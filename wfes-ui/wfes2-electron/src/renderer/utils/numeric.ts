/**
 * Numeric form-field helpers for model parameters.
 *
 * Views keep parameter fields as strings and must convert them before sending
 * them over IPC. The obvious idiom, `parseFloat(field) || undefined`, is wrong
 * for WFES: it is intended to mean "omit the parameter when the field is
 * blank", but 0 is also falsy, so a deliberately-entered zero is dropped and
 * the solver silently falls back to a default.
 *
 * That matters because zero is a meaningful value for these parameters:
 *   s = 0      neutrality
 *   h = 0      fully recessive allele
 *   u = 0      no backward mutation
 *   v = 0      no forward mutation
 *   alpha = 0  no tail truncation
 *   c = 0      no integration cutoff (used by the recorded absorption baseline)
 *
 * Silently substituting a default for any of these computes a different model
 * than the user asked for and reports no error, which is the worst possible
 * failure mode for a tool used to produce published results.
 */

/**
 * Parse a form field as a float, returning undefined only when the field is
 * genuinely absent or unparseable. A valid 0 is preserved.
 */
export function numOrUndefined(value: string | number | null | undefined): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (value === null || value === undefined) return undefined
  if (value.trim() === '') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * Integer form of {@link numOrUndefined}. A valid 0 is preserved.
 */
export function intOrUndefined(value: string | number | null | undefined): number | undefined {
  const parsed = numOrUndefined(value)
  return parsed === undefined ? undefined : Math.trunc(parsed)
}

/**
 * Pass through an already-computed number, dropping only NaN/Infinity.
 *
 * Use for values derived by arithmetic (e.g. unscaling 2Ns to s), where the
 * input may be NaN because the source field was blank, but 0 is a legitimate
 * result that must survive.
 */
export function finiteOrUndefined(value: number): number | undefined {
  return Number.isFinite(value) ? value : undefined
}
