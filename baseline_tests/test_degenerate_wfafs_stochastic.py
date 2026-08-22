#!/usr/bin/env python3
"""
Integrity checks for wfafs_stochastic's input guards.

The defects
-----------
1. NO PER-MODEL VECTOR LENGTH CHECK. wfafs_stochastic was the only multi-model
   tool in the suite without one -- wfes_switching, wfes_sequential,
   wfafs_deterministic and time_dist_sgv all refuse a short vector by name. The
   shared parser knows this and explicitly defers ("Length disagreements are
   left to the main's require_len"), but for this tool that main-side check did
   not exist, so nothing looked at all. The validated reproducer:

       wfafs_stochastic -N 10,10 -G 10,10 -f 1,1 -u 1e-9 --output-Q q.mtx --json

   Two models, one mutation rate. Every use of the parsed vectors below is an
   Eigen coefficient-wise op or an indexed read against n_models, so a short
   vector is an out-of-bounds read:

     * an assert-enabled build aborts with a raw Eigen assertion (exit 134,
       "aLhs.rows() == aRhs.rows()"), naming no argument;
     * an NDEBUG build has that assert compiled out, reads garbage rates,
       writes a nan-bearing --output-Q file, and then fails in the solver with
       "matrix is singular" -- a diagnostic pointing at the wrong thing
       entirely, with a corrupt artifact already on disk.

   A LONG vector was worse than either: three rates for two models exited 0
   with plausible output and the third value silently discarded. Equality, not
   ">=", is therefore the test.

   -f additionally divides N and G, so a zero or non-finite factor produced inf
   and then undefined behaviour casting inf to llong (observed: exit 134).

2. NO PSI-BOUNDARY GUARD, AT EITHER OF TWO SITES. This tool builds
   NON_ABSORBING matrices, which keep the 0-copy and 2N-copy rows that the
   absorbing models drop. wfes-lib builds each row in log space
   (wrightFisher.cpp binom_row), which is defined only for a success
   probability strictly inside (0, 1); psi_diploid returns exactly v for row 0
   and exactly 1 - u for row 2N, so those rows go nan when v == 0, or when
   1 - u rounds to 1.0 (any u below about 1.1e-16 -- not just u == 0). The nan
   then reaches every state, because the sparse product multiplies the poisoned
   row by a coefficient of 0 and 0 * nan = nan.

   Two sites, on two DIFFERENT sets of rates:

     (A) WF::Switching is handed the -f-RESCALED rates (u * f, v * f). The
         predicate has to be on those, not on what the user typed: `-f 0.5
         -u 1e-16` is degenerate (u*f = 5e-17) and a typed-value check MISSES
         it, while `-f 100 -u 1e-17` gives u*f = 1e-15 and a typed-value check
         would FALSELY REFUSE it.

     (B) the up-projection at the end builds a SECOND NON_ABSORBING matrix,
         WF::Single(..., s_unsc, h, u_unsc, v_unsc) -- with the UNSCALED rates,
         because it maps onto the real population. Its boundary rows are
         degenerate independently of the rescaled ones, and this site is easy
         to miss: `-N 1000 -G 10 -f 100 -u 1e-17` writes a completely CLEAN Q
         (u*f = 1e-15) and only then produces nan in the spectrum.

   Placement matters as much as the condition: --output-Q writes W.Q straight
   after construction and BEFORE the solve, so a check any later still leaves a
   nan-bearing file on disk. The pre-fix binary did exactly that -- 16 nan
   entries in the --output-Q file, then "matrix is singular" at exit 1.

3. NO RANGE CHECK ON THE STARTING COPY COUNT (-p). The count was used as a
   direct subscript of a dvec of length 2N+1
   (`initial[options.initial_count] = 1.0`) with no bound anywhere: the parser
   stored whatever was typed, and main indexed with it. Every other tool that
   takes a starting count refuses an out-of-range one by name -- wfes_single
   in the shared parser, wfafs_deterministic in its own main -- and this was
   the one that did not.

   Measured on the pre-fix binary at -N 10 -G 100 -f 1 (state space 0..20):

       -p 20   healthy
       -p 21   exit 0, EMPTY stderr, all-zero spectrum
       -p 100  exit 0, EMPTY stderr, all-zero spectrum

   and the two refusals were byte-identical to each other
   (md5 67a8cdc09afc78de4a47a3996ec264b5), so the published spectrum did not
   depend on what the user asked for and nothing in the run said so. Under
   NDEBUG, which is how these binaries ship, the 1.0 is written outside the
   vector.

   Two further faces of the same gap, both measured:

     * a SUPPLIED NEGATIVE collided with the "flag absent" sentinel. `-N 10
       -G 100 -f 1 --starting-copies=-5` exited 0 with output byte-identical
       (md5 479b597369902d13c162535f66aab3e3) to the equilibrium-start run
       that omits -p entirely: a request for a state that does not exist,
       answered with a different model's spectrum.

     * the bound is on the -f-RESCALED size, not on the typed N. This tool
       divides every N by its factor before building anything, so
       `-N 100 -f 10 -p 150` is inside the typed 2N = 200 and indexes 150 into
       a 21-entry vector (measured: exit 0, all-zero spectrum), while
       `-N 10 -f 0.5 -p 30` is outside the typed 2N = 20 and is a perfectly
       ordinary state of the model actually solved. A check against the typed
       value would both miss the first and falsely refuse the second, which is
       why the sentinel half of the check lives in the parser and the bound
       half lives in main beside the vector it protects.

   Valid counts here are 0..2N INCLUSIVE: this tool builds NON_ABSORBING,
   which keeps all 2N+1 rows, so the boundary counts are ordinary states --
   unlike the both-absorbing models, where wfes_single refuses -p 0.

What must happen instead
------------------------
Refuse, don't substitute. Each fault exits 1 (not by signal) with a diagnostic
naming the offending flag, prints no results in any format, and leaves NO
--output-Q file behind. Legitimate models are untouched, byte for byte.

Usage
-----
    python3 baseline_tests/test_degenerate_wfafs_stochastic.py [--bin DIR]
                                                               [--reference BIN]

--bin is a DIRECTORY holding wfafs_stochastic (default:
wfes-cli/build-cxstoch/bin). --reference is an optional second wfafs_stochastic
binary (default: the one inside an installed WFES3.app) whose healthy-run output
is compared byte for byte against the build under test; it is skipped if absent.
Exit status is 0 only if every check passes.

Note on the recorded md5s
-------------------------
LEGIT_CASES below locks the stdout of fifteen healthy models byte for byte, so
that a guard added to the degenerate paths cannot quietly move a healthy one
with it. The digests were originally recorded from a build of the PRE-FIX code
on macOS/arm64 with the platform-default solver backend. Seven of them
(2a401eaf..., cc34451c..., 8412ae9e..., 851ca08f..., c8162ef5..., 57115501...,
e46d55da...) were recorded independently during the investigation that found
these defects.

SEVEN OF THE FIFTEEN WERE RE-RECORDED IN TASK CX-PROJ (2026-08-21), on this
commit, from a Release build in wfes-cli/build-proj. They are the seven whose
model actually COMPRESSES in the down-projection, and they moved because that
step now SUMS the states in each output bin instead of averaging them:

    f = 2,2                       2a401eaf... -> 272ee5c8...
    f = 3,2                       cc34451c... -> 3b494d26...
    f = 4,2                       8412ae9e... -> 1fac2610...
    3 epochs, f = 10,10,10        c8162ef5... -> 99796d63...
    f = 25,25                     8d743300... -> 58930637...
    selection/dominance, f = 2,2  2a81fbb2... -> 846bf278...
    csv output, f = 2,2           57115501... -> d1bf3d1d...

The old values published a spectrum missing about (1 - 1/bin-count) of its
SEGREGATING mass -- 54% of it at f = 2,2, 90% at the 3-epoch f = 10,10,10 --
and the change was approved by the PI on exactly that basis, knowing that
default f != 1 outputs move. The rationale, the measurements and the mechanism
are in test_down_projection_conserves_mass below, which asserts the property
the new digests encode rather than merely locking them.

The other EIGHT are byte-identical across the change, and which eight is itself
the evidence that the change is the binning and nothing else:

  * six are f == 1 runs, which never enter the projection block at all;
  * one is the --no-project run, which takes the branch that skips the
    down-projection;
  * one is `-f 0.5`, which does enter it. That model EXPANDS (19 interior
    states into 39 bins), so no bin receives more than one state, and there
    the average and the sum are the same number. Its digest not moving is a
    direct check that only multi-state bins were ever affected.

Reference-binary comparison. Nine of the fifteen are byte-identical to the
shipped /Applications/WFES3.app binary; the reference mode of each case is the
fourth field of its tuple:

  * True -- assert byte-identical.
  * "cx-proj" -- the six JSON cases re-recorded above. The shipped binary was
    verified (task CX-proj) to still produce the pre-fix AVERAGED spectrum, so
    these are not skipped: the reference is asserted to diverge in exactly the
    intended way -- same two boundary classes to the bit, a total short of 1,
    while ours sums to 1. A divergence of any other shape fails.
  * False -- skipped, for a divergence that predates this work: the
    --no-project case, because the --no-project semantics fix (it now keeps
    the up-projected spectrum, as its help says) landed after that app was
    built; and the --csv case, because csv output moved from the stream
    default of 6 significant figures to round-trip precision. The csv case is
    ALSO a CX-proj case, but it has no --json to compare structurally, so it
    stays a plain skip.

Count the modes from the list itself, not from this paragraph: it said
"twelve"/"three"/"the two --no-project cases" through one review cycle while
the list held 13 True and 2 False.

A mismatch on any recorded md5 means either a regression in the healthy path or
an unrelated change to how this tool formats output; check which before
assuming the worst.

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

This suite's sweep is NONFINITE_RE over `proc.stdout`; `text()` appears
only in the DETAIL of a failed check. The healthy-model site swept both
streams until task C6 aligned it -- see the comment there for why.
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

import platform_probe

REPO = Path(__file__).resolve().parent.parent
DEFAULT_BIN_DIR = REPO / "wfes-cli" / "build-cxstoch" / "bin"
DEFAULT_REFERENCE = Path(
    "/Applications/WFES3.app/Contents/Resources/bin/wfafs_stochastic")

# The reference is the SHIPPED v3.0.0-beta.3 binary, which exists only inside
# the macOS .app bundle. Where it is absent, each comparison it would have made
# is named and counted rather than quietly not run -- that silence is what the
# first Linux run reported as thirteen CHECKS LOST.
NO_REFERENCE_REASON = ("shipped v3.0.0-beta.3 wfafs_stochastic not installed "
                       "(second-implementation byte comparison)")

SKIPS = platform_probe.Skips()

# Set in main() from the probe: True only on the platform AND backend the md5
# table was recorded against. See platform_probe's "Byte-identity locks".
DIGESTS_APPLY = True

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
# so ordinary words ("info") and exponents ("1e-09") do not match.
NONFINITE_RE = re.compile(
    r"(?<![A-Za-z0-9_.])-?(?:inf(?:inity)?|nan)(?![A-Za-z0-9_])", re.IGNORECASE)

# The exact INV-2 reproducer, kept verbatim and separately named because it is
# the invocation the whole length guard exists for.
INV2_REPRO = ["-N", "10,10", "-G", "10,10", "-f", "1,1", "-u", "1e-9"]

# ---------------------------------------------------------------------------
# Fault cases. Each entry: (label, argv, [substrings the diagnostic must
# contain]).  Every one of these is run with --output-Q, and every one must
# leave no file behind.
# ---------------------------------------------------------------------------

# Guard 1 -- one value per model. The six short-vector cases plus the long-
# vector case (silently discarded value) plus the -f domain case.
LENGTH_FAULTS = [
    ("-u short (1 value, 2 models)",
     ["-N", "10,10", "-G", "10,10", "-f", "1,1", "-u", "1e-9"],
     ["(-u)", "1 value(s)", "2 models"]),
    ("-v short (1 value, 2 models)",
     ["-N", "10,10", "-G", "10,10", "-f", "1,1", "-v", "1e-9"],
     ["(-v)", "1 value(s)", "2 models"]),
    ("-s short (1 value, 2 models)",
     ["-N", "10,10", "-G", "10,10", "-f", "1,1", "-s", "0.001"],
     ["(-s)", "1 value(s)", "2 models"]),
    ("-h short (1 value, 2 models)",
     ["-N", "10,10", "-G", "10,10", "-f", "1,1", "-h", "0.5"],
     ["(-h)", "1 value(s)", "2 models"]),
    ("-G short (1 value, 2 models)",
     ["-N", "10,10", "-G", "10", "-f", "1,1"],
     ["(-G)", "1 value(s)", "2 models"]),
    ("-f short (1 value, 2 models)",
     ["-N", "10,10", "-G", "10,10", "-f", "1"],
     ["(-f)", "1 value(s)", "2 models"]),
    # The dangerous one: pre-fix this exited 0 with plausible output and the
    # third rate silently thrown away.
    ("-u long (3 values, 2 models)",
     ["-N", "10,10", "-G", "10,10", "-f", "1,1", "-u", "1e-9,1e-9,1e-9"],
     ["(-u)", "3 value(s)", "2 models"]),
    ("-f 0 (N/f and G/f are inf)",
     ["-N", "100,100", "-G", "100,100", "-f", "0,0"],
     ["Scaling factor (-f)", "model 1", "positive"]),
]

# Guard 2 -- psi boundary rows. The first four are the switching matrix, on the
# -f-RESCALED rates; the last is the up-projection, on the UNSCALED ones.
PSI_FAULTS = [
    ("psi: -v 0 (row 0 probability is v)",
     ["-N", "10", "-G", "10", "-f", "1", "-v", "0"],
     ["(-v)", "0 copies", "strictly inside (0, 1)"]),
    ("psi: -u 0 (row 2N probability is 1-u)",
     ["-N", "10", "-G", "10", "-f", "1", "-u", "0"],
     ["(-u)", "20 copies", "strictly inside (0, 1)"]),
    ("psi: -u 1e-17 (1-u rounds to exactly 1)",
     ["-N", "10", "-G", "10", "-f", "1", "-u", "1e-17"],
     ["(-u)", "20 copies", "1.1e-16"]),
    # A check on the TYPED u would miss this one: u = 1e-16 looks representable,
    # but WF::Switching is handed u * f = 5e-17.
    ("psi: -f 0.5 -u 1e-16 (rescaled u*f = 5e-17)",
     ["-N", "10", "-G", "10", "-f", "0.5", "-u", "1e-16"],
     ["(-u)", "-f-rescaled", "strictly inside (0, 1)"]),
    # The second site. Q comes out completely clean here (u*f = 1e-15); it is
    # the up-projection's own matrix, built from the UNSCALED u = 1e-17, that
    # is degenerate. Pre-fix this reached the output stage before failing.
    ("psi: up-projection only (-N 1000 -f 100 -u 1e-17)",
     ["-N", "1000", "-G", "10", "-f", "100", "-u", "1e-17"],
     ["up-projection", "NOT -f-rescaled", "(-u)"]),
]

# Guard 3 -- the starting-copy count (-p) against the state space this tool
# actually builds. See the module docstring's defect 3. Every one of these
# exited 0 on the pre-fix binary.
STARTING_COPIES_FAULTS = [
    # The measured reproducer: one past the top of the state space.
    ("-p 21 (one past 2N = 20)",
     ["-N", "10", "-G", "100", "-f", "1", "-p", "21"],
     ["Starting copies (-p)", "between 0 and 2N = 20", "got 21"]),
    # Far outside. Pre-fix this was byte-identical to -p 21 (both all-zero),
    # so the published spectrum did not depend on what was asked for.
    ("-p 100 (far outside 0..20)",
     ["-N", "10", "-G", "100", "-f", "1", "-p", "100"],
     ["between 0 and 2N = 20", "got 100"]),
    # The sentinel collision: a supplied negative used to be stored verbatim
    # into the same field that means "no -p given", so the run answered with
    # the equilibrium start instead -- exit 0, byte-identical to omitting the
    # flag. Refused in the parser, which is why the wording differs.
    ("--starting-copies=-5 (collides with the no-flag sentinel)",
     ["-N", "10", "-G", "100", "-f", "1", "--starting-copies=-5"],
     ["Starting copies (-p/--starting-copies)", "got -5"]),
    # The case that decides WHERE the bound has to be checked: 150 is inside
    # the typed 2N = 200 and outside the -f-rescaled 2N = 20 the model is
    # actually solved on. A parser-side check against the typed value would
    # let this through.
    ("-N 100 -f 10 -p 150 (inside typed 2N, outside rescaled 2N)",
     ["-N", "100", "-G", "100", "-f", "10", "-p", "150"],
     ["between 0 and 2N = 20", "got 150", "-f-rescaled"]),
]

# The other half of the same contract: counts that ARE in range must still run.
# (label, argv, expected number of states)
#
# The bounds are INCLUSIVE at both ends -- this tool builds NON_ABSORBING, so
# counts 0 and 2N are ordinary states, unlike the both-absorbing models where
# wfes_single refuses -p 0. And -f 0.5 is the mirror image of the -N 100 -f 10
# fault above: 30 is OUTSIDE the typed 2N = 20 and inside the rescaled 2N = 40,
# so a check against the typed value would falsely refuse a valid model.
STARTING_COPIES_ACCEPTED = [
    ("-p 20 (the 2N boundary)",
     ["-N", "10", "-G", "100", "-f", "1", "-p", "20"], 21),
    ("-p 0 (the lower boundary; NON_ABSORBING keeps count 0)",
     ["-N", "10", "-G", "100", "-f", "1", "-p", "0"], 21),
    ("-N 10 -f 0.5 -p 30 (outside typed 2N, inside rescaled 2N = 40)",
     ["-N", "10", "-G", "100", "-f", "0.5", "-p", "30"], 41),
]

FAULTS = LENGTH_FAULTS + PSI_FAULTS + STARTING_COPIES_FAULTS

# ---------------------------------------------------------------------------
# Legitimate models: (label, argv, md5-of-stdout, reference-mode)
#
# reference-mode is True (byte-identical to the shipped binary), False (skip
# the comparison) or "cx-proj" (assert the intended divergence). See the
# module docstring's "Note on the recorded md5s".
# ---------------------------------------------------------------------------
LEGIT_CASES = [
    ("defaults, 1 model",
     ["-N", "100", "-G", "100", "-f", "1", "--json"],
     "851ca08fc2904ad3f1e424cf3cf6ace7", True),
    ("defaults, 2 models",
     ["-N", "10,10", "-G", "10,10", "-f", "1,1", "--json"],
     "721955ba8a014165d760bc3590d11e3e", True),
    # CX-proj re-record: was 2a401eaf33ea2e3b175d77940d3c0071 (averaged bins).
    # This is additionally the value locked by test_degenerate_wfafs_sweep.py,
    # which was re-recorded in the same commit.
    ("f = 2,2 (projection runs)",
     ["-N", "20,10", "-G", "10,5", "-f", "2,2", "--json"],
     "272ee5c8af127c7035fdcb76628f788b", "cx-proj"),
    # CX-proj re-record: was cc34451c483e2f97e5e72b163a2cdf58.
    ("f = 3,2 (unequal factors)",
     ["-N", "30,20", "-G", "20,10", "-f", "3,2", "--json"],
     "3b494d2621d2c695e24d0c31cabfbf8e", "cx-proj"),
    # CX-proj re-record: was 8412ae9ed556480bccdf46a096791e22.
    ("f = 4,2 (unequal factors)",
     ["-N", "200,100", "-G", "100,50", "-f", "4,2", "--json"],
     "1fac26102f1d52760e8c4b20949722f3", "cx-proj"),
    # CX-proj re-record: was c8162ef5cdf434de634197532fbd9c4d. The worst of the
    # measured cases -- 1999 interior states into 199 bins, so the averaged
    # spectrum kept a tenth of its segregating mass.
    ("3 epochs with projection",
     ["-N", "2000,200,1000", "-G", "400,40,200", "-f", "10,10,10", "--json"],
     "99796d63fadc5b152b52a33fec60349d", "cx-proj"),
    # NOT re-recorded, and deliberately kept in the list for that reason: this
    # model expands rather than compresses, so every bin takes at most one
    # state and averaging and summing coincide. See the module docstring.
    ("f = 0.5 (factor below 1)",
     ["-N", "10", "-G", "10", "-f", "0.5", "--json"],
     "8c8014d7c05d8cebaf62d4edfd2b9da9", True),
    # CX-proj re-record: was 8d7433000e81729092406593e53e4406.
    ("f = 25,25 on a large model",
     ["-N", "5000,500", "-G", "1000,100", "-f", "25,25", "--json"],
     "589306378bc0b3a16882b5e1884903a9", "cx-proj"),
    # The false-positive case the -f rescaling creates. u = 1e-17 as TYPED
    # would make 1 - u round to 1, but WF::Switching is handed u * f = 1e-15
    # for model 1 and the last factor is 1, so the up-projection never runs.
    # A guard written against the typed value instead of the rescaled one
    # would wrongly refuse this.
    ("typed u = 1e-17 but rescaled u*f = 1e-15 (must NOT be refused)",
     ["-N", "1000,100", "-G", "10,10", "-f", "100,1", "-u", "1e-17,1e-9",
      "--json"],
     "dcd8b35fb1644e43eb03344355cf57c7", True),
    ("v = 1e-300 (tiny but positive)",
     ["-N", "10", "-G", "10", "-f", "1", "-v", "1e-300", "--json"],
     "b1d8794bbe31dad98f9f21317f27c369", True),
    ("u = 1.2e-16 (just representable in 1-u)",
     ["-N", "10", "-G", "10", "-f", "1", "-u", "1.2e-16", "--json"],
     "8a76a69958f72d83fe072e1388185789", True),
    ("GUI default shape",
     ["-N", "100", "-G", "100", "-f", "1", "-s", "0", "-h", "0.5",
      "-u", "2.5e-6", "-v", "2.5e-6", "--json"],
     "d67ab18d0643f6a6a4e8badca203d377", True),
    # CX-proj re-record: was 2a81fbb2ec474eec8b27378b63996c6d.
    ("selection and dominance, 2 models",
     ["-N", "200,100", "-G", "100,50", "-f", "2,2", "-s", "0.01,0.01",
      "-h", "0.5,0.5", "--json"],
     "846bf27800ce7271c64c6d1398555cd1", "cx-proj"),
    # csv and --no-project: see the module docstring for why these two do not
    # match the shipped binary. CX-proj re-record: was
    # 571155019e595eda5cc394b8bc888754 -- the same f = 2,2 model as above, so
    # its numbers moved for the CX-proj reason too, but its reference mode
    # stays False because csv precision already diverged and there is no
    # --json here to compare structurally.
    ("csv output, f = 2,2",
     ["-N", "20,10", "-G", "10,5", "-f", "2,2", "--csv"],
     "d1bf3d1d9e9ffc264d83e8e899b669d8", False),
    ("--no-project, f = 2,2",
     ["-N", "20,10", "-G", "10,5", "-f", "2,2", "--no-project"],
     "e46d55da4752add66eb229dd4d6b8768", False),
]

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
    """Run the tool, capturing raw bytes so stdout can be hashed exactly."""
    return subprocess.run([str(binary), *args], capture_output=True)


def text(proc: subprocess.CompletedProcess) -> str:
    return (proc.stdout + proc.stderr).decode("utf-8", "replace")


def parse_json(blob: str):
    start = blob.find("{")
    if start < 0:
        return None
    try:
        return json.loads(blob[start:])
    except json.JSONDecodeError:
        return None


def assert_refused(binary: Path, tmp: Path, tag: str, label: str,
                   args: list[str], wanted: list[str]) -> None:
    """A fault must exit 1 cleanly, name itself, print nothing, write nothing."""
    path = tmp / f"Q_{tag}.mtx"
    proc = run(binary, args + ["--output-Q", str(path), "--json"])
    err = proc.stderr.decode("utf-8", "replace")
    stdout = proc.stdout.decode("utf-8", "replace")

    # A negative returncode is death by signal -- the pre-fix behaviour for
    # every length fault was SIGABRT from a raw Eigen assertion (exit 134),
    # which is nonzero but is not a refusal.
    check(f"[{label}] exits 1 without crashing",
          proc.returncode == 1,
          f"returncode {proc.returncode} "
          f"({'killed by signal' if proc.returncode < 0 else 'unexpected'}); "
          f"output: {text(proc).strip()[:300]}")
    for want in wanted:
        check(f"[{label}] diagnostic names {want!r}", want in err,
              f"stderr: {err.strip()[:400]}")
    if path.exists():
        body = path.read_text("utf-8", "replace")
        nan_lines = len(NONFINITE_RE.findall(body))
        check(f"[{label}] --output-Q file was not written", False,
              f"{path.name} exists; {nan_lines} of its entries are nan/inf")
        check(f"[{label}] --output-Q file holds no nan/inf", nan_lines == 0,
              f"{nan_lines} nan/inf entries in {path.name}")
    else:
        check(f"[{label}] --output-Q file was not written", True)
        check(f"[{label}] --output-Q file holds no nan/inf", True)
    check(f"[{label}] stderr carries a diagnostic", err.strip() != "",
          "stderr was empty")
    check(f"[{label}] no results on stdout", "distribution" not in stdout,
          f"stdout: {stdout.strip()[:300]}")
    # stdout only, deliberately: the guards' own diagnostics explain the
    # mechanism in words ("yields nan for that row"), and that sentence is the
    # point of the refusal. What must never appear is a nan PUBLISHED as a
    # result, which is what stdout carries. Same split as
    # test_degenerate_wfafs_deterministic.py.
    hits = NONFINITE_RE.findall(stdout)
    check(f"[{label}] no inf/nan token on stdout", not hits,
          f"found {sorted(set(hits))} in: {stdout.strip()[:300]}")


# --------------------------------------------------------------------------
# Tests
# --------------------------------------------------------------------------

def test_inv2_repro(binary: Path, tmp: Path) -> None:
    """The exact invocation from the investigation, kept as its own test."""
    print("wfafs_stochastic: the INV-2 reproducer "
          "(-N 10,10 -G 10,10 -f 1,1 -u 1e-9)")
    path = tmp / "inv2_repro_Q.mtx"
    proc = run(binary, INV2_REPRO + ["--output-Q", str(path), "--json"])
    err = proc.stderr.decode("utf-8", "replace")
    check("exits 1 without crashing", proc.returncode == 1,
          f"returncode {proc.returncode}: {text(proc).strip()[:400]}")
    check("diagnostic names the length mismatch",
          "(-u)" in err and "1 value(s)" in err and "2 models" in err,
          f"stderr: {err.strip()[:400]}")
    check("diagnostic says what to supply",
          "one comma-separated value per model" in err,
          f"stderr: {err.strip()[:400]}")
    check("--output-Q file was not written", not path.exists(),
          f"{path} was created despite the run being refused")
    check("no 'singular' misdiagnosis", "singular" not in err.lower(),
          f"stderr: {err.strip()[:400]}")


def test_length_guard(binary: Path, tmp: Path) -> None:
    print("wfafs_stochastic: one value per model (guard 1)")
    for i, (label, args, wanted) in enumerate(LENGTH_FAULTS):
        assert_refused(binary, tmp, f"len{i}", label, args, wanted)


def test_psi_guard(binary: Path, tmp: Path) -> None:
    print("wfafs_stochastic: psi boundary rows (guard 2)")
    for i, (label, args, wanted) in enumerate(PSI_FAULTS):
        assert_refused(binary, tmp, f"psi{i}", label, args, wanted)


def test_starting_copies_range(binary: Path, tmp: Path) -> None:
    """-p must name a state this model has (guard 3).

    The refusals go through assert_refused, so they get the same five
    structural checks (exit 1 not a signal, a diagnostic on stderr, no results
    on stdout, no --output-Q file, no nan token) as every other fault here.
    What is specific to this guard is the ACCEPTED half below: the pre-fix
    failure mode was an all-zero spectrum printed at exit 0, so a guard that
    over-refuses would look identical to a fix in the fault list alone.
    """
    print("wfafs_stochastic: -p names a state this model has (guard 3)")
    for i, (label, args, wanted) in enumerate(STARTING_COPIES_FAULTS):
        assert_refused(binary, tmp, f"p{i}", label, args, wanted)

    for label, args, n_states in STARTING_COPIES_ACCEPTED:
        proc = run(binary, args + ["--json"])
        if not check(f"[{label}] exits 0", proc.returncode == 0,
                     f"exit {proc.returncode}: {text(proc).strip()[:400]}"):
            # Keep the count fixed whatever happens: six checks per accepted
            # case, so a refusal here cannot read as CHECKS LOST in
            # run_all_suites.py.
            for tail in ("stdout parses with json.load",
                         f"spectrum has {n_states} states",
                         "all probabilities finite and in [0, 1]",
                         "sums to 1 within 1e-9",
                         "spectrum is not all-zero"):
                check(f"[{label}] {tail}", False, "run was refused")
            continue
        doc = parse_json(proc.stdout.decode())
        if not check(f"[{label}] stdout parses with json.load", doc is not None,
                     text(proc)[:400]):
            for tail in (f"spectrum has {n_states} states",
                         "all probabilities finite and in [0, 1]",
                         "sums to 1 within 1e-9",
                         "spectrum is not all-zero"):
                check(f"[{label}] {tail}", False, "stdout did not parse")
            continue
        probs = [e["probability"] for e in doc["results"]["distribution"]]
        check(f"[{label}] spectrum has {n_states} states",
              len(probs) == n_states, f"got {len(probs)}")
        check(f"[{label}] all probabilities finite and in [0, 1]",
              all(p == p and 0.0 <= p <= 1.0 for p in probs),
              f"min {min(probs)}, max {max(probs)}")
        check(f"[{label}] sums to 1 within 1e-9",
              abs(sum(probs) - 1.0) < 1e-9, f"sum {sum(probs)!r}")
        # The pre-fix fabrication signature, asserted directly: an
        # out-of-range -p wrote its 1.0 outside the vector, so the vector the
        # solver was handed was all zeros and the spectrum came back all zeros
        # at exit 0.
        check(f"[{label}] spectrum is not all-zero",
              any(p != 0.0 for p in probs),
              "every probability is exactly 0 -- the pre-fix out-of-range "
              "signature")


def _cx_proj_divergence(label: str, ours: bytes, ref: subprocess.CompletedProcess,
                        got: str) -> None:
    """One check: the shipped binary diverges exactly as CX-proj intends.

    The alternative was to drop these six comparisons to a SKIP, which would
    have retired six byte-for-byte assertions in the same commit that moved the
    numbers -- precisely when the reference is most worth consulting. The
    shipped /Applications/WFES3.app binary still runs the AVERAGING
    down-projection, so the divergence has a known shape and can be asserted
    positively instead: the two boundary classes are bit-identical (the
    down-projection copies them either way), the reference total falls short of
    1 (the segregating mass it dropped), and ours does not. Anything else --
    including the reference agreeing with us, which would mean this suite is
    pointed at a rebuilt app -- fails.
    """
    ours_doc = parse_json(ours.decode("utf-8", "replace"))
    ref_doc = parse_json(ref.stdout.decode("utf-8", "replace"))
    if ref.returncode != 0 or ours_doc is None or ref_doc is None:
        check(f"[{label}] diverges from the reference binary as CX-proj "
              f"intends", False,
              f"reference exit {ref.returncode}; parsed ours="
              f"{ours_doc is not None}, reference={ref_doc is not None}")
        return
    a = [e["probability"] for e in ours_doc["results"]["distribution"]]
    b = [e["probability"] for e in ref_doc["results"]["distribution"]]
    same_shape = len(a) == len(b)
    boundaries = same_shape and a[0] == b[0] and a[-1] == b[-1]
    ours_sums = abs(sum(a) - 1.0) < 1e-12
    ref_short = sum(b) < 1.0 - 1e-9
    ref_md5 = hashlib.md5(strip_provenance(ref.stdout)).hexdigest()
    check(f"[{label}] diverges from the reference binary as CX-proj intends",
          same_shape and boundaries and ours_sums and ref_short,
          f"reference md5 {ref_md5} vs {got}; same length {same_shape}, "
          f"boundary classes identical {boundaries}, ours sums to "
          f"{sum(a)!r}, reference sums to {sum(b)!r} (must be short of 1: "
          f"the segregating mass the averaging dropped)")


def test_legitimate_models(binary: Path, reference: Path | None) -> None:
    print("wfafs_stochastic: legitimate models are untouched")
    for label, args, digest, ship_match in LEGIT_CASES:
        proc = run(binary, args)
        if not check(f"[{label}] exits 0", proc.returncode == 0,
                     f"exit {proc.returncode}: {text(proc).strip()[:400]}"):
            continue
        got = hashlib.md5(strip_provenance(proc.stdout)).hexdigest()
        if DIGESTS_APPLY:
            check(f"[{label}] stdout matches the recorded md5",
                  got == digest, f"recorded {digest}, got {got}")
        else:
            SKIPS.skip(f"[{label}] stdout matches the recorded md5",
                       f"{platform_probe.DIGEST_REASON}; measured here: "
                       f"{got}, recorded {digest}")
        # stdout only, per the stderr-scope convention in the module docstring.
        # This site used to sweep both streams, on the argument that a healthy
        # run "says nothing at all about nan" so stderr costs nothing to
        # include. That is true of today's binary and is exactly why it is the
        # wrong place to draw the line: it makes the suite's scope depend on
        # the tool staying silent, so the first legitimate advisory that names
        # a non-finite quantity fails a HEALTHY-run check for saying something
        # useful. The healthy run's real obligation, byte-for-byte identity of
        # its published stdout, is asserted immediately above.
        hits = NONFINITE_RE.findall(proc.stdout.decode("utf-8", "replace"))
        check(f"[{label}] no inf/nan token on stdout", not hits,
              f"found {sorted(set(hits))} in: {text(proc).strip()[:300]}")
        if reference is not None:
            if ship_match is True:
                ref = run(reference, args)
                check(f"[{label}] byte-identical to the reference binary",
                      ref.returncode == 0 and strip_provenance(ref.stdout)
                                             == strip_provenance(proc.stdout),
                      f"reference exit {ref.returncode}, "
                      f"md5 "
                      f"{hashlib.md5(strip_provenance(ref.stdout)).hexdigest()}"
                      f" vs {got}")
            elif ship_match == "cx-proj":
                _cx_proj_divergence(label, proc.stdout, run(reference, args),
                                    got)
            else:
                # NOT a platform skip: this comparison is retired on every
                # machine, and the recorded count already excludes it. Counting
                # it here would break the recording platform's own arithmetic
                # (recorded - skipped == ran).
                print(f"  SKIP  [{label}] reference comparison "
                      "(known pre-existing divergence -- see module docstring)")
        elif ship_match is True:
            SKIPS.skip(f"[{label}] byte-identical to the reference binary",
                       NO_REFERENCE_REASON)
        elif ship_match == "cx-proj":
            SKIPS.skip(f"[{label}] diverges from the reference binary as "
                       f"CX-proj intends", NO_REFERENCE_REASON)


def test_healthy_distribution_is_a_distribution(binary: Path) -> None:
    """The guards must not perturb the numbers they let through.

    Both spectra now conserve mass to roundoff and both are asserted at 1e-12.
    That was not always true of the first of them. Until task CX-proj the
    DOWN-projection AVERAGED the m-2 interior states into the n-2 output bins
    (`prj_u[i+1] / row_integral_counts[j+1]`) instead of summing them, so it
    threw away about (1 - 1/bin-count) of the SEGREGATING mass and the total
    came back short: measured 1.2e-07 for -f 2,2 on -N 20,10 and 3.1e-05 for
    the 3-epoch -f 10,10,10 model, which is why this check used to be asserted
    at the honest-but-loose bound of 1e-3. The bins are summed as of CX-proj
    and the deficit is gone; test_down_projection_conserves_mass below asserts
    the stronger, tolerance-free property that motivates it.
    """
    print("wfafs_stochastic: a healthy spectrum is still a distribution")
    for label, args, tol in (
            ("f = 2,2 down-projected",
             ["-N", "20,10", "-G", "10,5", "-f", "2,2", "--json"], 1e-12),
            ("f = 2,2 up-projected",
             ["-N", "20,10", "-G", "10,5", "-f", "2,2", "--no-project",
              "--json"], 1e-9)):
        proc = run(binary, args)
        if not check(f"[{label}] exits 0", proc.returncode == 0,
                     f"exit {proc.returncode}: {text(proc).strip()[:400]}"):
            continue
        doc = parse_json(proc.stdout.decode())
        if not check(f"[{label}] stdout parses with json.load", doc is not None,
                     text(proc)[:400]):
            continue
        probs = [e["probability"] for e in doc["results"]["distribution"]]
        check(f"[{label}] all probabilities finite",
              all(p == p and abs(p) != float("inf") for p in probs))
        check(f"[{label}] all probabilities in [0, 1]",
              all(0.0 <= p <= 1.0 for p in probs),
              f"min {min(probs)}, max {max(probs)}")
        check(f"[{label}] sums to 1 within {tol:g}",
              abs(sum(probs) - 1.0) < tol, f"sum {sum(probs)!r}")


# The two halves of the projection, run as a pair. --no-project returns
# prj_u -- the exact vector the down-projection consumes -- so the two runs
# straddle the binning step and nothing else, and the comparison needs no
# reference values from outside this file.
MASS_CONSERVATION_CASES = [
    ("f = 2,2", ["-N", "20,10", "-G", "10,5", "-f", "2,2"]),
    ("3 epochs, f = 10,10,10",
     ["-N", "2000,200,1000", "-G", "400,40,200", "-f", "10,10,10"]),
]


def test_down_projection_conserves_mass(binary: Path) -> None:
    """The down-projection must SUM its bins, not average them (task CX-proj).

    THE BUG THIS EXISTS TO CATCH. The down-projection maps the m-2 interior
    states of the up-projected spectrum onto the n-2 interior states of the
    model's own space. Every fine state belongs to exactly one output bin, so
    the operation that preserves probability is a SUM. It divided by
    row_integral_counts instead -- averaging the states in each bin -- and so
    published a spectrum missing about (1 - 1/bin-count) of its SEGREGATING
    mass. Measured on the pre-fix binary:

        -f 2,2 on -N 20,10        segregating 2.1798e-07 -> 1.0059e-07  (-54%)
        3 epochs, -f 10,10,10     segregating 3.4641e-05 -> 3.4327e-06  (-90%)

    It was easy to miss for one reason: the two BOUNDARY classes are copied
    across verbatim (prj_d[0] = prj_u[0], prj_d[n-1] = prj_u[m-1]) and under
    the mutation-drift models this tool solves they carry ~0.5 each, so the
    total still came back as 0.99999988 and 0.99996879 -- close enough to 1 to
    look like roundoff in any check written with a loose tolerance. The
    segregating part, which is the part an allele-frequency spectrum is FOR,
    had lost half to nine tenths of itself.

    So the assertion is on the segregating mass specifically, at rtol 1e-9,
    and not only on the total. A total-only check at 1e-12 would also fail
    today, but it would go on passing for any future model whose boundary
    classes happen to dominate even harder. --no-project returns prj_u, the
    input to the binning step, so BEFORE and AFTER come from the same binary
    on the same model and the check carries no recorded constants to go stale.

    Six checks per case, fixed, so a regression cannot read as CHECKS LOST.
    """
    print("wfafs_stochastic: the down-projection conserves mass (CX-proj)")
    for label, args in MASS_CONSERVATION_CASES:
        up_proc = run(binary, args + ["--no-project", "--json"])
        dn_proc = run(binary, args + ["--json"])
        up_doc = parse_json(up_proc.stdout.decode("utf-8", "replace"))
        dn_doc = parse_json(dn_proc.stdout.decode("utf-8", "replace"))
        ok = (up_proc.returncode == 0 and dn_proc.returncode == 0
              and up_doc is not None and dn_doc is not None)
        if not check(f"[{label}] both projections exit 0 and parse", ok,
                     f"--no-project exit {up_proc.returncode}, default exit "
                     f"{dn_proc.returncode}: "
                     f"{text(dn_proc).strip()[:300]}"):
            for tail in ("up-projected spectrum sums to 1 within 1e-9",
                         "down-projected spectrum sums to 1 within 1e-12",
                         "segregating mass survives the down-projection "
                         "(rtol 1e-9)",
                         "the 0-copy class is carried over unchanged",
                         "the 2N-copy class is carried over unchanged"):
                check(f"[{label}] {tail}", False, "a run was refused")
            continue

        up = [e["probability"] for e in up_doc["results"]["distribution"]]
        dn = [e["probability"] for e in dn_doc["results"]["distribution"]]

        check(f"[{label}] up-projected spectrum sums to 1 within 1e-9",
              abs(sum(up) - 1.0) < 1e-9, f"sum {sum(up)!r}")
        check(f"[{label}] down-projected spectrum sums to 1 within 1e-12",
              abs(sum(dn) - 1.0) < 1e-12, f"sum {sum(dn)!r}")

        # The whole point. Interior = every state that is neither 0 copies nor
        # 2N copies, i.e. the segregating part of the spectrum.
        seg_up, seg_dn = sum(up[1:-1]), sum(dn[1:-1])
        check(f"[{label}] segregating mass survives the down-projection "
              f"(rtol 1e-9)",
              abs(seg_dn - seg_up) <= 1e-9 * abs(seg_up),
              f"before {seg_up!r} ({len(up) - 2} states) -> "
              f"after {seg_dn!r} ({len(dn) - 2} bins); "
              f"relative change {(seg_dn - seg_up) / seg_up:+.3e}. A ratio "
              f"near 1/bin-count is the averaging bug (CX-proj) returning.")

        # These two are copied, not binned. If they ever stop matching, the
        # segregating comparison above is measuring the wrong difference.
        check(f"[{label}] the 0-copy class is carried over unchanged",
              dn[0] == up[0], f"{up[0]!r} -> {dn[0]!r}")
        check(f"[{label}] the 2N-copy class is carried over unchanged",
              dn[-1] == up[-1], f"{up[-1]!r} -> {dn[-1]!r}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--bin", type=Path, default=DEFAULT_BIN_DIR,
                    help=f"directory holding wfafs_stochastic "
                         f"(default: {DEFAULT_BIN_DIR})")
    ap.add_argument("--reference", type=Path,
                    default=platform_probe.shipped_root() / "wfafs_stochastic",
                    help="second wfafs_stochastic to compare healthy output "
                         "against byte for byte (skipped if absent)")
    opts = ap.parse_args()

    binary = opts.bin / "wfafs_stochastic"
    if not binary.is_file():
        print(f"error: {binary} not found (build it first, or pass --bin)")
        return 2
    reference: Path | None = opts.reference
    if reference is None or not reference.is_file():
        print(f"note: reference binary {opts.reference} not found; "
              "skipping the byte-for-byte comparison")
        reference = None

    global DIGESTS_APPLY
    DIGESTS_APPLY = platform_probe.digests_apply(opts.bin)
    print(f"Binary:    {binary}")
    print(f"Reference: {reference if reference else '(none)'}")
    print(platform_probe.platform_banner(opts.bin))
    print(f"recorded md5s asserted here: {DIGESTS_APPLY}\n")

    with tempfile.TemporaryDirectory() as tmpdir:
        tmp = Path(tmpdir)
        test_inv2_repro(binary, tmp)
        test_length_guard(binary, tmp)
        test_psi_guard(binary, tmp)
        test_starting_copies_range(binary, tmp)
        test_legitimate_models(binary, reference)
        test_healthy_distribution_is_a_distribution(binary)
        test_down_projection_conserves_mass(binary)

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
