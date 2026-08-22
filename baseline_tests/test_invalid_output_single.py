#!/usr/bin/env python3
"""Invalid-output tests for wfes_single (integrity audit section 7.1, task CX1a).

Contract under test — "refuse, don't substitute":
  * stdout under --json parses with json.load (no bare nan/inf tokens);
  * every reported probability is inside [0, 1];
  * no reported value is non-finite;
  * a field the mode normally reports may be OMITTED only together with a
    stderr diagnostic naming it (partial refusal, exit 0); a run that can
    compute nothing valid must exit nonzero;
  * the degenerate `-c 1` case (no starting state above the integration
    cutoff) must refuse: nonzero exit, diagnostic, no output files written;
  * `-v 0` omits N_ext (undefined without recurrent forward mutation) with a
    stderr diagnostic; everything else is still reported;
  * numerical non-regression: for parameter sets the shipped binary handles
    correctly, every value present in both outputs agrees to 1e-10 relative --
    except quantities integrated over the mutational injection distribution,
    where the shipped reference itself carries a known common-factor error and
    the documented INTEGRATED_REL_TOL applies instead;
  * independent verification: for two `-p 1` cases the absorption quantities
    are recomputed here from scratch (dense LU with partial pivoting on the
    Wright-Fisher matrix built from the published model definitions) and must
    agree with the CLI. One case has P_fix ~ 1e-18: below the 2.2e-16 noise
    floor of the old "B_fix = 1 - B_ext" subtraction, so it separates a real
    solve from a derived complement;
  * --csv is exercised too, not just --json: a healthy case must exit 0 with
    no bare nan/inf token and the same field count as the shipped binary's
    --csv for that case, and the -c 1 degenerate case must still refuse under
    --csv.

Standalone, stdlib-only.

Usage:
    python3 baseline_tests/test_invalid_output_single.py [--bin DIR]
        [--shipped PATH] [--skip-dense]

--bin is the directory containing the wfes_single binary under test
(default: wfes-cli/build-cx1a/bin). --shipped is the reference binary for the
non-regression table (default: the installed WFES3.app copy); its absence is
a hard failure because the non-regression comparison is a required part of
this suite.
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
DEFAULT_BIN_DIR = REPO / "wfes-cli" / "build-cx1a" / "bin"
DEFAULT_SHIPPED = Path("/Applications/WFES3.app/Contents/Resources/bin/wfes_single")

ABS_FIELDS = ["P_ext", "P_fix", "T_abs", "T_abs_std", "T_ext", "T_ext_std",
              "N_ext", "T_fix", "T_fix_std"]
FIX_FIELDS = ["T_fix", "T_std", "rate"]
PROB_FIELDS = {"P_ext", "P_fix"}
REL_TOL = 1e-10

# Non-regression tolerance for quantities INTEGRATED over the mutational
# injection distribution -- i.e. every case that does not pin a starting count
# with -p.
#
# The shipped reference binary renormalizes those injection weights by
# 1 - q0, where q0 = 1 - O(2Nv) is the count-0 entry. That subtraction cancels
# catastrophically, so the whole weight vector carries a common relative error
# bounded by ~eps/(2 * 2Nv) -- and therefore so does every integrated output it
# produces (P_ext, P_fix, T_abs, T_ext, T_fix, N_ext, rate, ...), which all move
# together by that one factor (standard deviations by half of it). At this
# suite's parameters the bound is <= 1.2e-9; the divergences actually measured
# against the shipped binary are 3.913e-10 at 2N = 200 and 1.238e-10 at
# 2N = 100 (opposite signs -- the cancelled digits are a rounding die-roll, not
# a drift). That is the reference's error, not a regression here: this binary
# renormalizes by the retained tail's own sum, which sums small same-sign
# numbers and loses nothing.
#
# 5e-9 sits above the ~1.2e-9 bound with headroom while staying far below any
# difference that would signal a real change in the model or the solve. It
# applies ONLY to the injection-integrated rows: -p-anchored cases and the
# -v 0 section (no forward mutation, hence no injection to integrate) keep the
# 1e-10 tolerance below. When a fixed binary becomes the shipped reference,
# this constant collapses back to REL_TOL.
INTEGRATED_REL_TOL = 5e-9

# Bare non-finite tokens as C++ iostreams print them (json.load rejects them,
# but scan the raw text as well so the diagnosis is explicit).
BAD_TOKEN = re.compile(r"(?<![\w.])[-+]?(?:nan|inf(?:inity)?)(?![\w])", re.I)

# (label, extra args, mode, healthy) -- healthy means the shipped binary's
# output for this case is trustworthy, so it anchors the 1e-10 non-regression
# assertion. The first four absorption cases are the audit section 1.1
# reproductions: the shipped binary emits P_ext > 1, negative P_fix, or nan
# for them, so only the new binary's output contract is asserted there.
SPREAD = [
    ("abs N=200 s=-0.09 h=0.5", ["-N", "200", "-s", "-0.09", "-h", "0.5"], "absorption", False),
    ("abs N=300 s=-0.05",       ["-N", "300", "-s", "-0.05"],              "absorption", False),
    ("abs N=400 s=-0.08",       ["-N", "400", "-s", "-0.08"],              "absorption", False),
    ("abs N=600 s=-0.05",       ["-N", "600", "-s", "-0.05"],              "absorption", False),
    ("abs N=100 s=0.02",        ["-N", "100", "-s", "0.02"],               "absorption", True),
    ("abs N=50 s=0",            ["-N", "50", "-s", "0"],                   "absorption", True),
    ("abs N=100 s=-0.001",      ["-N", "100", "-s", "-0.001"],             "absorption", True),
    ("fix N=100 s=0.02",        ["-N", "100", "-s", "0.02"],               "fixation",   True),
    ("fix N=50 s=0",            ["-N", "50", "-s", "0"],                   "fixation",   True),
]

_results: list[tuple[bool, str, str]] = []


def check(ok: bool, label: str, detail: str = "") -> bool:
    _results.append((bool(ok), label, detail))
    print(f"  {'OK  ' if ok else 'FAIL'} {label}" + (f"  [{detail}]" if detail else ""))
    return bool(ok)


def run(binary: Path, args: list[str], fmt: str = "--json") -> subprocess.CompletedProcess:
    return subprocess.run([str(binary), *args, fmt],
                          capture_output=True, text=True, timeout=600)


def parse_results(proc: subprocess.CompletedProcess):
    """Return (results dict or None, error string)."""

    def refuse_constant(name):  # NaN / Infinity spellings json would accept
        raise ValueError(f"non-finite JSON constant {name!r}")

    try:
        doc = json.loads(proc.stdout, parse_constant=refuse_constant)
    except ValueError as exc:
        return None, f"stdout does not parse as JSON: {exc}"
    if not isinstance(doc, dict) or "results" not in doc:
        return None, "JSON has no 'results' object"
    return doc["results"], ""


def contract_check(label: str, proc: subprocess.CompletedProcess,
                   expected_fields: list[str]):
    """The generic output contract. Returns the parsed results (or None)."""
    print(f"--- {label} ---")
    m = BAD_TOKEN.search(proc.stdout)
    check(m is None, "no bare nan/inf token on stdout",
          m.group(0) if m else "")
    results, err = parse_results(proc)
    if not check(results is not None, "stdout parses as JSON", err):
        check(proc.returncode != 0,
              "unparseable output at least exits nonzero",
              f"exit={proc.returncode}")
        return None
    ok_fin = all(isinstance(v, (int, float)) and math.isfinite(v)
                 for v in results.values())
    check(ok_fin, "every reported value is finite",
          str({k: v for k, v in results.items()
               if not (isinstance(v, (int, float)) and math.isfinite(v))}))
    for f in sorted(PROB_FIELDS & results.keys()):
        check(0.0 <= results[f] <= 1.0, f"{f} in [0,1]", f"{f}={results[f]!r}")
    absent = [f for f in expected_fields if f not in results]
    for f in absent:
        check(f in proc.stderr,
              f"absent field {f} is explained on stderr",
              "stderr does not name it" if f not in proc.stderr else "")
    if len(absent) == len(expected_fields):
        check(proc.returncode != 0,
              "run with no computable field exits nonzero",
              f"exit={proc.returncode}")
    else:
        check(proc.returncode == 0,
              "run that produced results exits 0", f"exit={proc.returncode}")
    return results


def rel_diff(a: float, b: float) -> float:
    if a == b:
        return 0.0
    return abs(a - b) / max(abs(a), abs(b))


# --------------------------------------------------------------------------
# Independent dense reference (pure stdlib).
#
# Builds the diploid Wright-Fisher one-step matrix over allele counts
# 0..2N from the published model definition (psi_diploid selection+mutation
# expectation; binomial sampling rows computed by the same log-space
# recurrence the CLI uses, WITHOUT tail truncation, each row renormalized to
# sum 1 as the CLI does), then solves the absorption system with dense LU
# and partial pivoting. Shares no solver code with the CLI: the CLI
# assembles a truncated sparse matrix and factorizes with UMFPACK/Accelerate;
# this factorizes a dense matrix in pure Python. Agreement therefore checks
# the assembled model AND the linear solve, not one implementation against
# itself.
# --------------------------------------------------------------------------

def psi_diploid(i: int, N: int, s: float, h: float, u: float, v: float) -> float:
    j = (2 * N) - i
    w_11 = max(1.0 + s, 1e-30)
    w_12 = max(1.0 + s * h, 1e-30)
    w_22 = 1.0
    a = w_11 * i * i
    b = w_12 * i * j
    c = w_22 * j * j
    w_bar = a + 2 * b + c
    return (((a + b) * (1.0 - u)) + ((b + c) * v)) / w_bar


def binom_row_full(n: int, p: float) -> list[float]:
    """Binomial(n, p) pmf over 0..n via the CLI's log-space recurrence."""
    if p <= 0.0:
        return [1.0] + [0.0] * n
    if p >= 1.0:
        return [0.0] * n + [1.0]
    lc = math.log(p) - math.log1p(-p)
    d = n * math.log1p(-p)  # log pmf at k = 0
    logs = [d]
    for k in range(1, n + 1):
        d += math.log(n - k + 1) - math.log(k) + lc
        logs.append(d)
    row = [math.exp(x) for x in logs]
    total = math.fsum(row)
    return [x / total for x in row]


def lu_factor(A: list[list[float]]):
    """In-place LU with partial pivoting; returns (LU, piv)."""
    n = len(A)
    piv = list(range(n))
    for k in range(n):
        p = max(range(k, n), key=lambda r: abs(A[r][k]))
        if A[p][k] == 0.0:
            raise ZeroDivisionError("singular matrix in dense reference")
        if p != k:
            A[k], A[p] = A[p], A[k]
            piv[k], piv[p] = piv[p], piv[k]
        akk = A[k][k]
        rowk = A[k]
        for r in range(k + 1, n):
            f = A[r][k] / akk
            if f != 0.0:
                rowr = A[r]
                for c in range(k + 1, n):
                    rowr[c] -= f * rowk[c]
            A[r][k] = f
    return A, piv


def lu_solve(LU, piv, b: list[float]) -> list[float]:
    n = len(LU)
    x = [b[p] for p in piv]
    for i in range(1, n):
        row = LU[i]
        x[i] -= math.fsum(row[j] * x[j] for j in range(i) if x[j] != 0.0)
    for i in range(n - 1, -1, -1):
        row = LU[i]
        x[i] -= math.fsum(row[j] * x[j] for j in range(i + 1, n) if x[j] != 0.0)
        x[i] /= row[i]
    return x


def dense_absorption_reference(N: int, s: float, h: float, u: float, v: float,
                               start_count: int) -> dict[str, float]:
    """All nine absorption-mode quantities for a single starting count."""
    size = 2 * N - 1
    st = start_count - 1  # transient index == count - 1
    Q = []       # transient-to-transient
    R_ext = []
    R_fix = []
    for i in range(1, 2 * N):
        row = binom_row_full(2 * N, psi_diploid(i, N, s, h, u, v))
        R_ext.append(row[0])
        R_fix.append(row[2 * N])
        Q.append(row[1:2 * N])
    # A = I - Q, and its transpose for the fundamental-matrix rows
    A = [[(1.0 if i == j else 0.0) - Q[i][j] for j in range(size)]
         for i in range(size)]
    At = [[A[j][i] for j in range(size)] for i in range(size)]
    LU, piv = lu_factor(A)
    LUt, pivt = lu_factor(At)

    B_ext = lu_solve(LU, piv, R_ext)
    B_fix = lu_solve(LU, piv, R_fix)
    e_st = [0.0] * size
    e_st[st] = 1.0
    N1 = lu_solve(LUt, pivt, e_st)   # row st of (I-Q)^-1
    N2 = lu_solve(LUt, pivt, N1)     # row st of (I-Q)^-2

    T_abs = math.fsum(N1)
    T_abs_var = (2 * math.fsum(N2) - T_abs) - T_abs ** 2
    out = {"P_ext": B_ext[st], "P_fix": B_fix[st],
           "T_abs": T_abs, "T_abs_std": math.sqrt(T_abs_var)}
    for name, B in (("ext", B_ext), ("fix", B_fix)):
        E = [B[j] * N1[j] / B[st] for j in range(size)]
        Ev = [B[j] * N2[j] / B[st] for j in range(size)]
        T = math.fsum(E)
        T_var = (2 * math.fsum(Ev) - T) - T ** 2
        out[f"T_{name}"] = T
        out[f"T_{name}_std"] = math.sqrt(T_var)
        if name == "ext":
            copy_gens = math.fsum(E[j] * (j + 1) for j in range(size))
            out["N_ext"] = copy_gens / (1.0 / (2 * N * v) + T)
    return out


# --------------------------------------------------------------------------
# Test sections
# --------------------------------------------------------------------------

def section_spread(new_bin: Path):
    print("\n== output contract across the parameter spread ==")
    outputs = {}
    for label, extra, mode, _healthy in SPREAD:
        proc = run(new_bin, [f"--{mode}", *extra])
        fields = ABS_FIELDS if mode == "absorption" else FIX_FIELDS
        outputs[label] = contract_check(label, proc, fields)
    return outputs


def section_nonregression(new_bin: Path, shipped: Path, new_outputs):
    print("\n== numerical non-regression vs shipped binary ==")
    print(f"   shipped: {shipped}")
    header = f"{'case':<24} {'field':<10} {'shipped':>24} {'new':>24} {'rel diff':>10}  verdict"
    print(header)
    print("-" * len(header))
    for label, extra, mode, healthy in SPREAD:
        new_res = new_outputs.get(label)
        proc = run(shipped, [f"--{mode}", *extra])
        old_res, err = parse_results(proc)
        if new_res is None:
            check(False, f"{label}: no parsed output from new binary")
            continue
        if old_res is None:
            # The shipped binary emits unparseable output (bare nan) for some
            # defect reproductions; that IS the defect. Only healthy cases
            # must be comparable.
            print(f"{label:<24} {'-':<10} {'<unparseable: ' + err[:26] + '>':>24} "
                  f"{'-':>24} {'-':>10}  defective shipped output")
            check(not healthy, f"{label}: shipped output parseable for healthy case", err)
            continue
        if healthy:
            check(set(old_res) == set(new_res),
                  f"{label}: healthy case keeps the full field set",
                  f"shipped={sorted(old_res)} new={sorted(new_res)}")
        # A case that pins its starting count with -p integrates over nothing,
        # so the shipped binary's injection-weight error cannot reach it and
        # the tight tolerance applies. Everything else is integrated over the
        # injection distribution -- see INTEGRATED_REL_TOL.
        tol = REL_TOL if "-p" in extra else INTEGRATED_REL_TOL
        for f in [f for f in (ABS_FIELDS if mode == "absorption" else FIX_FIELDS)
                  if f in old_res and f in new_res]:
            d = rel_diff(old_res[f], new_res[f])
            if healthy:
                verdict = "OK" if d <= tol else "FAIL"
            else:
                verdict = "n/a (defective shipped baseline)"
            print(f"{label:<24} {f:<10} {old_res[f]:>24.17g} {new_res[f]:>24.17g} "
                  f"{d:>10.2e}  {verdict}")
            if healthy:
                check(d <= tol, f"{label}.{f} agrees with shipped to {tol:g}",
                      f"rel diff {d:.3e}")


def section_degenerate_cutoff(new_bin: Path):
    print("\n== -c 1 degenerate: refuse before writing anything ==")
    with tempfile.TemporaryDirectory() as td:
        n_out = Path(td) / "N.csv"
        b_out = Path(td) / "B.csv"
        proc = run(new_bin, ["--absorption", "-N", "10", "-c", "1",
                             "--output-N", str(n_out), "--output-B", str(b_out)])
        check(proc.returncode != 0, "absorption -c 1 exits nonzero",
              f"exit={proc.returncode}")
        check(bool(re.search(r"cutoff", proc.stderr, re.I)),
              "stderr diagnostic mentions the integration cutoff",
              proc.stderr.strip()[:120])
        check('"results"' not in proc.stdout, "no results object is emitted")
        check(not n_out.exists(), "--output-N file was not written")
        check(not b_out.exists(), "--output-B file was not written")
    proc = run(new_bin, ["--fixation", "-N", "10", "-c", "1"])
    check(proc.returncode != 0, "fixation -c 1 exits nonzero",
          f"exit={proc.returncode}")


def section_v0(new_bin: Path, shipped: Path):
    print("\n== -v 0: N_ext undefined, everything else reported ==")
    proc = run(new_bin, ["--absorption", "-N", "8", "-v", "0"])
    results = contract_check("abs N=8 v=0", proc, ABS_FIELDS)
    if results is None:
        return
    check("N_ext" not in results, "N_ext is omitted",
          f"N_ext={results.get('N_ext')!r}")
    check("N_ext" in proc.stderr, "stderr diagnostic names N_ext")
    others = [f for f in ABS_FIELDS if f != "N_ext"]
    check(all(f in results for f in others),
          "the other eight fields are present",
          str([f for f in others if f not in results]))
    # Non-regression on the shared fields (shipped output is healthy here
    # except for the N_ext artifact).
    old_res, err = parse_results(run(shipped, ["--absorption", "-N", "8", "-v", "0"]))
    if check(old_res is not None, "shipped output parseable for -v 0", err):
        for f in [f for f in others if f in old_res and f in results]:
            d = rel_diff(old_res[f], results[f])
            check(d <= REL_TOL, f"v0.{f} agrees with shipped to {REL_TOL:g}",
                  f"shipped={old_res[f]!r} new={results[f]!r} rel={d:.2e}")


def section_underflow(new_bin: Path):
    print("\n== extreme underflow: P_fix below double precision ==")
    # 2N s h = -500: the true single-copy fixation probability is ~1e-434,
    # unrepresentable in a double. The fixation-conditional family must be
    # omitted with diagnostics, not printed as 0 / nan / garbage.
    proc = run(new_bin, ["--absorption", "-N", "1000", "-s", "-0.5", "-h", "0.5",
                         "--force"])
    results = contract_check("abs N=1000 s=-0.5 (forced)", proc, ABS_FIELDS)
    if results is None:
        return
    for f in ("P_fix", "T_fix", "T_fix_std"):
        check(f not in results, f"{f} is omitted rather than fabricated",
              f"{f}={results.get(f)!r}")
    for f in ("P_ext", "T_abs", "T_ext"):
        check(f in results, f"{f} is still reported")


def section_refusal_leaves_nothing(new_bin: Path):
    print("\n== a refused run leaves no output artefacts behind ==")
    # --establishment -p at or above the establishment count is refused (it
    # indexes past the end of the truncated model's state space -- SIGABRT on a
    # debug build, an out-of-bounds write under NDEBUG). The guard was correct
    # but it ran ~160 lines too late: WF::Truncated had already been built and
    # --output-Q / --output-R had already been written from it, so the rejected
    # run exited 1 with a matrix file on disk that a user could pick up and
    # analyse. Measured on the pre-fix build:
    #
    #   $ wfes_single --establishment -N 8 -s 0.05 -h 0.5 -p 10 \
    #                 --output-Q leak.mtx
    #   Error: -p / --starting-copies 10 is at or above the establishment
    #          count 7 ...
    #   $ ls leak.mtx        ->  -rw-r--r--  1025 bytes
    #
    # A refusal that leaves an artefact is not a refusal. The range check now
    # runs the moment est_idx is known, before anything is built or written.
    with tempfile.TemporaryDirectory() as td:
        paths = {
            "Q": Path(td) / "leak_Q.mtx",
            "R": Path(td) / "leak_R.txt",
            "N": Path(td) / "leak_N.txt",
            "B": Path(td) / "leak_B.txt",
            "I": Path(td) / "leak_I.txt",
        }
        args = ["--establishment", "-N", "8", "-s", "0.05", "-h", "0.5",
                "-p", "10"]
        for flag, p in paths.items():
            args += [f"--output-{flag}", str(p)]
        proc = run(new_bin, args)
        check(proc.returncode != 0,
              "establishment -p above the establishment count is refused",
              f"exit={proc.returncode}")
        left = sorted(f for f, p in paths.items() if p.exists())
        check(not left,
              "the refusal writes NO output file, --output-Q included",
              f"left behind: {left or 'nothing'}")
        check("establishment count" in proc.stderr,
              "the diagnostic names the establishment count and the valid range",
              proc.stderr.strip()[:130])

    # The healthy neighbour still works: -p just below the establishment count
    # must write everything, so the guard is a range check and not a blanket
    # refusal of --establishment -p.
    with tempfile.TemporaryDirectory() as td:
        q = Path(td) / "Q.mtx"
        proc = run(new_bin, ["--establishment", "-N", "8", "-s", "0.05",
                             "-h", "0.5", "-p", "3", "--output-Q", str(q)])
        check(proc.returncode == 0 and q.exists(),
              "establishment -p below the establishment count still writes",
              f"exit={proc.returncode} Q={q.exists()}")

    # A SECOND out-of-bounds access in the same branch, found while verifying
    # the one above, and not previously reported.
    #
    # --establishment starts its post-establishment calculation one copy ABOVE
    # the establishment count (a deliberate, frozen convention). When the odds
    # threshold is first crossed at the last transient count, that start index
    # is one past the end of every full-model vector: the state is fixation,
    # which is absorbing, not transient. Measured at -N 5 -s 0.05 --odds-ratio
    # 10, where est_idx == size == 9:
    #
    #   unoptimised build : SIGABRT on the Eigen bounds assertion (exit 134)
    #   Release build     : assertion compiled out (-DNDEBUG is the default
    #                       since bd0bc2e, and is what ships), so id_full(9)=1
    #                       writes past the end, B_full_*(9) read past it, and
    #                       the run prints, at exit 0:
    #                          Est. freq. = 0.9   P_est = 0.131484
    #                          T_seg = 0   T_seg_std = 0   T_est = 14.1072
    #
    # The two zeros are the tell: id_full never received its 1, so the sojourn
    # solve returned the zero vector and T_seg was "measured" as 0 generations.
    # This is the shape the whole audit exists to remove -- a fabricated number
    # at exit 0 -- and on the shipping build configuration it is silent.
    proc = run(new_bin, ["--establishment", "-N", "5", "-s", "0.05",
                         "-h", "0.5", "--odds-ratio", "10"])
    check(proc.returncode not in (0, -6, 134),
          "establishment at est_idx == size refuses instead of aborting or "
          "reading out of bounds", f"exit={proc.returncode}")
    check("T_seg" not in proc.stdout,
          "no fabricated T_seg = 0 from an out-of-bounds sojourn solve",
          proc.stdout.strip()[-90:])
    check("fixation itself" in proc.stderr,
          "the diagnostic explains that the post-establishment state IS "
          "fixation", proc.stderr.strip()[:130])

    # ... and the neighbouring odds ratio, whose establishment count is inside
    # the transient space, still computes.
    proc = run(new_bin, ["--establishment", "-N", "5", "-s", "0.05",
                         "-h", "0.5", "--odds-ratio", "2"])
    check(proc.returncode == 0,
          "establishment with est_idx < size is unaffected",
          f"exit={proc.returncode} {proc.stderr.strip()[:90]}")


def section_csv(new_bin: Path, shipped: Path):
    print("\n== --csv output: healthy case and degenerate refusal ==")
    # The suite above exercises --json exclusively; --csv is a separate
    # OutputFormatter code path (and, for a run with an omitted field, a
    # separate print_absorption_results_partial branch) that could silently
    # diverge from it. Healthy case reuses "abs N=100 s=0.02" from SPREAD.
    label = "abs N=100 s=0.02 (csv)"
    proc = run(new_bin, ["--absorption", "-N", "100", "-s", "0.02"], fmt="--csv")
    check(proc.returncode == 0, f"{label}: exits 0", f"exit={proc.returncode}")
    m = BAD_TOKEN.search(proc.stdout)
    check(m is None, f"{label}: no bare nan/inf token on stdout",
          m.group(0) if m else "")

    new_lines = proc.stdout.strip().splitlines()
    new_fields = new_lines[0].split(",") if new_lines else []
    shipped_proc = run(shipped, ["--absorption", "-N", "100", "-s", "0.02"], fmt="--csv")
    shipped_lines = shipped_proc.stdout.strip().splitlines()
    shipped_fields = shipped_lines[0].split(",") if shipped_lines else []
    check(len(new_fields) == len(shipped_fields) and len(new_fields) > 0,
          f"{label}: field count matches shipped binary's --csv",
          f"new={new_fields} shipped={shipped_fields}")

    proc = run(new_bin, ["--absorption", "-N", "10", "-c", "1"], fmt="--csv")
    check(proc.returncode != 0, "csv degenerate -c 1 exits nonzero",
          f"exit={proc.returncode}")


def section_dense_reference(new_bin: Path):
    print("\n== independent dense-LU reference ==")
    cases = [
        # (label, N, s, h, start count, extra CLI args, rel tolerance)
        # Healthy case: every quantity at ordinary magnitudes.
        ("N=50 s=0.02 p=1", 50, 0.02, 0.5, 1, [], 1e-8),
        # P_fix ~ 1e-18: an order of magnitude below the 2.2e-16 subtraction
        # noise floor. The shipped binary prints P_fix=0 and T_fix=nan here.
        ("N=100 s=-0.2 p=1", 100, -0.2, 0.5, 1, [], 1e-8),
    ]
    u = v = 1e-9
    for label, N, s, h, p_count, extra, tol in cases:
        print(f"--- {label} ---")
        ref = dense_absorption_reference(N, s, h, u, v, p_count)
        proc = run(new_bin, ["--absorption", "-N", str(N), "-s", str(s),
                             "-h", str(h), "-p", str(p_count), *extra])
        results, err = parse_results(proc)
        if not check(results is not None, "CLI output parses", err):
            continue
        for f in ABS_FIELDS:
            if f not in results:
                check(f in proc.stderr, f"{f} absent but explained on stderr")
                continue
            d = rel_diff(ref[f], results[f])
            check(d <= tol, f"{f}: CLI vs dense reference within {tol:g}",
                  f"ref={ref[f]:.12e} cli={results[f]:.12e} rel={d:.2e}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--bin", type=Path, default=DEFAULT_BIN_DIR,
                    help=f"directory containing wfes_single (default: {DEFAULT_BIN_DIR})")
    ap.add_argument("--shipped", type=Path, default=DEFAULT_SHIPPED,
                    help=f"shipped reference binary (default: {DEFAULT_SHIPPED})")
    ap.add_argument("--skip-dense", action="store_true",
                    help="skip the (slower) pure-Python dense reference section")
    opts = ap.parse_args()

    new_bin = opts.bin / "wfes_single"
    if not new_bin.is_file():
        print(f"error: {new_bin} not found; build it first "
              f"(cmake -S wfes-cli -B wfes-cli/build-cx1a && "
              f"cmake --build wfes-cli/build-cx1a -j8)", file=sys.stderr)
        return 2
    if not opts.shipped.is_file():
        print(f"error: shipped reference binary {opts.shipped} not found; the "
              f"non-regression comparison is a required part of this suite "
              f"(point --shipped at a known-good binary)", file=sys.stderr)
        return 2

    print(f"binary under test: {new_bin}")
    new_outputs = section_spread(new_bin)
    section_nonregression(new_bin, opts.shipped, new_outputs)
    section_degenerate_cutoff(new_bin)
    section_v0(new_bin, opts.shipped)
    section_underflow(new_bin)
    section_refusal_leaves_nothing(new_bin)
    section_csv(new_bin, opts.shipped)
    if opts.skip_dense:
        print("\n(dense reference section skipped on request)")
    else:
        section_dense_reference(new_bin)

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
