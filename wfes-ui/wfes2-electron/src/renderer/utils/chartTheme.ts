/**
 * @file chartTheme.ts
 * @brief One palette for every chart, drawn from the app's own colours.
 *
 * The charts had each picked their own hues -- Tailwind 400-level pastels
 * (#60a5fa, #f87171, #34d399, ...) in an app themed with Mantine, whose primary
 * is #228be6. That is why they read as belonging to a different program.
 *
 * Two things were also wrong rather than merely mismatched:
 *
 *   - Those hues sat above the OKLCH lightness band for a dark surface
 *     (0.48-0.67), so they glowed against it.
 *   - The adjacent red and green (#f87171 / #34d399) separated by only
 *     deutan dE 6.5, which is the classic red-green confusion: a
 *     deuteranopic reader could not reliably tell the two series apart.
 *
 * The palette below is Mantine's own scale snapped into the dark band, and it
 * passes all five checks of the dataviz validator against every surface the app
 * paints (#1f2937 panels, #2e2e2e and #242424 modals, #1a1a1a body):
 *
 *   lightness band   all inside L 0.48-0.67
 *   chroma floor     all >= 0.1
 *   CVD separation   worst adjacent dE 11.3 (deutan), 12.7 (tritan)
 *   normal vision    worst adjacent dE 16.2
 *   contrast         all >= 3:1 on surface
 *
 * Reproduce the check with the dataviz validator:
 *
 *   node validate_palette.js "#228be6,#e8590c,#0ca678,#be4bdb,#e64980,#4c6ef5" \
 *     --mode dark --surface "#242424"
 *
 * Slot order is fixed. Assign hues by position and never cycle: a series keeps
 * its colour when a sibling is toggled off, so the reader's mapping survives.
 */

/** Categorical hues, in assignment order. Mantine blue-6, orange-8, teal-7, grape-6, pink-7, indigo-6. */
export const SERIES = [
  '#228be6',
  '#e8590c',
  '#0ca678',
  '#be4bdb',
  '#e64980',
  '#4c6ef5'
] as const

/** Slot 1: the app's own primary, for a chart with a single series. */
export const PRIMARY = SERIES[0]

/** Slot 2: the second measure on a two-series chart (a PDF and its CDF). */
export const SECONDARY = SERIES[1]

/**
 * Ink and furniture, from the app's theme rather than invented per chart.
 * Axis and tick text takes a text token, never the series colour -- a chart
 * whose axis label is painted the same blue as its line says the label is data.
 */
export const INK = {
  /** Primary text (Mantine dark-mode body text, as sampled from the app). */
  text: '#e0e0e0',
  /** Dimmed text: axis ticks, captions. */
  muted: '#828282',
  /** Grid and axis lines -- recessive, close to the surface. */
  grid: '#424242',
  /** Tooltip surface and its border, matching the app's panels. */
  tooltipBg: '#1f2937',
  tooltipBorder: '#424242'
} as const

/** Colour for slot i, never cycled: past the last slot, callers should group into "other". */
export function seriesColor(i: number): string {
  return SERIES[i] ?? INK.muted
}
