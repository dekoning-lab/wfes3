#!/usr/bin/env python3
"""
Integrity tests for the SHARED CLI layer: wfes-cli/src/core/args_parser.cpp,
wfes-cli/include/args_parser.hpp and wfes-cli/src/core/output_formatter.cpp.

Everything here is a behaviour every one of the eleven tools inherits from the
same code, so a regression in one of these is a regression in all of them.

What each section locks in, and why it is not a style preference:

  -x/--observed-copies (wfes_single --allele-age)
      The parser stored `observed_copies = x - 1` with no bounds check, and the
      main treated the stored 0 as "flag not supplied". Two consequences, both
      verified against the pre-fix build:
        * `-x 1` -- one observed copy, the most common allele-age query --
          failed with "--observed-copies parameter required", a message that
          describes a different problem than the one the user has;
        * `-x 0`, `-x -1`, `-x 2N` and beyond indexed OUTSIDE the (2N-1)-element
          transient state space. With Eigen's asserts enabled that is SIGABRT
          (exit 134, seen in the shipped binaries); under -DNDEBUG, which is how
          these binaries are built, the assert compiles out and the read walks
          off the vector, so the answer came from whatever was in memory.
      The valid range is fixed by the model, not by taste: --allele-age builds
      WF::BOTH_ABSORBING, whose Q drops allele counts 0 and 2N (wrightFisher.cpp,
      "Do not include 0th and Nx2th row and column"), leaving 2N-1 transient
      states indexed 0..2N-2 for copy counts 1..2N-1. wfes_single_main.cpp sets
      `size = 2N - 1` and uses x directly as a Q index. So counts 1..2N-1 are
      exactly the valid -x values, and both edges must work.

  time_dist_sgv -d/--distribution-cutoff
      Its validator range-checked `integration_cutoff` -- a value the tool hard
      codes and never reads -- so the flag the user actually set went entirely
      unchecked. `-d 5` (a probability mass above 1, never reachable) ran to the
      max_t ceiling and exited 0.

  Wright-Fisher advisories on the vector tools
      wfes_single refuses 4N*mu > 1, N > 500000, 2Ns <= -100 and alpha > 1e-5
      unless --force. wfes_switching, wfes_sequential and wfafs_stochastic had
      TODO stubs that checked only alpha, so the same parameters that stop
      wfes_single ran silently to a plausible-looking answer.

  N >= 2, every tool
      -N 1 aborts on an Eigen bounds assert in the shipped binaries (exit 134
      for wfes_single, wfes_switching and wfes_sequential) and, in an NDEBUG
      build like this one, exits 0 with fabricated numbers instead. This check
      is deliberately NOT --force-bypassable: it is an indexing error, not a
      judgement call.

  --library
      ViennaCL was advertised in every tool's --help and always failed, and an
      UNRECOGNISED library string fell through the factories' `else` branch to
      the platform default -- so on Linux a typo'd --library silently ran
      Pardiso and reported success.

  CSV precision
      wfes_single printed ~6 significant figures of CSV in five modes and 17 in
      --fundamental. Six figures is lossy: the value cannot be round-tripped
      back to the double that was computed.

Usage
-----
    python3 baseline_tests/test_shared_parser.py [--bin <dir>]

--bin is the DIRECTORY holding the eleven binaries; it defaults to
wfes-cli/build-cx6/bin. Exit status is 0 only if every check passes.

Standard library only, no third-party imports, no fixtures on disk.
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
DEFAULT_BIN_DIR = REPO / "wfes-cli" / "build-cx6" / "bin"

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


# Minimal argument sets that make each tool run. `N` is substituted per call so
# the same table drives the N >= 2 loop and the --library loop.
def tool_invocations(n: str) -> list[tuple[str, list[str]]]:
    return [
        ("wfes_single", ["--absorption", "-N", n]),
        ("wfes_switching", ["--absorption", "-N", f"{n},{n}",
                            "-R", "0.5,0.5;0.5,0.5"]),
        ("wfes_sequential", ["-N", f"{n},{n}", "-e", "10,10"]),
        ("wfes_sweep", ["--fixation", "-N", n, "-s", "0.01,0.02", "-L", "0.5"]),
        ("time_dist", ["-N", n]),
        ("time_dist_dual", ["-N", n]),
        ("time_dist_sgv", ["-N", n, "-L", "0.5", "-s", "0.01,0.01"]),
        ("phase_type_dist", ["-N", n]),
        ("phase_type_moments", ["-N", n]),
        ("wfafs_stochastic", ["-N", f"{n},{n}", "-G", "10,10", "-f", "1,1"]),
        ("wfafs_deterministic", ["-N", n, "-G", "10", "-s", "0.01", "-p", "1"]),
    ]


ALL_TOOLS = [name for name, _ in tool_invocations("10")]


def significant_digits(token: str) -> int:
    """Significant decimal digits in a printed float, ignoring the exponent."""
    m = re.fullmatch(r"[+-]?(\d*)\.?(\d*)(?:[eE][+-]?\d+)?", token.strip())
    if not m:
        return 0
    digits = (m.group(1) + m.group(2)).lstrip("0")
    return len(digits.rstrip("0")) if digits else 0


# --------------------------------------------------------------------------
# 1. -x / --observed-copies
# --------------------------------------------------------------------------
def section_observed_copies(bindir: Path):
    print("\n== -x/--observed-copies: bounds and the missing-flag sentinel ==")
    single = bindir / "wfes_single"

    # N = 20 -> transient counts 1..39. Both edges must produce a real answer.
    for n, x in (("20", "1"), ("20", "39"), ("5", "1"), ("5", "9")):
        proc = run(single, ["--allele-age", "-N", n, "-x", x, "--json"])
        label = f"--allele-age -N {n} -x {x}"
        if not check(proc.returncode == 0, f"{label}: exits 0",
                     f"exit={proc.returncode} {proc.stderr.strip()[:160]!r}"):
            continue
        try:
            results = json.loads(proc.stdout)["results"]
        except (json.JSONDecodeError, KeyError) as exc:
            check(False, f"{label}: stdout is JSON with a results object", str(exc))
            continue
        e_t = results.get("E_T")
        check(isinstance(e_t, float) and e_t == e_t and abs(e_t) != float("inf")
              and e_t > 0,
              f"{label}: E_T is finite and positive", repr(e_t))

    # Out of range on either side. The message has to name the range, because
    # the whole failure mode being fixed here is a message that describes the
    # wrong problem.
    for n, x, bound in (("20", "0", "39"), ("20", "-1", "39"),
                        ("20", "40", "39"), ("20", "100", "39"),
                        ("5", "10", "9")):
        proc = run(single, ["--allele-age", "-N", n, "-x", x, "--json"])
        label = f"--allele-age -N {n} -x {x}"
        check(proc.returncode != 0, f"{label}: exits nonzero",
              f"exit={proc.returncode}")
        text = output(proc)
        check(bound in text and "observed" in text.lower(),
              f"{label}: message names --observed-copies and the 2N-1 bound "
              f"({bound})",
              text.strip().splitlines()[-1][:200] if text.strip() else "<empty>")

    # Omitting -x entirely is still an error, and must say so as itself.
    proc = run(single, ["--allele-age", "-N", "20", "--json"])
    check(proc.returncode != 0, "--allele-age without -x: exits nonzero",
          f"exit={proc.returncode}")
    check("observed" in output(proc).lower(),
          "--allele-age without -x: message names --observed-copies")


# --------------------------------------------------------------------------
# 2. time_dist_sgv -d
# --------------------------------------------------------------------------
def section_sgv_distribution_cutoff(bindir: Path):
    print("\n== time_dist_sgv -d/--distribution-cutoff is range checked ==")
    sgv = bindir / "time_dist_sgv"
    base = ["-N", "20", "-L", "0.5", "-s", "0.01,0.01"]

    for d in ("-1", "0", "5"):
        proc = run(sgv, base + ["-d", d, "--csv"])
        label = f"time_dist_sgv -d {d}"
        check(proc.returncode != 0, f"{label}: exits nonzero",
              f"exit={proc.returncode}")
        check("cutoff" in output(proc).lower(),
              f"{label}: message names the cutoff")

    proc = run(sgv, base + ["-d", "0.5", "--csv"])
    check(proc.returncode == 0, "time_dist_sgv -d 0.5: exits 0",
          f"exit={proc.returncode} {proc.stderr.strip()[:160]!r}")


# --------------------------------------------------------------------------
# 3. Wright-Fisher advisories on the vector tools
# --------------------------------------------------------------------------
def section_advisories(bindir: Path):
    print("\n== 4N*mu > 1 advisory reaches the vector tools ==")
    # 4 * 20 * 0.5 = 40, far past the diffusion limit these tools assume.
    cases = [
        ("wfes_switching", ["--absorption", "-N", "20,20", "-u", "0.5,0.5",
                            "-R", "0.5,0.5;0.5,0.5"]),
        ("wfes_sequential", ["-N", "20,20", "-e", "10,10", "-u", "0.5,0.5"]),
        ("wfafs_stochastic", ["-N", "20,20", "-G", "10,10", "-f", "1,1",
                              "-u", "0.5,0.5"]),
    ]
    for name, args in cases:
        binary = bindir / name
        proc = run(binary, args)
        check(proc.returncode != 0, f"{name} at 4N*mu=40: exits nonzero",
              f"exit={proc.returncode}")
        text = output(proc)
        check("mutation rate" in text.lower() and "--force" in text,
              f"{name} at 4N*mu=40: message names the advisory and --force",
              text.strip().splitlines()[-1][:200] if text.strip() else "<empty>")

        # --force must actually get through. Determined empirically against
        # both the shipped binaries and this build: 4N*mu > 1 does NOT abort --
        # it completes and prints finite numbers from a model whose assumptions
        # are violated. That is a judgement call, so --force owns it. (The
        # input that really does abort is N < 2, handled below and NOT
        # bypassable.)
        forced = run(binary, args + ["--force"])
        check(forced.returncode == 0, f"{name} at 4N*mu=40 --force: exits 0",
              f"exit={forced.returncode} {forced.stderr.strip()[:160]!r}")

    print("\n== 2Ns <= -100 advisory reaches the vector tools ==")
    strong = [
        ("wfes_switching", ["--absorption", "-N", "100,100", "-s", "-0.9,-0.9",
                            "-R", "0.5,0.5;0.5,0.5"]),
        ("wfes_sequential", ["-N", "100,100", "-e", "10,10", "-s", "-0.9,-0.9"]),
    ]
    for name, args in strong:
        proc = run(bindir / name, args)
        check(proc.returncode != 0, f"{name} at 2Ns=-180: exits nonzero",
              f"exit={proc.returncode}")
        check("--force" in output(proc),
              f"{name} at 2Ns=-180: message offers --force")


# --------------------------------------------------------------------------
# 4. N >= 2 for every tool, not bypassable
# --------------------------------------------------------------------------
def section_minimum_population_size(bindir: Path):
    print("\n== -N 1 is refused by all eleven tools ==")
    for name, args in tool_invocations("1"):
        proc = run(bindir / name, args)
        check(proc.returncode != 0, f"{name} -N 1: exits nonzero",
              f"exit={proc.returncode} stdout={proc.stdout.strip()[-160:]!r}")
        check("population size" in output(proc).lower(),
              f"{name} -N 1: message names the population size")

    # Not a judgement call: --force must not open the door.
    forced = run(bindir / "wfes_single", ["--absorption", "-N", "1", "--force"])
    check(forced.returncode != 0, "wfes_single -N 1 --force: still refused",
          f"exit={forced.returncode}")

    # And N = 2 -- the smallest population the model does define -- must work,
    # so the floor is a floor and not an accidental exclusion.
    ok = run(bindir / "wfes_single", ["--absorption", "-N", "2", "--json"])
    check(ok.returncode == 0, "wfes_single -N 2: exits 0",
          f"exit={ok.returncode} {ok.stderr.strip()[:160]!r}")


# --------------------------------------------------------------------------
# 4b. Non-finite model parameters, every tool
# --------------------------------------------------------------------------
def section_non_finite_parameters(bindir: Path):
    print("\n== nan/inf model parameters are refused, not clamped ==")
    # Reachable in every tool that parses a vector flag by hand with std::stod,
    # which takes "nan" and "inf" as ordinary values. (The scalar flags go
    # through args' own double parser, which rejects them at parse time, so
    # wfes_single is not in this list.) psi_diploid clamps the fitnesses with
    # fmax(w, 1e-30), and fmax returns the NON-NaN operand -- so a NaN was not
    # propagated, it was silently replaced by the clamp. Measured before the
    # fix: time_dist_sgv and wfafs_stochastic exited 0 with a complete
    # table/spectrum, and the other three exited nonzero blaming an "invalid
    # column index" or a "singular matrix".
    cases = [
        ("time_dist_sgv", ["-N", "10", "-L", "0.5", "-s", "nan,nan", "--csv"]),
        ("wfafs_stochastic", ["-N", "10,10", "-G", "10,10", "-f", "1,1",
                              "-s", "nan,nan", "--csv"]),
        ("wfes_switching", ["--absorption", "-N", "10,10", "-s", "nan,nan",
                            "-R", "0.5,0.5;0.5,0.5", "--json"]),
        ("wfes_sequential", ["-N", "10,10", "-e", "10,10", "-s", "nan,nan",
                             "--json"]),
        ("wfes_sweep", ["--fixation", "-N", "10", "-s", "nan,nan", "-L", "0.5",
                        "--json"]),
        ("wfafs_deterministic", ["-N", "10", "-G", "10", "-s", "nan", "-p", "1",
                                 "--json"]),
        # inf takes the same path: 1.0 + inf < 0.0 is false, so it slipped
        # through the fitness range checks exactly as nan did.
        ("wfes_switching", ["--absorption", "-N", "10,10", "-s", "inf,inf",
                            "-R", "0.5,0.5;0.5,0.5", "--json"]),
        # ...and it is not only -s: u and v reach the same clamp.
        ("time_dist_sgv", ["-N", "10", "-L", "0.5", "-s", "0.01,0.01",
                           "-u", "nan,nan", "--csv"]),
    ]
    for name, args in cases:
        label = f"{name} {' '.join(args[:6])}"
        proc = run(bindir / name, args)
        check(proc.returncode != 0, f"{label}: exits nonzero",
              f"exit={proc.returncode} stdout={proc.stdout.strip()[-160:]!r}")
        text = output(proc)
        check("not a finite number" in text,
              f"{label}: message says the parameter is not finite",
              text.strip().splitlines()[-1][:200] if text.strip() else "<empty>")

    # A finite parameter must cost nothing.
    for name, args in (("time_dist_sgv", ["-N", "10", "-L", "0.5",
                                          "-s", "0.01,0.01", "--csv"]),
                       ("wfafs_stochastic", ["-N", "10,10", "-G", "10,10",
                                             "-f", "1,1", "--csv"])):
        proc = run(bindir / name, args)
        check(proc.returncode == 0, f"{name} healthy run: still exits 0",
              f"exit={proc.returncode} {proc.stderr.strip()[:160]!r}")


# --------------------------------------------------------------------------
# 4c. --non-absorbing keeps the boundary rows, so it needs buildable ones
# --------------------------------------------------------------------------
def section_non_absorbing_boundary_rows(bindir: Path):
    print("\n== --non-absorbing refuses the rates that poison its boundary rows ==")
    single = bindir / "wfes_single"
    # This model keeps all 2N+1 rows, including the two the absorbing modes drop
    # from Q. wfes-lib builds each row in log space, which is defined only for a
    # success probability strictly inside (0, 1), and psi_diploid returns
    # exactly v for the 0-copy row and exactly 1-u for the 2N-copy row. Measured
    # before the fix, on this build AND on the shipped binary: each of the three
    # cases below wrote 16 nan entries into --output-Q and exited 0, with stdout
    # reporting "Non-absorbing matrix construction completed".
    for label, args in (("-v 0", ["-v", "0"]),
                        ("-u 0", ["-u", "0"]),
                        ("-u 1e-17", ["-u", "1e-17"])):
        with tempfile.TemporaryDirectory() as td:
            qpath = Path(td) / "Q.mtx"
            proc = run(single, ["--non-absorbing", "-N", "10", *args,
                                "--output-Q", str(qpath)])
            check(proc.returncode != 0, f"--non-absorbing {label}: exits nonzero",
                  f"exit={proc.returncode}")
            check("nan" not in (qpath.read_text() if qpath.exists() else ""),
                  f"--non-absorbing {label}: writes no nan-bearing Q matrix")
            check("mutation rate" in output(proc),
                  f"--non-absorbing {label}: message names the mutation rate")

    # The bound is on 1-u, not on u, and v has no magnitude floor at all -- so
    # both of these are legal and must stay that way.
    for label, args in (("-u 1.2e-16", ["-u", "1.2e-16"]),
                        ("-v 1e-300", ["-v", "1e-300"]),
                        ("defaults", [])):
        proc = run(single, ["--non-absorbing", "-N", "10", *args])
        check(proc.returncode == 0, f"--non-absorbing {label}: exits 0",
              f"exit={proc.returncode} {proc.stderr.strip()[:160]!r}")

    # And the absorbing modes, which DROP the boundary rows, must keep
    # accepting the no-recurrent-mutation model the shared check allows.
    for mode, extra in (("--absorption", []), ("--allele-age", ["-x", "1"]),
                        ("--establishment", []), ("--fundamental", [])):
        for flag in (["-v", "0"], ["-u", "0"]):
            proc = run(single, [mode, "-N", "10", *flag, *extra, "--json"])
            check(proc.returncode == 0,
                  f"{mode} {' '.join(flag)}: still exits 0",
                  f"exit={proc.returncode} {proc.stderr.strip()[:160]!r}")


# --------------------------------------------------------------------------
# 5. --library
# --------------------------------------------------------------------------
def section_library(bindir: Path):
    print("\n== --library: unknown values refused, ViennaCL de-advertised ==")
    for name, args in tool_invocations("10"):
        binary = bindir / name

        proc = run(binary, args + ["--library", "Pardsio"])
        check(proc.returncode != 0, f"{name} --library Pardsio: exits nonzero",
              f"exit={proc.returncode}")
        text = output(proc)
        # The message has to be actionable: it must list what IS accepted.
        check("Pardsio" in text and re.search(
                  r"Accelerate|SuiteSparse|ParU|Pardiso", text) is not None,
              f"{name} --library Pardsio: message quotes the value and lists "
              f"the supported libraries",
              text.strip().splitlines()[-1][:200] if text.strip() else "<empty>")

        helped = run(binary, ["--help"])
        check(helped.returncode == 0, f"{name} --help: exits 0",
              f"exit={helped.returncode}")
        check("ViennaCL" not in output(helped),
              f"{name} --help: does not advertise ViennaCL")

    # A supported library still works, so the gate is not simply closed.
    proc = run(bindir / "wfes_single",
               ["--absorption", "-N", "20", "--library", "SuiteSparse", "--json"])
    check(proc.returncode == 0, "wfes_single --library SuiteSparse: exits 0",
          f"exit={proc.returncode} {proc.stderr.strip()[:160]!r}")


# --------------------------------------------------------------------------
# 6. CSV precision
# --------------------------------------------------------------------------
def section_csv_precision(bindir: Path):
    print("\n== CSV carries round-trip precision, like JSON ==")
    proc = run(bindir / "wfes_single",
               ["--absorption", "-N", "100", "-s", "0.02", "--csv"])
    check(proc.returncode == 0, "wfes_single --csv: exits 0",
          f"exit={proc.returncode}")
    lines = [ln for ln in proc.stdout.splitlines() if ln.strip()]
    if not check(len(lines) >= 2, "wfes_single --csv: header plus a data row",
                 repr(lines)):
        return
    values = lines[1].split(",")
    widest = max((significant_digits(v) for v in values), default=0)
    check(widest > 10,
          "wfes_single --csv: at least one value carries >10 significant digits",
          f"widest={widest} row={lines[1][:160]!r}")

    # The same run under --json must be unchanged in precision (JSON already
    # had it), which is what makes this a CSV-only change.
    jproc = run(bindir / "wfes_single",
                ["--absorption", "-N", "100", "-s", "0.02", "--json"])
    jvals = [v for v in re.findall(r":\s*([-\d.eE+]+)", jproc.stdout)]
    check(max((significant_digits(v) for v in jvals), default=0) > 10,
          "wfes_single --json: still carries >10 significant digits")

    # And no CSV row may carry a bare nan/inf token: that is the formatter's
    # last-line-of-defence policy, seen from outside.
    check(re.search(r"(?<![A-Za-z])(nan|-?inf|-?Inf|NaN|INF)(?![A-Za-z])",
                    proc.stdout) is None,
          "wfes_single --csv: no bare nan/inf token on stdout")


# --------------------------------------------------------------------------
# 7. Non-finite policy in OutputFormatter
# --------------------------------------------------------------------------
def section_non_finite_policy(bindir: Path):
    print("\n== non-finite values never reach a JSON/CSV stream ==")
    # The per-tool mains now refuse before calling the formatter (that was
    # wave 1's fix), so no CLI input still reaches OutputFormatter carrying a
    # nan -- the formatter guard added here is a last line of defence for
    # exactly that reason and cannot be provoked from outside any more. What
    # IS testable from outside is the invariant it protects: for every mode of
    # the tool most prone to it, stdout either parses or the run failed. A
    # fabricated stand-in binary would test nothing about this code, so none
    # is built.
    modes = [
        (["--absorption", "-N", "50", "-s", "-0.5"], "absorption s=-0.5"),
        (["--fixation", "-N", "50", "-s", "-0.5"], "fixation s=-0.5"),
        (["--allele-age", "-N", "50", "-x", "1"], "allele-age -x 1"),
        (["--establishment", "-N", "50", "-s", "0.02"], "establishment"),
        (["--equilibrium", "-N", "50"], "equilibrium"),
    ]
    bad_token = re.compile(r"(?<![A-Za-z])(nan|-?inf|-?Inf|NaN|INF)(?![A-Za-z])")
    for args, label in modes:
        for fmt in ("--json", "--csv"):
            proc = run(bindir / "wfes_single", args + [fmt])
            text = proc.stdout
            if proc.returncode != 0:
                check(True, f"{label} {fmt}: refused rather than printed")
                continue
            check(bad_token.search(text) is None,
                  f"{label} {fmt}: no bare nan/inf on stdout",
                  bad_token.search(text).group(0) if bad_token.search(text) else "")
            if fmt == "--json":
                try:
                    json.loads(text)
                    ok = True
                except json.JSONDecodeError as exc:
                    ok = False
                    detail = str(exc)
                check(ok, f"{label} --json: stdout parses as JSON",
                      "" if ok else detail)


# --------------------------------------------------------------------------
# 8. wfafs_deterministic banner
# --------------------------------------------------------------------------
def section_banner(bindir: Path):
    print("\n== wfafs_deterministic identifies itself like the other ten ==")
    det = bindir / "wfafs_deterministic"
    args = ["-N", "10", "-G", "10", "-s", "0.01", "-p", "1"]

    proc = run(det, args)
    check(proc.returncode == 0, "wfafs_deterministic plain run: exits 0",
          f"exit={proc.returncode} {proc.stderr.strip()[:160]!r}")
    check("Program: wfafs_deterministic" in proc.stdout,
          "wfafs_deterministic plain run: prints the banner")

    # ...and must NOT print it into a structured stream.
    for fmt in ("--json", "--csv"):
        proc = run(det, args + [fmt])
        check("Program: wfafs_deterministic" not in proc.stdout,
              f"wfafs_deterministic {fmt}: banner suppressed")
        check("█" not in proc.stdout,
              f"wfafs_deterministic {fmt}: no ASCII art in the stream")

    proc = run(det, ["--help"])
    check(proc.returncode == 0, "wfafs_deterministic --help: exits 0",
          f"exit={proc.returncode}")
    check("Program: wfafs_deterministic" in proc.stdout,
          "wfafs_deterministic --help: prints the banner")


# --------------------------------------------------------------------------
# 9. wfafs_stochastic help strings for the refused output flags
# --------------------------------------------------------------------------
def section_wfafs_stochastic_help(bindir: Path):
    print("\n== wfafs_stochastic --help admits which outputs it cannot produce ==")
    proc = run(bindir / "wfafs_stochastic", ["--help"])
    text = proc.stdout
    check(proc.returncode == 0, "wfafs_stochastic --help: exits 0",
          f"exit={proc.returncode}")
    # The flags stay parseable on purpose: the curated runtime refusal is
    # better UX than args' "Flag could not be matched". But the help text may
    # not keep promising a file the tool will never write.
    for flag in ("--output-R", "--output-N-ext", "--output-N-fix",
                 "--output-N-tmo"):
        m = re.search(re.escape(flag) + r"=?\[?path?\]?(.*?)(?=\n\s{2,}-|\Z)",
                      text, re.S)
        blurb = m.group(1) if m else ""
        check("not available" in blurb.lower() or "not produced" in blurb.lower(),
              f"wfafs_stochastic --help: {flag} says it is unavailable for "
              f"this model",
              " ".join(blurb.split())[:160])


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--bin", type=Path, default=DEFAULT_BIN_DIR,
                    help="directory holding the eleven binaries "
                         f"(default: {DEFAULT_BIN_DIR})")
    opts = ap.parse_args()
    bindir: Path = opts.bin

    missing = [t for t in ALL_TOOLS if not (bindir / t).exists()]
    if missing:
        print(f"error: missing binaries in {bindir}: {', '.join(missing)}",
              file=sys.stderr)
        return 2

    print(f"binaries: {bindir}")
    section_observed_copies(bindir)
    section_sgv_distribution_cutoff(bindir)
    section_advisories(bindir)
    section_minimum_population_size(bindir)
    section_non_finite_parameters(bindir)
    section_non_absorbing_boundary_rows(bindir)
    section_library(bindir)
    section_csv_precision(bindir)
    section_non_finite_policy(bindir)
    section_banner(bindir)
    section_wfafs_stochastic_help(bindir)

    print(f"\n{PASS} passed, {FAIL} failed")
    if FAILURES:
        print("failed checks:")
        for f in FAILURES:
            print(f"  - {f}")
    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
