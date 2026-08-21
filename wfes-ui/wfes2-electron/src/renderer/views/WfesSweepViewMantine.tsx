import React, { useState, useEffect, useMemo } from 'react'
import InitialStateSelector, { InitialMode } from '../components/shared/InitialStateSelector'
import { 
  Grid, 
  Paper, 
  Stack, 
  Title, 
  Group, 
  Text,
  Loader,
  Alert,
  Switch,
  Tabs,
  Badge,
  Button,
  Box,
  Tooltip,
  ActionIcon,
  Divider,
  useMantineTheme
} from '@mantine/core'
import { IconCopy, IconPlayerPlay, IconChartBar } from '@tabler/icons-react'
import {
  WfesViewLayout,
  WfesParameterInput,
  WfesResultsTable,
  validateScientificNotation,
  validatePositiveInteger,
  validateProbability
} from '../components/shared'
import { WfesSweepParams, WfesResultItem } from '../types/wfes'
import { wfesService } from '../services/wfesService'
import { SolverWarnings } from '../components/shared'
import AboutContentPanel from '../components/AboutContentPanel'
import { numOrUndefined, intOrUndefined } from '../utils/numeric'
import { useExecuteShortcut } from '../hooks/useExecuteShortcut'
import SwitchingStateDiagram from '../components/shared/SwitchingStateDiagram'
import { sweepDiagram } from '../utils/switchingDiagrams'
import { formatResultsCopy } from '../utils/resultsCopy'
import DecompositionChartModal from '../components/DecompositionChartModal'
import { qtyRow, formatQuantity } from '../utils/quantityLabels'

interface WfesSweepViewProps {
  onBack: () => void
  hideBackButton?: boolean
}

const WfesSweepViewMantine: React.FC<WfesSweepViewProps> = ({ onBack, hideBackButton = false }) => {
  const theme = useMantineTheme()
  // How the starting state is specified. This tool offers 3 of the three.
  const [initialMode, setInitialMode] = useState<InitialMode>('fixed')
  const [initialDistFile, setInitialDistFile] = useState('')
  const [populationScaled, setPopulationScaled] = useState(true)
  
  // Mode is fixed to Fixation in sweep
  const modelType = 'fixation'
  
  // Population parameters
  const [populationSize, setPopulationSize] = useState('100')
  const [alpha, setAlpha] = useState('1e-20') // Probability cutoff
  const [lambda, setLambda] = useState('0.01')
  const [integrationCutoff, setIntegrationCutoff] = useState('1e-10')
  // Default 0: the documented quantity is the time between fixations,
  // T_b.fix = sum_j N(0,j) (about/wfes_sweep.md), i.e. starting from zero
  // copies. Phase 1 of the sweep model keeps count 0 as a transient state,
  // so 0 is a valid starting count here (unlike the both-absorbing models).
  const [startingCopies, setStartingCopies] = useState('0')

  // The CLI accepts 0..2N for wfes_sweep because phase 1 treats count 0 as
  // transient; the shared validatePositiveInteger helper rejects 0, so use a
  // local check rather than loosening it for every other caller.
  const validateStartingCopiesSweep = (value: string): boolean => {
    const p = parseInt(value)
    const N = parseInt(populationSize)
    if (isNaN(p) || value.trim() !== p.toString()) return false
    if (isNaN(N)) return p >= 0
    return p >= 0 && p <= 2 * N
  }
  
  // Component 1 parameters (initial phase - variation accumulation)
  const [comp1ForwardMutation, setComp1ForwardMutation] = useState('0.001')  // 4Nv = 0.001
  const [comp1BackwardMutation, setComp1BackwardMutation] = useState('0.001') // 4Nu = 0.001
  const [comp1SelectionCoeff, setComp1SelectionCoeff] = useState('0')        // 2Ns = 0
  const [comp1DominanceCoeff, setComp1DominanceCoeff] = useState('0.5')
  
  // Component 2 parameters (sweep phase - selection changes)
  const [comp2ForwardMutation, setComp2ForwardMutation] = useState('0.001')  // 4Nv = 0.001
  const [comp2BackwardMutation, setComp2BackwardMutation] = useState('0.001') // 4Nu = 0.001
  const [comp2SelectionCoeff, setComp2SelectionCoeff] = useState('0')        // 2Ns = 0
  const [comp2DominanceCoeff, setComp2DominanceCoeff] = useState('0.5')
  
  // Tab state for components
  const [activeTab, setActiveTab] = useState<string | null>('component-1')
  
  // Output options
  const [outputOptions, setOutputOptions] = useState({
    writeQ: false,
    writeR: false,
    writeN: false,
    writeB: false
  })
  
  // Execution options - detect platform for default library
  const getDefaultLibrary = () => {
    if (typeof navigator !== 'undefined' && navigator.platform) {
      const platform = navigator.platform.toLowerCase()
      return platform.includes('mac') || platform.includes('darwin') ? 'Accelerate' : 'Pardiso'
    }
    // Default to Accelerate if we can't detect
    return 'Accelerate'
  }
  
  // No `solver`: no WFES binary declares --solver, and the handler drops the
  // key deliberately -- keeping a value here would be state no control can
  // ever deliver.
  const [executionOptions, setExecutionOptions] = useState({
    force: false,
    threads: navigator.hardwareConcurrency || 4,
    library: getDefaultLibrary() as 'Accelerate' | 'Pardiso' | 'SuiteSparse' | 'ParU'
  })
  
  // Results state
  const [results, setResults] = useState<WfesResultItem[]>([])
  const [isExecuting, setIsExecuting] = useState(false)
  const [executionTime, setExecutionTime] = useState('')
  const [regimeSplit, setRegimeSplit] = useState<number[] | null>(null)
  const [showChartModal, setShowChartModal] = useState(false)
  const [error, setError] = useState('')
  // Whatever the solver wrote to stderr while still exiting 0.
  const [warnings, setWarnings] = useState<string[]>([])

  // Helper function to clear results and reset execution state
  const clearResults = () => {
    setResults([])
    setWarnings([])
    setExecutionTime('')
    setError('')
  }
  
  // Handle population scaling toggle
  const handlePopulationScaledToggle = (newValue: boolean) => {
    // The conversion divides or multiplies by the N on screen, and execute
    // later divides the scaled values by the N on screen AT THAT TIME. Those
    // two agree only if this conversion never fabricates an N: the old
    // `parseInt(populationSize) || 1000` converted against 1000 when the N
    // field was blank or invalid, so a later execute at the user's real N
    // decoded values that were silently off by the ratio. Refuse instead.
    if (!validatePositiveInteger(populationSize)) {
      setError('Set a valid population size (N) before switching the scaled display.')
      return
    }
    setError('')
    const N = parseInt(populationSize)

    if (newValue && !populationScaled) {
      // Converting from raw to scaled values
      // u → 4Nu, v → 4Nv, s → 2Ns
      // Component 1
      const rawU1 = parseFloat(comp1ForwardMutation) || 0
      const rawV1 = parseFloat(comp1BackwardMutation) || 0
      const rawS1 = parseFloat(comp1SelectionCoeff) || 0
      
      setComp1ForwardMutation((rawU1 * 4 * N).toString())
      setComp1BackwardMutation((rawV1 * 4 * N).toString())
      setComp1SelectionCoeff(rawS1 === 0 ? '0' : (rawS1 * 2 * N).toString())
      
      // Component 2
      const rawU2 = parseFloat(comp2ForwardMutation) || 0
      const rawV2 = parseFloat(comp2BackwardMutation) || 0
      const rawS2 = parseFloat(comp2SelectionCoeff) || 0
      
      setComp2ForwardMutation((rawU2 * 4 * N).toString())
      setComp2BackwardMutation((rawV2 * 4 * N).toString())
      setComp2SelectionCoeff(rawS2 === 0 ? '0' : (rawS2 * 2 * N).toString())
    } else if (!newValue && populationScaled) {
      // Converting from scaled to raw values
      // 4Nu → u, 4Nv → v, 2Ns → s
      // Component 1
      const scaledU1 = parseFloat(comp1ForwardMutation) || 0
      const scaledV1 = parseFloat(comp1BackwardMutation) || 0
      const scaledS1 = parseFloat(comp1SelectionCoeff) || 0
      
      setComp1ForwardMutation((scaledU1 / (4 * N)).toString())
      setComp1BackwardMutation((scaledV1 / (4 * N)).toString())
      setComp1SelectionCoeff(scaledS1 === 0 ? '0' : (scaledS1 / (2 * N)).toString())
      
      // Component 2
      const scaledU2 = parseFloat(comp2ForwardMutation) || 0
      const scaledV2 = parseFloat(comp2BackwardMutation) || 0
      const scaledS2 = parseFloat(comp2SelectionCoeff) || 0
      
      setComp2ForwardMutation((scaledU2 / (4 * N)).toString())
      setComp2BackwardMutation((scaledV2 / (4 * N)).toString())
      setComp2SelectionCoeff(scaledS2 === 0 ? '0' : (scaledS2 / (2 * N)).toString())
    }
    
    setPopulationScaled(newValue)
  }
  
  const handleExecute = async () => {
    setIsExecuting(true)
    clearResults()

    try {
      // Convert population-scaled values to raw values if needed
      const N = parseInt(populationSize)
      
      // Component 1
      let rawForwardMutation1 = parseFloat(comp1ForwardMutation) || 0
      let rawBackwardMutation1 = parseFloat(comp1BackwardMutation) || 0
      let rawSelectionCoeff1 = parseFloat(comp1SelectionCoeff) || 0
      
      // Component 2
      let rawForwardMutation2 = parseFloat(comp2ForwardMutation) || 0
      let rawBackwardMutation2 = parseFloat(comp2BackwardMutation) || 0
      let rawSelectionCoeff2 = parseFloat(comp2SelectionCoeff) || 0
      
      if (populationScaled) {
        // Convert from population-scaled to raw values
        // 4Nu → u, 4Nv → v
        rawForwardMutation1 = rawForwardMutation1 / (4 * N)
        rawBackwardMutation1 = rawBackwardMutation1 / (4 * N)
        rawForwardMutation2 = rawForwardMutation2 / (4 * N)
        rawBackwardMutation2 = rawBackwardMutation2 / (4 * N)
        // 2Ns → s
        rawSelectionCoeff1 = rawSelectionCoeff1 / (2 * N)
        rawSelectionCoeff2 = rawSelectionCoeff2 / (2 * N)
      }
      
      const params = {
      
        // The chosen initial distribution. Every builder reads params.initial
      
        // before its own nested fallbacks.
      
        initial: initialMode === 'file' ? (initialDistFile || undefined) : undefined,
        model_type: modelType,
        population_size: N,
        alpha: numOrUndefined(alpha),
        lambda: numOrUndefined(lambda),
        integration_cutoff: numOrUndefined(integrationCutoff),
        // Only the "Fixed p" mode sends a starting count. This used to be
        // sent unconditionally, so "Integrate over p" still passed
        // --starting-copies and the CLI never integrated: the selector chose
        // between two labels that ran the same model. Same pattern as the
        // single view.
        starting_copies: initialMode === 'fixed' ? intOrUndefined(startingCopies) : undefined,
        // Arrays for comma-separated CLI values
        selection_coefficients: [rawSelectionCoeff1, rawSelectionCoeff2],
        dominance: [parseFloat(comp1DominanceCoeff), parseFloat(comp2DominanceCoeff)],
        backward_mutation: [rawBackwardMutation1, rawBackwardMutation2],
        forward_mutation: [rawForwardMutation1, rawForwardMutation2],
        // Execution options
        n_threads: executionOptions.threads,
        force: executionOptions.force,
        library: executionOptions.library,
        // Output options: the nested write* object the builder reads,
        // outputDirectory included. The flat output_Q..output_B keys this
        // replaced matched nothing on the other side of the IPC boundary.
        output_options: outputOptions
      }
      
      const response = await wfesService.executeSweep(params)
      
      if (response.success) {
        // Convert results to WfesResultItem format
        const resultItems: WfesResultItem[] = []
        
        if (response.results) {
          // Parse results based on expected output
          // Keys match the CLI's JSON (T_fix, rate, T_regime1/2). The
          // previous pFix/tFix reads matched nothing the tool ever emitted,
          // so this table showed only Rate.
          const rr = response.results
          if (rr.T_fix !== undefined) {
            // The tool's T_fix IS the substitution time here: fixation is the
            // only absorbing state in the sweep model.
            resultItems.push(qtyRow('T_sub', rr.T_fix, {
              description: 'Expected time to substitution, both regimes'
            }))
          }
          if (rr.rate !== undefined) {
            resultItems.push(qtyRow('R_sub', rr.rate))
          }
          // The decomposition this two-regime model exists for: waiting under
          // the standing-variation regime vs. sweeping under the adaptive one.
          // The percentage share stays in the display string; `raw` keeps the
          // unrounded generation count for the clipboard.
          if (rr.T_regime1 !== undefined && rr.T_regime2 !== undefined && rr.T_fix > 0) {
            const share = (x: number) => `${formatQuantity(x)}  (${((100 * x) / rr.T_fix).toFixed(2)}%)`
            resultItems.push(qtyRow('T_reg1', rr.T_regime1, { display: share(rr.T_regime1) }))
            resultItems.push(qtyRow('T_reg2', rr.T_regime2, { display: share(rr.T_regime2) }))
            // Held for the chart. wfes_sweep emits no vector output, so the
            // regime split is the whole of what there is to draw -- and it is
            // the decomposition the two-regime model exists to produce.
            setRegimeSplit([rr.T_regime1, rr.T_regime2])
          }
        }
        
        // Execution time is reported under the table, not as a row in it:
        // the results table holds model quantities only.
        
        setResults(resultItems)
        setWarnings(response.warnings || [])
        setExecutionTime(response.executionTime)
      } else {
        setError(response.error || 'Unknown error occurred')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error occurred')
    } finally {
      setIsExecuting(false)
    }
  }
  
  const handleStop = () => {
    wfesService.stopExecution()
    setIsExecuting(false)
  }
  
  const copyToClipboard = () => {
    navigator.clipboard.writeText(formatResultsCopy('WFES Sweep results', results))
  }
  
  // Build command line string
  const buildCommandLine = () => {
    // Mirrors the actual run: view params -> IPC handler -> the arg builder in
    // wfesBackendService. The previous version emitted flags that exist in no
    // WFES tool, so the "run the same analysis from the command line" promise
    // under the preview was unkeepable. Verified against the spawned command.
    const parts = ['wfes_sweep']
    const N = parseInt(populationSize) || 100
    const raw = (v: string, scale: number) =>
      populationScaled ? (parseFloat(v) || 0) / (scale * N) : (parseFloat(v) || 0)
    parts.push('--fixation')
    parts.push(`--pop-size ${N}`)
    parts.push(`--selection ${raw(comp1SelectionCoeff, 2)},${raw(comp2SelectionCoeff, 2)}`)
    parts.push(`--lambda ${parseFloat(lambda) || 0}`)
    parts.push(`--dominance ${parseFloat(comp1DominanceCoeff) || 0.5},${parseFloat(comp2DominanceCoeff) || 0.5}`)
    parts.push(`--backward-mu ${raw(comp1BackwardMutation, 4)},${raw(comp2BackwardMutation, 4)}`)
    parts.push(`--forward-mu ${raw(comp1ForwardMutation, 4)},${raw(comp2ForwardMutation, 4)}`)
    parts.push(`--alpha ${numOrUndefined(alpha) ?? 1e-20}`)
    parts.push(`--num-threads ${executionOptions.threads}`)
    parts.push(`--integration-cutoff ${numOrUndefined(integrationCutoff) ?? 1e-10}`)
    // Same gate as the run: a starting count is a fixed-p concept, and the
    // run drops it in the other two modes.
    if (initialMode === 'fixed' && intOrUndefined(startingCopies) !== undefined) {
      parts.push(`--starting-copies ${intOrUndefined(startingCopies)}`)
    }
    if (executionOptions.force) parts.push('--force')
    // Flag order below mirrors buildWfesSweepArgs exactly (--library before
    // the output flags); the preview used to print the outputs first, so it
    // was never token-for-token the spawned command.
    parts.push(`--library ${executionOptions.library}`)
    const dir = (outputOptions as any).outputDirectory || '~/Downloads'
    if (outputOptions.writeQ) parts.push(`--output-Q ${dir}/wfes_sweep_Q.mtx`)
    if (outputOptions.writeR) parts.push(`--output-R ${dir}/wfes_sweep_R.csv`)
    if (outputOptions.writeN) parts.push(`--output-N ${dir}/wfes_sweep_N.csv`)
    if (outputOptions.writeB) parts.push(`--output-B ${dir}/wfes_sweep_B.csv`)
    if (initialMode === 'file' && initialDistFile) parts.push(`--initial ${initialDistFile}`)
    parts.push('--json')
    return parts.join(' ')
  }
  
  const copyCommandLine = () => {
    const command = buildCommandLine()
    navigator.clipboard.writeText(command)
  }
  
  // Count active output options for badge. Only real checkbox states count:
  // the drawer also stores the outputDirectory string in this object, and a
  // truthy path must not read as an "active option".
  const activeOutputOptions = Object.values(outputOptions).filter(v => v === true).length +
    (executionOptions.force ? 1 : 0)
  
  // Cmd+Enter (Ctrl+Enter off macOS) fires Execute / Re-execute.
  useExecuteShortcut(handleExecute, isExecuting)

  // Live state diagram: two regimes, one-way switch with mean wait 1/lambda.
  const diagramModel = useMemo(() => sweepDiagram({
    N: populationSize,
    lambda,
    comp1: { s: comp1SelectionCoeff, h: comp1DominanceCoeff,
             u: comp1BackwardMutation, v: comp1ForwardMutation },
    comp2: { s: comp2SelectionCoeff, h: comp2DominanceCoeff,
             u: comp2BackwardMutation, v: comp2ForwardMutation },
    scaled: populationScaled
  }), [populationSize, lambda, comp1SelectionCoeff, comp1DominanceCoeff,
       comp1BackwardMutation, comp1ForwardMutation, comp2SelectionCoeff,
       comp2DominanceCoeff, comp2BackwardMutation, comp2ForwardMutation, populationScaled])

  return (
    <WfesViewLayout
      title="Substitution with Standing Genetic Variation"
      onBack={onBack}
      hideBackButton={hideBackButton}
      outputOptions={outputOptions}
      onOutputOptionsChange={setOutputOptions}
      // The four matrix/vector outputs wfes_sweep declares. Not the shared
      // default list: this binary has no --output-N-ext/-N-fix.
      outputFlags={[
        { key: 'writeQ', label: 'Write Q', description: 'Transient-to-transient transition probability sub-matrix' },
        { key: 'writeR', label: 'Write R', description: 'Transient-to-absorbing transition probability sub-matrix' },
        { key: 'writeN', label: 'Write N', description: 'Fundamental matrix: N = (I-Q)^(-1)' },
        { key: 'writeB', label: 'Write B', description: 'Absorption (fixation) probability vector: B = NR' }
      ]}
      executionOptions={executionOptions}
      onExecutionOptionsChange={setExecutionOptions}
      activeOptionsCount={activeOutputOptions}
    >
      {/* Technical Details */}
      <AboutContentPanel modelName="wfes_sweep" />
      
      <Grid>
        {/* Column 1: Mode and Population Parameters */}
        <Grid.Col span={6}>
          <Stack>
            {/* Mode Display */}
            <Paper p="md" withBorder style={{ height: '400px' }}>
              <Title order={6} mb="sm">Mode</Title>
              <Text size="sm">
                <Badge>Substitution Model</Badge> (Fixed)
              </Text>
              <Text size="xs" c="dimmed" mt="xs">
                Fixation only is absorbing, giving substitution-rate properties with standing genetic variation
              </Text>
            </Paper>
            
            {/* Population Parameters */}
            <Paper p="md" withBorder>
              <Title order={6} mb="sm">Population Parameters</Title>
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
                  description="Probability mass trimmed from the tails of each matrix row (α/2 per tail); larger values give a sparser matrix"
                  value={alpha}
                  onChange={setAlpha}
                  error={!validateScientificNotation(alpha)}
                />
                <WfesParameterInput
                  type="text"
                  label="λ"
                  description="Switching rate"
                  value={lambda}
                  onChange={setLambda}
                  error={!validateProbability(lambda)}
                />
                {/* p and c follow the Initial state selector below: each is
                    editable only in the mode that reads it, so a value typed
                    here can never be silently ignored by the run. */}
                <WfesParameterInput
                  type="scientific"
                  label="c"
                  description="Starting probability cutoff"
                  helpText="Starting copy numbers rarer than this are left out of the integration over p"
                  value={integrationCutoff}
                  onChange={setIntegrationCutoff}
                  error={!validateScientificNotation(integrationCutoff)}
                  disabled={initialMode !== 'integrate'}
                />
                <WfesParameterInput
                  type="text"
                  label="p"
                  description="Starting number of copies (0 = from a fixed background)"
                  value={startingCopies}
                  onChange={setStartingCopies}
                  error={!validateStartingCopiesSweep(startingCopies)}
                  disabled={initialMode !== 'fixed'}
                />
              </Stack>
            </Paper>
            
            {/* Components - Two phases of evolution */}
            <Paper p="md" withBorder>
              <Group justify="space-between" mb="sm">
                <Title order={6}>Components</Title>
                <Switch 
                  label="Population Scaled" 
                  checked={populationScaled}
                  onChange={(e) => handlePopulationScaledToggle(e.currentTarget.checked)}
                />
              </Group>
              
              <Tabs value={activeTab} onChange={setActiveTab}>
                <Tabs.List>
                  <Tabs.Tab value="component-1">Equilibration</Tabs.Tab>
                  <Tabs.Tab value="component-2">Absorbing</Tabs.Tab>
                </Tabs.List>
                
                {/* Component 1 - Initial phase */}
                <Tabs.Panel value="component-1" pt="md">
                  <Text size="xs" c="dimmed" mb="sm">
                    Initial phase: variation accumulates under neutral or weak selection
                  </Text>
                  <Stack gap="sm">
                    <Title order={6} size="sm">Mutation</Title>
                    <Group grow>
                      <WfesParameterInput
                        type="scientific"
                        label={populationScaled ? "4Nv" : "v"}
                        description="Forward mutation rate"
                        value={comp1ForwardMutation}
                        onChange={setComp1ForwardMutation}
                        error={!validateScientificNotation(comp1ForwardMutation)}
                      />
                      <WfesParameterInput
                        type="scientific"
                        label={populationScaled ? "4Nu" : "u"}
                        description="Backward mutation rate"
                        value={comp1BackwardMutation}
                        onChange={setComp1BackwardMutation}
                        error={!validateScientificNotation(comp1BackwardMutation)}
                      />
                    </Group>
                    
                    <Title order={6} size="sm" mt="sm">Selection</Title>
                    <Group grow>
                      <WfesParameterInput
                        type="text"
                        label={populationScaled ? "2Ns" : "s"}
                        description="Selection coefficient"
                        value={comp1SelectionCoeff}
                        onChange={setComp1SelectionCoeff}
                        error={!validateScientificNotation(comp1SelectionCoeff)}
                      />
                      <WfesParameterInput
                        type="text"
                        label="h"
                        description="Dominance coefficient"
                        value={comp1DominanceCoeff}
                        onChange={setComp1DominanceCoeff}
                        error={!validateProbability(comp1DominanceCoeff)}
                      />
                    </Group>
                  </Stack>
                </Tabs.Panel>
                
                {/* Component 2 - Sweep phase */}
                <Tabs.Panel value="component-2" pt="md">
                  <Text size="xs" c="dimmed" mb="sm">
                    Sweep phase: selection changes and drives allele to fixation
                  </Text>
                  <Stack gap="sm">
                    <Title order={6} size="sm">Mutation</Title>
                    <Group grow>
                      <WfesParameterInput
                        type="scientific"
                        label={populationScaled ? "4Nv" : "v"}
                        description="Forward mutation rate"
                        value={comp2ForwardMutation}
                        onChange={setComp2ForwardMutation}
                        error={!validateScientificNotation(comp2ForwardMutation)}
                      />
                      <WfesParameterInput
                        type="scientific"
                        label={populationScaled ? "4Nu" : "u"}
                        description="Backward mutation rate"
                        value={comp2BackwardMutation}
                        onChange={setComp2BackwardMutation}
                        error={!validateScientificNotation(comp2BackwardMutation)}
                      />
                    </Group>
                    
                    <Title order={6} size="sm" mt="sm">Selection</Title>
                    <Group grow>
                      <WfesParameterInput
                        type="text"
                        label={populationScaled ? "2Ns" : "s"}
                        description="Selection coefficient"
                        value={comp2SelectionCoeff}
                        onChange={setComp2SelectionCoeff}
                        error={!validateScientificNotation(comp2SelectionCoeff)}
                      />
                      <WfesParameterInput
                        type="text"
                        label="h"
                        description="Dominance coefficient"
                        value={comp2DominanceCoeff}
                        onChange={setComp2DominanceCoeff}
                        error={!validateProbability(comp2DominanceCoeff)}
                      />
                    </Group>
                  </Stack>
                </Tabs.Panel>
              </Tabs>
            </Paper>
          </Stack>
        </Grid.Col>
        
        {/* Column 2: Results and Execution */}
        <Grid.Col span={6}>
          <Stack>
            {/* Results */}
            {/* minHeight, not height: results now include breakdown tables of
    variable size, and a fixed 400px box let them overflow past the
    paper into the sections below. The box grows to contain. */}
          <Paper p="md" withBorder style={{ minHeight: '400px' }}>
              <Group justify="space-between" mb="md">
                <Title order={6}>Results</Title>
                {results.length > 0 && (
                  <Group gap="xs">
                    {regimeSplit && (
                      <Button
                        variant="light"
                        size="sm"
                        leftSection={<IconChartBar size={16} />}
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

              <SolverWarnings warnings={warnings} />

              {error && (
                <Alert color="red" mb="md">
                  {error}
                </Alert>
              )}

              {results.length > 0 ? (
                <Stack>
                  <WfesResultsTable data={results} columns={2} />
                  <Divider my="sm" />
                  <Text size="xs" c="dimmed">Execution time: {executionTime}</Text>
                  
                  <Group mt="md" gap="sm">
                    {!isExecuting && (
                      <Button 
                        leftSection={<IconPlayerPlay size={16} />}
                        size="sm"
                        onClick={handleExecute}
                      >
                        Re-execute
                      </Button>
                    )}
                  </Group>
                </Stack>
              ) : (
                <Stack align="center" justify="center" style={{ height: '300px' }}>
                  {isExecuting ? (
                    <>
                      <Loader size="lg" />
                      <Text size="sm" c="dimmed">Running the selective sweep...</Text>
                    </>
                  ) : (
                    <>
                      <Text size="sm" c="dimmed">
                        No results yet. Configure parameters and click Execute.
                      </Text>
                      <Button 
                        leftSection={<IconPlayerPlay size={16} />}
                        size="lg"
                        onClick={handleExecute}
                        mt="md"
                      >
                        Execute
                      </Button>
                    </>
                  )}
                </Stack>
              )}
            </Paper>
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

          expectedLength={(parseInt(populationSize) || 0) > 0 ? 4 * parseInt(populationSize) + 1 : null}
                  blocks={(parseInt(populationSize) || 0) > 0 ? [
                    { label: `pre-adaptive phase (counts 0..${2 * parseInt(populationSize)})`, length: 2 * parseInt(populationSize) + 1 },
                    { label: `adaptive phase (counts 0..${2 * parseInt(populationSize) - 1})`, length: 2 * parseInt(populationSize) }
                  ] : undefined}

          stateSpace="the concatenated pre-adaptive and adaptive phase states"

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
    {/* The two-regime time split -- the decomposition this model exists to
        produce. wfes_sweep emits no vector output, so this is the whole of
        what there is to draw. */}
    <DecompositionChartModal
      opened={showChartModal}
      onClose={() => setShowChartModal(false)}
      categories={['Regime 1 (waiting)', 'Regime 2 (sweep)']}
      series={regimeSplit ? [{ name: 'Generations', values: regimeSplit, kind: 'time' as const }] : []}
      title="Substitution time by regime"
      filename="wfes_sweep_regimes"
      categoryLabel="Regime"
    />
    </WfesViewLayout>
  )
}

export default WfesSweepViewMantine