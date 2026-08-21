import React, { useState, useMemo } from 'react'
import InitialStateSelector, { InitialMode } from '../components/shared/InitialStateSelector'
import { saveTextFile } from '../utils/saveFile'
import { 
  Grid, 
  Paper, 
  Stack, 
  Title, 
  Group, 
  Text,
  Loader,
  Alert,
  Modal,
  Switch,
  Button,
  Box,
  Tooltip,
  ActionIcon,
  Tabs,
  useMantineTheme
} from '@mantine/core'
import { IconChartArea, IconCopy, IconTable,
  IconPlus,
  IconX
} from '@tabler/icons-react'
import { 
  WfesViewLayout,
  WfesParameterInput,
  WfesResultsTable,
  WfesExecutionPanel,
  WfesExportButtons,
  validateScientificNotation,
  validatePositiveInteger,
  validateProbability,
  generateFilename,
  exportToCSV
} from '../components/shared'
import { WfafdParams, WfesResultItem } from '../types/wfes'
import { wfesService } from '../services/wfesService'
import { Math as MathTeX } from '../components/shared'
import AboutContentPanel from '../components/AboutContentPanel'
import SwitchingStateDiagram from '../components/shared/SwitchingStateDiagram'
import { wfafdDiagram } from '../utils/switchingDiagrams'
import { formatResultsCopy } from '../utils/resultsCopy'
import { qtyRow } from '../utils/quantityLabels'
import SpectrumChartModal from '../components/SpectrumChartModal'

interface Component {
  N: string
  G: string
  s: string
  h: string
  u: string
  v: string
}

interface WfafdViewProps {
  onBack: () => void
  hideBackButton?: boolean
}

const WfafdViewMantine: React.FC<WfafdViewProps> = ({ onBack, hideBackButton = false }) => {
  const theme = useMantineTheme()
  // How the starting state is specified. This tool offers 2 of the three.
  const [initialMode, setInitialMode] = useState<InitialMode>('fixed')
  const [initialDistFile, setInitialDistFile] = useState('')
  const [populationScaled, setPopulationScaled] = useState(true)
  
  // Population parameters
  // One epoch list, in the same shape and with the same tabbed editor as
  // Stochastic Switching. This view used to carry a single parameter set plus a
  // list of population-size changes, which let only N vary -- but
  // wfafs_deterministic takes --selection/--dominance/--backward-mu/--forward-mu as well, so every
  // parameter can change per epoch. The two models differ in how long an epoch
  // lasts, not in what an epoch is, so they get the same interface.
  const [activeTab, setActiveTab] = useState('0')
  const [components, setComponents] = useState<Component[]>([
    { N: '100', G: '100', s: '0', h: '0.5', u: '0.001', v: '0.001' }
  ])

  const addComponent = () => {
    setComponents([...components, { ...components[components.length - 1] }])
    setActiveTab(String(components.length))
  }
  const removeComponent = (index: number) => {
    if (components.length <= 1) return
    const next = components.filter((_, i) => i !== index)
    setComponents(next)
    if (parseInt(activeTab) >= next.length) setActiveTab(String(next.length - 1))
  }
  const updateComponent = (index: number, field: keyof Component, value: string) => {
    const next = [...components]
    next[index] = { ...next[index], [field]: value }
    setComponents(next)
  }
  const [alpha, setAlpha] = useState('1e-20') // Probability cutoff
  
  // Distribution parameters
  // The start is specified through the standard selector: a fixed count, the
  // mutation-injection integration, or a file -- the same trio as everywhere
  // else. The old frequency field (p0, converted with round(p0*N) against a
  // 0..2N state space) is gone with the special-case UI it belonged to.
  const [startingCopies, setStartingCopies] = useState('1')
  const [integrationCutoff, setIntegrationCutoff] = useState('1e-10')
  
  // Population size changes (optional)
  
  // Output options
  const [outputOptions, setOutputOptions] = useState({
    writeQ: false,
    writeR: false,
    writeN: false,
    writeDist: true,
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
  const [distribution, setDistribution] = useState<any[]>([])
  const [isExecuting, setIsExecuting] = useState(false)
  const [progress, setProgress] = useState(0)
  const [progressMessage, setProgressMessage] = useState('')
  const [executionTime, setExecutionTime] = useState('')
  const [error, setError] = useState('')
  const [showChartModal, setShowChartModal] = useState(false)
  const [showTableModal, setShowTableModal] = useState(false)
  
  // Helper function to clear results and reset execution state
  const clearResults = () => {
    setResults([])
    setDistribution([])
    setExecutionTime('')
    setProgress(0)
    setProgressMessage('')
    setError('')
  }
  
  // Handle population scaling toggle
  // Scaling is per epoch, against that epoch's own N, because each epoch now
  // carries its own parameters.
  const handlePopulationScaledToggle = (newValue: boolean) => {
    if (newValue !== populationScaled) {
      setComponents(components.map(c => {
        const N = parseInt(c.N) || 100
        // Exact string conversion -- no toFixed/toExponential. handleExecute
        // sends `components` straight through to the CLI, unmodified, so
        // whatever rounding happened here used to be exactly what shipped;
        // toFixed(5) on `s` silently zeroed small population-scaled
        // selection coefficients at large N.
        const conv = (val: string, factor: number) => {
          const x = parseFloat(val) || 0
          if (x === 0) return '0'
          const y = newValue ? x * factor * N : x / (factor * N)
          return y.toString()
        }
        return { ...c, u: conv(c.u, 4), v: conv(c.v, 4), s: conv(c.s, 2) }
      }))
    }
    setPopulationScaled(newValue)
    clearResults()
  }

  const handleExecute = async () => {
    setIsExecuting(true)
    setProgress(0)
    clearResults()
    
    try {
      // Validate: every epoch needs a positive N and a positive duration.
      const bad = components.findIndex(c =>
        !(parseInt(c.N) > 0) || !(parseInt(c.G) > 0))
      if (bad >= 0) {
        setError(`Epoch ${bad + 1} needs a positive population size and number of generations.`)
        setIsExecuting(false)
        return
      }
      const N = parseInt(components[0].N)
      // buildWfafdArgs passes this straight to -p, an allele COUNT. Only the
      // fixed mode sends it; integrate sends the cutoff instead.
      const startingFreq = initialMode === 'fixed' ? parseInt(startingCopies) : undefined

      // Prepare parameters for backend. The epoch list is the state.
      const params = {
        // The chosen initial distribution. Every builder reads params.initial
        // before its own nested fallbacks.
        initial: initialMode === 'file' ? (initialDistFile || undefined) : undefined,
        startingFrequency: startingFreq,
        integrationCutoff: initialMode === 'integrate' ? integrationCutoff : undefined,
        components,
        alpha,
        outputOptions: {
          writeQ: outputOptions.writeQ,
          writeR: outputOptions.writeR,
          writeN: outputOptions.writeN,
          writeDist: outputOptions.writeDist,
          writeRes: outputOptions.writeRes
        },
        executionParams: {
          force: executionOptions.force,
          threads: executionOptions.threads,
          library: executionOptions.library
        },
        populationScaled
      }
      
      // Execute via IPC
      const result = await window.api.wfes.wfafd.execute(params)
      
      if (!result.success) {
        throw new Error(result.error || 'Execution failed')
      }
      
      // Process results
      const processedResults: WfesResultItem[] = []
      
      // Only Variance survives from the legacy statistics block: mean frequency
      // and the fixation/extinction masses are already shown by the spectrum
      // summaries below (E[freq], P_2N, P_0), and duplicate rows with different
      // names invited the question of whether they were different quantities.
      // They were not.
      //
      // Declared here rather than inside the guard below because it is pushed
      // after the spectrum summaries -- so that the two boundary masses (P_0,
      // P_2N) pair up on the table's first row.
      const varianceRow =
        result.statistics && result.statistics.variance !== undefined
          ? qtyRow('Var_freq', result.statistics.variance, {
              description: 'Variance of allele frequency'
            })
          : null
      
      if (result.executionTime) {
        // Reported under the table, not as a row in it: the results
        // table holds model quantities only.
        setExecutionTime(result.executionTime)
      }
      
      // Process distribution data
      if (result.distribution && Array.isArray(result.distribution)) {
        const processedDistribution = result.distribution.map((item: any) => ({
          copies: item.copies || item.i || 0,
          frequency: item.frequency || (item.copies / N) || 0,
          probability: item.probability || item.p || 0,
          cumulative: item.cumulative || 0
        }))
        
        // Calculate cumulative if not provided
        if (processedDistribution.length > 0 && !processedDistribution[0].cumulative) {
          let cumSum = 0
          processedDistribution.forEach((item: any) => {
            cumSum += item.probability
            item.cumulative = cumSum
          })
        }
        
        setDistribution(processedDistribution)

        // Distribution summaries, same set as WFAF-S so the two spectra are
        // directly comparable.
        if (processedDistribution.length > 0) {
          const maxCopies = Math.max(...processedDistribution.map((r: any) => r.copies))
          const total = processedDistribution.reduce((a: number, r: any) => a + r.probability, 0) || 1
          const massAt = (pred: (c: number) => boolean) =>
            processedDistribution.filter((r: any) => pred(r.copies))
              .reduce((a: number, r: any) => a + r.probability, 0) / total
          const pLost = massAt((c) => c === 0)
          const pFixed = massAt((c) => c === maxCopies)
          const meanFreq = processedDistribution.reduce(
            (a: number, r: any) => a + r.probability * (r.copies / maxCopies), 0) / total
          const het = processedDistribution.reduce(
            (a: number, r: any) => a + r.probability * 2 * (r.copies / maxCopies) * (1 - r.copies / maxCopies), 0) / total
          processedResults.push(
            qtyRow('P_0', pLost),
            qtyRow('P_2N', pFixed, {
              description: `Probability the allele is fixed (count ${maxCopies})`
            }),
            qtyRow('P_seg', 1 - pLost - pFixed, {
              description: 'Probability the allele is still segregating'
            }),
            qtyRow('E_freq', meanFreq, { description: 'Mean allele frequency' }),
            qtyRow('E_het', het, { description: 'Expected heterozygosity, 2p(1−p)' })
          )
          if (varianceRow) processedResults.push(varianceRow)
        }
      }
      
      setResults(processedResults)
      
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error occurred')
    } finally {
      setIsExecuting(false)
      setProgress(100)
    }
  }
  
  const handleStop = async () => {
    try {
      await wfesService.stopExecution()
      setIsExecuting(false)
    } catch (error) {
      console.error('Error stopping execution:', error)
    }
  }
  
  const handleExportData = (format: 'csv' | 'tsv') => {
    if (!distribution || distribution.length === 0) return
    
    const delimiter = format === 'tsv' ? '\t' : ','
    const headers = ['Copies', 'Frequency', 'Probability', 'Cumulative']
    
    const data = [
      headers,
      ...distribution.map(row => [
        row.copies,
        row.frequency.toFixed(6),
        row.probability.toExponential(6),
        row.cumulative.toFixed(6)
      ])
    ]
    
    const content = data.map(row => row.join(delimiter)).join('\n')
    // Through the main process: an <a download> is silently dropped here.
    void saveTextFile(content, generateFilename('wfafd', format))
  }
  
  const copyToClipboard = () => {
    navigator.clipboard.writeText(formatResultsCopy('WFAF-D results', results))
  }
  
  // Build command line string
  const buildCommandLine = () => {
    // Mirrors the actual run: view params -> IPC handler -> the arg builder in
    // wfesBackendService. The previous version emitted flags that exist in no
    // WFES tool, so the "run the same analysis from the command line" promise
    // under the preview was unkeepable. Verified against the spawned command.
    const parts = ['wfafs_deterministic']
    const N = parseInt(components[0]?.N) || 100
    if (initialMode === 'fixed') parts.push(`-p ${parseInt(startingCopies) || 0}`)
    if (initialMode === 'integrate') parts.push(`-c ${integrationCutoff}`)
    parts.push(`--pop-sizes ${components.map(c => parseInt(c.N) || 100).join(',')}`)
    parts.push(`--generations ${components.map(c => parseInt(c.G) || 0).join(',')}`)
    // Each epoch unscales against its own N.
    const per = (field: 's' | 'u' | 'v', scale: number) => components.map(c => {
      const x = parseFloat(c[field]) || 0
      return populationScaled ? x / (scale * (parseInt(c.N) || 100)) : x
    }).join(',')
    parts.push(`--selection ${per('s', 2)}`)
    parts.push(`--dominance ${components.map(c => parseFloat(c.h) || 0.5).join(',')}`)
    parts.push(`--backward-mu ${per('u', 4)}`)
    parts.push(`--forward-mu ${per('v', 4)}`)
    parts.push(`--alpha ${alpha}`)
    parts.push(`--num-threads ${executionOptions.threads}`)
    parts.push(`--library ${executionOptions.library}`)
    if (executionOptions.force) parts.push('--force')
    if (initialMode === 'file' && initialDistFile) parts.push(`--initial ${initialDistFile}`)
    parts.push('--json')
    return parts.join(' ')
  }
  
  const copyCommandLine = () => {
    const command = buildCommandLine()
    navigator.clipboard.writeText(command)
  }
  



  // A progress listener used to live here, subscribing to 'wfes:progress'
  // through optional-chained calls onto a window.api surface the preload
  // never exposes that pair of methods on (only wfes.onProgress /
  // removeProgressListener exist), so the subscribe and the cleanup were
  // both silent no-ops. Deleted rather than rewired to the real API: the CLI
  // emits no progress lines for this tool, so there is nothing to subscribe
  // to yet. `progress` and `progressMessage` state are left in place --
  // WfesExecutionPanel and the "Processing..." loading text below still read
  // them -- but now only ever move 0 -> 100 around handleExecute, with no
  // step in between. A later task removes the progress UI machinery
  // entirely; this is the render code it still needs to touch.

  // Count active output options for badge
  const activeOutputOptions = Object.values(outputOptions).filter(Boolean).length + 
    (executionOptions.force ? 1 : 0)
  
  // Live timeline: deterministic epochs derived exactly as the params builder
  // derives them from the size-change list.
  const diagramModel = useMemo(
    () => wfafdDiagram(components, populationScaled),
    [components, populationScaled])

  return (
    <WfesViewLayout
      title="Wright-Fisher Allele Frequency Distribution (WFAFD)"
      onBack={onBack}
      hideBackButton={hideBackButton}
      outputOptions={outputOptions}
      onOutputOptionsChange={setOutputOptions}
      executionOptions={executionOptions}
      onExecutionOptionsChange={setExecutionOptions}
      activeOptionsCount={activeOutputOptions}
    >
      {/* Technical Details */}
      <AboutContentPanel modelName="wfafs_deterministic" />
      
      <Grid>
        {/* Column 1: Parameters */}
        <Grid.Col span={6}>
          <Stack>
            {/* Epochs. Same editor as Stochastic Switching: this model differs in
                how long an epoch lasts, not in what an epoch is. */}
            <Paper p="md" withBorder>
              <Group justify="space-between" mb="sm">
                <Title order={6}>Components</Title>
                <Switch
                  label="Population Scaled"
                  checked={populationScaled}
                  onChange={(e) => handlePopulationScaledToggle(e.currentTarget.checked)}
                />
              </Group>
              <Tabs value={activeTab} onChange={(v) => setActiveTab(v || '0')}>
                <Tabs.List>
                  {components.map((_, index) => (
                    <Tabs.Tab key={index} value={String(index)} rightSection={
                      components.length > 1 ? (
                        <ActionIcon size="xs" variant="subtle"
                          onClick={(e) => { e.stopPropagation(); removeComponent(index) }}>
                          <IconX size={14} />
                        </ActionIcon>
                      ) : null
                    }>
                      Comp {index + 1}
                    </Tabs.Tab>
                  ))}
                  <ActionIcon variant="subtle" onClick={addComponent} ml="xs">
                    <IconPlus size={16} />
                  </ActionIcon>
                </Tabs.List>
                {components.map((comp, index) => (
                  <Tabs.Panel key={index} value={String(index)} pt="md">
                    <Stack gap="sm">
                      <Group grow>
                        <WfesParameterInput
                          type="text" label="N" description="Population size"
                          value={comp.N}
                          onChange={(value) => updateComponent(index, 'N', value)}
                          error={!validatePositiveInteger(comp.N)}
                        />
                        <WfesParameterInput
                          type="text" label="G" description="Exact generations"
                          tooltip="This epoch lasts exactly this many generations. Use Stochastic Switching for geometrically distributed epoch lengths."
                          value={comp.G}
                          onChange={(value) => updateComponent(index, 'G', value)}
                          error={!validatePositiveInteger(comp.G)}
                        />
                      </Group>
                      <Group grow>
                        <WfesParameterInput
                          type="scientific" label={populationScaled ? "4Nu" : "u"}
                          description="Backward mutation rate"
                          value={comp.u}
                          onChange={(value) => updateComponent(index, 'u', value)}
                          error={!validateScientificNotation(comp.u)}
                        />
                        <WfesParameterInput
                          type="scientific" label={populationScaled ? "4Nv" : "v"}
                          description="Forward mutation rate"
                          value={comp.v}
                          onChange={(value) => updateComponent(index, 'v', value)}
                          error={!validateScientificNotation(comp.v)}
                        />
                      </Group>
                      <Group grow>
                        <WfesParameterInput
                          type="text" label={populationScaled ? "2Ns" : "s"}
                          description="Selection coefficient"
                          value={comp.s}
                          onChange={(value) => updateComponent(index, 's', value)}
                          error={!validateScientificNotation(comp.s)}
                        />
                        <WfesParameterInput
                          type="text" label="h" description="Dominance coefficient"
                          value={comp.h}
                          onChange={(value) => updateComponent(index, 'h', value)}
                          error={!validateProbability(comp.h)}
                        />
                      </Group>
                    </Stack>
                  </Tabs.Panel>
                ))}
              </Tabs>
            </Paper>
            
            
            {/* Numerical Parameters */}
            <Paper p="md" withBorder>
              <Title order={6} mb="sm">Numerical Parameters</Title>
              <Stack gap="sm">
                <WfesParameterInput
                  type="scientific"
                  label="α"
                  description="Probability cutoff"
                  helpText="Probability mass trimmed from the tails of each matrix row (α/2 per tail), which the row is renormalised after"
                  value={alpha}
                  onChange={setAlpha}
                  error={!validateScientificNotation(alpha)}
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
                      <>
                        <Button 
                          variant="light" 
                          size="sm"
                          leftSection={<IconChartArea size={16} />}
                          onClick={() => setShowChartModal(true)}
                        >
                          View Chart
                        </Button>
                        <Button 
                          variant="light" 
                          size="sm"
                          leftSection={<IconTable size={16} />}
                          onClick={() => setShowTableModal(true)}
                        >
                          View Table
                        </Button>
                      </>
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
              
              {error && (
                <Alert color="red" mb="md">
                  {error}
                </Alert>
              )}
              
              {results.length > 0 ? (
                <Stack>
                  <WfesResultsTable data={results} columns={2} />
                  <Text size="xs" c="dimmed">Execution time: {executionTime}</Text>
                  {distribution.length > 0 && (
                    <Group mt="md">
                      <WfesExportButtons
                        onExport={(format) => {
                          if (format === 'csv') handleExportData('csv')
                          else if (format === 'png' || format === 'svg') {
                            // A chart can only be serialized while it is on
                            // screen, so this opens it; the modal's own Export
                            // SVG writes every panel it is showing. Previously
                            // both formats were silently no-ops.
                            setShowChartModal(true)
                          }
                        }}
                        formats={['csv', 'png', 'svg']}
                      />
                    </Group>
                  )}
                </Stack>
              ) : (
                <Stack align="center" justify="center" style={{ height: '300px' }}>
                  {isExecuting ? (
                    <>
                      <Loader size="lg" />
                      <Text size="sm" c="dimmed">{progressMessage || 'Processing...'}</Text>
                    </>
                  ) : (
                    <Text size="sm" c="dimmed">
                      No results yet. Configure parameters and click Execute.
                    </Text>
                  )}
                </Stack>
              )}
            </Paper>
            
            {/* Execution Panel */}
            <WfesExecutionPanel
              isExecuting={isExecuting}
              progress={progress}
              progressMessage={progressMessage}
              error={error}
              onExecute={handleExecute}
              onStop={handleStop}
            />
          </Stack>
        </Grid.Col>
      </Grid>
      
      {/* Live model-structure diagram */}
      <SwitchingStateDiagram model={diagramModel} />

      {/* How the starting state is specified. The modes offered are the

          ones this tool actually has; see InitialStateSelector. */}

      <Paper p="md" withBorder mt="md">

        <Title order={6}>Initial state</Title>

        <InitialStateSelector

          modes={['fixed', 'integrate', 'file']}

          value={initialMode}

          onChange={(m) => { setInitialMode(m); if (m !== 'file') setInitialDistFile('') }}

          file={initialDistFile}

          onFileChange={setInitialDistFile}

          expectedLength={(parseInt(components[0]?.N) || 0) > 0 ? 2 * parseInt(components[0].N) + 1 : null}

          stateSpace="allele counts 0..2N in the first epoch"

        />
        {initialMode === 'fixed' && (
          <WfesParameterInput
            type="text"
            label="Starting copies (p)"
            description="Initial number of copies of the allele in the first epoch; NOT a sample size"
            value={startingCopies}
            onChange={setStartingCopies}
            error={!validatePositiveInteger(startingCopies)}
          />
        )}
        {initialMode === 'integrate' && (
          <WfesParameterInput
            type="scientific"
            label="Integration cutoff (c)"
            description="Starting copy numbers rarer than this are left out of the integration over p"
            value={integrationCutoff}
            onChange={setIntegrationCutoff}
            error={!validateScientificNotation(integrationCutoff)}
          />
        )}

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
      <SpectrumChartModal
        opened={showChartModal}
        onClose={() => setShowChartModal(false)}
        data={distribution.map((d: any) => ({
          copies: d.copies,
          probability: d.probability,
          cumulative: d.cumulative
        }))}
        title="Allele frequency distribution (deterministic)"
        filename="wfafs_deterministic_spectrum"
      />
      
      {/* Table Modal */}
      <Modal
        opened={showTableModal}
        onClose={() => setShowTableModal(false)}
        size="lg"
        title="Frequency Distribution Data"
      >
        <Stack>
          <div style={{ overflowX: 'auto', maxHeight: '500px', overflowY: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead style={{ position: 'sticky', top: 0, background: 'var(--mantine-color-dark-7)' }}>
                <tr style={{ borderBottom: '2px solid var(--mantine-color-dark-4)' }}>
                  <th style={{ padding: '8px', textAlign: 'left' }}>Copies</th>
                  <th style={{ padding: '8px', textAlign: 'right' }}>Frequency</th>
                  <th style={{ padding: '8px', textAlign: 'right' }}>Probability</th>
                  <th style={{ padding: '8px', textAlign: 'right' }}>Cumulative</th>
                </tr>
              </thead>
              <tbody>
                {distribution.map((row, index) => (
                  <tr key={index} style={{ borderBottom: '1px solid var(--mantine-color-dark-6)' }}>
                    <td style={{ padding: '8px' }}>{row.copies}</td>
                    <td style={{ padding: '8px', textAlign: 'right' }}>{row.frequency.toFixed(6)}</td>
                    <td style={{ padding: '8px', textAlign: 'right' }}>{row.probability.toExponential(6)}</td>
                    <td style={{ padding: '8px', textAlign: 'right' }}>{row.cumulative.toFixed(6)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Group justify="flex-end" mt="md">
            <WfesExportButtons
              onExport={(format) => {
                if (format === 'csv') handleExportData('csv')
              }}
              formats={['csv']}
            />
          </Group>
        </Stack>
      </Modal>
      
    </WfesViewLayout>
  )
}

export default WfafdViewMantine