#!/usr/bin/env python3
"""
Recorded-value numeric regression for wfes_switching and wfes_sequential.

Why this file exists
--------------------
Every other tool in the suite had a recorded-value regression by the end of the
2026-08 integrity audit; these two did not (CX2 review, M8). Their suites were
all behavioural -- refuse-don't-substitute, JSON parses, probabilities in [0,1],
CSV has a header. Those checks are strong against a tool that publishes garbage
and completely silent about a tool that publishes a plausible WRONG number. A
refactor that moved T_fix by 3% would have passed every check in
test_degenerate_switching_sequential.py.

This file closes that gap: twelve healthy models, six per tool, with every
published field pinned to a recorded value at 1e-11 relative.

The independent anchor -- read this before touching a recorded value
--------------------------------------------------------------------
A recorded value is only as trustworthy as whatever established it. Recording
what the binary printed and then asserting the binary still prints it is a
tautology: it detects CHANGE, but it certifies nothing about CORRECTNESS, and
if the value was wrong when recorded the suite locks the error in and defends
it against every future fix.

So the values here are not self-certified. wfes_switching restricted to ONE
model with a 1x1 switching matrix (-R 1 -P 1) is mathematically the plain
Wright-Fisher absorbing chain -- which is what wfes_single computes, through a
completely separate code path (WF::Single, not WF::Switching, with its own
matrix assembly and its own results struct). Two independent implementations of
the same quantity must agree. `test_cross_tool_anchor` asserts exactly that,
LIVE, on every run:

    wfes_switching --absorption -N 50 -s 0.01 -h 0.5 -u 1e-8 -v 1e-8 \\
                   -R 1 -P 1 -c 1e-10
    wfes_single    --absorption -N 50 -s 0.01 -h 0.5 -u 1e-8 -v 1e-8 -c 1e-10

    wfes_switching --fixation   -N 50 -s 0.01 -h 0.5 -u 1e-8 -v 1e-8 -R 1 -P 1
    wfes_single    --fixation   -N 50 -s 0.01 -h 0.5 -u 1e-8 -v 1e-8 -p 0

P_ext, P_fix, T_ext, T_fix (absorption) and T_fix, rate (fixation) must agree to
1e-9 relative. At recording time they agreed EXACTLY -- every one of the six
comparisons was bit-identical, relative difference 0.0 -- so the 1e-9 the brief
specifies is not a tolerance being leaned on, it is nine orders of headroom.

The anchor runs FIRST and gates the rest. If it fails, the recorded-value
section does not run at all: values whose independent basis has just been
invalidated must not be reported as passing. That is deliberate, and it mirrors
the rule the recording followed -- no value was written into this file until
the anchor had passed.

wfes_sequential has no exact single-tool reduction (its model carries a third
absorbing outcome, timeout, with per-epoch rate 1/e), so it gets a different
independent check: as e -> infinity the timeout mass vanishes and the one-epoch
model must converge to wfes_single's answer, at a rate of O(1/e). Both the
LIMIT and the RATE are asserted (`test_sequential_converges_to_single`), which
is a stronger statement than either alone -- a constant offset would pass a
loose limit check and fail the rate check, and vice versa. Measured at
recording time: relative error in P_ext of 8.50e-4, 8.53e-5, 8.53e-6 at
e = 1e4, 1e5, 1e6 -- a clean factor of 10 per decade.

Provenance of the recorded values
---------------------------------
    Recorded on:   2026-08-21
    Recorded from: commit 28cd2e4a7ae151a70ce24e16636f99fec8bf7438
                   (branch integrity-fixes), built Release
                   (-O3 -DNDEBUG) into wfes-cli/build-c6 by
                   cmake -S wfes-cli -B wfes-cli/build-c6 \\
                         -DCMAKE_BUILD_TYPE=Release
    Platform:      macOS/arm64, Homebrew LLVM clang 21.1.8,
                   platform-default solver backend (Accelerate/UMFPACK)

    INJECTION RENORMALIZATION: these values are POST-correction. Commit
    fe35e720cb5323f9069fed08028249d6d4de3681 ("Stop renormalizing the
    injection weights by a cancelled subtraction") changed every quantity
    integrated over the mutational injection distribution -- which is most of
    the table below, since these cases integrate over starting copy number via
    -c. Commit 28cd2e4 then took the cancelled factor back out of the recorded
    references elsewhere in this directory. Values recorded before fe35e72 are
    NOT comparable with these, and a bulk mismatch here against an older
    binary is that change, not a regression. Check the commit before
    concluding anything.

    Independently anchored: yes, at recording time and on every run since --
    see the section above. The 1-model cases (sw_abs_1model, sw_fix_1model)
    are the anchored ones; the multi-model cases extend the same code path to
    2 and 3 models, where no single-tool equivalent exists.

Tolerance
---------
1e-11 relative, against the PLATFORM-DEFAULT solver backend, which is the only
backend this suite invokes (no case passes -l). That number is measured, not
guessed:

  * repeated runs of the same binary are BIT-identical -- three runs per case,
    exact equality of the parsed JSON -- so run-to-run noise is zero and any
    nonzero deviation is a real change;
  * SuiteSparse reproduces all 186 recorded field values bit-for-bit
    (relative difference exactly 0.0);
  * ParU reproduces 184 of the 186 bit-for-bit. The two exceptions are
    sw_fix_2model's T_fix and its reciprocal `rate`, which differ by 2.6e-11 --
    just over this tolerance.

That last point is stated rather than smoothed over, because an earlier draft
of this block claimed a 5.5e-15 cross-backend spread on the strength of two
cases and was wrong about the table as a whole. The ParU deviation is not a
disagreement about the answer: T_fix there is ~5.45e7 (54463721.4784434 under
the default backend, 54463721.4770448 under ParU), a difference of 0.0014
absolute, i.e. agreement to ~11 significant figures on a large sojourn-time
sum where a different LU pivot order accumulates rounding differently. It is
expected behaviour for the biggest number in the table, and it is why
`--library ParU` is OUT OF SCOPE here: re-running these cases under ParU and
comparing against this table will report two failures, correctly, because the
table records the default backend.

Within that scope 1e-11 sits far above zero measured noise and ~5 orders below
the smallest physically interesting change, so a regression that moves a value
by 1e-10 is caught while nothing else is.

What is NOT claimed
-------------------
That these numbers are correct to 1e-11 in an absolute sense. What is
established is (a) two independent implementations agree on the anchored cases
to machine precision, (b) the sequential model converges to that anchor at the
theoretically predicted rate, and (c) nothing has moved since the recording.
Agreement between two implementations is not proof that both are right; it is
much stronger than either alone, and it is what is available without an
external reference implementation.

Usage
-----
    python3 baseline_tests/test_numeric_switching_sequential.py [--bin DIR]

--bin is a DIRECTORY holding wfes_switching, wfes_sequential and wfes_single
(default: wfes-cli/build-c6/bin). wfes_single is REQUIRED, not optional: it is
the anchor, and a run without it would report a pass it has not earned.
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

This suite asserts something stronger for its own cases: every case here is
HEALTHY, so stderr must be completely EMPTY. A healthy run that starts
emitting an advisory is a change worth seeing, and the -P vectors are given
pre-normalised (0.75,0.25 rather than 3,1) precisely so that no legitimate
advisory is expected.
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

import platform_probe

REPO = Path(__file__).resolve().parent.parent
DEFAULT_BIN_DIR = REPO / "wfes-cli" / "build-c6" / "bin"

# See "Tolerance" in the module docstring.
REL_TOL = 1e-11

# The tolerance actually in force for section 3, and a one-line explanation of
# why. Set in main() from platform_probe.cross_backend_rel_tol():
#
#   * on the backend the table was recorded against (SuiteSparse, macOS) this
#     is REL_TOL unchanged -- 1e-11, exactly as recorded, with no
#     cross-platform slack anywhere near the machine the numbers came from;
#
#   * on any OTHER backend it is platform_probe.CROSS_BACKEND_REL_TOL = 1e-9,
#     because the comparison has become one between two independent LU
#     implementations. Measured spread, twice, on the SAME two fields both
#     times: ParU vs SuiteSparse differs by 2.6e-11 (macOS, recorded in the
#     "Tolerance" block above), and MKL Pardiso vs SuiteSparse by 2.33e-10
#     (Linux, 2026-08-21: sw_fix_2model.T_fix recorded 54463721.4784434,
#     measured 54463721.49112928, and its reciprocal `rate` moves with it).
#     Every one of the other 184 recorded field values agreed to <= 1.6e-14.
#
#     T_fix there is the largest number in the table -- a sum of sojourn times
#     over the whole transient state space, where a different pivot order
#     accumulates rounding differently. 1e-9 is about 4x the largest spread
#     measured so far, which is thin; it is stated rather than rounded up,
#     because the right response to a third backend exceeding it is to measure
#     that backend, not to widen the tier again.
ACTIVE_REL_TOL = REL_TOL
ACTIVE_REL_TOL_WHY = f"{REL_TOL:.0e} (recording backend)"

# The anchor's own tolerance, per the C6 brief. Observed disagreement at
# recording time was exactly 0.0 for all six comparisons.
ANCHOR_REL_TOL = 1e-9

# Bare IEEE tokens that are not valid JSON numbers.
BAD_TOKEN = re.compile(r"(?<![\w.])-?(?:nan|inf(?:inity)?)(?![\w])", re.IGNORECASE)

failures: list[str] = []
checks_run = 0
BIN_DIR = DEFAULT_BIN_DIR


def check(label: str, ok: bool, detail: str = "") -> bool:
    global checks_run
    checks_run += 1
    if not ok:
        print(f"  FAIL  {label}" + (f"\n          {detail}" if detail else ""))
        failures.append(label)
    return ok


def run(tool: str, args: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run([str(BIN_DIR / tool), *args], capture_output=True,
                          timeout=600, **platform_probe.TEXT_IO)


def results(tool: str, args: list[str], label: str, want_stderr=None):
    """Parse a healthy run's results object, or None (having failed a check).

    `want_stderr="empty"` additionally asserts the run said nothing at all --
    see the module docstring's note on why every case here is expected silent.
    The assertion is made on THIS process's stderr rather than by re-running
    the tool: a second invocation would be a second measurement, and asserting
    a property of run A against the output of run B is exactly the kind of
    seam that makes a suite quietly stop meaning what it says.
    """
    proc = run(tool, args + ["--json"])
    if not check(f"{label}: exits 0", proc.returncode == 0,
                 f"exit {proc.returncode}; stderr: {proc.stderr.strip()[:300]}"):
        return None
    if want_stderr == "empty":
        check(f"{label}: healthy run writes nothing to stderr",
              proc.stderr.strip() == "", proc.stderr.strip()[:300])
    # stdout only -- see the stderr-scope convention in the module docstring.
    if not check(f"{label}: no bare nan/inf token on stdout",
                 BAD_TOKEN.search(proc.stdout) is None,
                 proc.stdout[:300]):
        return None
    try:
        return json.loads(proc.stdout)["results"]
    except (ValueError, KeyError) as exc:
        check(f"{label}: stdout parses as JSON with a results object", False,
              f"{exc}\n{proc.stdout[:300]}")
        return None


def rel(got: float, want: float) -> float:
    return abs(got - want) / max(abs(want), 1e-300)


# ---------------------------------------------------------------------------
# 1. The independent anchor. Runs first; gates section 3.
# ---------------------------------------------------------------------------

# (mode, switching args, matched wfes_single args, [(switching key, single key)])
ANCHOR_CASES = [
    ("absorption",
     ["--absorption", "-N", "50", "-s", "0.01", "-h", "0.5",
      "-u", "1e-8", "-v", "1e-8", "-R", "1", "-P", "1", "-c", "1e-10"],
     ["--absorption", "-N", "50", "-s", "0.01", "-h", "0.5",
      "-u", "1e-8", "-v", "1e-8", "-c", "1e-10"],
     [("P_ext", "P_ext"), ("P_fix", "P_fix"),
      ("T_ext", "T_ext"), ("T_fix", "T_fix")]),
    # wfes_single --fixation indexes -p by COUNT (mode-aware since 2026-08-17),
    # so -p 0 is the count-0 start: full substitution time with mutational
    # origination included, which is what the 1-model switching run computes.
    ("fixation",
     ["--fixation", "-N", "50", "-s", "0.01", "-h", "0.5",
      "-u", "1e-8", "-v", "1e-8", "-R", "1", "-P", "1"],
     ["--fixation", "-N", "50", "-s", "0.01", "-h", "0.5",
      "-u", "1e-8", "-v", "1e-8", "-p", "0"],
     [("T_fix", "T_fix"), ("rate", "rate")]),
]


def test_cross_tool_anchor() -> bool:
    """One-model wfes_switching must reproduce wfes_single exactly.

    This is the check that makes every recorded value below mean something.
    Returns True only if all comparisons pass.
    """
    print("[1] cross-tool anchor: 1-model wfes_switching == wfes_single")
    ok = True
    for mode, sw_args, si_args, fields in ANCHOR_CASES:
        sw = results("wfes_switching", sw_args, f"anchor {mode}: switching")
        si = results("wfes_single", si_args, f"anchor {mode}: single")
        if sw is None or si is None:
            ok = False
            continue
        for a, b in fields:
            if a not in sw or b not in si:
                ok &= check(f"anchor {mode}: both tools report {a}", False,
                            f"switching keys={sorted(sw)} single keys={sorted(si)}")
                continue
            d = rel(sw[a], si[b])
            ok &= check(
                f"anchor {mode}: {a} agrees with wfes_single ({d:.2e} rel)",
                d < ANCHOR_REL_TOL,
                f"switching={sw[a]!r} single={si[b]!r} rel={d:.3e} "
                f"(limit {ANCHOR_REL_TOL:.0e})")
    return ok


# ---------------------------------------------------------------------------
# 2. wfes_sequential's independent check: the e -> infinity limit AND its rate
# ---------------------------------------------------------------------------

def test_sequential_converges_to_single() -> None:
    """A one-epoch wfes_sequential must approach wfes_single as e -> infinity.

    wfes_sequential's model has a third absorbing outcome (timeout) entered at
    per-generation rate 1/e, so it does not reduce to wfes_single exactly at
    any finite e -- but the timeout mass is O(1/e), so the answer must converge
    to wfes_single's at first order.

    Asserting the LIMIT alone would accept a tool that converges to the wrong
    place slowly; asserting the RATE alone would accept one that converges at
    the right rate to the wrong value. Both are asserted.
    """
    print("[2] wfes_sequential -> wfes_single as e -> infinity")
    base = ["-N", "50", "-s", "0.01", "-h", "0.5", "-u", "1e-8", "-v", "1e-8",
            "-c", "1e-10"]
    si = results("wfes_single", ["--absorption"] + base, "limit: wfes_single")
    if si is None:
        return

    errs = {}
    for e in ("1e4", "1e5", "1e6"):
        seq = results("wfes_sequential", base + ["-e", e], f"limit: sequential e={e}")
        if seq is None:
            return
        # Sanity: the three outcomes are exhaustive.
        total = seq["P_ext"] + seq["P_fix"] + seq["P_tmo"]
        check(f"limit e={e}: P_ext + P_fix + P_tmo == 1",
              abs(total - 1.0) < 1e-9, f"sum={total!r}")
        errs[e] = rel(seq["P_ext"], si["P_ext"])
        print(f"        e={e:<5} P_tmo={seq['P_tmo']:.6e} "
              f"rel err in P_ext vs wfes_single = {errs[e]:.4e}")

    # The limit: by e = 1e6 the answer must be within 1e-5 of wfes_single's.
    check("limit: e=1e6 agrees with wfes_single to 1e-5",
          errs["1e6"] < 1e-5, f"rel={errs['1e6']:.3e}")
    # The rate: first order means a factor of ~10 improvement per decade.
    for lo, hi in (("1e4", "1e5"), ("1e5", "1e6")):
        ratio = errs[hi] / errs[lo] if errs[lo] else float("inf")
        check(f"rate: error falls ~10x from e={lo} to e={hi} "
              f"(observed {1 / ratio:.2f}x)",
              0.08 < ratio < 0.125,
              f"errs[{lo}]={errs[lo]:.4e} errs[{hi}]={errs[hi]:.4e} "
              f"ratio={ratio:.4f}, want 0.08..0.125 (first order)")


# ---------------------------------------------------------------------------
# 3. The recorded values. See the provenance block in the module docstring.
# ---------------------------------------------------------------------------

# (case name, tool, args, {field: recorded value})
RECORDED = [
    ("sw_abs_1model", "wfes_switching",
     ["--absorption", "-N", "50", "-s", "0.01", "-h", "0.5", "-u",
      "1e-8", "-v", "1e-8", "-R", "1", "-P", "1", "-c", "1e-10"],
     {
         "P_ext": 0.9842829629701882,
         "P_fix": 0.0157170370296503,
         "T_ext": 8.532296426724612,
         "T_fix": 194.1014143609234,
         "P_cond_ext": [0.9842829629701882],
         "P_cond_fix": [0.0157170370296503],
         "T_uncond": [11.448893068893847],
         "T_cond_ext": [8.532296426724608],
         "T_cond_fix": [194.1014143609234],
     }),
    ("sw_abs_2model", "wfes_switching",
     ["--absorption", "-N", "50,100", "-R", "0.99,0.01;0.02,0.98", "-s",
      "0.01,0.005", "-h", "0.5,0.5", "-u", "1e-8,1e-8", "-v",
      "1e-8,1e-8", "-P", "0.75,0.25", "-c", "1e-10"],
     {
         "P_ext": 0.9862406462323242,
         "P_fix": 0.013759353767390469,
         "T_ext": 9.08876841453391,
         "T_fix": 234.38712475843312,
         "P_cond_ext": [0.7345039158641798, 0.2517367303681443],
         "P_cond_fix": [0.011087065169452912, 0.002672288597937556],
         "T_uncond": [8.251771414125292, 3.905434758750345],
         "T_cond_ext": [6.191959977195497, 2.8968084373384118],
         "T_cond_fix": [154.4043004697965, 79.98282428863664],
     }),
    ("sw_abs_3model", "wfes_switching",
     ["--absorption", "-N", "30,60,90", "-R",
      "0.98,0.01,0.01;0.01,0.98,0.01;0.01,0.01,0.98", "-s",
      "0.02,0,-0.01", "-h", "0.5,0.5,0.5", "-u", "1e-8,1e-8,1e-8", "-v",
      "1e-8,1e-8,1e-8", "-c", "1e-10"],
     {
         "P_ext": 0.9878918126460949,
         "P_fix": 0.012108187353630872,
         "T_ext": 8.779614874566471,
         "T_fix": 188.75455780465762,
         "P_cond_ext": [0.334020799474579, 0.32876273974779324, 0.32510827342372284],
         "P_cond_fix": [0.007452236810659672, 0.002972300881594534, 0.0016836496613766689],
         "T_uncond": [3.3411441564316195, 3.66574401162468, 3.8305145964309926],
         "T_cond_ext": [2.5477335719114502, 2.992588541378694, 3.23929276127633],
         "T_cond_fix": [64.49922639272937, 64.50774110057446, 59.74759031135381],
     }),
    ("sw_abs_neutral", "wfes_switching",
     ["--absorption", "-N", "100,100", "-R", "0.9,0.1;0.1,0.9", "-s",
      "0,0", "-h", "0.5,0.5", "-u", "1e-6,1e-6", "-v", "1e-6,1e-6", "-c",
      "1e-8"],
     {
         "P_ext": 0.9949915185557828,
         "P_fix": 0.005008474877534129,
         "T_ext": 10.013526070180767,
         "T_fix": 396.61584416445646,
         "P_cond_ext": [0.4974957592778914, 0.4974957592778914],
         "P_cond_fix": [0.0025042374387670625, 0.002504237438767067],
         "T_uncond": [5.974904880509094, 5.974904880509093],
         "T_cond_ext": [5.0067630350903825, 5.006763035090383],
         "T_cond_fix": [198.30792208222823, 198.3079220822282],
     }),
    ("sw_fix_1model", "wfes_switching",
     ["--fixation", "-N", "50", "-s", "0.01", "-h", "0.5", "-u", "1e-8",
      "-v", "1e-8", "-R", "1", "-P", "1"],
     {
         "T_fix": 63625983.90964555,
         "rate": 1.571684928943633e-08,
     }),
    ("sw_fix_2model", "wfes_switching",
     ["--fixation", "-N", "40,80", "-R", "0.95,0.05;0.05,0.95", "-s",
      "0.01,0.02", "-h", "0.5,0.25", "-u", "1e-8,1e-8", "-v",
      "1e-8,1e-8", "-P", "0.75,0.25"],
     {
         "T_fix": 54463721.4784434,
         "rate": 1.8360845951296173e-08,
     }),
    ("seq_2epoch", "wfes_sequential",
     ["-N", "50,100", "-e", "1000,2000", "-s", "0.01,0.005", "-h",
      "0.5,0.5", "-u", "1e-8,1e-8", "-v", "1e-8,1e-8", "-P", "0.75,0.25",
      "-c", "1e-10"],
     {
         "P_ext": 0.984827285728594,
         "P_fix": 0.013182705052813883,
         "P_tmo": 0.001990009218307143,
         "T_ext": 8.88784234976969,
         "T_ext_std": 29.338370168370925,
         "T_fix": 250.510195536347,
         "T_fix_std": 150.4673286288107,
         "T_tmo": 218.6795827017957,
         "T_tmo_std": 190.939058829601,
         "P_cond_ext": [0.7321560073318595, 0.2526712783967345],
         "P_cond_fix": [0.009757749390151121, 0.0034249556626627623],
         "T_uncond": [8.086243277868263, 3.9800184366142877],
         "T_cond_ext": [6.137899354744761, 2.74994299502493],
         "T_cond_fix": [130.27506758842264, 120.23512794792433],
         "T_cond_tmo": [64.24970592887793, 154.4298767729178],
     }),
    ("seq_3epoch", "wfes_sequential",
     ["-N", "30,60,90", "-e", "500,500,500", "-s", "0.02,0,-0.01", "-h",
      "0.5,0.5,0.5", "-u", "1e-8,1e-8,1e-8", "-v", "1e-8,1e-8,1e-8",
      "-c", "1e-10"],
     {
         "P_ext": 0.9729424176737856,
         "P_fix": 0.02645524024606661,
         "P_tmo": 0.0006023420800907879,
         "T_ext": 8.140725376701509,
         "T_ext_std": 23.8563113277826,
         "T_fix": 122.49333750645172,
         "T_fix_std": 78.3412742551687,
         "T_tmo": 276.8982017745622,
         "T_tmo_std": 168.27464697423196,
         "P_cond_ext": [0.9578794967207415, 0.013641120070619602, 0.0014218008824245954],
         "P_cond_fix": [0.022607600163426503, 0.003331358069174293, 0.0005162820134658117],
         "T_uncond": [9.756451557887546, 1.2702124879905985, 0.3011710400453943],
         "T_cond_ext": [7.199667026277359, 0.7737501921087581, 0.1673081583153933],
         "T_cond_fix": [102.73460595393584, 17.3459234414589, 2.412808111056968],
         "T_cond_tmo": [55.983933417469174, 97.1334107806662, 123.78085757642687],
     }),
    ("seq_starting_copies", "wfes_sequential",
     ["-N", "50,100", "-e", "1000,2000", "-s", "0.01,0.005", "-h",
      "0.5,0.5", "-u", "1e-8,1e-8", "-v", "1e-8,1e-8",
      "--starting-copies", "3"],
     {
         "P_ext": 0.9524449189290142,
         "P_fix": 0.045770261344781994,
         "P_tmo": 0.0017848197262041472,
         "T_ext": 20.936936666832697,
         "T_ext_std": 45.70298938410999,
         "T_fix": 208.10887125499335,
         "T_fix_std": 132.80804205706005,
         "T_tmo": 259.7225777655119,
         "T_tmo_std": 200.6937382909021,
         "P_cond_ext": [0.9349169611515611, 0.017527957777453057],
         "P_cond_fix": [0.038722643948938804, 0.007047617395843189],
         "T_uncond": [26.360394899500132, 3.5696394524082917],
         "T_cond_ext": [19.249944564593374, 1.6869921022393215],
         "T_cond_fix": [171.97511387102907, 36.13375738396429],
         "T_cond_tmo": [86.58415208185214, 173.13842568365965],
     }),
    ("seq_neutral", "wfes_sequential",
     ["-N", "100,100", "-e", "5000,5000", "-s", "0,0", "-h", "0.5,0.5",
      "-u", "1e-6,1e-6", "-v", "1e-6,1e-6", "-c", "1e-8"],
     {
         "P_ext": 0.9949628116283901,
         "P_fix": 0.00498981063913685,
         "P_tmo": 4.737116579006297e-05,
         "T_ext": 10.000008053649749,
         "T_ext_std": 37.92304243308859,
         "T_fix": 395.6900182333307,
         "T_fix_std": 213.76488581675682,
         "T_tmo": 358.4800614952223,
         "T_tmo_std": 275.57525967404524,
         "P_cond_ext": [0.9930284863187385, 0.0019343253096516656],
         "P_cond_fix": [0.004630671927717705, 0.0003591387114191446],
         "T_uncond": [11.70417593430433, 0.236855828950315],
         "T_cond_ext": [9.860301350956917, 0.13970670269283378],
         "T_cond_fix": [377.78109326390717, 17.90892496942344],
         "T_cond_tmo": [179.2400307476112, 179.24003074761114],
     }),
    ("seq_dominance", "wfes_sequential",
     ["-N", "40,80", "-e", "800,1600", "-s", "0.015,0.005", "-h",
      "0.1,0.9", "-u", "1e-9,1e-9", "-v", "1e-9,1e-9", "-c", "1e-10"],
     {
         "P_ext": 0.9814530742711234,
         "P_fix": 0.017820303462571418,
         "P_tmo": 0.0007266222663045924,
         "T_ext": 7.9781304367456976,
         "T_ext_std": 23.305287392326687,
         "T_fix": 160.7417043589268,
         "T_fix_std": 104.31105782223642,
         "T_tmo": 208.1476296768499,
         "T_tmo_std": 166.58650224508287,
         "P_cond_ext": [0.9726402796385293, 0.008812794632594117],
         "P_cond_fix": [0.015255625778743757, 0.00256467768382766],
         "T_uncond": [9.683275666181089, 1.1625956260873485],
         "T_cond_ext": [7.420026961637976, 0.5581034751077221],
         "T_cond_fix": [132.15494300021672, 28.586761358710053],
         "T_cond_tmo": [63.067444638483586, 145.0801850383663],
     }),
    ("seq_1epoch_long", "wfes_sequential",
     ["-N", "50", "-e", "1e6", "-s", "0.01", "-h", "0.5", "-u", "1e-8",
      "-v", "1e-8", "-c", "1e-10"],
     {
         "P_ext": 0.9842745651250802,
         "P_fix": 0.01571398671133858,
         "P_tmo": 1.1448163419475012e-05,
         "T_ext": 8.531651870625291,
         "T_ext_std": 25.386570927903925,
         "T_fix": 194.09043474324298,
         "T_fix_std": 104.77907600117065,
         "T_tmo": 64.72901206272164,
         "T_tmo_std": 89.2799699195071,
         "P_cond_ext": [0.9842745651250802],
         "P_cond_fix": [0.01571398671133858],
         "T_uncond": [11.448163419475005],
         "T_cond_ext": [8.531651870625291],
         "T_cond_fix": [194.09043474324295],
         "T_cond_tmo": [64.72901206272165],
     }),
]


def test_recorded_values() -> None:
    print(f"[3] recorded values ({len(RECORDED)} cases, relative tolerance "
          f"{ACTIVE_REL_TOL_WHY})")
    for name, tool, args, expected in RECORDED:
        res = results(tool, args, name, want_stderr="empty")
        if res is None:
            continue
        # Every recorded field must still be published...
        missing = [k for k in expected if k not in res]
        if not check(f"{name}: publishes all {len(expected)} recorded fields",
                     not missing, f"missing: {missing}"):
            continue
        # ...and no NEW field may appear unrecorded, or the table silently
        # stops covering part of the output.
        extra = [k for k in res if k not in expected]
        check(f"{name}: publishes no field absent from the recording",
              not extra,
              f"unrecorded fields: {extra} -- re-record deliberately, do not "
              f"widen the table to match whatever the binary now prints")
        worst = 0.0
        worst_field = ""
        for key, want in expected.items():
            got = res[key]
            if isinstance(want, list):
                if not check(f"{name}.{key}: {len(want)} entries",
                             isinstance(got, list) and len(got) == len(want),
                             f"got {got!r}"):
                    continue
                pairs = list(zip(got, want))
            else:
                pairs = [(got, want)]
            for i, (g, w) in enumerate(pairs):
                d = rel(float(g), float(w))
                if d > worst:
                    worst, worst_field = d, (f"{key}[{i}]"
                                             if isinstance(want, list) else key)
                check(f"{name}.{key}"
                      + (f"[{i}]" if isinstance(want, list) else ""),
                      d <= ACTIVE_REL_TOL,
                      f"recorded {w!r}, got {g!r}, rel {d:.3e} > "
                      f"{ACTIVE_REL_TOL:.0e}")
        print(f"        {name:<22} worst {worst:.2e} rel"
              + (f"  ({worst_field})" if worst else ""))


def main() -> int:
    global BIN_DIR
    ap = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--bin", type=Path, default=DEFAULT_BIN_DIR,
                    help=f"directory holding wfes_switching, wfes_sequential "
                         f"and wfes_single (default: {DEFAULT_BIN_DIR})")
    opts = ap.parse_args()
    BIN_DIR = opts.bin

    # wfes_single is required, not optional: without it there is no anchor,
    # and the recorded values would be self-certifying.
    missing = [t for t in ("wfes_switching", "wfes_sequential", "wfes_single")
               if not (BIN_DIR / t).is_file()]
    if missing:
        print(f"error: missing binaries in {BIN_DIR}: {', '.join(missing)}. "
              f"wfes_single is the cross-tool anchor and is required.",
              file=sys.stderr)
        return 2

    global ACTIVE_REL_TOL, ACTIVE_REL_TOL_WHY
    ACTIVE_REL_TOL, ACTIVE_REL_TOL_WHY = platform_probe.cross_backend_rel_tol(
        BIN_DIR, REL_TOL)

    print(f"binaries: {BIN_DIR}")
    print(platform_probe.platform_banner(BIN_DIR))
    print(f"recorded-value tolerance in force: {ACTIVE_REL_TOL_WHY}")
    anchored = test_cross_tool_anchor()
    test_sequential_converges_to_single()
    if anchored:
        test_recorded_values()
    else:
        print("\n[3] SKIPPED: the cross-tool anchor failed, so the recorded "
              "values have no independent basis on this build. Reporting them "
              "as passing would be reporting a result this run did not earn. "
              "Fix the anchor first.")
        check("recorded values ran (anchor held)", False,
              "section 3 was skipped because section 1 failed")

    n_fail = len(failures)
    print(f"\n{'=' * 78}")
    print(platform_probe.Skips().summary_line())
    print(f"PASS {checks_run - n_fail}   FAIL {n_fail}")
    if failures:
        print("failing checks:")
        for f in failures:
            print(f"  - {f}")
    return 1 if n_fail else 0


if __name__ == "__main__":
    sys.exit(main())
