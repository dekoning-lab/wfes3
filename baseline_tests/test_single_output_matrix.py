#!/usr/bin/env python3
"""Per-mode output-flag contract for wfes_single (integrity audit 3.1, task CX1b).

Contract under test — every `--output-*` flag, in every model, ends in exactly
one of THREE permitted outcomes, and never in a fourth:

  1. WRITE — the quantity is produced by that model, and a non-empty file with
     the model's own dimensions is written;
  2. REFUSE — the quantity is not defined for that model, or the solve that
     would produce it cannot be trusted at these parameters. The run exits
     nonzero with a stderr diagnostic that names both the flag and the model
     (or the failed solve), having written nothing at all — a refusal that
     leaves an artefact behind is not a refusal;
  3. DISCLOSED OMISSION — the quantity is defined for the model and the run is
     otherwise sound, but this particular value is not computable in double
     precision (a conditional sojourn whose anchor probability has fallen below
     COND_PROB_MIN). The run exits 0, writes NO file for that flag, and says so
     on stderr naming the flag and the reason. The rest of the run proceeds
     normally.

Outcome 3 is the CX1a convention, carried into this tool deliberately: the
alternative to omitting a conditional sojourn is writing a matrix of roundoff,
which is the substitution this whole audit exists to remove. It is a distinct
outcome from 1 and 2 and is pinned as such below (`section_disclosed_omission`)
— an earlier revision of this docstring claimed two outcomes and no third,
which did not describe the binary it was testing.

Silent acceptance — flag parsed, no file, exit 0, and NOTHING said — is the
defect this suite locks out, and it is what separates outcome 3 from a bug: the
stderr note is the whole difference. The shipped binary had 24 silently
accepted cells (plus 14 documented-scope `--output-E`/`--output-V` ones that
were also silently accepted, and 3 cells whose file misrepresented the run).

Also locked in here:
  * `--output-I` records the distribution the run ACTUALLY used: the delta at
    the requested count under `--starting-copies`, not the pre-collapse
    injection distribution, and over the model's own state space;
  * `--equilibrium` refuses `--starting-copies`/`--initial` rather than
    validating and then discarding them (the stationary distribution does not
    depend on the start);
  * `--fixation --output-B` is SOLVED, not a hardcoded vector of ones: the
    entries must sit within solver tolerance of 1 without being exactly 1, and
    that tolerance is CAPPED — a solve whose own forward-error bound exceeds
    the range of a probability refuses instead of clamping to a ones vector;
  * `--fixation` refuses a T_fix its solve cannot resolve, whichever SIGN the
    unresolvable value happens to carry;
  * `--establishment` derives no absorption vector by subtraction — checked
    against an independent dense-LU reference in the large `--odds-ratio`
    regime, where `1 - B_fix` loses most of its significant digits;
  * `--fundamental`/`--non-absorbing` never exit 0 with zero bytes of
    structured output, and `--fundamental --json` does not mix a fixed
    "completed" message into a results object that carries real data.

Standalone, stdlib-only. The dense reference is imported from
test_invalid_output_single.py (same directory).

Usage:
    python3 baseline_tests/test_single_output_matrix.py [--bin DIR] [--skip-dense]

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

This suite runs no token sweep; it asserts structure and recomputed values
on stdout. stderr is asserted only against expected diagnostic substrings.
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

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
DEFAULT_BIN_DIR = REPO / "wfes-cli" / "build-cx1b" / "bin"

sys.path.insert(0, str(HERE))
from test_invalid_output_single import (  # noqa: E402
    psi_diploid, binom_row_full, lu_factor, lu_solve,
)

# Long-form flag spellings THROUGHOUT. The short forms were being
# canonicalised in parallel with this suite (-k, for one, stopped meaning
# --odds-ratio in wfes_single), and the long names are the stable contract.
N_TEST = 8
SIZE_TRANSIENT = 2 * N_TEST - 1    # both-absorbing / allele-age: counts 1..2N-1
SIZE_FIXATION = 2 * N_TEST         # fixation-only: counts 0..2N-1
SIZE_FULL = 2 * N_TEST + 1         # equilibrium / non-absorbing: counts 0..2N
EST_DIM = 6                        # truncated establishment system at these params

FLAGS = ["Q", "R", "N", "N-ext", "N-fix", "B", "I", "E", "V"]

# Mode -> the extra arguments that make that mode runnable at N = 8.
MODE_ARGS = {
    "absorption":    [],
    "fixation":      [],
    "fundamental":   ["--starting-copies", "3"],
    "equilibrium":   [],
    "establishment": ["--selection", "0.05", "--dominance", "0.5"],
    "allele-age":    ["--observed-copies", "3"],
    "non-absorbing": [],
}

# The specification. Per mode, per flag:
#   ("mtx", rows, cols)  MatrixMarket file with those dimensions
#   ("csv", rows, cols)  comma-separated rows; None means "any positive count"
#   ("vec", n)           one value per line
#   ("refuse",)          nonzero exit naming the flag and the mode, no file
#
# Rationale for every refusal is in the CX1b report; in short: a model with no
# absorbing state has no R, no fundamental matrix N, no absorption vector B and
# no absorption-conditional sojourns; --fixation has no extinction absorbing
# state; the establishment model's second absorbing state is establishment, not
# fixation, so neither conditional-sojourn flag names a quantity it has; a
# model that never uses a starting distribution has no --output-I to write; and
# --output-E/--output-V keep their documented single-mode scope.
SPEC = {
    "absorption": {
        "Q": ("mtx", SIZE_TRANSIENT, SIZE_TRANSIENT),
        "R": ("csv", SIZE_TRANSIENT, 2),
        "N": ("csv", None, SIZE_TRANSIENT),
        "N-ext": ("csv", None, SIZE_TRANSIENT),
        "N-fix": ("csv", None, SIZE_TRANSIENT),
        "B": ("csv", SIZE_TRANSIENT, 2),
        "I": ("vec", SIZE_TRANSIENT),
        "E": ("refuse",),
        "V": ("refuse",),
    },
    "fixation": {
        "Q": ("mtx", SIZE_FIXATION, SIZE_FIXATION),
        "R": ("csv", SIZE_FIXATION, 1),
        "N": ("csv", None, SIZE_FIXATION),
        "N-ext": ("refuse",),
        "N-fix": ("csv", None, SIZE_FIXATION),
        "B": ("vec", SIZE_FIXATION),
        "I": ("vec", SIZE_FIXATION),
        "E": ("refuse",),
        "V": ("refuse",),
    },
    "fundamental": {
        "Q": ("mtx", SIZE_TRANSIENT, SIZE_TRANSIENT),
        "R": ("csv", SIZE_TRANSIENT, 2),
        "N": ("csv", 1, SIZE_TRANSIENT),
        "N-ext": ("csv", 1, SIZE_TRANSIENT),
        "N-fix": ("csv", 1, SIZE_TRANSIENT),
        "B": ("csv", SIZE_TRANSIENT, 2),
        "I": ("vec", SIZE_TRANSIENT),
        "E": ("refuse",),
        "V": ("csv", SIZE_TRANSIENT, SIZE_TRANSIENT),
    },
    "equilibrium": {
        "Q": ("mtx", SIZE_FULL, SIZE_FULL),
        "R": ("refuse",),
        "N": ("refuse",),
        "N-ext": ("refuse",),
        "N-fix": ("refuse",),
        "B": ("refuse",),
        "I": ("refuse",),
        "E": ("vec", SIZE_FULL),
        "V": ("refuse",),
    },
    "establishment": {
        "Q": ("mtx", EST_DIM, EST_DIM),
        "R": ("csv", EST_DIM, 2),
        "N": ("csv", None, EST_DIM),
        "N-ext": ("refuse",),
        "N-fix": ("refuse",),
        "B": ("csv", EST_DIM, 2),
        "I": ("vec", EST_DIM),
        "E": ("refuse",),
        "V": ("refuse",),
    },
    "allele-age": {
        "Q": ("mtx", SIZE_TRANSIENT, SIZE_TRANSIENT),
        "R": ("csv", SIZE_TRANSIENT, 2),
        "N": ("csv", None, SIZE_TRANSIENT),
        "N-ext": ("csv", None, SIZE_TRANSIENT),
        "N-fix": ("csv", None, SIZE_TRANSIENT),
        "B": ("csv", SIZE_TRANSIENT, 2),
        "I": ("vec", SIZE_TRANSIENT),
        "E": ("refuse",),
        "V": ("refuse",),
    },
    "non-absorbing": {
        "Q": ("mtx", SIZE_FULL, SIZE_FULL),
        "R": ("refuse",),
        "N": ("refuse",),
        "N-ext": ("refuse",),
        "N-fix": ("refuse",),
        "B": ("refuse",),
        "I": ("refuse",),
        "E": ("refuse",),
        "V": ("refuse",),
    },
}

_results: list[tuple[bool, str, str]] = []


def check(ok: bool, label: str, detail: str = "") -> bool:
    _results.append((bool(ok), label, detail))
    print(f"  {'OK  ' if ok else 'FAIL'} {label}" + (f"  [{detail}]" if detail else ""))
    return bool(ok)


def run(binary: Path, args: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run([str(binary), *args], capture_output=True, text=True,
                          timeout=900)


def read_csv_shape(path: Path) -> tuple[int, int]:
    text = path.read_text()
    rows = [r for r in text.splitlines() if r.strip()]
    if not rows:
        return 0, 0
    widths = {len(r.split(",")) for r in rows}
    return len(rows), (widths.pop() if len(widths) == 1 else -1)


def read_mtx_shape(path: Path) -> tuple[int, int]:
    for line in path.read_text().splitlines():
        if line.startswith("%"):
            continue
        parts = line.split()
        if len(parts) >= 2:
            return int(parts[0]), int(parts[1])
        break
    return 0, 0


def read_vector(path: Path) -> list[float]:
    return [float(v) for v in path.read_text().splitlines() if v.strip()]


# --------------------------------------------------------------------------
# Section 1 — the mode x flag matrix
# --------------------------------------------------------------------------

def section_matrix(binary: Path) -> None:
    print("\n== mode x output-flag matrix: written-with-right-shape, or refused ==")
    for mode, extra in MODE_ARGS.items():
        print(f"--- --{mode} ---")
        for flag in FLAGS:
            spec = SPEC[mode][flag]
            with tempfile.TemporaryDirectory() as td:
                out = Path(td) / "m.out"
                proc = run(binary, [f"--{mode}", "--pop-size", str(N_TEST), *extra,
                                    f"--output-{flag}", str(out), "--json"])
                label = f"--{mode} --output-{flag}"
                if spec[0] == "refuse":
                    ok = check(proc.returncode != 0, f"{label}: refused (nonzero exit)",
                               f"exit={proc.returncode}")
                    if ok:
                        check(f"--output-{flag}" in proc.stderr,
                              f"{label}: diagnostic names the flag",
                              proc.stderr.strip()[:150])
                        check(f"--{mode}" in proc.stderr,
                              f"{label}: diagnostic names the mode",
                              proc.stderr.strip()[:150])
                    check(not out.exists(), f"{label}: no file written")
                    continue

                if not check(proc.returncode == 0, f"{label}: run succeeds",
                             f"exit={proc.returncode} stderr={proc.stderr.strip()[:120]}"):
                    continue
                if not check(out.exists() and out.stat().st_size > 0,
                             f"{label}: non-empty file written",
                             "missing" if not out.exists() else "zero bytes"):
                    continue
                kind = spec[0]
                if kind == "mtx":
                    r, c = read_mtx_shape(out)
                    check((r, c) == (spec[1], spec[2]),
                          f"{label}: MatrixMarket dims {spec[1]}x{spec[2]}", f"got {r}x{c}")
                elif kind == "csv":
                    r, c = read_csv_shape(out)
                    check(c == spec[2], f"{label}: {spec[2]} columns", f"got {c}")
                    if spec[1] is None:
                        check(r > 0, f"{label}: at least one row", f"got {r}")
                    else:
                        check(r == spec[1], f"{label}: {spec[1]} rows", f"got {r}")
                elif kind == "vec":
                    vals = read_vector(out)
                    check(len(vals) == spec[1], f"{label}: {spec[1]} entries",
                          f"got {len(vals)}")
                    check(all(math.isfinite(v) for v in vals),
                          f"{label}: every entry finite")


# --------------------------------------------------------------------------
# Section 2 — --output-I records what the run actually used
# --------------------------------------------------------------------------

def section_output_I(binary: Path) -> None:
    print("\n== --output-I records the distribution the run actually used ==")
    with tempfile.TemporaryDirectory() as td:
        default_p = Path(td) / "I_default.txt"
        p3 = Path(td) / "I_p3.txt"
        run(binary, ["--absorption", "--pop-size", str(N_TEST),
                     "--output-I", str(default_p), "--json"])
        run(binary, ["--absorption", "--pop-size", str(N_TEST), "--starting-copies", "3",
                     "--output-I", str(p3), "--json"])
        ok = check(default_p.exists() and p3.exists(), "both I files written")
        if ok:
            check(default_p.read_bytes() != p3.read_bytes(),
                  "-p 3 writes a different I file from the default",
                  "byte-identical" if default_p.read_bytes() == p3.read_bytes() else "")
            vals = read_vector(p3)
            check(len(vals) == SIZE_TRANSIENT, "-p 3 I file has 2N-1 entries",
                  f"got {len(vals)}")
            if len(vals) == SIZE_TRANSIENT:
                # -p 3 is a delta on the transient index for count 3, i.e. index 2.
                check(vals[2] == 1.0 and math.fsum(vals) == 1.0,
                      "-p 3 I file is the delta at count 3",
                      f"index2={vals[2]!r} sum={math.fsum(vals)!r}")
            dvals = read_vector(default_p)
            check(len(dvals) == SIZE_TRANSIENT, "default I file has 2N-1 entries",
                  f"got {len(dvals)}")
            check(abs(math.fsum(dvals) - 1.0) < 1e-9,
                  "default I file is a probability distribution",
                  f"sum={math.fsum(dvals)!r}")

        # Fixation indexes states by count (0..2N-1), so its I vector is longer.
        fix_i = Path(td) / "I_fix.txt"
        run(binary, ["--fixation", "--pop-size", str(N_TEST), "--starting-copies", "1",
                     "--output-I", str(fix_i), "--json"])
        if check(fix_i.exists(), "--fixation --output-I written"):
            vals = read_vector(fix_i)
            check(len(vals) == SIZE_FIXATION,
                  "--fixation I file spans counts 0..2N-1", f"got {len(vals)}")
            if len(vals) == SIZE_FIXATION:
                check(vals[1] == 1.0, "--fixation -p 1 is the delta at index 1",
                      f"index1={vals[1]!r}")

        # A refused run must leave no artefact behind.
        refused_i = Path(td) / "I_refused.txt"
        proc = run(binary, ["--absorption", "--pop-size", "10", "--integration-cutoff", "1",
                            "--output-I", str(refused_i), "--json"])
        check(proc.returncode != 0, "-c 1 still refuses", f"exit={proc.returncode}")
        check(not refused_i.exists(), "refused run writes no --output-I artefact")


# --------------------------------------------------------------------------
# Section 3 — --equilibrium refuses parameters it cannot honour
# --------------------------------------------------------------------------

def section_equilibrium_start(binary: Path) -> None:
    print("\n== --equilibrium refuses --starting-copies / --initial ==")
    proc = run(binary, ["--equilibrium", "--pop-size", str(N_TEST), "--starting-copies", "3", "--json"])
    check(proc.returncode != 0, "--equilibrium -p 3 exits nonzero",
          f"exit={proc.returncode}")
    check("equilibrium" in proc.stderr.lower(),
          "diagnostic names the mode", proc.stderr.strip()[:150])
    with tempfile.TemporaryDirectory() as td:
        init = Path(td) / "init.csv"
        init.write_text("\n".join(["0"] * (SIZE_TRANSIENT - 1) + ["1"]))
        proc = run(binary, ["--equilibrium", "--pop-size", str(N_TEST),
                            "--initial", str(init), "--json"])
        check(proc.returncode != 0, "--equilibrium --initial exits nonzero",
              f"exit={proc.returncode}")
        check("stationary" in proc.stderr.lower() or "does not depend" in proc.stderr.lower(),
              "diagnostic says the stationary distribution is independent of the start",
              proc.stderr.strip()[:150])
    # The mode itself still works without them.
    proc = run(binary, ["--equilibrium", "--pop-size", str(N_TEST), "--json"])
    check(proc.returncode == 0, "--equilibrium still runs without a start",
          f"exit={proc.returncode}")


# --------------------------------------------------------------------------
# Section 4 — --fixation --output-B is solved, not asserted
# --------------------------------------------------------------------------

def section_fixation_B(binary: Path) -> None:
    print("\n== --fixation --output-B is solved, not a hardcoded ones vector ==")
    # With fixation the only absorbing state, absorption is certain, so B == 1
    # in exact arithmetic and a hardcoded dvec::Ones() looks right in every
    # printed digit -- which is why the old code got away with it. What
    # separates a solve from a constant is that a solve carries the system's
    # own roundoff: for a well-conditioned case it can land on exactly 1.0 in
    # every entry, but across a spread of conditioning it cannot. A literal
    # ones vector deviates by exactly 0 EVERYWHERE, so a single nonzero
    # deviation anywhere falsifies it.
    cases = [
        # (label, args, 2N)  -- measured worst |B-1| on the CX1b build:
        ("N=8 defaults", ["--fixation", "--pop-size", "8"], 16),                 # 5.6e-10
        ("N=50 s=0", ["--fixation", "--pop-size", "50", "--selection", "0"], 100),        # 1.2e-08
        ("N=100 s=0.01", ["--fixation", "--pop-size", "100", "--selection", "0.01"], 200),  # 0
        ("N=100 s=0.01 -p 1", ["--fixation", "--pop-size", "100", "--selection", "0.01",
                               "--starting-copies", "1"], 200),                          # 0
    ]
    deviations = []
    for label, args, n_expected in cases:
        with tempfile.TemporaryDirectory() as td:
            out = Path(td) / "B.txt"
            proc = run(binary, [*args, "--output-B", str(out), "--json"])
            if not check(proc.returncode == 0, f"fixation {label}: exits 0",
                         f"exit={proc.returncode} {proc.stderr.strip()[:120]}"):
                continue
            vals = read_vector(out)
            if not check(len(vals) == n_expected, f"fixation {label}: 2N entries",
                         f"got {len(vals)}"):
                continue
            worst = max(abs(v - 1.0) for v in vals)
            deviations.append((label, worst))
            check(worst < 1e-4,
                  f"fixation {label}: every entry within tolerance of 1",
                  f"worst |B-1| = {worst:.3e}")

    # Falsifying the ones-literal.
    #
    # The direct falsification is a nonzero deviation somewhere: a literal
    # `dvec::Ones(size)` deviates by exactly 0 in every entry of every case, so
    # one nonzero |B-1| anywhere in the spread proves a solve happened. That
    # test is real but it leans on ROUNDOFF LUCK -- a well-conditioned enough
    # model can legitimately land on exactly 1.0 everywhere, and if the spread
    # above ever narrowed to only such cases the check would start failing on a
    # correct binary. Keep it (it is the sharpest evidence when it fires), but
    # anchor the section on a signal that does not depend on luck.
    check(any(w > 0.0 for _, w in deviations),
          "at least one --fixation --output-B carries the solve's own roundoff, "
          "so the file cannot be a ones-literal write",
          ", ".join(f"{lbl}: {w:.3e}" for lbl, w in deviations))

    # Luck-free anchor: the CONDITIONING GATE. A hardcoded ones vector has no
    # solve behind it, so there is nothing whose forward-error bound could be
    # measured and nothing that could fail -- it would be written at every
    # parameter setting, unconditionally. The solved implementation refuses
    # exactly where the bound on its own solve exceeds the range of a
    # probability, and the refusal quotes that measured bound. A binary that
    # writes a file here cannot be solving. (The RED case and the measured
    # numbers live in section_solve_conditioning.)
    with tempfile.TemporaryDirectory() as td:
        out = Path(td) / "B.txt"
        proc = run(binary, ["--fixation", "--pop-size", "200",
                            "--selection", "-0.05", "--dominance", "0.5",
                            "--output-B", str(out), "--json"])
        check(proc.returncode != 0 and not out.exists(),
              "--fixation --output-B refuses where its own solve cannot certify "
              "B, which a ones-literal could never do",
              f"exit={proc.returncode} file={out.exists()}")


# --------------------------------------------------------------------------
# Section 5 — establishment solves for both absorption vectors
# --------------------------------------------------------------------------

def dense_establishment_reference(N: int, s: float, h: float, u: float, v: float,
                                  odds_ratio: float) -> dict[str, float]:
    """T_seg_ext family from a dense LU solve of BOTH absorption columns.

    Shares no code with the CLI: dense partial-pivoted LU in pure Python on a
    matrix assembled here from the published model definition. B_ext is solved
    against its own right-hand side, never derived as 1 - B_fix.
    """
    size = 2 * N - 1
    Q, R_ext, R_fix = [], [], []
    for i in range(1, 2 * N):
        row = binom_row_full(2 * N, psi_diploid(i, N, s, h, u, v))
        R_ext.append(row[0])
        R_fix.append(row[2 * N])
        Q.append(row[1:2 * N])
    A = [[(1.0 if i == j else 0.0) - Q[i][j] for j in range(size)]
         for i in range(size)]
    At = [[A[j][i] for j in range(size)] for i in range(size)]
    LU, piv = lu_factor([r[:] for r in A])
    LUt, pivt = lu_factor(At)

    B_fix = lu_solve(LU, piv, R_fix)
    B_ext = lu_solve(LU, piv, R_ext)

    threshold = odds_ratio / (1 + odds_ratio)
    est_idx = next((j for j in range(size) if B_fix[j] >= threshold), -1)
    if est_idx <= 0:
        raise ValueError("no establishment count at this odds ratio")
    est_idx += 1        # the CLI's 1-based conversion, deliberately preserved

    e = [0.0] * size
    e[est_idx] = 1.0
    N1 = lu_solve(LUt, pivt, e)
    N2 = lu_solve(LUt, pivt, N1)

    out = {"est_freq": est_idx / (2 * N)}
    T_seg = math.fsum(N1)
    T_seg_var = (2 * math.fsum(N2) - T_seg) - T_seg ** 2
    out["T_seg"] = T_seg
    out["T_seg_std"] = math.sqrt(T_seg_var)
    for tag, B in (("ext", B_ext), ("fix", B_fix)):
        anchor = B[est_idx]
        E = [B[j] * N1[j] / anchor for j in range(size)]
        Ev = [B[j] * N2[j] / anchor for j in range(size)]
        T = math.fsum(E)
        T_var = (2 * math.fsum(Ev) - T) - T ** 2
        out[f"T_seg_{tag}"] = T
        out[f"T_seg_{tag}_std"] = math.sqrt(T_var)
    out["_anchor_ext"] = B_ext[est_idx]
    out["_anchor_ext_subtraction"] = 1.0 - B_fix[est_idx]
    return out


def rel_diff(a: float, b: float) -> float:
    if a == b:
        return 0.0
    return abs(a - b) / max(abs(a), abs(b))


def section_establishment(binary: Path, skip_dense: bool) -> None:
    print("\n== --establishment: no absorption vector derived by subtraction ==")

    # (a) the misleading --initial diagnostic
    with tempfile.TemporaryDirectory() as td:
        init = Path(td) / "init.csv"
        init.write_text("\n".join(["0"] * (SIZE_TRANSIENT - 1) + ["1"]))
        proc = run(binary, ["--establishment", "--pop-size", str(N_TEST), "--selection", "0.05",
                            "--dominance", "0.5", "--initial", str(init), "--json"])
        check(proc.returncode != 0, "--establishment --initial exits nonzero",
              f"exit={proc.returncode}")
        check("mutation alone" not in proc.stderr,
              "diagnostic no longer claims 'establishment can be reached by mutation alone'",
              proc.stderr.strip()[:150])
        check("--initial" in proc.stderr,
              "diagnostic names --initial", proc.stderr.strip()[:150])

    # (b) degenerate parameters refuse rather than print nan or walk off the
    # end of the truncated state space. --starting-copies is range-checked
    # against the FULL model's 1..2N-1, but the establishment model only
    # follows the population up to establishment, so a count at or above the
    # establishment threshold used to index one past the end of a vector: the
    # shipped binary aborts on an Eigen assertion here (SIGABRT, exit 134, no
    # message naming the parameter), and on a build with NDEBUG that assertion
    # is compiled out.
    for label, args in (
        ("odds ratio unreachable", ["--establishment", "--pop-size", "20", "--selection", "0.05",
                                    "--dominance", "0.5", "--odds-ratio", "1e30"]),
        ("no odds ratio", ["--establishment", "--pop-size", "20", "--selection", "0.05", "--dominance", "0.5",
                           "--odds-ratio", "0"]),
        ("start at or above establishment",
         ["--establishment", "--pop-size", "8", "--selection", "0.05",
          "--dominance", "0.5", "--starting-copies", "10"]),
    ):
        proc = run(binary, [*args, "--json"])
        check(proc.returncode == 1, f"establishment {label}: refuses cleanly (exit 1)",
              f"exit={proc.returncode}")
        check("nan" not in proc.stdout.lower(),
              f"establishment {label}: no nan on stdout", proc.stdout.strip()[:100])
        check("Assertion failed" not in proc.stderr,
              f"establishment {label}: refusal is a diagnostic, not an abort",
              proc.stderr.strip()[:120])

    if skip_dense:
        print("  (dense establishment reference skipped on request)")
        return

    # (c) the regime the subtraction cannot survive. B_full_ext(est_idx) is
    # about 1/(1+k) by construction of the odds threshold, so deriving it as
    # 1 - B_full_fix caps its ABSOLUTE accuracy at ~eps and its RELATIVE
    # accuracy at ~(1+k)*eps. Every conditional-on-extinction segregation
    # moment divides by that anchor.
    print("--- large --odds-ratio: CLI vs independent dense LU ---")
    N, s, h = 100, 0.5, 0.5
    header = (f"{'k':>8} {'field':<16} {'dense (direct)':>22} {'CLI':>22} "
              f"{'rel':>10} {'subtraction rel':>16}")
    print(header)
    print("-" * len(header))
    # Tolerance 1e-12: the direct solve agrees with the dense reference to
    # ~1.5e-15 relative at every k below, while the subtraction it replaced was
    # off by 7.3e-10 (k = 1e6), 1.3e-7 (k = 1e9) and 7.1e-4 (k = 1e12) in
    # T_seg_ext -- so this gate separates the two at every k tested, not only
    # the extreme one.
    for k, tol in (("1e6", 1e-12), ("1e9", 1e-12), ("1e12", 1e-12)):
        try:
            ref = dense_establishment_reference(N, s, h, 1e-9, 1e-9, float(k))
        except ValueError as exc:
            check(False, f"k={k}: dense reference", str(exc))
            continue
        proc = run(binary, ["--establishment", "--pop-size", str(N), "--selection", str(s),
                            "--dominance", str(h), "--odds-ratio", k, "--json"])
        if not check(proc.returncode == 0, f"k={k}: CLI run succeeds",
                     f"exit={proc.returncode} {proc.stderr.strip()[:120]}"):
            continue
        try:
            res = json.loads(proc.stdout)["results"]
        except (ValueError, KeyError) as exc:
            check(False, f"k={k}: CLI output parses", str(exc))
            continue
        check(abs(res["est_freq"] - ref["est_freq"]) < 1e-12,
              f"k={k}: same establishment count as the reference",
              f"cli={res['est_freq']} ref={ref['est_freq']}")
        # How wrong the subtraction is at this k, measured on the reference
        # itself: this is the size of the error the direct solve removes.
        sub_rel = rel_diff(ref["_anchor_ext"], ref["_anchor_ext_subtraction"])
        for field in ("T_seg_ext", "T_seg_ext_std", "T_seg_fix", "T_seg"):
            if field not in res:
                check(False, f"k={k}: {field} present in CLI output")
                continue
            d = rel_diff(ref[field], res[field])
            print(f"{k:>8} {field:<16} {ref[field]:>22.17g} {res[field]:>22.17g} "
                  f"{d:>10.2e} {sub_rel:>16.2e}")
            check(d <= tol, f"k={k}: {field} matches the dense direct solve to {tol:g}",
                  f"rel={d:.3e}")


# --------------------------------------------------------------------------
# Section 6 — a solve that cannot certify its answer refuses, either sign
# --------------------------------------------------------------------------

# Ground truth for the cases below, from an independent GTH (Grassmann-Taksar-
# Heyman) state-reduction reference in pure Python. GTH is subtraction-free for
# a substochastic M-matrix -- it recovers every diagonal it divides by as a SUM
# of nonnegative probabilities rather than as 1 - Q[k][k] -- so it is
# componentwise relative-accurate independent of the condition number, and it
# runs in the SAME double precision the CLI does. Where the two disagree, the
# subtractive LU is the one that lost the digits.
#
# --fixation, N = 200, h = 0.5, u = v = 1e-9, T_fix from count 1:
#
#   s        GTH (true)      LU (pre-fix CLI)  relative error   verdict
#   -0.01    1.35134e+10     1.35134e+10       1.8e-07          write
#   -0.02    3.93843e+11     3.93845e+11       5.3e-06          write
#   -0.03    1.56684e+13     1.56718e+13       2.1e-04          refuse
#   -0.04    7.31124e+14     7.38436e+14       1.0e-02          refuse
#   -0.05    3.79792e+16     7.82089e+16       1.06             refuse
#   -0.20    4.34509e+45    -7.38341e+16       garbage          refuse
#
# Two facts the pre-fix diagnostics got wrong, and that these cases pin:
#   * the true values are all REPRESENTABLE -- 4.3e45 is 260 orders below
#     DBL_MAX -- so this is not overflow, and a diagnostic that says "the
#     sojourn sums overflowed" sends the user after a problem they do not have;
#   * the failure is not signed. At s = -0.05 the LU's answer is positive, has
#     no negative entry anywhere in N, and was printed to 17 digits at exit 0
#     with not one of them correct. A gate that only catches negative times
#     catches half of this.

def section_solve_conditioning(binary: Path) -> None:
    print("\n== a solve that cannot certify its answer refuses, either sign ==")

    # RED 1 (Critical): --output-B wrote 400 clamped 1.0s at exit 0, under the
    # note "worst excursion 1.05926 (solver roundoff, within tolerance
    # 13892.7); clamped to the boundary" -- a tolerance four orders wider than
    # the entire range of a probability, presented as roundoff. The file was
    # byte-identical to the hardcoded ones-vector this task removed.
    with tempfile.TemporaryDirectory() as td:
        out = Path(td) / "B.txt"
        proc = run(binary, ["--fixation", "--pop-size", "200",
                            "--selection", "-0.05", "--dominance", "0.5",
                            "--output-B", str(out), "--json"])
        check(proc.returncode != 0,
              "N=200 s=-0.05 --output-B: refuses instead of clamping to ones",
              f"exit={proc.returncode}")
        check(not out.exists(),
              "N=200 s=-0.05 --output-B: writes no file",
              f"exists={out.exists()}")
        low = proc.stderr.lower()
        check("conditioning" in low,
              "the diagnostic names the conditioning",
              proc.stderr.strip()[:110])
        # The pre-fix note called a 1.06 excursion on a probability "solver
        # roundoff, within tolerance 13892.7". The replacement has to disclaim
        # that explicitly, not merely omit it.
        check("not roundoff" in low,
              "the diagnostic says outright that this is NOT roundoff",
              proc.stderr.strip()[:110])
        check(not proc.stdout.strip(),
              "nothing is printed to stdout on the refusal",
              f"{len(proc.stdout)}B")

    # RED 2a / 2b (Critical): BOTH signs of unresolvable T_fix. 2a came back
    # negative and was already caught; 2b came back positive and was printed.
    for label, sel in (("s=-0.2 (negative garbage)", "-0.2"),
                       ("s=-0.05 (positive garbage)", "-0.05")):
        proc = run(binary, ["--fixation", "--pop-size", "200",
                            "--selection", sel, "--dominance", "0.5", "--json"])
        check(proc.returncode != 0, f"{label}: exits nonzero",
              f"exit={proc.returncode}")
        check(not proc.stdout.strip(),
              f"{label}: no 17-digit garbage on stdout",
              proc.stdout.strip()[:110])
        # The corrected mechanism. IEEE 754 doubles saturate to +inf and never
        # to a negative, so a sum of nonnegative sojourns CANNOT wrap: the
        # overflow story the first fix recorded was impossible as stated, and
        # measurably wrong (see the table above).
        low = proc.stderr.lower()
        # The claim being pinned out of existence, verbatim from the first fix:
        # "... so the sojourn sums overflowed. Refusing to print it". Nothing
        # overflowed; a sum of nonnegative doubles cannot wrap negative under
        # IEEE 754, and the true values are 260 orders below DBL_MAX. Neither
        # diagnostic may say anything overflowed. (Saying it is NOT an
        # overflow, as the T_fix message does, is the point.)
        check("overflowed" not in low,
              f"{label}: does not claim anything overflowed",
              proc.stderr.strip()[:130])
        check("conditioning" in low,
              f"{label}: names the conditioning of the solve",
              proc.stderr.strip()[:130])
        check("representable" in low,
              f"{label}: says the true value IS representable",
              proc.stderr.strip()[:130])

    # The gate is a property of the parameters, not of which files were asked
    # for. Before the fix the conditioning was only measured inside the
    # --output-B branch, so the same run refused or printed garbage depending
    # on whether a -B path happened to be on the command line.
    with tempfile.TemporaryDirectory() as td:
        out = Path(td) / "B.txt"
        with_b = run(binary, ["--fixation", "--pop-size", "200",
                              "--selection", "-0.05", "--dominance", "0.5",
                              "--output-B", str(out), "--json"])
        without_b = run(binary, ["--fixation", "--pop-size", "200",
                                 "--selection", "-0.05", "--dominance", "0.5",
                                 "--json"])
        check((with_b.returncode != 0) == (without_b.returncode != 0),
              "the verdict does not depend on whether --output-B was requested",
              f"with={with_b.returncode} without={without_b.returncode}")

    # A refusal must leave nothing behind, including the files it would have
    # written from the same failed factorization.
    with tempfile.TemporaryDirectory() as td:
        paths = {f: Path(td) / f"{f}.txt" for f in ("N", "B", "N-fix", "I")}
        args = ["--fixation", "--pop-size", "200", "--selection", "-0.05",
                "--dominance", "0.5", "--json"]
        for flag, p in paths.items():
            args += [f"--output-{flag}", str(p)]
        proc = run(binary, args)
        left = sorted(f for f, p in paths.items() if p.exists())
        check(proc.returncode != 0 and not left,
              "a refused --fixation run leaves no output files behind",
              f"exit={proc.returncode} left={left or 'none'}")

    # And the gate must NOT fire where the solve still resolves the answer.
    # Measured against GTH: 1.8e-07 relative at s=-0.01, 5.3e-06 at s=-0.02.
    for label, sel, want in (("s=-0.01", "-0.01", 1.3513403087419121e10),
                             ("s=-0.02", "-0.02", 3.9384277908656226e11)):
        proc = run(binary, ["--fixation", "--pop-size", "200",
                            "--selection", sel, "--dominance", "0.5",
                            "--starting-copies", "1", "--json"])
        if not check(proc.returncode == 0, f"N=200 {label}: still exits 0",
                     f"exit={proc.returncode} {proc.stderr.strip()[:110]}"):
            continue
        got = json.loads(proc.stdout)["results"]["T_fix"]
        check(rel_diff(got, want) < 1e-4,
              f"N=200 {label}: T_fix still agrees with the GTH reference",
              f"cli={got:.9e} gth={want:.9e} rel={rel_diff(got, want):.2e}")


# --------------------------------------------------------------------------
# Section 7 — the third outcome: a disclosed omission
# --------------------------------------------------------------------------

def section_disclosed_omission(binary: Path) -> None:
    print("\n== disclosed omission is a real, distinct third outcome ==")
    # --absorption -N 150 -s -0.9: the fixation probability from one copy is
    # 2.34e-302, a genuine positive double but below COND_PROB_MIN = 1e-300.
    # Every conditional-on-fixation quantity divides by it, so the conditional
    # sojourn matrix would be entirely roundoff. The run is otherwise sound and
    # its other outputs are real, so it is neither a WRITE nor a REFUSE: the
    # one uncomputable file is omitted, out loud, and the run continues.
    #
    # (--force is required: 2Ns = -270 trips the strongly-deleterious advisory,
    # which is a separate, deliberate guard.)
    base = ["--absorption", "--pop-size", "150", "--selection", "-0.9",
            "--dominance", "0.5", "--starting-copies", "1", "--force"]
    with tempfile.TemporaryDirectory() as td:
        nfix = Path(td) / "N-fix.txt"
        next_ = Path(td) / "N-ext.txt"
        n = Path(td) / "N.txt"
        proc = run(binary, [*base, "--output-N-fix", str(nfix),
                            "--output-N-ext", str(next_),
                            "--output-N", str(n), "--json"])
        if not check(proc.returncode == 0,
                     "disclosed omission: the run still exits 0",
                     f"exit={proc.returncode} {proc.stderr.strip()[:110]}"):
            return
        check(not nfix.exists(),
              "disclosed omission: the uncomputable file is NOT written",
              f"exists={nfix.exists()}")
        check("--output-N-fix not written" in proc.stderr,
              "disclosed omission: stderr names the flag it omitted",
              proc.stderr.strip()[:130])
        check("1e-300" in proc.stderr,
              "disclosed omission: stderr names the threshold that was crossed",
              proc.stderr.strip()[:130])
        # This is what separates outcome 3 from silent acceptance: the run
        # still delivers everything it CAN compute.
        check(next_.exists() and n.exists(),
              "disclosed omission: the computable files are still written",
              f"N-ext={next_.exists()} N={n.exists()}")
        res = json.loads(proc.stdout)["results"]
        check("T_fix" not in res and "T_fix_std" not in res,
              "disclosed omission: the matching scalar fields are omitted too, "
              "not printed as 0/0 artifacts", str(sorted(res)))
        check("P_ext" in res and "T_abs" in res,
              "disclosed omission: the unconditional results are still reported",
              str(sorted(res)))


# --------------------------------------------------------------------------
# Section 8 — structured output is never an empty success
# --------------------------------------------------------------------------

def section_structured(binary: Path) -> None:
    print("\n== no mode exits 0 with zero bytes of structured output ==")
    cases = [
        ("--fundamental --csv (no -p)", ["--fundamental", "--pop-size", str(N_TEST), "--csv"]),
        ("--non-absorbing --csv", ["--non-absorbing", "--pop-size", str(N_TEST), "--csv"]),
        ("--fundamental --json (no -p)", ["--fundamental", "--pop-size", str(N_TEST), "--json"]),
        ("--non-absorbing --json", ["--non-absorbing", "--pop-size", str(N_TEST), "--json"]),
    ]
    for label, args in cases:
        proc = run(binary, args)
        empty = not proc.stdout.strip()
        check(proc.returncode != 0 or not empty,
              f"{label}: refuses or emits something",
              f"exit={proc.returncode} stdout={len(proc.stdout)}B")

    # --fundamental --json with -p carries real data; a fixed "completed"
    # message alongside it makes every successful run look like a no-data run
    # to a consumer that keys off the message.
    proc = run(binary, ["--fundamental", "--pop-size", str(N_TEST), "--starting-copies", "3", "--json"])
    if check(proc.returncode == 0, "--fundamental -p 3 --json exits 0",
             f"exit={proc.returncode}"):
        try:
            res = json.loads(proc.stdout)["results"]
        except (ValueError, KeyError) as exc:
            check(False, "--fundamental -p 3 --json parses", str(exc))
            return
        check("T_abs" in res and "sojourn_times" in res,
              "results carry the sojourn data", str(sorted(res)))
        check("message" not in res,
              "no fixed 'completed' message alongside real data",
              str(res.get("message"))[:80])

    # The no-data variant must say what it did and where the matrix went.
    with tempfile.TemporaryDirectory() as td:
        npath = Path(td) / "N.csv"
        proc = run(binary, ["--fundamental", "--pop-size", str(N_TEST),
                            "--output-N", str(npath), "--json"])
        if check(proc.returncode == 0, "--fundamental --json (no -p) exits 0",
                 f"exit={proc.returncode}"):
            try:
                res = json.loads(proc.stdout)["results"]
            except (ValueError, KeyError) as exc:
                check(False, "--fundamental --json (no -p) parses", str(exc))
                return
            check("T_abs" not in res,
                  "no starting state means no T_abs is claimed", str(sorted(res)))
            check(str(npath) in json.dumps(res),
                  "results record where the matrix was written", str(sorted(res)))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--bin", type=Path, default=DEFAULT_BIN_DIR,
                    help=f"directory containing wfes_single (default: {DEFAULT_BIN_DIR})")
    ap.add_argument("--skip-dense", action="store_true",
                    help="skip the pure-Python dense establishment reference")
    opts = ap.parse_args()

    binary = opts.bin / "wfes_single"
    if not binary.is_file():
        print(f"error: {binary} not found; build it first "
              f"(cmake -S wfes-cli -B wfes-cli/build-cx1b && "
              f"cmake --build wfes-cli/build-cx1b -j8)", file=sys.stderr)
        return 2

    print(f"binary under test: {binary}")
    section_matrix(binary)
    section_output_I(binary)
    section_equilibrium_start(binary)
    section_fixation_B(binary)
    section_establishment(binary, opts.skip_dense)
    section_solve_conditioning(binary)
    section_disclosed_omission(binary)
    section_structured(binary)

    n_fail = sum(1 for ok, *_ in _results if not ok)
    n_pass = len(_results) - n_fail
    print(f"\n{'=' * 78}\nPASS {n_pass}   FAIL {n_fail}")
    if n_fail:
        print("failing checks:")
        for ok, label, detail in _results:
            if not ok:
                print(f"  - {label}" + (f"  [{detail}]" if detail else ""))
    return 1 if n_fail else 0


if __name__ == "__main__":
    sys.exit(main())
