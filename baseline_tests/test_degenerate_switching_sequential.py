#!/usr/bin/env python3
"""Degenerate-input tests for wfes_switching and wfes_sequential.

Both tools take a probability vector over their component models/epochs (-p)
and an integration cutoff over starting copy numbers (-c).  Every command
below used to produce a plausible-looking number and exit status 0:

  * `-p 1,1` was used as a raw weight, so
    `wfes_switching --absorption -N 8,8 -r "0.9,0.1;0.1,0.9" -p 1,1`
    reported P_ext = 1.8749999928 -- a "probability" of 1.87;
  * `-p -2,1` reported P_ext = -0.9375;
  * `-p 0,0` in --fixation zeroed the sojourn matrix, and 1/T_fix then wrote
    `"rate": inf` into a JSON document that json.load refuses to read;
  * `-c 1` put every starting state below the cutoff, leaving the
    zero-initialised accumulators to be printed as the result;
  * `wfes_switching --fixation` never read -c at all: -c 1e-10, -c 0.9 and
    -c 1 gave byte-identical output;
  * `wfes_switching --absorption --initial <file> -P -5,3` printed the raw,
    unread -P into the CSV p0/p1 columns and the JSON
    "starting_probabilities" -- literally negative "probabilities",
    published at exit 0 for a run that never used them.

The assertions here say the tools must now either refuse (nonzero exit plus a
diagnostic on stderr) or return a normalised, finite result -- never a
placeholder.  They also pin the machine-readable output: JSON must parse, its
parameters block must record what the run actually used (including the
NORMALISED -p and the mutation rates), and CSV must carry a header row with
one name per emitted field.

Usage:
    python3 baseline_tests/test_degenerate_switching_sequential.py [--bin DIR]

Exit status is 0 only if every check passes.

stderr-scope convention (shared by every suite in this directory)
-----------------------------------------------------------------
The nan/inf TOKEN SWEEP scans **stdout only**. stderr is asserted against
EXPECTED DIAGNOSTIC SUBSTRINGS and is never swept for tokens.

stdout is the published result: a bare `nan` or `inf` there is not valid JSON,
jq coerces it to 1.797e308, and a pipeline consumes a fake number. stderr is
where the tool EXPLAINS itself, and a good explanation often has to name the
value it is refusing ("rate would be 1/0 = inf") -- sweeping the combined
streams makes the better diagnostic the failing one. Suites here used to
disagree; they were aligned in task C6 (2026-08-21). Full statement and
rationale: baseline_tests/README.md.

This suite's sweep is BAD_JSON_TOKEN over `r.stdout`; stderr is asserted
only against expected substrings ("-p", "integration cutoff", "T_ext").
"""

import argparse
import json
import math
import os
import re
import subprocess
import sys
import tempfile

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_BIN_DIR = os.path.join(REPO_ROOT, "wfes-cli", "build-cx2", "bin")

# A two-model switching run small enough to solve instantly.
SWITCHING_BASE = ["-N", "8,8", "-R", "0.9,0.1;0.1,0.9"]
SEQUENTIAL_BASE = ["-N", "8,8", "-e", "100,100"]

# The parser's own default for -c.  Supplying exactly this value is
# indistinguishable from not supplying it, which is why --fixation accepts it.
DEFAULT_CUTOFF = "1e-10"

# Bare IEEE tokens that are not valid JSON numbers.
BAD_JSON_TOKEN = re.compile(r"(?<![\w.])(-?(?:nan|inf|infinity))(?![\w.])", re.IGNORECASE)

BIN_DIR = DEFAULT_BIN_DIR
RUNS = []          # every invocation, for the JSON-token sweep at the end
CHECKS = 0
FAILURES = []


class Run(object):
    def __init__(self, argv, proc):
        self.argv = argv
        self.returncode = proc.returncode
        self.stdout = proc.stdout
        self.stderr = proc.stderr

    def label(self):
        return " ".join([os.path.basename(self.argv[0])] + self.argv[1:])


def run(tool, args):
    argv = [os.path.join(BIN_DIR, tool)] + list(args)
    proc = subprocess.run(argv, capture_output=True, text=True, timeout=600)
    r = Run(argv, proc)
    RUNS.append(r)
    return r


def check(condition, what, detail=""):
    global CHECKS
    CHECKS += 1
    if not condition:
        FAILURES.append((what, detail))
        print("  FAIL  %s" % what)
        if detail:
            for line in detail.rstrip("\n").split("\n"):
                print("          %s" % line)
    return bool(condition)


def context(r, limit=400):
    return "exit=%d\ncmd: %s\nstdout: %s\nstderr: %s" % (
        r.returncode, r.label(), r.stdout[:limit].strip(), r.stderr[:limit].strip())


def expect_refusal(r, what, needles):
    """A refusal is a nonzero exit AND a diagnostic naming the offending input."""
    ok = check(r.returncode != 0, "%s: exits nonzero" % what, context(r))
    for needle in needles:
        ok &= check(needle.lower() in r.stderr.lower(),
                    "%s: diagnostic mentions %r" % (what, needle), context(r))
    ok &= check(r.stderr.strip() != "", "%s: diagnostic goes to stderr" % what,
                context(r))
    return ok


def parse_json(r, what):
    try:
        return json.loads(r.stdout)
    except ValueError as exc:
        check(False, "%s: stdout parses as JSON" % what,
              "%s\n%s" % (exc, context(r, 800)))
        return None


# ---------------------------------------------------------------------------
# 1. -p must be a probability vector: negatives and an all-zero vector refused
# ---------------------------------------------------------------------------

def test_negative_starting_probability_refused():
    print("test_negative_starting_probability_refused")
    expect_refusal(run("wfes_switching", ["--absorption"] + SWITCHING_BASE + ["-P", "-2,1", "--json"]),
                   "switching --absorption -P -2,1", ["-p"])
    expect_refusal(run("wfes_switching", ["--fixation"] + SWITCHING_BASE + ["-P", "-2,1", "--json"]),
                   "switching --fixation -P -2,1", ["-p"])
    expect_refusal(run("wfes_sequential", SEQUENTIAL_BASE + ["-P", "-2,1", "--json"]),
                   "sequential -P -2,1", ["-p"])


def test_zero_starting_probability_refused():
    print("test_zero_starting_probability_refused")
    expect_refusal(run("wfes_switching", ["--absorption"] + SWITCHING_BASE + ["-P", "0,0", "--json"]),
                   "switching --absorption -P 0,0", ["-p"])
    r = run("wfes_switching", ["--fixation"] + SWITCHING_BASE + ["-P", "0,0", "--json"])
    expect_refusal(r, "switching --fixation -P 0,0", ["-p"])
    # This is the run that used to emit `"rate": inf`.
    check(BAD_JSON_TOKEN.search(r.stdout) is None,
          "switching --fixation -p 0,0: emits no inf/nan", context(r))
    expect_refusal(run("wfes_sequential", SEQUENTIAL_BASE + ["-P", "0,0", "--json"]),
                   "sequential -P 0,0", ["-p"])


def test_unnormalised_starting_probability_is_normalised_with_warning():
    print("test_unnormalised_starting_probability_is_normalised_with_warning")

    r = run("wfes_switching", ["--absorption"] + SWITCHING_BASE + ["-P", "1,1", "--json"])
    check(r.returncode == 0, "switching --absorption -p 1,1: exits 0", context(r))
    check("normalis" in r.stderr.lower(),
          "switching --absorption -p 1,1: warns on stderr about normalisation", context(r))
    doc = parse_json(r, "switching --absorption -P 1,1")
    if doc:
        res = doc["results"]
        p_ext, p_fix = res["P_ext"], res["P_fix"]
        check(0.0 <= p_ext <= 1.0, "switching: P_ext in [0,1]", "P_ext=%r" % p_ext)
        check(0.0 <= p_fix <= 1.0, "switching: P_fix in [0,1]", "P_fix=%r" % p_fix)
        check(abs(p_ext + p_fix - 1.0) < 1e-9,
              "switching: P_ext + P_fix == 1", "sum=%.17g" % (p_ext + p_fix))

    r = run("wfes_sequential", SEQUENTIAL_BASE + ["-P", "1,1", "--json"])
    check(r.returncode == 0, "sequential -p 1,1: exits 0", context(r))
    check("normalis" in r.stderr.lower(),
          "sequential -p 1,1: warns on stderr about normalisation", context(r))
    doc = parse_json(r, "sequential -P 1,1")
    if doc:
        res = doc["results"]
        # wfes_sequential has a third absorbing outcome (timeout), so the
        # three probabilities -- not two -- are what must sum to 1.
        parts = [res["P_ext"], res["P_fix"], res["P_tmo"]]
        for name, value in zip(("P_ext", "P_fix", "P_tmo"), parts):
            check(0.0 <= value <= 1.0, "sequential: %s in [0,1]" % name,
                  "%s=%r" % (name, value))
        check(abs(sum(parts) - 1.0) < 1e-9,
              "sequential: P_ext + P_fix + P_tmo == 1", "sum=%.17g" % sum(parts))


# ---------------------------------------------------------------------------
# 2. A cutoff that excludes every starting state is an error, not a zero
# ---------------------------------------------------------------------------

def test_cutoff_above_every_starting_state_refused():
    print("test_cutoff_above_every_starting_state_refused")
    expect_refusal(run("wfes_switching", ["--absorption"] + SWITCHING_BASE + ["-c", "1", "--json"]),
                   "switching --absorption -c 1", ["integration cutoff"])
    expect_refusal(run("wfes_sequential", SEQUENTIAL_BASE + ["-c", "1", "--json"]),
                   "sequential -c 1", ["integration cutoff"])


# ---------------------------------------------------------------------------
# 3. --fixation has no starting-copy integration, so it must refuse -c rather
#    than accept and ignore it.  The parser default (1e-10) is indistinguishable
#    from an unsupplied -c and stays accepted, so the GUI keeps working.
# ---------------------------------------------------------------------------

def test_non_finite_result_refused():
    """`-t 1,1` leaves every starting state unable to reach an extinction or
    fixation boundary before its epoch times out, so E[T | extinction] divides
    0 by 0. The run used to report P_ext = 0.316 alongside T_ext = nan and
    exit 0 -- and `"T_ext": nan` is not valid JSON."""
    print("test_non_finite_result_refused")
    r = run("wfes_sequential", ["-N", "2,2", "-e", "1,1", "--json"])
    expect_refusal(r, "sequential -N 2,2 -e 1,1", ["T_ext"])
    check(BAD_JSON_TOKEN.search(r.stdout) is None,
          "sequential -N 2,2 -e 1,1: emits no nan/inf", context(r))


def test_fixation_refuses_meaningful_integration_cutoff():
    print("test_fixation_refuses_meaningful_integration_cutoff")
    for value in ("1", "0.9", "1e-5", "1e-12"):
        expect_refusal(run("wfes_switching", ["--fixation"] + SWITCHING_BASE + ["-c", value, "--json"]),
                       "switching --fixation -c %s" % value, ["-c", "fixation"])

    r = run("wfes_switching", ["--fixation"] + SWITCHING_BASE + ["-c", DEFAULT_CUTOFF, "--json"])
    check(r.returncode == 0,
          "switching --fixation -c %s (the default): still accepted" % DEFAULT_CUTOFF,
          context(r))


# ---------------------------------------------------------------------------
# 4. JSON provenance: the parameters block records what the run actually used
# ---------------------------------------------------------------------------

def approx_list(values, expected, tol=1e-12):
    if not isinstance(values, list) or len(values) != len(expected):
        return False
    return all(abs(float(a) - b) <= tol for a, b in zip(values, expected))


def test_json_parameters_record_the_values_used():
    """The parameters block must record the NORMALISED -P the run actually used.

    The live-p cases here supply `-P 3,1` and assert [0.75, 0.25], not the
    obvious `-P 1,1` and [0.5, 0.5]. [0.5, 0.5] is BOTH what `-P 1,1`
    normalises to AND the parser's default for two models (verified: omitting
    -P entirely prints "starting_probabilities": [0.5, 0.5]), so an assertion
    on it passes just as happily against an implementation that ignores -P and
    echoes its own default -- which is a variant of the exact defect this file
    exists to lock out. An asymmetric vector discriminates: only a run that
    read -P and normalised it can print [0.75, 0.25].

    -P 1,1 stays in the DEAD-p cases (--starting-copies / --initial, in
    test_csv_output_has_a_header), where the point is a vector summing to 2
    that must not trigger a renormalisation warning; there the sum is the
    signal, not the ratio.
    """
    print("test_json_parameters_record_the_values_used")

    r = run("wfes_switching", ["--fixation"] + SWITCHING_BASE + ["-P", "3,1", "-u", "1e-8,1e-8", "--json"])
    check(r.returncode == 0, "switching --fixation --json: exits 0", context(r))
    doc = parse_json(r, "switching --fixation --json")
    if doc:
        params = doc.get("parameters", {})
        check(approx_list(params.get("starting_probabilities"), [0.75, 0.25]),
              "switching --fixation --json: records NORMALISED p",
              "starting_probabilities=%r" % (params.get("starting_probabilities"),))
        check(approx_list(params.get("backward_mutation_rates"), [1e-8, 1e-8], 1e-20),
              "switching --fixation --json: records u",
              "backward_mutation_rates=%r" % (params.get("backward_mutation_rates"),))
        check(approx_list(params.get("forward_mutation_rates"), [1e-9, 1e-9], 1e-20),
              "switching --fixation --json: records v",
              "forward_mutation_rates=%r" % (params.get("forward_mutation_rates"),))
        rate = doc.get("results", {}).get("rate")
        check(isinstance(rate, float) and math.isfinite(rate) and rate > 0,
              "switching --fixation --json: rate is finite and positive", "rate=%r" % (rate,))

    r = run("wfes_sequential", SEQUENTIAL_BASE + ["-P", "3,1", "-u", "1e-8,1e-8", "--json"])
    check(r.returncode == 0, "sequential --json: exits 0", context(r))
    doc = parse_json(r, "sequential --json")
    if doc:
        params = doc.get("parameters", {})
        check(approx_list(params.get("starting_probabilities"), [0.75, 0.25]),
              "sequential --json: records NORMALISED p",
              "starting_probabilities=%r" % (params.get("starting_probabilities"),))
        check(approx_list(params.get("backward_mutation_rates"), [1e-8, 1e-8], 1e-20),
              "sequential --json: records u",
              "backward_mutation_rates=%r" % (params.get("backward_mutation_rates"),))
        check(approx_list(params.get("forward_mutation_rates"), [1e-9, 1e-9], 1e-20),
              "sequential --json: records v",
              "forward_mutation_rates=%r" % (params.get("forward_mutation_rates"),))
        check("integration_cutoff" in params,
              "sequential --json: records the integration cutoff in effect",
              "parameters keys=%r" % sorted(params))

    # --starting-copies replaces the integration, so that is what gets recorded.
    r = run("wfes_sequential", SEQUENTIAL_BASE + ["--starting-copies", "3", "--json"])
    check(r.returncode == 0, "sequential --starting-copies --json: exits 0", context(r))
    doc = parse_json(r, "sequential --starting-copies --json")
    if doc:
        params = doc.get("parameters", {})
        check(params.get("starting_copies") == 3,
              "sequential --json: records starting_copies actually used",
              "parameters=%r" % params)

    # switching --absorption records the same XOR as --fixation: the
    # parameters block names whichever starting rule the run actually used.
    # Without --initial, that is the NORMALISED -P.
    r = run("wfes_switching", ["--absorption"] + SWITCHING_BASE + ["-P", "3,1", "--json"])
    check(r.returncode == 0, "switching --absorption --json: exits 0", context(r))
    doc = parse_json(r, "switching --absorption --json")
    if doc:
        params = doc.get("parameters", {})
        check(approx_list(params.get("starting_probabilities"), [0.75, 0.25]),
              "switching --absorption --json: records NORMALISED p",
              "starting_probabilities=%r" % (params.get("starting_probabilities"),))
        check("initial_distribution" not in params,
              "switching --absorption --json: no initial_distribution without --initial",
              "parameters keys=%r" % sorted(params))

    # With --initial the run never reads -P (the file replaces the per-model
    # starting integration entirely, wfes_switching_main.cpp ABSORPTION
    # branch), so the raw vector must not be published as
    # "starting_probabilities"; the initial_distribution path is what gets
    # recorded.  -P -5,3 is the confirmed bug's exact repro: dead input that
    # is (correctly) never validated, and that this run used to publish as
    # "starting_probabilities": [-5, 3] at exit 0.  The 30-state file spans
    # the concatenated TRANSIENT states of all models: 2*sum(N_i) - n_models
    # = 30 for SWITCHING_BASE.
    with tempfile.TemporaryDirectory() as tmpdir:
        absorption_initial = write_initial_distribution(tmpdir, 30)
        r = run("wfes_switching", ["--absorption"] + SWITCHING_BASE +
                ["--initial", absorption_initial, "-P", "-5,3", "--json"])
        check(r.returncode == 0,
              "switching --absorption --initial --json: exits 0 (dead -P not validated)",
              context(r))
        doc = parse_json(r, "switching --absorption --initial --json")
        if doc:
            params = doc.get("parameters", {})
            check("starting_probabilities" not in params,
                  "switching --absorption --initial --json: unused -P not published",
                  "parameters=%r" % params)
            check(params.get("initial_distribution") == absorption_initial,
                  "switching --absorption --initial --json: records the initial_distribution path",
                  "parameters=%r" % params)
            res = doc.get("results", {})
            p_ext, p_fix = res.get("P_ext"), res.get("P_fix")
            check(isinstance(p_ext, float) and isinstance(p_fix, float)
                  and abs(p_ext + p_fix - 1.0) < 1e-9,
                  "switching --absorption --initial --json: P_ext + P_fix == 1",
                  "P_ext=%r P_fix=%r" % (p_ext, p_fix))


# ---------------------------------------------------------------------------
# 5. CSV must have a header, and it must have exactly one name per field
# ---------------------------------------------------------------------------

def is_number(token):
    try:
        float(token)
        return True
    except ValueError:
        return False


def write_initial_distribution(tmpdir, n_states, active_index=0):
    """A minimal, valid --initial file: a delta function on one state.

    load_csv_col_vector (wfes-lib/source/utils/parsing.cpp) reads one
    probability per line, no header. The delta sums to exactly 1.0 so
    load_initial_distribution's own renormalisation warning -- whose message
    is "...renormalising", which also contains the substring "normalis" --
    never fires; a file that merely summed close to 1 would make the
    no-warning assertion below ambiguous between "the -p warning correctly
    stayed silent" and "the --initial warning fired instead".
    """
    path = os.path.join(tmpdir, "initial_%d.csv" % n_states)
    with open(path, "w") as f:
        for i in range(n_states):
            f.write("1.0\n" if i == active_index else "0.0\n")
    return path


# The two solver-backend provenance columns (task CX8, integrity audit
# section 2.3). Both --csv rows here publish the run's parameters, and
# --library was the one parameter that was not necessarily what the run used:
# SolverFactory serves an "Accelerate" request with SuiteSparse whenever the
# build has it, which is every shipped macOS build. These two columns close
# the parameters group, immediately after `a` and before the first result
# column, and carry backend NAMES rather than numbers -- so check_csv_header
# asserts them against the tool's own --library whitelist instead of against
# float(). That is a stricter test than "is a number", not a relaxation:
# `is_number` would have accepted any numeric token at all, while a name here
# has to be one the factory could actually have produced.
#
# Positive assertions on the values themselves (that requested is what was
# asked for, that effective is what ran, and that the pair matches the JSON
# parameters block) live in test_shared_parser.py's provenance section.
PROVENANCE_COLUMNS = ("library_requested", "library_effective")

_LIBRARY_WHITELIST = {}


def whitelisted_libraries(tool):
    """The build's --library whitelist, read back out of the tool's --help.

    Args_Parser::supported_libraries() is the single source of truth for the
    help text, for what --library accepts, and for the name that appears in
    library_effective, so reading it here keeps this suite from hardcoding a
    platform's backend list.
    """
    if tool not in _LIBRARY_WHITELIST:
        text = run(tool, ["--help"]).stdout
        m = re.search(r"Library \(([^)]*)\)", text)
        names = ([t.strip() for t in re.split(r",\s*|\s+or\s+", m.group(1))
                  if t.strip()] if m else [])
        _LIBRARY_WHITELIST[tool] = names
    return _LIBRARY_WHITELIST[tool]


def check_csv_header(r, what, empty_ok=(), tool=None):
    """Check header/data shape: a header line, then data line(s) with one
    field per header column -- counted by splitting on ',', which counts
    delimiters rather than values and so is unaffected by an empty field.

    Every field must be numeric, except:

      * a field whose header name is listed in `empty_ok`: the schema keeps
        that column (a fixed-position CSV consumer must not see the column
        count change across runs), but the run did not use it, so the field
        must be empty rather than carry a number that played no part in the
        result;
      * the two PROVENANCE_COLUMNS, which name a solver backend and must hold
        a name from `tool`'s own --library whitelist. Pass `tool` to have them
        checked; without it they are checked for non-emptiness only.

    Returns (header, data_lines) for callers that need to inspect the parsed
    row further; returns None if the basic header/data-line shape is wrong.
    """
    check(r.returncode == 0, "%s: exits 0" % what, context(r))
    lines = [ln for ln in r.stdout.strip().split("\n") if ln.strip()]
    if not check(len(lines) >= 2, "%s: emits a header line and a data line" % what, context(r)):
        return None
    header = lines[0].split(",")
    check(not any(is_number(tok) for tok in header),
          "%s: first line is a header, not data" % what, "header=%r" % (lines[0],))
    data_lines = lines[1:]
    for i, line in enumerate(data_lines, start=1):
        fields = line.split(",")
        if not check(len(fields) == len(header),
                     "%s: data row %d has one field per header column" % (what, i),
                     "header has %d columns, row has %d\nheader=%s\nrow=%s"
                     % (len(header), len(fields), lines[0], line)):
            continue
        libs = whitelisted_libraries(tool) if tool else []
        for name, tok in zip(header, fields):
            if name in empty_ok:
                check(tok == "", "%s: data row %d field %s is empty (unused)" % (what, i, name),
                      "row=%s" % line)
            elif name in PROVENANCE_COLUMNS:
                ok = tok in libs if libs else bool(tok)
                check(ok,
                      "%s: data row %d field %s names a backend this build has"
                      % (what, i, name),
                      "value=%r whitelist=%r row=%s" % (tok, libs, line))
            else:
                check(is_number(tok), "%s: data row %d field %s is numeric" % (what, i, name),
                      "row=%s" % line)
    return header, data_lines


def test_csv_output_has_a_header():
    print("test_csv_output_has_a_header")
    check_csv_header(run("wfes_switching", ["--fixation"] + SWITCHING_BASE + ["--csv"]),
                     "switching --fixation --csv", tool="wfes_switching")
    check_csv_header(run("wfes_sequential", SEQUENTIAL_BASE + ["--csv"]),
                     "sequential --csv", tool="wfes_sequential")

    # --starting-copies is one of three mutually exclusive starting rules
    # (see test_json_parameters_record_the_values_used above) and replaces
    # -p entirely, so -p 1,1 here is dead input -- exactly the case that
    # used to print "renormalising" for a vector the run never reads, and
    # the case the CSV schema fix is for: the header keeps p0/p1 (a
    # fixed-position CSV consumer must see the same column count across
    # runs), but the data row must leave them empty rather than carry a
    # number that played no part in the result.
    r = run("wfes_sequential",
            SEQUENTIAL_BASE + ["--starting-copies", "3", "-P", "1,1", "--csv"])
    check("normalis" not in r.stderr.lower(),
          "sequential --starting-copies -p 1,1 --csv: "
          "no renormalisation warning for an unused -p", context(r))
    check_csv_header(r, "sequential --starting-copies --csv", empty_ok=("p0", "p1"),
                     tool="wfes_sequential")

    # --initial is the other -p-replacing rule (see
    # test_json_parameters_record_the_values_used above), and it covers both
    # tools: it supplies a whole distribution over the concatenated state
    # space, so -p is equally dead input here -- same schema fix, different
    # trigger. -p 1,1 is included as dead input for the same reason as the
    # --starting-copies case above: it would normally warn about
    # renormalising a vector that summed to 2, and must not, because
    # --initial means the run never reads it.
    #
    # wfes_switching --fixation --initial spans the concatenated states of
    # all models, counts 0..2N_i-1 per model: 2*sum(N_i) = 2*(8+8) = 32 for
    # SWITCHING_BASE (wfes_switching_main.cpp FIXATION branch, `llong size =
    # (2 * population_sizes.sum())`). wfes_sequential --initial spans the
    # concatenated TRANSIENT states of all epochs: 2*sum(N_i) - n_models =
    # 32 - 2 = 30 for SEQUENTIAL_BASE (wfes_sequential_main.cpp, `llong size
    # = (2 * population_sizes.sum()) - n_models`) -- the same BOTH_ABSORBING
    # count switching's own --absorption branch uses.
    with tempfile.TemporaryDirectory() as tmpdir:
        switching_initial = write_initial_distribution(tmpdir, 32)
        r = run("wfes_switching",
                ["--fixation"] + SWITCHING_BASE +
                ["--initial", switching_initial, "-P", "1,1", "--csv"])
        check("normalis" not in r.stderr.lower(),
              "switching --fixation --initial --csv: "
              "no renormalisation warning for an unused -p", context(r))
        check_csv_header(r, "switching --fixation --initial --csv",
                         empty_ok=("p0", "p1"), tool="wfes_switching")

        sequential_initial = write_initial_distribution(tmpdir, 30)
        r = run("wfes_sequential",
                SEQUENTIAL_BASE +
                ["--initial", sequential_initial, "-P", "1,1", "--csv"])
        check("normalis" not in r.stderr.lower(),
              "sequential --initial --csv: "
              "no renormalisation warning for an unused -p", context(r))
        check_csv_header(r, "sequential --initial --csv", empty_ok=("p0", "p1"),
                         tool="wfes_sequential")

        # wfes_switching --absorption --initial: same -p-replacing rule as
        # the two cases above, but this output travels through the shared
        # OutputFormatter::print_switching_absorption_results rather than
        # the main's own CsvRow, and that formatter used to print the raw
        # -P vector unconditionally.  Because a dead -P is (correctly)
        # never validated, the values here are deliberately ones validation
        # would refuse (-5,3): the run must neither refuse them nor publish
        # them.  This is the exact shape that used to print p0=-5,p1=3 into
        # a clean exit-0 CSV row.  --absorption spans the concatenated
        # TRANSIENT states of all models: 2*sum(N_i) - n_models = 30 for
        # SWITCHING_BASE (`llong size = (2 * population_sizes.sum()) -
        # n_models`).
        absorption_initial = write_initial_distribution(tmpdir, 30)
        r = run("wfes_switching",
                ["--absorption"] + SWITCHING_BASE +
                ["--initial", absorption_initial, "-P", "-5,3", "--csv"])
        check_csv_header(r, "switching --absorption --initial --csv",
                         empty_ok=("p0", "p1"), tool="wfes_switching")


# ---------------------------------------------------------------------------
# 6. wfes_sequential prints the banner like the other tools, and only when the
#    output is meant for a human
# ---------------------------------------------------------------------------

def test_sequential_banner():
    print("test_sequential_banner")
    r = run("wfes_sequential", SEQUENTIAL_BASE)
    check(r.returncode == 0, "sequential (text): exits 0", context(r))
    check("Program: wfes_sequential" in r.stdout,
          "sequential (text): prints the banner", context(r))
    for fmt in ("--json", "--csv"):
        r = run("wfes_sequential", SEQUENTIAL_BASE + [fmt])
        check("Program: wfes_sequential" not in r.stdout,
              "sequential %s: banner suppressed" % fmt, context(r))


# ---------------------------------------------------------------------------
# 7. Sweep: no JSON run may contain a bare nan/inf token
# ---------------------------------------------------------------------------

def test_no_bare_nan_or_inf_in_json_runs():
    print("test_no_bare_nan_or_inf_in_json_runs")
    for r in RUNS:
        if "--json" not in r.argv:
            continue
        match = BAD_JSON_TOKEN.search(r.stdout)
        check(match is None, "no bare nan/inf in JSON: %s" % r.label(),
              "" if match is None else "found %r\n%s" % (match.group(0), context(r)))


TESTS = [
    test_negative_starting_probability_refused,
    test_zero_starting_probability_refused,
    test_unnormalised_starting_probability_is_normalised_with_warning,
    test_cutoff_above_every_starting_state_refused,
    test_non_finite_result_refused,
    test_fixation_refuses_meaningful_integration_cutoff,
    test_json_parameters_record_the_values_used,
    test_csv_output_has_a_header,
    test_sequential_banner,
]


def main():
    global BIN_DIR
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--bin", default=DEFAULT_BIN_DIR,
                    help="directory holding wfes_switching and wfes_sequential "
                         "(default: %(default)s)")
    opts = ap.parse_args()
    BIN_DIR = opts.bin

    for tool in ("wfes_switching", "wfes_sequential"):
        path = os.path.join(BIN_DIR, tool)
        if not os.path.isfile(path):
            sys.stderr.write("No such binary: %s\n"
                             "Build first: cmake -S wfes-cli -B wfes-cli/build-cx2 "
                             "&& cmake --build wfes-cli/build-cx2 -j8\n" % path)
            return 2

    print("Binaries: %s\n" % BIN_DIR)
    for test in TESTS:
        test()
    test_no_bare_nan_or_inf_in_json_runs()

    print("\n%d checks, %d failed" % (CHECKS, len(FAILURES)))
    if FAILURES:
        print("\nFailed:")
        for what, _ in FAILURES:
            print("  - %s" % what)
        return 1
    print("PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
