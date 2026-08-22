import React, { useState, useMemo } from 'react'
import { SERIES, PRIMARY, SECONDARY, INK } from '../utils/chartTheme'
import { saveTextFile } from '../utils/saveFile'
import { 
  Stack, 
  Text, 
  Paper, 
  Group,
  Switch,
  Button,
  Box,
  Grid
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
import { IconDownload, IconFileVector, IconPhoto } from '@tabler/icons-react'

interface EquilibriumChartModalProps {
  data: Array<{
    copies: number
    probability: number
  }>
  populationSize: number
  /** Absent (undefined) when the run produced no E_freq — rendered as "—", not 0. */
  expectedFrequency?: number
  parameters: {
    N: number
    s: number
    h: number
    u: number
    v: number
  }
  /**
   * Command line that produced the plotted data, captured when the run
   * executed. Passed straight through to the exporters, which stamp it onto
   * the figure. Absent, the figure exports without a provenance block.
   */
  command?: string
}

import { thinSeries, thinningNote } from '../utils/thinSeries'
import { exportChartsSvg, exportChartsPng } from '../utils/exportChartsSvg'
import { formatQuantity } from '../utils/quantityLabels'

const EquilibriumChartModalNew: React.FC<EquilibriumChartModalProps> = ({ 
  data, 
  populationSize, 
  expectedFrequency,
  parameters, command
}) => {
  const [useLogScale, setUseLogScale] = useState(true)

  // Process data for chart
  const chartData = useMemo(() => {
    if (!data || data.length === 0) return []
    
    return data.map(point => ({
      frequency: point.copies / (2 * populationSize),
      probability: point.probability
    }))
  }, [data, populationSize])

  // Filter data for log scale
  const filteredData = useMemo(() => {
    if (!useLogScale) return chartData
    return chartData.filter(d => d.probability > 0)
  }, [chartData, useLogScale])

  // The equilibrium distribution has 2N+1 points, so a large population is
  // enough to bog the chart down on its own. Thinned for drawing; the CSV
  // export above still walks the full series.
  const plotData = useMemo(() => thinSeries(filteredData, ['probability'], 2000), [filteredData])
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
          <Text size="sm" fw={600} c="dark">Frequency: {formatTick(data.frequency)}</Text>
          <Text size="sm" fw={500} style={{ color: PRIMARY }}>Probability: {formatTick(data.probability)}</Text>
        </Paper>
      )
    }
    return null
  }

  const handleExportData = () => {
    const headers = ['Copies', 'Frequency', 'Probability']
    const csvContent = [
      headers.join(','),
      ...data.map(row => 
        `${row.copies},${row.copies / (2 * populationSize)},${row.probability}`
      )
    ].join('\n')
    
    // Through the main process: an <a download> is silently dropped here.
    void saveTextFile(csvContent, `equilibrium_distribution_N${parameters.N}.csv`)
  }

  const chartsRef = React.useRef<HTMLDivElement>(null)

  const exportSVG = () => {
    // Every chart in the panel, not just the first querySelector match.
    exportChartsSvg({ command, version: __APP_VERSION__,
      container: chartsRef.current,
      titles: ['Equilibrium frequency distribution'],
      caption: note,
      filename: `equilibrium_distribution_N${parameters.N}`
    })
  }
  /** Same figure, rasterised -- for anywhere that will not take an SVG. */
  const exportPNG = () => {
    void exportChartsPng({ command, version: __APP_VERSION__,
      container: chartsRef.current,
      titles: ['Equilibrium frequency distribution'],
      caption: note,
      filename: `equilibrium_distribution_N${parameters.N}`
    })
      .catch((e: any) => alert(`The chart could not be exported as PNG: ${e?.message ?? e}`))
  }



  return (
    <Stack gap="md">
      <Group justify="space-between">
        <Switch
          label="Log scale (y-axis)"
          checked={useLogScale}
          onChange={(e) => setUseLogScale(e.currentTarget.checked)}
        />
        <Group>
          <Button
            leftSection={<IconDownload size={16} />}
            onClick={handleExportData}
            variant="light"
          >
            Export Data
          </Button>
          <Button
            leftSection={<IconPhoto size={16} />}
            onClick={exportPNG}
            variant="light"
            color="grape"
          >
            Export PNG
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

      <Paper p="sm" withBorder>
        <Grid>
          <Grid.Col span={4}>
            <Text size="sm">
              <strong>Expected Frequency:</strong> {formatQuantity(expectedFrequency)}
            </Text>
          </Grid.Col>
          <Grid.Col span={4}>
            <Text size="sm">
              <strong>Population Size (N):</strong> {parameters.N}
            </Text>
          </Grid.Col>
          <Grid.Col span={4}>
            <Text size="sm">
              <strong>Selection (2Ns):</strong> {(2 * parameters.N * parameters.s).toFixed(3)}
            </Text>
          </Grid.Col>
          <Grid.Col span={4}>
            <Text size="sm">
              <strong>Dominance (h):</strong> {parameters.h}
            </Text>
          </Grid.Col>
          <Grid.Col span={4}>
            <Text size="sm">
              <strong>Forward Mutation (4Nu):</strong> {(4 * parameters.N * parameters.u).toFixed(6)}
            </Text>
          </Grid.Col>
          <Grid.Col span={4}>
            <Text size="sm">
              <strong>Backward Mutation (4Nv):</strong> {(4 * parameters.N * parameters.v).toFixed(6)}
            </Text>
          </Grid.Col>
        </Grid>
      </Paper>
      
      {note && <Text size="xs" c="dimmed">{note}</Text>}
      <Box style={{ width: '100%', height: '500px' }}>
        <div ref={chartsRef} style={{ width: '100%', height: '100%' }}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={plotData} margin={{ top: 10, right: 20, left: 40, bottom: 50 }}>
            <CartesianGrid stroke={INK.grid} strokeWidth={0.5} strokeOpacity={0.2} />
            <XAxis
                tick={{ fill: INK.muted }} 
              dataKey="frequency" 
              label={{ value: 'Frequency', position: 'insideBottom', offset: -10 , fill: INK.muted }}
              domain={[0, 1]}
              tickFormatter={formatTick}
            />
            <YAxis 
              label={{ 
                value: 'Probability', 
                angle: -90, 
                position: 'insideLeft',
                style: { fill: INK.muted }
              }}
              scale={useLogScale ? 'log' : 'linear'}
              domain={useLogScale ? ['auto', 'auto'] : [0, 'auto']}
              tickFormatter={formatTick}
              tick={{ fill: INK.muted }}
            />
            <Tooltip content={<CustomTooltip />} />
            <Area 
              type="monotone" 
              dataKey="probability" 
              stroke={PRIMARY} 
              strokeWidth={2}
              fill={PRIMARY}
              fillOpacity={0.2}
              dot={false}
              name="Probability"
            />
          </ComposedChart>
        </ResponsiveContainer>
        </div>
      </Box>
      
      <Paper p="sm" withBorder>
        <Text size="xs" c="dimmed">
          This chart shows the equilibrium frequency distribution for allele frequencies in the population. 
          The y-axis can be displayed in log scale to better visualize small probabilities.
        </Text>
      </Paper>
    </Stack>
  )
}

export default EquilibriumChartModalNew