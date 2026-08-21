import React, { useState } from 'react'
import InitialStateSelector, { InitialMode } from '../components/shared/InitialStateSelector'
import { saveTextFile } from '../utils/saveFile'
import { 
  NumberInput, 
  TextInput, 
  Button, 
  Checkbox, 
  Radio, 
  Group, 
  Stack, 
  Paper, 
  Title, 
  Text,
  Divider,
  ActionIcon,
  Tooltip,
  Select,
  Grid,
  Container,
  Space,
  Loader,
  Alert,
  SegmentedControl,
  Box,
  Drawer,
  Badge,
  Table,
  Modal,
  useMantineTheme
} from '@mantine/core'
import { 
  IconArrowLeft, 
  IconPlayerPlay, 
  IconPlayerStop, 
  IconDownload, 
  IconSettings,
  IconX,
  IconCopy,
  IconChartLine,
  IconInfoCircle,
  IconArrowRight
} from '@tabler/icons-react'
import EquilibriumChartModal from '../components/EquilibriumChartModal'
import EquilibriumChartModalNew from '../components/EquilibriumChartModalNew'
import FundamentalMatrixModal from '../components/FundamentalMatrixModal'
import { AboutContentPanel, SolverWarnings } from '../components/shared'
import { numOrUndefined, intOrUndefined, finiteOrUndefined } from '../utils/numeric'
import { useExecuteShortcut } from '../hooks/useExecuteShortcut'
import WfesResultsTable from '../components/shared/WfesResultsTable'
import { qtyRow, sdRow, plainRow, formatQuantity } from '../utils/quantityLabels'
import { formatResultsCopy } from '../utils/resultsCopy'
import { WfesResultItem } from '../types/wfes'

interface WfesSingleViewProps {
  onBack: () => void
  hideBackButton?: boolean
  /** Cross-link to another module, optionally opening it on a given tool. */
  onNavigate?: (
    view: string,
    opts?: { momentsOnly?: boolean; timeDistTool?: 'time-dist' | 'time-dist-dual' }
  ) => void
}

type ModelType = 'absorption' | 'fixation' | 'establishment' | 'fundamental' | 'nonAbsorbing' | 'equilibrium' | 'alleleAge'

/** Cross-link buttons: narrow column, long labels -- wrap instead of clipping. */
const LINK_BUTTON = {
  root: { height: 'auto', minHeight: 26, paddingTop: 5, paddingBottom: 5 },
  label: { whiteSpace: 'normal' as const, textAlign: 'left' as const, lineHeight: 1.3 }
}

const WfesSingleViewMantine2: React.FC<WfesSingleViewProps> = ({ onBack, hideBackButton = false, onNavigate }) => {
  const theme = useMantineTheme()
  
  // Model type
  const [modelType, setModelType] = useState<ModelType>('absorption')
  // Sojourn times are defined per starting state, so this mode has two useful
  // outputs and no third: one row of N, or the whole matrix. It gets its own
  // control rather than the three-way starting-distribution selector, which
  // offers an averaging over starting states that this mode is not for.
  const [sojournScope, setSojournScope] = useState<'all' | 'single'>('all')
  
  // Options drawer state
  const [optionsDrawerOpen, setOptionsDrawerOpen] = useState(false)
  
  // Helper function to clear results and reset execution state
  const clearResults = () => {
    setResults(null)
    setWarnings([])
    setExecutionTime('')
  }

  // Handle population scaling toggle
  const handlePopulationScaledToggle = (newValue: boolean) => {
    const N = parseInt(populationSize) || 100
    
    if (newValue && !scaledMutation) {
      // Converting from raw to scaled values
      // u → 4Nu, v → 4Nv, s → 2Ns
      const rawU = parseFloat(mutationRateBackward) || 0
      const rawV = parseFloat(mutationRateForward) || 0
      const rawS = parseFloat(selectionCoefficient) || 0
      
      // Use string formatting to handle scientific notation properly
      setMutationRateBackward(rawU === 0 ? '0' : (rawU * 4 * N).toString())
      setMutationRateForward(rawV === 0 ? '0' : (rawV * 4 * N).toString())
      setSelectionCoefficient(rawS === 0 ? '0' : (rawS * 2 * N).toString())
    } else if (!newValue && scaledMutation) {
      // Converting from scaled to raw values
      // 4Nu → u, 4Nv → v, 2Ns → s
      const scaledU = parseFloat(mutationRateBackward) || 0
      const scaledV = parseFloat(mutationRateForward) || 0
      const scaledS = parseFloat(selectionCoefficient) || 0
      
      // Use string formatting to handle scientific notation properly
      setMutationRateBackward(scaledU === 0 ? '0' : (scaledU / (4 * N)).toString())
      setMutationRateForward(scaledV === 0 ? '0' : (scaledV / (4 * N)).toString())
      setSelectionCoefficient(scaledS === 0 ? '0' : (scaledS / (2 * N)).toString())
    }
    
    setScaledMutation(newValue)
    setScaledSelection(newValue)
  }

  // Get CPU count for default threads
  const getCpuCount = () => {
    return navigator.hardwareConcurrency || 4
  }

  // Input parameters
  const [populationSize, setPopulationSize] = useState('100')
  const [selectionCoefficient, setSelectionCoefficient] = useState('0')
  const [dominanceCoefficient, setDominanceCoefficient] = useState('0.5')
  const [mutationRateForward, setMutationRateForward] = useState('0.001')
  const [mutationRateBackward, setMutationRateBackward] = useState('0.001')
  
  const [alpha, setAlpha] = useState('1e-20') // Probability cutoff
  const [startingCopies, setStartingCopies] = useState('1')
  const [integrationCutoff, setIntegrationCutoff] = useState('1e-10')
  const [mutationOnly, setMutationOnly] = useState(false)
  const [scaledMutation, setScaledMutation] = useState(true)
  const [scaledSelection, setScaledSelection] = useState(true)
  
  // Mode-specific parameters
  const [observedCopies, setObservedCopies] = useState('2')  // for alleleAge mode
  // Number of allele-age moments to report (2..10). 2 is the historical output;
  // each further moment is one extra back-substitution in the CLI.
  const [ageMoments, setAgeMoments] = useState('2')
  const [oddsRatio, setOddsRatio] = useState('1.0')  // for establishment mode

  // Output options. No writeRes: no WFES binary declares a results-summary
  // flag, so the "Write Res" checkbox that used to sit in this view's drawer
  // could never produce a file.
  const [writeQ, setWriteQ] = useState(false)
  const [writeR, setWriteR] = useState(false)
  const [writeB, setWriteB] = useState(false)
  const [writeN, setWriteN] = useState(false)
  const [writeNExt, setWriteNExt] = useState(false)
  const [writeNFix, setWriteNFix] = useState(false)
  const [writeI, setWriteI] = useState(false)
  const [writeE, setWriteE] = useState(false)
  const [writeV, setWriteV] = useState(false)
  // Destination folder for the files above; Downloads when unset.
  const [outputDirectory, setOutputDirectory] = useState('')

  // --output-E is written only inside the CLI's --equilibrium branch and
  // --output-V only inside its --fundamental branch; in any other mode the
  // flag parses and is then ignored. The checkboxes are disabled outside
  // their mode, and everything downstream reads emitE/emitV rather than the
  // raw state, so a box left ticked while the mode changes never asks for a
  // file the run will not produce. --output-I has no such restriction: the
  // CLI writes the starting distribution before it branches on model type.
  const canWriteE = modelType === 'equilibrium'
  const canWriteV = modelType === 'fundamental'
  const emitE = writeE && canWriteE
  const emitV = writeV && canWriteV

  // Execution options. No solver state: no WFES binary declares --solver,
  // and the Select that once chose one is long gone.
  const [force, setForce] = useState(false)
  const [threads, setThreads] = useState(getCpuCount().toString())
  const [library, setLibrary] = useState<'Accelerate' | 'ParU'>('Accelerate')
  const [initialDistribution, setInitialDistribution] = useState('')
  // Which of the three mutually exclusive initial-state specifications is in
  // use. Single source of truth: the command builder, the execute-time param
  // builder and the p/c enable/disable logic all read this directly rather
  // than a second piece of state that could fall out of step with it.
  const [initialMode, setInitialMode] = useState<InitialMode>('fixed')

  // Results state
  const [results, setResults] = useState<any>(null)
  const [isExecuting, setIsExecuting] = useState(false)
  const [executionTime, setExecutionTime] = useState('')
  // Whatever the solver wrote to stderr while still exiting 0.
  const [warnings, setWarnings] = useState<string[]>([])
  const [showEquilibriumChart, setShowEquilibriumChart] = useState(false)
  const [showFundamentalMatrix, setShowFundamentalMatrix] = useState(false)
  const [sojournType, setSojournType] = useState<'unconditional' | 'extinction' | 'fixation'>('unconditional')


  // Validation functions
  const validatePositiveInteger = (value: string) => {
    const num = parseInt(value)
    return !isNaN(num) && num > 0
  }

  const validateProbability = (value: string) => {
    const num = parseFloat(value)
    return !isNaN(num) && num >= 0 && num <= 1
  }

  // Mode-aware validity, matching the CLI's -p rules (args_parser.cpp):
  // fixation keeps count 0 as a transient state, so p = 0 is legal there and
  // means "start from zero copies, mutational origination included"; in the
  // both-absorbing modes (absorption, establishment, allele-age) count 0 is an
  // absorbing state and the CLI rejects -p 0. Valid counts top out at 2N-1 in
  // both state spaces (count 2N is always absorbing).
  const validateStartingCopies = () => {
    const p = parseInt(startingCopies)
    const N = parseInt(populationSize)
    if (isNaN(p) || isNaN(N)) return false
    const minCount = modelType === 'fixation' ? 0 : 1
    return p >= minCount && p <= 2 * N - 1
  }

  const modelOptions = [
    { value: 'absorption', label: 'Standard Wright-Fisher', description: 'Extinction and fixation are both absorbing' },
    { value: 'fixation', label: 'Substitution Model', description: 'Fixation only is absorbing, giving substitution-rate properties' },
    { value: 'fundamental', label: 'Sojourn Times', description: 'Sojourn times, including conditional on the absorbing state' },
    { value: 'establishment', label: 'Establishment Properties', description: 'Times and probabilities to establishment' },
    { value: 'alleleAge', label: 'Allele Age', description: 'Moments of allele age, computed directly' },
    { value: 'nonAbsorbing', label: 'Non-Absorbing Model', description: 'Full transition matrix, all states transient' },
    { value: 'equilibrium', label: 'Equilibrium Distribution', description: 'Stationary distribution of allele frequencies, all states transient' }
  ]

  const executeModel = async () => {
    setIsExecuting(true)
    clearResults()
    const startTime = Date.now()

    try {
      // Convert population-scaled values to raw values if needed
      const N = parseInt(populationSize)
      let rawForwardMutation = parseFloat(mutationRateForward)
      let rawBackwardMutation = parseFloat(mutationRateBackward)
      let rawSelectionCoeff = parseFloat(selectionCoefficient)
      
      if (scaledMutation) {
        // Convert from population-scaled to raw values
        // 4Nu → u, 4Nv → v
        rawBackwardMutation = rawBackwardMutation / (4 * N)
        rawForwardMutation = rawForwardMutation / (4 * N)
      }
      
      if (scaledSelection) {
        // 2Ns → s
        rawSelectionCoeff = rawSelectionCoeff / (2 * N)
      }

      // Prepare parameters for execution
      const params = {
        modelType,
        populationSize: N,
        // numOrUndefined/finiteOrUndefined rather than `|| undefined`: a zero
        // entered deliberately (s=0 neutral, u=0/v=0 no mutation, alpha=0 no
        // tail truncation, c=0 no cutoff) must reach the solver instead of
        // being dropped and silently replaced by a default. See utils/numeric.
        alpha: numOrUndefined(alpha),
        startingCopies: modelType === 'fundamental'
          ? (sojournScope === 'single' ? intOrUndefined(startingCopies) : undefined)
          : (initialMode === 'fixed' ? intOrUndefined(startingCopies) : undefined),
        integrationCutoff: numOrUndefined(integrationCutoff),
        observedCopies: modelType === 'alleleAge' ? intOrUndefined(observedCopies) : undefined,
        numMoments: modelType === 'alleleAge' ? (parseInt(ageMoments) || 2) : undefined,
        oddsRatio: modelType === 'establishment' ? numOrUndefined(oddsRatio) : undefined,
        forwardMutation: finiteOrUndefined(rawForwardMutation),
        backwardMutation: finiteOrUndefined(rawBackwardMutation),
        noRecurrentMutation: mutationOnly,
        selectionCoeff: finiteOrUndefined(rawSelectionCoeff),
        dominanceCoeff: numOrUndefined(dominanceCoefficient),
        outputOptions: {
          writeQ, writeR, writeB, writeN, writeNExt, writeNFix,
          writeI, writeE: emitE, writeV: emitV,
          // Where the requested files are written (outputPath in the main
          // process reads this; Downloads when empty).
          outputDirectory: outputDirectory || undefined
        },
        executionOptions: {
          force,
          threads: parseInt(threads),
          library,
          // --fundamental refuses --initial: sojourn times are conditioned on a
          // starting state, not averaged over a distribution of them.
          initialDistFile: modelType !== 'fundamental' && initialMode === 'file'
            ? (initialDistribution || undefined) : undefined
        }
      }

      // Execute via IPC
      const response = await window.api.wfes.single.execute(params)
      
      if (response.success) {
        console.log('Received results:', response.results)
        setResults(response.results)
        setWarnings(response.warnings || [])
        setExecutionTime(response.executionTime || `${((Date.now() - startTime) / 1000).toFixed(3)}s`)
      } else {
        alert(`Execution failed: ${response.error || 'Unknown error'}`)
      }
    } catch (error) {
      console.error('Execution error:', error)
      alert('Failed to execute WFES Single')
    } finally {
      setIsExecuting(false)
    }
  }

  const stopExecution = async () => {
    try {
      await window.api.wfes.stopExecution()
    } catch (err) {
      console.error('Error stopping execution:', err)
    } finally {
      // Unconditional: the run must stop showing as "executing" in the UI
      // whether or not the backend IPC call itself succeeded, otherwise a
      // rejected stopExecution() leaves isExecuting stuck true forever.
      setIsExecuting(false)
    }
  }

  const exportResults = () => {
    if (!results) return
    
    // For equilibrium distribution, export as CSV
    if (modelType === 'equilibrium' && results.distribution) {
      const headers = ['Copies', 'Frequency', 'Probability']
      const csvContent = [
        headers.join(','),
        ...results.distribution.map((d: any) => 
          `${d.copies},${d.copies / (2 * parseInt(populationSize))},${d.probability}`
        )
      ].join('\n')
      
      // Through the main process: an <a download> is silently dropped here.
      void saveTextFile(csvContent, `equilibrium_distribution_N${populationSize}.csv`)
    } else {
      // For other model types, export as JSON
      const data = JSON.stringify(results, null, 2)
      // Through the main process: an <a download> is silently dropped here.
      void saveTextFile(data, 'wfes_single_results.json')
    }
  }

  // Build command line string
  const buildCommandLine = () => {
    // Mirrors the actual run: view params -> IPC handler -> the arg builder in
    // wfesBackendService. The previous version emitted flags that exist in no
    // WFES tool, so the "run the same analysis from the command line" promise
    // under the preview was unkeepable. Verified against the spawned command.
    const parts = ['wfes_single']
    const N = parseInt(populationSize) || 100
    const rawS = scaledSelection ? (parseFloat(selectionCoefficient) || 0) / (2 * N) : (parseFloat(selectionCoefficient) || 0)
    const rawU = scaledMutation ? (parseFloat(mutationRateBackward) || 0) / (4 * N) : (parseFloat(mutationRateBackward) || 0)
    const rawV = scaledMutation ? (parseFloat(mutationRateForward) || 0) / (4 * N) : (parseFloat(mutationRateForward) || 0)
    const modeFlag: Record<string, string> = {
      absorption: '--absorption', fixation: '--fixation', fundamental: '--fundamental',
      equilibrium: '--equilibrium', establishment: '--establishment',
      alleleAge: '--allele-age', nonAbsorbing: '--non-absorbing'
    }
    parts.push(modeFlag[modelType] || `--${modelType}`)
    parts.push(`--pop-size ${N}`)
    if (Number.isFinite(rawS)) parts.push(`--selection ${rawS}`)
    parts.push(`--dominance ${parseFloat(dominanceCoefficient) || 0.5}`)
    // The run skips u/v when they equal the CLI default 1e-9 (see
    // buildWfesSingleArgs); zero is a real value and IS sent.
    if (Number.isFinite(rawU) && rawU !== 1e-9) parts.push(`--backward-mu ${rawU}`)
    if (Number.isFinite(rawV) && rawV !== 1e-9) parts.push(`--forward-mu ${rawV}`)
    if (mutationOnly) parts.push('--no-recurrent-mu')
    // Sojourn mode takes its starting count from its own scope control, not
    // from the three-way selector, and the run's builder already did. The
    // preview must follow the same rule or it advertises a flag the run omits.
    const wantsStartingCopies = modelType === 'fundamental'
      ? sojournScope === 'single'
      : initialMode === 'fixed'
    if (wantsStartingCopies && startingCopies !== '') parts.push(`--starting-copies ${parseInt(startingCopies)}`)
    if (modelType === 'alleleAge' && observedCopies !== '') parts.push(`--observed-copies ${parseInt(observedCopies)}`)
    if (modelType === 'alleleAge') parts.push(`--num-moments ${parseInt(ageMoments) || 2}`)
    if (modelType !== 'fundamental') {
      parts.push(`--integration-cutoff ${parseFloat(integrationCutoff) || 1e-10}`)
    }
    parts.push(`--odds-ratio ${modelType === 'establishment' ? (parseFloat(oddsRatio) || 1) : 1}`)
    // The run's builder skips --alpha at the CLI default 1e-20 (same
    // skip-if-default convention as --backward-mu/--forward-mu at 1e-9).
    const alphaVal = parseFloat(alpha) || 1e-20
    if (alphaVal !== 1e-20) parts.push(`--alpha ${alphaVal}`)
    parts.push(`--num-threads ${threads}`)
    parts.push(`--library ${library}`)
    if (initialMode === 'file' && initialDistribution) parts.push(`--initial ${initialDistribution}`)
    if (force) parts.push('--force')
    const dir = outputDirectory || '~/Downloads'
    if (writeQ) parts.push(`--output-Q ${dir}/wfes_single_Q.mtx`)
    if (writeR) parts.push(`--output-R ${dir}/wfes_single_R.csv`)
    if (writeB) parts.push(`--output-B ${dir}/wfes_single_B.csv`)
    if (writeN) parts.push(`--output-N ${dir}/wfes_single_N.csv`)
    if (writeNExt) parts.push(`--output-N-ext ${dir}/wfes_single_N_ext.csv`)
    if (writeNFix) parts.push(`--output-N-fix ${dir}/wfes_single_N_fix.csv`)
    if (writeI) parts.push(`--output-I ${dir}/wfes_single_I.csv`)
    if (emitE) parts.push(`--output-E ${dir}/wfes_single_E.csv`)
    if (emitV) parts.push(`--output-V ${dir}/wfes_single_V.csv`)
    parts.push('--json')
    return parts.join(' ')
  }

  const copyCommandLine = () => {
    const command = buildCommandLine()
    navigator.clipboard.writeText(command)
  }

  const copyResultsToClipboard = () => {
    if (!results) return
    // Reuses the same row builder as the table. This handler used to carry its
    // own parallel switch over modelType, which had already drifted: it named
    // the dispersion rows T_abs_SD where the table said "T_abs SD", and it
    // ordered absorption rows differently. One builder, one set of names.
    if (results.message && modelType !== 'fundamental' && modelType !== 'equilibrium') {
      navigator.clipboard.writeText(results.message)
      return
    }
    const rows = buildResultRows()
    if (rows.length === 0) return
    navigator.clipboard.writeText(formatResultsCopy('WFES single results', rows))
  }

  // Count active output options
  const activeOutputOptions = [writeQ, writeR, writeB, writeN, writeNExt, writeNFix, writeI, emitE, emitV].filter(Boolean).length

  /**
   * The quantities this mode reports, in display order.
   *
   * Shared by the table and by Copy so the two cannot drift apart. Names come
   * from utils/quantityLabels, which is also where their descriptions live.
   */
  const buildResultRows = (): WfesResultItem[] => {
    if (!results) return []
    const tableData: WfesResultItem[] = []

    switch (modelType) {
      case 'absorption':
        tableData.push(
          qtyRow('P_ext', results.P_ext),
          qtyRow('P_fix', results.P_fix),
          qtyRow('T_abs', results.T_abs),
          sdRow('T_abs', results.T_abs_std),
          qtyRow('T_ext', results.T_ext),
          sdRow('T_ext', results.T_ext_std),
          qtyRow('T_fix', results.T_fix),
          sdRow('T_fix', results.T_fix_std),
          qtyRow('N_ext', results.N_ext)
        )
        break
      case 'fixation':
        tableData.push(
          qtyRow('T_fix', results.T_fix),
          sdRow('T_fix', results.T_std),
          qtyRow('R_sub', results.rate)
        )
        break
      case 'establishment':
        tableData.push(
          qtyRow('f_est', results.est_freq),
          qtyRow('P_est', results.P_est),
          qtyRow('T_est', results.T_est),
          sdRow('T_est', results.T_est_std),
          qtyRow('T_seg', results.T_seg),
          sdRow('T_seg', results.T_seg_std),
          qtyRow('T_seg_ext', results.T_seg_ext),
          sdRow('T_seg_ext', results.T_seg_ext_std),
          qtyRow('T_seg_fix', results.T_seg_fix),
          sdRow('T_seg_fix', results.T_seg_fix_std)
        )
        break
      case 'fundamental':
        // The matrix covers every starting state and is shown in its own modal.
        // T_abs is the one reported quantity that depends on the starting
        // distribution: the sum of alpha^T N.
        if (results.T_abs !== undefined) tableData.push(qtyRow('T_abs', results.T_abs))
        break
      case 'equilibrium':
        tableData.push(qtyRow('E_freq', results.E_freq))
        break
      case 'alleleAge':
        tableData.push(
          qtyRow('T_age', results.E_T),
          sdRow('T_age', results.Std_T)
        )
        if (results.age_skewness !== undefined) {
          tableData.push(plainRow('Skewness', formatQuantity(results.age_skewness),
            'Standardised third central moment of allele age; positive means a long right tail'))
        }
        if (results.age_kurtosis_excess !== undefined) {
          tableData.push(plainRow('Excess kurtosis', formatQuantity(results.age_kurtosis_excess),
            'Fourth standardised central moment minus 3; positive means heavier tails than a Gaussian'))
        }
        if (Array.isArray(results.age_raw_moments)) {
          results.age_raw_moments.forEach((m: number, i: number) => {
            if (i >= 2) tableData.push(plainRow(`E[T^${i + 1}]`, formatQuantity(m),
              `Raw moment of order ${i + 1} of the allele age distribution`))
          })
        }
        break
    }

    return tableData
  }

  const renderResultsTable = () => {
    if (!results) return null

    // Message-only modes (non-absorbing, fundamental) have no quantities.
    if (results.message && modelType !== 'fundamental') {
      return (
        <Text size="sm" c="dimmed">
          {results.message.split('\n').map((line: string, i: number) => (
            <span key={i}>{line}<br /></span>
          ))}
        </Text>
      )
    }

    const tableData = buildResultRows()
    if (tableData.length === 0) return null

    // The shared component, on Mantine v8's Table.* sub-components. The table
    // this replaces was built from raw tbody/tr/td plus a v7-era `sx` prop, so
    // it rendered with 0px cell padding, no borders and no striping -- the
    // values read as floating text rather than as a table.
    return <WfesResultsTable data={tableData} columns={2} />
  }

  // Cmd+Enter (Ctrl+Enter off macOS) fires Execute / Re-execute.
  useExecuteShortcut(executeModel, isExecuting)

  return (
    <>
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
      <div className={`flex flex-col h-full bg-gray-800 dark:bg-gray-800 ${!hideBackButton ? 'native-window' : ''}`}>
      {/* Header */}
      <Paper py="sm" px="md" radius={0} style={{ borderBottom: `1px solid ${theme.colors.gray[7]}` }}>
        <Group justify="space-between">
          <Group>
            {!hideBackButton && (
              <Tooltip label="Back to main menu">
                <ActionIcon onClick={onBack} variant="subtle" size="lg">
                  <IconArrowLeft size={20} />
                </ActionIcon>
              </Tooltip>
            )}
            <Title order={4}>Time-Homogeneous WFES</Title>
          </Group>
          <Tooltip label="Options & Settings">
            <Box style={{ position: 'relative', padding: '6px' }}>
              <ActionIcon 
                onClick={() => setOptionsDrawerOpen(true)} 
                variant="subtle" 
                size="lg"
              >
                <IconSettings size={20} />
              </ActionIcon>
              {activeOutputOptions > 0 && (
                <Badge 
                  size="xs" 
                  color="blue" 
                  variant="filled"
                  style={{ 
                    position: 'absolute', 
                    top: 0, 
                    right: 0,
                    padding: '2px 4px',
                    minWidth: '16px'
                  }}
                >
                  {activeOutputOptions}
                </Badge>
              )}
            </Box>
          </Tooltip>
        </Group>
      </Paper>

      {/* Main content */}
      <Container fluid p="md" style={{ flex: 1, overflow: 'auto' }}>
        {/* Technical Details */}
        <AboutContentPanel modelName="wfes_single" />
        <Grid>
          {/* Column 1: Mode */}
          <Grid.Col span={4}>
            <Paper p="md" withBorder style={{ minHeight: '420px', overflow: 'hidden' }}>
              <Title order={6} mb="sm">Mode</Title>
              <Box style={{ width: '100%', overflow: 'hidden' }}>
                <SegmentedControl
                  value={modelType}
                  onChange={(value) => {
                    const next = value as ModelType
                    // Default starting count follows the mode: 0 for the
                    // Substitution Model (count 0 is transient there and means
                    // the mutation's own origination is included), 1 everywhere
                    // else. Only an untouched default is swapped.
                    const defaultFor = (m: ModelType) => (m === 'fixation' ? '0' : '1')
                    if (startingCopies === defaultFor(modelType)) {
                      setStartingCopies(defaultFor(next))
                    }
                    setModelType(next)
                    clearResults()
                  }}
                  data={modelOptions.map(option => ({ 
                    label: option.label, 
                    value: option.value 
                  }))}
                  orientation="vertical"
                  fullWidth
                  color="blue"
                  size="md"
                  className="mode-selector"
                />
              </Box>
              <Text size="xs" c="dimmed" mt="xs" style={{ minHeight: '60px' }}>
                {modelOptions.find(m => m.value === modelType)?.description}
              </Text>

              {/* The Substitution Model reports the MEAN time to substitution and
                  the rate that follows from it. The variance and higher moments,
                  and the distribution those moments summarise, are a different
                  program, and nothing on this screen said so: the natural reading
                  was that wfes_single is all there is for substitutions. It sits
                  inside the Mode panel because below it the panel's fixed height
                  pushed it under the fold. */}
              {/* The same gap in the default mode: this one reports absorption
                  PROBABILITIES and mean times, and the distributions those means
                  come from are the time_dist programs. */}
              {modelType === 'absorption' && onNavigate && (
                <>
                  <Divider my="sm" />
                  <Group gap={6} mb={4}>
                    <IconInfoCircle size={15} style={{ opacity: 0.7 }} />
                    <Text size="sm" fw={600}>Beyond the mean</Text>
                  </Group>
                  <Text size="xs" c="dimmed" mb="xs">
                    This mode gives absorption probabilities and mean times to
                    extinction and fixation. The distributions those means
                    summarise are computed by the Time to Extinction and Fixation
                    module.
                  </Text>
                  <Stack gap={6}>
                    <Button
                      variant="light" size="xs" fullWidth justify="space-between"
                      rightSection={<IconArrowRight size={14} style={{ flexShrink: 0 }} />}
                      styles={LINK_BUTTON}
                      onClick={() => onNavigate('time-dist', { timeDistTool: 'time-dist' })}
                    >
                      Full probability distributions
                    </Button>
                    <Button
                      variant="light" size="xs" fullWidth justify="space-between"
                      rightSection={<IconArrowRight size={14} style={{ flexShrink: 0 }} />}
                      styles={LINK_BUTTON}
                      onClick={() => onNavigate('time-dist', { timeDistTool: 'time-dist-dual' })}
                    >
                      Including the wait for a mutation
                    </Button>
                  </Stack>
                </>
              )}
              {modelType === 'fixation' && onNavigate && (
                <>
                  <Divider my="sm" />
                  <Group gap={6} mb={4}>
                    <IconInfoCircle size={15} style={{ opacity: 0.7 }} />
                    <Text size="sm" fw={600}>Beyond the mean</Text>
                  </Group>
                  <Text size="xs" c="dimmed" mb="xs">
                    This mode gives the expected time to substitution and the rate
                    that follows from it. The spread of that time is computed by
                    the Time to Substitution module.
                  </Text>
                  <Stack gap={6}>
                    {/* This column is narrow and the labels are long enough to
                        clip in it, so the label wraps and the button grows to
                        fit rather than the text being cut at the arrow. */}
                    <Button
                      variant="light" size="xs" fullWidth justify="space-between"
                      rightSection={<IconArrowRight size={14} style={{ flexShrink: 0 }} />}
                      styles={LINK_BUTTON}
                      onClick={() => onNavigate('phase-type', { momentsOnly: true })}
                    >
                      Moments (variance, skewness)
                    </Button>
                    <Button
                      variant="light" size="xs" fullWidth justify="space-between"
                      rightSection={<IconArrowRight size={14} style={{ flexShrink: 0 }} />}
                      styles={LINK_BUTTON}
                      onClick={() => onNavigate('phase-type', { momentsOnly: false })}
                    >
                      Full probability distribution
                    </Button>
                  </Stack>
                </>
              )}
            </Paper>

          </Grid.Col>

          {/* Column 2: Results */}
          <Grid.Col span={8}>
            <Paper p="md" withBorder style={{ height: '100%', minHeight: '300px' }}>
              <Group justify="space-between" mb="md">
                <Title order={6}>Results</Title>
                {results && (
                  <Group gap="xs">
                    {modelType === 'equilibrium' && results.distribution && (
                      <Button 
                        variant="light" 
                        size="sm"
                        leftSection={<IconChartLine size={16} />}
                        onClick={() => setShowEquilibriumChart(true)}
                      >
                        View Chart
                      </Button>
                    )}
                    <Button 
                      variant="light" 
                      size="sm"
                      leftSection={<IconCopy size={16} />}
                      onClick={copyResultsToClipboard}
                    >
                      Copy
                    </Button>
                    <Button 
                      variant="light" 
                      size="sm"
                      leftSection={<IconDownload size={16} />}
                      onClick={exportResults}
                    >
                      Export
                    </Button>
                  </Group>
                )}
              </Group>

              <SolverWarnings warnings={warnings} />

              {isExecuting ? (
                <Stack align="center" justify="center" style={{ height: '200px' }}>
                  <Loader size="lg" />
                  <Text size="sm" c="dimmed">Running...</Text>
                  <Button
                    leftSection={<IconPlayerStop size={16} />}
                    size="lg"
                    color="red"
                    onClick={stopExecution}
                  >
                    Stop
                  </Button>
                </Stack>
              ) : results ? (
                <Stack gap="sm">
                  {renderResultsTable()}
                  <Divider my="sm" />
                  <Text size="xs" c="dimmed">Execution time: {executionTime}</Text>
                  
                  <Group mt="md" gap="sm">
                    <Button
                      leftSection={<IconPlayerPlay size={16} />}
                      size="sm"
                      onClick={executeModel}
                    >
                      Re-execute
                    </Button>

                    {modelType === 'fundamental' && results.fundamental_matrix && (
                      <Stack gap="xs">
                        <Button 
                          variant="light" 
                          size="sm"
                          onClick={() => {
                            setSojournType('unconditional')
                            setShowFundamentalMatrix(true)
                          }}
                        >
                          View N (unconditional)
                        </Button>
                        {results.n_ext && (
                          <Button 
                            variant="light" 
                            size="sm"
                            onClick={() => {
                              setSojournType('extinction')
                              setShowFundamentalMatrix(true)
                            }}
                          >
                            View N_ext (extinction-conditioned)
                          </Button>
                        )}
                        {results.n_fix && (
                          <Button 
                            variant="light" 
                            size="sm"
                            onClick={() => {
                              setSojournType('fixation')
                              setShowFundamentalMatrix(true)
                            }}
                          >
                            View N_fix (fixation-conditioned)
                          </Button>
                        )}
                      </Stack>
                    )}
                  </Group>
                </Stack>
              ) : (
                <Stack align="center" justify="center" style={{ height: '200px' }}>
                  <Text size="sm" c="dimmed">
                    No results yet. Configure parameters and click Execute.
                  </Text>
                  <Group mt="md">
                    <Button
                      leftSection={<IconPlayerPlay size={16} />}
                      size="lg"
                      onClick={executeModel}
                    >
                      Execute
                    </Button>
                  </Group>
                </Stack>
              )}
            </Paper>
          </Grid.Col>
        </Grid>

        {/* Input Parameters below */}
        <Grid mt="md">
          <Grid.Col span={12}>
            <Stack>
              {/* Population Section */}
              <Paper p="md" withBorder>
                <Title order={6} mb="sm">Population</Title>
                <Group grow align="flex-start">
                  <Box>
                    <NumberInput
                      label="N"
                      description="Population size"
                      value={populationSize}
                      onChange={(value) => setPopulationSize(value?.toString() || '')}
                      min={1}
                      required
                      error={populationSize !== '' && !validatePositiveInteger(populationSize)}
                    />
                  </Box>
                  <Box>
                    <TextInput
                      label="α"
                      description="Probability cutoff"
                      value={alpha}
                      onChange={(event) => setAlpha(event.currentTarget.value)}
                      placeholder="1e-20"
                    />
                    <Text size="xs" c="dimmed" mt={4}>
                      Probability mass trimmed from the tails of each matrix row (α/2 per tail), which the row is renormalised after
                    </Text>
                  </Box>
                  <Box>
                    <NumberInput
                      label="p"
                      description={modelType === 'fixation'
                        ? 'Starting number of copies (0 = include mutational origination)'
                        : 'Starting number of copies'}
                      value={startingCopies}
                      onChange={(value) => setStartingCopies(value?.toString() || '')}
                      // Editable only in the mode that reads it ('fixed'): in
                      // file mode too the run sends no --starting-copies, so an
                      // enabled field there would edit a number the run ignores.
                      disabled={initialMode !== 'fixed' || !(modelType === 'absorption' || modelType === 'fixation' || modelType === 'establishment' || modelType === 'alleleAge')}
                      min={modelType === 'fixation' ? 0 : 1}
                      max={populationSize ? parseInt(populationSize) * 2 - 1 : undefined}
                      error={startingCopies !== '' && !validateStartingCopies()}
                    />
                  </Box>
                  <Box>
                    <TextInput
                      label="c"
                      description="Starting probability cutoff"
                      value={integrationCutoff}
                      onChange={(event) => setIntegrationCutoff(event.currentTarget.value)}
                      placeholder="1e-10"
                      disabled={initialMode !== 'integrate' || !(modelType === 'absorption' || modelType === 'fixation' || modelType === 'establishment' || modelType === 'alleleAge')}
                    />
                    <Text size="xs" c="dimmed" mt={4}>
                      Starting copy numbers rarer than this are left out of the integration over p
                    </Text>
                  </Box>
                </Group>
                {modelType === 'fundamental' && (
                  <Stack gap="xs" mt="sm">
                    <SegmentedControl
                      size="xs"
                      value={sojournScope}
                      onChange={(v) => setSojournScope(v as 'all' | 'single')}
                      data={[
                        { value: 'all', label: 'All starting states' },
                        { value: 'single', label: 'One starting count' }
                      ]}
                    />
                    {sojournScope === 'single' ? (
                      <NumberInput
                        label="Starting copies (p)"
                        description={`Row of N for this count, 1 to ${populationSize ? parseInt(populationSize) * 2 - 1 : ''}`}
                        value={startingCopies}
                        onChange={(v) => setStartingCopies(v?.toString() || '')}
                        min={1}
                        max={populationSize ? parseInt(populationSize) * 2 - 1 : undefined}
                        error={startingCopies !== '' && !validateStartingCopies()}
                      />
                    ) : (
                      <Text size="xs" c="dimmed">
                        The full fundamental matrix, one row per starting count. Choosing a
                        single count is one solve instead of 2N-1.
                      </Text>
                    )}
                  </Stack>
                )}
                {/* Same control as every other view; the single view is the one tool
                    that offers all three alternatives. */}
                <InitialStateSelector
                  modes={['fixed', 'integrate', 'file']}
                  value={initialMode}
                  onChange={(m) => {
                    setInitialMode(m)
                    if (m !== 'file') setInitialDistribution('')
                  }}
                  file={initialDistribution}
                  onFileChange={setInitialDistribution}
                  expectedLength={(parseInt(populationSize) || 0) > 0 ? 2 * parseInt(populationSize) - 1 : null}
                  stateSpace="allele counts 1..2N-1"
                  disabled={!(modelType === 'absorption' || modelType === 'fixation' || modelType === 'establishment' || modelType === 'alleleAge')}
                />
              </Paper>

              {/* Mode-specific options */}
              {(modelType === 'establishment' || modelType === 'alleleAge') && (
                <Paper p="md" withBorder>
                  <Title order={6} mb="sm">Additional Parameters</Title>
                  <Group grow>
                    {modelType === 'alleleAge' && (
                      <NumberInput
                        label="x"
                        description="Observed number of copies"
                        value={observedCopies}
                        onChange={(value) => setObservedCopies(value?.toString() || '')}
                        min={1}
                      />
                    )}
                    {modelType === 'alleleAge' && (
                      <NumberInput
                        label="Moments (k)"
                        description="Raw moments of allele age to report; 3+ adds skewness, 4+ excess kurtosis"
                        value={ageMoments}
                        onChange={(value) => setAgeMoments(value?.toString() || '2')}
                        min={2}
                        max={10}
                      />
                    )}
                    {modelType === 'establishment' && (
                      <TextInput
                        label="k"
                        description="Desired odds ratio of fixation to extinction"
                        value={oddsRatio}
                        onChange={(event) => setOddsRatio(event.currentTarget.value)}
                        placeholder="1.0"
                      />
                    )}
                  </Group>
                </Paper>
              )}

              {/* Mutation & Selection Section */}
              <Grid>
                <Grid.Col span={6}>
                  <Paper p="md" withBorder style={{ height: '100%' }}>
                    <Title order={6} mb="sm">Mutation</Title>
                    <Stack gap="sm">
                      <TextInput
                        label={scaledMutation ? "4Nu" : "u"}
                        description={scaledMutation ? "Population-scaled backward mutation rate" : "Backward mutation rate"}
                        value={mutationRateBackward}
                        onChange={(event) => setMutationRateBackward(event.currentTarget.value)}
                        placeholder="e.g., 0.001 or 1e-3"
                      />
                      <TextInput
                        label={scaledMutation ? "4Nv" : "v"}
                        description={scaledMutation ? "Population-scaled forward mutation rate" : "Forward mutation rate"}
                        value={mutationRateForward}
                        onChange={(event) => setMutationRateForward(event.currentTarget.value)}
                        placeholder="e.g., 0.001 or 1e-3"
                      />
                      <Group>
                        <Checkbox
                          label="Population Scaled"
                          checked={scaledMutation}
                          onChange={(event) => handlePopulationScaledToggle(event.currentTarget.checked)}
                        />
                        <Checkbox
                          label="Disable recurrent mutation"
                          checked={mutationOnly}
                          onChange={(event) => setMutationOnly(event.currentTarget.checked)}
                        />
                      </Group>
                    </Stack>
                  </Paper>
                </Grid.Col>

                <Grid.Col span={6}>
                  <Paper p="md" withBorder style={{ height: '100%' }}>
                    <Title order={6} mb="sm">Selection</Title>
                    <Stack gap="sm">
                      <TextInput
                        label={scaledSelection ? "2Ns" : "s"}
                        description={scaledSelection ? "Population-scaled selection coefficient" : "Selection coefficient"}
                        value={selectionCoefficient}
                        onChange={(event) => setSelectionCoefficient(event.currentTarget.value)}
                        placeholder="e.g., 0, 1, -2.5"
                      />
                      <NumberInput
                        label="h"
                        description="Dominance coefficient"
                        value={dominanceCoefficient}
                        onChange={(value) => setDominanceCoefficient(value?.toString() || '')}
                        step={0.1}
                        precision={2}
                        min={0}
                        max={1}
                        error={dominanceCoefficient !== '' && !validateProbability(dominanceCoefficient)}
                      />
                    </Stack>
                  </Paper>
                </Grid.Col>
              </Grid>
            </Stack>
          </Grid.Col>
        </Grid>

        {/* Command Line Preview - Full width below all other content */}
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
      </Container>

      {/* Options Drawer */}
      <Drawer
        opened={optionsDrawerOpen}
        onClose={() => setOptionsDrawerOpen(false)}
        title="Options & Settings"
        position="right"
        size="sm"
        padding="md"
      >
        <Stack>
          {/* Output Options */}
          <Paper p="md" withBorder>
            <Title order={6} mb="sm">Output Options</Title>
            <Stack gap="sm">
              <div>
                <Checkbox 
                  label="Write Q" 
                  checked={writeQ} 
                  onChange={(e) => setWriteQ(e.currentTarget.checked)} 
                />
                <Text size="xs" c="dimmed" ml={22}>
                  Transient-to-transient transition probability sub-matrix
                </Text>
              </div>
              <div>
                <Checkbox 
                  label="Write R" 
                  checked={writeR} 
                  onChange={(e) => setWriteR(e.currentTarget.checked)} 
                />
                <Text size="xs" c="dimmed" ml={22}>
                  Transient-to-absorbing transition probability sub-matrix
                </Text>
              </div>
              <div>
                <Checkbox 
                  label="Write B" 
                  checked={writeB} 
                  onChange={(e) => setWriteB(e.currentTarget.checked)} 
                />
                <Text size="xs" c="dimmed" ml={22}>
                  Absorption probability matrix: B = NR
                </Text>
              </div>
              <div>
                <Checkbox 
                  label="Write N" 
                  checked={writeN} 
                  onChange={(e) => setWriteN(e.currentTarget.checked)} 
                />
                <Text size="xs" c="dimmed" ml={22}>
                  Fundamental matrix: N = (I-Q)^(-1)
                </Text>
              </div>
              <div>
                <Checkbox 
                  label="Write N_Ext" 
                  checked={writeNExt} 
                  onChange={(e) => setWriteNExt(e.currentTarget.checked)} 
                />
                <Text size="xs" c="dimmed" ml={22}>
                  Fundamental matrix, conditioned on extinction
                </Text>
              </div>
              <div>
                <Checkbox 
                  label="Write N_Fix" 
                  checked={writeNFix} 
                  onChange={(e) => setWriteNFix(e.currentTarget.checked)} 
                />
                <Text size="xs" c="dimmed" ml={22}>
                  Fundamental matrix, conditioned on fixation
                </Text>
              </div>
              <div>
                <Checkbox 
                  label="Write I" 
                  checked={writeI} 
                  onChange={(e) => setWriteI(e.currentTarget.checked)} 
                />
                <Text size="xs" c="dimmed" ml={22}>
                  Initial probability distribution over starting states
                </Text>
              </div>
              <div>
                <Checkbox 
                  label="Write E" 
                  checked={writeE} 
                  disabled={!canWriteE}
                  onChange={(e) => setWriteE(e.currentTarget.checked)} 
                />
                <Text size="xs" c="dimmed" ml={22}>
                  Equilibrium allele frequency distribution
                  {!canWriteE && ' \u2014 requires the Equilibrium model'}
                </Text>
              </div>
              <div>
                <Checkbox 
                  label="Write V" 
                  checked={writeV} 
                  disabled={!canWriteV}
                  onChange={(e) => setWriteV(e.currentTarget.checked)} 
                />
                <Text size="xs" c="dimmed" ml={22}>
                  Variance of sojourn times: V = N(2N_dg - I) - N_sq
                  {!canWriteV && ' \u2014 requires the Fundamental model'}
                </Text>
              </div>
              {/* No "Write Res" here any more: wfes_single (like every WFES
                  binary) declares no results-summary flag, so that checkbox
                  could never produce a file. */}
              <Divider my="xs" />
              <div>
                <Text size="sm" fw={500}>Output folder</Text>
                <Text size="xs" c="dimmed" mb={6}>
                  Where the files selected above are written. Defaults to Downloads.
                </Text>
                <Group gap="xs" align="center">
                  <Text size="xs" style={{ flex: 1, wordBreak: 'break-all' }}>
                    {outputDirectory || '(Downloads)'}
                  </Text>
                  <Button
                    size="xs"
                    variant="default"
                    onClick={async () => {
                      const dir = await (window as any).api.dialog.selectDirectory()
                      if (dir) setOutputDirectory(dir)
                    }}
                  >
                    Choose...
                  </Button>
                </Group>
              </div>
            </Stack>
          </Paper>

          {/* Execution Options */}
          <Paper p="md" withBorder>
            <Title order={6} mb="sm">Execution</Title>
            <Stack gap="sm">
              <Checkbox 
                label="Force" 
                checked={force} 
                onChange={(e) => setForce(e.currentTarget.checked)} 
              />
              <NumberInput
                label="Threads"
                description="Number of threads"
                value={threads}
                onChange={(value) => setThreads(value?.toString() || '')}
                min={1}
                max={getCpuCount()}
              />
              <Select
                label="Library"
                value={library}
                onChange={(value) => setLibrary(value as 'Accelerate' | 'ParU')}
                data={[
                  // Only backends compiled into the shipped binaries: ViennaCL
                  // needs OpenCL support that is not built, and Pardiso is
                  // unavailable on Apple Silicon. Both errored at run time.
                  { value: 'Accelerate', label: 'Default (UMFPACK)' },
                  { value: 'ParU', label: 'ParU (SuiteSparse, parallel)' }
                ]}
              />
            </Stack>
          </Paper>
        </Stack>
      </Drawer>

      {/* Chart Modals */}
      <Modal
        opened={showEquilibriumChart}
        onClose={() => setShowEquilibriumChart(false)}
        size="90%"
        title="Equilibrium Frequency Distribution"
      >
        <EquilibriumChartModalNew
          data={results?.distribution || []}
          populationSize={parseInt(populationSize)}
          expectedFrequency={numOrUndefined(results?.E_freq)}
          parameters={{
            N: parseInt(populationSize),
            s: parseFloat(selectionCoefficient) / (scaledSelection ? 2 * parseInt(populationSize) : 1),
            h: parseFloat(dominanceCoefficient),
            u: parseFloat(mutationRateBackward) / (scaledMutation ? 4 * parseInt(populationSize) : 1),
            v: parseFloat(mutationRateForward) / (scaledMutation ? 4 * parseInt(populationSize) : 1)
          }}
        />
      </Modal>
      
      <FundamentalMatrixModal
        opened={showFundamentalMatrix}
        onClose={() => setShowFundamentalMatrix(false)}
        data={
          sojournType === 'extinction' && results?.n_ext ? results.n_ext :
          sojournType === 'fixation' && results?.n_fix ? results.n_fix :
          results?.fundamental_matrix || []
        }
        populationSize={parseInt(populationSize)}
        parameters={{
          N: parseInt(populationSize),
          s: parseFloat(selectionCoefficient) / (scaledSelection ? 2 * parseInt(populationSize) : 1),
          h: parseFloat(dominanceCoefficient),
          u: parseFloat(mutationRateBackward) / (scaledMutation ? 4 * parseInt(populationSize) : 1),
          v: parseFloat(mutationRateForward) / (scaledMutation ? 4 * parseInt(populationSize) : 1)
        }}
        title={
          sojournType === 'extinction' ? 'Extinction-Conditioned Sojourn Times N_ext(i,j)' :
          sojournType === 'fixation' ? 'Fixation-Conditioned Sojourn Times N_fix(i,j)' :
          'Unconditional Sojourn Times N(i,j)'
        }
      />
    </div>
    </>
  )
}

export default WfesSingleViewMantine2