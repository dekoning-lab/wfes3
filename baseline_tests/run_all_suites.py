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

...AND SO ARE THE SKIPS
-----------------------
The counts in EXPECTED were recorded on macOS, on a machine with every
capability the suites use. Somewhere else -- the Linux/MKL cluster build, for
one -- some of those checks CANNOT run: there is no /Applications/WFES3.app to
compare against, and a build whose --library whitelist is "Pardiso" alone
cannot be asked for Accelerate, SuiteSparse or ParU.

Such a check is not deleted and not quietly dropped. Each suite names it,
counts it, and prints the total on one machine-readable line --

    SKIPPED 33 (--library Accelerate: this build substitutes no backend ...)

-- which this runner reads, so that the contract becomes

    checks that RAN  ==  recorded count  -  skips the suite reported

An UNDECLARED check that stops running is still CHECKS LOST, on every
platform: subtracting only what a suite is willing to name in its own output
is what keeps the two apart. On macOS the subtraction is a no-op (every suite
reports SKIPPED 0), and a nonzero skip there is reported as a FAILURE --
UNEXPECTED SKIPS -- because on the recording platform it means a capability
has gone missing, not that the platform is different. See
platform_probe.py, and LINUX_SKIP_PROJECTION below for what a Linux run is
expected to skip.

Prerequisites
-------------
  * A build of the CLI. Any build directory works; Release is what the counts
    were recorded against:
        cmake -S wfes-cli -B wfes-cli/build -DCMAKE_BUILD_TYPE=Release
        cmake --build wfes-cli/build -j8

  * /Applications/WFES3.app, the shipped v3.0.0-beta.3 reference, ON MACOS.
    Several suites compare against it: test_invalid_output_single.py requires
    it (its non-regression table is not optional -- without it the suite exits
    2, unless this runner passes --no-shipped-reference, which it does only
    when the reference is genuinely absent), while
    test_flag_canonicalization.py, test_degenerate_wfafs_deterministic.py and
    test_degenerate_wfafs_stochastic.py report counted skips for the sections
    that need it. On macOS its absence is a failure (UNEXPECTED SKIPS); on
    Linux, where the .app does not exist at all, it is an accounted-for skip.

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
import os
import re
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent

sys.path.insert(0, str(HERE))
import platform_probe  # noqa: E402

# --------------------------------------------------------------------------
# Two Linux-only failure modes this file had, both of them about text encoding
# rather than about anything the binaries do. Fixed here because the runner is
# the one process that touches every suite.
#
# 1. DECODING what a suite prints. The tools emit a box-drawing banner
#    (U+2588 and friends) on stdout, and on the refusal path on stderr too. A
#    cluster shell with LC_ALL=C or LANG=POSIX makes
#    locale.getpreferredencoding(False) ANSI_X3.4-1968, so `text=True` --
#    here AND inside every suite -- raises UnicodeDecodeError the first time a
#    tool says no. In a suite that surfaces as a traceback with no summary
#    line, which this runner then reports as UNPARSEABLE SUMMARY; here it
#    surfaced as the runner itself dying. Pinning the codec on both sides ends
#    it: this call decodes UTF-8 with replacement, and PYTHONUTF8=1 in the
#    child environment puts every child interpreter into UTF-8 mode, which is
#    what its own subprocess calls decode with. That last part matters for
#    validate_baselines.py, which is frozen and could not be edited to pin its
#    own codec.
#
# 2. ENCODING what this file prints. The failure summary used to contain an em
#    dash. Under the same C locale, with output redirected to a log file,
#    printing it raises UnicodeEncodeError -- so the runner crashed at the
#    exact moment it had something to report, and only ever on a red run. The
#    text is ASCII now, and stdout is reconfigured defensively besides, since
#    it also relays whatever the suites printed.
# --------------------------------------------------------------------------
CHILD_ENV = {**os.environ, "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"}
try:  # pragma: no cover - depends on the ambient locale
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except (AttributeError, ValueError):
    pass

# --------------------------------------------------------------------------
# Summary-line parsers.
#
# The suites were written independently and print their totals five different
# ways. Rather than rewrite twelve working suites to agree on a format -- which
# would touch far more code than it is worth and risk changing what they test
# -- each is parsed on its own terms. Every regex is anchored to a line the
# suite prints at the very end.
# --------------------------------------------------------------------------

def _last(pattern: str, text: str):
    """The LAST line matching `pattern`, or None.

    Last rather than first: a suite's FAIL details quote the tools' own
    output, so a line that looks like a summary can appear in the body long
    before the real one. The summary is always the final such line.
    """
    matches = list(re.finditer(pattern, text, re.M))
    return matches[-1] if matches else None


def _pass_fail(text: str):
    """`PASS 162   FAIL 0` (and the UNRESOLVED variant)."""
    m = _last(r"^PASS\s+(\d+)\s+FAIL\s+(\d+)(?:\s+UNRESOLVED\s+(\d+))?\s*$",
              text)
    if not m:
        return None
    passed, failed = int(m.group(1)), int(m.group(2))
    unresolved = int(m.group(3)) if m.group(3) else 0
    # An UNRESOLVED check is not a pass; validate_baselines.py exits nonzero
    # on it, and it must not be counted toward the recorded total.
    return passed, failed + unresolved


def _checks_failed(text: str):
    """`294 checks, 0 failed` / `37 checks, 0 failure(s)`."""
    m = _last(r"^(\d+) checks, (\d+) (?:failed|failure\(s\))\s*$", text)
    if not m:
        return None
    total, failed = int(m.group(1)), int(m.group(2))
    return total - failed, failed


def _slash_passed(text: str):
    """`93/93 checks passed`."""
    m = _last(r"^(\d+)/(\d+) checks passed\s*$", text)
    if not m:
        return None
    passed, total = int(m.group(1)), int(m.group(2))
    return passed, total - passed


def _passed_slash(text: str):
    """`PASSED 185/185 checks` or `FAILED 3/185 checks:`."""
    m = _last(r"^PASSED (\d+)/(\d+) checks\s*$", text)
    if m:
        passed, total = int(m.group(1)), int(m.group(2))
        return passed, total - passed
    m = _last(r"^FAILED (\d+)/(\d+) checks:?\s*$", text)
    if m:
        failed, total = int(m.group(1)), int(m.group(2))
        return total - failed, failed
    return None


def _n_passed_m_failed(text: str):
    """`189 passed, 0 failed`."""
    m = _last(r"^(\d+) passed, (\d+) failed\s*$", text)
    if not m:
        return None
    return int(m.group(1)), int(m.group(2))


# The one line every capability-aware suite prints, in the format
# platform_probe.Skips.summary_line() produces:
#
#     SKIPPED 0
#     SKIPPED 33 (--library Accelerate: this build substitutes no backend ...)
#
# A suite that prints no such line is read as SKIPPED 0. That is only correct
# for a suite with no capability gate in it, which is why every suite here
# prints the line unconditionally -- validate_baselines.py excepted, because it
# is frozen and has no gate.
SKIPPED_RE = r"^SKIPPED (\d+)(?:\s+\((.*)\))?\s*$"


def parse_skips(text: str) -> tuple[int, str]:
    m = _last(SKIPPED_RE, text)
    if not m:
        return 0, ""
    return int(m.group(1)), (m.group(2) or "")


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
    # 162 -> 178 (2026-08-21, task FINAL): +16 for the two missing injection
    # range guards, in section_injection_range_guards. --absorption has always
    # refused an integration range that overruns its state space, and
    # --establishment got the same guard in CX1a; --fixation's and
    # --allele-age's injection loops had none, so with 4Nu > 1 they indexed
    # outside their vectors under --force. Eight checks per mode: the six
    # repeated runs exit 1 with one identical diagnostic (the pre-fix fixation
    # repro returned 0, 133 and 138 from the same command line -- three
    # outcomes, one of them a printed number), the diagnostic names the range
    # and the bound, nothing is published, no --output-Q survives the refusal,
    # and the in-range neighbour of each still computes. The allele-age pair
    # also pins that the overrun is no longer reported as a double-precision
    # failure, and that the neighbour returns the E[T] the pre-fix binary
    # called unresolvable.
    ("test_invalid_output_single.py",          _pass_fail,          178),
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
    # 93 -> 180 (2026-08-21, task CX-disclose): +87 for disclosing the CDF
    # rescale itself, PI decision "Rescale + disclose" on the open item
    # recorded for this branch. A converged run's JSON already ended its CDF
    # at exactly 1.0; it now also says so explicitly, with two additive
    # keys -- cdf_rescaled: true and cdf_pre_rescale_mass (the captured mass
    # the rescale divided by) -- present exactly when the renormalisation
    # block actually ran, and honestly ABSENT (not false) on a run that
    # stopped at --max-t instead, same as this tool's own
    # mean_extinction/std_extinction convention. When --distribution-cutoff
    # is <= 0.99 (comfortably below the ~1e-8-of-1 default, where the
    # rescale is cleaning up floating-point noise rather than discarding a
    # modeling-relevant tail), the same fact is also printed to stderr,
    # since CSV and plain text carry neither JSON key. +9 in
    # test_truncated_runs_disclose (both keys confirmed absent, and no
    # stderr note, on the existing -m 40 truncated fixture, x3 tools); +9 in
    # test_converged_runs_still_normalise (cdf_rescaled true + mass bounded
    # + stderr note present, on the existing -d 0.9 fixture, x3 tools); +69
    # in the new test_cdf_rescale_disclosure, covering the default cutoff
    # (converged, mass approx cutoff, no note), -d 0.5 (note names the
    # cutoff and the conditionality), --csv (structure unchanged, note still
    # fires), and plain text (note still fires), x3 tools.
    ("test_degenerate_time_dist_family.py",    _slash_passed,       180),
    ("test_degenerate_wfafs_deterministic.py", _passed_slash,       185),
    # 190 -> 242 (2026-08-21, task FINAL): +52 for the missing -p range check,
    # in test_starting_copies_range. The starting copy count was used as a
    # direct subscript of a 2N+1 vector with no bound anywhere, so at
    # -N 10 -G 100 -f 1 both `-p 21` and `-p 100` exited 0 with an empty
    # stderr and an all-zero spectrum -- byte-identical to each other, so the
    # published answer did not depend on what was asked for. Four faults
    # through the suite's own assert_refused (34: the two measured ones, the
    # supplied-negative that used to collide with the "flag absent" sentinel
    # and silently return the equilibrium start, and the -f case that fixes
    # WHERE the bound must be checked) plus three accepted counts at six
    # checks each (18) -- both boundaries and the -f 0.5 case that a
    # typed-value check would falsely refuse. The accepted half is not
    # optional: the pre-fix failure was an all-zero spectrum at exit 0, so an
    # over-refusing guard would look identical in the fault list alone.
    # 242 -> 254 (2026-08-21, task CX-proj): +12 for the down-projection's mass
    # conservation, in test_down_projection_conserves_mass. The step that maps
    # the up-projected spectrum back onto the model's own states AVERAGED the
    # fine states in each output bin instead of summing them, and so published
    # a spectrum missing about (1 - 1/bin-count) of its SEGREGATING mass: 54%
    # of it at -f 2,2, 90% at the 3-epoch -f 10,10,10 model. It read as
    # roundoff because the two boundary classes are copied across verbatim and
    # carry ~0.5 each, so the total still printed as 0.99999988. Two models x
    # six checks: both runs parse, each spectrum's total (the up-projected one
    # at 1e-9, the down-projected one now at 1e-12), the segregating mass
    # across the binning step at rtol 1e-9, and the two boundary classes bit
    # for bit. The segregating check is the one that matters -- a total-only
    # check goes on passing for any model whose boundaries dominate harder.
    # Measured against the pre-fix binary: 18 of this suite's checks fail on
    # it (these 5 plus the 13 re-recorded f != 1 digests and reference-mode
    # assertions), at the same total of 254.
    ("test_degenerate_wfafs_stochastic.py",    _passed_slash,       254),
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
#
# (The first Linux collection run tripped over exactly this, invoking
# validate_baselines.py with the directory and getting
# "error: .../bin not found. Build the CLI first" -- a harness mistake, not a
# missing build. The runner has always got it right; the per-suite ARGV line
# printed below now makes that visible in the log instead of implied.)
WANTS_BINARY_NOT_DIR = {"validate_baselines.py": "wfes_single"}


# --------------------------------------------------------------------------
# THE SAME CONTRACT, OFF THE RECORDING PLATFORM.
#
# EXPECTED above is a macOS recording. Away from macOS some of those checks
# cannot run at all: there is no /Applications/WFES3.app to compare against,
# and a Linux build's --library whitelist is "Pardiso" where the recording's
# was "Accelerate, SuiteSparse, ParU". Those checks are not deleted and not
# quietly dropped -- each suite reports them as named skips and prints the
# total on a SKIPPED line, and the contract becomes
#
#       checks that RAN  ==  recorded count  -  skips the suite reported
#
# so the arithmetic stays exact and a check that stops running WITHOUT being
# declared a skip still trips CHECKS LOST, on every platform.
#
# On the recording platform the subtraction is a no-op by construction: a
# fully equipped macOS box reports SKIPPED 0 for all twelve suites and the
# expected counts are the recorded ones, unchanged. If it ever reports
# anything else, that is a broken workstation (the .app uninstalled, most
# likely) rather than a platform difference, and it is reported as a failure
# instead of being absorbed -- see UNEXPECTED SKIPS below.
#
# The table below is the DERIVED Linux expectation, written out so the cluster
# run has something to be compared against rather than only something to
# report. Each number is the count of recorded checks that a Pardiso-only
# Linux build with no WFES3.app installed cannot run, taken from the
# 2026-08-21 Linux logs and from the skip lists in each suite:
#
#   test_invalid_output_single      51  three shipped-binary comparison sites
#                                       (41 non-regression + 9 -v 0 + 1 --csv)
#   test_shared_parser              33  the Accelerate->SuiteSparse
#                                       substitution, 3 checks x 11 tools
#   test_degenerate_wfafs_stochastic 28 15 recorded md5s + 13 shipped-binary
#                                       comparisons
#   test_paru_multirhs              26  every ParU half of every comparison
#   test_flag_canonicalization       8  the collision checker's negative
#                                       control, which needs the shipped
#                                       binaries to fail against
#   test_degenerate_wfafs_determ.    7  3 recorded md5s + 4 shipped-binary
#                                       comparisons
#   test_degenerate_wfafs_sweep      1  one recorded md5
#
# It is a PROJECTION, not an assertion: a Linux build configured with
# SuiteSparse, or a machine with the reference binaries copied into place,
# will legitimately skip fewer. A deviation is therefore printed loudly and
# not treated as a failure by itself -- what IS enforced is the arithmetic
# above, which holds whatever the build turns out to have.
# --------------------------------------------------------------------------
LINUX_SKIP_PROJECTION = {
    "validate_baselines.py": 0,
    "test_invalid_output_single.py": 51,
    "test_single_output_matrix.py": 0,
    "test_degenerate_switching_sequential.py": 0,
    "test_numeric_switching_sequential.py": 0,
    "test_degenerate_time_dist_family.py": 0,
    "test_degenerate_wfafs_deterministic.py": 7,
    "test_degenerate_wfafs_stochastic.py": 28,
    "test_degenerate_wfafs_sweep.py": 1,
    "test_shared_parser.py": 33,
    "test_flag_canonicalization.py": 8,
    "test_paru_multirhs.py": 26,
}

PROJECTIONS = {"linux": LINUX_SKIP_PROJECTION,
               "macos": {script: 0 for script, _, _ in EXPECTED}}


def extra_args_for(script: str) -> list[str]:
    """Per-suite flags that depend on what this machine has.

    Only one so far. test_invalid_output_single.py REQUIRES the shipped
    reference and exits 2 without it, deliberately: its non-regression table
    is not an optional extra. --no-shipped-reference is the explicit,
    per-machine permission to run the contract sections without it and report
    the comparisons as counted skips, and it is passed ONLY when the reference
    is genuinely absent -- never as a default, and never on a machine that has
    one (where the suite ignores it anyway).
    """
    if (script == "test_invalid_output_single.py"
            and platform_probe.shipped_reference("wfes_single") is None):
        return ["--no-shipped-reference"]
    return []


class Result:
    def __init__(self, script, recorded):
        self.script = script
        self.recorded = recorded      # the macOS recording, never adjusted
        self.expected = recorded      # recorded - skipped, on this machine
        self.passed = None
        self.failed = None
        self.skipped = 0
        self.skip_reason = ""
        self.returncode = None
        self.seconds = 0.0
        self.argv: list[str] = []
        self.output = ""
        self.problems: list[str] = []
        self.notes: list[str] = []

    @property
    def ok(self) -> bool:
        return not self.problems

    def status(self) -> str:
        parts = self.problems + self.notes
        if not parts:
            return "OK"
        return "; ".join(parts)


def run_suite(script: str, parser, recorded: int, bin_dir: Path,
              timeout: int) -> Result:
    res = Result(script, recorded)
    target = bin_dir
    if script in WANTS_BINARY_NOT_DIR:
        target = bin_dir / WANTS_BINARY_NOT_DIR[script]

    res.argv = [sys.executable, str(HERE / script), "--bin", str(target),
                *extra_args_for(script)]
    started = time.time()
    try:
        # Streams are kept apart and stdout is parsed FIRST. Concatenating
        # them and parsing the join can put a stderr line where a summary
        # anchor expects an end-of-line, and on a suite whose stdout does not
        # end in a newline it can splice two lines into one. stderr is still
        # searched as a fallback, and both are relayed in full for a failing
        # suite.
        proc = subprocess.run(res.argv, capture_output=True, timeout=timeout,
                              cwd=REPO, env=CHILD_ENV,
                              encoding="utf-8", errors="replace")
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

    counts = parser(proc.stdout) or parser(res.output)
    if counts is None:
        res.problems.append("UNPARSEABLE SUMMARY (no recognised summary line "
                            "on stdout or stderr -- the suite may have died "
                            "before printing one, or changed its format; the "
                            "full output is relayed below)")
        return res
    res.passed, res.failed = counts
    res.skipped, res.skip_reason = parse_skips(proc.stdout)
    if not res.skipped:  # a suite that printed its summary on stderr
        res.skipped, res.skip_reason = parse_skips(res.output)

    # THE PLATFORM ADJUSTMENT. Recorded on macOS; here, minus whatever this
    # machine declared it could not run.
    res.expected = res.recorded - res.skipped

    if res.skipped and platform_probe.is_recording_platform():
        # macOS is where every count in EXPECTED was taken. A skip here means
        # a capability that was present at recording time has gone missing --
        # /Applications/WFES3.app uninstalled, most likely -- and subtracting
        # it would turn a broken workstation into a quiet green.
        res.problems.append(
            f"UNEXPECTED SKIPS ({res.skipped}) on the recording platform: "
            f"{res.skip_reason or 'no reason given'}")

    projection = PROJECTIONS.get(platform_probe.platform_tag())
    if projection is not None and script in projection:
        want = projection[script]
        if res.skipped != want:
            res.notes.append(
                f"skips differ from the {platform_probe.platform_tag()} "
                f"projection (reported {res.skipped}, projected {want})")

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
    #
    # A DECLARED skip is not a lost check either -- it has already been
    # subtracted from res.expected -- but an UNDECLARED one still is, on every
    # platform. That is the whole point of making suites count their skips
    # rather than letting them return early.
    ran = res.passed + res.failed
    if ran < res.expected:
        res.problems.append(
            f"CHECKS LOST ({res.expected - ran} fewer ran than the "
            f"{res.recorded} recorded minus the {res.skipped} declared "
            f"skipped)")
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
    print(f"{platform_probe.platform_banner(bin_dir)}")
    print(f"effective solver backend: "
          f"{platform_probe.effective_backend(bin_dir)} "
          f"(recorded against {platform_probe.RECORDING_BACKEND})")
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
    print(f"{'SUITE'.ljust(name_w)}  {'RECORD':>6} {'SKIP':>5} {'EXPECT':>6} "
          f"{'PASS':>6} {'FAIL':>5} {'TIME':>7}  STATUS")
    print("-" * (name_w + 48))
    total_pass = total_fail = total_skip = 0
    for r in sorted(results, key=lambda x: x.script):
        total_pass += r.passed or 0
        total_fail += r.failed or 0
        total_skip += r.skipped
        shown_p = "-" if r.passed is None else str(r.passed)
        shown_f = "-" if r.failed is None else str(r.failed)
        print(f"{r.script.ljust(name_w)}  {r.recorded:>6} {r.skipped:>5} "
              f"{r.expected:>6} {shown_p:>6} {shown_f:>5} "
              f"{r.seconds:>6.1f}s  {r.status()}")
    print("-" * (name_w + 48))
    recorded_total = sum(r.recorded for r in results)
    expected_total = sum(r.expected for r in results)
    print(f"{'TOTAL'.ljust(name_w)}  {recorded_total:>6} {total_skip:>5} "
          f"{expected_total:>6} {total_pass:>6} {total_fail:>5} "
          f"{elapsed:>6.1f}s")

    if total_skip:
        print(f"\nSKIPPED ({total_skip} checks this machine cannot run; each "
              f"one is named in its suite's output):")
        for r in sorted(results, key=lambda x: x.script):
            if r.skipped:
                print(f"  {r.script}: {r.skipped} -- "
                      f"{r.skip_reason or 'no reason given'}")

    bad = [r for r in results if not r.ok]
    for r in results:
        if opts.verbose or r in bad:
            print(f"\n{'=' * 78}\n{r.script}  --  {r.status()}\n"
                  f"argv: {' '.join(r.argv)}\n"
                  f"exit: {r.returncode}\n{'=' * 78}")
            print(r.output.rstrip())

    if skipped:
        print(f"\nNOT RUN ({len(skipped)}): {', '.join(sorted(skipped))}")

    print()
    if bad:
        # ASCII only: this line is printed exactly when there is bad news, and
        # under a C locale a non-ASCII character here raises UnicodeEncodeError
        # and destroys the report instead of delivering it.
        print(f"FAIL: {len(bad)} of {len(results)} suites -- "
              + ", ".join(f"{r.script} [{r.status()}]" for r in bad))
        return 1
    if skipped:
        print(f"Partial run: {len(results)} suites passed at their recorded "
              f"counts, {len(skipped)} not run. This is NOT a full green.")
        return 1
    if total_skip:
        print(f"PASS: all {len(results)} suites at their recorded counts "
              f"minus {total_skip} declared platform skips "
              f"({total_pass} checks ran, {recorded_total} recorded on "
              f"{platform_probe.RECORDING_PLATFORM}).")
        return 0
    print(f"PASS: all {len(results)} suites at their recorded counts "
          f"({total_pass} checks).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
