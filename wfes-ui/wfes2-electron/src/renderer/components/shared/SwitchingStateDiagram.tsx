/**
 * @file SwitchingStateDiagram.tsx
 * @brief Live state-transition diagram for the switching-family models.
 *
 * Renders the DiagramModel built by utils/switchingDiagrams.ts as inline SVG.
 * Node boxes are SIZED TO THEIR TEXT: every line is measured (canvas
 * measureText with the actual fonts when available, the calibrated estimator
 * from switchingDiagrams.ts otherwise) and long residence/note lines are
 * word-wrapped. SVG text neither wraps nor clips on its own, so the earlier
 * fixed 172px width let long notes ("spectrum observed at end of this epoch")
 * run straight through the border.
 *
 * Layouts: 'chain' places nodes left to right; 'ring' places them on a circle
 * with curved right-of-travel edges. Stay probabilities appear inside nodes as
 * mean residence times, not as self-loop arrows.
 */
import React, { useId, useMemo, useState } from 'react'
import { Paper, Group, Title, Text, Collapse, ActionIcon, Stack, Box } from '@mantine/core'
import { IconChevronDown } from '@tabler/icons-react'
import {
  DiagramModel, DiagramState, estimateTextWidth, wrapText, TextMeasure
} from '../../utils/switchingDiagrams'

const PAD = 16
const PAD_X = 12          // horizontal padding inside a node box
const MIN_NODE_W = 172
const MAX_NODE_W = 252    // beyond this, lines wrap instead of widening
// Floor for the space between chain nodes. The edge label is centred in that
// space, so the actual gap is whichever is larger, this or the widest label:
// at a fixed 86 the label ran over the node boxes and the arrowhead whenever it
// was wider, which "@ -> @  lambda = 0.001 /gen" is.
const CHAIN_GAP_MIN = 86
const FONT = { title: 13, residence: 11, note: 10, param: 10 }
const LINE_H = { title: 15, residence: 13, note: 12, param: 13 }
const SANS = 'system-ui, sans-serif'
const MONO = 'ui-monospace, monospace'

const COLORS = {
  nodeFill: 'var(--mantine-color-body, #ffffff)',
  nodeStroke: 'var(--mantine-color-gray-5, #adb5bd)',
  title: 'var(--mantine-color-text, #212529)',
  residence: 'var(--mantine-color-blue-7, #1971c2)',
  note: 'var(--mantine-color-dimmed, #868e96)',
  param: 'var(--mantine-color-gray-7, #495057)',
  edge: 'var(--mantine-color-gray-6, #868e96)',
  edgeLabel: 'var(--mantine-color-blue-8, #1864ab)'
}

/**
 * Real text measurement when a canvas is available (always true in the
 * renderer); the shared estimator otherwise, so sizing is testable in Node.
 */
function makeMeasure(): (text: string, font: keyof typeof FONT) => number {
  let ctx: CanvasRenderingContext2D | null = null
  try {
    ctx = document.createElement('canvas').getContext('2d')
  } catch {
    ctx = null
  }
  return (text, font) => {
    const size = FONT[font]
    const mono = font === 'param'
    if (ctx) {
      ctx.font = `${font === 'title' ? '700 ' : ''}${font === 'note' ? 'italic ' : ''}${size}px ${mono ? MONO : SANS}`
      // small safety margin over the exact measurement
      return ctx.measureText(text).width * 1.03
    }
    return estimateTextWidth(text, size, {
      mono, bold: font === 'title', italic: font === 'note'
    })
  }
}

interface PreparedLine {
  text: string
  kind: keyof typeof FONT
}

interface PreparedState {
  s: DiagramState
  lines: PreparedLine[]
  height: number
}

/** Wrap and measure one state's content against the maximum text width. */
function prepareState(s: DiagramState, measure: ReturnType<typeof makeMeasure>): {
  prepared: PreparedState; maxLineW: number
} {
  const maxTextW = MAX_NODE_W - 2 * PAD_X
  const lines: PreparedLine[] = []
  const wrapAs = (text: string, kind: keyof typeof FONT): void => {
    const m: TextMeasure = (t) => measure(t, kind)
    for (const piece of wrapText(text, maxTextW, m)) lines.push({ text: piece, kind })
  }
  wrapAs(s.name, 'title')
  wrapAs(s.residence, 'residence')
  if (s.note) wrapAs(s.note, 'note')
  for (const pl of s.paramLines) wrapAs(pl, 'param')
  let h = 10
  let paramsStarted = false
  for (const l of lines) {
    if (l.kind === 'param' && !paramsStarted) { h += 6; paramsStarted = true }
    h += LINE_H[l.kind]
  }
  h += 10
  const maxLineW = Math.max(...lines.map((l) => measure(l.text, l.kind)))
  return { prepared: { s, lines, height: h }, maxLineW }
}

function NodeBox({ p, x, y, w, h }: { p: PreparedState; x: number; y: number; w: number; h: number }) {
  const fills: Record<keyof typeof FONT, string> = {
    title: COLORS.title, residence: COLORS.residence, note: COLORS.note, param: COLORS.param
  }
  let ty = y + 10
  let paramsStarted = false
  const texts = p.lines.map((l, i) => {
    if (l.kind === 'param' && !paramsStarted) { ty += 6; paramsStarted = true }
    ty += LINE_H[l.kind]
    return (
      <text key={i} x={x + w / 2} y={ty - 3} textAnchor="middle"
        fontSize={FONT[l.kind]}
        fontWeight={l.kind === 'title' ? 700 : undefined}
        fontStyle={l.kind === 'note' ? 'italic' : undefined}
        fontFamily={l.kind === 'param' ? MONO : SANS}
        fill={fills[l.kind]}>{l.text}</text>
    )
  })
  return (
    <g data-diagram-node={p.s.name}>
      <rect x={x} y={y} width={w} height={h} rx={10}
        fill={COLORS.nodeFill} stroke={COLORS.nodeStroke} strokeWidth={1.4}
        strokeDasharray={p.s.residenceKind === 'terminal' ? '6 4' : undefined} />
      {texts}
    </g>
  )
}

/** Point where a ray from a rect's centre exits its boundary (slightly outside). */
function rectEdgePoint(cx: number, cy: number, dx: number, dy: number, w: number, h: number) {
  const tx = dx !== 0 ? w / 2 / Math.abs(dx) : Infinity
  const ty = dy !== 0 ? h / 2 / Math.abs(dy) : Infinity
  const t = Math.min(tx, ty) * 1.04
  return { x: cx + dx * t, y: cy + dy * t }
}

export interface SwitchingStateDiagramProps {
  model: DiagramModel
  title?: string
  defaultOpen?: boolean
}

export const SwitchingStateDiagram: React.FC<SwitchingStateDiagramProps> = ({
  model, title = 'Model structure', defaultOpen = true
}) => {
  const [open, setOpen] = useState(defaultOpen)
  const markerId = useId().replace(/[:]/g, '') + '-arrow'
  const n = model.states.length

  // Measure/wrap all nodes; one uniform width for the whole diagram keeps the
  // chain/ring layout arithmetic simple and the nodes visually even.
  const { prepared, W, H, chainGap } = useMemo(() => {
    const measure = makeMeasure()
    const results = model.states.map((s) => prepareState(s, measure))
    const maxLineW = Math.max(0, ...results.map((r) => r.maxLineW))
    const W = Math.min(MAX_NODE_W, Math.max(MIN_NODE_W, Math.ceil(maxLineW) + 2 * PAD_X))
    const H = Math.max(0, ...results.map((r) => r.prepared.height))
    // Edge labels render at 11px in the sans face, which is what 'residence'
    // measures, and sit centred between two nodes. Widen the gap to hold them.
    const widestEdge = Math.max(0, ...model.edges.map((e) => measure(e.label, 'residence')))
    const chainGap = Math.max(CHAIN_GAP_MIN, Math.ceil(widestEdge) + 14)
    return { prepared: results.map((r) => r.prepared), W, H, chainGap }
  }, [model.states, model.edges])

  if (n === 0) return null

  let svg: React.ReactNode
  let width: number
  let height: number

  if (model.layout === 'chain') {
    width = PAD * 2 + n * W + (n - 1) * chainGap
    height = PAD * 2 + H + 18
    const y = PAD + 14
    svg = (
      <>
        {prepared.map((p, i) => (
          <NodeBox key={i} p={p} x={PAD + i * (W + chainGap)} y={y} w={W} h={H} />
        ))}
        {model.edges.map((e, k) => {
          // Two-lane chain edges: forward upper, backward lower; single lane
          // when one-way. Non-adjacent hops arc over the row (defensive).
          const yc = y + H / 2
          const hasBackward = model.edges.some((d) => d.to < d.from)
          const forward = e.to > e.from
          const li = Math.min(e.from, e.to)
          const ri = Math.max(e.from, e.to)
          const xLeft = PAD + li * (W + chainGap) + W + 3
          const xRight = PAD + ri * (W + chainGap) - 5
          if (ri - li > 1) {
            const yTop = y - 6
            const x1 = forward ? xLeft : xRight
            const x2 = forward ? xRight : xLeft
            const mx = (x1 + x2) / 2
            return (
              <g key={k}>
                <path d={`M ${x1} ${yc} Q ${mx} ${yTop - 30} ${x2} ${yc}`}
                  fill="none" stroke={COLORS.edge} strokeWidth={1.6}
                  markerEnd={`url(#${markerId})`} />
                <text x={mx} y={yTop - 18} textAnchor="middle" fontSize={11}
                  fill={COLORS.edgeLabel}>{e.label}</text>
              </g>
            )
          }
          const lane = hasBackward ? (forward ? yc - 11 : yc + 11) : yc
          const x1 = forward ? xLeft : xRight
          const x2 = forward ? xRight : xLeft
          return (
            <g key={k}>
              <line x1={x1} y1={lane} x2={x2} y2={lane} stroke={COLORS.edge}
                strokeWidth={1.6} markerEnd={`url(#${markerId})`} />
              <text x={(xLeft + xRight) / 2} y={forward ? lane - 7 : lane + 16}
                textAnchor="middle" fontSize={11}
                fill={COLORS.edgeLabel}>{e.label}</text>
            </g>
          )
        })}
      </>
    )
  } else {
    // Ring layout with right-of-travel curved edges; labels near the source.
    const R = Math.max(150, 66 + n * 34)
    const cx = R + W / 2 + PAD
    const cy = R + H / 2 + PAD + 10
    width = cx * 2
    height = cy * 2
    const centre = (i: number) => {
      const a = -Math.PI / 2 + (2 * Math.PI * i) / n
      return { x: cx + R * Math.cos(a), y: cy + R * Math.sin(a) }
    }
    svg = (
      <>
        {model.edges.map((e, k) => {
          const c1 = centre(e.from)
          const c2 = centre(e.to)
          const dx = c2.x - c1.x
          const dy = c2.y - c1.y
          const len = Math.hypot(dx, dy) || 1
          const ux = dx / len
          const uy = dy / len
          const p1 = rectEdgePoint(c1.x, c1.y, ux, uy, W, H)
          const p2 = rectEdgePoint(c2.x, c2.y, -ux, -uy, W, H)
          const px = uy
          const py = -ux
          const bow = 26
          const mx = (p1.x + p2.x) / 2 + px * bow
          const my = (p1.y + p2.y) / 2 + py * bow
          const t = 0.3
          const bx = (1 - t) * (1 - t) * p1.x + 2 * (1 - t) * t * mx + t * t * p2.x
          const by = (1 - t) * (1 - t) * p1.y + 2 * (1 - t) * t * my + t * t * p2.y
          const lx = bx + px * 26
          const ly = by + py * 26 + 4
          return (
            <g key={k}>
              <path d={`M ${p1.x} ${p1.y} Q ${mx} ${my} ${p2.x} ${p2.y}`}
                fill="none" stroke={COLORS.edge} strokeWidth={1.6}
                markerEnd={`url(#${markerId})`} />
              <text x={lx} y={ly} textAnchor="middle" fontSize={11}
                fill={COLORS.edgeLabel}>{e.label}</text>
            </g>
          )
        })}
        {prepared.map((p, i) => {
          const c = centre(i)
          return <NodeBox key={i} p={p} x={c.x - W / 2} y={c.y - H / 2} w={W} h={H} />
        })}
      </>
    )
  }

  return (
    <Paper p="md" withBorder mt="md" data-testid="switching-state-diagram">
      <Group justify="space-between" style={{ cursor: 'pointer' }} onClick={() => setOpen(!open)}>
        <Title order={6}>{title}</Title>
        <ActionIcon variant="subtle" color="gray" aria-label="Toggle diagram">
          <IconChevronDown size={16}
            style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 150ms' }} />
        </ActionIcon>
      </Group>
      <Collapse in={open}>
        <Stack gap="xs" mt="xs">
          <Box style={{ overflowX: 'auto' }}>
            <svg viewBox={`0 0 ${width} ${height}`} width="100%"
              style={{ maxWidth: width, display: 'block', margin: '0 auto' }}
              role="img" aria-label={title}>
              <defs>
                <marker id={markerId} viewBox="0 0 10 10" refX={9} refY={5}
                  markerWidth={7} markerHeight={7} orient="auto-start-reverse">
                  <path d="M 0 0 L 10 5 L 0 10 z" fill={COLORS.edge} />
                </marker>
              </defs>
              {svg}
            </svg>
          </Box>
          {model.captions.map((c, i) => (
            <Text key={i} size="xs" c="dimmed">{c}</Text>
          ))}
        </Stack>
      </Collapse>
    </Paper>
  )
}

export default SwitchingStateDiagram
