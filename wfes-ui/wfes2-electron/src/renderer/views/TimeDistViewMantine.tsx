import React, { useState, useEffect } from 'react'
import InitialStateSelector, { InitialMode } from '../components/shared/InitialStateSelector'
import { saveTextFile } from '../utils/saveFile'
import { 
  Grid, 
  Paper, 
  Stack, 
  Title, 
  SegmentedControl, 
  Group, 
  Text,
  Loader,
  Alert,
  Modal,
  Switch,
  Button,
  ActionIcon,
  Box,
  Tooltip,
  useMantineTheme,
  Progress
} from '@mantine/core'
import { IconChartLine, IconCopy, IconPlayerPlay } from '@tabler/icons-react'
import { 
  WfesViewLayout,
  WfesParameterInput,
  WfesResultsTable,
  WfesExportButtons,
  validateScientificNotation,
  validatePositiveInteger,
  validateProbability,
  generateFilename
} from '../components/shared'
import { TimeDistParams, WfesResultItem } from '../types/wfes'
import { qtyRow, sdRow } from '../utils/quantityLabels'
import { wfesService } from '../services/wfesService'
import TimeDistChartModal from '../components/TimeDistChartModal'
import { Math as MathTeX } from '../components/shared'
import AboutContentPanel from '../components/AboutContentPanel'
import { useExecuteShortcut } from '../hooks/useExecuteShortcut'

interface TimeDistViewProps {
  onBack: () => void
  hideBackButton?: boolean
  /**
   * Which of this view's two tools to open on, for cross-links that name one.
   * A mount-time seed: App remounts the view when the requested tool changes.
   * Not to be confused with initialMode below, which is this view's own state
   * for HOW the starting distribution is specified.
   */
  initialTool?: ModeType
}

type ModeType = 'time-dist' | 'time-dist-dual'

const TimeDistViewMantine: React.FC<TimeDistViewProps> = ({ onBack, hideBackButton = false, initialTool = 'time-dist' }) => {
  const theme = useMantineTheme()
  // How the starting state is specified. This tool offers 2 of the three.
  const [initialMode, setInitialMode] = useState<InitialMode>('integrate')
  const [initialDistFile, setInitialDistFile] = useState('')
  const [mode, setMode] = useState<ModeType>(initialTool)
  const [populationScaled, setPopulationScaled] = useState(true)
  
  // Population parameters
  const [populationSize, setPopulationSize] = useState('100')
  const [a, setA] = useState('1e-20') // Probability cutoff (alpha)
  const [l, setL] = useState('10')
  // The CLI's own default, not 0.999. Until time_dist's stopping rule was
  // fixed the cutoff never fired and every run computed the full --max-t, so
  // the displayed moments were effectively exact. With the rule working, 0.999
  // stops while the tail still matters: measured at N=100, s=0, that cutoff
  // puts SD[T_fix] 2.1% and T_fix 0.35% below the fully-converged values.
  // At 1e-8 every statistic matches the old full-length run to 1e-6, in 3,895
  // steps instead of 1,000,000.
  const [c, setC] = useState('0.99999999')
  const [m, setM] = useState('1000000')
  
  
  // Mutation parameters
  const [u, setU] = useState('0.001')
  const [v, setV] = useState('0.001')
  
  // Selection parameters
  const [s, setS] = useState('0')
  const [h, setH] = useState('0.5')
  
  // No recurrent mutation checkbox
  const [noRecurrentMutation, setNoRecurrentMutation] = useState(false)
  
  // Output options
  const [outputOptions, setOutputOptions] = useState({
    writeQ: false,
    writeR: false,
    writeP: false,
    writeRes: true
  })
  
  // Execution options
  const [executionOptions, setExecutionOptions] = useState({
    force: false,
    threads: navigator.hardwareConcurrency || 4,
    library: 'Accelerate' as const
  })
  
  // Results state
  const [results, setResults] = useState<WfesResultItem[]>([])
  // Set when the solver stopped on --max-t rather than converging: the times
  // below are then computed over a truncated window and understate the truth.
  const [truncation, setTruncation] = useState<{ captured: number; steps: number; cutoff: number } | null>(null)
  const [distribution, setDistribution] = useState<any[]>([])
  const [isExecuting, setIsExecuting] = useState(false)
  const [progress, setProgress] = useState(0)
  const [progressMessage, setProgressMessage] = useState('')
  const [executionTime, setExecutionTime] = useState('')
  const [error, setError] = useState('')
  const [showChartModal, setShowChartModal] = useState(false)
  
  // Detect platform for library default
  useEffect(() => {
    const isMac = typeof navigator !== 'undefined' && 
      navigator.platform && navigator.platform.toLowerCase().includes('mac')
    setExecutionOptions(prev => ({
      ...prev,
      library: isMac ? 'Accelerate' : 'Pardiso'
    }))
  }, [])
  
  // Helper function to clear results and reset execution state
  const clearResults = () => {
    setResults([])
    setTruncation(null)
    setDistribution([])
    setExecutionTime('')
    setProgress(0)
    setProgressMessage('')
    setError('')
  }

  // Handle mode change
  useEffect(() => {
    clearResults()
  }, [mode])
  
  // Handle population scaling toggle
  const handlePopulationScaledToggle = (newValue: boolean) => {
    const N = parseInt(populationSize) || 1000
    
    if (newValue && !populationScaled) {
      // Converting from raw to scaled values
      const rawU = parseFloat(u) || 0
      const rawV = parseFloat(v) || 0
      const rawS = parseFloat(s) || 0
      
      setU((rawU * 4 * N).toExponential(3))
      setV((rawV * 4 * N).toExponential(3))
      setS(rawS === 0 ? '0' : (rawS * 2 * N).toString())
    } else if (!newValue && populationScaled) {
      // Converting from scaled to raw values
      const scaledU = parseFloat(u) || 0
      const scaledV = parseFloat(v) || 0
      const scaledS = parseFloat(s) || 0
      
      setU((scaledU / (4 * N)).toExponential(3))
      setV((scaledV / (4 * N)).toExponential(3))
      setS(scaledS === 0 ? '0' : (scaledS / (2 * N)).toExponential(3))
    }
    
    setPopulationScaled(newValue)
  }
  
  const handleExecute = async () => {
    setIsExecuting(true)
    setProgress(0)
    clearResults()
    
    // Set up progress listener
    window.api.wfes.onProgress((data) => {
      if (data.progress !== undefined) {
        setProgress(data.progress)
      }
      if (data.message) {
        setProgressMessage(data.message)
      }
      if (data.executionTime) {
        setExecutionTime(data.executionTime)
      }
    })
    
    try {
      // Convert population-scaled values to raw values if needed
      let processedMutationParams = { u, v }
      let processedSelectionParams = { s, h }
      
      if (populationScaled) {
        const N = parseInt(populationSize) || 1000
        processedMutationParams = {
          u: (parseFloat(u) / (4 * N)).toString(),
          v: (parseFloat(v) / (4 * N)).toString()
        }
        processedSelectionParams = {
          s: (parseFloat(s) / (2 * N)).toString(),
          h
        }
      }
      
      const params = {
      
        // The chosen initial distribution. Every builder reads params.initial
      
        // before its own nested fallbacks.
      
        initial: initialMode === 'file' ? (initialDistFile || undefined) : undefined,
        mode,
        populationParams: {
          N: populationSize, a, l, c, m
        },
        mutationParams: processedMutationParams,
        selectionParams: processedSelectionParams,
        noRecurrentMutation,
        outputOptions,
        executionParams: executionOptions
      }
      
      const result = await wfesService.executeTimeDist(params)
      console.log(`TimeDistView received result for ${mode}:`, {
        hasResults: !!result.results,
        resultsLength: result.results?.length || 0,
        hasDistribution: !!result.distribution,
        distributionLength: result.distribution?.length || 0
      })
      
      // Process results
      if (result.results && result.results.length > 0) {
        // Original implementation returns string array, convert to WfesResultItem format
        const resultItems: WfesResultItem[] = result.results.map((res: string, idx: number) => {
          // Parse the result string to extract label and value
          const parts = res.split(':')
          if (parts.length >= 2) {
            return {
              label: parts[0].trim(),
              value: parts[1].trim(),
              description: ''
            }
          }
          return { label: `Result ${idx + 1}`, value: res, description: '' }
        })
        setResults(resultItems)
      }
      
      if (result.distribution) {
        // Calculate cumulative distributions if not present
        let processedDist = result.distribution
        if (result.distribution.length > 0 && !result.distribution[0].cdf_ext) {
          let cdfExt = 0
          let cdfFix = 0
          let cdfTotal = 0
          
          processedDist = result.distribution.map((row: any) => {
            cdfExt += row.p_ext || 0
            cdfFix += row.p_fix || 0
            cdfTotal += row.p_total || (row.p_ext + row.p_fix) || 0
            
            return {
              ...row,
              cdf_ext: cdfExt,
              cdf_fix: cdfFix,
              cdf_total: cdfTotal
            }
          })
        }
        
        setDistribution(processedDist)
        
        // Calculate statistics from distribution
        const stats = calculateStats(processedDist)
        const statResults: WfesResultItem[] = []
        
        // These are moments of the COMPUTED distribution: accumulated over the
        // time window the run covered, not to infinity. Said in the
        // descriptions, since the same symbols name exact limits elsewhere.
        if (stats.cdfExt > 0) {
          statResults.push(
            qtyRow('T_ext', stats.meanExt, {
              description: 'Expected extinction time over the computed window'
            }),
            sdRow('T_ext', stats.stdExt),
            qtyRow('P_ext', stats.cdfExt, {
              description: 'Extinction probability over the computed window'
            })
          )
        }
        
        if (stats.cdfFix > 0) {
          statResults.push(
            qtyRow('T_fix', stats.meanFix, {
              description: 'Expected fixation time over the computed window'
            }),
            sdRow('T_fix', stats.stdFix),
            qtyRow('P_fix', stats.cdfFix, {
              description: 'Fixation probability over the computed window'
            })
          )
        }
        
        // Execution time is reported under the table, not as a row in it:
        // the results table holds model quantities only.
        
        // Did the solver converge, or run out of generations? Same disclosure
        // as the phase-type view: a truncated window makes every moment
        // computed from it a lower bound, and nothing said so before.
        const st = result.statistics || {}
        setTruncation(st.reached_cutoff === false ? {
          captured: st.total_probability_absorption ?? (stats.cdfExt + stats.cdfFix),
          steps: st.time_steps_computed ?? 0,
          cutoff: st.distribution_cutoff ?? 0
        } : null)

        setResults(statResults)
      }
      
      setExecutionTime(result.executionTime || '')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error occurred')
    } finally {
      setIsExecuting(false)
      setProgress(100)
      // Clean up progress listener
      window.api.wfes.removeProgressListener()
    }
  }
  
  const handleStop = () => {
    wfesService.stopExecution()
    setIsExecuting(false)
  }
  
  const calculateStats = (dist: any[]) => {
    if (!dist || dist.length === 0) {
      return { meanExt: 0, meanFix: 0, stdExt: 0, stdFix: 0, cdfExt: 0, cdfFix: 0 }
    }
    
    let meanExt = 0
    let meanFix = 0
    let m2Ext = 0
    let m2Fix = 0
    let cdfExt = 0
    let cdfFix = 0

    dist.forEach((row) => {
      const t = row.time
      meanExt += t * row.p_ext
      meanFix += t * row.p_fix
      m2Ext += t * t * row.p_ext
      m2Fix += t * t * row.p_fix
      cdfExt += row.p_ext
      cdfFix += row.p_fix
    })

    const stats = {
      meanExt: cdfExt > 0 ? meanExt / cdfExt : 0,
      meanFix: cdfFix > 0 ? meanFix / cdfFix : 0,
      stdExt: 0,
      stdFix: 0,
      cdfExt,
      cdfFix
    }

    // Calculate standard deviations
    if (cdfExt > 0) {
      const m2ExtCond = m2Ext / cdfExt
      stats.stdExt = Math.sqrt(m2ExtCond - stats.meanExt * stats.meanExt)
    }
    if (cdfFix > 0) {
      const m2FixCond = m2Fix / cdfFix
      stats.stdFix = Math.sqrt(m2FixCond - stats.meanFix * stats.meanFix)
    }

    return stats
  }
  
  const handleExportData = (format: 'csv' | 'tsv') => {
    if (!distribution || distribution.length === 0) return
    
    const delimiter = format === 'tsv' ? '\t' : ','
    const headers = ['Time', 'P(ext)', 'P(fix)', 'P(total)', 'CDF(ext)', 'CDF(fix)', 'CDF(total)']
    
    const data = [
      headers,
      ...distribution.map(row => [
        row.time,
        row.p_ext.toExponential(6),
        row.p_fix.toExponential(6),
        row.p_total.toExponential(6),
        (row.cdf_ext || row.cdf || 0).toExponential(6),
        (row.cdf_fix || 0).toExponential(6),
        (row.cdf_total || row.cdf || 0).toExponential(6)
      ])
    ]
    
    const content = data.map(row => row.join(delimiter)).join('\n')
    // Through the main process: an <a download> is silently dropped here.
    void saveTextFile(content, generateFilename('time_dist', format))
  }
  
  const copyToClipboard = () => {
    // ASCII names and unrounded values, like every other view.
    const text = results.map(r => `${r.plain ?? r.label}\t${r.raw ?? r.value}`).join('\n')
    navigator.clipboard.writeText(text)
  }
  
  // Build command line string
  const buildCommandLine = () => {
    // Mirrors the actual run: view params -> IPC handler -> the arg builder in
    // wfesBackendService. The previous version emitted flags that exist in no
    // WFES tool, so the "run the same analysis from the command line" promise
    // under the preview was unkeepable. Verified against the spawned command.
    const parts = [mode === 'time-dist-dual' ? 'time_dist_dual' : 'time_dist']
    const N = parseInt(populationSize) || 1000
    const rawS = populationScaled ? (parseFloat(s) || 0) / (2 * N) : (parseFloat(s) || 0)
    const rawU = populationScaled ? (parseFloat(u) || 0) / (4 * N) : (parseFloat(u) || 0)
    const rawV = populationScaled ? (parseFloat(v) || 0) / (4 * N) : (parseFloat(v) || 0)
    parts.push(`--pop-size ${N}`)
    parts.push(`--alpha ${a}`)
    parts.push(`--block-size ${l}`)
    parts.push(`--distribution-cutoff ${c}`)
    parts.push(`--max-t ${m}`)
    parts.push(`--selection ${rawS}`)
    parts.push(`--dominance ${parseFloat(h) || 0.5}`)
    parts.push(`--backward-mu ${rawU}`)
    parts.push(`--forward-mu ${rawV}`)
    if (noRecurrentMutation) parts.push('--no-recurrent-mu')
    if (executionOptions.force) parts.push('--force')
    parts.push(`--num-threads ${executionOptions.threads}`)
    parts.push(`--library ${executionOptions.library}`)
    if (initialMode === 'file' && initialDistFile) parts.push(`--initial ${initialDistFile}`)
    parts.push('--json')
    return parts.join(' ')
  }
  
  const copyCommandLine = () => {
    const command = buildCommandLine()
    navigator.clipboard.writeText(command)
  }
  
  // Count active output options for badge
  const activeOutputOptions = Object.values(outputOptions).filter(Boolean).length + 
    (executionOptions.force ? 1 : 0)
  
  // Cmd+Enter (Ctrl+Enter off macOS) fires Execute / Re-execute.
  useExecuteShortcut(handleExecute, isExecuting)

  return (
    <WfesViewLayout
      title="Time to Extinction and Fixation"
      onBack={onBack}
      hideBackButton={hideBackButton}
      outputOptions={outputOptions}
      onOutputOptionsChange={setOutputOptions}
      executionOptions={executionOptions}
      onExecutionOptionsChange={setExecutionOptions}
      activeOptionsCount={activeOutputOptions}
    >
      <style>{`
        .mode-selector .mantine-SegmentedControl-label {
          transition: all 200ms ease;
          cursor: pointer;
        }
        .mode-selector .mantine-SegmentedControl-label:hover {
          background-color: rgba(59, 130, 246, 0.1);
          padding-left: 20px;
        }
        .mode-selector .mantine-SegmentedControl-input:checked + .mantine-SegmentedControl-label:hover {
          background-color: #2563eb;
        }
      `}</style>
      {/* Technical Details */}
      {/* The panel follows the mode. The two modes run different binaries
          (time_dist vs time_dist_dual) whose documents describe different
          starting conditions, so a pinned name explains the wrong tool. */}
      <AboutContentPanel modelName={mode === 'time-dist-dual' ? 'time_dist_dual' : 'time_dist'} />
      
      <Grid>
        {/* Column 1: Mode and Parameters */}
        <Grid.Col span={6}>
          <Stack>
            {/* Mode Selection */}
            <Paper p="md" withBorder>
              <Title order={6} mb="sm">Mode</Title>
              <SegmentedControl
                value={mode}
                onChange={(value) => {
                  setMode(value as ModeType)
                  clearResults()
                }}
                data={[
                  { value: 'time-dist', label: 'Time-Homogeneous' },
                  { value: 'time-dist-dual', label: 'Time-Homogeneous (including mutation time)' }
                ]}
                orientation="vertical"
                fullWidth
                color="blue"
                size="md"
                className="mode-selector"
              />
              <Text size="sm" c="dimmed" mt="sm">
                {mode === 'time-dist' && 'Compute the probability distributions for time to extinction and fixation assuming we start with *one copy* of the mutant allele'}
                {mode === 'time-dist-dual' && 'Compute the probability distributions for time to extinction and fixation assuming we start with *zero copies* of the mutant allele'}
              </Text>
            </Paper>
            
            {/* Population Parameters */}
            <Paper p="md" withBorder>
              <Group justify="space-between" mb="sm">
                <Title order={6}>Population Parameters</Title>
                <Switch 
                  label="Population Scaled" 
                  checked={populationScaled}
                  onChange={(e) => handlePopulationScaledToggle(e.currentTarget.checked)}
                />
              </Group>
              <Stack gap="sm">
                <WfesParameterInput
                  type="text"
                  label="N"
                  description="Population size"
                  value={populationSize}
                  onChange={setPopulationSize}
                  error={!validatePositiveInteger(populationSize)}
                />
                <WfesParameterInput
                  type="scientific"
                  label="α"
                  description="Probability cutoff"
                  helpText="Probability mass trimmed from the tails of each matrix row (α/2 per tail), which the row is renormalised after"
                  value={a}
                  onChange={setA}
                  error={!validateScientificNotation(a)}
                />
                <WfesParameterInput
                  type="text"
                  label="l"
                  description="Block size"
                  value={l}
                  onChange={setL}
                  error={!validatePositiveInteger(l)}
                />
                <WfesParameterInput
                  type="text"
                  label="d"
                  description="Distribution cutoff"
                  helpText="Stop when this fraction of the total probability is computed"
                  value={c}
                  onChange={setC}
                  error={!validateProbability(c)}
                />
                <WfesParameterInput
                  type="text"
                  label="m"
                  description="Maximum time"
                  value={m}
                  onChange={setM}
                  error={!validatePositiveInteger(m)}
                />
              </Stack>
            </Paper>
            
            {/* Mutation Parameters */}
            <Paper p="md" withBorder>
              <Title order={6} mb="sm">Mutation Parameters</Title>
              <Stack gap="sm">
                <WfesParameterInput
                  type="scientific"
                  label={populationScaled ? "4Nu" : "u"}
                  description="Backward mutation rate"
                  value={u}
                  onChange={setU}
                  error={!validateScientificNotation(u)}
                />
                <WfesParameterInput
                  type="scientific"
                  label={populationScaled ? "4Nv" : "v"}
                  description="Forward mutation rate"
                  value={v}
                  onChange={setV}
                  error={!validateScientificNotation(v)}
                />
                <WfesParameterInput
                  type="checkbox"
                  label="No recurrent mutation"
                  value={noRecurrentMutation}
                  onChange={setNoRecurrentMutation}
                />
              </Stack>
            </Paper>
            
            {/* Selection Parameters */}
            <Paper p="md" withBorder>
              <Title order={6} mb="sm">Selection Parameters</Title>
              <Stack gap="sm">
                <WfesParameterInput
                  type="text"
                  label={populationScaled ? "2Ns" : "s"}
                  description="Selection coefficient"
                  value={s}
                  onChange={setS}
                  error={!validateScientificNotation(s)}
                />
                <WfesParameterInput
                  type="text"
                  label="h"
                  description="Dominance coefficient"
                  value={h}
                  onChange={setH}
                  error={!validateProbability(h)}
                />
              </Stack>
            </Paper>
          </Stack>
        </Grid.Col>
        
        {/* Column 2: Results and Execution */}
        <Grid.Col span={6}>
          <Stack>
            {/* Results */}
            <Paper p="md" withBorder style={{ minHeight: '400px' }}>
              <Group justify="space-between" mb="md">
                <Title order={6}>Results</Title>
                {results.length > 0 && (
                  <Group gap="xs">
                    {distribution.length > 0 && (
                      <Button 
                        variant="light" 
                        size="sm"
                        leftSection={<IconChartLine size={16} />}
                        onClick={() => setShowChartModal(true)}
                      >
                        View Chart
                      </Button>
                    )}
                    <Button 
                      variant="light" 
                      size="sm"
                      leftSection={<IconCopy size={16} />}
                      onClick={copyToClipboard}
                    >
                      Copy
                    </Button>
                  </Group>
                )}
              </Group>
              
              {truncation && (
                <Alert color="yellow" mb="md" title="Distributions did not converge">
                  <Text size="sm">
                    The solver stopped at the generation limit ({truncation.steps.toLocaleString()}{' '}
                    generations) with {(100 * truncation.captured).toFixed(2)}% of the mass absorbed,
                    short of the {truncation.cutoff} cutoff for each branch. The times below are
                    computed over that window only, so they are UNDERESTIMATES. Raise the generation
                    limit to converge.
                  </Text>
                </Alert>
              )}

              {error && (
                <Alert color="red" mb="md">
                  {error}
                </Alert>
              )}
              
              {results.length > 0 ? (
                <Stack>
                  <WfesResultsTable data={results} columns={1} />
                  <Text size="xs" c="dimmed">Execution time: {executionTime}</Text>
                  {distribution.length > 0 && (
                    <Group mt="md">
                      <WfesExportButtons
                        onExport={(format) => {
                          if (format === 'csv' || format === 'tsv') handleExportData(format as 'csv' | 'tsv')
                          else if (format === 'png' || format === 'svg') {
                            // Open chart modal for visual export
                            setShowChartModal(true)
                          }
                        }}
                        formats={['csv', 'tsv', 'png', 'svg']}
                      />
                    </Group>
                  )}
                  <Button 
                    variant="light" 
                    size="md"
                    fullWidth
                    mt="md"
                    onClick={handleExecute}
                    disabled={isExecuting}
                  >
                    Re-execute
                  </Button>
                </Stack>
              ) : (
                <Stack align="center" justify="center" style={{ height: '300px' }}>
                  {isExecuting ? (
                    <>
                      <Loader size="lg" />
                      <Text size="sm" c="dimmed" mt="md">{progressMessage || 'Processing...'}</Text>
                      {progress > 0 && (
                        <Progress 
                          value={progress} 
                          size="sm" 
                          style={{ width: '200px' }} 
                          mt="sm"
                        />
                      )}
                      <Button 
                        variant="light" 
                        color="red"
                        size="sm"
                        mt="md"
                        onClick={handleStop}
                      >
                        Stop
                      </Button>
                    </>
                  ) : (
                    <Stack align="center">
                      <Text size="sm" c="dimmed">
                        No results yet. Configure parameters and click Execute.
                      </Text>
                      <Button 
                        size="lg" 
                        mt="md"
                        onClick={handleExecute}
                        leftSection={<IconPlayerPlay size={20} />}
                      >
                        Execute
                      </Button>
                    </Stack>
                  )}
                </Stack>
              )}
            </Paper>
          </Stack>
        </Grid.Col>
      </Grid>
      
      {/* How the starting state is specified. The modes offered are the
      
          ones this tool actually has; see InitialStateSelector. */}
      
      <Paper p="md" withBorder mt="md">
      
        <Title order={6}>Initial state</Title>
      
        <InitialStateSelector
      
          modes={['integrate', 'file']}
      
          value={initialMode}
      
          onChange={(m) => { setInitialMode(m); if (m !== 'file') setInitialDistFile('') }}
      
          file={initialDistFile}
      
          onFileChange={setInitialDistFile}
      
          expectedLength={(parseInt(populationSize) || 0) > 0 ? 2 * parseInt(populationSize) - 1 : null}
      
          stateSpace="allele counts 1..2N-1"
      
        />
      
      </Paper>

      
      {/* Command Line Preview - Full Width */}
      <Paper p="md" withBorder mt="md">
        <Group justify="space-between" mb="sm">
          <Title order={6}>Command Line Preview</Title>
          <Tooltip label="Copy command">
            <ActionIcon 
              variant="light" 
              onClick={copyCommandLine}
            >
              <IconCopy size={16} />
            </ActionIcon>
          </Tooltip>
        </Group>
        <Box
          style={{
            backgroundColor: theme.colors.gray[9],
            padding: '12px',
            borderRadius: '4px',
            fontFamily: 'monospace',
            fontSize: '13px',
            color: theme.colors.gray[3],
            overflowX: 'auto',
            whiteSpace: 'nowrap'
          }}
        >
          {buildCommandLine()}
        </Box>
        <Text size="xs" c="dimmed" mt="xs">
          This command can be used to run the same analysis from the command line
        </Text>
      </Paper>
      
      {/* Chart Modal */}
      <TimeDistChartModal
        opened={showChartModal}
        onClose={() => setShowChartModal(false)}
        data={distribution}
        mode={mode}
      />
    </WfesViewLayout>
  )
}

export default TimeDistViewMantine