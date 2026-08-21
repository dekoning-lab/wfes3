/**
 * @file quantityLabels.tsx
 * @brief One naming scheme for every quantity the GUI reports.
 *
 * Before this, the same quantity had a different name in every view. The
 * expected time to fixation appeared as `T_fix` (wfes_single), `T(fixation)`
 * (sequential), `E[T | fixation]` (switching), `E[T_fix]` (time_dist) and
 * `Mean` (phase-type) -- five names, one number. A reader comparing two views
 * had no way to know they were looking at the same thing, and a reader copying
 * results into a manuscript had to invent their own notation anyway.
 *
 * The scheme is the one wfes_single already used, because it is the one that
 * matches the CLI's own JSON keys and it survives being read out of context:
 *
 *   - Subscripted symbols for the quantities themselves: P_ext, T_fix, N_ext.
 *     The symbol carries the *expectation* -- T_fix IS the expected time to
 *     fixation, so there is no E[...] wrapper, exactly as the solver names it.
 *   - Operators for dispersion and for means with no conventional symbol:
 *     SD[T_fix], Var[freq], E[het].
 *   - Subscripts carry indices and conditioning: P_ext,k is the joint
 *     probability for state/epoch k, P_k|ext the conditional.
 *
 * Every row still carries its descriptive sentence -- the abbreviation is safe
 * precisely because the description is always underneath it.
 *
 * `plain` is the ASCII form, used by the Copy buttons so the clipboard reads
 * the same as the screen.
 */
import React from 'react'

export interface Quantity {
  /** ASCII form for clipboard/export, e.g. "SD[T_fix]". */
  plain: string
  /** Rendered form, e.g. SD[T<sub>fix</sub>]. */
  node: React.ReactNode
  /** Sentence shown under the label. */
  description: string
}

/** A subscripted symbol: sym('T','fix') -> T<sub>fix</sub>, plain "T_fix". */
const sym = (base: string, subscript = ''): Omit<Quantity, 'description'> => ({
  plain: subscript ? `${base}_${subscript}` : base,
  node: subscript ? (
    <span>
      {base}
      <sub>{subscript}</sub>
    </span>
  ) : (
    <span>{base}</span>
  )
})

/** An operator over a symbol: op('SD','T','fix') -> SD[T<sub>fix</sub>]. */
const op = (operator: string, base: string, subscript = ''): Omit<Quantity, 'description'> => ({
  plain: `${operator}[${subscript ? `${base}_${subscript}` : base}]`,
  node: (
    <span>
      {operator}[{base}
      {subscript ? <sub>{subscript}</sub> : null}]
    </span>
  )
})

const Q = (spec: Omit<Quantity, 'description'>, description: string): Quantity => ({
  ...spec,
  description
})

/**
 * The registry. Keys are the CLI's JSON key names wherever one exists, so the
 * table, the clipboard and the raw solver output all line up.
 */
export const QUANTITIES = {
  // ---- Probabilities -----------------------------------------------------
  P_ext: Q(sym('P', 'ext'), 'Probability of extinction'),
  P_fix: Q(sym('P', 'fix'), 'Probability of fixation'),
  P_seg: Q(sym('P', 'seg'), 'Probability the allele is still segregating'),
  P_tmo: Q(sym('P', 'tmo'), 'Probability the run times out before absorbing'),
  P_est: Q(sym('P', 'est'), 'Probability of establishment'),

  // ---- Times (each symbol is already an expectation) ---------------------
  T_abs: Q(sym('T', 'abs'), 'Expected time to absorption'),
  T_ext: Q(sym('T', 'ext'), 'Expected time to extinction, given extinction'),
  T_fix: Q(sym('T', 'fix'), 'Expected time to fixation, given fixation'),
  T_tmo: Q(sym('T', 'tmo'), 'Expected time elapsed given the run times out'),
  T_sub: Q(sym('T', 'sub'), 'Expected time to substitution'),
  T_est: Q(sym('T', 'est'), 'Expected time to establishment'),
  T_seg: Q(sym('T', 'seg'), 'Expected time segregating'),
  T_seg_ext: Q(sym('T', 'seg→ext'), 'Expected time from establishment to extinction'),
  T_seg_fix: Q(sym('T', 'seg→fix'), 'Expected time from establishment to fixation'),
  T_age: Q(sym('T', 'age'), 'Expected age of the allele'),
  T_reg1: Q(sym('T', 'reg1'), 'Expected generations in regime 1 — the pre-adaptive wait, equal to 1/λ'),
  T_reg2: Q(sym('T', 'reg2'), 'Expected generations under regime 2 — the sweep itself'),

  // ---- Counts and rates --------------------------------------------------
  //
  // Per-generation, not a per-trajectory total: the solver divides the
  // cumulative copy-generations by 1/(2Nv) + T_ext (wfes_single_main.cpp:448).
  // Computed for the stochastic tunnelling model.
  N_ext: Q(sym('N', 'ext'), 'Mean number of mutants per generation prior to extinction'),
  R_sub: Q(sym('R', 'sub'), 'Substitution rate, 1/T_fix — exact, as fixation is the only absorbing state'),

  // ---- Frequencies and spectra ------------------------------------------
  f_est: Q(sym('f', 'est'), 'Frequency at which fixation probability reaches the establishment threshold'),
  E_freq: Q(op('E', 'freq'), 'Expected allele frequency'),
  E_het: Q(op('E', 'het'), 'Expected heterozygosity, 2p(1−p)'),
  Var_freq: Q(op('Var', 'freq'), 'Variance of the allele frequency'),

  // ---- Allele-frequency spectra -----------------------------------------
  //
  // Deliberately NOT P_ext/P_fix: the spectrum models allele counts at a point
  // in time under recurrent mutation, where 0 and 2N are transient. Mass at 0
  // means the allele is currently absent, not that it is permanently lost.
  P_0: Q(sym('P', '0'), 'Probability the allele is absent (count 0)'),
  P_2N: Q(sym('P', '2N'), 'Probability the allele is fixed (count 2N)'),

  // ---- Distribution diagnostics -----------------------------------------
  P_total: Q(sym('ΣP'), 'Probability mass captured by the computed window'),
  F_max: Q(sym('F', 'max'), 'Largest cumulative probability reached'),

  // ---- Per-state / per-epoch decomposition rows -------------------------
  // k indexes the model state (switching) or the epoch (sequential).
  P_ext_k: Q(sym('P', 'ext,k'), 'Probability of going extinct here; row sums to P_ext'),
  P_fix_k: Q(sym('P', 'fix,k'), 'Probability of fixing here; row sums to P_fix'),
  P_k_ext: Q(sym('P', 'k|ext'), 'Given extinction, the probability it happened here; row sums to 100%'),
  P_k_fix: Q(sym('P', 'k|fix'), 'Given fixation, the probability it happened here; row sums to 100%'),
  P_k: Q(sym('P', 'k'), 'Probability absorption happened here — P_ext,k + P_fix,k'),
  T_k: Q(sym('T', 'k'), 'Expected generations here, whatever the outcome'),
  T_k_ext: Q(sym('T', 'k|ext'), 'Expected generations here given extinction; row sums to T_ext'),
  T_k_fix: Q(sym('T', 'k|fix'), 'Expected generations here given fixation; row sums to T_fix'),
  T_k_tmo: Q(sym('T', 'k|tmo'), 'Expected generations here given a timeout; row sums to T_tmo')
} as const

export type QuantityKey = keyof typeof QUANTITIES

/** Dispersion of a registered quantity: sd('T_fix') -> SD[T_fix]. */
export function sd(key: QuantityKey): Quantity {
  const q = QUANTITIES[key]
  const base = q.plain.replace(/^([A-Za-zΣ]+)(?:_(.*))?$/, '$1')
  const subscript = q.plain.includes('_') ? q.plain.slice(q.plain.indexOf('_') + 1) : ''
  // Reuse the quantity's own description rather than naming the symbol back
  // at the reader: T_abs is "Expected time to absorption", so its dispersion
  // reads "Standard deviation of the time to absorption".
  const of = q.description.replace(/^Expected /, 'the ').replace(/^Probability /, 'the probability ')
  return { ...op('SD', base, subscript), description: `Standard deviation of ${of}` }
}

/**
 * Display formatting: six significant digits, with an exponent for values too
 * large or too small to read as a decimal.
 *
 * The fixed `toFixed(6)` this replaces printed any probability below 5e-7 as
 * "0.000000" -- a genuinely nonzero result shown as zero. Full precision is
 * kept for the clipboard and for Export (see `raw` on the row), so nothing is
 * lost, only made readable.
 */
export function formatQuantity(v: unknown): string {
  const x = typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v) : NaN
  if (!Number.isFinite(x)) return typeof v === 'string' && v.trim() !== '' ? v : '—'
  if (x === 0) return '0'
  const mag = Math.abs(x)
  if (mag >= 1e6 || mag < 1e-4) return x.toExponential(4)
  // toPrecision can still return exponential form; guard, then trim zeros.
  const s = x.toPrecision(6)
  return s.includes('e') ? x.toExponential(4) : s.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')
}

/**
 * Build a results row from the registry.
 *
 * `raw` carries the unrounded value so Copy/Export stay at full precision
 * while the table stays readable.
 */
export function qtyRow(
  key: QuantityKey,
  value: unknown,
  overrides?: { description?: string; display?: string }
): { label: React.ReactNode; plain: string; value: string; raw?: number | string; description: string } {
  const q = QUANTITIES[key]
  return {
    label: q.node,
    plain: q.plain,
    value: overrides?.display ?? formatQuantity(value),
    raw: typeof value === 'number' || typeof value === 'string' ? value : undefined,
    description: overrides?.description ?? q.description
  }
}

/** As `qtyRow`, but for the standard deviation of a registered quantity. */
export function sdRow(
  key: QuantityKey,
  value: unknown,
  overrides?: { description?: string }
): { label: React.ReactNode; plain: string; value: string; raw?: number | string; description: string } {
  const q = sd(key)
  return {
    label: q.node,
    plain: q.plain,
    value: formatQuantity(value),
    raw: typeof value === 'number' || typeof value === 'string' ? value : undefined,
    description: overrides?.description ?? q.description
  }
}

/** A row that is not a model quantity (execution time, notes). */
export function plainRow(
  label: string,
  value: string | number,
  description?: string
): { label: React.ReactNode; plain: string; value: string; description?: string } {
  return { label, plain: label, value: String(value), description }
}
