/**
 * @file chartStamp.ts
 * @brief The provenance block stamped onto every exported figure.
 *
 * A figure that leaves this app should carry the run that made it. The block
 * holds the exact command line -- the same string the Command Line Preview
 * shows, which the preview harness holds to character equality with the argv
 * actually spawned -- so a reader can re-run the analysis by copying it, and
 * every parameter behind the picture is legible on the picture.
 *
 * The command MUST be the one captured when the run executed, not one rebuilt
 * from the form at export time: the controls stay editable after a run, so a
 * live rebuild can describe a different analysis than the one plotted. A
 * stamp that misdescribes its own figure is worse than no stamp, which is why
 * `command` is required rather than defaulted.
 *
 * Laid out in SVG user units at 96/inch, matching the CSS pixel the charts are
 * sized in, so "one inch below the chart" is one inch on a printed page.
 */

const SVG_NS = 'http://www.w3.org/2000/svg'

/** One inch, in the user units the composite is laid out in. */
export const INCH = 96

const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
const SANS = 'sans-serif'
const CMD_SIZE = 12
/** Menlo and friends sit near 0.60 em; measured rather than guessed at below. */
const CMD_CHAR_W = CMD_SIZE * 0.601
const CMD_LINE_H = 17
const BOX_PAD = 14
const HEADING_H = 16
const FOOT_SIZE = 10.5
const FOOT_GAP = 15

export interface StampInput {
  /** The command that produced the data, captured at execution time. */
  command: string
  /** Application version, baked in at build time. */
  version: string
  /** When the figure was exported. */
  when?: Date
}

/**
 * Break a command line into display lines that fit `maxChars`, preferring to
 * break between arguments so a flag and its value stay together. A single
 * argument longer than the width (a long file path) is hard-wrapped rather
 * than allowed to overflow the box.
 */
export function wrapCommand(command: string, maxChars: number): string[] {
  if (maxChars < 8) return [command]
  const out: string[] = []
  let line = ''
  // Continuation lines are indented, so the command reads as one statement.
  const indent = '  '

  const flush = () => {
    if (line.length) out.push(line)
    line = ''
  }

  for (const token of command.split(' ').filter(Boolean)) {
    const prefix = line.length === 0 ? (out.length === 0 ? '' : indent) : ' '
    if (line.length + prefix.length + token.length <= maxChars) {
      line += prefix + token
      continue
    }
    flush()
    if (token.length + indent.length <= maxChars) {
      line = (out.length === 0 ? '' : indent) + token
    } else {
      // Longer than a whole line on its own: cut it.
      let rest = token
      const room = maxChars - indent.length
      while (rest.length > room) {
        out.push((out.length === 0 ? '' : indent) + rest.slice(0, room))
        rest = rest.slice(room)
      }
      line = (out.length === 0 ? '' : indent) + rest
    }
  }
  flush()
  return out.length ? out : ['']
}

/** Local time, to the second, with the zone named so it is unambiguous. */
export function formatStampTime(when: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const date =
    `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`
  const time = `${pad(when.getHours())}:${pad(when.getMinutes())}:${pad(when.getSeconds())}`
  const zone =
    new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' })
      .formatToParts(when)
      .find(p => p.type === 'timeZoneName')?.value ?? ''
  return `${date} ${time}${zone ? ' ' + zone : ''}`
}

/** How tall the whole block will be, so the caller can size the canvas first. */
export function stampHeight(command: string, boxWidth: number): number {
  const maxChars = Math.max(8, Math.floor((boxWidth - 2 * BOX_PAD) / CMD_CHAR_W))
  const lines = wrapCommand(command, maxChars)
  const boxH = BOX_PAD + HEADING_H + lines.length * CMD_LINE_H + BOX_PAD
  return boxH + FOOT_GAP + FOOT_SIZE
}

/**
 * Append the block to `parent`, with its top-left at (x, y).
 * @returns the height consumed, matching stampHeight for the same inputs.
 */
export function appendStamp(
  parent: SVGElement,
  { command, version, when = new Date() }: StampInput,
  x: number,
  y: number,
  boxWidth: number
): number {
  const maxChars = Math.max(8, Math.floor((boxWidth - 2 * BOX_PAD) / CMD_CHAR_W))
  const lines = wrapCommand(command, maxChars)
  const boxH = BOX_PAD + HEADING_H + lines.length * CMD_LINE_H + BOX_PAD

  const el = (name: string, attrs: Record<string, string | number>, text?: string) => {
    const node = document.createElementNS(SVG_NS, name)
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v))
    if (text !== undefined) node.textContent = text
    parent.appendChild(node)
    return node
  }

  el('rect', {
    x, y, width: boxWidth, height: boxH,
    rx: 6, ry: 6,
    fill: '#f7f8f9', stroke: '#c8ced3', 'stroke-width': 1
  })

  el('text', {
    x: x + BOX_PAD, y: y + BOX_PAD + 11,
    'font-family': SANS, 'font-size': 10.5, 'font-weight': 600,
    'letter-spacing': 0.6, fill: '#5a6b6e'
  }, 'COMMAND LINE TO REPRODUCE THIS FIGURE')

  lines.forEach((line, i) => {
    el('text', {
      x: x + BOX_PAD,
      y: y + BOX_PAD + HEADING_H + (i + 1) * CMD_LINE_H - 4,
      'font-family': MONO, 'font-size': CMD_SIZE, fill: '#1c2426',
      'xml:space': 'preserve'
    }, line)
  })

  el('text', {
    x, y: y + boxH + FOOT_GAP,
    'font-family': SANS, 'font-size': FOOT_SIZE, fill: '#6b7678'
  }, `Results were generated on ${formatStampTime(when)} using WFES3 v${version}.`)

  return boxH + FOOT_GAP + FOOT_SIZE
}

/**
 * Rasterise an already-rendered figure with the provenance block beneath it.
 *
 * The matrix modal draws its heatmap as a canvas or a pre-rendered image
 * depending on size, so there is no SVG to extend -- the figure arrives as
 * pixels. Wrapping those pixels in an SVG alongside the stamp, then
 * rasterising the whole thing, keeps one implementation of the block: the
 * same appendStamp that the vector exports use, laid out identically.
 *
 * Embedding a raster inside SVG would be wrong for an .svg deliverable, and
 * that path stays fully vector. Here the output is a PNG, so there is nothing
 * to lose by it.
 */
export async function rasterWithStamp(
  sourceDataUrl: string,
  sourceWidth: number,
  sourceHeight: number,
  stamp: StampInput,
  scale = 1
): Promise<Blob> {
  const margin = 24
  const stampW = Math.max(120, sourceWidth - 2 * margin)
  const stampTop = sourceHeight + INCH
  const totalH = stampTop + stampHeight(stamp.command, stampW) + margin

  const wrapper = document.createElementNS(SVG_NS, 'svg')
  wrapper.setAttribute('xmlns', SVG_NS)
  wrapper.setAttribute('width', String(sourceWidth))
  wrapper.setAttribute('height', String(Math.ceil(totalH)))
  wrapper.setAttribute('viewBox', `0 0 ${sourceWidth} ${Math.ceil(totalH)}`)

  const bg = document.createElementNS(SVG_NS, 'rect')
  bg.setAttribute('width', '100%')
  bg.setAttribute('height', '100%')
  bg.setAttribute('fill', '#ffffff')
  wrapper.appendChild(bg)

  const img = document.createElementNS(SVG_NS, 'image')
  img.setAttribute('x', '0')
  img.setAttribute('y', '0')
  img.setAttribute('width', String(sourceWidth))
  img.setAttribute('height', String(sourceHeight))
  img.setAttribute('href', sourceDataUrl)
  wrapper.appendChild(img)

  appendStamp(wrapper, stamp, margin, stampTop, stampW)

  const source = new XMLSerializer().serializeToString(wrapper)
  const encoded = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(source)))

  return new Promise<Blob>((resolve, reject) => {
    const image = new Image()
    image.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = Math.ceil(sourceWidth * scale)
      canvas.height = Math.ceil(totalH * scale)
      const ctx = canvas.getContext('2d')
      if (!ctx) { reject(new Error('no 2d context')); return }
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.setTransform(scale, 0, 0, scale, 0, 0)
      ctx.drawImage(image, 0, 0)
      canvas.toBlob(b => (b ? resolve(b) : reject(new Error('PNG encoding failed'))), 'image/png')
    }
    image.onerror = () => reject(new Error('the figure could not be rasterised'))
    image.src = encoded
  })
}

/**
 * Rasterise an SVG document string to a PNG blob.
 *
 * `scale` oversamples: these figures are laid out at 96 units to the inch, and
 * a 1:1 raster of that is only screen resolution.
 */
export async function rasterizeSvgString(svg: string, scale = 2): Promise<Blob> {
  const widthMatch = svg.match(/width="(\d+(?:\.\d+)?)"/)
  const heightMatch = svg.match(/height="(\d+(?:\.\d+)?)"/)
  const w = widthMatch ? parseFloat(widthMatch[1]) : 1000
  const h = heightMatch ? parseFloat(heightMatch[1]) : 1000
  const encoded = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)))

  return new Promise<Blob>((resolve, reject) => {
    const image = new Image()
    image.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = Math.ceil(w * scale)
      canvas.height = Math.ceil(h * scale)
      const ctx = canvas.getContext('2d')
      if (!ctx) { reject(new Error('no 2d context')); return }
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.setTransform(scale, 0, 0, scale, 0, 0)
      ctx.drawImage(image, 0, 0)
      canvas.toBlob(b => (b ? resolve(b) : reject(new Error('PNG encoding failed'))), 'image/png')
    }
    image.onerror = () => reject(new Error('the figure could not be rasterised'))
    image.src = encoded
  })
}
