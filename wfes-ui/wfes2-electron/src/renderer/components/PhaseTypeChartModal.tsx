import React, { useState, useRef } from 'react'
import { SERIES, PRIMARY, SECONDARY, INK } from '../utils/chartTheme'
import {
  Stack,
  Switch,
  Group,
  Button,
  Text,
  Paper,
  Select
} from '@mantine/core'
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  TooltipProps
} from 'recharts'
import { IconDownload } from '@tabler/icons-react'

interface PhaseTypeChartModalProps {
  distribution: Array<{
    time: number
    probability: number
    cumulative: number
  }>
}

const CustomTooltip: React.FC<TooltipProps<number, string>> = ({ active, payload, label }) => {
  if (active && payload && payload.length) {
    return (
      <Paper shadow="sm" p="sm" withBorder style={{ backgroundColor: INK.tooltipBg, border: `1px solid ${INK.tooltipBorder}` }}>
        <Text size="sm" fw={600} c="dark">Time: {label}</Text>
        {payload.map((entry, index) => (
          <Text key={index} size="sm" fw={500} style={{ color: entry.color || '#000' }}>
            {entry.name}: {
              typeof entry.value === 'number' 
                ? entry.value < 0.001 
                  ? entry.value.toExponential(4)
                  : entry.value.toFixed(6)
                : entry.value
            }
          </Text>
        ))}
      </Paper>
    )
  }
  return null
}

import { thinSeries, thinningNote } from '../utils/thinSeries'
import { exportChartsSvg } from '../utils/exportChartsSvg'

const PhaseTypeChartModal: React.FC<PhaseTypeChartModalProps> = ({ distribution }) => {
  const [useLogScale, setUseLogScale] = useState(false)
  const [samplingRate, setSamplingRate] = useState<string>('1')
  const chartRef = useRef<HTMLDivElement>(null)

  // Sample the distribution based on sampling rate
  // The manual rate stays -- someone may want a specific stride -- but it no
  // longer has to be set by hand to make the chart appear. Automatic thinning
  // runs after it and keeps each bucket's extremes, where a stride keeps
  // whatever the modulus lands on and can drop a peak entirely.
  const sampledData = React.useMemo(() => {
    const rate = parseInt(samplingRate) || 1
    const strided = rate === 1 ? distribution : distribution.filter((_, index) => index % rate === 0)
    return thinSeries(strided, ['probability', 'cumulative'], 2000)
  }, [distribution, samplingRate])

  const note = thinningNote(sampledData.length, distribution.length)

  // Format tick values for scientific notation
  const formatTick = (value: number) => {
    if (value === 0) return '0'
    if (Math.abs(value) < 0.001 || Math.abs(value) > 1000) {
      return value.toExponential(1)
    }
    return value.toFixed(3)
  }

  // Export chart as SVG
  const exportSVG = () => {
    // Every chart in the panel. The single-querySelector version wrote only the
    // first one whenever this modal showed more than one.
    exportChartsSvg({
      container: chartRef.current,
      titles: ['Phase-type distribution'],
      caption: note,
      filename: 'phase_type_pdf_cdf'
    })
  }


  // Calculate y-axis domain for PDF based on data
  const pdfDomain = React.useMemo(() => {
    const values = sampledData.map(d => d.probability)
    const nonZeroValues = values.filter(v => v > 0)
    
    if (nonZeroValues.length === 0) return [0, 1]
    
    const max = Math.max(...values)
    return [0, max * 1.1] // Add 10% padding for linear scale
  }, [sampledData])

  return (
    <Stack>
      <Group justify="space-between">
        <Group>
          <Switch
            label="Log Scale (Time)"
            checked={useLogScale}
            onChange={(e) => setUseLogScale(e.currentTarget.checked)}
          />
          <Select
            label="Sampling Rate"
            value={samplingRate}
            onChange={(value) => setSamplingRate(value || '1')}
            data={[
              { value: '1', label: 'Every point' },
              { value: '10', label: 'Every 10th point' },
              { value: '100', label: 'Every 100th point' },
              { value: '1000', label: 'Every 1000th point' }
            ]}
            style={{ width: 150 }}
          />
        </Group>
        <Button
          leftSection={<IconDownload size={16} />}
          onClick={exportSVG}
          variant="light"
        >
          Export SVG
        </Button>
      </Group>

      <div ref={chartRef} style={{ width: '100%', height: 400 }}>
        {note && <Text size="xs" c="dimmed">{note}</Text>}
      <ResponsiveContainer>
          <LineChart
            data={sampledData}
            margin={{ top: 5, right: 70, left: 70, bottom: 5 }}
          >
            <CartesianGrid stroke={INK.grid} strokeWidth={0.5} strokeOpacity={0.5} />
            <XAxis
                tick={{ fill: INK.muted }}
              dataKey="time"
              label={{ value: 'Time (generations)', position: 'insideBottom', offset: -5 , fill: INK.muted }}
              tickFormatter={formatTick}
              stroke="#666"
              scale={useLogScale ? 'log' : 'linear'}
              domain={useLogScale ? [1, 'dataMax'] : [0, 'dataMax']}
            />
            <YAxis
              yAxisId="pdf"
              domain={[0, 'auto']}
              label={{ 
                value: 'PDF', 
                angle: -90, 
                position: 'insideLeft',
                style: { fill: INK.muted }
              }}
              tickFormatter={formatTick}
              tick={{ fill: INK.muted }}
            />
            <YAxis
              yAxisId="cdf"
              orientation="right"
              domain={[0, 1]}
              label={{ 
                value: 'CDF', 
                angle: 90, 
                position: 'insideRight',
                style: { fill: INK.muted }
              }}
              tickFormatter={formatTick}
              tick={{ fill: INK.muted }}
            />
            <Tooltip content={<CustomTooltip />} />
            <Line
              yAxisId="pdf"
              type="monotone"
              dataKey="probability"
              name="P(t)"
              stroke={PRIMARY}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4 }}
            />
            <Line
              yAxisId="cdf"
              type="monotone"
              dataKey="cumulative"
              name="CDF"
              stroke={SECONDARY}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4 }}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <Paper p="sm" withBorder>
        <Group gap="xl">
          <Text size="sm">
            <Text span fw={500}>Total Points:</Text> {distribution.length}
          </Text>
          <Text size="sm">
            <Text span fw={500}>Displayed Points:</Text> {sampledData.length}
          </Text>
          <Text size="sm">
            <Text span fw={500}>Max Time:</Text> {distribution[distribution.length - 1]?.time || 0}
          </Text>
          <Text size="sm">
            <Text span fw={500}>Max CDF:</Text> {distribution[distribution.length - 1]?.cumulative.toFixed(6) || 0}
          </Text>
        </Group>
      </Paper>
    </Stack>
  )
}

export default PhaseTypeChartModal