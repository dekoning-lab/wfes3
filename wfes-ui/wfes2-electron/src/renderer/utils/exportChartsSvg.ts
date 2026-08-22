/**
 * @file exportChartsSvg.ts
 * @brief Export every chart in a panel to one SVG.
 *
 * The export handlers each did:
 *
 *     document.querySelector('.recharts-wrapper svg')
 *
 * querySelector returns the FIRST match. In every modal that shows a pair of
 * charts -- extinction beside fixation, say -- the second one was silently
 * dropped and the file claimed to be "the chart" regardless.
 *
 * This collects them all and lays them out side by side in a single document,
 * each under its own heading, on an explicit white background (the app is dark,
 * the charts are drawn for it, and an SVG opened anywhere else would otherwise
 * be dark text on nothing).
 *
 * `exportChartsPng` rasterises the very same composite rather than re-walking
 * the DOM, so the two formats cannot drift apart in what they show.
 */

import { saveTextFile, saveBlobFile } from './saveFile'
import { appendStamp, stampHeight, INCH } from './chartStamp'

interface ExportOptions {
  /** Element containing the charts; defaults to the whole document. */
  container?: HTMLElement | null
  /** Heading above each chart, in DOM order. */
  titles?: string[]
  /** Caption under the whole figure -- e.g. the thinning note. */
  caption?: string
  /** Download filename, without extension. */
  filename: string
  /**
   * The command that produced the plotted data, captured when the run
   * executed. Given one, the figure is stamped with a reproduce-this block and
   * a generated-on line. Omitted, the figure exports unstamped -- the stamp is
   * skipped rather than filled with a guess.
   */
  command?: string
  /** Application version for the stamp; required alongside `command`. */
  version?: string
}

const SVG_NS = 'http://www.w3.org/2000/svg'
const GAP = 24
const TITLE_H = 28
const CAPTION_H = 22

interface Composite {
  svg: SVGSVGElement
  count: number
  width: number
  height: number
}

/**
 * Lay every chart in `container` into one white-background SVG document.
 * Returns null when there is nothing on screen to export.
 */
function buildChartsSvg({
  container,
  titles = [],
  caption = '',
  command,
  version
}: Omit<ExportOptions, 'filename'>): Composite | null {
  const root: ParentNode = container ?? document
  // The wrapper's own child svg, which is the chart. Both looser selectors are
  // wrong here: '.recharts-wrapper svg' picks up every legend item's icon, and
  // so does 'svg.recharts-surface' -- recharts gives the legend glyphs that
  // same class. Either would have written six legend icons into the file
  // alongside the two real panels.
  const charts = Array.from(root.querySelectorAll('.recharts-wrapper > svg')) as SVGSVGElement[]
  if (charts.length === 0) return null

  const sizes = charts.map(svg => ({
    w: Number(svg.getAttribute('width')) || svg.getBoundingClientRect().width || 600,
    h: Number(svg.getAttribute('height')) || svg.getBoundingClientRect().height || 400
  }))
  const totalW = sizes.reduce((a, s) => a + s.w, 0) + GAP * (charts.length + 1)
  const maxH = Math.max(...sizes.map(s => s.h))
  const bodyH = TITLE_H + maxH + GAP + (caption ? CAPTION_H : 0)

  // The provenance block sits one inch clear of everything above it, measured
  // from the lowest thing drawn -- the caption when there is one, the charts
  // otherwise -- so the gap is an inch on the page either way.
  const stampW = totalW - 2 * GAP
  const stampTop = bodyH + INCH
  const totalH = command && version
    ? stampTop + stampHeight(command, stampW) + GAP
    : bodyH

  const out = document.createElementNS(SVG_NS, 'svg')
  out.setAttribute('xmlns', SVG_NS)
  out.setAttribute('width', String(Math.ceil(totalW)))
  out.setAttribute('height', String(Math.ceil(totalH)))
  out.setAttribute('viewBox', `0 0 ${Math.ceil(totalW)} ${Math.ceil(totalH)}`)

  const bg = document.createElementNS(SVG_NS, 'rect')
  bg.setAttribute('width', '100%')
  bg.setAttribute('height', '100%')
  bg.setAttribute('fill', '#ffffff')
  out.appendChild(bg)

  let x = GAP
  charts.forEach((chart, i) => {
    if (titles[i]) {
      const label = document.createElementNS(SVG_NS, 'text')
      label.setAttribute('x', String(x))
      label.setAttribute('y', String(TITLE_H - 10))
      label.setAttribute('fill', '#000000')
      label.setAttribute('font-family', 'sans-serif')
      label.setAttribute('font-size', '14')
      label.setAttribute('font-weight', '600')
      label.textContent = titles[i]
      out.appendChild(label)
    }

    // Nested <svg> keeps each chart's own coordinate system intact, so no
    // transform arithmetic is needed and nothing shifts.
    const clone = chart.cloneNode(true) as SVGSVGElement
    clone.setAttribute('x', String(x))
    clone.setAttribute('y', String(TITLE_H))
    clone.setAttribute('width', String(sizes[i].w))
    clone.setAttribute('height', String(sizes[i].h))
    // Drawn for a dark UI; on white, the light strokes would be invisible.
    clone.querySelectorAll('text').forEach(t => t.setAttribute('fill', '#000000'))
    clone.querySelectorAll('line').forEach(l => {
      if (l.getAttribute('stroke') !== 'none') l.setAttribute('stroke', '#000000')
    })
    out.appendChild(clone)
    x += sizes[i].w + GAP
  })

  if (caption) {
    const cap = document.createElementNS(SVG_NS, 'text')
    cap.setAttribute('x', String(GAP))
    // Under the charts, not under everything: measuring from totalH put the
    // caption below the provenance block once that block started being drawn,
    // so the note about the chart sat beneath the stamp that follows it.
    cap.setAttribute('y', String(bodyH - 8))
    cap.setAttribute('fill', '#444444')
    cap.setAttribute('font-family', 'sans-serif')
    cap.setAttribute('font-size', '12')
    cap.textContent = caption
    out.appendChild(cap)
  }

  if (command && version) {
    appendStamp(out, { command, version }, GAP, stampTop, stampW)
  }

  return { svg: out, count: charts.length, width: Math.ceil(totalW), height: Math.ceil(totalH) }
}

/** @returns the number of charts written, so callers can report honestly. */
export function exportChartsSvg(opts: ExportOptions): number {
  const built = buildChartsSvg(opts)
  if (!built) return 0

  // Through the main process: the <a download> this used to do is silently
  // dropped here, so the button wrote nothing and said nothing.
  void saveTextFile(
    new XMLSerializer().serializeToString(built.svg),
    `${opts.filename}_${new Date().toISOString().slice(0, 10)}.svg`
  )

  return built.count
}

/**
 * The same figure as a PNG, for anywhere that will not take an SVG.
 *
 * Rasterised from the composite above rather than from the live DOM, so the
 * two exports always show the same thing. `scale` oversamples: recharts sizes
 * its SVG to the panel, which is smaller than anything worth putting in a
 * figure, and a 1:1 raster of it looks soft.
 *
 * @returns the number of charts written, 0 if there was nothing to draw.
 */
export async function exportChartsPng(opts: ExportOptions, scale = 2): Promise<number> {
  const built = buildChartsSvg(opts)
  if (!built) return 0

  const source = new XMLSerializer().serializeToString(built.svg)
  const encoded =
    'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(source)))

  const blob = await new Promise<Blob | null>((resolve, reject) => {
    const image = new Image()
    image.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = Math.ceil(built.width * scale)
      canvas.height = Math.ceil(built.height * scale)
      const ctx = canvas.getContext('2d')
      if (!ctx) { reject(new Error('no 2d context')); return }
      // The composite already carries a white background rect, but the canvas
      // starts transparent and PNG keeps that -- fill so the margins match.
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.setTransform(scale, 0, 0, scale, 0, 0)
      ctx.drawImage(image, 0, 0)
      canvas.toBlob(resolve, 'image/png')
    }
    image.onerror = () => reject(new Error('the chart could not be rasterised'))
    image.src = encoded
  })

  if (!blob) throw new Error('the chart could not be encoded as PNG')
  await saveBlobFile(blob, `${opts.filename}_${new Date().toISOString().slice(0, 10)}.png`)
  return built.count
}
