/**
 * @file switchingDiagrams.ts
 * @brief Build labelled state-transition diagram descriptions for the
 *        switching-family models, from the same form state the views hold.
 *
 * Each adapter mirrors the switching-matrix construction in its CLI main
 * (cited on the function), so the diagram shows the model the run will
 * actually use — including transformations the user never typed: derived
 * diagonal entries, row normalization, and factor scaling.
 *
 * Dwell is labelled as MEAN RESIDENCE TIME rather than a rate. In a
 * discrete-time chain the time spent in state i is geometric with mean
 * 1/(1 - p_ii); for the sequential family that is exactly the G_i the user
 * entered, so the diagram echoes their own input back with structure.
 *
 * Pure functions with no React or Electron imports, so
 * scripts/verify-diagrams.ts can exercise them outside the app.
 */

export interface DiagramState {
  /** Node title, e.g. "Epoch 1" or the user's state name. */
  name: string
  /** Parameter lines shown inside the node, already formatted. */
  paramLines: string[]
  /** Main dwell label, e.g. "Mean stay ≈ 100 gens". */
  residence: string
  /** exact = deterministic schedule; terminal = never leaves. */
  residenceKind: 'geometric' | 'exact' | 'terminal'
  /** Optional extra line, e.g. "then the analysis ends". */
  note?: string
}

export interface DiagramEdge {
  from: number
  to: number
  /** Edge label, e.g. "p = 0.01 /gen". */
  label: string
}

export interface DiagramModel {
  states: DiagramState[]
  edges: DiagramEdge[]
  layout: 'chain' | 'ring'
  /** Footnotes rendered under the diagram. */
  captions: string[]
}

/** Compact numeric formatting for labels. */
export function fmt(x: number): string {
  if (!Number.isFinite(x)) return '∞'
  if (x === 0) return '0'
  const a = Math.abs(x)
  if (a >= 1e5 || a < 1e-3) {
    return x.toExponential(2).replace(/e\+?(-?)0*(\d)/, 'e$1$2')
  }
  return String(parseFloat(x.toPrecision(4)))
}

/**
 * Parameter lines for one state. When the view is in population-scaled mode
 * the user's inputs ARE 2Ns / 4Nu / 4Nv, so they are labelled as such rather
 * than silently relabelled s / u / v.
 */
export function paramLines(
  p: { N?: string; s: string; h: string; u: string; v: string },
  scaled: boolean
): string[] {
  const lines: string[] = []
  if (p.N !== undefined && p.N !== '') lines.push(`N = ${p.N}`)
  lines.push(`${scaled ? '2Ns' : 's'} = ${p.s}`)
  lines.push(`h = ${p.h}`)
  lines.push(`${scaled ? '4Nu' : 'u'} = ${p.u}`)
  lines.push(`${scaled ? '4Nv' : 'v'} = ${p.v}`)
  return lines
}

/**
 * Text measurement for the diagram renderer, pure so the test harness (Node,
 * no canvas) can exercise the same code path. Character-class widths in em,
 * calibrated against system-ui at the diagram's sizes and padded ~6% high on
 * purpose: overestimating wastes a few pixels, underestimating overflows the
 * box -- which is exactly the defect this exists to prevent.
 */
export function estimateTextWidth(
  text: string,
  fontSize: number,
  opts: { mono?: boolean; bold?: boolean; italic?: boolean } = {}
): number {
  if (opts.mono) return text.length * fontSize * 0.64
  let w = 0
  for (const ch of text) {
    if ('iljI.,;:!|\''.includes(ch)) w += 0.30
    else if ('mwMW@'.includes(ch)) w += 0.90
    else if (ch === ' ') w += 0.30
    else if (ch >= 'A' && ch <= 'Z') w += 0.68
    else if (ch >= '0' && ch <= '9') w += 0.58
    else w += 0.53
  }
  w *= fontSize
  if (opts.bold) w *= 1.06
  if (opts.italic) w *= 1.04
  return w * 1.06
}

/** Measure function signature: text -> pixel width. */
export type TextMeasure = (text: string) => number

/**
 * Greedy word-wrap against a pixel budget. Returns at least one line; a
 * single word longer than the budget is hard-split rather than allowed to
 * overflow.
 */
export function wrapText(text: string, maxWidth: number, measure: TextMeasure): string[] {
  if (measure(text) <= maxWidth) return [text]
  const words = text.split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let cur = ''
  const push = () => { if (cur) { lines.push(cur); cur = '' } }
  for (const word of words) {
    const cand = cur ? cur + ' ' + word : word
    if (measure(cand) <= maxWidth) { cur = cand; continue }
    push()
    if (measure(word) <= maxWidth) { cur = word; continue }
    // hard-split an over-long word
    let piece = ''
    for (const ch of word) {
      if (measure(piece + ch) > maxWidth) { lines.push(piece); piece = ch } else piece += ch
    }
    cur = piece
  }
  push()
  return lines.length > 0 ? lines : [text]
}

const GEOMETRIC_CAPTION =
  'Dwell times are geometric (memoryless): "Mean stay" is the expectation; individual histories vary around it.'

/**
 * Circled numeral for a 1-based model-state index — ①, ②, ... — so an edge
 * label like "①→②" reads unmistakably as MODEL STATES rather than quantities
 * (plain "1→2" was easy to misread, and bare letters collide with parameter
 * names). Unicode covers ① through ⑳; beyond that fall back to (n).
 */
export function circled(i: number): string {
  return i >= 1 && i <= 20 ? String.fromCodePoint(0x2460 + i - 1) : `(${i})`
}

const num = (s: string): number => {
  const x = parseFloat(s)
  return Number.isFinite(x) ? x : NaN
}

/**
 * wfes_sequential: epochs visited strictly in order.
 * Mirrors wfes-cli/wfes_sequential/src/wfes_sequential_main.cpp:
 *   switching(i,i) = 1 - 1/G_i ;  switching(i,i+1) = 1/G_i
 * so the mean residence in epoch i is exactly the user's G_i. The final
 * epoch's exit (probability 1/G_n per generation) goes to the timeout state.
 */
export function sequentialDiagram(
  epochs: { name?: string; N: string; s: string; h: string; u: string; v: string; generations: string }[],
  scaled: boolean,
  /** -p distribution over starting epochs; null = CLI default [1, 0, ...]. */
  startProbs: number[] | null = null
): DiagramModel {
  const n = epochs.length
  const start = startProbs && startProbs.length === n ? startProbs : null
  const states: DiagramState[] = epochs.map((e, i) => {
    const G = num(e.generations)
    const p0 = start ? start[i] : i === 0 ? 1 : 0
    // The last-epoch note wins the single note slot; start-probability is
    // shown wherever it is non-zero and the slot is free.
    const startNote = p0 > 0 ? `Start here: ${fmt(p0 * 100)}%` : undefined
    return {
      name: e.name || `Epoch ${i + 1}`,
      paramLines: paramLines(e, scaled),
      residence: `Mean stay ≈ ${fmt(G)} gens`,
      residenceKind: 'geometric',
      note: i === n - 1 ? 'Then the analysis ends (timeout)' : startNote
    }
  })
  // Edge labels are indexed (1→2) and avoid the bare letter p, which WFES
  // uses throughout for the number of starting copies.
  const edges: DiagramEdge[] = epochs.slice(0, -1).map((e, i) => ({
    from: i,
    to: i + 1,
    label: `${circled(i + 1)}→${circled(i + 2)}  1/G${i + 1} = ${fmt(1 / num(e.generations))} /gen`
  }))
  const captions = [GEOMETRIC_CAPTION]
  // Name the flag when an explicit distribution is shown: on wfes_sequential,
  // -p is the starting distribution over EPOCHS (-p distribution), not a
  // starting copy number -- the caption says which one the nodes display.
  captions.push(start
    ? 'Starting epoch distribution as specified (the -p distribution over epochs), shown on the nodes.'
    : 'The process starts in Epoch 1.')
  return { states, edges, layout: 'chain', captions }
}

/**
 * wfafs_stochastic: same chain as wfes_sequential
 * (wfes-cli/wfafs_stochastic/src/wfafs_stochastic_main.cpp), but the CLI first
 * divides G by the approximation factor f and shrinks N by f, so with f != 1
 * the chain the solver actually runs is a 1/f-scale approximation of the model
 * shown. The allele-frequency spectrum is read at the end of the final epoch.
 */
export function wfafsDiagram(
  components: { N: string; G: string; f: string; u: string; v: string; s: string; h: string }[],
  scaled: boolean
): DiagramModel {
  const n = components.length
  const anyFactor = components.some((c) => c.f !== '' && num(c.f) !== 1)
  const states: DiagramState[] = components.map((c, i) => {
    const G = num(c.G)
    const f = num(c.f)
    const factorNote = c.f !== '' && f !== 1 ? `Runs internally at 1/${c.f} scale` : undefined
    return {
      name: `Epoch ${i + 1}`,
      paramLines: paramLines(c, scaled),
      residence: `Mean stay ≈ ${fmt(G)} gens`,
      residenceKind: 'geometric',
      note: i === n - 1 ? 'Spectrum observed at end of this epoch' : factorNote
    }
  })
  const edges: DiagramEdge[] = components.slice(0, -1).map((c, i) => ({
    from: i,
    to: i + 1,
    label: `${circled(i + 1)}→${circled(i + 2)}  1/G${i + 1} = ${fmt(1 / num(c.G))} /gen`
  }))
  const captions = [GEOMETRIC_CAPTION]
  if (anyFactor) {
    captions.push(
      'Approximation factors f rescale each epoch internally (N/f, G/f, s·f, u·f, v·f); the diagram shows the model being approximated.'
    )
  }
  return { states, edges, layout: 'chain', captions }
}

/**
 * wfafs_deterministic: a piecewise-constant demographic SCHEDULE, not a Markov
 * chain — epoch boundaries are fixed generation numbers, so durations are
 * exact, not means. This is the key modelling difference from WFAF-S.
 * Epochs are derived exactly as the view's own parameter builder derives them
 * from the size-change list.
 */
export function wfafdDiagram(
  components: { N: string; G: string; u: string; v: string; s: string; h: string }[],
  scaled: boolean
): DiagramModel {
  // Same epoch list as WFAF-S; the difference is that these durations are exact
  // rather than geometric means. This used to derive epochs from one N plus a
  // list of size changes, because the view only let the population size vary --
  // but wfafs_deterministic takes --s-vec/--h-vec/--u-vec/--v-vec too, so every
  // parameter can change per epoch and the diagram shows each epoch's own.
  const n = components.length
  const states: DiagramState[] = components.map((c, i) => ({
    name: `Epoch ${i + 1}`,
    paramLines: paramLines(c, scaled),
    residence: `Exactly ${fmt(num(c.G))} gens`,
    residenceKind: 'exact',
    note: i === n - 1 ? 'Then the distribution is reported' : undefined
  }))
  // Edges are labelled by the generation the switch happens at, which is the
  // running total of the durations before it.
  const edges: DiagramEdge[] = components.slice(0, -1).map((c, i) => ({
    from: i,
    to: i + 1,
    label: `At generation ${fmt(
      components.slice(0, i + 1).reduce((acc, x) => acc + num(x.G), 0)
    )}`
  }))
  return {
    states,
    edges,
    layout: 'chain',
    captions: [
      'Deterministic schedule: epoch changes happen at fixed generations, so durations are exact — unlike WFAF-S, where they are geometric means.'
    ]
  }
}

/**
 * wfes_sweep: two regimes, one-way switch.
 * Mirrors wfes-cli/wfes_sweep/src/wfes_sweep_main.cpp:
 *   switching << 1-λ, λ, 0, 1
 * Regime 1's dwell is geometric with mean 1/λ; regime 2 is terminal.
 */
export function sweepDiagram(spec: {
  N: string
  lambda: string
  comp1: { s: string; h: string; u: string; v: string }
  comp2: { s: string; h: string; u: string; v: string }
  scaled: boolean
  /**
   * What each regime is called. wfes_sweep and time_dist_sgv are the same
   * two-regime model -- both build `switching << 1-l, l, 0, 1` and pass it to
   * NonAbsorbingToFixationOnly -- but the views name the regimes differently.
   * One builder keeps the structure from drifting between them; the labels are
   * the caller's.
   */
  labels?: { first: string; second: string }
}): DiagramModel {
  const first = spec.labels?.first ?? 'Equilibration'
  const second = spec.labels?.second ?? 'Absorbing'
  const lam = num(spec.lambda)
  return {
    states: [
      {
        name: first,
        paramLines: paramLines({ N: spec.N, ...spec.comp1 }, spec.scaled),
        residence: `Mean stay ≈ ${fmt(1 / lam)} gens`,
        residenceKind: 'geometric'
      },
      {
        name: second,
        paramLines: paramLines({ N: spec.N, ...spec.comp2 }, spec.scaled),
        residence: 'Terminal — remains until fixation',
        residenceKind: 'terminal'
      }
    ],
    edges: [{ from: 0, to: 1, label: `${circled(1)}→${circled(2)}  λ = ${fmt(lam)} /gen` }],
    layout: 'chain',
    captions: [
      GEOMETRIC_CAPTION,
      'The switch is one-way: once in regime 2 the model stays there until the allele fixes.'
    ]
  }
}

/**
 * wfes_switching: general n-state chain.
 *
 * Mirrors BOTH transformations between what the user types and what runs:
 *  1. wfesBackendService.buildWfesSwitchingArgs derives each diagonal as
 *     max(0, 1 - Σ off-diagonal exits) — the user only enters exit rates.
 *  2. wfes-cli/wfes_switching/src/wfes_switching_main.cpp normalizes every row
 *     to sum to 1 (rows with exits summing above 1 are rescaled).
 * Mean residence is then 1/(1 - p_ii) of the NORMALIZED matrix.
 */
export function generalSwitchingDiagram(
  states: { name: string; N: string; s: string; h: string; u: string; v: string }[],
  rates: { from: number; to: number; p: number }[],
  scaled: boolean,
  /**
   * Start-state distribution, or null for the CLI default (uniform, 1/n each,
   * applied when --starting-prob is omitted). Displayed on each node so the
   * model's starting assumption is visible rather than implicit.
   */
  startProbs: number[] | null = null
): DiagramModel {
  const n = states.length
  const matrix: number[][] = Array.from({ length: n }, () => Array(n).fill(0))
  for (const r of rates) {
    if (r.from >= 0 && r.from < n && r.to >= 0 && r.to < n && r.from !== r.to && Number.isFinite(r.p)) {
      matrix[r.from][r.to] = r.p
    }
  }
  const captions: string[] = [GEOMETRIC_CAPTION,
    'Edge labels i→j are per-generation switching probabilities.',
    'Stay-probabilities (diagonal) are derived as 1 − Σ(exit rates); they are not entered directly.']
  const rescaled: number[] = []
  for (let i = 0; i < n; i++) {
    const exitSum = matrix[i].reduce((a, x, j) => (j === i ? a : a + x), 0)
    matrix[i][i] = Math.max(0, 1 - exitSum)          // GUI-derived diagonal
    const rowSum = matrix[i].reduce((a, x) => a + x, 0)
    if (rowSum > 0 && Math.abs(rowSum - 1) > 1e-9) { // CLI row normalization
      for (let j = 0; j < n; j++) matrix[i][j] /= rowSum
      rescaled.push(i)
    }
  }
  if (rescaled.length > 0) {
    captions.push(
      `Exit rates from ${rescaled.map((i) => states[i]?.name ?? `state ${i + 1}`).join(', ')} sum to more than 1/gen; ` +
      'the CLI rescales those rows to probabilities — the diagram shows the rescaled values actually used.'
    )
  }
  const start = startProbs && startProbs.length === n ? startProbs : null
  if (start) {
    captions.push('Start-state distribution as specified (--starting-prob).')
  } else {
    captions.push(
      'Start-state distribution: uniform (1/n each) — the CLI default when --starting-prob is omitted.'
    )
  }
  const diagStates: DiagramState[] = states.map((s, i) => {
    const pStay = matrix[i][i]
    const terminal = pStay >= 1 - 1e-12
    const p0 = start ? start[i] : 1 / n
    return {
      name: s.name || `State ${i + 1}`,
      paramLines: paramLines(s, scaled),
      residence: terminal
        ? 'Terminal — never leaves'
        : `Mean stay ≈ ${fmt(1 / (1 - pStay))} gens`,
      residenceKind: terminal ? 'terminal' : 'geometric',
      note: `Start here: ${fmt(p0 * 100)}%`
    }
  })
  const edges: DiagramEdge[] = []
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i !== j && matrix[i][j] > 0) {
        edges.push({ from: i, to: j, label: `${circled(i + 1)}→${circled(j + 1)}  ${fmt(matrix[i][j])} /gen` })
      }
    }
  }
  return { states: diagStates, edges, layout: n <= 2 ? 'chain' : 'ring', captions }
}
