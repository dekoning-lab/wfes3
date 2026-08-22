#!/usr/bin/env python3
"""
Integrity tests for the time_dist family (time_dist, time_dist_dual,
time_dist_sgv) and phase_type_moments.

These are not numerical-accuracy checks -- validate_baselines.py covers that.
They check that the tools DISCLOSE what they did, and REFUSE rather than
substitute when a computation cannot be performed correctly:

  * --output-P must not suppress --json/--csv; a file and a stream are
    independent requests.
  * A CDF is renormalised to end at 1.0 only when the distribution actually
    converged. A run stopped by --max-t must print its raw partial CDF, so the
    truncation is visible in every output format (the CSV path carries no
    reached_cutoff field), and must say so on stderr.
  * A converged run still ends at 1.0.
  * task CX-disclose (PI decision "Rescale + disclose"): a converged run's
    JSON additionally carries `cdf_rescaled: true` and the pre-rescale
    captured mass (`cdf_pre_rescale_mass`), present exactly when -- and only
    when -- the CDF columns were actually divided down to end at 1.0; a
    truncated run has neither key. When --distribution-cutoff is <= 0.99, the
    rescale is also disclosed on stderr in every output format, since CSV and
    plain text carry neither field.
  * A degenerate --distribution-cutoff (<= 0) must not produce a header-only
    "success"; zero computed time steps is a refusal, not a result.
  * phase_type_moments must never print nan/inf. Moments that overflow double
    precision are a refusal with a diagnostic, not exit 0 with nan in the table.
  * time_dist_sgv's -r/--no-recurrent-mu is not wired into the SGV model, so it
    must be refused rather than accepted and silently ignored.
  * No output the tools call JSON may contain a bare nan/inf token.

Usage
-----
    python3 baseline_tests/test_degenerate_time_dist_family.py
    python3 baseline_tests/test_degenerate_time_dist_family.py --bin <dir>

<dir> holds the built binaries (default: wfes-cli/build-cx3/bin).
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

This suite's sweep is NONFINITE_TOKEN over `proc.stdout`; stderr is
asserted only against expected diagnostic substrings.
"""
from __future__ import annotations

import argparse
import json
import math
import re
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
DEFAULT_BIN_DIR = REPO / "wfes-cli" / "build-cx3" / "bin"

# A bare nan/inf/-inf as C++ ostream writes it. Word-bounded so that identifiers
# which merely contain the letters (there are none today, but "infinity_norm"
# would) do not trip the scan.
NONFINITE_TOKEN = re.compile(r"(?<![A-Za-z0-9_.])[-+]?(?:nan|inf|infinity)(?![A-Za-z0-9_])",
                             re.IGNORECASE)

# Substring common to all three tools' stderr disclosure for task CX-disclose
# (PI decision "Rescale + disclose"): printed when, and only when, a run
# converged (reached_cutoff) AND --distribution-cutoff <= 0.99 -- see the
# threshold rationale next to cdf_was_rescaled in each tool's main.cpp. Format
# -agnostic (emitted before the --json/--csv/plain branch), which is the point:
# CSV and plain text carry no cdf_rescaled field, so this note is their only
# disclosure channel.
RESCALE_NOTE_MARKER = "rescaled to end at 1.0 from the captured mass"

BIN_DIR = DEFAULT_BIN_DIR  # replaced in main()
FAILURES: list[str] = []
N_CHECKS = 0


# ----------------------------------------------------------------- utilities


def run(tool: str, args: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run([str(BIN_DIR / tool), *args],
                          capture_output=True, text=True, timeout=600)


def strict_json(text: str):
    """json.loads that refuses NaN/Infinity in any spelling.

    Python's json accepts the capitalised literals by default; C++ writes them
    lowercase, which json rejects outright. Both spellings must fail here.
    """
    def reject(token):
        raise ValueError(f"non-finite JSON constant: {token}")
    return json.loads(text, parse_constant=reject)


def check(label: str, ok: bool, detail: str = "") -> bool:
    global N_CHECKS
    N_CHECKS += 1
    print(f"  {'OK  ' if ok else 'FAIL'} {label}" + (f" -- {detail}" if detail else ""))
    if not ok:
        FAILURES.append(label)
    return ok


def close(a: float, b: float, rel: float = 1e-9) -> bool:
    return math.isclose(a, b, rel_tol=rel, abs_tol=1e-300)


def assert_clean_json(label: str, proc: subprocess.CompletedProcess):
    """stdout must parse as JSON and hold no non-finite token."""
    check(f"{label}: stdout holds no bare nan/inf",
          NONFINITE_TOKEN.search(proc.stdout) is None,
          (NONFINITE_TOKEN.search(proc.stdout) or [""])[0] if
          NONFINITE_TOKEN.search(proc.stdout) else "")
    try:
        parsed = strict_json(proc.stdout)
        check(f"{label}: stdout parses as JSON", True)
        return parsed
    except Exception as exc:
        check(f"{label}: stdout parses as JSON", False, str(exc)[:120])
        return None


# ------------------------------------------------------------------- checks


def test_sgv_output_P_does_not_suppress_streams():
    print("\n=== time_dist_sgv: --output-P must not suppress --json/--csv ===")
    base = ["-N", "20", "-L", "0.5", "-s", "0.1,0.1",
            "-u", "0.01,0.01", "-v", "0.01,0.01", "-d", "0.9"]
    with tempfile.TemporaryDirectory() as tmp:
        for flag, name in (("--json", "json"), ("--csv", "csv")):
            p_path = Path(tmp) / f"P_{name}.txt"
            proc = run("time_dist_sgv", base + ["--output-P", str(p_path), flag])
            label = f"--output-P + {flag}"
            check(f"{label}: exit 0", proc.returncode == 0, f"exit={proc.returncode}")
            check(f"{label}: P file written non-empty",
                  p_path.is_file() and p_path.stat().st_size > 0)
            check(f"{label}: stdout non-empty", len(proc.stdout) > 0,
                  f"{len(proc.stdout)} bytes")
            if flag == "--json":
                assert_clean_json(label, proc)
            else:
                first = proc.stdout.splitlines()[0] if proc.stdout else ""
                check(f"{label}: CSV header present", first == "time,pdf,cdf", first[:60])


def test_truncated_runs_disclose():
    print("\n=== truncated runs: raw partial CDF + stderr warning ===")

    # time_dist -- 7-column model, three CDFs, no final_cdf key: the totals live
    # in statistics.total_probability_*.
    proc = run("time_dist", ["-N", "50", "-m", "40", "--json"])
    label = "time_dist -m 40"
    check(f"{label}: exit 0", proc.returncode == 0, f"exit={proc.returncode}")
    d = assert_clean_json(label, proc)
    if d:
        st = d["statistics"]
        rows = d["distribution"]
        check(f"{label}: reached_cutoff false", st["reached_cutoff"] is False)
        check(f"{label}: last cdf_total < 1", rows[-1]["cdf_total"] < 1.0,
              repr(rows[-1]["cdf_total"]))
        check(f"{label}: last cdf_total == total_probability_absorption",
              close(rows[-1]["cdf_total"], st["total_probability_absorption"]),
              f'{rows[-1]["cdf_total"]!r} vs {st["total_probability_absorption"]!r}')
        check(f"{label}: last cdf_ext == total_probability_extinction",
              close(rows[-1]["cdf_ext"], st["total_probability_extinction"]))
        check(f"{label}: last cdf_fix == total_probability_fixation",
              close(rows[-1]["cdf_fix"], st["total_probability_fixation"]))
        # task CX-disclose: nothing was rescaled here (the run stopped at
        # --max-t short of the cutoff), so the disclosure keys are honestly
        # ABSENT rather than printed with a false/null sentinel -- the same
        # convention this tool already uses for mean_extinction/std_extinction
        # when cdf_ext == 0 (see time_dist_main.cpp).
        check(f"{label}: cdf_rescaled absent (nothing was rescaled)",
              "cdf_rescaled" not in st, str(sorted(st)))
        check(f"{label}: cdf_pre_rescale_mass absent (nothing was rescaled)",
              "cdf_pre_rescale_mass" not in st, str(sorted(st)))
    check(f"{label}: stderr warns about --max-t", "--max-t" in proc.stderr,
          proc.stderr.strip()[:80])
    check(f"{label}: stderr carries no rescale-disclosure note",
          RESCALE_NOTE_MARKER not in proc.stderr, proc.stderr.strip()[:160])

    # The CSV path has no reached_cutoff field at all, so the raw CDF is the
    # only thing that can disclose the truncation.
    proc = run("time_dist", ["-N", "50", "-m", "40", "--csv"])
    label = "time_dist -m 40 --csv"
    rows = [r for r in proc.stdout.splitlines() if r and not r.startswith("time,")]
    check(f"{label}: last row cdf_total < 1",
          bool(rows) and float(rows[-1].split(",")[6]) < 1.0,
          rows[-1] if rows else "no rows")

    # time_dist_dual
    proc = run("time_dist_dual", ["-N", "50", "-m", "40", "--json"])
    label = "time_dist_dual -m 40"
    check(f"{label}: exit 0", proc.returncode == 0, f"exit={proc.returncode}")
    d = assert_clean_json(label, proc)
    if d:
        st = d["statistics"]
        rows = d["distribution"]
        check(f"{label}: reached_cutoff false", st["reached_cutoff"] is False)
        check(f"{label}: last cdf_total < 1", rows[-1]["cdf_total"] < 1.0,
              repr(rows[-1]["cdf_total"]))
        check(f"{label}: last cdf_total == final_cdf",
              close(rows[-1]["cdf_total"], st["final_cdf"]),
              f'{rows[-1]["cdf_total"]!r} vs {st["final_cdf"]!r}')
        check(f"{label}: cdf_rescaled absent (nothing was rescaled)",
              "cdf_rescaled" not in st, str(sorted(st)))
        check(f"{label}: cdf_pre_rescale_mass absent (nothing was rescaled)",
              "cdf_pre_rescale_mass" not in st, str(sorted(st)))
    check(f"{label}: stderr warns about --max-t", "--max-t" in proc.stderr,
          proc.stderr.strip()[:80])
    check(f"{label}: stderr carries no rescale-disclosure note",
          RESCALE_NOTE_MARKER not in proc.stderr, proc.stderr.strip()[:160])

    # time_dist_sgv
    proc = run("time_dist_sgv", ["-N", "50", "-L", "0.5", "-s", "0,0.01",
                                 "-m", "40", "--json"])
    label = "time_dist_sgv -m 40"
    check(f"{label}: exit 0", proc.returncode == 0, f"exit={proc.returncode}")
    d = assert_clean_json(label, proc)
    if d:
        cdfs = d["distribution"]["cdf"]
        check(f"{label}: reached_cutoff false", d["reached_cutoff"] is False)
        check(f"{label}: last cdf < 1", cdfs[-1] < 1.0, repr(cdfs[-1]))
        check(f"{label}: last cdf == final_cdf", close(cdfs[-1], d["final_cdf"]),
              f'{cdfs[-1]!r} vs {d["final_cdf"]!r}')
        check(f"{label}: cdf_rescaled absent (nothing was rescaled)",
              "cdf_rescaled" not in d, str(sorted(d)))
        check(f"{label}: cdf_pre_rescale_mass absent (nothing was rescaled)",
              "cdf_pre_rescale_mass" not in d, str(sorted(d)))
    check(f"{label}: stderr warns about --max-t", "--max-t" in proc.stderr,
          proc.stderr.strip()[:80])
    check(f"{label}: stderr carries no rescale-disclosure note",
          RESCALE_NOTE_MARKER not in proc.stderr, proc.stderr.strip()[:160])


def test_converged_runs_still_normalise():
    print("\n=== converged runs: CDF still ends at 1, no warning ===")
    cases = [
        ("time_dist", ["-N", "20", "-d", "0.9", "--json"], 0.9,
         lambda d: d["distribution"][-1]["cdf_total"],
         lambda d: d["statistics"]["reached_cutoff"],
         lambda d: d["statistics"]),
        ("time_dist_dual", ["-N", "20", "-u", "0.01", "-v", "0.01",
                            "-d", "0.9", "--json"], 0.9,
         lambda d: d["distribution"][-1]["cdf_total"],
         lambda d: d["statistics"]["reached_cutoff"],
         lambda d: d["statistics"]),
        ("time_dist_sgv", ["-N", "10", "-L", "0.5", "-s", "0.1,0.1",
                           "-u", "0.01,0.01", "-v", "0.01,0.01",
                           "-d", "0.9", "--json"], 0.9,
         lambda d: d["distribution"]["cdf"][-1],
         lambda d: d["reached_cutoff"],
         lambda d: d),
    ]
    for tool, args, cutoff, last_cdf, reached, stats in cases:
        proc = run(tool, args)
        label = f"{tool} converged"
        check(f"{label}: exit 0", proc.returncode == 0, f"exit={proc.returncode}")
        check(f"{label}: no warning on stderr", "Warning" not in proc.stderr,
              proc.stderr.strip()[:80])
        d = assert_clean_json(label, proc)
        if d:
            check(f"{label}: reached_cutoff true", reached(d) is True)
            check(f"{label}: last cdf == 1", close(last_cdf(d), 1.0, rel=1e-12),
                  repr(last_cdf(d)))
            # task CX-disclose: this cutoff (0.9) is <= 0.99, so the run must
            # both carry the disclosure keys AND print the stderr note -- the
            # two channels are not exclusive alternatives, JSON gets both.
            check(f"{label}: cdf_rescaled true", stats(d).get("cdf_rescaled") is True,
                  repr(stats(d).get("cdf_rescaled")))
            mass = stats(d).get("cdf_pre_rescale_mass")
            check(f"{label}: cdf_pre_rescale_mass in [cutoff, 1)",
                  mass is not None and cutoff <= mass < 1.0, repr(mass))
            check(f"{label}: stderr carries the rescale-disclosure note "
                  f"(cutoff {cutoff} <= 0.99)",
                  RESCALE_NOTE_MARKER in proc.stderr, proc.stderr.strip()[:160])


def test_cdf_rescale_disclosure():
    """task CX-disclose (PI decision "Rescale + disclose").

    A converged run always rescales its CDF(s) to end at 1.0 -- that part is
    unchanged and tested above. What is new is DISCLOSING the rescale: every
    converged run's JSON carries cdf_rescaled + cdf_pre_rescale_mass, and a
    run whose --distribution-cutoff is <= 0.99 (chosen because the DEFAULT
    cutoff is 1-1e-8 -- comfortably above it, where the rescale only mops up
    floating-point-scale tail noise nobody would call a modeling choice --
    while 0.99 already means at least 1% of one of the branches' own mass
    sits outside the computed window, which is large enough to change how a
    reader should interpret "P(T <= t) -> 1") ALSO explains itself on stderr,
    in every output format, since CSV and plain text carry neither JSON key.
    """
    print("\n=== task CX-disclose: converged runs disclose their CDF rescale ===")

    # Small, fast-converging models (verified empirically against an
    # unmodified build: each reaches even the ~1e-8-of-1 default cutoff in
    # well under a second at these sizes). No -d/-csv/--json here -- those are
    # appended per scenario below.
    MODEL_ARGS = {
        "time_dist": ["-N", "10", "-s", "0.5"],
        "time_dist_dual": ["-N", "10", "-s", "0.5", "-v", "0.05"],
        "time_dist_sgv": ["-N", "10", "-L", "0.5", "-s", "0.1,0.5",
                          "-u", "0.01,0.01", "-v", "0.01,0.01"],
    }
    # (tool, statistics-dict accessor, reached_cutoff accessor) -- time_dist
    # and time_dist_dual nest both under "statistics"; time_dist_sgv publishes
    # everything flat at top level (see time_dist_sgv_main.cpp's own comment
    # on why: it is the one tool of the eleven that does).
    CASES = [
        ("time_dist", lambda d: d["statistics"], lambda d: d["statistics"]["reached_cutoff"]),
        ("time_dist_dual", lambda d: d["statistics"], lambda d: d["statistics"]["reached_cutoff"]),
        ("time_dist_sgv", lambda d: d, lambda d: d["reached_cutoff"]),
    ]
    CSV_HEADER = {
        "time_dist": "time,P_ext,P_fix,P_total,cdf_ext,cdf_fix,cdf_total",
        "time_dist_dual": "time,P_ext,P_fix,P_total,cdf_total",
        "time_dist_sgv": "time,pdf,cdf",
    }

    print("--- default cutoff (converged): disclosure keys, no stderr note ---")
    for tool, stats, reached in CASES:
        proc = run(tool, MODEL_ARGS[tool] + ["--json"])
        label = f"{tool} default cutoff"
        check(f"{label}: exit 0", proc.returncode == 0, f"exit={proc.returncode}")
        d = assert_clean_json(label, proc)
        if d:
            st = stats(d)
            cutoff = st["distribution_cutoff"]
            check(f"{label}: reached_cutoff true", reached(d) is True)
            check(f"{label}: cdf_rescaled true", st.get("cdf_rescaled") is True,
                  repr(st.get("cdf_rescaled")))
            mass = st.get("cdf_pre_rescale_mass")
            check(f"{label}: cdf_pre_rescale_mass present", mass is not None)
            check(f"{label}: cdf_pre_rescale_mass approx cutoff ({cutoff!r})",
                  mass is not None and close(mass, cutoff, rel=1e-3), repr(mass))
        # The default cutoff (1-1e-8) is far above the 0.99 threshold: no note.
        check(f"{label}: stderr carries no rescale-disclosure note (cutoff far above 0.99)",
              RESCALE_NOTE_MARKER not in proc.stderr, proc.stderr.strip()[:160])

    print("--- -d 0.5 (deliberate low cutoff): disclosure keys + stderr note ---")
    for tool, stats, reached in CASES:
        proc = run(tool, MODEL_ARGS[tool] + ["-d", "0.5", "--json"])
        label = f"{tool} -d 0.5"
        check(f"{label}: exit 0", proc.returncode == 0, f"exit={proc.returncode}")
        d = assert_clean_json(label, proc)
        if d:
            st = stats(d)
            check(f"{label}: reached_cutoff true", reached(d) is True)
            check(f"{label}: cdf_rescaled true", st.get("cdf_rescaled") is True,
                  repr(st.get("cdf_rescaled")))
            mass = st.get("cdf_pre_rescale_mass")
            # Not a tight equality: time_dist's cutoff is applied separately to
            # each branch's OWN total (target_ext/target_fix), so when the two
            # branches converge at different rates the combined captured mass
            # can overshoot 0.5 substantially even though each branch is right
            # at its own target -- verified empirically (0.5 -> 0.82 total in
            # one asymmetric case). >= cutoff and < 1 (strictly -- otherwise
            # this could not be distinguished from the POST-rescale value) is
            # what is actually guaranteed for all three tools.
            check(f"{label}: cdf_pre_rescale_mass in [0.5, 1)",
                  mass is not None and 0.5 <= mass < 1.0, repr(mass))
        check(f"{label}: stderr carries the rescale-disclosure note",
              RESCALE_NOTE_MARKER in proc.stderr, proc.stderr.strip()[:200])
        check(f"{label}: stderr note names the triggering cutoff (0.5)",
              "0.5" in proc.stderr, proc.stderr.strip()[:200])
        check(f"{label}: stderr note explains the conditionality",
              "conditional" in proc.stderr, proc.stderr.strip()[:200])

    print("--- -d 0.5 --csv: structure unchanged, note is the only channel ---")
    for tool, _stats, _reached in CASES:
        proc = run(tool, MODEL_ARGS[tool] + ["-d", "0.5", "--csv"])
        label = f"{tool} -d 0.5 --csv"
        check(f"{label}: exit 0", proc.returncode == 0, f"exit={proc.returncode}")
        lines = [l for l in proc.stdout.splitlines() if l.strip()]
        check(f"{label}: CSV header unchanged",
              bool(lines) and lines[0] == CSV_HEADER[tool],
              lines[0] if lines else "no output")
        data = [l for l in lines if not l.startswith("time,")]
        last_col = float(data[-1].split(",")[-1]) if data else None
        check(f"{label}: last row's CDF column still ends at 1 (structure unchanged)",
              last_col is not None and close(last_col, 1.0, rel=1e-9), repr(last_col))
        check(f"{label}: stderr still carries the rescale-disclosure note",
              RESCALE_NOTE_MARKER in proc.stderr, proc.stderr.strip()[:200])

    print("--- -d 0.5, plain text: note fires regardless of format ---")
    for tool, _stats, _reached in CASES:
        proc = run(tool, MODEL_ARGS[tool] + ["-d", "0.5"])
        label = f"{tool} -d 0.5 (plain)"
        check(f"{label}: exit 0", proc.returncode == 0, f"exit={proc.returncode}")
        check(f"{label}: stderr carries the rescale-disclosure note",
              RESCALE_NOTE_MARKER in proc.stderr, proc.stderr.strip()[:200])


def test_degenerate_cutoff_refuses():
    print("\n=== degenerate --distribution-cutoff: refuse, do not print an empty table ===")
    cases = [
        ("time_dist_sgv", ["-N", "20", "-L", "0.5", "-s", "0,0.01", "-d", "-1", "--csv"]),
        ("time_dist_sgv", ["-N", "20", "-L", "0.5", "-s", "0,0.01", "-d", "0", "--csv"]),
        ("time_dist", ["-N", "20", "-d", "0", "--csv"]),
        ("time_dist_dual", ["-N", "20", "-d", "0", "--csv"]),
    ]
    for tool, args in cases:
        proc = run(tool, args)
        label = f"{tool} {' '.join(args[-3:-1])}"
        check(f"{label}: nonzero exit", proc.returncode != 0, f"exit={proc.returncode}")
        check(f"{label}: stderr carries a diagnostic",
              len(proc.stderr.strip()) > 0, proc.stderr.strip()[:80])
        data = [r for r in proc.stdout.splitlines()
                if r.strip() and not r.startswith("time,")]
        check(f"{label}: no data table on stdout", not data, str(data[:1]))


def test_phase_type_moments_refuses_nonfinite():
    print("\n=== phase_type_moments: never print nan/inf ===")
    for fmt in ("--csv", "--json", None):
        args = ["-N", "10", "-k", "50"] + ([fmt] if fmt else [])
        proc = run("phase_type_moments", args)
        label = f"ptm -N 10 -k 50 {fmt or '(text)'}"
        check(f"{label}: nonzero exit", proc.returncode != 0, f"exit={proc.returncode}")
        check(f"{label}: stdout holds no nan/inf",
              NONFINITE_TOKEN.search(proc.stdout) is None)
        check(f"{label}: stderr carries a diagnostic",
              len(proc.stderr.strip()) > 0, proc.stderr.strip()[:100])


def test_phase_type_moments_safe_k():
    print("\n=== phase_type_moments: a safe -k still works ===")
    proc = run("phase_type_moments", ["-N", "10", "-k", "4", "--json"])
    label = "ptm -N 10 -k 4"
    check(f"{label}: exit 0", proc.returncode == 0, f"exit={proc.returncode}")
    d = assert_clean_json(label, proc)
    if d:
        moments = d["results"]["raw_moments"]
        check(f"{label}: 4 moments returned", len(moments) == 4, str(len(moments)))
        check(f"{label}: all moments finite",
              all(math.isfinite(x) for x in moments))
        check(f"{label}: mean and std_dev finite",
              math.isfinite(d["results"]["mean"]) and
              math.isfinite(d["results"]["std_dev"]))

    # -k 1 is the smallest legal request. The standard deviation needs the
    # second moment, so the tool must obtain it internally rather than index
    # past the end of the moment matrix.
    proc = run("phase_type_moments", ["-N", "10", "-k", "1", "--json"])
    label = "ptm -N 10 -k 1"
    check(f"{label}: exit 0", proc.returncode == 0, f"exit={proc.returncode}")
    d = assert_clean_json(label, proc)
    if d:
        check(f"{label}: 1 moment returned",
              len(d["results"]["raw_moments"]) == 1)


def test_sgv_rejects_unwired_recurrent_mutation_flag():
    print("\n=== time_dist_sgv: -r is not wired into the model, so refuse it ===")
    args = ["-N", "20", "-L", "0.5", "-s", "0.1,0.1", "-u", "0.01,0.01",
            "-v", "0.01,0.01", "-d", "0.9"]
    proc = run("time_dist_sgv", args + ["-r", "--json"])
    check("sgv -r: nonzero exit", proc.returncode != 0, f"exit={proc.returncode}")
    check("sgv -r: stderr names the limitation",
          "not supported" in proc.stderr.lower(), proc.stderr.strip()[:120])
    check("sgv -r: no distribution on stdout", "distribution" not in proc.stdout)

    # ... and the misleading verbose echo of the flag is gone.
    proc = run("time_dist_sgv", args + ["--verbose"])
    check("sgv --verbose: no recurrent_mutation echo",
          "recurrent_mutation" not in proc.stdout,
          [l for l in proc.stdout.splitlines() if "recurrent" in l][:1])


def test_no_stale_integration_cutoff_echo():
    print("\n=== integration_cutoff is not used by these tools, so do not echo it ===")
    # -c is an accepted alias for --distribution-cutoff here; whatever the user
    # passes, options.integration_cutoff stays at its hardcoded 1e-10 and never
    # reaches the computation. A provenance block must not carry it.
    proc = run("time_dist", ["-N", "20", "-c", "0.9", "--json"])
    d = assert_clean_json("time_dist -c 0.9", proc)
    if d:
        check("time_dist JSON parameters: no integration_cutoff",
              "integration_cutoff" not in d["parameters"],
              str(sorted(d["parameters"])))
        check("time_dist JSON statistics: distribution_cutoff reports the -c value",
              close(d["statistics"]["distribution_cutoff"], 0.9),
              repr(d["statistics"].get("distribution_cutoff")))

    verbose_cases = [
        ("time_dist", ["-N", "20", "-m", "5", "-c", "0.9", "--verbose"]),
        ("time_dist_dual", ["-N", "20", "-m", "5", "-c", "0.9", "--verbose"]),
        ("time_dist_sgv", ["-N", "20", "-L", "0.5", "-s", "0,0.01",
                           "-m", "5", "-c", "0.9", "--verbose"]),
    ]
    for tool, args in verbose_cases:
        proc = run(tool, args)
        check(f"{tool} --verbose: no integration_cutoff echo",
              "integration_cutoff" not in proc.stdout,
              [l for l in proc.stdout.splitlines() if "integration_cutoff" in l][:1])


# --------------------------------------------------------------------- main


def main() -> int:
    global BIN_DIR
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--bin", type=Path, default=DEFAULT_BIN_DIR,
                    help=f"directory holding the built binaries "
                         f"(default: {DEFAULT_BIN_DIR})")
    opts = ap.parse_args()
    BIN_DIR = opts.bin

    required = ["time_dist", "time_dist_dual", "time_dist_sgv", "phase_type_moments"]
    missing = [t for t in required if not (BIN_DIR / t).is_file()]
    if missing:
        print(f"error: not found in {BIN_DIR}: {', '.join(missing)}. "
              f"Build the CLI first "
              f"(cmake -S wfes-cli -B wfes-cli/build-cx3 && "
              f"cmake --build wfes-cli/build-cx3 -j8).", file=sys.stderr)
        return 2

    print(f"binaries: {BIN_DIR}")
    test_sgv_output_P_does_not_suppress_streams()
    test_truncated_runs_disclose()
    test_converged_runs_still_normalise()
    test_cdf_rescale_disclosure()
    test_degenerate_cutoff_refuses()
    test_phase_type_moments_refuses_nonfinite()
    test_phase_type_moments_safe_k()
    test_sgv_rejects_unwired_recurrent_mutation_flag()
    test_no_stale_integration_cutoff_echo()

    print(f"\n{'='*70}")
    print(f"{N_CHECKS - len(FAILURES)}/{N_CHECKS} checks passed")
    if FAILURES:
        print("failed:")
        for f in FAILURES:
            print(f"  - {f}")
    return 1 if FAILURES else 0


if __name__ == "__main__":
    sys.exit(main())
