/**
 * @file SojournVectorChart.tsx
 * @brief One row of the fundamental matrix, drawn as the vector it is.
 *
 * With "One starting count" the solver computes a single row of N -- the
 * sojourn times from that one starting state -- and the CLI writes exactly
 * that: one line, not a padded square. The heatmap was still asked to draw it,
 * and a 1 x (2N-1) grid stretches its single row over the full plot height, so
 * a vector arrived looking like a matrix that had lost all but one row.
 *
 * A vector wants a line, not a colour ramp: the quantity is expected visits
 * against end state, and the interesting thing about it is its shape -- a peak
 * at the starting count decaying away on both sides -- which a one-row heatmap
 * cannot show at all.
 *
 * Axis convention: the transient states of this model are allele counts
 * 1..2N-1, so column index j holds the count j+1. This chart plots the count.
 */
import React, { useMemo, useState } from 'react'
import { Group, Switch, Text, Stack } from '@mantine/core'
import {
  ComposedChart, Area, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer
} from 'recharts'
import { PRIMARY, INK } from '../utils/chartTheme'
import { thinSeries, thinningNote } from '../utils/thinSeries'
import { formatQuantity } from '../utils/quantityLabels'

export type SojournKind = 'unconditional' | 'extinction' | 'fixation' | 'transition'

interface SojournVectorChartProps {
  /** The single row of N, one entry per transient state. */
  values: number[]
  kind?: SojournKind
  /** Which starting count the row was computed from, if known. */
  startingCopies?: number
  className?: string
}

const SYMBOL: Record<SojournKind, string> = {
  unconditional: 'N',
  extinction: 'N_ext',
  fixation: 'N_fix',
  transition: 'Q'
}

const SojournVectorChart: React.FC<SojournVectorChartProps> = ({
  values,
  kind = 'unconditional',
  startingCopies,
  className = ''
}) => {
  const [logY, setLogY] = useState(false)

  const rows = useMemo(
    () => values.map((v, j) => ({ count: j + 1, visits: v })),
    [values]
  )

  // A log axis cannot show a zero, and sojourn rows legitimately contain them
  // far from the starting count. Those points are dropped from the log view
  // rather than silently redrawn at some floor value.
  const positive = useMemo(() => rows.filter(r => r.visits > 0), [rows])
  const source = logY ? positive : rows
  const shown = useMemo(() => thinSeries(source, ['visits'], 2000), [source, logY])
  const droppedForLog = logY ? rows.length - positive.length : 0

  if (!values || values.length === 0) {
    return <div className="flex items-center justify-center h-full text-gray-500">No data available</div>
  }

  const symbol = SYMBOL[kind]
  const from = startingCopies !== undefined ? String(startingCopies) : 'p'

  return (
    <Stack gap="xs" className={className} style={{ height: '100%' }}>
      <Group justify="space-between" wrap="wrap" gap="sm">
        <Text size="sm" fw={500}>
          {`${symbol}(${from}, j) — expected visits to each state, starting from ${from} ${
            startingCopies === 1 ? 'copy' : 'copies'
          }`}
        </Text>
        <Switch
          size="xs"
          checked={logY}
          onChange={e => setLogY(e.currentTarget.checked)}
          label="Log Y"
        />
      </Group>

      <div style={{ flex: 1, minHeight: 320 }}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={shown} margin={{ top: 10, right: 24, left: 60, bottom: 50 }}>
            <CartesianGrid stroke={INK.grid} strokeWidth={0.5} strokeOpacity={0.2} />
            <XAxis
              dataKey="count"
              type="number"
              domain={['dataMin', 'dataMax']}
              tick={{ fill: INK.muted }}
              label={{
                value: 'Allele count (j)',
                position: 'insideBottom',
                offset: -15,
                fill: INK.muted
              }}
            />
            <YAxis
              scale={logY ? 'log' : 'linear'}
              domain={logY ? ['auto', 'auto'] : [0, 'auto']}
              allowDataOverflow={false}
              tick={{ fill: INK.muted }}
              width={80}
              tickFormatter={(v: number) => formatQuantity(v)}
              label={{
                value: 'Expected visits',
                angle: -90,
                position: 'insideLeft',
                offset: 0,
                fill: INK.muted
              }}
            />
            <Tooltip
              cursor={{ stroke: INK.grid }}
              content={({ active, payload }: any) => {
                if (!active || !payload?.length) return null
                const p = payload[0].payload
                return (
                  <div
                    style={{
                      background: INK.tooltipBg,
                      border: `1px solid ${INK.tooltipBorder}`,
                      borderRadius: 6,
                      padding: '8px 10px'
                    }}
                  >
                    <Text size="sm" fw={600} c={INK.text}>{`Allele count ${p.count}`}</Text>
                    <Text size="sm" style={{ color: PRIMARY }}>
                      {`${symbol}(${from}, ${p.count}) = ${formatQuantity(p.visits)}`}
                    </Text>
                  </div>
                )
              }}
            />
            <Area
              type="monotone"
              dataKey="visits"
              stroke={PRIMARY}
              strokeWidth={2}
              fill={PRIMARY}
              fillOpacity={0.18}
              dot={false}
              isAnimationActive={false}
            />
            <Line
              type="monotone"
              dataKey="visits"
              stroke={PRIMARY}
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {(shown.length < source.length || droppedForLog > 0) && (
        <Text size="xs" c="dimmed">
          {[
            thinningNote(shown.length, source.length),
            droppedForLog > 0
              ? `${droppedForLog.toLocaleString()} state${droppedForLog === 1 ? '' : 's'} with zero expected visits omitted from the log view.`
              : ''
          ]
            .filter(Boolean)
            .join(' ')}
        </Text>
      )}
    </Stack>
  )
}

export default SojournVectorChart
