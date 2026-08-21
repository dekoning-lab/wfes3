import React, { useState, useMemo, useRef } from 'react'
import { SERIES, PRIMARY, SECONDARY, INK } from '../utils/chartTheme'
import { saveTextFile } from '../utils/saveFile'
import { 
  Stack, 
  Text, 
  Paper, 
  Group,
  Switch,
  Button,
  Box
} from '@mantine/core'
import { 
  ComposedChart, 
  Area, 
  XAxis, 
  YAxis, 
  CartesianGrid, 
  Tooltip, 
  ResponsiveContainer,
  TooltipProps 
} from 'recharts'
import { IconDownload, IconFileVector } from '@tabler/icons-react'

interface TimeToSubstitutionChartModalProps {
  distribution: Array<{ time: number; probability: number; cumulative: number }>
}

import { thinSeries, thinningNote } from '../utils/thinSeries'
import { exportChartsSvg } from '../utils/exportChartsSvg'

const TimeToSubstitutionChartModal: React.FC<TimeToSubstitutionChartModalProps> = ({ distribution }) => {
  const [useLogScale, setUseLogScale] = useState(true)
  const [showPDF, setShowPDF] = useState(true)
  const [showCDF, setShowCDF] = useState(false)

  // Process data for chart
  const chartData = useMemo(() => {
    if (!distribution || distribution.length === 0) return []
    
    return distribution.map(point => ({
      time: point.time,
      pdf: point.probability,
      cdf: point.cumulative
    }))
  }, [distribution])

  // Filter data for log scale
  const filteredData = useMemo(() => {
    if (!useLogScale) return chartData
    return chartData.filter(d => d.time > 0)
  }, [chartData, useLogScale])

  // Substitution can take a very long time, so this series is the longest the
  // app draws -- routinely hundreds of thousands of generations. Recharts
  // renders a node per point, which is what made this modal crawl or come up
  // empty. Thinned for drawing only, extremes preserved; CSV export below
  // still walks chartData, so the file keeps every point.
  const plotData = useMemo(
    () => thinSeries(filteredData, ['pdf', 'cdf'], 2000),
    [filteredData]
  )
  const note = thinningNote(plotData.length, filteredData.length)

  const formatTick = (value: number) => {
    if (value === 0) return '0'
    if (value < 0.001) return value.toExponential(0)
    if (value < 1) return value.toFixed(3)
    if (value < 1000) return value.toFixed(0)
    return value.toExponential(0)
  }

  const CustomTooltip = ({ active, payload }: TooltipProps<any, any>) => {
    if (active && payload && payload.length) {
      const data = payload[0].payload
      return (
        <Paper p="sm" withBorder style={{ backgroundColor: INK.tooltipBg, border: `1px solid ${INK.tooltipBorder}` }}>
          <Text size="sm" fw={600} c="dark">Time: {formatTick(data.time)}</Text>
          {showPDF && <Text size="sm" fw={500} style={{ color: PRIMARY }}>PDF: {formatTick(data.pdf)}</Text>}
          {showCDF && <Text size="sm" fw={500} style={{ color: SECONDARY }}>CDF: {formatTick(data.cdf)}</Text>}
        </Paper>
      )
    }
    return null
  }

  const handleExport = () => {
    const headers = ['Time', 'PDF', 'CDF']
    const csvContent = [
      headers.join(','),
      ...chartData.map(row => 
        `${row.time},${row.pdf},${row.cdf}`
      )
    ].join('\n')
    
    // Through the main process: an <a download> is silently dropped here.
    void saveTextFile(csvContent, 'time_to_substitution.csv')
  }

  const chartsRef = useRef<HTMLDivElement>(null)

  const exportSVG = () => {
    // Whatever charts the panel is showing, not just the first one.
    exportChartsSvg({
      container: chartsRef.current,
      titles: ['Time to substitution'],
      caption: note,
      filename: 'time_to_substitution'
    })
  }


  return (
    <Stack gap="md">
      <Group justify="space-between">
        <Group>
          <Switch
            label="Log scale (time)"
            checked={useLogScale}
            onChange={(e) => setUseLogScale(e.currentTarget.checked)}
          />
          <Switch
            label="Show PDF"
            checked={showPDF}
            onChange={(e) => setShowPDF(e.currentTarget.checked)}
          />
          <Switch
            label="Show CDF"
            checked={showCDF}
            onChange={(e) => setShowCDF(e.currentTarget.checked)}
          />
        </Group>
        <Group>
          <Button
            leftSection={<IconDownload size={16} />}
            onClick={handleExport}
            variant="light"
          >
            Export Data
          </Button>
          <Button
            leftSection={<IconFileVector size={16} />}
            onClick={exportSVG}
            variant="light"
            color="grape"
          >
            Export SVG
          </Button>
        </Group>
      </Group>
      
      {note && <Text size="xs" c="dimmed">{note}</Text>}
      <Box style={{ width: '100%', height: '500px' }}>
        <div ref={chartsRef} style={{ width: '100%', height: '100%' }}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={plotData} margin={{ top: 10, right: showCDF ? 40 : 20, left: 40, bottom: 50 }}>
            <CartesianGrid stroke={INK.grid} strokeWidth={0.5} strokeOpacity={0.2} />
            <XAxis
                tick={{ fill: INK.muted }} 
              dataKey="time" 
              label={{ value: 'Time (generations)', position: 'insideBottom', offset: -10 , fill: INK.muted }}
              scale={useLogScale ? 'log' : 'linear'}
              domain={useLogScale ? [1, 'dataMax'] : [0, 'dataMax']}
              tickFormatter={formatTick}
            />
            {showPDF && (
              <YAxis 
                yAxisId="pdf"
                orientation="left"
                label={{ 
                  value: 'PDF', 
                  angle: -90, 
                  position: 'insideLeft',
                  style: { fill: INK.muted }
                }}
                tickFormatter={formatTick}
                domain={[0, 'auto']}
                tick={{ fill: INK.muted }}
              />
            )}
            {showCDF && (
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
            )}
            <Tooltip content={<CustomTooltip />} />
            {showPDF && (
              <Area 
                yAxisId="pdf"
                type="monotone" 
                dataKey="pdf" 
                stroke={PRIMARY} 
                strokeWidth={2}
                fill={PRIMARY}
                fillOpacity={0.2}
                dot={false}
                name="PDF"
              />
            )}
            {showCDF && (
              <Area 
                yAxisId="cdf"
                type="monotone" 
                dataKey="cdf"
                stroke={SECONDARY} 
                strokeWidth={2}
                fill={SECONDARY}
                fillOpacity={0.1}
                dot={false}
                name="CDF"
                isAnimationActive={false}
              />
            )}
          </ComposedChart>
        </ResponsiveContainer>
        </div>
      </Box>
      
      <Paper p="sm" withBorder>
        <Text size="xs" c="dimmed">
          This chart shows the probability density function (PDF) and cumulative distribution function (CDF) 
          for the time to substitution. Use the toggles above to show/hide curves and enable log scale for 
          the time axis.
        </Text>
      </Paper>
    </Stack>
  )
}

export default TimeToSubstitutionChartModal