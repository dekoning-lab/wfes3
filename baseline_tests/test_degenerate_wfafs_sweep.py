#!/usr/bin/env python3
"""
Integrity checks for wfes_sweep and wfafs_stochastic.

These are behavioural regression tests for four defects found in the 2026-08-21
audit. All four share one failure mode: the tool produced *something* -- exit 0
and a plausible-looking artifact -- where it should have produced either a real
computation or a refusal.

  1. wfes_sweep with an integration cutoff above every starting-copy
     probability integrated over nothing, then printed the resulting zeros as
     results: T_fix = 0 and rate = 1/0 = "inf". A bare `inf` is not valid JSON
     (python json.load and node JSON.parse both reject it) and jq silently
     coerces it to 1.7976931348623157e+308, i.e. a plausible-looking fake number
     in any jq pipeline. It must refuse instead.
  2. wfes_sweep --output-B was accepted and never written.
  3. wfafs_stochastic --output-R / --output-N-ext / --output-N-fix /
     --output-N-tmo were accepted and never written. wfafs_stochastic builds a
     NON_ABSORBING chain, so none of those quantities exist for this model; the
     flags must be refused rather than silently ignored.
  4. wfafs_stochastic --no-project did not do what its help says. Its help is
     "Do not project the distribution down", i.e. keep the up-projected,
     real-population-size spectrum; it instead skipped the up-projection too and
     returned the un-projected scaled-size spectrum.

Usage
-----
    python3 baseline_tests/test_degenerate_wfafs_sweep.py [--bin <dir>]

--bin is a DIRECTORY containing wfes_sweep and wfafs_stochastic
(default: wfes-cli/build-cx4/bin). Exit status is 0 only if every check passes.

Note on the recorded md5
-----------------------
WFAFS_DEFAULT_MD5 below locks the DEFAULT (no --no-project) output of
wfafs_stochastic byte for byte, so that a change to the --no-project branch
cannot quietly move the default path with it. It was recorded from a build of
the pre-fix code on macOS/arm64 with the platform-default solver backend. A
mismatch means either that regression, or an unrelated change to how
wfafs_stochastic formats its output -- check which before assuming the worst.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
DEFAULT_BIN_DIR = REPO / "wfes-cli" / "build-cx4" / "bin"

# A degenerate sweep: -c 1 is above every starting-copy probability.
SWEEP_MODEL = ["--fixation", "-N", "10", "-s", "0.1,0.2", "-L", "0.5"]
SWEEP_DEGENERATE = SWEEP_MODEL + ["-c", "1"]

# Two epochs with a scaling factor != 1 in the last epoch, so the projection
# step actually runs and --no-project has something to change.
WFAFS_MODEL = ["-N", "20,10", "-G", "10,5", "-f", "2,2"]

# Scaled sizes are 10 and 5, so the last epoch's un-projected spectrum has
# 2*5+1 = 11 entries and the up-projected one has 2*(5*2)+1 = 21.
WFAFS_N_PROJECTED = 11
WFAFS_N_UPPROJECTED = 21

# md5 of the raw stdout of `wfafs_stochastic -N 20,10 -G 10,5 -f 2,2 --json`,
# recorded from the pre-fix build (see module docstring).
WFAFS_DEFAULT_MD5 = "2a401eaf33ea2e3b175d77940d3c0071"

# `inf`, `-inf`, `infinity`, `nan` as standalone tokens. Bounded on both sides so
# that ordinary words ("info") and exponents ("1e-09") do not match.
NONFINITE_RE = re.compile(r"(?<![A-Za-z0-9_.])-?(?:inf(?:inity)?|nan)(?![A-Za-z0-9_])",
                          re.IGNORECASE)

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
    """Run a tool, capturing raw bytes so output can be hashed exactly."""
    return subprocess.run([str(binary), *args], capture_output=True)


def text(proc: subprocess.CompletedProcess) -> str:
    return (proc.stdout + proc.stderr).decode("utf-8", "replace")


def parse_json(blob: str):
    """Parse the JSON object in `blob`, or return None."""
    start = blob.find("{")
    if start < 0:
        return None
    try:
        return json.loads(blob[start:])
    except json.JSONDecodeError:
        return None


def stdout_has_csv_data_row(stdout_text: str) -> bool:
    """True if any line of `stdout_text` looks like a wfes_sweep --csv results
    row: more than two comma-separated fields that all parse as floats (a
    healthy row has 15, e.g. "10,0.1,0.2,...,2.36623e+08"). Used in place of
    the "T_fix" token match for csv, because that literal string never
    appears in csv output -- not even on a normal, successful run."""
    for line in stdout_text.splitlines():
        fields = line.split(",")
        if len(fields) <= 2:
            continue
        try:
            for field in fields:
                float(field)
        except ValueError:
            continue
        return True
    return False


# --------------------------------------------------------------------------
# wfes_sweep
# --------------------------------------------------------------------------

def test_sweep_degenerate_refuses(sweep: Path) -> None:
    print("wfes_sweep: cutoff above every starting-copy probability")
    for label, fmt in (("json", ["--json"]), ("csv", ["--csv"]), ("plain", [])):
        proc = run(sweep, SWEEP_DEGENERATE + fmt)
        out = text(proc)
        check(f"[{label}] exits nonzero", proc.returncode != 0,
              f"exit {proc.returncode}; output: {out.strip()[:400]}")
        hits = NONFINITE_RE.findall(out)
        check(f"[{label}] no inf/nan anywhere in the output", not hits,
              f"found {hits} in: {out.strip()[:400]}")
        check(f"[{label}] diagnostic mentions the cutoff",
              "cutoff" in proc.stderr.decode("utf-8", "replace").lower(),
              f"stderr: {proc.stderr.decode('utf-8', 'replace').strip()[:400]}")
        # Belt and braces on the refusal itself: a regression that printed
        # results to stdout and THEN exited nonzero (e.g. a check added after
        # the output block instead of before it) would still pass the two
        # checks above, since exit code and inf/nan-freedom say nothing about
        # whether results were printed. json and plain both print the literal
        # token "T_fix" in their results section (a JSON key, and a
        # "T_fix = ..." line respectively), so its absence from stdout is
        # direct evidence no results were printed for those two formats. csv's
        # results row is bare comma-separated numbers with no "T_fix" token
        # anywhere -- even on a normal, successful run -- so the same check
        # on csv stdout would pass unconditionally and prove nothing; csv
        # instead gets a check for the absence of a numeric data row (a line
        # with more than two comma-separated fields that all parse as
        # floats), which is what a printed csv results row actually looks
        # like.
        stdout_only = proc.stdout.decode("utf-8", "replace")
        if label == "csv":
            check(f"[{label}] stdout contains no numeric data row (no results were printed)",
                  not stdout_has_csv_data_row(stdout_only),
                  f"stdout: {stdout_only.strip()[:400]}")
        else:
            check(f"[{label}] stdout contains no T_fix token (no results were printed)",
                  "T_fix" not in stdout_only,
                  f"stdout: {stdout_only.strip()[:400]}")


def test_sweep_degenerate_output_I_no_file(sweep: Path, tmp: Path) -> None:
    # --output-I used to be written before the z == 0 refusal, so a refused
    # degenerate run left the initial-distribution file behind even though
    # the run itself produced no results -- contradicting "a refused run
    # writes no file". The write must happen only after the refusal check.
    print("wfes_sweep: --output-I writes no file on the degenerate refusal")
    path = tmp / "sweep_I_degenerate.txt"
    proc = run(sweep, SWEEP_DEGENERATE + ["--json", "--output-I", str(path)])
    check("exits nonzero", proc.returncode != 0,
          f"exit {proc.returncode}: {text(proc)[:400]}")
    check("--output-I file was not created", not path.exists(),
          f"{path} was created despite the run being refused")


def test_sweep_normal_still_works(sweep: Path) -> None:
    print("wfes_sweep: a normal run is unaffected")
    proc = run(sweep, SWEEP_MODEL + ["--json"])
    out = text(proc)
    if not check("exits 0", proc.returncode == 0, f"exit {proc.returncode}: {out[:400]}"):
        return
    doc = parse_json(proc.stdout.decode())
    if not check("stdout parses with json.load", doc is not None, out[:400]):
        return
    results = doc.get("results", {})
    wanted = ("T_fix", "rate", "T_regime1", "T_regime2")
    check("all four results are finite numbers",
          all(isinstance(results.get(k), (int, float)) for k in wanted)
          and all(float(results[k]) == float(results[k]) for k in wanted)
          and all(abs(float(results[k])) != float("inf") for k in wanted),
          str(results))
    check("T_fix is positive", float(results.get("T_fix", 0)) > 0, str(results))
    check("rate == 1/T_fix",
          abs(float(results["rate"]) * float(results["T_fix"]) - 1.0) < 1e-9,
          str(results))


def test_sweep_output_B(sweep: Path, tmp: Path) -> None:
    # Disposition: WRITTEN. wfes_sweep's model has exactly one absorbing state
    # (fixation), held in R, so B = (I-Q)^-1 R exists and is one absorption
    # probability per transient state. Every entry is 1 in exact arithmetic
    # (row sums of [Q|R] are exactly 1.0, so no alpha tail truncation mass is
    # missing); the small observed deviation from 1 is solver
    # conditioning/roundoff, not truncation loss -- see the tolerance
    # comment below for the derivation.
    print("wfes_sweep: --output-B is written")
    path = tmp / "sweep_B.txt"
    proc = run(sweep, SWEEP_MODEL + ["--json", "--output-B", str(path)])
    if not check("exits 0", proc.returncode == 0, f"exit {proc.returncode}: {text(proc)[:400]}"):
        return
    if not check("file exists", path.exists(), f"{path} was not created"):
        return
    values = [float(x) for x in path.read_text().split() if x.strip()]
    check("file is non-empty", len(values) > 0)
    # The state space is (2N+1) + 2N = 4N+1 for N = 10.
    check("one entry per transient state (4N+1 = 41)", len(values) == 41,
          f"got {len(values)} entries")
    check("all entries finite", all(v == v and abs(v) != float("inf") for v in values))
    # Fixation is the only absorbing state, so every entry is 1 in exact
    # arithmetic -- row sums of [Q|R] are exactly 1.0, so there is no alpha
    # truncation mass unaccounted for. The tolerance is not arbitrary:
    # (I-Q)^-1 has entries of order T_fix, which is ~2.4e8 for this model, so
    # double-precision roundoff reaches the solved vector at about
    # T_fix * eps ~ 5e-8. Measured directly: 40 of these 41 entries land
    # strictly ABOVE 1 (max 1.0000000121, none below) -- truncation can only
    # discard probability mass, which would pull entries below 1, so an
    # above-1 deviation is solver roundoff, not truncation. A mis-wired B
    # (wrong vector, wrong transpose) would not land near 1 at all.
    check("absorption into the single absorbing state is 1 within solver tolerance",
          all(abs(v - 1.0) < 1e-6 for v in values),
          f"max deviation {max(abs(v - 1.0) for v in values)}" if values else "empty")


# --------------------------------------------------------------------------
# wfafs_stochastic
# --------------------------------------------------------------------------

def test_wfafs_unsupported_outputs(wfafs: Path, tmp: Path) -> None:
    # Disposition: REFUSED. wfafs_stochastic builds a NON_ABSORBING switching
    # chain, so it has no absorbing state: R is (size x 0) and the extinction-,
    # fixation- and timeout-conditional sojourn times are undefined for it.
    # There is nothing honest to write, so the flags must be errors.
    print("wfafs_stochastic: flags naming quantities this model does not have")
    for i, flag in enumerate(("--output-R", "--output-N-ext",
                              "--output-N-fix", "--output-N-tmo")):
        path = tmp / f"wfafs_unsupported_{i}.txt"
        proc = run(wfafs, WFAFS_MODEL + ["--json", flag, str(path)])
        err = proc.stderr.decode("utf-8", "replace")
        check(f"[{flag}] exits nonzero", proc.returncode != 0,
              f"exit {proc.returncode}; output: {text(proc).strip()[:400]}")
        check(f"[{flag}] names the flag in its diagnostic", flag in err,
              f"stderr: {err.strip()[:400]}")
        check(f"[{flag}] writes no file", not path.exists(),
              f"{path} was created anyway")


def test_wfafs_default_unchanged(wfafs: Path) -> str:
    print("wfafs_stochastic: the default (unflagged) path is byte-identical")
    proc = run(wfafs, WFAFS_MODEL + ["--json"])
    if not check("exits 0", proc.returncode == 0, f"exit {proc.returncode}: {text(proc)[:400]}"):
        return ""
    digest = hashlib.md5(proc.stdout).hexdigest()
    check("md5 of stdout matches the recorded pre-fix value",
          digest == WFAFS_DEFAULT_MD5,
          f"recorded {WFAFS_DEFAULT_MD5}, got {digest}")
    doc = parse_json(proc.stdout.decode())
    if not check("stdout parses with json.load", doc is not None, text(proc)[:400]):
        return digest
    dist = doc["results"]["distribution"]
    check(f"projected down to {WFAFS_N_PROJECTED} states",
          len(dist) == WFAFS_N_PROJECTED, f"got {len(dist)}")
    return digest


def test_wfafs_no_project(wfafs: Path, default_digest: str) -> None:
    print("wfafs_stochastic: --no-project keeps the up-projected spectrum")
    proc = run(wfafs, WFAFS_MODEL + ["--json", "--no-project"])
    if not check("exits 0", proc.returncode == 0, f"exit {proc.returncode}: {text(proc)[:400]}"):
        return
    doc = parse_json(proc.stdout.decode())
    if not check("stdout parses with json.load", doc is not None, text(proc)[:400]):
        return
    dist = doc["results"]["distribution"]
    check(f"kept at the un-projected-down size ({WFAFS_N_UPPROJECTED} states)",
          len(dist) == WFAFS_N_UPPROJECTED,
          f"got {len(dist)}; {WFAFS_N_PROJECTED} means the flag had no effect on "
          "the down-projection")
    digest = hashlib.md5(proc.stdout).hexdigest()
    check("differs from the default run", digest != default_digest,
          "--no-project produced byte-identical output to the default run")
    probs = [entry["probability"] for entry in dist]
    check("all probabilities finite", all(p == p and abs(p) != float("inf") for p in probs))
    check("still a probability distribution (sums to 1)",
          abs(sum(probs) - 1.0) < 1e-6, f"sum {sum(probs)}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--bin", type=Path, default=DEFAULT_BIN_DIR,
                    help=f"directory holding the tools (default: {DEFAULT_BIN_DIR})")
    opts = ap.parse_args()

    sweep = opts.bin / "wfes_sweep"
    wfafs = opts.bin / "wfafs_stochastic"
    for tool in (sweep, wfafs):
        if not tool.is_file():
            print(f"error: {tool} not found (build it first, or pass --bin)")
            return 2

    print(f"Binaries: {opts.bin}\n")
    with tempfile.TemporaryDirectory() as tmpdir:
        tmp = Path(tmpdir)
        test_sweep_degenerate_refuses(sweep)
        test_sweep_degenerate_output_I_no_file(sweep, tmp)
        test_sweep_normal_still_works(sweep)
        test_sweep_output_B(sweep, tmp)
        test_wfafs_unsupported_outputs(wfafs, tmp)
        digest = test_wfafs_default_unchanged(wfafs)
        test_wfafs_no_project(wfafs, digest)

    print()
    if failures:
        print(f"FAILED {len(failures)}/{checks_run} checks:")
        for label in failures:
            print(f"  - {label}")
        return 1
    print(f"PASSED {checks_run}/{checks_run} checks")
    return 0


if __name__ == "__main__":
    sys.exit(main())
