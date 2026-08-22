#!/usr/bin/env python3
"""
Regression harness: validate wfes_single against the recorded reference outputs
in this directory.

The reference values are transcribed from the baseline_* files here, which state
they were "Generated using original wfes2 implementation" (Ivan Krukov's
MKL/PARDISO version). This script re-runs the CLI and checks agreement.

Usage
-----
    python3 baseline_tests/validate_baselines.py [--library Accelerate]
    python3 baseline_tests/validate_baselines.py --bin /path/to/wfes_single

Exit status is 0 only if every check passes.

Tolerance
---------
Both sides of the comparison are decimal representations of limited precision,
so the comparison can be no tighter than the COARSER of the two. For each value
this script reconstructs the rounding interval implied by each representation
(half a unit in its last decimal place) and requires agreement within the larger.

Which side is coarser has changed over time, which is why the tolerance is taken
from both rather than from the printed value alone:
  - originally the CLI's JSON writer emitted ~6 significant digits while the
    recorded baselines carry 10-11, so the printed value was the limit;
  - since JSON gained round-trip precision (17 significant digits), the recorded
    baselines are the limit instead.
Taking the maximum keeps the harness correct under either regime, and the
effective comparison is now ~11 significant figures rather than ~6.

A PASS therefore means agreement to the full precision of whichever artifact is
less precise. It does not establish agreement beyond that.

Provenance note
---------------
The fixation cases use `-p 0` (start from zero copies: full substitution time,
mutational origination included). The recorded baseline VALUES were produced by
the original wfes2 under its old convention, where `-p 1` computed the count-0
quantity (an off-by-one relabeling, verified against an independent dense
reference: count-0 T_fix = 4.3605511613e+05 vs the recorded 4.3605511611e+05).
On 2026-08-17 the CLI's -p semantics were fixed to be mode-aware (fixation:
index == count, -p 0 legal; both-absorbing modes: index == count - 1, -p 0 is
an error), so the same recorded values are now reproduced by `-p 0`. The
baseline files record N, s, h, u, v and a but not p or c, which is why this
must be documented here rather than read from the files.
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import tempfile
import sys
from decimal import Decimal
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
DEFAULT_BIN = REPO / "wfes-cli" / "build" / "bin" / "wfes_single"

# (case label, CLI args, {baseline label: (json key, expected literal)})
# Expected literals are copied verbatim from the baseline_* files.
CASES: list[tuple[str, list[str], dict[str, tuple[str, str]]]] = [
    (
        "N=100 ABSORPTION  [baseline_wfes_single_absorption_N100.txt]",
        ["--absorption", "-N", "100", "-s", "0.01", "-h", "0.5",
         "-u", "1e-6", "-v", "1e-6", "-p", "1", "-c", "0"],
        {
            "P_ext":     ("P_ext", "9.8850198569e-01"),
            "P_fix":     ("P_fix", "1.1498014307e-02"),
            "T_abs":     ("T_abs", "1.3763025703e+01"),
            "T_abs_std": ("T_abs_std", "5.6187533505e+01"),
            "T_ext":     ("T_ext", "9.5423157407e+00"),
            "T_ext_std": ("T_ext_std", "3.4489660077e+01"),
            "N_ext":     ("N_ext", "3.4335298357e-02"),
            "T_fix":     ("T_fix", "3.7662395695e+02"),
            "T_fix_std": ("T_fix_std", "1.9775401603e+02"),
        },
    ),
    (
        "N=100 FIXATION    [baseline_wfes_single_fixation_N100.txt]",
        ["--fixation", "-N", "100", "-s", "0.01", "-h", "0.5",
         "-u", "1e-6", "-v", "1e-6", "-p", "0"],
        {
            "T_fix": ("T_fix", "4.3605511611e+05"),
            "T_std": ("T_std", "4.3567816452e+05"),
            "Rate":  ("rate", "2.2932880800e-06"),
        },
    ),
    (
        "N=5 FIXATION      [baseline_wfes_single_all_modes_N5.txt]",
        ["--fixation", "-p", "0"],
        {
            "T_fix": ("T_fix", "6.7344433610e+08"),
            "T_std": ("T_std", "6.7344431832e+08"),
            "Rate":  ("rate", "1.4849037202e-09"),
        },
    ),
    (
        "N=5 ABSORPTION    [baseline_wfes_single_all_modes_N5.txt]",
        ["--absorption", "-p", "1"],
        {
            "P_ext":     ("P_ext", "8.5150961700e-01"),
            "P_fix":     ("P_fix", "1.4849038300e-01"),
            "T_abs":     ("T_abs", "6.2910739849e+00"),
            "T_abs_std": ("T_abs_std", "8.2254695049e+00"),
            "T_ext":     ("T_ext", "4.3736841537e+00"),
            "T_ext_std": ("T_ext_std", "6.1161863379e+00"),
            "N_ext":     ("N_ext", "9.7201774696e-08"),
            "T_fix":     ("T_fix", "1.7286236418e+01"),
            "T_fix_std": ("T_fix_std", "9.9575675890e+00"),
        },
    ),
    (
        # Baseline lists E[freq mut] and E[freq wt]; the CLI emits one "E_freq".
        # Mapped to E[freq mut]; the wt complement is checked separately below.
        "N=5 EQUILIBRIUM   [baseline_wfes_single_all_modes_N5.txt]",
        ["--equilibrium"],
        {"E[freq mut]": ("E_freq", "7.0210952180e-01")},
    ),
    (
        # Baseline labels are E(A)/S(A); the CLI emits E_T/Std_T.
        "N=5 ALLELE_AGE    [baseline_wfes_single_all_modes_N5.txt]",
        ["--allele-age", "-x", "3", "-p", "1"],
        {
            "E(A)": ("E_T", "8.5221742099e+00"),
            "S(A)": ("Std_T", "8.4825247661e+00"),
        },
    ),
    (
        # Baseline label F_est corresponds to the CLI's est_freq.
        #
        # DELIBERATE DIVERGENCE FROM wfes2 (2026-08-17). Three of these values no
        # longer match baseline_wfes_single_all_modes_N5.txt, because that file
        # records original-wfes2 output produced with two implementation defects:
        # the truncated model's establishment column omitted its last support
        # state (rows did not sum to 1, deficits up to 1.4e-4 here), and the
        # integrated variance mixed p_i- and p_i^2-weighted terms. The expected
        # values below are taken from an INDEPENDENT dense reference built from
        # doc/ivan-thesis/chapters/establishment.tex (scratch ref_est_full.py),
        # not read back out of the fixed binary. See
        # the establishment-method notes (internal dev notes).
        #
        #   quantity     wfes2 (recorded)      corrected (independent ref)
        #   P_est        2.2408912193e-01      2.2413131056e-01
        #   T_est        5.8388973720e+00      5.8389788174e+00
        #   T_est_std    3.6052313251e+00      3.6052357888e+00
        #
        # F_est and the whole T_seg family are UNCHANGED: the post-establishment
        # start state (c*+1) is Ivan's convention and is deliberately frozen.
        #
        # SECOND CORRECTION, 2026-08-21 (injection-weight renormalization). The
        # three establishment values above were recorded while the mutational
        # injection weights were renormalized by 1 - q0, a subtraction that
        # cancels catastrophically because q0 = 1 - O(2Nv). At these parameters
        # (N=5, v=1e-9, so 2Nv = 1e-8) that put a UNIFORM relative error
        # delta = +1.5774722e-9 on every weight, hence the same common factor on
        # every weight-integrated quantity (delta/2 on a standard deviation).
        # delta was measured in exact rational arithmetic on the exact double
        # inputs, against a bit-exact replication of the binary's log-domain
        # binom_row pipeline. Because the independent dense reference
        # (ref_est_full.py) necessarily replicated that same double-precision
        # 1 - q0 renormalization, its literals inherited the factor.
        #
        # The values below are the recorded reference literals with that
        # exactly-measured factor divided out -- recorded/(1+delta), and
        # recorded/(1+delta/2) for the standard deviation -- so they retain the
        # thesis reference's provenance and are NOT read back out of the binary
        # under test. They agree to all 11 recorded digits with the binary that
        # renormalizes by the tail's own sum, which is the corroboration, not
        # the source:
        #
        #   quantity     was (carried delta)   now (delta divided out)
        #   P_est        2.2413131056e-01      2.2413131021e-01
        #   T_est        5.8389788174e+00      5.8389788082e+00
        #   T_est_std    3.6052357888e+00      3.6052357860e+00
        #
        # F_est and the whole T_seg family are again unchanged, and measurably
        # so: they are bit-identical across the renormalizer fix because they do
        # not depend on the injection weights.
        "N=5 ESTABLISHMENT [thesis reference; diverges from wfes2, see notes]",
        # Spelling only: --odds-ratio is long form only since the short-flag
        # canonicalization, because -k is --n-moments (a moment COUNT) in
        # phase_type_moments and a letter may not mean two things. The odds
        # ratio, the model and every recorded value below are unchanged;
        # `-k 1.5` is now a hard error naming this spelling.
        ["--establishment", "--odds-ratio", "1.5"],
        {
            "F_est":         ("est_freq", "5.0000000000e-01"),
            "P_est":         ("P_est", "2.2413131021e-01"),  # was 2.2413131056e-01
            "T_seg":         ("T_seg", "1.1701964839e+01"),
            "T_seg_std":     ("T_seg_std", "9.3571022200e+00"),
            "T_seg_ext":     ("T_seg_ext", "1.3789854846e+01"),
            "T_seg_ext_std": ("T_seg_ext_std", "9.6783118254e+00"),
            "T_seg_fix":     ("T_seg_fix", "1.0843481736e+01"),
            "T_seg_fix_std": ("T_seg_fix_std", "9.0836057920e+00"),
            "T_est":         ("T_est", "5.8389788082e+00"),      # was 5.8389788174e+00
            "T_est_std":     ("T_est_std", "3.6052357860e+00"),  # was 3.6052357888e+00
        },
    ),
]

# Parameters for the N=5 all-modes cases, per that baseline file's header.
N5_PARAMS = ["-N", "5", "-s", "0.1", "-h", "0.5", "-u", "1e-9", "-v", "1e-9"]

SCALAR_RE = re.compile(
    r'"([A-Za-z_][A-Za-z0-9_]*)"\s*:\s*(-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)')


def half_ulp(printed: str) -> Decimal:
    """Half a unit in the last decimal place of `printed`."""
    exponent = Decimal(printed).as_tuple().exponent
    if not isinstance(exponent, int):  # 'n'/'N'/'F' for NaN/Infinity
        raise ValueError(f"non-finite value: {printed!r}")
    return Decimal(1).scaleb(exponent) / 2


def run(binary: Path, args: list[str], library) -> tuple[dict[str, str], str]:
    """Return ({json key: printed literal}, error message)."""
    cmd = [str(binary), *args]
    if "-N" not in args:
        cmd += N5_PARAMS
    cmd += (["--library", library] if library else []) + ["--json"]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    blob = proc.stdout[proc.stdout.find("{"):] if "{" in proc.stdout else ""
    if not blob:
        return {}, (f"no JSON (exit {proc.returncode}): "
                    f"{(proc.stdout + proc.stderr).strip()[:300]}")
    try:
        json.loads(blob)  # validate well-formedness
    except json.JSONDecodeError as exc:
        return {}, f"malformed JSON: {exc}"
    return dict(SCALAR_RE.findall(blob)), ""


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--bin", type=Path, default=DEFAULT_BIN,
                    help=f"wfes_single binary (default: {DEFAULT_BIN})")
    ap.add_argument("--library", default=None,
                    help="solver backend to pass to --library (default: omit the "
                         "flag and use the binary's platform default -- required "
                         "for portability: each build whitelists only the backends "
                         "it links, e.g. Linux/MKL builds refuse 'Accelerate')")
    opts = ap.parse_args()

    if not opts.bin.is_file():
        print(f"error: {opts.bin} not found. Build the CLI first "
              f"(cd wfes-cli/build && cmake .. && make -j8).", file=sys.stderr)
        return 2

    print(f"binary : {opts.bin}")
    print(f"backend: {opts.library or '(platform default)'}")

    n_pass = n_fail = n_unresolved = 0
    for label, args, checks in CASES:
        print(f"\n=== {label} ===")
        literals, err = run(opts.bin, args, opts.library)
        if err:
            print(f"  !!   {err}")
            n_unresolved += len(checks)
            continue

        for blabel, (key, expected_str) in checks.items():
            if key not in literals:
                print(f"  ??   {blabel:<14} key '{key}' absent; "
                      f"available: {sorted(literals)}")
                n_unresolved += 1
                continue
            printed = literals[key]
            got, expected = Decimal(printed), Decimal(expected_str)
            # The comparison can be no tighter than the coarser representation.
            tol = max(half_ulp(printed), half_ulp(expected_str))
            diff = abs(got - expected)
            ok = diff <= tol
            print(f"  {'OK  ' if ok else 'FAIL'} {blabel:<14} "
                  f"baseline={expected_str:<18} printed={printed:<14} "
                  f"|diff|={diff:.3e} tol={tol:.1e}")
            n_pass, n_fail = n_pass + ok, n_fail + (not ok)

        if "EQUILIBRIUM" in label and "E_freq" in literals:
            wt = Decimal(1) - Decimal(literals["E_freq"])
            expected_wt = Decimal("2.9789047820e-01")
            tol = max(half_ulp(literals["E_freq"]), half_ulp("2.9789047820e-01"))
            diff = abs(wt - expected_wt)
            ok = diff <= tol
            print(f"  {'OK  ' if ok else 'FAIL'} {'E[freq  wt]':<14} "
                  f"baseline=2.9789047820e-01 1-E_freq={wt:<14} "
                  f"|diff|={diff:.3e} tol={tol:.1e}")
            n_pass, n_fail = n_pass + ok, n_fail + (not ok)

    # ---- --fundamental: one row with -p, the whole matrix without ----------
    #
    # Sojourn times are conditioned on a starting state, so this mode has two
    # outputs and -p chooses between them. Two earlier versions of this branch
    # got it wrong in opposite directions: one ignored -p entirely and always
    # dumped the matrix, the next averaged rows under a starting distribution
    # and could fail the matrix-only run over a quantity nobody asked for.
    print(f"\n{'-' * 78}")
    print("--fundamental: -p selects one row of N, its absence selects the matrix")
    sel = ["-N", "5", "-s", "0.1", "-h", "0.5", "-u", "1e-4", "-v", "1e-4"]
    size = 2 * 5 - 1

    def fund(extra, out=None):
        args = [str(opts.bin), "--fundamental"] + sel + extra
        if out:
            args += ["--output-N", str(out)]
        args += (["--library", opts.library] if opts.library else []) + ["--json"]
        return subprocess.run(args, capture_output=True, text=True)

    with tempfile.TemporaryDirectory() as td:
        full_path, row_path = Path(td) / "full.csv", Path(td) / "row.csv"
        proc_full = fund([], full_path)
        proc_row = fund(["-p", "3"], row_path)
        rows_of = lambda f: [[float(x) for x in r.split(",") if x.strip()]
                             for r in f.read_text().splitlines() if r.strip()]
        checks = []
        full = rows_of(full_path) if proc_full.returncode == 0 else []
        row = rows_of(row_path) if proc_row.returncode == 0 else []
        checks.append(("no -p computes the whole matrix", len(full) == size, f"{len(full)} rows"))
        checks.append(("-p writes just that row", len(row) == 1, f"{len(row)} rows"))
        same = (full and row and
                max(abs(a - b) for a, b in zip(row[0], full[2])) == 0.0)
        checks.append(("-p 3 row equals row 2 of N", bool(same), "exact" if same else "differs"))

        res_full = json.loads(proc_full.stdout)["results"] if proc_full.returncode == 0 else {}
        res_row = json.loads(proc_row.stdout)["results"] if proc_row.returncode == 0 else {}
        checks.append(("no -p reports no T_abs", "T_abs" not in res_full,
                       "absent" if "T_abs" not in res_full else "present"))
        checks.append(("-p reports T_abs", "T_abs" in res_row,
                       f"{res_row.get('T_abs', 'missing')}"))
        if "T_abs" in res_row and row:
            s_ok = abs(res_row["T_abs"] - sum(row[0])) < 1e-12
            checks.append(("T_abs is the row sum", s_ok, f"{res_row['T_abs']:.10f}"))

        # --initial describes a distribution over starting states, which this
        # mode does not average over. Refused, not ignored.
        bad = fund(["--initial", str(full_path)])
        checks.append(("--initial is refused", bad.returncode != 0 or "Error" in bad.stdout,
                       "refused"))

        # V is built from the whole matrix, so it forces a full computation and
        # must not lose the row that -p asked for.
        vpath = Path(td) / "v.csv"
        pv = subprocess.run([str(opts.bin), "--fundamental"] + sel +
                            ["-p", "3", "--output-V", str(vpath), *(["--library", opts.library] if opts.library else []), "--json"],
                            capture_output=True, text=True)
        rv = json.loads(pv.stdout)["results"] if pv.returncode == 0 else {}
        checks.append(("--output-V with -p keeps the row",
                       "T_abs" in rv and vpath.exists(), "both present"))

        for label, ok, detail in checks:
            print(f"  {'OK  ' if ok else 'FAIL'} {label:<34} {detail}")
            n_pass, n_fail = n_pass + ok, n_fail + (not ok)

    # ---- allele-age higher moments (--num-moments) --------------------------
    #
    # Reference values verified three ways against each other during
    # implementation: the truncated series sum_t t^k Q^t with Q taken from the
    # CLI's own --output-Q, the paper's closed forms (mu_k = Li_{-k}(Q)/N), and
    # the shipped k<=2 legacy path. All agreed to the digits recorded here.
    print(f"\n{'-' * 78}")
    print("--allele-age --num-moments 4 against the dense-series reference")
    aa_args = ["--allele-age", "-N", "10", "-s", "0.01", "-h", "0.5",
               "-u", "1e-4", "-v", "1e-4", "-p", "2", "--observed-copies", "8",
               "--num-moments", "4", *(["--library", opts.library] if opts.library else []), "--json"]
    proc = subprocess.run([str(opts.bin)] + aa_args, capture_output=True, text=True)
    try:
        r = json.loads(proc.stdout)["results"]
        m = r["age_raw_moments"]
        import math as _math
        checks = [
            ("mu1 == legacy E_T", abs(m[0] - r["E_T"]) < 1e-12 * max(1, abs(r["E_T"])), f"{m[0]:.12g}"),
            ("sd(mu2) == legacy Std_T", abs(_math.sqrt(m[1] - m[0]**2) - r["Std_T"]) < 1e-9 * r["Std_T"], f"{_math.sqrt(m[1]-m[0]**2):.12g}"),
            ("mu1 vs series", abs(m[0] - 21.8788257309) < 1e-8 * 21.8788257309, f"{m[0]:.10f}"),
            ("mu3 vs series", abs(m[2] - 4.873641e4) < 1e-5 * 4.873641e4, f"{m[2]:.6e}"),
            ("mu4 vs series", abs(m[3] - 3.788051e6) < 1e-5 * 3.788051e6, f"{m[3]:.6e}"),
            ("skewness vs series", abs(r["age_skewness"] - 2.075220) < 1e-5, f"{r['age_skewness']:.6f}"),
        ]
    except Exception as e:
        checks = [("allele-age moments run", False, (proc.stdout or proc.stderr)[:80])]
    for label, ok, detail in checks:
        print(f"  {'OK  ' if ok else 'FAIL'} {label:<26} {detail}")
        n_pass, n_fail = n_pass + ok, n_fail + (not ok)

    # Integrated start: Std_T is the mixture SD, so it must equal the SD implied
    # by the mixture raw moments exactly. Under the pre-2026-08 convention
    # (average of per-start SDs) this check fails by ~3e-5 relative.
    proc = subprocess.run([str(opts.bin), "--allele-age", "-N", "10", "-s", "0.01", "-h", "0.5",
                           "-u", "1e-4", "-v", "1e-4", "--observed-copies", "8",
                           "--num-moments", "3", *(["--library", opts.library] if opts.library else []), "--json"],
                          capture_output=True, text=True)
    r = json.loads(proc.stdout)["results"]
    import math as _m2
    sd_mix = _m2.sqrt(r["age_raw_moments"][1] - r["age_raw_moments"][0] ** 2)
    ok = abs(r["Std_T"] - sd_mix) < 1e-12 * sd_mix
    print(f"  {'OK  ' if ok else 'FAIL'} {'integrated Std_T = mixture SD':<30} {r['Std_T']:.10f}")
    n_pass, n_fail = n_pass + ok, n_fail + (not ok)

    # Default output must be unchanged: no moment fields without --num-moments.
    proc = subprocess.run([str(opts.bin), "--allele-age", "-N", "10", "-s", "0.01", "-h", "0.5",
                           "-u", "1e-4", "-v", "1e-4", "-p", "2", "--observed-copies", "8",
                           *(["--library", opts.library] if opts.library else []), "--json"], capture_output=True, text=True)
    r = json.loads(proc.stdout)["results"]
    ok = set(r.keys()) == {"E_T", "Std_T"}
    print(f"  {'OK  ' if ok else 'FAIL'} {'default output unchanged':<26} keys={sorted(r.keys())}")
    n_pass, n_fail = n_pass + ok, n_fail + (not ok)

    print(f"\n{'=' * 78}")
    print(f"PASS {n_pass}   FAIL {n_fail}   UNRESOLVED {n_unresolved}")
    print("Tolerance = half-ulp of the COARSER of (printed value, recorded")
    print("baseline): agreement to the full precision of the less precise of")
    print("the two, currently the recorded baselines at ~11 s.f.")
    return 1 if (n_fail or n_unresolved) else 0


if __name__ == "__main__":
    sys.exit(main())
