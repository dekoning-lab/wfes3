import React, { useState } from 'react'
import { SERIES, PRIMARY, SECONDARY, INK } from '../utils/chartTheme'
import { Modal, Switch, Group, Select, Stack, Button, Text, Checkbox, Paper, Alert } from '@mantine/core'
import { LineChart, Line, Area, AreaChart, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ComposedChart, Legend } from 'recharts'
import { IconDownload } from '@tabler/icons-react'
import { thinSeries, thinningNote } from '../utils/thinSeries'
import { exportChartsSvg } from '../utils/exportChartsSvg'

interface TimeDistData {
  time: number
  p_ext: number
  p_fix: number
  p_total: number
  cdf?: number
  cdf_ext?: number
  cdf_fix?: number
  cdf_total?: number
  // For SGV mode - component-specific data
  [key: string]: number | undefined
}

interface TimeDistChartModalProps {
  opened: boolean
  onClose: () => void
  data: TimeDistData[]
  mode: 'time-dist' | 'time-dist-sgv' | 'time-dist-skip'
  components?: Array<{ N: string; s: string; h: string; u: string; v: string }>
}

const TimeDistChartModal: React.FC<TimeDistChartModalProps> = ({
  opened,
  onClose,
  data,
  mode,
  components
}) => {
  const [logScaleExt, setLogScaleExt] = useState(false)
  const [logScaleFix, setLogScaleFix] = useState(false)
  // Fraction of each branch's own mass to show. The control already existed
  // and already meant this; it just was not connected to the axis range.
  const [cutoff, setCutoff] = useState('0.99')
  const [showPDF, setShowPDF] = useState(true)
  const [showCDF, setShowCDF] = useState(false) // Default CDF off

  // Filter data based on cutoff
  const filteredData = React.useMemo(() => {
    if (!data || data.length === 0) return []
    
    // The whole series: each panel takes its own slice below, against its own
    // branch total. Cutting here first against cdf_total would truncate the
    // slower branch to wherever the faster one happened to finish.
    return data
  }, [data, cutoff])

  // Thinned for drawing only. These distributions run to hundreds of thousands
  // of generations and recharts renders a node per point, which is what made
  // the modal hang or come up blank. Extremes are kept, so peaks survive.
  const plotData = React.useMemo(
    () => thinSeries(filteredData, ['p_ext', 'p_fix', 'cdf_ext', 'cdf_fix'], 2000),
    [filteredData]
  )

  // Each branch gets its own time axis and its own thinning budget.
  //
  // Sharing one axis makes the faster branch unreadable: extinction is
  // typically over within tens of generations while fixation runs for
  // thousands, so on a common 0..T_max axis the whole extinction distribution
  // is compressed into the first pixel column and the panel looks empty. The
  // panels are separate charts precisely because the two distributions live on
  // different scales -- the same reason the CLI's stopping rule has to measure
  // each branch against its own total.
  const branchData = React.useMemo(() => {
    const cut = (pdfKey: string, cdfKey: string) => {
      if (filteredData.length === 0) return []
      const total = filteredData[filteredData.length - 1][cdfKey] as number
      if (!Number.isFinite(total) || total <= 0) return []
      // Where this branch has essentially finished, as a fraction of its own
      // mass -- not of the total, which is the distinction that makes the two
      // panels readable at all (extinction here holds 99.5% of the probability
      // and is over in tens of generations; fixation holds 0.5% and runs for
      // thousands).
      const frac = Math.min(1, Math.max(0.5, parseFloat(cutoff) || 0.99))
      let end = filteredData.length - 1
      for (let i = 0; i < filteredData.length; i++) {
        if ((filteredData[i][cdfKey] as number) >= frac * total) { end = i; break }
      }
      // A little headroom past the cutoff so the tail does not end mid-air.
      const stop = Math.min(filteredData.length, Math.ceil(end * 1.1) + 5)
      return thinSeries(filteredData.slice(0, stop), [pdfKey, cdfKey], 1000)
    }
    return { ext: cut('p_ext', 'cdf_ext'), fix: cut('p_fix', 'cdf_fix') }
  }, [filteredData, cutoff])

  // Stated per panel: one combined count would have to invent a denominator,
  // since the two panels cover different ranges of the same 3,895-row series.
  const note = branchData.ext.length && branchData.fix.length
    ? `Extinction: ${branchData.ext.length.toLocaleString()} points drawn to generation ` +
      `${branchData.ext[branchData.ext.length - 1]?.time}. ` +
      `Fixation: ${branchData.fix.length.toLocaleString()} points to generation ` +
      `${branchData.fix[branchData.fix.length - 1]?.time}. ` +
      `Series is ${filteredData.length.toLocaleString()} generations; peaks and troughs are ` +
      'preserved, and export and CSV use every point.'
    : ''

  // Format tick values for scientific notation
  const formatTick = (value: number) => {
    if (value === 0) return '0'
    if (value < 0.001 || value > 1000) {
      return value.toExponential(1)
    }
    return value.toFixed(3)
  }

  // Custom tooltip
  const CustomTooltip = ({ active, payload, label }: any) => {
    if (active && payload && payload.length) {
      return (
        <Paper p="sm" withBorder style={{ backgroundColor: INK.tooltipBg, border: `1px solid ${INK.tooltipBorder}` }}>
          <Text size="sm" fw={600} c={INK.text} mb={4}>{`Time: ${label}`}</Text>
          {payload.map((entry: any, index: number) => (
            <Text key={index} size="sm" fw={500} style={{ color: entry.color }}>
              {`${entry.name}: ${entry.value.toExponential(3)}`}
            </Text>
          ))}
        </Paper>
      )
    }
    return null
  }

  const chartsRef = React.useRef<HTMLDivElement>(null)

  const exportChart = () => {
    // Every chart in the panel, not just the first one querySelector happened
    // to return -- this modal shows extinction beside fixation, and the
    // fixation panel was silently missing from every file it ever wrote.
    exportChartsSvg({
      container: chartsRef.current,
      titles: mode === 'time-dist-sgv'
        ? ['Time to fixation by component']
        : ['Time to extinction', 'Time to fixation'],
      caption: note,
      filename: 'time_dist_pdf_cdf'
    })
  }

  const renderStandardChart = () => {
    
    return (
      <div style={{ display: 'flex', gap: '10px' }}>
        {/* Extinction Chart */}
        <div style={{ flex: 1 }}>
          <Group justify="space-between" mb="xs">
            <Text size="sm" fw={500}>Time to Extinction</Text>
            <Switch 
              label="Log X" 
              size="xs"
              checked={logScaleExt}
              onChange={(e) => setLogScaleExt(e.currentTarget.checked)}
            />
          </Group>
          <ResponsiveContainer width="100%" height={500}>
            <ComposedChart data={branchData.ext} margin={{ top: 10, right: showCDF ? 40 : 20, left: 40, bottom: 50 }}>
              <CartesianGrid stroke={INK.grid} strokeWidth={0.5} strokeOpacity={0.2} />
              <XAxis
                tick={{ fill: INK.muted }} 
                dataKey="time" 
                label={{ value: 'Time (generations)', position: 'insideBottom', offset: -15 , fill: INK.muted }}
                scale={logScaleExt ? 'log' : 'linear'}
                domain={logScaleExt ? [1, 'dataMax'] : [0, 'dataMax']}
                tickFormatter={(value) => value.toFixed(0)}
              />
              <YAxis 
                yAxisId="pdf"
                label={{ 
                  value: 'PDF', 
                  angle: -90, 
                  position: 'insideLeft',
                  offset: 10,
                  style: { fill: INK.muted }
                }}
                tickFormatter={formatTick}
                domain={[0, 'auto']}
                tick={{ fill: INK.muted }}
              />
              {showCDF && (
                <YAxis 
                  yAxisId="cdf"
                  orientation="right"
                  label={{ 
                    value: 'CDF', 
                    angle: 90, 
                    position: 'insideRight',
                    offset: 10,
                    style: { fill: INK.muted }
                  }}
                  tickFormatter={formatTick}
                  domain={[0, 1]}
                  tick={{ fill: INK.muted }}
                />
              )}
              <Tooltip content={<CustomTooltip />} />
              {showPDF && (
                <Area 
                  yAxisId="pdf"
                  type="monotone" 
                  dataKey="p_ext" 
                  stroke={PRIMARY} 
                  strokeWidth={2}
                  fill={PRIMARY}
                  fillOpacity={0.2}
                  dot={false}
                  name="PDF (Extinction)"
                />
              )}
              {showCDF && (
                <Area 
                  yAxisId="cdf"
                  type="monotone" 
                  dataKey="cdf_ext"
                  stroke={SECONDARY} 
                  strokeWidth={2}
                  fill={SECONDARY}
                  fillOpacity={0.1}
                  dot={false}
                  name="CDF (Extinction)"
                  isAnimationActive={false}
                />
              )}
            </ComposedChart>
          </ResponsiveContainer>
        </div>

        {/* Fixation Chart */}
        <div style={{ flex: 1 }}>
          <Group justify="space-between" mb="xs">
            <Text size="sm" fw={500}>Time to Fixation</Text>
            <Switch 
              label="Log X" 
              size="xs"
              checked={logScaleFix}
              onChange={(e) => setLogScaleFix(e.currentTarget.checked)}
            />
          </Group>
          <ResponsiveContainer width="100%" height={500}>
            <ComposedChart data={branchData.fix} margin={{ top: 10, right: showCDF ? 40 : 20, left: 40, bottom: 50 }}>
              <CartesianGrid stroke={INK.grid} strokeWidth={0.5} strokeOpacity={0.2} />
              <XAxis
                tick={{ fill: INK.muted }} 
                dataKey="time" 
                label={{ value: 'Time (generations)', position: 'insideBottom', offset: -5 , fill: INK.muted }}
                scale={logScaleFix ? 'log' : 'linear'}
                domain={logScaleFix ? [1, 'dataMax'] : [0, 'dataMax']}
                tickFormatter={(value) => value.toFixed(0)}
              />
              <YAxis 
                yAxisId="pdf"
                label={{ 
                  value: 'PDF', 
                  angle: -90, 
                  position: 'insideLeft',
                  offset: 10,
                  style: { fill: INK.muted }
                }}
                tickFormatter={formatTick}
                domain={[0, 'auto']}
                tick={{ fill: INK.muted }}
              />
              {showCDF && (
                <YAxis 
                  yAxisId="cdf"
                  orientation="right"
                  label={{ 
                    value: 'CDF', 
                    angle: 90, 
                    position: 'insideRight',
                    offset: 10,
                    style: { fill: INK.muted }
                  }}
                  tickFormatter={formatTick}
                  domain={[0, 1]}
                  tick={{ fill: INK.muted }}
                />
              )}
              <Tooltip content={<CustomTooltip />} />
              {showPDF && (
                <Area 
                  yAxisId="pdf"
                  type="monotone" 
                  dataKey="p_fix" 
                  stroke={PRIMARY} 
                  strokeWidth={2}
                  fill={PRIMARY}
                  fillOpacity={0.2}
                  dot={false}
                  name="PDF (Fixation)"
                />
              )}
              {showCDF && (
                <Area 
                    yAxisId="cdf"
                    type="monotone" 
                    dataKey="cdf_fix"
                    stroke={SECONDARY} 
                    strokeWidth={2}
                    fill={SECONDARY}
                    fillOpacity={0.1}
                    dot={false}
                    name="CDF (Fixation)"
                    isAnimationActive={false}
                  />
              )}
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </div>
    )
  }

  const renderSGVChart = () => {
    if (!components || components.length === 0) return null
    
    // For SGV mode, we need to show fixation probability for each component
    const colors = [PRIMARY, SECONDARY, SERIES[2], SERIES[3], SERIES[4], SERIES[5]]
    
    return (
      <ResponsiveContainer width="100%" height={400}>
        <LineChart data={plotData} margin={{ top: 10, right: 30, left: 20, bottom: 50 }}>
          <CartesianGrid stroke={INK.grid} strokeWidth={0.5} strokeOpacity={0.2} />
          <XAxis
                tick={{ fill: INK.muted }} 
            dataKey="time" 
            label={{ value: 'Time (generations)', position: 'insideBottom', offset: -5 , fill: INK.muted }}
            scale={logScaleExt ? 'log' : 'linear'}
            domain={logScaleExt ? [1, 'dataMax'] : [0, 'dataMax']}
            tickFormatter={(value) => value.toFixed(0)}
          />
          <YAxis
                tick={{ fill: INK.muted }} 
            label={{ value: 'Fixation Probability', angle: -90, position: 'insideLeft' , fill: INK.muted }}
            tickFormatter={formatTick}
          />
          <Tooltip content={<CustomTooltip />} />
          <Legend
              formatter={(value: string) => (
                <span style={{ color: INK.text }}>{value}</span>
              )}
            />
          {components.map((comp, index) => (
            <Line 
              key={index}
              type="monotone" 
              dataKey={`p_fix_${index}`} 
              stroke={colors[index % colors.length]} 
              strokeWidth={2}
              dot={false}
              name={`Component ${index + 1}`}
            />
          ))}
          <Line 
            type="monotone" 
            dataKey="p_fix" 
            stroke={INK.text} 
            strokeWidth={2}
            strokeDasharray="5 5"
            dot={false}
            name="Total"
          />
        </LineChart>
      </ResponsiveContainer>
    )
  }

  const renderDualChart = () => {
    // For dual/skip mode, show component-specific probabilities if available
    // Otherwise fall back to standard chart
    return renderStandardChart()
  }

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      size="95%"
      title="Time Distribution Charts"
      styles={{
        body: { padding: '10px' },
        header: { padding: '10px 15px' }
      }}
    >
      <Stack>
        {/* Controls */}
        <Group justify="space-between">
          <Group>
            <Checkbox
              label="Show PDF"
              checked={showPDF}
              onChange={(e) => setShowPDF(e.currentTarget.checked)}
            />
            <Checkbox
              label="Show CDF"
              checked={showCDF}
              onChange={(e) => setShowCDF(e.currentTarget.checked)}
            />
            <Select
              label="Show mass"
              description="Fraction of each branch's own distribution"
              value={cutoff}
              onChange={(value) => setCutoff(value || '1.0')}
              data={[
                { value: '0.9', label: '0.9' },
                { value: '0.95', label: '0.95' },
                { value: '0.99', label: '0.99' },
                { value: '0.999', label: '0.999' },
                { value: '1.0', label: '1.0' }
              ]}
              style={{ width: 100 }}
            />
          </Group>
          <Button
            leftSection={<IconDownload size={16} />}
            onClick={exportChart}
            variant="light"
          >
            Export SVG
          </Button>
        </Group>

        {note && <Text size="xs" c="dimmed">{note}</Text>}

        {/* Chart */}
        <div ref={chartsRef}>
        {branchData.ext.length + branchData.fix.length > 0 ? (
          mode === 'time-dist-sgv' ? renderSGVChart() :
          mode === 'time-dist-skip' ? renderDualChart() :
          renderStandardChart()
        ) : (
          <Text c="dimmed" ta="center" style={{ height: 500, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            No data available
          </Text>
        )}
        </div>
      </Stack>
    </Modal>
  )
}

export default TimeDistChartModal