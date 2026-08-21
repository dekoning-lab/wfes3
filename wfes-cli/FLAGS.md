# WFES3 command-line flags — the canonical table

**One short letter, one meaning, across all eleven tools.** This file is the
single source of truth for that invariant, and it is machine-checked:

```sh
python3 wfes-cli/scripts/check_flag_collisions.py --bin <build>/bin
```

That command is the CI entry point. It runs every tool's `--help`, rebuilds the
short-flag map from what the binaries actually advertise, and exits nonzero if
any letter is bound to two long names, if any letter's value type diverges
outside the documented list below, if a tool advertises a long alias, or if any
re-purposed letter fails to error. Pointed at the shipped v3.0.0-beta.3
binaries it reports 33 problems; pointed at a build of this source it exits 0.

Status: implements the PI-approved canonicalization
(`WFES3-FLAG-CANONICALIZATION-PROPOSAL.md`, approved 2026-08-21), whose
governing rule is that **a flag must never silently change meaning.**

---

## 1. The canonical short flags

| Flag | Long name | Value | Tools |
|---|---|---|---|
| `-N` | `--pop-size` | `int` / `int[k]` † | all 11 |
| `-s` | `--selection` | `float` / `float[k]` † | all 11 |
| `-h` | `--dominance` | `float` / `float[k]` † | all 11 |
| `-u` | `--backward-mu` | `float` / `float[k]` † | all 11 |
| `-v` | `--forward-mu` | `float` / `float[k]` † | all 11 |
| `-a` | `--alpha` | `float` | all 11 |
| `-i` | `--initial` | `path` | all 11 |
| `-c` | `--integration-cutoff` | `float` | 10 (not phase_type_moments) |
| `-t` | `--num-threads` | `int` | 10 (not wfes_sequential — see §3) |
| `-l` | `--library` | `library` | 9 (not wfes_sweep, time_dist_sgv — see §3) |
| `-b` | `--block-size` | `int` | wfes_single, the 4 dist tools, phase_type_moments, wfafs_deterministic |
| `-d` | `--distribution-cutoff` | `float` | time_dist, time_dist_dual, time_dist_sgv, phase_type_dist |
| `-m` | `--max-t` | `int` | time_dist, time_dist_dual, time_dist_sgv, phase_type_dist |
| `-r` | `--no-recurrent-mu` | switch | the 4 dist tools + wfes_single, phase_type_moments |
| `-p` | `--starting-copies` | `int` | wfes_single, wfes_sweep, wfafs_stochastic, wfafs_deterministic |
| `-P` | `--starting-prob` | `float[k]` | wfes_switching, wfes_sequential |
| `-e` | `--exp-time` | `float[k]` | wfes_sequential |
| `-L` | `--lambda` | `float` | wfes_sweep, time_dist_sgv |
| `-R` | `--switching` | `float[k][k]` | wfes_switching |
| `-G` | `--generations` | `float[k]` / `int[k]` † | wfafs_stochastic, wfafs_deterministic |
| `-f` | `--factor` | `float[k]` | wfafs_stochastic |
| `-k` | `--n-moments` | `int` | phase_type_moments |
| `-x` | `--observed-copies` | `int` | wfes_single |
| `-o` | `--output-file` | `output_file` | wfafs_deterministic |

† Documented arity/type flip — see §2.

Long-only options (no short letter, deliberately): `--odds-ratio`,
`--num-moments`, `--starting-copies` in wfes_sequential, `--num-threads` in
wfes_sequential, `--library` in wfes_sweep and time_dist_sgv, every
`--output-*`, `--force`, `--verbose`, `--json`, `--csv`, `--no-project`, and
each tool's model-type switches (`--absorption`, `--fixation`, …).

## 2. Documented arity and type flips

These six letters keep the same concept and the same long name in every tool,
and differ only in how many values they take (and, for `-G`, in whether the
count is exact or expected). The flips are kept, not fixed: a single-model tool
taking `-s 0.01` and a five-epoch tool taking `-s 0,0,-0.1,0,0.01` is the
natural spelling in both cases. What the audit found missing was any statement
of the convention, so each multi-model tool's `--help` now says "one entry per
epoch" or "one entry per model" on every one of them.

| Flag | Scalar in | Vector in |
|---|---|---|
| `-N --pop-size` | the 7 single-model tools | wfes_switching, wfes_sequential, wfafs_stochastic, wfafs_deterministic |
| `-s --selection` | wfes_single, time_dist, time_dist_dual, phase_type_dist, phase_type_moments | wfes_sweep, wfes_switching, wfes_sequential, time_dist_sgv, wfafs_stochastic, wfafs_deterministic |
| `-h --dominance` | as `-s` | as `-s` |
| `-u --backward-mu` | as `-s` | as `-s` |
| `-v --forward-mu` | as `-s` | as `-s` |
| `-G --generations` | — | `float[k]` (expected) in wfafs_stochastic, `int[k]` (exact) in wfafs_deterministic |

`check_flag_collisions.py` holds exactly this list in `DOCUMENTED_ARITY_FLIPS`
and rejects any other divergence. Adding a flip means adding it to both places,
with the reason.

## 3. Re-purposed letters: hard errors, not silent rebinds

Six letters changed meaning. In the tool that previously bound each one to
something else, the letter now parses as **nothing at all**: supplying it exits
nonzero with a message naming the old meaning and the new spelling, and the run
never reaches the solver.

This is the whole point of the exercise. `wfes_sequential -t 8` has always meant
"an epoch whose expected length is 8 generations". Rebinding `-t` to
`--num-threads` would have turned every such invocation into an eight-thread run
of a *different model*, with no warning and a perfectly plausible answer. The
same goes for `wfes_sweep -l 0.5`, where `-l` means `--library` in nine other
tools. Erroring loudly on the seam is what satisfies the audit's one absolute
rule.

| Tool | Letter | Used to mean | Now use |
|---|---|---|---|
| wfes_sequential | `-t` | `--exp-time` | `-e/--exp-time`; threads via `--num-threads` |
| wfes_sequential | `-p` | `--starting-prob` | `-P/--starting-prob`; or `--starting-copies` |
| wfes_switching | `-p` | `--starting-prob` | `-P/--starting-prob` |
| wfes_switching | `-r` | `--switching` | `-R/--switching` |
| wfes_single | `-m` | `--no-recurrent-mu` | `-r/--no-recurrent-mu` |
| wfes_single | `-k` | `--odds-ratio` | `--odds-ratio` (long form only) |
| phase_type_moments | `-m` | `--no-recurrent-mu` | `-r/--no-recurrent-mu` |
| wfes_sweep | `-l` | `--lambda` | `-L/--lambda`; library via `--library` |
| time_dist_sgv | `-l` | `--lambda` | `-L/--lambda`; library via `--library` |

Every trap message follows one form, built by `moved_flag_message()`:

```
-t previously meant --exp-time in wfes_sequential and now means --num-threads
across WFES; use -e/--exp-time or --num-threads explicitly
```

Traps are not listed in `--help`: a guard rail is not an option. They are
implemented as hidden `args::ActionFlag`s (see `MovedShortFlag` in
`args_parser.hpp`) so the error is raised inside `ParseCLI`, before any value
is stored.

### Where a letter is now unavailable

Three tools lose the short form of a flag they still support, because the
letter is occupied by a trap for one release:

* wfes_sequential — threads: `--num-threads` only; a fixed first-epoch count:
  `--starting-copies` only.
* wfes_sweep, time_dist_sgv — solver backend: `--library` only.

These can take their canonical letters once the traps are retired.

## 4. Renamed long names: silent aliases, kept indefinitely

A displaced *letter* hard-errors because the same letter meant something else
somewhere. A renamed *long* name has no such ambiguity, so the old spelling
keeps working, forever, with no warning — and is simply not advertised, so
`--help` shows one name per concept.

| Canonical | Also accepted | Tools |
|---|---|---|
| `--pop-size` | `--pop-sizes` | wfes_switching, wfes_sequential, wfafs_stochastic, wfafs_deterministic |
| `--starting-copies` | `--initial-count` | wfafs_stochastic, wfafs_deterministic |

Both aliases are load-bearing today: the GUI's argument builders
(`wfes-ui/wfes2-electron/src/main/wfesBackendService.ts`) emit `--pop-sizes` for
all four vector tools and `--initial-count` for wfafs_stochastic.

One alias was *removed* rather than kept: time_dist_sgv's `--threads`. It named
the same `int` as `--num-threads`, so it was never a second meaning — but it was
a second advertised spelling, which is the thing this table exists to prevent.

Implementation: `AliasedValueFlag` in `args_parser.hpp`. The alias has to live
in the same `args::Matcher` as the canonical name (a separate flag object would
break `Options::Required`, which args validates per object), so the alias is
suppressed from the help text rather than from the matcher.

## 5. Where the flags are defined

* `wfes-cli/src/core/args_parser.cpp` — nine of the eleven tools.
* `wfes-cli/wfes_sweep/src/wfes_sweep_main.cpp` — wfes_sweep's own parser.
* `wfes-cli/wfafs_deterministic/src/wfafs_deterministic_main.cpp` —
  wfafs_deterministic's own parser.

Tests: `baseline_tests/test_flag_canonicalization.py` (traps, new bindings,
aliases, and the checker's own negative control against the shipped binaries).
