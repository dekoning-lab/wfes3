/**
 * @file thinSeries.ts
 * @brief Reduce a long series to something a chart can draw, without losing
 *        the features that make it worth looking at.
 *
 * Time-to-substitution distributions run to hundreds of thousands of
 * generations, and recharts renders one SVG node per point: at that size the
 * chart takes tens of seconds to appear, or never appears at all.
 *
 * The obvious fix -- keep every nth point -- is the wrong one for scientific
 * data. Stride sampling lands wherever the modulus lands, so a narrow peak
 * between two sampled indices simply vanishes, and the chart quietly shows a
 * distribution the solver never produced.
 *
 * Instead: divide the series into buckets along x, and from each bucket keep
 * the rows carrying the minimum and maximum of every plotted series. A spike
 * of one point survives, because it is the maximum of its bucket. The first
 * and last rows are always kept so the axes do not shift.
 *
 * Every returned row is a row the solver actually produced -- nothing is
 * averaged, interpolated or invented. What is lost is only the points that
 * would have drawn between the extremes, which at these densities land inside
 * the same pixel anyway.
 */

/**
 * @param rows       the full series, in x order
 * @param yKeys      the keys that will be plotted; extremes of each are kept
 * @param targetPoints  soft ceiling on the returned length
 */
export function thinSeries<T extends Record<string, any>>(
  rows: T[],
  yKeys: string[],
  targetPoints = 2000
): T[] {
  if (!Array.isArray(rows) || rows.length <= targetPoints) return rows
  const keys = yKeys.filter(k => k)
  if (keys.length === 0) return rows

  // Each bucket can contribute up to two rows per key, so the bucket count has
  // to allow for that or the result overshoots the ceiling.
  const buckets = Math.max(1, Math.floor(targetPoints / (2 * keys.length)))
  const bucketSize = rows.length / buckets

  const keep = new Set<number>([0, rows.length - 1])
  for (let b = 0; b < buckets; b++) {
    const start = Math.floor(b * bucketSize)
    const end = Math.min(rows.length, Math.floor((b + 1) * bucketSize))
    if (end <= start) continue
    for (const key of keys) {
      let lo = start
      let hi = start
      for (let i = start; i < end; i++) {
        const v = rows[i][key]
        if (typeof v !== 'number' || !Number.isFinite(v)) continue
        const loV = rows[lo][key]
        const hiV = rows[hi][key]
        if (typeof loV !== 'number' || v < loV) lo = i
        if (typeof hiV !== 'number' || v > hiV) hi = i
      }
      keep.add(lo)
      keep.add(hi)
    }
  }

  return Array.from(keep).sort((a, b) => a - b).map(i => rows[i])
}

/** Sentence for the caption under a thinned chart. Empty when nothing was cut. */
export function thinningNote(shown: number, total: number): string {
  if (shown >= total) return ''
  return (
    `Showing ${shown.toLocaleString()} of ${total.toLocaleString()} points. ` +
    'Peaks and troughs are preserved; export and CSV use every point.'
  )
}
