import React, { useState, useEffect, useMemo } from 'react'
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
  Tabs,
  ActionIcon,
  Select,
  Box,
  Tooltip,
  useMantineTheme
} from '@mantine/core'
import { IconChartBar, IconCopy, IconTable, IconPlus, IconX } from '@tabler/icons-react'
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
import { WfafsParams, WfesResultItem } from '../types/wfes'
import { Math as MathTeX } from '../components/shared'
import AboutContentPanel from '../components/AboutContentPanel'
import SwitchingStateDiagram from '../components/shared/SwitchingStateDiagram'
import { wfafsDiagram } from '../utils/switchingDiagrams'
import { formatResultsCopy } from '../utils/resultsCopy'
import { qtyRow } from '../utils/quantityLabels'
import SpectrumChartModal from '../components/SpectrumChartModal'

interface Component {
  N: string
  G: string
  f: string
  u: string
  v: string
  s: string
  h: string
}

interface WfafsViewProps {
  onBack: () => void
  hideBackButton?: boolean
}

// Single source for the spectrum table and its TSV export, so the two
// cannot drift out of sync with each other again (audit 2.13: they used to
// share the same wrong headers, independently). Each row from
// parseWfafsOutput (wfesBackendService.ts) carries `frequency`/`count` as
// the SAME allele copy-number integer and `expected` as the raw per-row
// probability from the solver; `proportion` renormalises `expected` over the
// total of every row in this spectrum -- not necessarily the full 0..2N
// state space, since e.g. alpha-trimming can exclude tail mass -- i.e. it is
// the proportion "of shown", not a claim about the whole distribution.
const SPECTRUM_COLUMNS: { header: string; format: (row: any) => string }[] = [
  { header: 'Copies', format: (row) => String(row.frequency) },
  { header: 'Proportion (of shown)', format: (row) => row.proportion.toFixed(6) },
  { header: 'Probability', format: (row) => row.expected.toFixed(6) }
]

const WfafsViewMantine: React.FC<WfafsViewProps> = ({ onBack, hideBackButton = false }) => {
  const theme = useMantineTheme()
  // How the starting state is specified. This tool offers 2 of the three.
  const [initialMode, setInitialMode] = useState<InitialMode>('fixed')
  const [initialDistFile, setInitialDistFile] = useState('')
  const [integrationCutoff, setIntegrationCutoff] = useState('1e-10')
  const [populationScaled, setPopulationScaled] = useState(true)
  const [activeTab, setActiveTab] = useState('0')
  
  // Components array for multiple populations
  const [components, setComponents] = useState<Component[]>([
    { N: '100', G: '100', f: '1', u: '0.001', v: '0.001', s: '0', h: '0.5' }
  ])
  
  // Common parameters
  const [commonParams, setCommonParams] = useState({
    a: '1e-20',
    p: '1',
    noProj: false
  })
  
  // Output options
  const [outputOptions, setOutputOptions] = useState({
    writeQ: false,
    writeN: false,
    writeB: false,
    writeRes: true  // Results/distribution
  })
  
  // Execution options
  const [executionOptions, setExecutionOptions] = useState({
    force: false,
    threads: navigator.hardwareConcurrency || 4,
    library: 'Accelerate' as const,
    solver: 'gmres' as const,
    initialDistribution: ''
  })
  
  // Results state
  const [results, setResults] = useState<WfesResultItem[]>([])
  const [spectrum, setSpectrum] = useState<any[]>([])
  const [isExecuting, setIsExecuting] = useState(false)
  const [progress, setProgress] = useState(0)
  const [progressMessage, setProgressMessage] = useState('')
  const [executionTime, setExecutionTime] = useState('')
  const [error, setError] = useState('')
  const [showChartModal, setShowChartModal] = useState(false)
  const [showTableModal, setShowTableModal] = useState(false)
  
  // Helper functions
  const addComponent = () => {
    const lastComponent = components[components.length - 1]
    setComponents([...components, { ...lastComponent }])
    setActiveTab(String(components.length))
  }

  const removeComponent = (index: number) => {
    if (components.length > 1) {
      const newComponents = components.filter((_, i) => i !== index)
      setComponents(newComponents)
      if (parseInt(activeTab) >= newComponents.length) {
        setActiveTab(String(newComponents.length - 1))
      }
    }
  }

  const updateComponent = (index: number, field: keyof Component, value: string) => {
    const updatedComponents = [...components]
    updatedComponents[index] = { ...updatedComponents[index], [field]: value }
    setComponents(updatedComponents)
  }

  const clearResults = () => {
    setResults([])
    setSpectrum([])
    setExecutionTime('')
    setProgress(0)
    setProgressMessage('')
    setError('')
  }
  
  // Set up progress listener
  useEffect(() => {
    const handleProgress = (data: any) => {
      if (data.tool && data.tool === 'wfafs_stochastic') {
        setProgress(data.progress || 0)
        setProgressMessage(data.message || '')
      }
    }
    
    window.api.wfes.onProgress(handleProgress)
    
    return () => {
      window.api.wfes.removeProgressListener()
    }
  }, [])
  
  // Handle population scaling toggle
  const handleFileSelect = async () => {
    try {
      const result = await window.api.dialog.showOpenDialog({
        filters: [{ name: 'CSV files', extensions: ['csv'] }],
        properties: ['openFile']
      })
      if (!result.canceled && result.filePaths.length > 0) {
        setExecutionOptions({ ...executionOptions, initialDistribution: result.filePaths[0] })
      }
    } catch (error) {
      console.error('Error selecting file:', error)
    }
  }

  const handlePopulationScaledToggle = (checked: boolean) => {
    const updatedComponents = components.map(comp => {
      const N = parseFloat(comp.N) || 1000
      let newComp = { ...comp }
      
      if (checked) {
        // Converting to scaled values
        const u = parseFloat(comp.u) || 0
        const v = parseFloat(comp.v) || 0
        const s = parseFloat(comp.s) || 0

        // Exact string conversion -- no toFixed/toExponential. Rounding here
        // silently corrupted the selection coefficient (and mutation rates)
        // once N was large enough that the true value fell below the
        // rounded precision; see the execute-path conversion below for the
        // copy of this bug that actually reached the CLI.
        newComp.u = u === 0 ? '0' : (u * 4 * N).toString()
        newComp.v = v === 0 ? '0' : (v * 4 * N).toString()
        newComp.s = s === 0 ? '0' : (s * 2 * N).toString()
      } else {
        // Converting to unscaled values
        const u = parseFloat(comp.u) || 0
        const v = parseFloat(comp.v) || 0
        const s = parseFloat(comp.s) || 0

        newComp.u = u === 0 ? '0' : (u / (4 * N)).toString()
        newComp.v = v === 0 ? '0' : (v / (4 * N)).toString()
        newComp.s = s === 0 ? '0' : (s / (2 * N)).toString()
      }
      
      return newComp
    })
    
    setComponents(updatedComponents)
    setPopulationScaled(checked)
  }
  
  const handleExecute = async () => {
    setIsExecuting(true)
    setProgress(0)
    clearResults()
    
    try {
      // Convert to unscaled values if currently in scaled mode
      let execComponents = components
      if (populationScaled) {
        execComponents = components.map(comp => {
          const N = parseFloat(comp.N) || 1000
          const u = parseFloat(comp.u) || 0
          const v = parseFloat(comp.v) || 0
          const s = parseFloat(comp.s) || 0
          
          // Exact string conversion, matching the toggle handler above --
          // this is the value that actually ships to the CLI. toFixed(5)
          // here rounded 2Ns=0.1 at N=100000 (s=5e-7) to "0.00000", silently
          // sending the neutral model instead of the requested one.
          return {
            ...comp,
            u: u === 0 ? '0' : (u / (4 * N)).toString(),
            v: v === 0 ? '0' : (v / (4 * N)).toString(),
            s: s === 0 ? '0' : (s / (2 * N)).toString()
          }
        })
      }
      
      // Prepare parameters for WFAFS (always stochastic)
      const params = {
        mode: 'wfafs-stochastic',
        components: execComponents,
        // Exactly one of the three starting modes reaches the CLI: a fixed
        // count (-p), the mutation-injection integration (-c), or a file
        // (--initial, passed through executionParams below).
        commonParams: {
          ...commonParams,
          p: initialMode === 'fixed' ? commonParams.p : undefined
        },
        integrationCutoff: initialMode === 'integrate' ? integrationCutoff : undefined,
        outputOptions: {
          Q: outputOptions.writeQ,
          N: outputOptions.writeN,
          B: outputOptions.writeB,
          Dist: outputOptions.writeRes
        },
        executionParams: {
          ...executionOptions,
          // Reaches buildWfafsArgs as --initial.
          initialDistFile: initialMode === 'file' ? (initialDistFile || undefined) : undefined
        }
      }
      
      // Execute using wfes service
      const result = await window.api.wfes.wfafs.execute(params)
      
      if (result.success) {
        // Process results
        const resultItems: WfesResultItem[] = []
        
        if (result.executionTime) {
          // Reported under the table, not as a row in it: the results
          // table holds model quantities only.
          setExecutionTime(result.executionTime)
        }
        
        setResults(resultItems)
        
        // Set spectrum data if available.
        //
        // This read `result.distribution`, a key the IPC handler never sets --
        // it returns `spectrum` (src/main/index.ts). The guard was therefore
        // always false and setSpectrum was never called, so the chart and table
        // were unconditionally empty no matter what the computation returned.
        // The handler now delivers already-structured rows parsed from the
        // tool's JSON, so no string splitting is needed here either.
        if (result.spectrum && Array.isArray(result.spectrum)) {
          const spectrumData = result.spectrum
            .map((row: any) => ({
              // `frequency` is the allele COPY NUMBER (0..2N). The backend
              // (parseWfafsOutput in wfesBackendService.ts) also sends the
              // identical integer under `count` -- not a second quantity,
              // just the same one twice -- so only one field is kept here;
              // see SPECTRUM_COLUMNS for how it's labeled.
              frequency: Number(row.frequency ?? row.count),
              proportion: Number(row.proportion ?? 0),
              expected: Number(row.expected ?? row.probability ?? 0)
            }))
            .filter((row: any) => Number.isFinite(row.frequency))

          setSpectrum(spectrumData)
          
          // Distribution summaries. The previous block summed allele-count
          // INDICES and called the result "Total Sites" -- the spectrum is a
          // probability distribution over allele counts, not site counts.
          if (spectrumData.length > 0) {
            const maxCount = Math.max(...spectrumData.map(r => r.frequency))
            const total = spectrumData.reduce((a, r) => a + r.expected, 0) || 1
            const pOf = (pred: (c: number) => boolean) =>
              spectrumData.filter(r => pred(r.frequency)).reduce((a, r) => a + r.expected, 0) / total
            const pLost = pOf(c => c === 0)
            const pFixed = pOf(c => c === maxCount)
            const meanFreq = spectrumData.reduce((a, r) => a + r.expected * (r.frequency / maxCount), 0) / total
            const het = spectrumData.reduce(
              (a, r) => a + r.expected * 2 * (r.frequency / maxCount) * (1 - r.frequency / maxCount), 0) / total
            // Names from utils/quantityLabels, matching the deterministic
            // spectrum view exactly -- the two tools report the same
            // quantities and used to label them the same as each other but
            // differently from every absorbing-model view.
            resultItems.push(
              qtyRow('P_0', pLost),
              qtyRow('P_2N', pFixed, {
                description: `Probability the allele is fixed (count ${maxCount})`
              }),
              qtyRow('P_seg', 1 - pLost - pFixed, {
                description: 'Probability the allele is still segregating'
              }),
              qtyRow('E_freq', meanFreq, { description: 'Mean allele frequency' }),
              qtyRow('E_het', het, { description: 'Expected heterozygosity, 2p(1−p)' })
            )
          }
        }
      } else {
        setError(result.error || 'Execution failed')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error occurred')
    } finally {
      setIsExecuting(false)
      setProgress(100)
    }
  }
  
  const handleStop = async () => {
    try {
      await window.api.wfes.stopExecution()
      setIsExecuting(false)
      setProgressMessage('Execution stopped')
    } catch (error) {
      console.error('Error stopping execution:', error)
    }
  }
  
  const handleExportData = () => {
    if (!spectrum || spectrum.length === 0) return

    const data = [
      SPECTRUM_COLUMNS.map(col => col.header),
      ...spectrum.map(row => SPECTRUM_COLUMNS.map(col => col.format(row)))
    ]

    const content = data.map(row => row.join('\t')).join('\n')
    // Through the main process: an <a download> is silently dropped here.
    void saveTextFile(content, generateFilename('wfafs', 'tsv'))
  }
  
  const copyToClipboard = () => {
    navigator.clipboard.writeText(formatResultsCopy('WFAF-S results', results))
  }
  
  // Build command line string
  const buildCommandLine = () => {
    // Mirrors the actual run: view params -> IPC handler -> the arg builder in
    // wfesBackendService. The previous version emitted flags that exist in no
    // WFES tool, so the "run the same analysis from the command line" promise
    // under the preview was unkeepable. Verified against the spawned command.
    const parts = ['wfafs_stochastic']
    const raw = (val: string, scale: number, N: number) =>
      populationScaled ? (parseFloat(val) || 0) / (scale * N) : (parseFloat(val) || 0)
    const Ns = components.map(cp => parseInt(cp.N) || 100)
    parts.push(`--pop-sizes ${Ns.join(',')}`)
    parts.push(`--generations ${components.map(cp => parseInt(cp.G) || 100).join(',')}`)
    parts.push(`--factor ${components.map(cp => parseFloat(cp.f) || 1).join(',')}`)
    parts.push(`--selection ${components.map((cp, i) => raw(cp.s, 2, Ns[i])).join(',')}`)
    parts.push(`--dominance ${components.map(cp => parseFloat(cp.h) || 0.5).join(',')}`)
    parts.push(`--backward-mu ${components.map((cp, i) => raw(cp.u, 4, Ns[i])).join(',')}`)
    parts.push(`--forward-mu ${components.map((cp, i) => raw(cp.v, 4, Ns[i])).join(',')}`)
    parts.push(`--alpha ${commonParams.a}`)
    if (initialMode === 'fixed') parts.push(`--initial-count ${commonParams.p}`)
    if (initialMode === 'integrate') parts.push(`--integration-cutoff ${integrationCutoff}`)
    if (commonParams.noProj) parts.push('--no-project')
    if (initialMode === 'file' && initialDistFile) parts.push(`--initial ${initialDistFile}`)
    if (executionOptions.force) parts.push('--force')
    const dir = '~/Downloads'
    if (outputOptions.writeQ) parts.push(`--output-Q ${dir}/wfafs_Q.mtx`)
    if (outputOptions.writeR) parts.push(`--output-R ${dir}/wfafs_R.csv`)
    parts.push(`--num-threads ${executionOptions.threads}`)
    parts.push(`--library ${executionOptions.library}`)
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
  
  // Live state diagram: stochastic epoch chain with factor-scaling notes.
  const diagramModel = useMemo(
    () => wfafsDiagram(components, populationScaled),
    [components, populationScaled]
  )

  return (
    <WfesViewLayout
      title="Wright-Fisher Allele Frequency Spectrum (WFAFS) - Stochastic"
      onBack={onBack}
      hideBackButton={hideBackButton}
      outputOptions={outputOptions}
      onOutputOptionsChange={setOutputOptions}
      executionOptions={executionOptions}
      onExecutionOptionsChange={setExecutionOptions}
      activeOptionsCount={activeOutputOptions}
    >
      {/* Technical Details */}
      <AboutContentPanel modelName="wfafs_stochastic" />
      
      <Grid>
        {/* Column 1: Components and Common Parameters */}
        <Grid.Col span={6}>
          <Stack>
            {/* Components */}
            <Paper p="md" withBorder>
              <Title order={6} mb="sm">Components</Title>
              <Tabs value={activeTab} onChange={setActiveTab}>
                <Tabs.List>
                  {components.map((_, index) => (
                    <Tabs.Tab key={index} value={String(index)} rightSection={
                      components.length > 1 ? (
                        <ActionIcon 
                          size="xs" 
                          variant="subtle"
                          onClick={(e) => {
                            e.stopPropagation()
                            removeComponent(index)
                          }}
                        >
                          <IconX size={14} />
                        </ActionIcon>
                      ) : null
                    }>
                      Comp {index + 1}
                    </Tabs.Tab>
                  ))}
                  <ActionIcon 
                    variant="subtle" 
                    onClick={addComponent}
                    ml="xs"
                  >
                    <IconPlus size={16} />
                  </ActionIcon>
                </Tabs.List>
                
                {components.map((comp, index) => (
                  <Tabs.Panel key={index} value={String(index)} pt="md">
                    <Stack gap="sm">
                      <Group grow>
                        <WfesParameterInput
                          type="text"
                          label="N"
                          description="Population size"
                          value={comp.N}
                          onChange={(value) => updateComponent(index, 'N', value)}
                          error={!validatePositiveInteger(comp.N)}
                        />
                        <WfesParameterInput
                          type="text"
                          label="G"
                          description="Mean generations"
                          tooltip="The time spent in this epoch is geometrically distributed with this mean; individual histories vary around it. Use Deterministic Switching for exact epoch lengths."
                          value={comp.G}
                          onChange={(value) => updateComponent(index, 'G', value)}
                          error={!validatePositiveInteger(comp.G)}
                        />
                        <WfesParameterInput
                          type="text"
                          label="f"
                          description="Approximation factor"
                          tooltip="Matrix approximation factor: this epoch runs internally at 1/f scale (N/f, G/f, s·f, u·f, v·f). 1 means no approximation. Not a starting frequency."
                          value={comp.f}
                          onChange={(value) => updateComponent(index, 'f', value)}
                          error={!validateScientificNotation(comp.f)}
                        />
                      </Group>
                      <Group grow>
                        <WfesParameterInput
                          type="scientific"
                          label={populationScaled ? "4Nu" : "u"}
                          description="Backward mutation rate"
                          value={comp.u}
                          onChange={(value) => updateComponent(index, 'u', value)}
                          error={!validateScientificNotation(comp.u)}
                        />
                        <WfesParameterInput
                          type="scientific"
                          label={populationScaled ? "4Nv" : "v"}
                          description="Forward mutation rate"
                          value={comp.v}
                          onChange={(value) => updateComponent(index, 'v', value)}
                          error={!validateScientificNotation(comp.v)}
                        />
                      </Group>
                      <Group grow>
                        <WfesParameterInput
                          type="text"
                          label={populationScaled ? "2Ns" : "s"}
                          description="Selection coefficient"
                          value={comp.s}
                          onChange={(value) => updateComponent(index, 's', value)}
                          error={!validateScientificNotation(comp.s)}
                        />
                        <WfesParameterInput
                          type="text"
                          label="h"
                          description="Dominance coefficient"
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
            
            {/* Common Parameters */}
            <Paper p="md" withBorder>
              <Group justify="space-between" mb="sm">
                <Title order={6}>Common Parameters</Title>
                <Switch 
                  label="Population Scaled" 
                  checked={populationScaled}
                  onChange={(e) => handlePopulationScaledToggle(e.currentTarget.checked)}
                />
              </Group>
              <Stack gap="sm">
                <WfesParameterInput
                  type="scientific"
                  label="α"
                  description="Probability cutoff"
                  helpText="Probability mass trimmed from the tails of each matrix row (α/2 per tail), which the row is renormalised after"
                  value={commonParams.a}
                  onChange={(value) => setCommonParams({ ...commonParams, a: value })}
                  error={!validateScientificNotation(commonParams.a)}
                />
                <Switch
                  label="No Projection"
                  description="Disable projection"
                  checked={commonParams.noProj}
                  onChange={(e) => setCommonParams({ ...commonParams, noProj: e.currentTarget.checked })}
                />
              </Stack>
            </Paper>
          </Stack>
        </Grid.Col>
        
        {/* Column 2: Results and Execution */}
        <Grid.Col span={6}>
          <Stack>
            {/* Additional Execution Options */}
            <Paper p="md" withBorder>
              <Title order={6} mb="sm">Execution Options</Title>
              <Stack gap="sm">
                
                <div>
                  <WfesParameterInput
                    type="text"
                    label="Initial Distribution"
                    description="Path to initial distribution file (CSV)"
                    value={executionOptions.initialDistribution || ''}
                    onChange={(value) => setExecutionOptions({ ...executionOptions, initialDistribution: value })}
                  />
                  <Button
                    size="sm"
                    mt="xs"
                    fullWidth
                    onClick={handleFileSelect}
                  >
                    Browse...
                  </Button>
                </div>
              </Stack>
            </Paper>
            
            {/* Results */}
            <Paper p="md" withBorder style={{ minHeight: '400px' }}>
              <Group justify="space-between" mb="md">
                <Title order={6}>Results</Title>
                {results.length > 0 && (
                  <Group gap="xs">
                    {spectrum.length > 0 && (
                      <>
                        <Button 
                          variant="light" 
                          size="sm"
                          leftSection={<IconChartBar size={16} />}
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
                  {spectrum.length > 0 && (
                    <Group mt="md">
                      <WfesExportButtons
                        onExport={(format) => {
                          if (format === 'csv') handleExportData()
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
            value={commonParams.p}
            onChange={(value) => setCommonParams({ ...commonParams, p: value })}
            error={!validatePositiveInteger(commonParams.p)}
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
      
      {/* Chart Modal. Note the field naming in `spectrum`: `frequency` holds
          the ALLELE COUNT and `expected` the probability -- the same mapping the
          summary rows use above. */}
      <SpectrumChartModal
        opened={showChartModal}
        onClose={() => setShowChartModal(false)}
        data={spectrum.map((row: any) => ({
          copies: Number(row.frequency),
          probability: Number(row.expected)
        }))}
        title="Allele frequency spectrum (stochastic)"
        filename="wfafs_stochastic_spectrum"
      />
      
      {/* Table Modal */}
      <Modal
        opened={showTableModal}
        onClose={() => setShowTableModal(false)}
        size="lg"
        title="Frequency Spectrum Data"
      >
        <Stack>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ borderBottom: '2px solid var(--mantine-color-dark-4)' }}>
                  {SPECTRUM_COLUMNS.map((col, i) => (
                    <th key={col.header} style={{ padding: '8px', textAlign: i === 0 ? 'left' : 'right' }}>{col.header}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {spectrum.map((row, index) => (
                  <tr key={index} style={{ borderBottom: '1px solid var(--mantine-color-dark-6)' }}>
                    {SPECTRUM_COLUMNS.map((col, i) => (
                      <td key={col.header} style={{ padding: '8px', textAlign: i === 0 ? 'left' : 'right' }}>{col.format(row)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Group justify="flex-end" mt="md">
            <WfesExportButtons
              onExport={(format) => {
                if (format === 'csv') handleExportData()
              }}
              formats={['csv']}
            />
          </Group>
        </Stack>
      </Modal>
    </WfesViewLayout>
  )
}

export default WfafsViewMantine