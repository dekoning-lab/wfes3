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
 */

import { saveTextFile } from './saveFile'

interface ExportOptions {
  /** Element containing the charts; defaults to the whole document. */
  container?: HTMLElement | null
  /** Heading above each chart, in DOM order. */
  titles?: string[]
  /** Caption under the whole figure -- e.g. the thinning note. */
  caption?: string
  /** Download filename, without extension. */
  filename: string
}

const SVG_NS = 'http://www.w3.org/2000/svg'
const GAP = 24
const TITLE_H = 28
const CAPTION_H = 22

/** @returns the number of charts written, so callers can report honestly. */
export function exportChartsSvg({
  container,
  titles = [],
  caption = '',
  filename
}: ExportOptions): number {
  const root: ParentNode = container ?? document
  // The wrapper's own child svg, which is the chart. Both looser selectors are
  // wrong here: '.recharts-wrapper svg' picks up every legend item's icon, and
  // so does 'svg.recharts-surface' -- recharts gives the legend glyphs that
  // same class. Either would have written six legend icons into the file
  // alongside the two real panels.
  const charts = Array.from(root.querySelectorAll('.recharts-wrapper > svg')) as SVGSVGElement[]
  if (charts.length === 0) return 0

  const sizes = charts.map(svg => ({
    w: Number(svg.getAttribute('width')) || svg.getBoundingClientRect().width || 600,
    h: Number(svg.getAttribute('height')) || svg.getBoundingClientRect().height || 400
  }))
  const totalW = sizes.reduce((a, s) => a + s.w, 0) + GAP * (charts.length + 1)
  const maxH = Math.max(...sizes.map(s => s.h))
  const totalH = TITLE_H + maxH + GAP + (caption ? CAPTION_H : 0)

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
    cap.setAttribute('y', String(totalH - 8))
    cap.setAttribute('fill', '#444444')
    cap.setAttribute('font-family', 'sans-serif')
    cap.setAttribute('font-size', '12')
    cap.textContent = caption
    out.appendChild(cap)
  }

  // Through the main process: the <a download> this used to do is silently
  // dropped here, so the button wrote nothing and said nothing.
  void saveTextFile(
    new XMLSerializer().serializeToString(out),
    `${filename}_${new Date().toISOString().slice(0, 10)}.svg`
  )

  return charts.length
}
