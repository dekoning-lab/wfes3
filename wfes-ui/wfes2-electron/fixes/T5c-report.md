# T5c Report

*No pre-existing T5b/T5c review report was found at this path (or anywhere
else in the repository, tracked or untracked, on any branch) when this fix
round began. This file is therefore created fresh here rather than appended
to prior content -- the "## Fix round" heading below is kept as instructed,
but there is no earlier section above it to append after.*

## Fix round

Branch: `integrity-fixes`. Scope: the two Importants and six minors from the
combined T5b/T5c review, confined to `src/renderer/views/WfesSingleViewMantine2.tsx`,
`src/renderer/views/WfafsViewMantine.tsx`, and `scripts/verify-previews.mjs`
(all paths relative to `wfes-ui/wfes2-electron`).

### Important 1 -- canWriteI must require a SET starting count in fundamental

`canWriteI`'s `--fundamental` clause checked only `sojournScope === 'single'`;
with the count field blank, `-p` was dropped (`intOrUndefined` -> `undefined`)
while `--output-I` could still be emitted if Write I was checked, which the
CLI's mode-scoped `RUNTIME_REFUSALS` rule (`--fundamental && !--starting-copies`)
refuses at runtime.

- (a) Fixed: `canWriteI`'s fundamental clause now also requires
  `validateStartingCopies()`. That function is relocated earlier in the
  component (it now has a second caller, ahead of its use); its original site
  is left as a one-line pointer comment.
- (b) The `executeModel` gate for this exact scenario (fundamental + single
  scope + invalid count) was **already present** in the source as a separate
  `if` block before this round started (own alert, distinct from the
  "Fixed p" gate) -- confirmed by reading the code and by the baseline harness
  run below, where `single refusal: sojourn single count with blank count
  refuses to run` already passed pre-fix. No change was needed for (b); it is
  left as two separate, distinctly-worded `if` blocks rather than merged into
  one `||` condition, since the current structure already gives the user two
  different, more specific error messages.
- (c) Harness entry added (`scripts/verify-previews.mjs`, `single` spec's
  `htmlExpect`): fundamental + single scope + blank count. Implemented via
  `htmlExpect`, not `spec.states`, because `spec.states` requires a
  successful execution (asserts `argvLine` is non-null) and gate (b) above
  already refuses to run this exact state -- a `states` entry would fail
  "no argv spawned" regardless of whether `canWriteI` itself were fixed.
  `htmlExpect` was extended to accept an inline `overrides` field (falling
  back to its previous by-name lookup in `spec.states` when absent), so this
  check can render the state without needing it to also be a `states` entry;
  it only inspects the static markup `canWriteI` controls, decoupled from
  execution entirely.

**RED-first evidence**: with the harness entry in place and `canWriteI`
temporarily reverted to its pre-fix form (`sojournScope === 'single'` only),
the harness reported exactly one failure:

```
FAIL single [fundamental, single scope, blank count]: markup lacks "requires a single starting count" (Write I must say why it is disabled when Sojourn Times/"One starting count" is left blank (canWriteI must require a SET count))
```

193 checks ran, 1 failure -- nothing else regressed. `canWriteI`'s fix was
then restored and the file's md5 checksum confirmed byte-identical to the
pre-revert state (`f48dbfdd2c1a8f965b56d2ce2970e917`); harness back to 193/0.

### Important 2 -- checked-value assertion must reach the single view

`assertControlWired`'s three-part check (exists + enabled + `checked===true`)
ran only for `stateProbes`. All eleven of the single view's per-control
probes were `paramsProbes` (existence + enabled only), so the mis-binding
class -- a checkbox reading/writing the wrong key -- was unguarded on exactly
the view CX1b had just rewired.

Fixed: the nine write-flag probes (Write Q, R, B, N, N_Ext, N_Fix, I, E, V)
are converted to `stateProbes` using `{ boolNth: false, occurrence: N }`,
where `N` is that field's own position among the component's
`useState(false)` calls, counted from the top: 0 = `optionsDrawerOpen`,
1 = `mutationOnly`, so the nine write flags occupy 2..10 in declaration
order -- verified by reading the source top to bottom, not assumed.
`controlTargetFromOverrides` was extended to also recognise a
`boolNth`/`strNth` override (previously it understood only `{ patch }`),
since these fields have no `outputOptions` object to patch a key on. Write E
and Write V additionally carry their mode-switch override (`absorption` ->
`equilibrium`/`fundamental`) and a matching `base`, since those flags are
refused outside their own mode. Force and "Disable recurrent mutation" stay
as `paramsProbes` (not write flags; not part of the nine).

**RED-demo evidence**: Write R's checkbox was temporarily re-bound
(`checked={writeR}` -> `checked={writeB}`). The harness reported exactly one
failure:

```
FAIL single probe Write R: control "Write R" renders checked=false, expected true (bound to the wrong key?)
```

193 checks, 1 failure -- nothing else regressed. Reverted; md5 confirmed
byte-identical to the pre-mis-binding state (same checksum as above). Harness
back to 193/0.

### Minors

3. `buildCommandLine`'s starting-copies preview emission now goes through
   `intOrUndefined` (was a bare `parseInt` guarded only by `startingCopies
   !== ''`, so a non-numeric count rendered `--starting-copies NaN` in the
   preview while the run's own `intOrUndefined` sent no flag at all).
4. `assertControlWired` now binds by label through a uniqueness assertion
   (`.filter` + "expected exactly one control labelled X"), not `.find`'s
   first-match.
5. The `paramsProbes` state lookup now matches state names exactly
   (`s.name === probe.state`) instead of by `startsWith` prefix, fixing the
   latent `'equilibrium'` vs `'equilibrium (initialMode stuck on file)'`
   collision -- it previously resolved correctly only because `'equilibrium'`
   iterates first in the array, not because the lookup was actually correct.
6. The six remaining single-view disabled reasons (Write R, B, N, N_Ext,
   N_Fix, I) move from a sibling `<Text>` into the Checkbox's own
   `description` prop, matching the pattern Write E/V already used. Scope
   note: the corresponding `htmlExpect` entries (whole-page substring checks)
   were kept rather than moved to the stronger per-control `disabledControls`
   mechanism -- `disabledControls` renders one shared state
   (`disabledControlStates[0]`) for every entry in a spec, and these six
   controls are disabled in four *different*, mutually exclusive modes from
   each other and from Write E/V, so no single shared render state could
   exercise all eight. Extending `disabledControls` to support a per-entry
   state was judged out of scope for a minor with no such mechanism change
   prescribed; flagging here in case the reviewer wants that follow-up.
7. `WfafsViewMantine`: "Fixed p" with a blank count previously ran and
   silently integrated (`wfafs_stochastic` falls back to its own internal
   integration-cutoff default when it gets neither `--initial-count` nor
   `--integration-cutoff`). Added the same execute-path gate the other
   fixed-count views have, plus a `refusalProbes` entry. This gate's addition
   made one pre-existing harness state (`wfafs`'s `'blank alpha and initial
   count'`) start failing, since it blanked `commonParams.p` (now correctly
   refused before argv-building) in the same override as alpha -- split into
   a `'blank alpha'` state (p untouched) plus the new `refusalProbes` entry,
   which now covers p's blank case with a strictly stronger guarantee (refuses
   to run, rather than "ran and omitted the flag"). This is reported per the
   task's instruction to surface rather than paper over a newly-failing
   pre-existing check -- see Verification below for why it is not related to
   the CLI-binaries refresh.
8. Both `executeModel` validation gates in `WfesSingleViewMantine2` now report
   through `setError` (a new `error` state rendered as an inline `Alert` next
   to Results, cleared in `clearResults`) instead of `alert()`. `WfafsViewMantine`
   already had this pattern (`error`/`setError`/`Alert`) from before this
   round; its new gate (minor 7) uses it directly, no `alert()` introduced.
   Out of scope, left unchanged: the two pre-existing, unrelated `alert()`
   calls in `WfesSingleViewMantine2`'s execution-failure/catch paths -- the
   task named "the new gates," which these are not.

### An unrelated concurrent change observed in `verify-previews.mjs`

Partway through this round, a `HIDDEN_ALIASES` block (`checkFlags`'
allowlist for flags renamed by a canonical-flag-table commit but still
accepted under their old spelling -- `--pop-sizes`, and `wfafs_stochastic`'s
`--initial-count`) appeared in the working tree as an uncommitted change this
agent did not author, consistent with this round's task note that
`wfes-cli/build` had been refreshed to final HEAD. It was left in place
as-is (not authored, not modified) and is carried in this round's
`verify-previews.mjs` commit with that attribution stated in the commit
message, because several of this round's own checks (wfafs's, in
particular) depend on it staying green against the refreshed binaries.

## Verification

- `npm run build`: green, before and after every source change in this round.
- `node scripts/verify-previews.mjs`:
  - **Before** (start of this round, working tree as found): **192 checks, 0
    failures**.
  - **After** (all fixes applied): **193 checks, 0 failures**.
  - **Delta**: +1 check overall. This is smaller than the raw count of new
    assertions added (nine converted `stateProbes` each carry their own
    `assertControlWired` check on top of the retained argv check; a new
    `htmlExpect` entry; a new `wfafs` `refusalProbes` entry) because the same
    conversion also **removed** the nine superseded `paramsProbes`
    existence/enabled checks they replaced, and one pre-existing `wfafs`
    `states` entry was split into a narrower one (see minor 7). Net: several
    weak checks were replaced by fewer, strictly stronger ones, plus the
    genuinely new Important-1 and minor-7 entries.
  - No pre-existing check failed because of the `wfes-cli/build` refresh
    itself (the `HIDDEN_ALIASES` addition noted above appears to have already
    absorbed that). The one pre-existing check that DID newly fail
    (`wfafs [blank alpha and initial count]: no argv spawned`) was caused by
    this round's own minor-7 gate, not the binary refresh; see minor 7 above
    for the fix and reasoning.
- RED demonstrations for both Importants: see each section above. Both
  reverts were byte-confirmed via `md5` (identical checksum before the
  temporary break and after the revert) in addition to `diff` reporting no
  difference.

## Commits (branch `integrity-fixes`)

- `ed590fa` -- Require a set starting count before wfes_single can write
  --output-I (`WfesSingleViewMantine2.tsx`: Important 1a, minors 3/6/8)
- `94cec7a` -- Refuse to run WFAF-S "Fixed p" with a blank starting count
  (`WfafsViewMantine.tsx`: minor 7)
- `30da3ad` -- Harden verify-previews.mjs: checked-value probes, exact state
  lookup (`scripts/verify-previews.mjs`: Important 1c, Important 2, minors
  4/5/7-harness, the wfafs states-interaction fix, `HIDDEN_ALIASES`
  attribution)
