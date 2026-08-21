/**
 * @file SpectrumChartModal.tsx
 * @brief The allele-frequency spectrum chart, shared by WFAF-D and WFAF-S.
 *
 * Both views had a "View Chart" button that opened a modal reading
 * "Area chart visualization will be implemented here". The two tools report the
 * same shape of result -- a probability over allele counts 0..2N -- so they get
 * the same chart rather than two that drift apart.
 *
 * The boundary states are drawn apart from the rest deliberately. Mass at 0 and
 * at 2N is usually orders of magnitude above the interior, so plotted together
 * on a linear axis the interior is a flat line at zero; the summary strip
 * states both boundary masses as numbers, and a log toggle makes the interior
 * legible without hiding them.
 */
import React, { useMemo, useRef, useState } from 'react'
import { SERIES, PRIMARY, SECONDARY, INK } from '../utils/chartTheme'
import { Modal, Stack, Group, Text, Button, Switch, Checkbox, Paper, SegmentedControl } from '@mantine/core'
import {
  ComposedChart, Area, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer
} from 'recharts'
import { IconDownload } from '@tabler/icons-react'
import { thinSeries, thinningNote } from '../utils/thinSeries'
import { exportChartsSvg } from '../utils/exportChartsSvg'
import { formatQuantity } from '../utils/quantityLabels'

export interface SpectrumPoint {
  /** Allele count, 0..2N. */
  copies: number
  probability: number
  cumulative?: number
}

interface SpectrumChartModalProps {
  opened: boolean
  onClose: () => void
  data: SpectrumPoint[]
  /** Shown in the heading and used for the export filename. */
  title: string
  filename: string
}

const SpectrumChartModal: React.FC<SpectrumChartModalProps> = ({
  opened, onClose, data, title, filename
}) => {
  const [logY, setLogY] = useState(false)
  // Hidden by default. Mass at 0 and 2N is routinely orders of magnitude above
  // the interior, so including them on a linear axis renders the rest of the
  // spectrum -- the part the chart exists to show -- as a flat line at zero.
  // Nothing is concealed by this: both masses are printed above the chart, the
  // caption says they are hidden, and the checkbox puts them back.
  const [hideBoundaries, setHideBoundaries] = useState(true)
  const [xAxis, setXAxis] = useState<'count' | 'frequency'>('count')
  const [showCumulative, setShowCumulative] = useState(false)
  const chartsRef = useRef<HTMLDivElement>(null)

  const maxCopies = useMemo(
    () => (data.length ? Math.max(...data.map(d => d.copies)) : 0),
    [data]
  )

  const rows = useMemo(() => {
    if (!data.length) return []
    let cum = 0
    const withCum = data.map(d => {
      cum += d.probability
      return {
        copies: d.copies,
        frequency: maxCopies > 0 ? d.copies / maxCopies : 0,
        probability: d.probability,
        cumulative: d.cumulative ?? cum
      }
    })
    const body = hideBoundaries
      ? withCum.filter(d => d.copies !== 0 && d.copies !== maxCopies)
      : withCum
    // A log axis cannot show zero; those points are dropped from the plot only,
    // and the count of them is reported under the chart.
    return logY ? body.filter(d => d.probability > 0) : body
  }, [data, maxCopies, hideBoundaries, logY])

  const plotData = useMemo(
    () => thinSeries(rows, ['probability', 'cumulative'], 2000),
    [rows]
  )
  const droppedForLog = logY ? data.length - rows.length - (hideBoundaries ? 2 : 0) : 0
  const note = [
    hideBoundaries ? 'Boundary states (count 0 and 2N) are hidden; their masses are shown above.' : '',
    thinningNote(plotData.length, rows.length),
    droppedForLog > 0 ? `${droppedForLog.toLocaleString()} zero-probability points omitted by the log axis.` : ''
  ].filter(Boolean).join(' ')

  const boundary = useMemo(() => {
    const at = (c: number) => data.find(d => d.copies === c)?.probability ?? 0
    return { lost: at(0), fixed: at(maxCopies) }
  }, [data, maxCopies])

  const xKey = xAxis === 'count' ? 'copies' : 'frequency'

  const CustomTooltip = ({ active, payload, label }: any) => {
    if (!active || !payload?.length) return null
    return (
      <Paper p="sm" withBorder style={{ backgroundColor: INK.tooltipBg, border: `1px solid ${INK.tooltipBorder}` }}>
        <Text size="sm" fw={600} c={INK.text} mb={4}>
          {xAxis === 'count' ? `Allele count: ${label}` : `Frequency: ${formatQuantity(label)}`}
        </Text>
        {payload.map((e: any, i: number) => (
          <Text key={i} size="sm" style={{ color: e.color }}>
            {`${e.name}: ${formatQuantity(e.value)}`}
          </Text>
        ))}
      </Paper>
    )
  }

  return (
    <Modal opened={opened} onClose={onClose} size="90%" title={title}>
      <Stack>
        <Group justify="space-between">
          <Group>
            <SegmentedControl
              size="xs"
              value={xAxis}
              onChange={v => setXAxis(v as 'count' | 'frequency')}
              data={[{ value: 'count', label: 'Allele count' }, { value: 'frequency', label: 'Frequency' }]}
            />
            <Switch size="xs" label="Log Y" checked={logY} onChange={e => setLogY(e.currentTarget.checked)} />
            <Checkbox
              size="xs"
              label="Hide boundary states"
              checked={hideBoundaries}
              onChange={e => setHideBoundaries(e.currentTarget.checked)}
            />
            <Checkbox
              size="xs"
              label="Show CDF"
              checked={showCumulative}
              onChange={e => setShowCumulative(e.currentTarget.checked)}
            />
          </Group>
          <Button leftSection={<IconDownload size={16} />} variant="light" onClick={() =>
            exportChartsSvg({ container: chartsRef.current, titles: [title], caption: note, filename })
          }>
            Export SVG
          </Button>
        </Group>

        <Group gap="xl">
          <Text size="xs" c="dimmed">
            P<sub>0</sub> = {formatQuantity(boundary.lost)} (allele absent)
          </Text>
          <Text size="xs" c="dimmed">
            P<sub>2N</sub> = {formatQuantity(boundary.fixed)} (at fixation)
          </Text>
          <Text size="xs" c="dimmed">
            P<sub>seg</sub> = {formatQuantity(1 - boundary.lost - boundary.fixed)}
          </Text>
        </Group>
        {note && <Text size="xs" c="dimmed">{note}</Text>}

        <div ref={chartsRef}>
          {plotData.length > 0 ? (
            <ResponsiveContainer width="100%" height={480}>
              <ComposedChart data={plotData} margin={{ top: 10, right: showCumulative ? 50 : 20, left: 50, bottom: 50 }}>
                <CartesianGrid stroke={INK.grid} strokeWidth={0.5} strokeOpacity={0.2} />
                <XAxis
                tick={{ fill: INK.muted }}
                  dataKey={xKey}
                  type="number"
                  domain={['dataMin', 'dataMax']}
                  label={{
                    value: xAxis === 'count' ? 'Allele count' : 'Allele frequency',
                    position: 'insideBottom',
                    offset: -15
                  }}
                  tickFormatter={(v: number) => (xAxis === 'count' ? String(v) : v.toFixed(2))}
                />
                <YAxis
                  yAxisId="p"
                  scale={logY ? 'log' : 'linear'}
                  domain={logY ? ['auto', 'auto'] : [0, 'auto']}
                  allowDataOverflow={false}
                  label={{ value: 'Probability', angle: -90, position: 'insideLeft', offset: 0, style: { fill: INK.muted } }}
                  tick={{ fill: INK.muted }}
                  tickFormatter={(v: number) => formatQuantity(v)}
                  width={80}
                />
                {showCumulative && (
                  <YAxis
                    yAxisId="cdf"
                    orientation="right"
                    domain={[0, 1]}
                    label={{ value: 'Cumulative', angle: 90, position: 'insideRight', style: { fill: INK.muted } }}
                    tick={{ fill: INK.muted }}
                    tickFormatter={(v: number) => v.toFixed(2)}
                  />
                )}
                <Tooltip content={<CustomTooltip />} />
                {/* Bars once the spectrum is small enough for them to be
                    distinguishable; an area below that, where 20,000 bars would
                    be a solid block. */}
                {plotData.length <= 120 ? (
                  <Bar yAxisId="p" dataKey="probability" fill={PRIMARY} radius={[4, 4, 0, 0]} name="Probability" isAnimationActive={false} />
                ) : (
                  <Area
                    yAxisId="p"
                    type="monotone"
                    dataKey="probability"
                    stroke={PRIMARY}
                    strokeWidth={2}
                    fill={PRIMARY}
                    fillOpacity={0.2}
                    dot={false}
                    name="Probability"
                    isAnimationActive={false}
                  />
                )}
                {showCumulative && (
                  <Area
                    yAxisId="cdf"
                    type="monotone"
                    dataKey="cumulative"
                    stroke={SECONDARY}
                    strokeWidth={2}
                    fill={SECONDARY}
                    fillOpacity={0.1}
                    dot={false}
                    name="Cumulative"
                    isAnimationActive={false}
                  />
                )}
              </ComposedChart>
            </ResponsiveContainer>
          ) : (
            <Text c="dimmed" ta="center" style={{ height: 480, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              No spectrum to plot
            </Text>
          )}
        </div>
      </Stack>
    </Modal>
  )
}

export default SpectrumChartModal
