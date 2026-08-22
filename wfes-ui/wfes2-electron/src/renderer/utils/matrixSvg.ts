/**
 * @file matrixSvg.ts
 * @brief Build a standalone, genuinely vector SVG of a matrix heatmap.
 *
 * The modal's "Export SVG" used to serialise whatever <svg> was on screen, and
 * silently did nothing when there wasn't one. There usually isn't: the chart
 * draws SVG only for matrices of 50 rows or fewer, a canvas up to 200, and a
 * static image above that -- so every matrix anyone actually exports (a 199 x
 * 199 sojourn matrix, a 201 x 201 transition matrix) fell into the silent
 * branch. Generating the SVG from the data instead makes the export independent
 * of how the figure happens to be rendered on screen.
 *
 * Vector, not a wrapped bitmap: an SVG whose only content is an embedded raster
 * would satisfy the file extension while giving up the one property that makes
 * anyone ask for SVG.
 *
 * Runs of equal colour along a row are emitted as a single rect. That is exact
 * -- neighbouring cells that map to the same colour are the same colour -- and
 * it matters, because a Wright-Fisher matrix is banded: most of each row sits at
 * the bottom of the scale, so a 201 x 201 matrix collapses from 40,401 rects to
 * a few thousand. Without it these files run to tens of megabytes.
 */

import { appendStamp, stampHeight, INCH } from './chartStamp'

export interface MatrixSvgOptions {
  data: number[][]
  title: string
  /** Second line under the title, e.g. the parameter set. */
  subtitle?: string
  xLabel?: string
  yLabel?: string
  /** Refuse above this many emitted rects rather than write an unusable file. */
  maxRects?: number
  /** Command that produced the matrix; stamps the provenance block when given. */
  command?: string
  /** Application version, required alongside `command`. */
  version?: string
}

export type MatrixSvgResult =
  | { ok: true; svg: string; rects: number }
  | { ok: false; error: string }

/** The chart's own blue -> white -> red ramp, kept identical so the export matches the screen. */
export function heatColor(value: number, min: number, max: number): string {
  const span = max - min
  const normalized = span === 0 ? 0.5 : (value - min) / span
  if (normalized < 0.5) {
    const t = normalized * 2
    const c = Math.floor(t * 255)
    return `rgb(${c},${c},255)`
  }
  const t = (normalized - 0.5) * 2
  const c = Math.floor(255 - t * 255)
  return `rgb(255,${c},${c})`
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export function buildMatrixSvg(opts: MatrixSvgOptions): MatrixSvgResult {
  const { data, title, subtitle, xLabel = 'End State (j)', yLabel = 'Start State (i)',
          command, version } = opts
  const maxRects = opts.maxRects ?? 300000

  const numRows = data.length
  const numCols = data[0]?.length ?? 0
  if (numRows === 0 || numCols === 0) {
    return { ok: false, error: 'There is no matrix to export.' }
  }

  let min = Infinity
  let max = -Infinity
  for (const row of data) {
    for (const v of row) {
      if (!Number.isFinite(v)) continue
      if (v < min) min = v
      if (v > max) max = v
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return { ok: false, error: 'The matrix holds no finite values to plot.' }
  }

  // Layout, in user units.
  const plot = 800
  const m = { top: subtitle ? 92 : 70, right: 130, bottom: 78, left: 96 }
  const W = m.left + plot + m.right
  const bodyH = m.top + plot + m.bottom
  // Same placement rule as the chart exports: one inch clear of the figure.
  const stamped = Boolean(command && version)
  const stampW = W - 2 * m.left
  const stampTop = bodyH + INCH
  const H = stamped ? stampTop + stampHeight(command!, stampW) + 24 : bodyH
  const cw = plot / numCols
  const ch = plot / numRows

  // Heatmap, run-length encoded along each row.
  const cells: string[] = []
  for (let i = 0; i < numRows; i++) {
    const row = data[i]
    let runStart = 0
    let runColor: string | null = heatColor(row[0] ?? 0, min, max)
    for (let j = 1; j <= numCols; j++) {
      // null marks past-the-end, which closes the final run without needing a
      // sentinel colour string that could in principle collide with a real one.
      const color = j < numCols ? heatColor(row[j] ?? 0, min, max) : null
      if (color !== runColor) {
        const x = m.left + runStart * cw
        const w = (j - runStart) * cw
        cells.push(
          `<rect x="${x.toFixed(3)}" y="${(m.top + i * ch).toFixed(3)}" ` +
          `width="${w.toFixed(3)}" height="${ch.toFixed(3)}" fill="${runColor!}"/>`
        )
        if (cells.length > maxRects) {
          return {
            ok: false,
            error:
              `This ${numRows} x ${numCols} matrix needs more than ${maxRects.toLocaleString()} ` +
              `shapes to draw as vector art, which would produce an SVG too large to open. ` +
              `Export PNG for the picture, or Export Data for the numbers.`
          }
        }
        runStart = j
        runColor = color
      }
    }
  }

  // Axis ticks: up to 10 per axis, labelled by 1-based state index.
  const ticks = (n: number) => {
    const step = Math.max(1, Math.floor(n / 10))
    const out: number[] = []
    for (let k = 0; k < n; k += step) out.push(k)
    if (out[out.length - 1] !== n - 1) out.push(n - 1)
    return out
  }

  const xTicks = ticks(numCols).map(k => {
    const x = m.left + (k + 0.5) * cw
    return `<text x="${x.toFixed(2)}" y="${m.top + plot + 22}" text-anchor="middle" ` +
           `font-family="sans-serif" font-size="13" fill="black">${k + 1}</text>`
  })
  const yTicks = ticks(numRows).map(k => {
    const y = m.top + (k + 0.5) * ch
    return `<text x="${m.left - 10}" y="${y.toFixed(2)}" text-anchor="end" dominant-baseline="middle" ` +
           `font-family="sans-serif" font-size="13" fill="black">${k + 1}</text>`
  })

  // Colour bar.
  const barX = m.left + plot + 28
  const barW = 22
  const barH = plot
  const stops: string[] = []
  const STEPS = 64
  for (let s = 0; s < STEPS; s++) {
    const frac = s / (STEPS - 1)
    stops.push(`<stop offset="${(frac * 100).toFixed(2)}%" stop-color="${heatColor(min + (1 - frac) * (max - min), min, max)}"/>`)
  }
  const fmt = (v: number) =>
    Math.abs(v) >= 1e5 || (v !== 0 && Math.abs(v) < 1e-3) ? v.toExponential(2) : v.toPrecision(4)

  const svg =
`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs><linearGradient id="cbar" x1="0" y1="0" x2="0" y2="1">
${stops.join('\n')}
</linearGradient></defs>
<rect width="${W}" height="${H}" fill="white"/>
<text x="${W / 2}" y="34" text-anchor="middle" font-family="sans-serif" font-size="20" font-weight="bold" fill="black">${esc(title)}</text>
${subtitle ? `<text x="${W / 2}" y="60" text-anchor="middle" font-family="sans-serif" font-size="14" fill="#444">${esc(subtitle)}</text>` : ''}
<g shape-rendering="crispEdges">
${cells.join('\n')}
</g>
<rect x="${m.left}" y="${m.top}" width="${plot}" height="${plot}" fill="none" stroke="black" stroke-width="1"/>
${xTicks.join('\n')}
${yTicks.join('\n')}
<text x="${m.left + plot / 2}" y="${bodyH - 26}" text-anchor="middle" font-family="sans-serif" font-size="15" fill="black">${esc(xLabel)}</text>
<text x="26" y="${m.top + plot / 2}" text-anchor="middle" font-family="sans-serif" font-size="15" fill="black" transform="rotate(-90 26 ${m.top + plot / 2})">${esc(yLabel)}</text>
<rect x="${barX}" y="${m.top}" width="${barW}" height="${barH}" fill="url(#cbar)" stroke="black" stroke-width="0.5"/>
<text x="${barX + barW + 6}" y="${m.top + 10}" font-family="sans-serif" font-size="12" fill="black">${fmt(max)}</text>
<text x="${barX + barW + 6}" y="${m.top + barH / 2}" font-family="sans-serif" font-size="12" fill="black">${fmt((min + max) / 2)}</text>
<text x="${barX + barW + 6}" y="${m.top + barH}" font-family="sans-serif" font-size="12" fill="black">${fmt(min)}</text>
</svg>`

  if (!stamped) return { ok: true, svg, rects: cells.length }

  // Parse, stamp, re-serialise: appendStamp builds DOM nodes, and reusing it
  // is what keeps this block identical to the one on the chart exports.
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
  const root = doc.documentElement as unknown as SVGElement
  appendStamp(root, { command: command!, version: version! }, m.left, stampTop, stampW)
  return {
    ok: true,
    svg: new XMLSerializer().serializeToString(root),
    rects: cells.length
  }
}
