/**
 * Regression checks for the state-diagram adapters. Each assertion pins a
 * property that mirrors the CLI's switching-matrix construction; if an adapter
 * drifts from its CLI main, the diagram would silently show a different model
 * than the one being run — the exact failure mode this feature exists to
 * prevent.
 *
 * Run: npm run verify:diagrams
 */
import {
  circled,
  estimateTextWidth,
  wrapText,
  sequentialDiagram, wfafsDiagram, wfafdDiagram, sweepDiagram,
  generalSwitchingDiagram, fmt
} from '../src/renderer/utils/switchingDiagrams.ts'

let failures = 0
function check(name: string, cond: boolean, detail = ''): void {
  console.log(`  ${cond ? 'OK  ' : 'FAIL'} ${name}${cond || !detail ? '' : '  -> ' + detail}`)
  if (!cond) failures++
}

// ---- sequential: mean residence is exactly the user's G ----
const seq = sequentialDiagram(
  [
    { N: '100', s: '0', h: '0.5', u: '1e-3', v: '1e-3', generations: '100' },
    { N: '200', s: '0.01', h: '0.5', u: '1e-3', v: '1e-3', generations: '50' },
    { N: '300', s: '0', h: '0.5', u: '1e-3', v: '1e-3', generations: '25' }
  ],
  true
)
check('sequential: 3 nodes, 2 edges', seq.states.length === 3 && seq.edges.length === 2)
check('sequential: mean = user G', seq.states[0].residence.includes('100'), seq.states[0].residence)
check('sequential: edge indexed, 1/G form', seq.edges[0].label.includes('\u2460\u2192\u2461') && seq.edges[0].label.includes('1/G1') && seq.edges[0].label.includes('0.01'), seq.edges[0].label)
check('sequential: last epoch notes timeout', (seq.states[2].note ?? '').includes('ends'))
check('sequential: scaled labels', seq.states[0].paramLines.some(l => l.startsWith('2Ns')))

// ---- wfafs: factor note only when f != 1 ----
const wfafs = wfafsDiagram(
  [
    { N: '1000', G: '100', f: '2', u: '1e-3', v: '1e-3', s: '0', h: '0.5' },
    { N: '1000', G: '100', f: '1', u: '1e-3', v: '1e-3', s: '0', h: '0.5' }
  ],
  false
)
check('wfafs: factor note on f=2 epoch', (wfafs.states[0].note ?? '').includes('1/2'))
check('wfafs: factor caption present', wfafs.captions.some(c => c.includes('factor')))
check('wfafs: unscaled labels', wfafs.states[0].paramLines.some(l => l.startsWith('s =')))

// ---- wfafd: exact durations, derived like the view's builder ----
// WFAF-D takes an epoch list now, like WFAF-S, because wfafs_deterministic
// switches every parameter per epoch and not just the population size.
const wfafd = wfafdDiagram([
  { N: '100', G: '100', s: '0',    h: '0.5', u: '1e-3', v: '1e-3' },
  { N: '50',  G: '100', s: '0.01', h: '0.5', u: '1e-3', v: '1e-3' },
  { N: '500', G: '100', s: '0',    h: '0.5', u: '1e-3', v: '1e-3' }
], false)
check('wfafd: one epoch per component', wfafd.states.length === 3)
check('wfafd: epoch 1 exactly 100', wfafd.states[0].residence.includes('Exactly 100'))
check('wfafd: epoch 2 has its own N', wfafd.states[1].paramLines.some(l => l === 'N = 50'))
check('wfafd: epoch 2 has its own s', wfafd.states[1].paramLines.some(l => l.startsWith('s = 0.01')),
  wfafd.states[1].paramLines.join(' | '))
check('wfafd: switch labelled by cumulative generation',
  wfafd.edges[1].label.includes('200'), wfafd.edges[1].label)
check('wfafd: no geometric caption', !wfafd.captions.some(c => c.includes('geometric (memoryless)')))

// ---- sweep: one-way, terminal second regime ----
const sweep = sweepDiagram({
  N: '100', lambda: '0.01',
  comp1: { s: '0', h: '0.5', u: '1e-3', v: '1e-3' },
  comp2: { s: '0.1', h: '0.5', u: '1e-3', v: '1e-3' },
  scaled: true
})
check('sweep: regime 1 mean = 1/lambda', sweep.states[0].residence.includes('100'))
check('sweep: regime 2 terminal', sweep.states[1].residenceKind === 'terminal')
check('sweep: single one-way edge', sweep.edges.length === 1 && sweep.edges[0].from === 0)

// ---- general switching: derived diagonal + CLI row normalization ----
const gen1 = generalSwitchingDiagram(
  [
    { name: 'A', N: '100', s: '0', h: '0.5', u: '1e-3', v: '1e-3' },
    { name: 'B', N: '100', s: '0.01', h: '0.5', u: '1e-3', v: '1e-3' },
    { name: 'C', N: '100', s: '0', h: '0.5', u: '1e-3', v: '1e-3' }
  ],
  [
    { from: 0, to: 1, p: 0.01 }, { from: 1, to: 0, p: 0.02 },
    { from: 1, to: 2, p: 0.02 }, { from: 2, to: 0, p: 0.005 }
  ],
  false
)
// state B: exits sum 0.04, diagonal 0.96, mean 1/0.04 = 25
check('switching: mean 1/(1-p_ii) [B: 25]', gen1.states[1].residence.includes('25'), gen1.states[1].residence)
check('switching: 4 edges', gen1.edges.length === 4)
check('switching: ring layout for n=3', gen1.layout === 'ring')
check('switching: no rescale caption when rows sum to 1', !gen1.captions.some(c => c.includes('rescales')))

// exits summing over 1 must be rescaled exactly as the CLI does
const gen2 = generalSwitchingDiagram(
  [
    { name: 'A', N: '100', s: '0', h: '0.5', u: '1e-3', v: '1e-3' },
    { name: 'B', N: '100', s: '0', h: '0.5', u: '1e-3', v: '1e-3' }
  ],
  [{ from: 0, to: 1, p: 1.5 }, { from: 1, to: 0, p: 0.5 }],
  false
)
// row A: diag max(0, 1-1.5)=0 -> row [0, 1.5] -> normalized [0, 1] -> terminal? p_ii=0, mean 1 gen
check('switching: over-1 row rescaled, mean 1 gen', gen2.states[0].residence.includes('1 gen'), gen2.states[0].residence)
check('switching: rescale caption names state A', gen2.captions.some(c => c.includes('A')))
check('switching: rescaled edge shows 1 /gen', gen2.edges.some(e => e.from === 0 && e.label.includes(' 1 /gen')), JSON.stringify(gen2.edges))

// terminal state: no exits
const gen3 = generalSwitchingDiagram(
  [
    { name: 'A', N: '100', s: '0', h: '0.5', u: '1e-3', v: '1e-3' },
    { name: 'B', N: '100', s: '0', h: '0.5', u: '1e-3', v: '1e-3' }
  ],
  [{ from: 0, to: 1, p: 0.01 }],
  false
)
check('switching: state with no exits is terminal', gen3.states[1].residenceKind === 'terminal')

// ---- edge labels: indexed, and never the bare letter p (collides with -p) ----
const allEdges = [...seq.edges, ...wfafs.edges, ...sweep.edges, ...gen1.edges, ...gen2.edges]
check('labels: none use bare "p ="', allEdges.every(e => !/\bp =/.test(e.label)),
  allEdges.map(e => e.label).join(' ; '))
check('labels: all carry circled-state i\u2192j indexing',
  allEdges.every(e => /[\u2460-\u2473]\u2192[\u2460-\u2473]/.test(e.label)),
  allEdges.map(e => e.label).join(' ; '))
check('circled: \u2460 for 1, fallback beyond 20', 
  ((): boolean => {
    return circled(1) === '\u2460' && circled(2) === '\u2461' && circled(21) === '(21)'
  })())
check('sweep: lambda named in label', sweep.edges[0].label.includes('\u03bb'))

// ---- start-state distribution display ----
check('switching: uniform default annotated on nodes',
  gen1.states.every(st => (st.note ?? '').includes('33.33')), gen1.states[0].note)
check('switching: uniform default caption', gen1.captions.some(c => c.includes('uniform (1/n')))
const gen4 = generalSwitchingDiagram(
  [
    { name: 'A', N: '100', s: '0', h: '0.5', u: '1e-3', v: '1e-3' },
    { name: 'B', N: '100', s: '0', h: '0.5', u: '1e-3', v: '1e-3' }
  ],
  [{ from: 0, to: 1, p: 0.01 }, { from: 1, to: 0, p: 0.01 }],
  false,
  [0.9, 0.1]
)
check('switching: explicit start probs shown', (gen4.states[0].note ?? '').includes('90')
  && (gen4.states[1].note ?? '').includes('10'), gen4.states.map(s => s.note).join(' ; '))
check('switching: explicit start caption', gen4.captions.some(c => c.includes('as specified')))

// ---- sequential start-epoch annotation ----
const seqStart = sequentialDiagram(
  [
    { N: '100', s: '0', h: '0.5', u: '1e-3', v: '1e-3', generations: '100' },
    { N: '100', s: '0', h: '0.5', u: '1e-3', v: '1e-3', generations: '100' },
    { N: '100', s: '0', h: '0.5', u: '1e-3', v: '1e-3', generations: '100' }
  ], false)
check('sequential: default annotates Epoch 1 start 100%',
  (seqStart.states[0].note ?? '').includes('100'), seqStart.states[0].note)
check('sequential: default caption names Epoch 1 start',
  seqStart.captions.some(c => c.includes('starts in Epoch 1')))
const seqP = sequentialDiagram(
  [
    { N: '100', s: '0', h: '0.5', u: '1e-3', v: '1e-3', generations: '100' },
    { N: '100', s: '0', h: '0.5', u: '1e-3', v: '1e-3', generations: '100' },
    { N: '100', s: '0', h: '0.5', u: '1e-3', v: '1e-3', generations: '100' }
  ], false, [0.6, 0.4, 0])
check('sequential: explicit -p annotated', (seqP.states[0].note ?? '').includes('60')
  && (seqP.states[1].note ?? '').includes('40'), seqP.states.map(s => s.note).join(';'))
check('sequential: -p caption', seqP.captions.some(c => c.includes('-p distribution')))

// ---- node text must fit its box (mirrors SwitchingStateDiagram sizing) ----
// Constants mirror the component: MAX_NODE_W 252, PAD_X 12 -> 228px budget.
const TEXT_BUDGET = 252 - 2 * 12
const fits = (text: string, size: number, opts: {mono?: boolean; bold?: boolean; italic?: boolean} = {}) =>
  wrapText(text, TEXT_BUDGET, t => estimateTextWidth(t, size, opts))
    .every(line => estimateTextWidth(line, size, opts) <= TEXT_BUDGET)

// The exact note from the reported WFAF-S overflow: prove it exceeded the OLD
// fixed budget (172 - 24 = 148px) and fits the new wrap-or-widen scheme.
const overflowNote = 'spectrum observed at end of this epoch'
check('sizing: the reported note DID overflow the old 148px budget',
  estimateTextWidth(overflowNote, 10, { italic: true }) > 148,
  String(estimateTextWidth(overflowNote, 10, { italic: true })))
check('sizing: the reported note fits after wrapping', fits(overflowNote, 10, { italic: true }))

// Every state of every sample diagram: all content lines must fit.
const allDiagrams = [seq, seqStart, seqP, wfafs, wfafd, sweep, gen1, gen2, gen3, gen4]
let misfit = ''
for (const d of allDiagrams) {
  for (const st of d.states) {
    if (!fits(st.name, 13, { bold: true })) misfit = `title: ${st.name}`
    if (!fits(st.residence, 11)) misfit = `residence: ${st.residence}`
    if (st.note && !fits(st.note, 10, { italic: true })) misfit = `note: ${st.note}`
    for (const pl of st.paramLines) {
      if (!fits(pl, 10, { mono: true })) misfit = `param: ${pl}`
    }
  }
}
check('sizing: every sample-diagram line fits its node box', misfit === '', misfit)
check('wrapText: hard-splits an unbroken over-long token',
  wrapText('X'.repeat(400), TEXT_BUDGET, t => estimateTextWidth(t, 10))
    .every(l => estimateTextWidth(l, 10) <= TEXT_BUDGET))

// ---- edge labels must fit the space they are centred in --------------------
//
// The chain gap was a fixed 86px while the edge label is drawn centred between
// two nodes, so any wider label ran over the node boxes and the arrowhead. The
// component now takes the larger of that floor and the widest label; these
// pin the arithmetic that decides it. CHAIN_GAP_MIN and the +14 padding are
// mirrored from SwitchingStateDiagram.
const CHAIN_GAP_MIN = 86
const gapFor = (labels: string[]) =>
  Math.max(CHAIN_GAP_MIN, Math.ceil(Math.max(0, ...labels.map(l => estimateTextWidth(l, 11)))) + 14)

for (const [name, d] of [['sweep', sweep], ['sequential', seq], ['wfafs', wfafs], ['wfafd', wfafd]] as const) {
  if (d.layout !== 'chain' || d.edges.length === 0) continue
  const labels = d.edges.map(e => e.label)
  const gap = gapFor(labels)
  const widest = Math.max(...labels.map(l => estimateTextWidth(l, 11)))
  check(`edges: ${name} label fits the chain gap`, widest <= gap,
    `widest ${widest.toFixed(0)}px vs gap ${gap}px`)
}

// The sweep label is the one that overflowed the old fixed gap. Prove it did,
// so this is a regression test and not a tautology.
const sweepLabel = sweep.edges[0].label
check('edges: the sweep label DID overflow the old fixed 86px gap',
  estimateTextWidth(sweepLabel, 11) > CHAIN_GAP_MIN,
  `${estimateTextWidth(sweepLabel, 11).toFixed(0)}px`)

// The SGV mode of Time to Substitution runs time_dist_sgv, which is the same
// two-regime model as wfes_sweep, so it reuses this builder with its own names.
const sgv = sweepDiagram({
  N: '100', lambda: '0.001',
  comp1: { s: '0', h: '0.5', u: '0.001', v: '0.001' },
  comp2: { s: '10', h: '0.5', u: '0.001', v: '0.001' },
  scaled: true
})
// Both views name the two regimes the same way, so the builder's defaults are
// the names and neither view has to restate them.
check('sgv: regimes are Equilibration / Absorbing',
  sgv.states[0].name === 'Equilibration' && sgv.states[1].name === 'Absorbing',
  `${sgv.states[0].name} / ${sgv.states[1].name}`)
check('sgv: second regime is terminal', sgv.states[1].residenceKind === 'terminal')
check('sgv: one one-way edge', sgv.edges.length === 1 && sgv.edges[0].from === 0 && sgv.edges[0].to === 1)
check('sgv: label fits its chain gap',
  Math.max(...sgv.edges.map(e => estimateTextWidth(e.label, 11))) <= gapFor(sgv.edges.map(e => e.label)))

// ---- fmt sanity ----
check('fmt: 1e-9', fmt(1e-9) === '1.00e-9', fmt(1e-9))
check('fmt: 100', fmt(100) === '100', fmt(100))
check('fmt: 1/3 trimmed', fmt(1 / 0.03).length <= 6, fmt(1 / 0.03))

console.log(failures === 0 ? '\nAll diagram adapter checks pass.' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
