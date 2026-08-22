# baseline_tests

Regression and integrity suites for the WFES3 command-line tools.

## Running everything

```sh
cmake -S wfes-cli -B wfes-cli/build -DCMAKE_BUILD_TYPE=Release
cmake --build wfes-cli/build -j8
python3 baseline_tests/run_all_suites.py --bin wfes-cli/build/bin
```

`run_all_suites.py` invokes every suite in this directory against one build
directory, aggregates the per-suite check counts, and exits nonzero if any
suite fails or if any suite's count has moved. It is the only invocation you
need; the individual suites remain independently runnable and unchanged.

Useful flags: `--jobs N` (default 4), `--only SUBSTR` (repeatable; a partial
run always exits nonzero so it cannot be mistaken for a full green),
`--verbose`, `--timeout SECONDS`.

### Prerequisites

* A build of the CLI. Any build directory works.
* `/Applications/WFES3.app`, the shipped v3.0.0-beta.3 reference.
  `test_invalid_output_single.py` **requires** it and exits 2 without one;
  `test_flag_canonicalization.py`, `test_degenerate_wfafs_deterministic.py`
  and `test_degenerate_wfafs_stochastic.py` skip sections without it, which
  lowers their counts and surfaces as `CHECKS LOST`. If those three drop
  together, check the app is installed before hunting a regression.

## The counts are the contract

`EXPECTED` in `run_all_suites.py` records each suite's check count, and any
mismatch fails the run.

This exists because two separate reviews flagged the same drift class: **a
suite can lose checks while still printing PASS.** Delete a test function, let
an early `return` skip a section, or let a `continue` cut a loop short, and the
suite reports success over less coverage than yesterday. Green stays green
while coverage falls.

Demonstrated, not assumed. Removing one call from
`test_degenerate_wfafs_sweep.py`'s `main()` makes that suite print

```
PASSED 41/41 checks
```

— a clean pass, six checks lighter. The runner reports:

```
test_degenerate_wfafs_sweep.py      47     41     0    0.5s  CHECKS LOST (6 fewer than recorded)
```

Both directions fail:

| Condition | Status | Meaning |
|---|---|---|
| fewer checks than recorded | `CHECKS LOST` | the dangerous direction — a section stopped running, or checks were deleted |
| more checks than recorded | `COUNT ROSE` | coverage was added; record it in `EXPECTED` in the same commit |
| summary line unparseable | `UNPARSEABLE SUMMARY` | a suite changed its final line; teach the runner, don't let it contribute zero |
| exit code 2 | `COULD NOT RUN` | missing binary or missing required reference — not a pass |

Exact match rather than "at least N" is deliberate: an at-least rule lets you
delete five real checks and add five trivial ones and see nothing.

**Never adjust a number in `EXPECTED` to turn a red run green without first
establishing which checks moved and why.** Updating it is a deliberate act with
a diff, exactly like the recorded md5s and recorded values in the suites
themselves.

## stderr-scope convention

**The nan/inf token sweep scans stdout only. stderr is asserted against
expected diagnostic substrings and is never swept for tokens.**

The two streams carry opposite obligations:

* **stdout is the published result.** A bare `nan` or `inf` there is not valid
  JSON — `json.load` and `JSON.parse` both reject it, and `jq` silently coerces
  it to `1.7976931348623157e+308`, so a pipeline consumes a plausible-looking
  fake number. A non-finite token on stdout is always a defect.
* **stderr is where the tool explains itself.** A good diagnostic often has to
  name the value it is refusing — "rate would be 1/0 = inf" is a *better*
  message than one that omits the number.

Sweeping the combined streams makes the better diagnostic the failing one, and
pushes tool authors toward vaguer messages to keep the suite green. That is the
wrong incentive, so the sweep is scoped to stdout.

Suites here used to disagree — `test_degenerate_wfafs_sweep.py`'s stream
accessor joined both by default, and two healthy-run sites in the wfafs
deterministic/stochastic suites swept both — so a check moved between suites
changed meaning silently. They were aligned in task C6 (2026-08-21) and each
suite's docstring now states its own scope.

Two clarifications:

* Helpers that return **both** streams still exist (`text()`, `both_text()`,
  `output()`). They are for the human-readable **detail of a failed check**, and
  for **expected-substring** assertions where a message may legitimately go to
  either stream. Neither is a token sweep; the convention does not constrain
  them.
* `test_numeric_switching_sequential.py` asserts something stronger for its own
  cases: every case there is healthy, so stderr must be **empty**. Its `-P`
  vectors are supplied pre-normalised (`0.75,0.25`, not `3,1`) precisely so no
  legitimate advisory is expected.

## The suites

`validate_baselines.py` is the original numerical harness, checking
`wfes_single` against reference outputs recorded from Ivan Krukov's wfes2. The
rest were written during the 2026-08 integrity audit, one per investigation;
each docstring states the defect it was written for and what it locks shut.

| Suite | Covers |
|---|---|
| `validate_baselines.py` | `wfes_single` vs the recorded wfes2 baselines |
| `test_invalid_output_single.py` | `wfes_single`: refuse-don't-substitute, dense independent reference |
| `test_single_output_matrix.py` | `wfes_single`: matrix/vector outputs, establishment, disclosed omissions |
| `test_degenerate_switching_sequential.py` | `wfes_switching` / `wfes_sequential`: degenerate inputs, JSON provenance, CSV schema |
| `test_numeric_switching_sequential.py` | `wfes_switching` / `wfes_sequential`: recorded values, cross-tool anchored |
| `test_degenerate_time_dist_family.py` | `time_dist*`, `phase_type_moments`: truncation disclosure, non-finite refusal |
| `test_degenerate_wfafs_deterministic.py` | `wfafs_deterministic`: psi-boundary nan spectrum |
| `test_degenerate_wfafs_stochastic.py` | `wfafs_stochastic`: vector-length and psi guards, healthy-output locks |
| `test_degenerate_wfafs_sweep.py` | `wfes_sweep` / `wfafs_stochastic`: degenerate cutoff, unwritten output flags |
| `test_shared_parser.py` | the shared argument parser and `OutputFormatter`, all eleven tools |
| `test_flag_canonicalization.py` | short-flag canonicalization: traps, new bindings, long aliases |
| `test_paru_multirhs.py` | ParU vs the default backend, multi-RHS solves |

### Recorded values, and what a recording is worth

Several suites lock recorded artifacts: md5 digests of healthy output, or
reference numbers. A recording detects **change**; on its own it certifies
nothing about **correctness**, and a value that was wrong when recorded gets
locked in and defended against every future fix.

Where an independent basis exists, the suites establish one and say so:

* `test_numeric_switching_sequential.py` anchors its table on a **cross-tool**
  identity — one-model `wfes_switching` (`-R 1 -P 1`) is mathematically the
  plain absorbing Wright-Fisher chain that `wfes_single` computes through a
  separate code path, so the two must agree. They agree bit-for-bit. That
  anchor is asserted live on every run and **gates** the recorded section: if
  it fails, the recorded values are not reported as passing, because their
  independent basis has just been invalidated.
* `test_invalid_output_single.py` and `test_single_output_matrix.py` recompute
  absorption quantities from scratch in pure Python (dense LU on the
  Wright-Fisher matrix) and compare.
* `test_paru_multirhs.py` compares two independent solver backends.

When adding a recorded value, establish its basis first and write the
provenance down: which commit, which date, which build type, which backend, and
what independently corroborates it.

> **Injection renormalization.** Commit `fe35e72` ("Stop renormalizing the
> injection weights by a cancelled subtraction") changed every quantity
> integrated over the mutational injection distribution, and `28cd2e4` took the
> cancelled factor back out of the recorded references. Values recorded before
> `fe35e72` are not comparable with values recorded after it. A *bulk* mismatch
> against an older binary is that change, not a regression — check the commit
> before concluding anything.

## Adding a suite

1. Write it standalone, stdlib-only, taking `--bin DIR` and exiting 0 only on
   full success, 2 if it could not run.
2. State the defect it locks shut in the module docstring, and its stderr scope.
3. Add a row to `EXPECTED` in `run_all_suites.py` with its check count, and a
   parser for its summary line if it does not print one of the existing
   formats.

`validate_baselines.py` is frozen except by explicit approval. Its run
instructions live here and in the runner's docstring rather than in the file.
