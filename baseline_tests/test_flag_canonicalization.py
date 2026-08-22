#!/usr/bin/env python3
"""
Integrity tests for the short-flag canonicalization (WFES3 §4, PI-approved).

The governing rule the whole change exists to serve: A FLAG MUST NEVER SILENTLY
CHANGE MEANING. Before this change six letters meant different things in
different tools, and the two worst were silent:

    wfes_sequential -t 8      set an epoch expected time of 8 generations,
                              while `-t 8` in the other ten tools asked for
                              eight threads.
    wfes_sweep -l 0.5         set the sweep transition probability, while
                              `-l` in nine other tools chose the solver
                              library -- so `-l Accelerate` and `-l 0.5` were
                              both "valid" in different halves of the suite.

Neither produced an error. A script written against one tool and pointed at
another computed a different model and reported success. That is the defect
class this file locks shut, in three parts:

  TRAPS
      A letter that used to mean something else in a given tool is now a hard
      parse error THERE, naming the old meaning and the new spelling. It never
      parses as the new meaning, because silently rebinding `-t` in
      wfes_sequential would turn every existing `-t 8` invocation into an
      eight-thread run of a different model -- exactly the silent change the
      rule forbids. Nine (tool, letter) sites; each must exit nonzero both bare
      and with a value.

  NEW BINDINGS
      The displaced concepts moved to previously-unused letters (-e, -L, -P,
      -R) and --no-recurrent-mu standardised on -r in the two tools that had
      it on -m. Each new short flag must produce output BYTE-IDENTICAL to its
      long form; a short flag that is merely accepted is not the same thing as
      a short flag that means what it says.

  LONG ALIASES
      Where a LONG name changed (--initial-count -> --starting-copies,
      --pop-sizes -> --pop-size) the old spelling stays accepted forever: a
      long name is unambiguous, so there is nothing to protect against, and
      the GUI's argument builders emit --initial-count and --pop-sizes today.
      Byte-identical outputs, both spellings.

Plus a spot-check that the flags which did NOT move still work, and a run of
the CI collision checker: green against the build under test, red against the
shipped v3.0.0-beta.3 binaries, which is what proves the checker detects the
collisions rather than merely agreeing with whatever it is pointed at.

Usage
-----
    python3 baseline_tests/test_flag_canonicalization.py [--bin <dir>]
                                                         [--shipped <dir>]

--bin is the DIRECTORY holding the eleven binaries; it defaults to
wfes-cli/build-cx7/bin. --shipped points at the installed v3.0.0-beta.3
binaries for the checker's negative control; the check is skipped, not failed,
if they are absent. Exit status is 0 only if every check passes.

Standard library only, no third-party imports, no fixtures on disk.

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

This suite runs no token sweep. Its `output()` helper deliberately joins
both streams, because it searches for EXPECTED substrings (a trap message
naming the old meaning and the new spelling) that a tool may legitimately
print to either stream. That is a substring assertion, not a sweep.
"""
from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
DEFAULT_BIN_DIR = REPO / "wfes-cli" / "build-cx7" / "bin"
DEFAULT_SHIPPED = Path("/Applications/WFES3.app/Contents/Resources/bin")
CHECKER = REPO / "wfes-cli" / "scripts" / "check_flag_collisions.py"

ALL_TOOLS = [
    "wfes_single", "wfes_sweep", "wfes_switching", "wfes_sequential",
    "time_dist", "time_dist_dual", "time_dist_sgv", "phase_type_dist",
    "phase_type_moments", "wfafs_stochastic", "wfafs_deterministic",
]

PASS = FAIL = 0
FAILURES: list[str] = []


def check(condition: bool, label: str, detail: str = "") -> bool:
    global PASS, FAIL
    if condition:
        PASS += 1
        print(f"  PASS  {label}")
    else:
        FAIL += 1
        FAILURES.append(label)
        print(f"  FAIL  {label}" + (f"   [{detail}]" if detail else ""))
    return condition


def run(binary: Path, args: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run([str(binary), *args], capture_output=True, text=True,
                          timeout=600)


def output(proc: subprocess.CompletedProcess) -> str:
    return proc.stdout + proc.stderr


# --------------------------------------------------------------------------
# 1. Traps: every re-purposed letter is a hard error in the tool that moved it
# --------------------------------------------------------------------------
#
# (tool, letter, what it used to mean here, substrings the message must carry).
# The message has to name BOTH sides -- the old meaning, so a user reading it
# recognises the invocation they just typed, and the new spelling, so they know
# what to type instead. A message naming only one of the two leaves the reader
# to guess which of their flags is wrong.
#
# The replacement is spelled as the whole "-X/--long" token on purpose: "-e" is
# a substring of "--exp-time" and "-r" of "--no-recurrent-mu", so a check for
# the bare letter would pass on a message that never offered the letter at all.
TRAPS = [
    ("wfes_sequential", "t", "--exp-time",
     ["--exp-time", "--num-threads", "-e/--exp-time"]),
    ("wfes_sequential", "p", "--starting-prob",
     ["--starting-prob", "--starting-copies", "-P/--starting-prob"]),
    ("wfes_switching", "p", "--starting-prob",
     ["--starting-prob", "--starting-copies", "-P/--starting-prob"]),
    ("wfes_switching", "r", "--switching",
     ["--switching", "--no-recurrent-mu", "-R/--switching"]),
    ("wfes_single", "m", "--no-recurrent-mu",
     ["--no-recurrent-mu", "--max-t", "-r/--no-recurrent-mu"]),
    ("wfes_single", "k", "--odds-ratio",
     ["--odds-ratio", "--n-moments", "long form only"]),
    ("phase_type_moments", "m", "--no-recurrent-mu",
     ["--no-recurrent-mu", "--max-t", "-r/--no-recurrent-mu"]),
    ("wfes_sweep", "l", "--lambda",
     ["--lambda", "--library", "-L/--lambda"]),
    ("time_dist_sgv", "l", "--lambda",
     ["--lambda", "--library", "-L/--lambda"]),
]


def section_traps(bindir: Path):
    print("\n== every re-purposed short flag is a hard error, never a rebind ==")
    for tool, letter, old, must in TRAPS:
        binary = bindir / tool
        # Bare, and with the kind of value the old meaning took. Both forms
        # matter: `-t` alone and `-t 8` take different paths through the args
        # library (the second consumes the value first), and only the second
        # is what a user's existing script actually contains.
        for extra, shown in (([], f"-{letter}"), (["1"], f"-{letter} 1")):
            proc = run(binary, [f"-{letter}", *extra])
            text = output(proc)
            check(proc.returncode != 0,
                  f"{tool} {shown}: exits nonzero",
                  f"exit={proc.returncode}")
            missing = [s for s in must if s not in text]
            check(not missing,
                  f"{tool} {shown}: names {', '.join(must)}",
                  f"missing {missing}; got {' '.join(text.split())[:200]!r}")
        # And it must not be quietly reintroduced in --help.
        help_text = run(binary, ["--help"]).stdout
        check(f"-{letter}[" not in help_text and f"-{letter}," not in help_text
              and f"-{letter}\n" not in help_text,
              f"{tool} --help: does not offer -{letter}",
              f"still advertised (used to be {old})")


# --------------------------------------------------------------------------
# 2. New bindings: the short form must equal the long form, byte for byte
# --------------------------------------------------------------------------
#
# (label, tool, common args, short spelling, long spelling). Structured output
# is used throughout so the comparison covers the numbers rather than the
# banner, and because these streams carry no timestamps or paths.
NEW_BINDINGS = [
    ("wfes_sequential -e = --exp-time", "wfes_sequential",
     ["-N", "8,8", "--json"], ["-e", "10,10"], ["--exp-time", "10,10"]),

    ("wfes_switching -P = --starting-prob", "wfes_switching",
     ["--absorption", "-N", "8,8", "-R", "0.9,0.1;0.1,0.9", "--json"],
     ["-P", "1,0"], ["--starting-prob", "1,0"]),
    ("wfes_sequential -P = --starting-prob", "wfes_sequential",
     ["-N", "8,8", "-e", "10,10", "--json"],
     ["-P", "1,0"], ["--starting-prob", "1,0"]),

    ("wfes_switching -R = --switching", "wfes_switching",
     ["--absorption", "-N", "8,8", "--json"],
     ["-R", "0.9,0.1;0.1,0.9"], ["--switching", "0.9,0.1;0.1,0.9"]),

    ("wfes_sweep -L = --lambda", "wfes_sweep",
     ["--fixation", "-N", "10", "-s", "0.01,0.02", "--json"],
     ["-L", "0.5"], ["--lambda", "0.5"]),
    ("time_dist_sgv -L = --lambda", "time_dist_sgv",
     ["-N", "10", "-s", "0.01,0.01", "--csv"],
     ["-L", "0.5"], ["--lambda", "0.5"]),

    ("wfes_single -r = --no-recurrent-mu", "wfes_single",
     ["--absorption", "-N", "10", "--json"],
     ["-r"], ["--no-recurrent-mu"]),
    ("phase_type_moments -r = --no-recurrent-mu", "phase_type_moments",
     ["-N", "10", "--json"], ["-r"], ["--no-recurrent-mu"]),
]


def section_new_bindings(bindir: Path):
    print("\n== each newly bound short flag is its long form, byte for byte ==")
    for label, tool, base, short, long in NEW_BINDINGS:
        binary = bindir / tool
        a = run(binary, base + short)
        b = run(binary, base + long)
        check(a.returncode == 0 and b.returncode == 0,
              f"{label}: both spellings run",
              f"short exit={a.returncode} {a.stderr.strip()[:120]!r}; "
              f"long exit={b.returncode} {b.stderr.strip()[:120]!r}")
        check(a.stdout == b.stdout and a.stdout.strip() != "",
              f"{label}: identical output",
              f"{len(a.stdout)} vs {len(b.stdout)} bytes")


# --------------------------------------------------------------------------
# 3. Long aliases: the old long spellings still parse identically
# --------------------------------------------------------------------------
#
# These are NOT traps, and deliberately so: the deprecation policy hard-errors
# a displaced SHORT letter, because the same letter meant something else; a
# renamed LONG name has no such ambiguity, so it stays accepted indefinitely.
# The GUI depends on it -- wfesBackendService.ts emits --initial-count for
# wfafs_stochastic and --pop-sizes for all four vector tools today.
LONG_ALIASES = [
    ("wfafs_stochastic --initial-count = --starting-copies", "wfafs_stochastic",
     ["-N", "20,20", "-G", "10,10", "-f", "1,1", "--csv"],
     ["--initial-count", "3"], ["--starting-copies", "3"]),
    ("wfafs_deterministic --initial-count = --starting-copies",
     "wfafs_deterministic",
     ["-N", "10", "-G", "5", "-s", "0.01", "--csv"],
     ["--initial-count", "3"], ["--starting-copies", "3"]),
    ("wfafs_deterministic -p = --starting-copies", "wfafs_deterministic",
     ["-N", "10", "-G", "5", "-s", "0.01", "--csv"],
     ["-p", "3"], ["--starting-copies", "3"]),
    ("wfes_switching --pop-sizes = --pop-size", "wfes_switching",
     ["--absorption", "-R", "0.9,0.1;0.1,0.9", "--json"],
     ["--pop-sizes", "8,8"], ["--pop-size", "8,8"]),
    ("wfes_sequential --pop-sizes = --pop-size", "wfes_sequential",
     ["-e", "10,10", "--json"],
     ["--pop-sizes", "8,8"], ["--pop-size", "8,8"]),
    ("wfafs_stochastic --pop-sizes = --pop-size", "wfafs_stochastic",
     ["-G", "10,10", "-f", "1,1", "--csv"],
     ["--pop-sizes", "20,20"], ["--pop-size", "20,20"]),
    ("wfafs_deterministic --pop-sizes = --pop-size", "wfafs_deterministic",
     ["-G", "5", "-s", "0.01", "-p", "1", "--csv"],
     ["--pop-sizes", "10"], ["--pop-size", "10"]),
]


def section_long_aliases(bindir: Path):
    print("\n== renamed long names keep their old spelling as a silent alias ==")
    for label, tool, base, alias, canonical in LONG_ALIASES:
        binary = bindir / tool
        a = run(binary, base + alias)
        b = run(binary, base + canonical)
        check(a.returncode == 0 and b.returncode == 0,
              f"{label}: both spellings run",
              f"alias exit={a.returncode} {a.stderr.strip()[:120]!r}; "
              f"canonical exit={b.returncode} {b.stderr.strip()[:120]!r}")
        check(a.stdout == b.stdout and a.stdout.strip() != "",
              f"{label}: identical output",
              f"{len(a.stdout)} vs {len(b.stdout)} bytes")

    # The alias is accepted but not advertised: --help is the canonical table's
    # user-facing half, and two spellings for one concept is how the next
    # rename gets made against the wrong one.
    for tool, hidden, shown in (
            ("wfafs_stochastic", "--initial-count", "--starting-copies"),
            ("wfafs_deterministic", "--initial-count", "--starting-copies"),
            ("wfes_switching", "--pop-sizes", "--pop-size"),
            ("wfes_sequential", "--pop-sizes", "--pop-size"),
            ("wfafs_stochastic", "--pop-sizes", "--pop-size"),
            ("wfafs_deterministic", "--pop-sizes", "--pop-size")):
        text = run(bindir / tool, ["--help"]).stdout
        check(hidden not in text, f"{tool} --help: does not advertise {hidden}")
        check(shown in text, f"{tool} --help: advertises {shown}")


# --------------------------------------------------------------------------
# 4. The letters that did NOT move still mean what they meant
# --------------------------------------------------------------------------
def section_unchanged(bindir: Path):
    print("\n== the flags that did not move are untouched ==")
    single = bindir / "wfes_single"

    # -p: a starting copy count, and still mode-aware (count 0 is transient
    # under --fixation, absorbing otherwise).
    p_run = run(single, ["--absorption", "-N", "10", "-p", "3", "--json"])
    p_long = run(single, ["--absorption", "-N", "10", "--starting-copies", "3",
                          "--json"])
    check(p_run.returncode == 0 and p_run.stdout == p_long.stdout,
          "wfes_single -p 3 = --starting-copies 3",
          f"exit={p_run.returncode}")
    check(run(single, ["--absorption", "-N", "10", "-p", "0"]).returncode != 0,
          "wfes_single --absorption -p 0: still refused (absorbing state)")
    check(run(single, ["--fixation", "-N", "10", "-p", "0",
                       "--json"]).returncode == 0,
          "wfes_single --fixation -p 0: still accepted (transient state)")

    # -c: the starting-copy integration cutoff.
    c_run = run(single, ["--absorption", "-N", "10", "-c", "1e-8", "--json"])
    c_long = run(single, ["--absorption", "-N", "10",
                          "--integration-cutoff", "1e-8", "--json"])
    check(c_run.returncode == 0 and c_run.stdout == c_long.stdout,
          "wfes_single -c 1e-8 = --integration-cutoff 1e-8",
          f"exit={c_run.returncode}")

    # -l: the solver library, in the nine tools that keep it. (wfes_sweep and
    # time_dist_sgv take --library long-only this release, since -l traps.)
    l_run = run(single, ["--absorption", "-N", "10", "-l", "SuiteSparse",
                         "--json"])
    l_long = run(single, ["--absorption", "-N", "10", "--library",
                          "SuiteSparse", "--json"])
    check(l_run.returncode == 0 and l_run.stdout == l_long.stdout,
          "wfes_single -l SuiteSparse = --library SuiteSparse",
          f"exit={l_run.returncode} {l_run.stderr.strip()[:120]!r}")

    # -t still means threads in the ten tools that keep it, and the answer is
    # thread-count independent.
    t1 = run(single, ["--absorption", "-N", "10", "-t", "1", "--json"])
    t2 = run(single, ["--absorption", "-N", "10", "--num-threads", "1",
                      "--json"])
    check(t1.returncode == 0 and t1.stdout == t2.stdout,
          "wfes_single -t 1 = --num-threads 1", f"exit={t1.returncode}")

    # -m still means --max-t in the four distribution tools, unchanged.
    m1 = run(bindir / "time_dist", ["-N", "20", "-m", "40", "--csv"])
    m2 = run(bindir / "time_dist", ["-N", "20", "--max-t", "40", "--csv"])
    check(m1.returncode == 0 and m1.stdout == m2.stdout,
          "time_dist -m 40 = --max-t 40", f"exit={m1.returncode}")

    # -r still means --no-recurrent-mu in the four distribution tools.
    r1 = run(bindir / "time_dist", ["-N", "20", "-m", "40", "-r", "--csv"])
    r2 = run(bindir / "time_dist", ["-N", "20", "-m", "40",
                                    "--no-recurrent-mu", "--csv"])
    check(r1.returncode == 0 and r1.stdout == r2.stdout,
          "time_dist -r = --no-recurrent-mu", f"exit={r1.returncode}")

    # -k still means --n-moments in phase_type_moments, its one remaining home.
    k1 = run(bindir / "phase_type_moments", ["-N", "10", "-k", "4", "--json"])
    k2 = run(bindir / "phase_type_moments", ["-N", "10", "--n-moments", "4",
                                             "--json"])
    check(k1.returncode == 0 and k1.stdout == k2.stdout,
          "phase_type_moments -k 4 = --n-moments 4", f"exit={k1.returncode}")

    # time_dist_sgv's --threads alias is gone: one spelling per concept.
    sgv = run(bindir / "time_dist_sgv",
              ["-N", "10", "-L", "0.5", "-s", "0.01,0.01", "--threads", "1",
               "--csv"])
    check(sgv.returncode != 0,
          "time_dist_sgv --threads: dropped in favour of --num-threads",
          f"exit={sgv.returncode}")
    sgv_ok = run(bindir / "time_dist_sgv",
                 ["-N", "10", "-L", "0.5", "-s", "0.01,0.01", "-t", "1",
                  "--csv"])
    check(sgv_ok.returncode == 0, "time_dist_sgv -t 1: still means threads",
          f"exit={sgv_ok.returncode} {sgv_ok.stderr.strip()[:120]!r}")


# --------------------------------------------------------------------------
# 5. The CI checker: green here, red against the shipped binaries
# --------------------------------------------------------------------------
def section_checker(bindir: Path, shipped: Path):
    print("\n== the CI collision checker agrees, and can still say no ==")
    if not CHECKER.exists():
        check(False, "check_flag_collisions.py exists", str(CHECKER))
        return
    proc = subprocess.run([sys.executable, str(CHECKER), "--bin", str(bindir)],
                          capture_output=True, text=True, timeout=600)
    check(proc.returncode == 0,
          "check_flag_collisions.py: exits 0 for this build",
          " ".join(output(proc).split())[:400])

    # Negative control. A checker that passes everything it is shown proves
    # nothing; this one has to fail the binaries that actually carry the
    # collisions, and name them.
    if not (shipped / "wfes_single").exists():
        print(f"  SKIP  shipped binaries not present at {shipped}")
        return
    proc = subprocess.run([sys.executable, str(CHECKER), "--bin", str(shipped)],
                          capture_output=True, text=True, timeout=600)
    check(proc.returncode != 0,
          "check_flag_collisions.py: exits nonzero for the shipped v3.0.0-beta.3 "
          "binaries", f"exit={proc.returncode}")
    for letter in ("-t", "-l", "-m", "-r", "-k", "-p", "-N"):
        check(f"collision: {letter} means more than one thing" in proc.stdout,
              f"checker names the shipped {letter} collision")


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--bin", type=Path, default=DEFAULT_BIN_DIR,
                    help=f"directory holding the eleven binaries "
                         f"(default: {DEFAULT_BIN_DIR})")
    ap.add_argument("--shipped", type=Path, default=DEFAULT_SHIPPED,
                    help="installed v3.0.0-beta.3 binaries, used as the "
                         "checker's negative control")
    opts = ap.parse_args()
    bindir: Path = opts.bin

    missing = [t for t in ALL_TOOLS if not (bindir / t).exists()]
    if missing:
        print(f"error: missing binaries in {bindir}: {', '.join(missing)}",
              file=sys.stderr)
        return 2

    print(f"binaries: {bindir}")
    section_traps(bindir)
    section_new_bindings(bindir)
    section_long_aliases(bindir)
    section_unchanged(bindir)
    section_checker(bindir, opts.shipped)

    print(f"\n{PASS} passed, {FAIL} failed")
    if FAILURES:
        print("failed checks:")
        for f in FAILURES:
            print(f"  - {f}")
    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
