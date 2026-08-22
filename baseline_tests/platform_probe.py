#!/usr/bin/env python3
"""The one place a suite asks "what does THIS machine have?".

Why this file exists
--------------------
The twelve suites in this directory were all written and recorded on macOS,
against a build with Accelerate/SuiteSparse/ParU and with the shipped
v3.0.0-beta.3 reference installed at /Applications/WFES3.app. The first Linux
run (2026-08-21, /work/dk_lab/wfes3-linux-verify, MKL Pardiso build) turned
every one of those unstated assumptions into a red check:

  * `--library Accelerate`, `--library SuiteSparse` and `--library ParU` are
    refused by a build that only has Pardiso -- 39 failures across
    test_shared_parser.py, test_flag_canonicalization.py and
    test_paru_multirhs.py, all of them the harness asking for a backend that
    is not there;
  * /Applications/WFES3.app does not exist on Linux, so every shipped-binary
    comparison silently stopped running -- 25 CHECKS LOST, plus one suite
    exiting 2;
  * md5s of tool stdout recorded on macOS do not survive a change of LU
    implementation and libm -- 17 digest failures, on runs whose parsed
    numbers were still checked and still fine.

None of that is a defect in the Linux binaries. All of it is the test estate
speaking macOS. A capability question therefore gets asked ONCE, here, by
querying the binary under test rather than by consulting sys.platform, and
every suite imports the answer.

What a suite must do with the answer
------------------------------------
NEVER weaken a check that the local machine can actually run. The rule is:

    capability present  ->  run the check, exactly as recorded
    capability absent   ->  emit a NAMED, COUNTED skip

A skip is not a quiet `return`. It prints a line naming the check that did not
run and why, and it is added to a counter whose total the suite prints in a
machine-readable summary line:

    SKIPPED 33 (--library Accelerate: not in this build's whitelist)

run_all_suites.py reads that line and expects `recorded_count - skipped` checks
to have run, so a skip is subtracted from the contract rather than hidden by
it. A check that stops running WITHOUT being reported here still trips CHECKS
LOST, on every platform. And on the recording platform the runner requires
SKIPPED 0: if the shipped reference goes missing on the Mac the counts were
taken on, that is a broken workstation, not a platform difference.

Testing this file's own absent-capability paths
-----------------------------------------------
Set WFES3_SHIPPED_BIN to a path that does not exist to rehearse the
"no shipped reference" branch on a machine that has one:

    WFES3_SHIPPED_BIN=/nonexistent python3 baseline_tests/run_all_suites.py ...

That override exists so the Linux path can be exercised before it is run on
Linux. It cannot make a check pass that would otherwise fail -- it can only
turn a comparison into a counted skip.
"""
from __future__ import annotations

import functools
import json
import os
import platform
import re
import subprocess
import sys
from pathlib import Path

# ---------------------------------------------------------------------------
# Where the recorded expectations come from.
#
# Every recorded md5, every recorded numeric value and every count in
# run_all_suites.py's EXPECTED table was taken on macOS (arm64, Accelerate
# requested / SuiteSparse effective) with /Applications/WFES3.app v3.0.0-beta.3
# installed. That machine is the reference; anywhere else is a comparison.
# ---------------------------------------------------------------------------
RECORDING_PLATFORM = "macos"

# The backend that ACTUALLY factorised the matrices behind every recorded
# value: SolverFactory serves an "Accelerate" request with SuiteSparse/UMFPACK
# whenever the build has SuiteSparse, which every macOS build does. So the
# recorded numbers are SuiteSparse numbers, and "same backend as the recording"
# means library_effective == "SuiteSparse".
RECORDING_BACKEND = "SuiteSparse"

# Cross-backend tolerance tier. See cross_backend_rel_tol() below for the
# measurements and the rationale; it is applied ONLY when the build under test
# factorises with a different backend than the recording did.
CROSS_BACKEND_REL_TOL = 1e-9

# The shipped v3.0.0-beta.3 reference, as installed by the macOS .app bundle.
# WFES3_SHIPPED_BIN overrides the directory (see the module docstring).
DEFAULT_SHIPPED_BIN = Path("/Applications/WFES3.app/Contents/Resources/bin")

# Decode tool output as UTF-8 with replacement, ALWAYS.
#
# The tools print a box-drawing banner (U+2588 FULL BLOCK and friends) on
# stdout AND, on the refusal path, on stderr. `subprocess.run(text=True)`
# decodes with locale.getpreferredencoding(False), which on a cluster shell
# with LC_ALL=C or POSIX is ANSI_X3.4-1968 -- so a suite that merely runs a
# tool and reads its stderr dies with UnicodeDecodeError, mid-run, with no
# summary line. That is a property of the login shell, not of the binaries.
# Pinning the codec here makes every suite read the same bytes the same way on
# every machine.
TEXT_IO = {"encoding": "utf-8", "errors": "replace"}


def platform_tag() -> str:
    """A short, stable name for the machine's OS: macos / linux / windows."""
    return {"darwin": "macos", "linux": "linux", "win32": "windows"}.get(
        sys.platform, sys.platform)


def is_recording_platform() -> bool:
    """True on the platform every recorded value in this directory came from."""
    return platform_tag() == RECORDING_PLATFORM


def platform_banner(bindir: Path | None = None) -> str:
    """One line naming what this run is being judged against."""
    line = (f"platform: {platform_tag()} ({platform.machine()}); "
            f"recording platform: {RECORDING_PLATFORM}")
    if bindir is not None:
        libs = library_whitelist(bindir)
        line += f"; --library whitelist: {', '.join(libs) if libs else '(unreadable)'}"
    shipped = shipped_bin_dir()
    line += f"; shipped reference: {shipped if shipped else '(absent)'}"
    return line


# ---------------------------------------------------------------------------
# The shipped reference
# ---------------------------------------------------------------------------

def shipped_root() -> Path:
    """Where the shipped reference binaries are looked for, installed or not.

    This is the value a suite should use as its `--shipped`/`--reference`
    argparse default, so that WFES3_SHIPPED_BIN reaches it. Whether anything
    is actually there is a separate question -- ask shipped_reference().
    """
    override = os.environ.get("WFES3_SHIPPED_BIN")
    return Path(override) if override else DEFAULT_SHIPPED_BIN


def _shipped_root() -> Path:
    return shipped_root()


def shipped_bin_dir() -> Path | None:
    """The directory of shipped reference binaries, or None if not installed."""
    root = _shipped_root()
    return root if root.is_dir() else None


def shipped_reference(tool: str) -> Path | None:
    """The shipped copy of `tool`, or None when it is not installed here.

    A None here means "this machine cannot make that comparison". It never
    means "the comparison is optional": the caller must turn it into a named,
    counted skip.
    """
    root = _shipped_root()
    candidate = root / tool
    return candidate if candidate.is_file() else None


def has_shipped_reference() -> bool:
    return shipped_bin_dir() is not None


# ---------------------------------------------------------------------------
# The build's solver-backend whitelist
# ---------------------------------------------------------------------------

_WHITELIST_RE = re.compile(r"Library \(([^)]*)\)")
_REFUSAL_RE = re.compile(r"This build supports:\s*([^\n]*)")
# "Accelerate, SuiteSparse, or ParU" -> three names, not two names and
# "or ParU": the comma alternative has to consume the Oxford "or" with it,
# because by the time the plain `\s+or\s+` alternative is tried the comma has
# already eaten the space in front of it.
_SPLIT_RE = re.compile(r",\s*(?:or\s+)?|\s+or\s+")

# A --library value no build will ever have, used to make the parser print its
# own whitelist. Chosen to be obviously synthetic in a log.
_IMPOSSIBLE_LIBRARY = "NoSuchBackend"


def _first_tool(bindir: Path) -> Path | None:
    """Any binary in `bindir` that can be asked about --library."""
    if bindir.is_file():
        return bindir
    for name in ("wfes_single", "wfes_switching", "wfafs_stochastic",
                 "phase_type_moments", "time_dist"):
        candidate = bindir / name
        if candidate.is_file():
            return candidate
    return None


def _run(binary: Path, args: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run([str(binary), *args], capture_output=True,
                          timeout=600, **TEXT_IO)


@functools.lru_cache(maxsize=None)
def _whitelist_for(binary: str) -> tuple[str, ...]:
    path = Path(binary)
    # 1. --help. Args_Parser::supported_libraries() is the single source of
    #    truth for the help text, for what --library accepts and for the name
    #    that appears in library_effective, so reading it back out of --help
    #    asks the build itself rather than assuming a platform's backend list.
    try:
        helped = _run(path, ["--help"])
    except (OSError, subprocess.SubprocessError):
        return ()
    m = _WHITELIST_RE.search(helped.stdout) or _WHITELIST_RE.search(helped.stderr)
    if not m:
        # 2. The refusal message, which lists the same set:
        #    "Error: Unknown --library value 'X'. This build supports: Pardiso"
        try:
            refused = _run(path, ["--library", _IMPOSSIBLE_LIBRARY])
        except (OSError, subprocess.SubprocessError):
            return ()
        m = (_REFUSAL_RE.search(refused.stderr)
             or _REFUSAL_RE.search(refused.stdout))
    if not m:
        return ()
    return tuple(tok.strip() for tok in _SPLIT_RE.split(m.group(1))
                 if tok.strip())


def library_whitelist(bindir: Path) -> tuple[str, ...]:
    """Every --library value this build accepts, in the order it advertises.

    `bindir` may be a directory of binaries or a single binary. Returns an
    empty tuple only if the build could not be asked at all -- callers must
    treat that as "unknown", not as "no libraries".
    """
    tool = _first_tool(Path(bindir))
    return _whitelist_for(str(tool)) if tool else ()


def has_library(bindir: Path, name: str) -> bool:
    """Does this build accept `--library name`?"""
    return name in library_whitelist(bindir)


def pick_library(bindir: Path, preferred: str, *fallbacks: str) -> str | None:
    """`preferred` if the build has it, else the first available fallback, else
    the first whitelisted backend, else None.

    Used to keep a check that needs SOME valid backend running everywhere,
    with the recorded choice preserved wherever it exists -- so macOS goes on
    testing exactly the name it recorded.
    """
    libs = library_whitelist(bindir)
    for name in (preferred, *fallbacks):
        if name in libs:
            return name
    return libs[0] if libs else None


def substituting_request(bindir: Path) -> str | None:
    """A --library value this build SERVES WITH A DIFFERENT BACKEND, or None.

    SolverFactory::createSolver answers "Accelerate" with SuiteSparse/UMFPACK
    whenever the build has SuiteSparse -- the substitution the requested-vs-
    effective provenance pair exists to disclose. A build with no SuiteSparse
    substitutes nothing, and the checks that assert the substitution have no
    subject there.
    """
    libs = library_whitelist(bindir)
    if "Accelerate" in libs and "SuiteSparse" in libs:
        return "Accelerate"
    return None


def expected_effective(bindir: Path, requested: str) -> str:
    """The backend that will actually factorise when `requested` is asked for."""
    if requested == substituting_request(bindir):
        return "SuiteSparse"
    return requested


@functools.lru_cache(maxsize=None)
def _effective_backend_for(binary: str) -> str | None:
    try:
        proc = _run(Path(binary), ["--absorption", "-N", "10", "--json"])
        doc = json.loads(proc.stdout)
    except (OSError, subprocess.SubprocessError, json.JSONDecodeError):
        return None
    block = doc.get("parameters", doc)
    if not isinstance(block, dict):
        block = doc
    value = block.get("library_effective")
    return value if isinstance(value, str) else None


def effective_backend(bindir: Path) -> str | None:
    """The backend an unflagged run of this build actually factorises with.

    Read from the run's own library_effective field (audit section 2.3), not
    inferred from the platform: the whole point of that field is that the
    request and the backend can differ.
    """
    tool = _first_tool(Path(bindir))
    if tool is None:
        return None
    single = tool.parent / "wfes_single"
    return _effective_backend_for(str(single if single.is_file() else tool))


def same_backend_as_recording(bindir: Path) -> bool:
    """True when this build factorises with the backend the values were
    recorded against. Unknown (unreadable) counts as NOT the same: the looser
    cross-backend tier is the safe direction for a machine we cannot identify,
    and it is announced in the log either way."""
    return effective_backend(bindir) == RECORDING_BACKEND


def cross_backend_rel_tol(bindir: Path, recorded_tol: float) -> tuple[float, str]:
    """(tolerance, one-line explanation) for comparing against a recorded value.

    On the recording backend the recorded tolerance applies UNCHANGED -- there
    is no cross-platform slack on the machine the numbers came from.

    On any other backend the comparison is between two independent LU
    implementations, and the recorded tolerances in this directory were
    measured against run-to-run noise of exactly zero (repeated runs of one
    binary are bit-identical), not against implementation spread. Two
    measurements of that spread, on the SAME two fields both times:

      * ParU vs SuiteSparse, macOS, 2026-08-21: 184 of 186 recorded fields
        bit-for-bit identical; sw_fix_2model's T_fix and its reciprocal `rate`
        differ by 2.6e-11 (see test_numeric_switching_sequential.py's
        "Tolerance" block);
      * MKL Pardiso (Linux) vs SuiteSparse, 2026-08-21: the same 184 fields
        agree to <= 1.6e-14, and the same two differ by 2.33e-10
        (T_fix 54463721.4784434 recorded vs 54463721.49112928 measured --
        0.013 absolute on a number of order 5.4e7, i.e. agreement to ~10
        significant figures).

    T_fix there is the largest quantity in the table: a sum of sojourn times
    over the whole transient state space, where a different pivot order
    accumulates rounding differently. Nothing else in the table moves.

    CROSS_BACKEND_REL_TOL = 1e-9 is therefore about 4x the largest spread
    measured so far, and 4x is thin -- stated plainly rather than rounded up,
    because the honest thing to do if a third backend exceeds it is to measure
    that backend and say so, not to widen the tier again. It remains orders of
    magnitude below any physically interesting change in these quantities, so
    a real regression still fails.
    """
    if same_backend_as_recording(bindir):
        return recorded_tol, (f"{recorded_tol:.0e} (recording backend "
                              f"{RECORDING_BACKEND})")
    got = effective_backend(bindir) or "unknown"
    return CROSS_BACKEND_REL_TOL, (
        f"{CROSS_BACKEND_REL_TOL:.0e} cross-backend tier "
        f"(effective backend {got}, recorded against {RECORDING_BACKEND}; "
        f"recorded tolerance {recorded_tol:.0e} applies on the recording "
        f"backend only)")


# ---------------------------------------------------------------------------
# Byte-identity locks
# ---------------------------------------------------------------------------
#
# Several suites lock a healthy run's stdout with an md5. That is the right
# instrument for what it was written to catch -- "did any number in this
# published document move?" -- and it is exact, which is why it caught real
# regressions during the audit. It is also, unavoidably, a digest of PRINTED
# DOUBLES, and therefore of the whole toolchain: libm's exp/log, whether the
# compiler contracted a multiply-add, and, for anything behind a solve, which
# LU implementation chose which pivots. None of that is stable across
# platforms, and none of it has to be for the tools to be correct.
#
# The first Linux run produced 17 digest failures on runs whose parsed numbers
# were still checked and still fine -- including, in wfafs_deterministic, a
# PLAIN-text digest that MATCHED while the json and csv digests of the same
# run did not, which is exactly the signature of last-place differences in a
# more precisely printed format rather than of a different answer.
#
# So the digests are asserted only where they were recorded, and skipped by
# name everywhere else.
#
# TODO (needs a Linux machine; cannot be done from macOS)
# ------------------------------------------------------
# Per-platform digests would restore the lock on Linux instead of skipping it.
# Recording them requires a Linux run and must not be guessed. Procedure:
#
#   1. Build Release on the target platform and run each digest suite
#      standalone, confirming that every non-digest check passes -- the
#      digests are only worth recording for a build that is otherwise green:
#          python3 baseline_tests/test_degenerate_wfafs_stochastic.py --bin DIR
#          python3 baseline_tests/test_degenerate_wfafs_deterministic.py --bin DIR
#          python3 baseline_tests/test_degenerate_wfafs_sweep.py --bin DIR
#   2. Run each digest case TWICE on that machine and confirm the two digests
#      are identical. A digest that does not repeat is not a lock, and this
#      step is what distinguishes "stable platform difference" from "this run
#      was nondeterministic", which is a defect and must be reported.
#   3. Print the measured digest for each case (each suite's FAIL detail
#      already carries "recorded X, got Y"; Y is the candidate) and add it to
#      that suite's table under the platform tag, alongside the macOS value --
#      never replacing it.
#   4. Cross-check ONE case numerically against the macOS run before trusting
#      any of them: parse both documents and confirm every field agrees to
#      CROSS_BACKEND_REL_TOL. A digest difference that is accompanied by a
#      real numeric difference is a defect report, not a new recording.
#
# Until step 4 has been done by someone with both machines, a skip is the
# honest state: it says "not checked here" instead of asserting a number
# nobody measured.
DIGEST_REASON = ("recorded md5 of printed doubles: recorded on "
                 f"{RECORDING_PLATFORM}/{RECORDING_BACKEND}, not portable "
                 "across platform or solver backend (see platform_probe.py "
                 "'Byte-identity locks' for the recording procedure)")


def digests_apply(bindir: Path) -> bool:
    """True only where a recorded md5 of tool stdout can honestly be asserted.

    Deliberately conservative: BOTH the platform and the backend that actually
    factorises have to match the recording, because a digest of printed
    doubles depends on the whole toolchain.
    """
    return is_recording_platform() and same_backend_as_recording(bindir)


# ---------------------------------------------------------------------------
# Named, counted skips
# ---------------------------------------------------------------------------

class Skips:
    """Checks this machine cannot run, named and counted.

    Every entry is a check that WOULD have run on the recording platform and
    is part of that suite's recorded count. Anything else -- a comparison
    deliberately retired, a case that is skipped everywhere -- is not a
    platform skip and must not be counted here, or the recording platform's
    own arithmetic (recorded - skipped == ran) stops adding up.
    """

    def __init__(self) -> None:
        self.total = 0
        self.reasons: list[str] = []
        self.entries: list[tuple[str, str, int]] = []

    def skip(self, name: str, reason: str, checks: int = 1) -> None:
        suffix = f"   (covers {checks} checks)" if checks != 1 else ""
        print(f"  SKIP  {name} -- {reason}{suffix}")
        self.total += checks
        self.entries.append((name, reason, checks))
        if reason not in self.reasons:
            self.reasons.append(reason)

    def summary_line(self) -> str:
        """The machine-readable line run_all_suites.py parses.

        Printed by EVERY suite on EVERY run, including as `SKIPPED 0`, so that
        a missing line means "this suite has not been taught about platform
        capabilities" rather than "this suite skipped nothing".
        """
        if not self.total:
            return "SKIPPED 0"
        return f"SKIPPED {self.total} ({'; '.join(self.reasons)})"


def main() -> int:
    """`python3 baseline_tests/platform_probe.py --bin DIR` -- print what this
    machine looks like to the suites. No checks, no exit status to interpret;
    it is here so a cluster run can paste one line into a report."""
    import argparse
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--bin", type=Path,
                    default=Path(__file__).resolve().parent.parent
                    / "wfes-cli" / "build" / "bin",
                    help="directory holding the built binaries")
    opts = ap.parse_args()
    print(platform_banner(opts.bin))
    print(f"effective backend (unflagged run): {effective_backend(opts.bin)}")
    print(f"substituted request: {substituting_request(opts.bin)}")
    print(f"same backend as recording: {same_backend_as_recording(opts.bin)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
