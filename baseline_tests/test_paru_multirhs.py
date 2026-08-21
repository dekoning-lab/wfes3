#!/usr/bin/env python3
"""
Agreement checks for the ParU backend's multi-RHS solve (ParUSolver::solve_multiple).

Defect history (2026-08-21 validation of the integrity audit): every solve_multiple
backend must honor the contract documented and enforced in
PardisoSolver::solve_multiple -- the ROWS of B are the right-hand sides, each of
length equal to the system order, and the result is (order x n_rhs).
ParUSolver::solve_multiple instead still enforced the opposite (columns-are-RHS)
convention, so the only production caller, wfafs_stochastic, which passes
Identity(n_rhs, order) with transpose=true, died with
"ParUSolver: RHS matrix row size mismatch" under --library ParU. (The audit had
blamed the "transpose solve not yet implemented" stub two lines below; that stub
was unreachable from this caller because the orientation guard threw first.)

This test locks in the fix behaviourally: wfafs_stochastic under --library ParU
must exit 0 and agree elementwise with the platform-default library, and the
previously-working ParU single-RHS paths (wfes_single, phase_type_moments) must
keep agreeing too.

Usage
-----
    python3 baseline_tests/test_paru_multirhs.py [--bin <dir>]

--bin is a DIRECTORY containing wfafs_stochastic, wfes_single and
phase_type_moments (default: wfes-cli/build-cx5a/bin). Exit status is 0 only if
every check passes.

Tolerance
---------
Elementwise relative agreement within RTOL = 1e-8 (abs_tol 0). Both backends are
LU direct solvers on the same matrix, so observed disagreement is ~1e-15; 1e-8
leaves eight orders of magnitude of headroom while still catching any
orientation, indexing or transpose-semantics error, all of which produce O(1)
differences.
"""
from __future__ import annotations

import argparse
import json
import math
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
DEFAULT_BIN_DIR = REPO / "wfes-cli" / "build-cx5a" / "bin"

RTOL = 1e-8

# Case 1: the exact repro from the validated defect report -- two equal epochs.
WFAFS_CASE_EQUAL = ["-N", "50,50", "-G", "10,10", "-f", "1,1", "-s", "0,0",
                    "-h", "0.5,0.5", "-u", "1e-6,1e-6", "-v", "1e-6,1e-6",
                    "-p", "1", "--json"]

# Case 2: unequal epochs, so n_rhs (2*N_1+1 = 61) differs from every other
# dimension in the system and any row/column confusion cannot cancel out.
WFAFS_CASE_UNEQUAL = ["-N", "30,60", "-G", "8,12", "-f", "1,1", "-s", "0,0",
                      "-h", "0.5,0.5", "-u", "1e-6,1e-6", "-v", "1e-6,1e-6",
                      "-p", "1", "--json"]

# Non-regression: single-RHS ParU paths that already worked before the fix.
SINGLE_CASE = ["--fixation", "-N", "30", "-p", "1", "--json"]
PTM_CASE = ["-N", "30", "-k", "4", "--csv"]

failures: list[str] = []
checks_run = 0


def check(ok: bool, label: str, detail: str = "") -> None:
    global checks_run
    checks_run += 1
    if ok:
        print(f"  PASS  {label}")
    else:
        print(f"  FAIL  {label}" + (f" -- {detail}" if detail else ""))
        failures.append(label + (f": {detail}" if detail else ""))


def run(binary: Path, args: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run([str(binary)] + args, capture_output=True, text=True,
                          timeout=600)


def numeric_leaves(node, prefix: str = "") -> dict[str, float]:
    """Flatten every numeric value in a parsed-JSON tree to path -> value."""
    out: dict[str, float] = {}
    if isinstance(node, bool):
        return out
    if isinstance(node, (int, float)):
        out[prefix] = float(node)
    elif isinstance(node, dict):
        for k in node:
            out.update(numeric_leaves(node[k], f"{prefix}.{k}" if prefix else k))
    elif isinstance(node, list):
        for i, item in enumerate(node):
            out.update(numeric_leaves(item, f"{prefix}[{i}]"))
    return out


def compare_leaves(ref: dict[str, float], got: dict[str, float],
                   label: str) -> None:
    """Elementwise agreement of two flattened numeric trees at RTOL."""
    check(set(ref) == set(got), f"{label}: identical result structure",
          f"only-in-default={sorted(set(ref) - set(got))[:3]} "
          f"only-in-paru={sorted(set(got) - set(ref))[:3]}")
    common = sorted(set(ref) & set(got))
    check(len(common) > 0, f"{label}: results are non-empty")
    worst_key, worst_rel = None, 0.0
    n_bad = 0
    for key in common:
        a, b = ref[key], got[key]
        if not math.isclose(a, b, rel_tol=RTOL, abs_tol=0.0):
            n_bad += 1
        denom = max(abs(a), abs(b))
        rel = abs(a - b) / denom if denom > 0.0 else 0.0
        if rel >= worst_rel:
            worst_key, worst_rel = key, rel
    check(n_bad == 0,
          f"{label}: {len(common)} values agree elementwise at rtol {RTOL:g}",
          f"{n_bad} values differ; worst {worst_key}: "
          f"default={ref.get(worst_key)} paru={got.get(worst_key)} rel={worst_rel:.3e}")
    print(f"        (max relative difference {worst_rel:.3e} at {worst_key})")


def parse_json_results(proc: subprocess.CompletedProcess, label: str):
    """The 'results' object of a --json run, or None (recorded as a failure)."""
    try:
        doc = json.loads(proc.stdout)
    except json.JSONDecodeError as e:
        check(False, f"{label}: stdout is valid JSON", str(e))
        return None
    check("results" in doc, f"{label}: JSON has a 'results' object")
    return doc.get("results")


def parse_csv_pairs(proc: subprocess.CompletedProcess, label: str):
    """A moment,value CSV as an ordered path -> float dict, or None."""
    out: dict[str, float] = {}
    lines = [ln for ln in proc.stdout.splitlines() if ln.strip()]
    check(bool(lines) and lines[0].strip() == "moment,value",
          f"{label}: CSV header is 'moment,value'",
          f"got {lines[0]!r}" if lines else "empty output")
    if not lines:
        return None
    for i, line in enumerate(lines[1:]):
        parts = line.split(",")
        if len(parts) != 2:
            check(False, f"{label}: CSV row {i + 1} is 'name,value'", repr(line))
            return None
        try:
            # Row order matters and moment names repeat nothing today, but key
            # on position as well so a reordering cannot silently pass.
            out[f"{i}:{parts[0].strip()}"] = float(parts[1])
        except ValueError:
            check(False, f"{label}: CSV row {i + 1} value parses as float",
                  repr(line))
            return None
    return out


def agreement_case(binary: Path, args: list[str], label: str,
                   csv: bool = False) -> None:
    """Run with the default library and with --library ParU; require exit 0
    from both and elementwise agreement at RTOL."""
    ref_proc = run(binary, args)
    paru_proc = run(binary, args + ["--library", "ParU"])
    check(ref_proc.returncode == 0, f"{label}: default library exits 0",
          f"exit={ref_proc.returncode} stderr={ref_proc.stderr.strip()[:200]!r}")
    check(paru_proc.returncode == 0, f"{label}: --library ParU exits 0",
          f"exit={paru_proc.returncode} stderr={paru_proc.stderr.strip()[:200]!r}")
    if ref_proc.returncode != 0 or paru_proc.returncode != 0:
        return
    if csv:
        ref = parse_csv_pairs(ref_proc, f"{label} (default)")
        got = parse_csv_pairs(paru_proc, f"{label} (ParU)")
    else:
        ref_res = parse_json_results(ref_proc, f"{label} (default)")
        got_res = parse_json_results(paru_proc, f"{label} (ParU)")
        ref = numeric_leaves(ref_res) if ref_res is not None else None
        got = numeric_leaves(got_res) if got_res is not None else None
    if ref is None or got is None:
        return
    compare_leaves(ref, got, label)


def parse_matrix_file(path: Path) -> list[list[float]]:
    """Parse a dump from OutputFormatter::write_matrix_to_file
    (wfes-cli/src/core/output_formatter.cpp): one row per line, comma-separated
    doubles at max_digits10 precision, no header, no trailing newline after the
    last row. Row i is state i; column j is the solution for RHS j."""
    return [[float(x) for x in line.split(",")]
            for line in path.read_text().splitlines() if line.strip()]


def output_N_orientation_case(binary: Path, args: list[str], label: str,
                              order: int, n_rhs: int) -> None:
    """--output-N under both libraries must (a) have shape order x n_rhs and
    (b) agree elementwise at RTOL.

    This is the strongest available regression lock for the ParUSolver::
    solve_multiple orientation fix: it checks the raw solve_multiple result
    (the full B matrix) directly, entry by entry, rather than only the
    AFS-reduced summary the JSON-based cases above compare. That reduction
    sums over many entries of B, so an orientation bug that happened to
    preserve row/column sums could in principle slip past it; the full
    matrix cannot alias that way.
    """
    with tempfile.TemporaryDirectory() as tmp:
        ref_path = Path(tmp) / "N_default.txt"
        paru_path = Path(tmp) / "N_paru.txt"
        ref_proc = run(binary, args + ["--output-N", str(ref_path)])
        paru_proc = run(binary, args + ["--output-N", str(paru_path), "--library", "ParU"])
        check(ref_proc.returncode == 0, f"{label}: default library exits 0",
              f"exit={ref_proc.returncode} stderr={ref_proc.stderr.strip()[:200]!r}")
        check(paru_proc.returncode == 0, f"{label}: --library ParU exits 0",
              f"exit={paru_proc.returncode} stderr={paru_proc.stderr.strip()[:200]!r}")
        if ref_proc.returncode != 0 or paru_proc.returncode != 0:
            return
        ref_written = ref_path.is_file() and ref_path.stat().st_size > 0
        paru_written = paru_path.is_file() and paru_path.stat().st_size > 0
        check(ref_written, f"{label}: default --output-N file written non-empty")
        check(paru_written, f"{label}: ParU --output-N file written non-empty")
        if not ref_written or not paru_written:
            return

        ref_mat = parse_matrix_file(ref_path)
        paru_mat = parse_matrix_file(paru_path)
        ref_shape = (len(ref_mat), len(ref_mat[0]) if ref_mat else 0)
        paru_shape = (len(paru_mat), len(paru_mat[0]) if paru_mat else 0)
        check(ref_shape == (order, n_rhs),
              f"{label}: default --output-N shape is order x n_rhs ({order}x{n_rhs})",
              f"got {ref_shape}")
        check(paru_shape == (order, n_rhs),
              f"{label}: ParU --output-N shape is order x n_rhs ({order}x{n_rhs})",
              f"got {paru_shape}")

        ref_flat = {f"{i}:{j}": v for i, row in enumerate(ref_mat) for j, v in enumerate(row)}
        paru_flat = {f"{i}:{j}": v for i, row in enumerate(paru_mat) for j, v in enumerate(row)}
        compare_leaves(ref_flat, paru_flat, f"{label} (full matrix)")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    ap.add_argument("--bin", type=Path, default=DEFAULT_BIN_DIR,
                    help="directory containing the wfes CLI binaries "
                         f"(default: {DEFAULT_BIN_DIR})")
    opts = ap.parse_args()

    wfafs = opts.bin / "wfafs_stochastic"
    single = opts.bin / "wfes_single"
    ptm = opts.bin / "phase_type_moments"
    for b in (wfafs, single, ptm):
        if not b.exists():
            print(f"ERROR: binary not found: {b}", file=sys.stderr)
            return 2

    print(f"Binaries: {opts.bin}")

    print("\n[1] wfafs_stochastic, two equal epochs (the validated repro): "
          "ParU vs default")
    agreement_case(wfafs, WFAFS_CASE_EQUAL, "wfafs equal epochs")

    print("\n[2] wfafs_stochastic, unequal epochs: ParU vs default")
    agreement_case(wfafs, WFAFS_CASE_UNEQUAL, "wfafs unequal epochs")

    # WFAFS_CASE_UNEQUAL is -N 30,60 over 2 epochs: order = 2*(30+60) + 2 = 182,
    # n_rhs = 2*30 + 1 = 61 (n_rhs is fixed by the FIRST epoch's population
    # size). This is the exact case and shape the integrity audit validated
    # ad hoc (182x61, 11102 entries, max rel diff ~2.8e-15); locking it in here
    # so that evidence lives in the regression suite, not only in a report.
    print("\n[3] wfafs_stochastic, unequal epochs, full --output-N matrix "
          "(order x n_rhs): ParU vs default")
    output_N_orientation_case(wfafs, WFAFS_CASE_UNEQUAL,
                              "wfafs unequal epochs --output-N",
                              order=182, n_rhs=61)

    print("\n[4] Non-regression: wfes_single --fixation under ParU vs default")
    agreement_case(single, SINGLE_CASE, "wfes_single fixation")

    print("\n[5] Non-regression: phase_type_moments under ParU vs default")
    agreement_case(ptm, PTM_CASE, "phase_type_moments", csv=True)

    print(f"\n{checks_run} checks, {len(failures)} failure(s)")
    if failures:
        for f in failures:
            print(f"  FAILED: {f}")
        return 1
    print("ALL PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
