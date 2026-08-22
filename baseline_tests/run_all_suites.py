#!/usr/bin/env python3
"""
Run every baseline_tests suite against ONE build, and assert the check counts.

    python3 baseline_tests/run_all_suites.py --bin wfes-cli/build/bin

That is the whole interface. --bin is a DIRECTORY holding the eleven binaries;
the runner translates it for each suite (validate_baselines.py wants a path to
wfes_single, everything else wants the directory). Exit status is 0 only if
every suite passes AND every suite's check count matches the table below.

Why this file exists
--------------------
The 2026-08 integrity remediation grew twelve standalone suites, each with its
own --bin default pointing at whichever scratch build dir its task used
(build-cx1a, build-cx2, build-cx3, ...). Running "the tests" meant knowing all
twelve invocations, and a suite pointed at a stale build could report a
confident PASS about a binary nobody had rebuilt in hours. One command, one
build directory, one table.

THE COUNTS ARE THE CONTRACT
---------------------------
Two separate reviews flagged the same drift class: a suite can lose checks
without anyone noticing. Delete a test function, or let an early `return` skip
a section, and the suite still prints PASS -- just a PASS covering less than it
did yesterday. Green stays green while coverage quietly falls.

So EXPECTED below records each suite's check count, and a mismatch is a
failure:

  * FEWER checks RAN than recorded is the dangerous direction and is reported
    as CHECKS LOST. Nothing legitimate silently removes checks. Either a
    section stopped running (look for an early return, a skipped optional
    reference, or a `continue` in a loop that used to complete) or checks were
    deleted; in both cases the suite is no longer testing what the table says.
    Note that the comparison is against checks RUN (passed + failed), not
    checks passed -- a suite with one genuine failure has not lost anything,
    and reporting it as though it had would point the reader at the wrong
    problem.

  * MORE checks than recorded also fails, as COUNT ROSE. That is not a bug --
    someone added coverage, which is good -- but it must be recorded here
    deliberately, in the same commit. Accepting increases silently would leave
    the obvious hole: delete five real checks, add five trivial ones, and an
    "at least N" rule sees nothing. Exact match closes it.

  * A summary line the runner cannot PARSE is also a failure, not a zero. A
    suite that changed its summary format has to be re-taught here rather than
    silently contributing nothing to the total.

Updating EXPECTED is therefore a deliberate act with a diff, exactly like the
recorded md5s and recorded values elsewhere in this directory. Never adjust a
number here to make a red run green without first understanding which checks
moved and why.

Prerequisites
-------------
  * A build of the CLI. Any build directory works; Release is what the counts
    were recorded against:
        cmake -S wfes-cli -B wfes-cli/build -DCMAKE_BUILD_TYPE=Release
        cmake --build wfes-cli/build -j8

  * /Applications/WFES3.app, the shipped v3.0.0-beta.3 reference. Several
    suites compare against it: test_invalid_output_single.py REQUIRES it (it
    exits 2 without one, because its non-regression table is not optional),
    while test_flag_canonicalization.py, test_degenerate_wfafs_deterministic.py
    and test_degenerate_wfafs_stochastic.py SKIP sections without it -- which
    lowers their counts and shows up here as CHECKS LOST. If you see those
    three drop together, check that the app is installed before looking for a
    regression.

Suites, and where each came from
--------------------------------
validate_baselines.py is the original numerical harness against Ivan Krukov's
recorded wfes2 outputs; the rest were written during the 2026-08 audit, one per
task. Their own docstrings carry the defect each was written for. This file
does not duplicate that; it only runs them and counts.

Note: run instructions for the suites live HERE and in baseline_tests/README.md.
validate_baselines.py is frozen except by explicit approval, so its own usage
comment was deliberately left untouched by the task that added this runner.
"""
from __future__ import annotations

import argparse
import re
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent

# --------------------------------------------------------------------------
# Summary-line parsers.
#
# The suites were written independently and print their totals five different
# ways. Rather than rewrite twelve working suites to agree on a format -- which
# would touch far more code than it is worth and risk changing what they test
# -- each is parsed on its own terms. Every regex is anchored to a line the
# suite prints at the very end.
# --------------------------------------------------------------------------

def _pass_fail(text: str):
    """`PASS 162   FAIL 0` (and the UNRESOLVED variant)."""
    m = re.search(r"^PASS\s+(\d+)\s+FAIL\s+(\d+)(?:\s+UNRESOLVED\s+(\d+))?\s*$",
                  text, re.M)
    if not m:
        return None
    passed, failed = int(m.group(1)), int(m.group(2))
    unresolved = int(m.group(3)) if m.group(3) else 0
    # An UNRESOLVED check is not a pass; validate_baselines.py exits nonzero
    # on it, and it must not be counted toward the recorded total.
    return passed, failed + unresolved


def _checks_failed(text: str):
    """`294 checks, 0 failed` / `37 checks, 0 failure(s)`."""
    m = re.search(r"^(\d+) checks, (\d+) (?:failed|failure\(s\))\s*$",
                  text, re.M)
    if not m:
        return None
    total, failed = int(m.group(1)), int(m.group(2))
    return total - failed, failed


def _slash_passed(text: str):
    """`93/93 checks passed`."""
    m = re.search(r"^(\d+)/(\d+) checks passed\s*$", text, re.M)
    if not m:
        return None
    passed, total = int(m.group(1)), int(m.group(2))
    return passed, total - passed


def _passed_slash(text: str):
    """`PASSED 185/185 checks` or `FAILED 3/185 checks:`."""
    m = re.search(r"^PASSED (\d+)/(\d+) checks\s*$", text, re.M)
    if m:
        passed, total = int(m.group(1)), int(m.group(2))
        return passed, total - passed
    m = re.search(r"^FAILED (\d+)/(\d+) checks:?\s*$", text, re.M)
    if m:
        failed, total = int(m.group(1)), int(m.group(2))
        return total - failed, failed
    return None


def _n_passed_m_failed(text: str):
    """`189 passed, 0 failed`."""
    m = re.search(r"^(\d+) passed, (\d+) failed\s*$", text, re.M)
    if not m:
        return None
    return int(m.group(1)), int(m.group(2))


# --------------------------------------------------------------------------
# THE CONTRACT.
#
# (script, parser, expected number of checks RUN -- passed + failed, so a
#  genuine failure does not read as a lost check)
#
# Recorded 2026-08-21 from commit 28cd2e4 (branch integrity-fixes) built
# Release into wfes-cli/build-c6, with /Applications/WFES3.app v3.0.0-beta.3
# installed as the shipped reference. Read the "THE COUNTS ARE THE CONTRACT"
# section above before changing any number here.
# --------------------------------------------------------------------------
EXPECTED = [
    ("validate_baselines.py",                  _pass_fail,           54),
    ("test_invalid_output_single.py",          _pass_fail,          162),
    ("test_single_output_matrix.py",           _pass_fail,          343),
    # 294 -> 306 (2026-08-21, task CX8): +12. Not new test code -- the same
    # per-field loop in check_csv_header, run over two new columns. Both --csv
    # rows this suite checks now close their parameters group with
    # library_requested,library_effective (audit section 2.3: a "--library
    # Accelerate" run is served by SuiteSparse, so the request alone was never
    # a record of the run). Six check_csv_header call sites x one data row x
    # two columns = 12. The columns carry backend NAMES, so they are asserted
    # against the tool's own --library whitelist rather than against float();
    # see PROVENANCE_COLUMNS in that suite.
    ("test_degenerate_switching_sequential.py", _checks_failed,     306),
    ("test_numeric_switching_sequential.py",   _pass_fail,          330),
    ("test_degenerate_time_dist_family.py",    _slash_passed,        93),
    ("test_degenerate_wfafs_deterministic.py", _passed_slash,       185),
    ("test_degenerate_wfafs_stochastic.py",    _passed_slash,       190),
    ("test_degenerate_wfafs_sweep.py",         _passed_slash,        47),
    # 189 -> 309 (2026-08-21, task CX8): +120 checks for solver-backend
    # provenance. The eleven tools now publish library_requested and
    # library_effective in their --json parameters block (and, for the three
    # whose --csv row already carries parameters, as two columns closing that
    # group), so a run that asked for Accelerate and was served SuiteSparse --
    # every macOS run, flagged or default -- says so in the record a methods
    # section is copied from. The new section runs four cases per tool
    # (identity backend, Accelerate, no flag, unknown flag), then the
    # verbose/JSON agreement check and four --csv cases. Measured against
    # wfes-cli/build-cx8: 61 of them fail on the pre-fix binaries.
    ("test_shared_parser.py",                  _n_passed_m_failed,  309),
    ("test_flag_canonicalization.py",          _n_passed_m_failed,  107),
    ("test_paru_multirhs.py",                  _checks_failed,       37),
]

# validate_baselines.py takes --bin as a PATH TO wfes_single; every other suite
# takes --bin as the directory. Kept as data so the asymmetry is visible rather
# than buried in an `if` inside the run loop.
WANTS_BINARY_NOT_DIR = {"validate_baselines.py": "wfes_single"}


class Result:
    def __init__(self, script, expected):
        self.script = script
        self.expected = expected
        self.passed = None
        self.failed = None
        self.returncode = None
        self.seconds = 0.0
        self.output = ""
        self.problems: list[str] = []

    @property
    def ok(self) -> bool:
        return not self.problems

    def status(self) -> str:
        if not self.problems:
            return "OK"
        return "; ".join(self.problems)


def run_suite(script: str, parser, expected: int, bin_dir: Path,
              timeout: int) -> Result:
    res = Result(script, expected)
    target = bin_dir
    if script in WANTS_BINARY_NOT_DIR:
        target = bin_dir / WANTS_BINARY_NOT_DIR[script]

    argv = [sys.executable, str(HERE / script), "--bin", str(target)]
    started = time.time()
    try:
        proc = subprocess.run(argv, capture_output=True, text=True,
                              timeout=timeout, cwd=REPO)
        res.output = proc.stdout + proc.stderr
        res.returncode = proc.returncode
    except subprocess.TimeoutExpired:
        res.seconds = time.time() - started
        res.problems.append(f"TIMEOUT after {timeout}s")
        return res
    res.seconds = time.time() - started

    if res.returncode == 2:
        # Every suite reserves 2 for "could not run" (missing binaries, missing
        # required reference). That is not a test failure, but it is not a pass
        # either -- reporting it as one is how a suite that never ran gets
        # counted as green.
        res.problems.append("COULD NOT RUN (exit 2 -- missing binary or "
                            "required reference; see output)")
        return res

    counts = parser(res.output)
    if counts is None:
        res.problems.append("UNPARSEABLE SUMMARY (the suite's final line "
                            "changed; teach run_all_suites.py the new format)")
        return res
    res.passed, res.failed = counts

    if res.failed:
        res.problems.append(f"{res.failed} FAILING CHECK"
                            f"{'S' if res.failed != 1 else ''}")
    if res.returncode != 0 and not res.failed:
        res.problems.append(f"nonzero exit ({res.returncode}) with no failing "
                            f"check reported")

    # The count contract is about checks that RAN, not checks that passed.
    # Comparing res.passed against the target would report a suite with one
    # genuine failure as having "lost" a check, which is a different and much
    # more alarming diagnosis than the truth. Total = passed + failed isolates
    # the two: a failing check is a FAILING CHECK, and only a check that never
    # ran at all is a lost one.
    ran = res.passed + res.failed
    if ran < res.expected:
        res.problems.append(
            f"CHECKS LOST ({res.expected - ran} fewer ran than recorded)")
    elif ran > res.expected:
        res.problems.append(
            f"COUNT ROSE (+{ran - res.expected}); record it in EXPECTED")

    return res


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--bin", type=Path,
                    default=REPO / "wfes-cli" / "build" / "bin",
                    help="DIRECTORY holding the built binaries "
                         "(default: %(default)s)")
    ap.add_argument("--jobs", type=int, default=4,
                    help="suites to run concurrently (default: %(default)s; "
                         "use 1 to read the output in order)")
    ap.add_argument("--timeout", type=int, default=1800,
                    help="per-suite timeout in seconds (default: %(default)s)")
    ap.add_argument("--only", action="append", default=None, metavar="SUBSTR",
                    help="run only suites whose filename contains SUBSTR "
                         "(repeatable). The count contract still applies to "
                         "the suites that ran; the others are listed as "
                         "not run, and a partial run always exits nonzero so "
                         "it can never be mistaken for a full green.")
    ap.add_argument("--verbose", action="store_true",
                    help="print each suite's full output, not just failures")
    opts = ap.parse_args()

    bin_dir: Path = opts.bin.resolve()
    if not bin_dir.is_dir():
        print(f"error: --bin {bin_dir} is not a directory. Build first:\n"
              f"  cmake -S wfes-cli -B wfes-cli/build "
              f"-DCMAKE_BUILD_TYPE=Release\n"
              f"  cmake --build wfes-cli/build -j8", file=sys.stderr)
        return 2

    selected = EXPECTED
    if opts.only:
        selected = [row for row in EXPECTED
                    if any(s in row[0] for s in opts.only)]
        if not selected:
            print(f"error: --only {opts.only} matched no suite", file=sys.stderr)
            return 2
    skipped = [row[0] for row in EXPECTED if row not in selected]

    print(f"binaries:  {bin_dir}")
    print(f"suites:    {len(selected)} of {len(EXPECTED)}"
          f"   jobs: {opts.jobs}\n")

    started = time.time()
    with ThreadPoolExecutor(max_workers=max(1, opts.jobs)) as pool:
        futures = [pool.submit(run_suite, script, parser, expected, bin_dir,
                               opts.timeout)
                   for script, parser, expected in selected]
        results = [f.result() for f in futures]
    elapsed = time.time() - started

    name_w = max(len(r.script) for r in results)
    print(f"{'SUITE'.ljust(name_w)}  {'EXPECT':>6} {'PASS':>6} {'FAIL':>5} "
          f"{'TIME':>7}  STATUS")
    print("-" * (name_w + 36))
    total_pass = total_fail = 0
    for r in sorted(results, key=lambda x: x.script):
        total_pass += r.passed or 0
        total_fail += r.failed or 0
        shown_p = "-" if r.passed is None else str(r.passed)
        shown_f = "-" if r.failed is None else str(r.failed)
        print(f"{r.script.ljust(name_w)}  {r.expected:>6} {shown_p:>6} "
              f"{shown_f:>5} {r.seconds:>6.1f}s  {r.status()}")
    print("-" * (name_w + 36))
    expected_total = sum(r.expected for r in results)
    print(f"{'TOTAL'.ljust(name_w)}  {expected_total:>6} {total_pass:>6} "
          f"{total_fail:>5} {elapsed:>6.1f}s")

    bad = [r for r in results if not r.ok]
    for r in results:
        if opts.verbose or r in bad:
            print(f"\n{'=' * 78}\n{r.script}  --  {r.status()}\n{'=' * 78}")
            print(r.output.rstrip())

    if skipped:
        print(f"\nNOT RUN ({len(skipped)}): {', '.join(sorted(skipped))}")

    print()
    if bad:
        print(f"FAIL: {len(bad)} of {len(results)} suites — "
              + ", ".join(f"{r.script} [{r.status()}]" for r in bad))
        return 1
    if skipped:
        print(f"Partial run: {len(results)} suites passed at their recorded "
              f"counts, {len(skipped)} not run. This is NOT a full green.")
        return 1
    print(f"PASS: all {len(results)} suites at their recorded counts "
          f"({total_pass} checks).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
