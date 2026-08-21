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
    -c 1 gave byte-identical output.

The assertions here say the tools must now either refuse (nonzero exit plus a
diagnostic on stderr) or return a normalised, finite result -- never a
placeholder.  They also pin the machine-readable output: JSON must parse, its
parameters block must record what the run actually used (including the
NORMALISED -p and the mutation rates), and CSV must carry a header row with
one name per emitted field.

Usage:
    python3 baseline_tests/test_degenerate_switching_sequential.py [--bin DIR]

Exit status is 0 only if every check passes.
"""

import argparse
import json
import math
import os
import re
import subprocess
import sys

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_BIN_DIR = os.path.join(REPO_ROOT, "wfes-cli", "build-cx2", "bin")

# A two-model switching run small enough to solve instantly.
SWITCHING_BASE = ["-N", "8,8", "-r", "0.9,0.1;0.1,0.9"]
SEQUENTIAL_BASE = ["-N", "8,8", "-t", "100,100"]

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
    expect_refusal(run("wfes_switching", ["--absorption"] + SWITCHING_BASE + ["-p", "-2,1", "--json"]),
                   "switching --absorption -p -2,1", ["-p"])
    expect_refusal(run("wfes_switching", ["--fixation"] + SWITCHING_BASE + ["-p", "-2,1", "--json"]),
                   "switching --fixation -p -2,1", ["-p"])
    expect_refusal(run("wfes_sequential", SEQUENTIAL_BASE + ["-p", "-2,1", "--json"]),
                   "sequential -p -2,1", ["-p"])


def test_zero_starting_probability_refused():
    print("test_zero_starting_probability_refused")
    expect_refusal(run("wfes_switching", ["--absorption"] + SWITCHING_BASE + ["-p", "0,0", "--json"]),
                   "switching --absorption -p 0,0", ["-p"])
    r = run("wfes_switching", ["--fixation"] + SWITCHING_BASE + ["-p", "0,0", "--json"])
    expect_refusal(r, "switching --fixation -p 0,0", ["-p"])
    # This is the run that used to emit `"rate": inf`.
    check(BAD_JSON_TOKEN.search(r.stdout) is None,
          "switching --fixation -p 0,0: emits no inf/nan", context(r))
    expect_refusal(run("wfes_sequential", SEQUENTIAL_BASE + ["-p", "0,0", "--json"]),
                   "sequential -p 0,0", ["-p"])


def test_unnormalised_starting_probability_is_normalised_with_warning():
    print("test_unnormalised_starting_probability_is_normalised_with_warning")

    r = run("wfes_switching", ["--absorption"] + SWITCHING_BASE + ["-p", "1,1", "--json"])
    check(r.returncode == 0, "switching --absorption -p 1,1: exits 0", context(r))
    check("normalis" in r.stderr.lower(),
          "switching --absorption -p 1,1: warns on stderr about normalisation", context(r))
    doc = parse_json(r, "switching --absorption -p 1,1")
    if doc:
        res = doc["results"]
        p_ext, p_fix = res["P_ext"], res["P_fix"]
        check(0.0 <= p_ext <= 1.0, "switching: P_ext in [0,1]", "P_ext=%r" % p_ext)
        check(0.0 <= p_fix <= 1.0, "switching: P_fix in [0,1]", "P_fix=%r" % p_fix)
        check(abs(p_ext + p_fix - 1.0) < 1e-9,
              "switching: P_ext + P_fix == 1", "sum=%.17g" % (p_ext + p_fix))

    r = run("wfes_sequential", SEQUENTIAL_BASE + ["-p", "1,1", "--json"])
    check(r.returncode == 0, "sequential -p 1,1: exits 0", context(r))
    check("normalis" in r.stderr.lower(),
          "sequential -p 1,1: warns on stderr about normalisation", context(r))
    doc = parse_json(r, "sequential -p 1,1")
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
    r = run("wfes_sequential", ["-N", "2,2", "-t", "1,1", "--json"])
    expect_refusal(r, "sequential -N 2,2 -t 1,1", ["T_ext"])
    check(BAD_JSON_TOKEN.search(r.stdout) is None,
          "sequential -N 2,2 -t 1,1: emits no nan/inf", context(r))


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
    print("test_json_parameters_record_the_values_used")

    r = run("wfes_switching", ["--fixation"] + SWITCHING_BASE + ["-p", "1,1", "-u", "1e-8,1e-8", "--json"])
    check(r.returncode == 0, "switching --fixation --json: exits 0", context(r))
    doc = parse_json(r, "switching --fixation --json")
    if doc:
        params = doc.get("parameters", {})
        check(approx_list(params.get("starting_probabilities"), [0.5, 0.5]),
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

    r = run("wfes_sequential", SEQUENTIAL_BASE + ["-p", "1,1", "-u", "1e-8,1e-8", "--json"])
    check(r.returncode == 0, "sequential --json: exits 0", context(r))
    doc = parse_json(r, "sequential --json")
    if doc:
        params = doc.get("parameters", {})
        check(approx_list(params.get("starting_probabilities"), [0.5, 0.5]),
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


# ---------------------------------------------------------------------------
# 5. CSV must have a header, and it must have exactly one name per field
# ---------------------------------------------------------------------------

def is_number(token):
    try:
        float(token)
        return True
    except ValueError:
        return False


def check_csv_header(r, what):
    check(r.returncode == 0, "%s: exits 0" % what, context(r))
    lines = [ln for ln in r.stdout.strip().split("\n") if ln.strip()]
    if not check(len(lines) >= 2, "%s: emits a header line and a data line" % what, context(r)):
        return
    header = lines[0].split(",")
    check(not any(is_number(tok) for tok in header),
          "%s: first line is a header, not data" % what, "header=%r" % (lines[0],))
    for i, line in enumerate(lines[1:], start=1):
        fields = line.split(",")
        check(len(fields) == len(header),
              "%s: data row %d has one field per header column" % (what, i),
              "header has %d columns, row has %d\nheader=%s\nrow=%s"
              % (len(header), len(fields), lines[0], line))
        check(all(is_number(tok) for tok in fields),
              "%s: data row %d is all numeric" % (what, i), "row=%s" % line)


def test_csv_output_has_a_header():
    print("test_csv_output_has_a_header")
    check_csv_header(run("wfes_switching", ["--fixation"] + SWITCHING_BASE + ["--csv"]),
                     "switching --fixation --csv")
    check_csv_header(run("wfes_sequential", SEQUENTIAL_BASE + ["--csv"]),
                     "sequential --csv")


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
