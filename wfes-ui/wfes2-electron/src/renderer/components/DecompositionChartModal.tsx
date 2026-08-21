/**
 * @file DecompositionChartModal.tsx
 * @brief Where the outcome happened, and where the time went, as a chart.
 *
 * The switching view's chart button opened a modal reading "State probability
 * timeline chart will be shown here". There is no timeline to draw: wfes_switching
 * reports scalars plus per-state decompositions, and no tool in the suite emits a
 * trajectory through time. Rather than invent one, this charts what the solver
 * actually produces -- the same per-state / per-epoch / per-regime numbers as the
 * breakdown table, which is exactly the part of the output that benefits from a
 * picture.
 *
 * One component serves all three because the shape is identical: a set of
 * categories (states, epochs, regimes) and a set of quantities over them.
 * Probabilities and times get separate panels since they share no scale.
 */
import React, { useMemo, useRef, useState } from 'react'
import { SERIES, PRIMARY, SECONDARY, INK } from '../utils/chartTheme'
import { Modal, Stack, Group, Text, Button, SegmentedControl, Paper } from '@mantine/core'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts'
import { IconDownload } from '@tabler/icons-react'
import { exportChartsSvg } from '../utils/exportChartsSvg'
import { formatQuantity } from '../utils/quantityLabels'

export interface DecompositionSeries {
  /** ASCII quantity name, e.g. "P_ext,k" -- matches the breakdown table. */
  name: string
  /** One value per category; non-numeric entries are skipped. */
  values: number[]
  /** Which panel it belongs on. */
  kind: 'probability' | 'time'
}

interface DecompositionChartModalProps {
  opened: boolean
  onClose: () => void
  /** State / epoch / regime names, in order. */
  categories: string[]
  series: DecompositionSeries[]
  title: string
  filename: string
  /** What the category axis is, for the axis label. */
  categoryLabel: string
}

const COLORS = [PRIMARY, SECONDARY, SERIES[2], SERIES[3], SERIES[4], SERIES[5]]

const DecompositionChartModal: React.FC<DecompositionChartModalProps> = ({
  opened, onClose, categories, series, title, filename, categoryLabel
}) => {
  const [scale, setScale] = useState<'absolute' | 'share'>('absolute')
  const chartsRef = useRef<HTMLDivElement>(null)

  const panel = (kind: 'probability' | 'time') => {
    const keys = series.filter(s => s.kind === kind)
    if (keys.length === 0) return null

    const rows = categories.map((cat, k) => {
      const row: Record<string, number | string> = { category: cat }
      for (const s of keys) {
        const v = s.values[k]
        if (typeof v === 'number' && Number.isFinite(v)) row[s.name] = v
      }
      return row
    })

    // "Share" normalizes each quantity by its own total across categories, so
    // rows that differ by orders of magnitude can be compared side by side.
    // The absolute view is the default: it is what the solver reported.
    const shown = scale === 'absolute' ? rows : rows.map(r => {
      const out: Record<string, number | string> = { category: r.category }
      for (const s of keys) {
        const total = keys.length
          ? rows.reduce((a, x) => a + (typeof x[s.name] === 'number' ? (x[s.name] as number) : 0), 0)
          : 0
        const v = r[s.name]
        if (typeof v === 'number') out[s.name] = total > 0 ? (100 * v) / total : 0
      }
      return out
    })

    const CustomTooltip = ({ active, payload, label }: any) => {
      if (!active || !payload?.length) return null
      return (
        <Paper p="sm" withBorder style={{ backgroundColor: INK.tooltipBg, border: `1px solid ${INK.tooltipBorder}` }}>
          <Text size="sm" fw={600} c={INK.text} mb={4}>{label}</Text>
          {payload.map((e: any, i: number) => (
            <Text key={i} size="sm" style={{ color: e.color }}>
              {`${e.name}: ${scale === 'share' ? `${e.value.toFixed(2)}%` : formatQuantity(e.value)}`}
            </Text>
          ))}
        </Paper>
      )
    }

    return (
      <div style={{ flex: 1, minWidth: 380 }}>
        <Text size="sm" fw={500} mb="xs">
          {kind === 'probability' ? 'Absorption probability' : 'Expected generations'}
        </Text>
        <ResponsiveContainer width="100%" height={420}>
          <BarChart data={shown} margin={{ top: 10, right: 20, left: 50, bottom: 50 }}>
            <CartesianGrid stroke={INK.grid} strokeWidth={0.5} strokeOpacity={0.2} />
            <XAxis
                tick={{ fill: INK.muted }}
              dataKey="category"
              label={{ value: categoryLabel, position: 'insideBottom', offset: -15 , fill: INK.muted }}
            />
            <YAxis
                tick={{ fill: INK.muted }}
              tickFormatter={(v: number) => (scale === 'share' ? `${v.toFixed(0)}%` : formatQuantity(v))}
              width={80}
              label={{
                value: scale === 'share' ? 'Share of total' : (kind === 'probability' ? 'Probability' : 'Generations'),
                angle: -90,
                position: 'insideLeft',
                offset: 0
              }}
            />
            <Tooltip content={<CustomTooltip />} />
            <Legend verticalAlign="top" height={28}
              formatter={(value: string) => (
                <span style={{ color: INK.text }}>{value}</span>
              )}
            />
            {keys.map((s, i) => (
              <Bar key={s.name} dataKey={s.name} fill={COLORS[i % COLORS.length]} radius={[4, 4, 0, 0]} isAnimationActive={false} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
    )
  }

  const panels = useMemo(
    () => [panel('probability'), panel('time')].filter(Boolean),
    [categories, series, scale]
  )

  return (
    <Modal opened={opened} onClose={onClose} size="95%" title={title}>
      <Stack>
        <Group justify="space-between">
          <SegmentedControl
            size="xs"
            value={scale}
            onChange={v => setScale(v as 'absolute' | 'share')}
            data={[
              { value: 'absolute', label: 'Absolute' },
              { value: 'share', label: 'Share of total' }
            ]}
          />
          <Button leftSection={<IconDownload size={16} />} variant="light" onClick={() =>
            exportChartsSvg({
              container: chartsRef.current,
              titles: ['Absorption probability', 'Expected generations'],
              filename
            })
          }>
            Export SVG
          </Button>
        </Group>

        <Text size="xs" c="dimmed">
          The same decomposition as the breakdown table. In the probability panel the
          category is where absorption ended; in the time panel it is where the time was
          spent en route, conditional on the outcome.
        </Text>

        <div ref={chartsRef} style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          {panels.length > 0 ? panels : (
            <Text c="dimmed" ta="center" style={{ width: '100%', height: 420, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              No decomposition to plot
            </Text>
          )}
        </div>
      </Stack>
    </Modal>
  )
}

export default DecompositionChartModal
