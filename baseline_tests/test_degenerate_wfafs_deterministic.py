#!/usr/bin/env python3
"""
Integrity checks for wfafs_deterministic.

The defect
----------
    wfafs_deterministic -p 2 --pop-sizes 5,10 --generations 0,0 \\
        --selection 0,0 --backward-mu 0,0 --forward-mu 0,0 --json

exited 0 with completely empty stderr and printed 21 bare `nan` tokens as the
allele frequency spectrum. A bare `nan` is not valid JSON -- python's
json.loads and node's JSON.parse both reject it, and jq coerces it -- so the
tool published an unparseable document as a clean success. Nothing in the tool
looked at whether the numbers it printed were numbers.

Root cause
----------
This tool builds every epoch matrix with WF::NON_ABSORBING, which keeps all
2N+1 rows -- including the two boundary rows that the absorbing models
(wfes_single and friends) drop from Q. wfes-lib builds each row in log space
(wrightFisher.cpp binom_row: `ld_binom(start, size, p)` and
`log(p) - log(1 - p)`), which is defined only for a success probability
strictly inside (0, 1):

  * p = 0 makes ld_binom's `k * log(pr)` term 0 * -inf = nan.
  * p = 1 makes `log(1 - p)` = -inf while `log(p) - log(1 - p)` = +inf, so the
    row recurrence adds -inf to +inf = nan.

Either way the row's weight is nan, `r.Q /= r.weight` turns the whole row nan,
and the sparse product spreads it to every state, because the nan row is
multiplied by a coefficient of 0 and 0 * nan = nan.

psi_diploid() returns *exactly* v for row 0 and *exactly* 1 - u for row 2N, so
the two boundary rows are degenerate precisely when:

  * v == 0                (no forward mutation), or
  * 1 - u == 1.0 in double precision, i.e. u below about 1.1e-16 -- which
    includes u == 0 but ALSO catches nonzero rates such as u = 1e-17 or
    u = 1e-30, where the tool produced an all-nan spectrum with no warning.

Non-finite s or h poison the interior rows the same way (`--selection inf` also
yielded an all-nan spectrum at exit 0).

What must happen instead
------------------------
Refuse, don't substitute. A run whose transition matrix cannot be built exits
nonzero with a diagnostic naming the offending parameter, and prints no
results in any output format. Additionally every published probability is
swept for finiteness before any output is emitted, so any *other* route to a
nan (a normalising sum of zero, say) is a refusal rather than a publication.

Usage
-----
    python3 baseline_tests/test_degenerate_wfafs_deterministic.py [--bin DIR]
                                                                 [--reference BIN]

--bin is a DIRECTORY holding wfafs_deterministic (default:
wfes-cli/build-cxdet/bin). --reference is an optional second wfafs_deterministic
binary (default: the one inside an installed WFES3.app) whose healthy-run
output is compared byte for byte against the build under test; it is skipped
if absent. Exit status is 0 only if every check passes.

Note on the recorded md5s
-------------------------
HEALTHY_MD5 locks the healthy-run stdout of all three output formats byte for
byte. The values were recorded from a build of the PRE-FIX code on
macOS/arm64 with the platform-default solver backend, and independently
confirmed to equal the output of the shipped
/Applications/WFES3.app/Contents/Resources/bin/wfafs_deterministic. They exist
so that a guard added to the degenerate path -- or the deletion of the two
dead helper functions in wfafs_deterministic_main.cpp -- cannot quietly move
the healthy path with it. A mismatch means either that regression or an
unrelated change to how this tool formats output; check which before assuming
the worst.

Two such formatting changes have since landed, from the shared-parser work
(task CX6). Neither touches a computed value, and this suite is arranged so
that the numbers stay locked to the original recording anyway:

  plain   this tool was the one of the eleven whose parse function never
          called displayBanner, so a plain run began straight at the spectrum's
          first row. It now prints the banner the other ten print. The recorded
          md5 is UNCHANGED and still checked -- strip_banner() removes the
          banner first, and the remainder is byte-identical to both the
          original recording and the shipped binary. That is a stronger
          statement than a re-recorded digest would be: it proves the numeric
          payload did not move.

  csv     was printed at the stream default of 6 significant figures while the
          --json branch beside it printed 17, so the same tool disagreed with
          itself about how much of a computed double was worth keeping, and 6
          figures cannot be converted back to the double that was computed.
          Both structured formats now carry round-trip precision. This is the
          one recorded digest that had to be re-recorded; the reference-binary
          comparison for csv is numeric rather than byte-wise as a result, so
          the shipped binary still checks the VALUES.

  json    unchanged, byte for byte, against both the recording and the shipped
          binary.

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

This suite's sweep is NONFINITE_RE over `out_text(proc)` and over written
output files; `both_text()` appears only in the DETAIL of a failed check.
Two healthy-run sites swept `both_text()` until task C6 aligned them.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
from decimal import Decimal, InvalidOperation
import tempfile
from pathlib import Path

import platform_probe

REPO = Path(__file__).resolve().parent.parent
DEFAULT_BIN_DIR = REPO / "wfes-cli" / "build-cxdet" / "bin"
DEFAULT_REFERENCE = Path(
    "/Applications/WFES3.app/Contents/Resources/bin/wfafs_deterministic")

# The reference is the SHIPPED v3.0.0-beta.3 binary, which exists only inside
# the macOS .app bundle. Where it is absent this suite used to print a note and
# return, which read downstream as four CHECKS LOST with no reason attached;
# the four comparisons are now named and counted instead.
NO_REFERENCE_REASON = ("shipped v3.0.0-beta.3 wfafs_deterministic not "
                       "installed (second-implementation byte comparison)")

SKIPS = platform_probe.Skips()

# Set in main() from the probe: True only on the platform AND backend the
# HEALTHY_MD5 table was recorded against. See platform_probe's
# "Byte-identity locks" block for why a digest of printed doubles is not a
# portable assertion, and for the procedure that would record a second one.
DIGESTS_APPLY = True

# The validated reproducer, exactly as found.
REPRO = ["-p", "2", "--pop-sizes", "5,10", "--generations", "0,0",
         "--selection", "0,0", "--backward-mu", "0,0", "--forward-mu", "0,0"]

# A healthy two-epoch run: same model, ordinary generation counts and the
# tool's own default mutation rates (1e-9).
HEALTHY = ["-p", "2", "--pop-sizes", "5,10", "--generations", "10,10",
           "--selection", "0,0"]

# 2*10 + 1 states in the final epoch.
HEALTHY_N_STATES = 21

# md5 of raw stdout for HEALTHY in each format (see module docstring).
HEALTHY_MD5 = {
    "json": "6efe032b585a3548704eb72249368ffc",
    # Re-recorded when csv gained round-trip precision (see the docstring).
    # Was db4e7458d2edd6616e6bd60c39cbfe53 at 6 significant figures.
    "csv": "123cc680d4484d71cb980609bce2452d",
    # Unchanged: this is the digest of the output with the banner stripped.
    "plain": "b946c18f78e2bd4eff1a481378a90916",
}

# The banner displayBanner() prints ends with a 60-character rule and a blank
# line. Everything before and including it is identification, not result.
BANNER_END = ("=" * 60 + "\n\n").encode()


def strip_banner(stdout: bytes) -> bytes:
    """The result payload of a plain-format run, with any banner removed.

    Lets the recorded md5s and the shipped-binary comparison keep checking the
    numbers across the addition of the banner, instead of being re-recorded.
    """
    return stdout.split(BANNER_END, 1)[-1]

FORMATS = (("json", ["--json"]), ("csv", ["--csv"]), ("plain", []))

# ---------------------------------------------------------------------------
# Solver-backend provenance lines (task CX8, integrity audit section 2.3)
#
# Every tool's --json parameters block now carries two extra lines:
#
#     "library_requested": "Accelerate",
#     "library_effective": "SuiteSparse",
#
# recording which backend was ASKED FOR and which one actually factorised the
# matrix -- SolverFactory serves an "Accelerate" request with SuiteSparse
# whenever the build has it, which is every shipped macOS build.
#
# They describe the RUN, not the result: no computed value moves because of
# them, and the shipped reference binary predates them entirely. So they are
# removed before the recorded digests are taken and before the byte-for-byte
# reference comparison -- exactly as strip_banner() already removes the banner
# in test_degenerate_wfafs_deterministic.py, and for the same reason. The
# recorded md5s below therefore keep their ORIGINAL pre-fix values and go on
# checking what they were written to check: that the NUMBERS did not move.
#
# The fields themselves are not left unchecked. test_shared_parser.py's
# provenance section asserts them positively, for all eleven tools, in both
# structured formats.
# ---------------------------------------------------------------------------
PROVENANCE_LINE_RE = re.compile(
    rb'^[ \t]*"library_(?:requested|effective)": (?:"[^"]*"|null),?\n', re.M)


def strip_provenance(stdout: bytes) -> bytes:
    """`stdout` with the two solver-backend provenance lines removed."""
    return PROVENANCE_LINE_RE.sub(b"", stdout)

# `inf`, `-inf`, `infinity`, `nan` as standalone tokens. Bounded on both sides
# so that ordinary words ("info") and exponents ("1e-09") do not match.
NONFINITE_RE = re.compile(
    r"(?<![A-Za-z0-9_.])-?(?:inf(?:inity)?|nan)(?![A-Za-z0-9_])", re.IGNORECASE)

# A printed spectrum row, in any of the three formats:
#   json   {"count": 0, "probability": 0.5}
#   csv    0,0.5
#   plain  0<TAB>0.5
SPECTRUM_ROW_RE = {
    "json": re.compile(r'"probability"\s*:'),
    "csv": re.compile(r"^\s*\d+\s*,\s*\S+\s*$", re.MULTILINE),
    "plain": re.compile(r"^\s*\d+\t\S+\s*$", re.MULTILINE),
}

failures: list[str] = []
checks_run = 0


def check(label: str, ok: bool, detail: str = "") -> bool:
    global checks_run
    checks_run += 1
    if ok:
        print(f"  PASS  {label}")
    else:
        print(f"  FAIL  {label}" + (f"\n          {detail}" if detail else ""))
        failures.append(label)
    return ok


def run(binary: Path, args: list[str]) -> subprocess.CompletedProcess:
    """Run the tool, capturing raw bytes so output can be hashed exactly."""
    return subprocess.run([str(binary), *args], capture_output=True)


def out_text(proc: subprocess.CompletedProcess) -> str:
    """stdout only -- the published result, and the only stream the nan/inf
    token sweep scans (see the stderr-scope convention in the docstring)."""
    return proc.stdout.decode("utf-8", "replace")


def err_text(proc: subprocess.CompletedProcess) -> str:
    """stderr only -- asserted against expected diagnostic substrings, never
    swept for tokens."""
    return proc.stderr.decode("utf-8", "replace")


def both_text(proc: subprocess.CompletedProcess) -> str:
    """Both streams, for the human-readable DETAIL of a failed check only.
    Never pass this to NONFINITE_RE."""
    return out_text(proc) + err_text(proc)


def assert_refusal(tool: Path, label: str, model: list[str],
                   wanted_in_stderr: tuple[str, ...]) -> None:
    """A degenerate run must refuse identically in all three output formats.

    Four independent properties are asserted, because no one of them implies
    the others: a nonzero exit says nothing about what reached stdout, and an
    output free of nan tokens says nothing about whether a *wrong but finite*
    spectrum was printed. The fourth -- no spectrum row on stdout -- is what
    actually rules out "printed results, then exited nonzero", which is what a
    guard placed after the output block instead of before it would do.

    The nan/inf sweep is scoped to STDOUT, deliberately. stdout is the
    published artifact and the place where a bare `nan` is invalid JSON;
    stderr is a diagnostic, and a diagnostic whose job is to name the offending
    quantity has to be free to print it. That is already the house pattern --
    wfes_sequential's own refusal reads "Computed T_ext = nan, which is not a
    number this tool can report", and test_degenerate_switching_sequential.py
    correspondingly runs its BAD_JSON_TOKEN check against r.stdout alone.
    Widening this check to stdout+stderr would not make the tool safer; it
    would only force the diagnostics to stop naming the value that broke the
    run.
    """
    for fmt_name, fmt_args in FORMATS:
        proc = run(tool, model + fmt_args)
        stdout = out_text(proc)
        stderr = err_text(proc)
        tag = f"{label} [{fmt_name}]"

        check(f"{tag} exits nonzero", proc.returncode != 0,
              f"exit {proc.returncode}; stdout: {stdout.strip()[:400]}")
        hits = NONFINITE_RE.findall(stdout)
        check(f"{tag} no nan/inf token on stdout", not hits,
              f"found {sorted(set(hits))} in: {stdout.strip()[:400]}")
        check(f"{tag} stderr carries a diagnostic", stderr.strip() != "",
              "stderr was empty")
        lowered = stderr.lower()
        named = [w for w in wanted_in_stderr if w.lower() in lowered]
        check(f"{tag} diagnostic names the offending parameter "
              f"(one of {list(wanted_in_stderr)})", bool(named),
              f"stderr: {stderr.strip()[:400]}")
        check(f"{tag} stdout printed no spectrum row",
              SPECTRUM_ROW_RE[fmt_name].search(stdout) is None,
              f"stdout: {stdout.strip()[:400]}")


# --------------------------------------------------------------------------
# The reproducer
# --------------------------------------------------------------------------

def test_repro_refuses(tool: Path) -> None:
    print("wfafs_deterministic: the validated reproducer (u = v = 0)")
    # u = 0 and v = 0 are both degenerate here; the diagnostic must name at
    # least one of them by flag.
    assert_refusal(tool, "repro", REPRO,
                   ("--backward-mu", "--forward-mu"))


def test_repro_json_is_not_parseable_garbage(tool: Path) -> None:
    """The headline symptom: stdout was a JSON document no parser accepts."""
    print("wfafs_deterministic: the reproducer publishes no unparseable JSON")
    proc = run(tool, REPRO + ["--json"])
    stdout = out_text(proc).strip()
    if stdout == "":
        check("stdout is empty, so there is no unparseable document", True)
        return
    try:
        json.loads(stdout[stdout.find("{"):])
        parsed = True
    except (json.JSONDecodeError, ValueError):
        parsed = False
    check("any JSON left on stdout parses with json.loads", parsed,
          f"stdout: {stdout[:400]}")


def test_repro_output_file_not_written(tool: Path, tmp: Path) -> None:
    """--output-file must not leave a file of nans behind on a refused run."""
    print("wfafs_deterministic: a refused run writes no --output-file")
    path = tmp / "wfafs_det_refused.tsv"
    proc = run(tool, REPRO + ["--output-file", str(path)])
    check("exits nonzero", proc.returncode != 0,
          f"exit {proc.returncode}: {both_text(proc)[:400]}")
    if path.exists():
        body = path.read_text("utf-8", "replace")
        check("--output-file was not created", False,
              f"{path} exists; contents: {body[:200]}")
        check("--output-file holds no nan/inf",
              not NONFINITE_RE.findall(body), f"contents: {body[:200]}")
    else:
        check("--output-file was not created", True)
        check("--output-file holds no nan/inf", True)


# --------------------------------------------------------------------------
# Each degenerate axis on its own
# --------------------------------------------------------------------------

def test_each_degenerate_axis(tool: Path) -> None:
    """Bisected from the reproducer: each of these alone yielded an all-nan
    spectrum at exit 0 in the pre-fix build (verified against both the shipped
    binary and a build of this branch)."""
    cases = [
        ("v = 0 (no forward mutation), single epoch",
         ["-p", "2", "--pop-sizes", "5", "--generations", "10",
          "--selection", "0", "--backward-mu", "1e-9", "--forward-mu", "0"],
         ("--forward-mu",)),
        ("u = 0 (no backward mutation), single epoch",
         ["-p", "2", "--pop-sizes", "5", "--generations", "10",
          "--selection", "0", "--backward-mu", "0", "--forward-mu", "1e-9"],
         ("--backward-mu",)),
        # NOT zero, and accepted by every range check in the tool -- but
        # 1 - 1e-17 == 1.0 in double precision, so row 2N is still degenerate.
        # This is the case a naive `if (u == 0)` guard would miss.
        ("u = 1e-17 (nonzero, but 1 - u rounds to exactly 1)",
         ["-p", "2", "--pop-sizes", "5", "--generations", "10",
          "--selection", "0", "--backward-mu", "1e-17", "--forward-mu", "1e-9"],
         ("--backward-mu",)),
        ("u = 1e-30 (nonzero, same rounding)",
         ["-p", "2", "--pop-sizes", "5", "--generations", "10",
          "--selection", "0", "--backward-mu", "1e-30", "--forward-mu", "1e-9"],
         ("--backward-mu",)),
        # A degenerate epoch anywhere in the chain must be caught, not just
        # the first: the epoch-2 matrix and the size-switch matrix both use
        # epoch 2's rates.
        ("u = 0 in the SECOND epoch only",
         ["-p", "2", "--pop-sizes", "5,10", "--generations", "10,10",
          "--selection", "0,0", "--backward-mu", "1e-9,0",
          "--forward-mu", "1e-9,1e-9"],
         ("--backward-mu",)),
        ("s = inf",
         ["-p", "2", "--pop-sizes", "5", "--generations", "10",
          "--selection", "inf"],
         ("--selection", "-s")),
        ("h = inf",
         ["-p", "2", "--pop-sizes", "5", "--generations", "10",
          "--selection", "0.1", "--dominance", "inf"],
         ("--dominance", "-h")),
        # This tool parses -s/-h by hand with std::stod, which accepts "nan"
        # as an ordinary value, so these are as reachable from the command
        # line as the inf cases above -- and worse in the pre-fix build:
        # psi_diploid() clamps fitnesses with fmax(w, 1e-30), and fmax()
        # RETURNS THE NON-NAN OPERAND, so a NaN selection coefficient was not
        # propagated (which the row-probability checks below would catch the
        # same way they catch inf) -- it was silently substituted with
        # s = -1, a lethal homozygote, and reported as the model asked for.
        # Locked here as a nonzero-exit regression test for the two-layer
        # fix landed in commit 2e52f3f ("Refuse the model parameters that
        # psi_diploid silently substitutes for"): parse_arguments() now runs
        # the shared Args_Parser::validate_model_domain per epoch, which
        # gained an explicit isfinite() check on s/h/u/v/alpha in that
        # commit and fires first (confirmed empirically against this build:
        # stderr is "Invalid model parameters (epoch 1): ... Check
        # --selection (-s)" / "... Check --dominance (-h)", exit 1, stdout
        # empty in all three formats) -- ahead of this file's own
        # require_usable_matrix(), whose independent isfinite(s)/isfinite(h)
        # checks are the second layer if the shared one is ever bypassed.
        ("s = nan",
         ["-p", "2", "--pop-sizes", "5", "--generations", "10",
          "--selection", "nan"],
         ("--selection", "-s")),
        ("h = nan",
         ["-p", "2", "--pop-sizes", "5", "--generations", "10",
          "--selection", "0.1", "--dominance", "nan"],
         ("--dominance", "-h")),
    ]
    for label, model, wanted in cases:
        print(f"wfafs_deterministic: {label}")
        assert_refusal(tool, label, model, wanted)


# --------------------------------------------------------------------------
# The healthy path must be untouched
# --------------------------------------------------------------------------

def test_healthy_unchanged(tool: Path) -> dict[str, str]:
    print("wfafs_deterministic: a healthy run is unaffected")
    digests: dict[str, str] = {}
    for fmt_name, fmt_args in FORMATS:
        proc = run(tool, HEALTHY + fmt_args)
        stdout_bytes = proc.stdout
        stdout = out_text(proc)
        tag = f"healthy [{fmt_name}]"
        if not check(f"{tag} exits 0", proc.returncode == 0,
                     f"exit {proc.returncode}: {both_text(proc)[:400]}"):
            continue
        check(f"{tag} no nan/inf token on stdout",
              not NONFINITE_RE.findall(stdout),
              f"output: {both_text(proc)[:400]}")
        if fmt_name == "plain":
            stdout_bytes = strip_banner(stdout_bytes)
        digest = hashlib.md5(strip_provenance(stdout_bytes)).hexdigest()
        digests[fmt_name] = digest
        if DIGESTS_APPLY:
            check(f"{tag} stdout is byte-identical to the recorded pre-fix "
                  f"output", digest == HEALTHY_MD5[fmt_name],
                  f"md5 {digest}, expected {HEALTHY_MD5[fmt_name]}")
        else:
            SKIPS.skip(f"{tag} stdout is byte-identical to the recorded "
                       f"pre-fix output",
                       f"{platform_probe.DIGEST_REASON}; measured here: "
                       f"{digest}, recorded {HEALTHY_MD5[fmt_name]}")
        rows = SPECTRUM_ROW_RE[fmt_name].findall(stdout)
        check(f"{tag} printed all {HEALTHY_N_STATES} spectrum rows",
              len(rows) == HEALTHY_N_STATES, f"found {len(rows)} rows")
    return digests


def test_healthy_json_parses(tool: Path) -> None:
    print("wfafs_deterministic: the healthy JSON document is well formed")
    proc = run(tool, HEALTHY + ["--json"])
    stdout = out_text(proc)
    if not check("exits 0", proc.returncode == 0,
                 f"exit {proc.returncode}: {both_text(proc)[:400]}"):
        return
    start = stdout.find("{")
    try:
        doc = json.loads(stdout[start:]) if start >= 0 else None
    except (json.JSONDecodeError, ValueError) as exc:
        doc = None
        detail = f"{exc}: {stdout[:400]}"
    else:
        detail = stdout[:400]
    if not check("stdout parses with json.loads", doc is not None, detail):
        return
    spectrum = doc.get("spectrum", [])
    check(f"spectrum has {HEALTHY_N_STATES} entries",
          len(spectrum) == HEALTHY_N_STATES, f"got {len(spectrum)}")
    probs = [entry.get("probability") for entry in spectrum]
    check("every probability is a finite float",
          all(isinstance(p, float) and p == p and abs(p) != float("inf")
              for p in probs),
          f"probabilities: {probs[:5]}")
    if all(isinstance(p, float) for p in probs):
        total = sum(probs)
        check("the spectrum is a probability distribution (sums to 1)",
              abs(total - 1.0) < 1e-9, f"sum {total}")


def test_healthy_output_file(tool: Path, tmp: Path) -> None:
    print("wfafs_deterministic: a healthy --output-file is written and finite")
    path = tmp / "wfafs_det_healthy.tsv"
    proc = run(tool, HEALTHY + ["--output-file", str(path)])
    if not check("exits 0", proc.returncode == 0,
                 f"exit {proc.returncode}: {both_text(proc)[:400]}"):
        return
    if not check("--output-file was created", path.exists(), str(path)):
        return
    body = path.read_text("utf-8", "replace")
    check("--output-file holds no nan/inf", not NONFINITE_RE.findall(body),
          f"contents: {body[:200]}")
    rows = [ln for ln in body.splitlines() if ln.strip()]
    check(f"--output-file holds {HEALTHY_N_STATES} rows",
          len(rows) == HEALTHY_N_STATES, f"found {len(rows)}")


def test_guard_does_not_over_refuse(tool: Path) -> None:
    """The guard rejects a degenerate matrix, not merely a small rate. These
    runs are numerically fine in the pre-fix build and must stay fine: a guard
    written as `u < 1e-9` or `v == 0 || v < eps` would wrongly reject them."""
    print("wfafs_deterministic: legitimate small rates are still accepted")
    cases = [
        ("v = 1e-30 with u = 1e-9 (psi(0) = 1e-30 is strictly positive)",
         ["-p", "2", "--pop-sizes", "5", "--generations", "10",
          "--selection", "0", "--backward-mu", "1e-9",
          "--forward-mu", "1e-30"]),
        ("u = 1e-15 (1 - u is representably below 1)",
         ["-p", "2", "--pop-sizes", "5", "--generations", "10",
          "--selection", "0", "--backward-mu", "1e-15",
          "--forward-mu", "1e-9"]),
        ("zero generations with healthy rates",
         ["-p", "2", "--pop-sizes", "5,10", "--generations", "0,0",
          "--selection", "0,0"]),
    ]
    for label, model in cases:
        proc = run(tool, model + ["--json"])
        check(f"accepted: {label}", proc.returncode == 0,
              f"exit {proc.returncode}: {both_text(proc)[:400]}")
        check(f"finite output: {label}",
              not NONFINITE_RE.findall(out_text(proc)),
              f"output: {both_text(proc)[:400]}")


def parse_csv_spectrum(stdout: str) -> list[str]:
    """The probability column of a `count,probability` csv, as printed."""
    out: list[str] = []
    for line in stdout.splitlines():
        parts = line.split(",")
        if len(parts) != 2:
            continue
        try:
            int(parts[0].strip())
            Decimal(parts[1].strip())
        except (ValueError, InvalidOperation):
            continue
        out.append(parts[1].strip())
    return out


def half_ulp(printed: str) -> Decimal:
    """Half a unit in the last decimal place of `printed`.

    Same convention as validate_baselines.py: a comparison between two decimal
    representations can be no tighter than the coarser of the two, and the
    rounding interval a printed value implies is half a unit in its own last
    place. Using this rather than one blanket relative tolerance matters here,
    because a 6-significant-figure value's relative precision ranges over an
    order of magnitude with its leading digit -- 5e-7 at a leading 9, 5e-6 at a
    leading 1 -- and a single constant is either too loose for most rows or too
    tight for some.
    """
    exponent = Decimal(printed).as_tuple().exponent
    if not isinstance(exponent, int):  # 'n'/'N'/'F' for NaN/Infinity
        raise ValueError(f"non-finite value: {printed!r}")
    return Decimal(1).scaleb(exponent) / 2


# Set by test_matches_reference_binary's caller so the csv branch can re-run the
# build under test; kept module-level rather than threaded through every caller.
REFERENCE_UNDER_TEST: Path | None = None


def test_matches_reference_binary(tool: Path, reference: Path,
                                  digests: dict[str, str]) -> None:
    """Byte-compare the healthy run against a second, independently built
    wfafs_deterministic (by default the one shipped inside WFES3.app)."""
    if not reference.is_file():
        print(f"wfafs_deterministic: reference binary {reference} not present")
        for what in ("[json] byte-identical to the reference binary",
                     "[csv] same row count as the reference binary",
                     "[csv] every value agrees with the reference binary to "
                     "the full precision the reference prints",
                     "[plain] byte-identical to the reference binary"):
            SKIPS.skip(what, NO_REFERENCE_REASON)
        return
    global REFERENCE_UNDER_TEST
    REFERENCE_UNDER_TEST = tool
    print(f"wfafs_deterministic: healthy output matches {reference}")
    for fmt_name, fmt_args in FORMATS:
        ref = run(reference, HEALTHY + fmt_args)
        if ref.returncode != 0:
            check(f"[{fmt_name}] reference binary runs", False,
                  f"exit {ref.returncode}: {both_text(ref)[:200]}")
            continue

        if fmt_name == "csv":
            # The reference predates round-trip csv precision, so it prints the
            # same values at 6 significant figures. Byte-comparing them would
            # only re-assert that the formatting changed. Compare the NUMBERS
            # instead, each to the rounding interval its own printed reference
            # value implies -- agreement to the full precision the reference
            # actually carries, which is all a 6-figure artifact can support.
            got = parse_csv_spectrum(out_text(
                subprocess.run([str(REFERENCE_UNDER_TEST), *HEALTHY, *fmt_args],
                               capture_output=True)))
            want = parse_csv_spectrum(out_text(ref))
            if not check("[csv] same row count as the reference binary",
                         len(got) == len(want), f"{len(got)} vs {len(want)}"):
                continue
            worst_row = worst_excess = None
            for i, (a, b) in enumerate(zip(got, want)):
                diff = abs(Decimal(a) - Decimal(b))
                excess = diff - half_ulp(b)
                if worst_excess is None or excess > worst_excess:
                    worst_excess, worst_row = excess, (i, a, b)
            check("[csv] every value agrees with the reference binary to the "
                  "full precision the reference prints",
                  worst_excess is None or worst_excess <= 0,
                  f"worst row {worst_row}, exceeds its half-ulp by "
                  f"{worst_excess}")
            continue

        # plain: the reference has no banner, and the build under test's digest
        # was taken with the banner stripped, so these compare like for like.
        ref_bytes = strip_banner(ref.stdout) if fmt_name == "plain" else ref.stdout
        ref_digest = hashlib.md5(strip_provenance(ref_bytes)).hexdigest()
        check(f"[{fmt_name}] byte-identical to the reference binary",
              digests.get(fmt_name) == ref_digest,
              f"under test {digests.get(fmt_name)}, reference {ref_digest}")


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Integrity checks for wfafs_deterministic.")
    ap.add_argument("--bin", type=Path, default=DEFAULT_BIN_DIR,
                    help=f"directory holding wfafs_deterministic "
                         f"(default: {DEFAULT_BIN_DIR})")
    ap.add_argument("--reference", type=Path,
                    default=platform_probe.shipped_root() / "wfafs_deterministic",
                    help="a second wfafs_deterministic to byte-compare the "
                         f"healthy run against (default: {DEFAULT_REFERENCE}; "
                         "skipped if absent)")
    opts = ap.parse_args()

    tool = opts.bin / "wfafs_deterministic"
    if not tool.is_file():
        print(f"error: {tool} not found (build it first, or pass --bin)")
        return 2

    global DIGESTS_APPLY
    DIGESTS_APPLY = platform_probe.digests_apply(opts.bin)
    print(f"Binary: {tool}")
    print(platform_probe.platform_banner(opts.bin))
    print(f"recorded md5s asserted here: {DIGESTS_APPLY}\n")
    with tempfile.TemporaryDirectory() as tmpdir:
        tmp = Path(tmpdir)
        test_repro_refuses(tool)
        test_repro_json_is_not_parseable_garbage(tool)
        test_repro_output_file_not_written(tool, tmp)
        test_each_degenerate_axis(tool)
        digests = test_healthy_unchanged(tool)
        test_healthy_json_parses(tool)
        test_healthy_output_file(tool, tmp)
        test_guard_does_not_over_refuse(tool)
        test_matches_reference_binary(tool, opts.reference, digests)

    print()
    print(SKIPS.summary_line())
    if failures:
        print(f"FAILED {len(failures)}/{checks_run} checks:")
        for label in failures:
            print(f"  - {label}")
        return 1
    print(f"PASSED {checks_run}/{checks_run} checks")
    return 0


if __name__ == "__main__":
    sys.exit(main())
