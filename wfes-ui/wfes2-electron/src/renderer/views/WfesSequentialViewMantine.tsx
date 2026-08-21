import React, { useState, useEffect, useMemo } from 'react'
import InitialStateSelector, { InitialMode } from '../components/shared/InitialStateSelector'
import { saveTextFile } from '../utils/saveFile'
import {
  Table, 
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
  Badge,
  Divider,
  NumberInput,
  Box,
  Tooltip,
  useMantineTheme
} from '@mantine/core'
import { IconChartLine, IconCopy, IconPlus, IconX, IconArrowRight, IconPlayerPlay } from '@tabler/icons-react'
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
import { WfesSequentialParams, WfesResultItem } from '../types/wfes'
import { wfesService } from '../services/wfesService'
import { Math as MathTeX, SolverWarnings } from '../components/shared'
import AboutContentPanel from '../components/AboutContentPanel'
import { useExecuteShortcut } from '../hooks/useExecuteShortcut'
import SwitchingStateDiagram from '../components/shared/SwitchingStateDiagram'
import { sequentialDiagram } from '../utils/switchingDiagrams'
import { formatResultsCopy } from '../utils/resultsCopy'
import DecompositionChartModal from '../components/DecompositionChartModal'
import { qtyRow, sdRow, QUANTITIES, type QuantityKey } from '../utils/quantityLabels'

interface WfesSequentialViewProps {
  onBack: () => void
  hideBackButton?: boolean
}

interface EvolutionaryEpoch {
  id: string
  name: string
  N: string
  s: string
  h: string
  u: string
  v: string
  generations: string
  // (startingCopies / startingFrequency removed: wfes_sequential has no
  //  per-epoch initial-allele-state input. The allele always enters as a new
  //  mutant via the injection distribution; -p only weights WHICH EPOCH the
  //  process starts in. These fields were being converted to frequencies and
  //  sent as -p, which distorted or failed every run.)
}

const WfesSequentialViewMantine: React.FC<WfesSequentialViewProps> = ({ onBack, hideBackButton = false }) => {
  const theme = useMantineTheme()
  // How the starting state is specified. This tool offers 2 of the three.
  const [initialMode, setInitialMode] = useState<InitialMode>('integrate')
  const [initialDistFile, setInitialDistFile] = useState('')
  const [populationScaled, setPopulationScaled] = useState(true)
  const [activeEpochTab, setActiveEpochTab] = useState('0')
  
  // Evolutionary epochs
  const [epochs, setEpochs] = useState<EvolutionaryEpoch[]>([
    { 
      id: '1', 
      name: 'Epoch 1', 
      N: '100', 
      s: '0', 
      h: '0.5', 
      u: '0.001', 
      v: '0.001', 
      generations: '100'
    },
    { 
      id: '2', 
      name: 'Epoch 2', 
      N: '1000', 
      s: '0.01', 
      h: '0.5', 
      u: '0.001', 
      v: '0.001', 
      generations: '500'
    }
  ])
  
  // Additional parameters
  const [alpha, setAlpha] = useState('1e-20') // Probability cutoff
  // A sequential model starts in Epoch 1: the -p epoch-start distribution the
  // CLI also accepts is deliberately not exposed here (its default is Epoch 1).
  // The three standard ways of giving the starting ALLELE state are.
  const [startingCopies, setStartingCopies] = useState('1')
  
  // Output options
  // Standard keys consumed by buildWfesSequentialArgs. The previous keys
  // (writeEpochTimes / writeTrajectories / writeFinalFrequencies) matched no
  // CLI flag and nothing in the builder. No writeRes: no WFES binary has a
  // results-summary flag, and its old default of true made the options badge
  // read "1" on a fresh view.
  const [outputOptions, setOutputOptions] = useState({
    writeQ: false, writeR: false, writeN: false, writeB: false,
    writeNExt: false, writeNFix: false
  })
  
  // Execution options
  const [executionOptions, setExecutionOptions] = useState({
    force: false,
    threads: navigator.hardwareConcurrency || 4,
    library: 'Accelerate' as 'Accelerate' | 'Pardiso' | 'SuiteSparse' | 'ParU'
  })
  
  // Results state
  const [results, setResults] = useState<WfesResultItem[]>([])
  const [trajectoryData, setTrajectoryData] = useState<any[]>([])
  // Per-epoch result decomposition, quantity rows × epoch columns.
  // `raw` carries the numbers for the chart; `values` the formatted strings for
  // the table. Re-parsing the latter would be a round trip through a lossy
  // format for no reason.
  const [decomp, setDecomp] = useState<
    { label: React.ReactNode; plain: string; description: string; values: string[]; raw: number[]; kind: 'probability' | 'time' }[]
  >([])
  const [isExecuting, setIsExecuting] = useState(false)
  const [executionTime, setExecutionTime] = useState('')
  const [error, setError] = useState('')
  const [showChartModal, setShowChartModal] = useState(false)
  const [showTrajectoryModal, setShowTrajectoryModal] = useState(false)
  // Whatever the solver wrote to stderr while still exiting 0.
  const [warnings, setWarnings] = useState<string[]>([])

  // Helper function to clear results and reset execution state
  const clearResults = () => {
    setResults([])
    setTrajectoryData([])
    setWarnings([])
    setExecutionTime('')
    setError('')
  }
  
  // Handle population scaling toggle
  const handlePopulationScaledToggle = (newValue: boolean) => {
    const updatedEpochs = epochs.map(epoch => {
      const N = parseInt(epoch.N) || 100
      
      if (newValue && !populationScaled) {
        // Converting from raw to scaled values
        const rawU = parseFloat(epoch.u) || 0
        const rawV = parseFloat(epoch.v) || 0
        const rawS = parseFloat(epoch.s) || 0
        
        return {
          ...epoch,
          u: rawU === 0 ? '0' : (rawU * 4 * N).toString(),
          v: rawV === 0 ? '0' : (rawV * 4 * N).toString(),
          s: rawS === 0 ? '0' : (rawS * 2 * N).toString()
        }
      } else if (!newValue && populationScaled) {
        // Converting from scaled to raw values
        const scaledU = parseFloat(epoch.u) || 0
        const scaledV = parseFloat(epoch.v) || 0
        const scaledS = parseFloat(epoch.s) || 0
        
        return {
          ...epoch,
          u: scaledU === 0 ? '0' : (scaledU / (4 * N)).toString(),
          v: scaledV === 0 ? '0' : (scaledV / (4 * N)).toString(),
          s: scaledS === 0 ? '0' : (scaledS / (2 * N)).toString()
        }
      }
      
      return epoch
    })
    
    setEpochs(updatedEpochs)
    setPopulationScaled(newValue)
  }
  
  const addEpoch = () => {
    const newId = (Math.max(...epochs.map(p => parseInt(p.id))) + 1).toString()
    const lastEpoch = epochs[epochs.length - 1]
    const newEpoch: EvolutionaryEpoch = {
      ...lastEpoch,
      id: newId,
      name: `Epoch ${newId}`
    }
    
    setEpochs([...epochs, newEpoch])
    setActiveEpochTab((epochs.length).toString())
  }
  
  const removeEpoch = (id: string) => {
    if (epochs.length <= 1) return // Need at least 1 epoch
    
    const epochIndex = epochs.findIndex(p => p.id === id)
    const newEpochs = epochs.filter(p => p.id !== id)
    setEpochs(newEpochs)
    
    // Update active tab if needed
    if (activeEpochTab === epochIndex.toString()) {
      setActiveEpochTab('0')
    }
  }
  
  const updateEpoch = (id: string, field: keyof EvolutionaryEpoch, value: string) => {
    const updatedEpochs = epochs.map(epoch => 
      epoch.id === id ? { ...epoch, [field]: value } : epoch
    )
    setEpochs(updatedEpochs)
  }
  
  const moveEpochUp = (index: number) => {
    if (index === 0) return
    const newEpochs = [...epochs]
    ;[newEpochs[index], newEpochs[index - 1]] = [newEpochs[index - 1], newEpochs[index]]
    setEpochs(newEpochs)
  }
  
  const moveEpochDown = (index: number) => {
    if (index === epochs.length - 1) return
    const newEpochs = [...epochs]
    ;[newEpochs[index], newEpochs[index + 1]] = [newEpochs[index + 1], newEpochs[index]]
    setEpochs(newEpochs)
  }
  
  /**
   * The two starting-state flags, resolved in one place and read by BOTH the
   * parameters sent over IPC and the command-line preview, so the two cannot
   * describe different models.
   *
   * They are mutually exclusive, matching the CLI's own precedence
   * (--initial, then --starting-copies, then the integration over starting
   * copies): "Fixed p" sends a count and no cutoff, "Integrate over p" sends
   * the cutoff and no count, and a custom distribution file sends neither.
   * This view previously sent -c in every mode while showing --starting-copies
   * in the preview, so choosing "Fixed p" advertised one model and ran
   * another.
   */
  const startingCopiesArg = (): number | undefined => {
    if (initialMode !== 'fixed') return undefined
    const p = parseInt(startingCopies)
    return Number.isFinite(p) ? p : undefined
  }

  /**
   * 1e-10 is the parser's own default for -c and this view offers no cutoff
   * field, so integrating means integrating at that default -- and the
   * file and fixed-count modes, which do not integrate at all, omit the flag
   * rather than passing a value the run ignores or, worse, a value the preview
   * does not mention.
   */
  const integrationCutoffArg = (): number | undefined =>
    initialMode === 'integrate' ? 1e-10 : undefined

  const handleExecute = async () => {
    // Fixed-p mode needs a usable count BEFORE anything is sent: with a blank
    // or non-numeric p, startingCopiesArg() returns undefined, so the run
    // would carry neither --starting-copies nor -c -- and the CLI then
    // silently integrates over starting copies while the UI says "Fixed p".
    // A red border on the field is a hint, not a gate; this is the gate.
    if (initialMode === 'fixed' && !validatePositiveInteger(startingCopies)) {
      setError('Fixed p needs a positive whole number of starting copies. Enter one, or switch the initial state to "Integrate over p".')
      return
    }
    setIsExecuting(true)
    clearResults()

    try {
      // Prepare parameters for wfes_sequential
      const populationSizes: number[] = []
      const expectedTimes: number[] = []
      const selectionCoeffs: number[] = []
      const dominanceCoeffs: number[] = []
      const backwardMutations: number[] = []
      const forwardMutations: number[] = []
      
      // Extract parameters from each epoch
      epochs.forEach((epoch, index) => {
        const N = parseInt(epoch.N) || 100
        populationSizes.push(N)
        expectedTimes.push(parseInt(epoch.generations) || 100)
        
        // Handle population scaling
        if (populationScaled) {
          // Scaled values need to be converted to raw
          selectionCoeffs.push((parseFloat(epoch.s) || 0) / (2 * N))
          backwardMutations.push((parseFloat(epoch.u) || 0) / (4 * N))
          forwardMutations.push((parseFloat(epoch.v) || 0) / (4 * N))
        } else {
          // Raw values
          selectionCoeffs.push(parseFloat(epoch.s) || 0)
          backwardMutations.push(parseFloat(epoch.u) || 0)
          forwardMutations.push(parseFloat(epoch.v) || 0)
        }
        
        dominanceCoeffs.push(parseFloat(epoch.h) || 0.5)
      })

      
      const params = {
      
        // The chosen initial distribution. Every builder reads params.initial
      
        // before its own nested fallbacks.
      
        initial: initialMode === 'file' ? (initialDistFile || undefined) : undefined,
        population_sizes: populationSizes,
        expected_times: expectedTimes,
        selection_coefficients: selectionCoeffs,
        dominance_coefficients: dominanceCoeffs,
        backward_mutations: backwardMutations,
        forward_mutations: forwardMutations,
        starting_copies: startingCopiesArg(),
        alpha: parseFloat(alpha) || 1e-20,
        integration_cutoff: integrationCutoffArg(),
        output_options: outputOptions,
        execution_options: executionOptions
      }
      
      console.log('Executing WFES Sequential with params:', params)
      
      // Execute via service
      const result = await wfesService.executeSequential(params)
      
      if (result.success) {
        // Parse results
        const resultItems: WfesResultItem[] = []
        
        if (result.results) {
          // Names come from utils/quantityLabels, shared with every other
          // view. Dispersion gets its own row rather than a "value ± sd"
          // composite, so it can be read, copied and pasted as a number.
          // Order matters: the table pairs adjacent rows side by side, so each
          // time sits next to its own standard deviation.
          const rr0 = result.results
          if (rr0.P_ext !== undefined) resultItems.push(qtyRow('P_ext', rr0.P_ext))
          if (rr0.P_fix !== undefined) resultItems.push(qtyRow('P_fix', rr0.P_fix))
          if (rr0.T_ext !== undefined) {
            resultItems.push(qtyRow('T_ext', rr0.T_ext), sdRow('T_ext', rr0.T_ext_std))
          }
          if (rr0.T_fix !== undefined) {
            resultItems.push(qtyRow('T_fix', rr0.T_fix), sdRow('T_fix', rr0.T_fix_std))
          }
          if (rr0.T_tmo !== undefined) {
            resultItems.push(qtyRow('T_tmo', rr0.T_tmo), sdRow('T_tmo', rr0.T_tmo_std))
          }
          if (rr0.P_tmo !== undefined) resultItems.push(qtyRow('P_tmo', rr0.P_tmo))
        }
        
          // Execution time is reported under the table, not as a row in it:
          // the results table holds model quantities only.
        
        // Per-epoch decomposition (new CLI keys). Joint absorption
        // probabilities by epoch, derived conditionals, and per-epoch dwell.
        const fmtV = (x: unknown, dp = 6) =>
          typeof x === 'number' && isFinite(x)
            ? (Math.abs(x) >= 1e5 || (x !== 0 && Math.abs(x) < 1e-4) ? x.toExponential(4) : x.toFixed(dp))
            : '—'
        const decompRows: { label: React.ReactNode; plain: string; description: string; values: string[]; raw: number[]; kind: 'probability' | 'time' }[] = []
        // Same registry as the headline rows; here k indexes the epoch, so the
        // shared descriptions say "epoch" instead of "state".
        const epochWording = (d: string) => d.replace(/this state/g, 'this epoch')
        const addRow = (arr: unknown, key: QuantityKey) => {
          if (Array.isArray(arr) && arr.length > 0) {
            const q = QUANTITIES[key]
            decompRows.push({
              label: q.node, plain: q.plain, description: epochWording(q.description),
              values: arr.map(x => fmtV(x)),
              raw: arr.map(x => (typeof x === 'number' && isFinite(x) ? x : NaN)),
              kind: q.plain.startsWith('T') ? 'time' : 'probability'
            })
          }
        }
        const addDerived = (arr: unknown, total: unknown, key: QuantityKey) => {
          if (Array.isArray(arr) && typeof total === 'number' && isFinite(total) && total > 0) {
            const q = QUANTITIES[key]
            decompRows.push({
              label: q.node, plain: q.plain, description: epochWording(q.description),
              // Derived shares, not quantities; the chart plots the quantities.
              raw: [], kind: 'probability',
              values: arr.map(x => {
                if (typeof x !== 'number' || !isFinite(x)) return '—'
                const pct = (100 * x) / total
                return pct > 0 && pct < 0.01 ? '<0.01%' : `${pct.toFixed(2)}%`
              })
            })
          }
        }
        const rr = result.results
        addRow(rr.P_cond_ext, 'P_ext_k')
        addRow(rr.P_cond_fix, 'P_fix_k')
        addDerived(rr.P_cond_ext, rr.P_ext, 'P_k_ext')
        addDerived(rr.P_cond_fix, rr.P_fix, 'P_k_fix')
        addRow(rr.T_uncond, 'T_k')
        addRow(rr.T_cond_ext, 'T_k_ext')
        addRow(rr.T_cond_fix, 'T_k_fix')
        addRow(rr.T_cond_tmo, 'T_k_tmo')
        setDecomp(decompRows)

        setResults(resultItems)
        setWarnings(result.warnings || [])
        setExecutionTime(result.executionTime || '0s')
        
        // Note: Trajectory data would need to be implemented separately
        // as wfes_sequential doesn't output trajectories by default
        
      } else {
        setError(result.error || 'Execution failed')
      }
      
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error occurred')
    } finally {
      setIsExecuting(false)
    }
  }
  
  const handleStop = async () => {
    try {
      await wfesService.stopExecution()
      setIsExecuting(false)
    } catch (err) {
      console.error('Error stopping execution:', err)
    }
  }
  
  const handleExportData = (format: 'csv' | 'tsv') => {
    if (!trajectoryData || trajectoryData.length === 0) return
    
    const delimiter = format === 'tsv' ? '\t' : ','
    const headers = ['Run', 'Generation', 'Phase', 'Frequency', 'Copies']
    
    const data = [
      headers,
      ...trajectoryData.map(row => [
        row.run,
        row.generation,
        row.phase,
        row.frequency.toFixed(6),
        row.copies
      ])
    ]
    
    const content = data.map(row => row.join(delimiter)).join('\n')
    // Through the main process: an <a download> is silently dropped here.
    void saveTextFile(content, generateFilename('wfes_sequential', format))
  }
  
  const copyToClipboard = () => {
    navigator.clipboard.writeText(formatResultsCopy(
      'WFES Sequential results',
      results,
      [{
        title: 'Per-epoch breakdown',
        columns: epochs.map((e, k) => e.name || `Epoch ${k + 1}`),
        rows: decomp.map(r => ({ plain: r.plain, values: r.values })),
        notes: ['In the probability rows the epoch is where absorption ended; in the time rows it is where time was spent en route, conditional on the outcome.']
      }]
    ))
  }
  
  // Build command line string
  const buildCommandLine = () => {
    // Mirrors buildWfesSequentialArgs exactly, long-form flags included --
    // the earlier version used short aliases (-N, -s, ...) that, while valid,
    // did not match the spawned command token for token.
    const parts = ['wfes_sequential']
    const N = epochs.map(e => parseInt(e.N) || 100)
    const raw = (v: string, scale: number, i: number) =>
      populationScaled ? (parseFloat(v) || 0) / (scale * N[i]) : (parseFloat(v) || 0)
    parts.push(`--pop-sizes ${N.join(',')}`)
    parts.push(`--exp-time ${epochs.map(e => parseInt(e.generations) || 100).join(',')}`)
    parts.push(`--selection ${epochs.map((e, i) => raw(e.s, 2, i)).join(',')}`)
    parts.push(`--dominance ${epochs.map(e => parseFloat(e.h) || 0.5).join(',')}`)
    parts.push(`--backward-mu ${epochs.map((e, i) => raw(e.u, 4, i)).join(',')}`)
    parts.push(`--forward-mu ${epochs.map((e, i) => raw(e.v, 4, i)).join(',')}`)
    // Same two helpers the run reads, so the preview cannot promise a flag the
    // run omits (or omit one it passes).
    const startingCopiesFlag = startingCopiesArg()
    if (startingCopiesFlag !== undefined) parts.push(`--starting-copies ${startingCopiesFlag}`)
    const integrationCutoffFlag = integrationCutoffArg()
    if (integrationCutoffFlag !== undefined) parts.push(`--integration-cutoff ${integrationCutoffFlag}`)
    parts.push(`--alpha ${parseFloat(alpha) || 1e-20}`)
    parts.push(`--num-threads ${executionOptions.threads}`)
    const dir = (outputOptions as any).outputDirectory || '~/Downloads'
    if (outputOptions.writeQ) parts.push(`--output-Q ${dir}/wfes_sequential_Q.mtx`)
    if (outputOptions.writeR) parts.push(`--output-R ${dir}/wfes_sequential_R.csv`)
    if (outputOptions.writeN) parts.push(`--output-N ${dir}/wfes_sequential_N.csv`)
    if (outputOptions.writeB) parts.push(`--output-B ${dir}/wfes_sequential_B.csv`)
    if (outputOptions.writeNExt) parts.push(`--output-N-ext ${dir}/wfes_sequential_N_ext.csv`)
    if (outputOptions.writeNFix) parts.push(`--output-N-fix ${dir}/wfes_sequential_N_fix.csv`)
    if (executionOptions.force) parts.push('--force')
    parts.push(`--library ${executionOptions.library}`)
    if (initialMode === 'file' && initialDistFile) parts.push(`--initial ${initialDistFile}`)
    parts.push('--json')
    return parts.join(' ')
  }
  
  const copyCommandLine = () => {
    const command = buildCommandLine()
    navigator.clipboard.writeText(command)
  }
  
  // Count active output options for badge. Only real checkbox states count:
  // the drawer also stores the outputDirectory string in this object.
  const activeOutputOptions = Object.values(outputOptions).filter(v => v === true).length +
    (executionOptions.force ? 1 : 0)
  
  // Cmd+Enter (Ctrl+Enter off macOS) fires Execute / Re-execute.
  useExecuteShortcut(handleExecute, isExecuting)

  // Live state diagram: epochs in order, mean residence = the G the user typed.
  const diagramModel = useMemo(() => {
    return sequentialDiagram(epochs, populationScaled, null)
  }, [epochs, populationScaled])

  return (
    <WfesViewLayout
      title="Sequential Switching Model"
      onBack={onBack}
      hideBackButton={hideBackButton}
      outputOptions={outputOptions}
      onOutputOptionsChange={setOutputOptions}
      executionOptions={executionOptions}
      onExecutionOptionsChange={setExecutionOptions}
      activeOptionsCount={activeOutputOptions}
    >
      {/* Technical Details */}
      <AboutContentPanel modelName="wfes_sequential" />
      
      <Grid>
        {/* Column 1: Mode */}
        <Grid.Col span={4}>
          <Paper p="md" withBorder style={{ height: '400px' }}>
            <Title order={6} mb="sm">Mode</Title>
            <Text size="sm">
              <Badge>Standard Wright-Fisher</Badge> (Fixed)
            </Text>
            <Text size="xs" c="dimmed" mt="xs">
              Extinction and fixation are both absorbing through sequential evolutionary epochs
            </Text>
          </Paper>
        </Grid.Col>

        {/* Column 2: Results */}
        <Grid.Col span={8}>
          {/* minHeight, not height: results now include breakdown tables of
    variable size, and a fixed 400px box let them overflow past the
    paper into the sections below. The box grows to contain. */}
          <Paper p="md" withBorder style={{ minHeight: '400px' }}>
            <Group justify="space-between" mb="md">
              <Title order={6}>Results</Title>
              {results.length > 0 && (
                <Group gap="xs">
                  {trajectoryData.length > 0 && (
                    <Button 
                      variant="light" 
                      size="sm"
                      leftSection={<IconChartLine size={16} />}
                      onClick={() => setShowTrajectoryModal(true)}
                    >
                      View Trajectories
                    </Button>
                  )}
                  {decomp.some(r => (r.raw?.length ?? 0) > 0) && (
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

            <SolverWarnings warnings={warnings} />

            {error && (
              <Alert color="red" mb="md">
                {error}
              </Alert>
            )}
            
            {results.length > 0 ? (
              <Stack>
                <WfesResultsTable data={results} columns={2} />
                {decomp.length > 0 && (
                  <>
                    <Divider my="sm" label="Per-epoch breakdown" labelPosition="center" />
                    {/* Mantine v8 applies striping, column borders and cell
                        padding through its Table.* sub-components; with raw
                        thead/td children those props did nothing, so the
                        breakdown rendered with browser defaults -- no stripes
                        or borders, a centred "Quantity" header, and values
                        vertically centred against the two-line labels so they
                        floated next to the description instead of the label. */}
                    <Table size="sm" striped withColumnBorders>
                      <Table.Thead>
                        <Table.Tr>
                          <Table.Th style={{ textAlign: 'left' }}>Quantity</Table.Th>
                          {epochs.map((e, k) => (
                            <Table.Th key={k} style={{ textAlign: 'right' }}>{e.name || `Epoch ${k + 1}`}</Table.Th>
                          ))}
                        </Table.Tr>
                      </Table.Thead>
                      <Table.Tbody>
                        {decomp.map((row, i) => (
                          <Table.Tr key={i}>
                            <Table.Td style={{ fontWeight: 500, verticalAlign: 'top' }}>
                              <div>{row.label}</div>
                              <Text size="xs" c="dimmed" style={{ fontWeight: 400 }}>{row.description}</Text>
                            </Table.Td>
                            {row.values.map((v, k) => (
                              <Table.Td key={k} style={{ fontFamily: 'monospace', textAlign: 'right', verticalAlign: 'top', paddingLeft: 16, whiteSpace: 'nowrap' }}>{v}</Table.Td>
                            ))}
                          </Table.Tr>
                        ))}
                      </Table.Tbody>
                    </Table>
                    <Text size="xs" c="dimmed" mt={4}>
                      Note: in the probability rows the epoch is where absorption <em>ended</em>;
                      in the time rows it is where time was <em>spent</em> en route — conditional
                      on the outcome, wherever it ended.
                    </Text>
                  </>
                )}
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
                {trajectoryData.length > 0 && (
                  <Group mt="md">
                    <WfesExportButtons
                      onExport={(format) => {
                        if (format === 'csv') handleExportData('csv')
                        else if (format === 'png' || format === 'svg') {
                          // Opens the decomposition chart, where Export SVG
                          // writes both panels. There are no trajectories to
                          // export -- the solver computes expectations, and the
                          // previous handler was a no-op.
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
                    <Text size="sm" c="dimmed">Running the sequential epochs...</Text>
                  </>
                ) : (
                  <>
                    <Text size="sm" c="dimmed">
                      No results yet. Configure epochs and click Execute.
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
        </Grid.Col>
      </Grid>

      {/* Evolutionary Epochs and Additional Parameters below */}
      <Grid mt="md">
        <Grid.Col span={12}>
          <Stack>
            {/* Evolutionary Epochs */}
            <Paper p="md" withBorder>
              <Group justify="space-between" mb="sm">
                <Title order={6}>Evolutionary Epochs</Title>
                <Group gap="xs">
                  <Switch 
                    label="Population Scaled" 
                    checked={populationScaled}
                    onChange={(e) => handlePopulationScaledToggle(e.currentTarget.checked)}
                  />
                  <Button 
                    size="xs" 
                    leftSection={<IconPlus size={14} />}
                    variant="light"
                    onClick={addEpoch}
                  >
                    Add Epoch
                  </Button>
                </Group>
              </Group>
              
              <Stack gap="xs">
                {epochs.map((epoch, index) => (
                  <Paper key={epoch.id} p="sm" withBorder>
                    <Group justify="space-between" mb="xs">
                      <Group gap="xs">
                        <Text fw={500}>{epoch.name}</Text>
                        {index > 0 && (
                          <Badge size="sm" variant="light">
                            Continues from Epoch {index}
                          </Badge>
                        )}
                      </Group>
                      <Group gap={4}>
                        <ActionIcon 
                          size="sm" 
                          variant="subtle"
                          disabled={index === 0}
                          onClick={() => moveEpochUp(index)}
                        >
                          ↑
                        </ActionIcon>
                        <ActionIcon 
                          size="sm" 
                          variant="subtle"
                          disabled={index === epochs.length - 1}
                          onClick={() => moveEpochDown(index)}
                        >
                          ↓
                        </ActionIcon>
                        {epochs.length > 1 && (
                          <ActionIcon 
                            size="sm" 
                            color="red"
                            variant="subtle"
                            onClick={() => removeEpoch(epoch.id)}
                          >
                            <IconX size={14} />
                          </ActionIcon>
                        )}
                      </Group>
                    </Group>
                    
                    <Group grow gap="xs">
                      <WfesParameterInput
                        type="text"
                        label="Name"
                        value={epoch.name}
                        onChange={(value) => updateEpoch(epoch.id, 'name', value)}
                        size="xs"
                      />
                      <WfesParameterInput
                        type="text"
                        label="Mean generations (t)"
                        tooltip="The time spent in this epoch is geometrically distributed with this mean (--exp-time); individual histories vary around it. WFES has no exact-duration absorption solver; WFAF-D applies exact epoch lengths for frequency spectra."
                        value={epoch.generations}
                        onChange={(value) => updateEpoch(epoch.id, 'generations', value)}
                        error={!validatePositiveInteger(epoch.generations)}
                        size="xs"
                      />
                    </Group>
                    
                    <Divider my="xs" />
                    
                    <Group grow gap="xs">
                      <WfesParameterInput
                        type="text"
                        label="N"
                        value={epoch.N}
                        onChange={(value) => updateEpoch(epoch.id, 'N', value)}
                        error={!validatePositiveInteger(epoch.N)}
                        size="xs"
                      />
                      <WfesParameterInput
                        type="text"
                        label={populationScaled ? "2Ns" : "s"}
                        value={epoch.s}
                        onChange={(value) => updateEpoch(epoch.id, 's', value)}
                        error={!validateScientificNotation(epoch.s)}
                        size="xs"
                      />
                      <WfesParameterInput
                        type="text"
                        label="h"
                        value={epoch.h}
                        onChange={(value) => updateEpoch(epoch.id, 'h', value)}
                        error={!validateProbability(epoch.h)}
                        size="xs"
                      />
                    </Group>
                    
                    <Group grow gap="xs" mt="xs">
                      <WfesParameterInput
                        type="scientific"
                        label={populationScaled ? "4Nu" : "u"}
                        value={epoch.u}
                        onChange={(value) => updateEpoch(epoch.id, 'u', value)}
                        error={!validateScientificNotation(epoch.u)}
                        size="xs"
                      />
                      <WfesParameterInput
                        type="scientific"
                        label={populationScaled ? "4Nv" : "v"}
                        value={epoch.v}
                        onChange={(value) => updateEpoch(epoch.id, 'v', value)}
                        error={!validateScientificNotation(epoch.v)}
                        size="xs"
                      />
                    </Group>
                  </Paper>
                ))}
              </Stack>
            </Paper>
            
            {/* Additional Parameters */}
            <Paper p="md" withBorder>
              <Title order={6} mb="sm">Additional Parameters</Title>
              <Stack gap="sm">
                <WfesParameterInput
                  type="scientific"
                  label="α"
                  description="Probability mass trimmed from the tails of each matrix row (α/2 per tail); larger values give a sparser matrix"
                  value={alpha}
                  onChange={setAlpha}
                  error={!validateScientificNotation(alpha)}
                />
              </Stack>
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

          expectedLength={epochs.reduce((a, e) => a + (2 * (parseInt(e.N) || 0) - 1), 0) || null}
                  blocks={epochs.map((e, k) => ({
                    label: `${e.name || `Epoch ${k + 1}`} (N=${e.N}, counts 1..${2 * (parseInt(e.N) || 0) - 1})`,
                    length: 2 * (parseInt(e.N) || 0) - 1
                  }))}

          stateSpace="the concatenated transient states of all epochs"

        />
        {initialMode === 'fixed' && (
          <WfesParameterInput
            type="text"
            // Not "(p)": on wfes_sequential this field is the long-only
            // --starting-copies flag, while -p is the SEPARATE starting
            // probability vector over epochs. The old label equated the two.
            label="Starting copies"
            description="Initial number of copies of the allele in Epoch 1 (--starting-copies); NOT a sample size"
            value={startingCopies}
            onChange={setStartingCopies}
            error={!validatePositiveInteger(startingCopies)}
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
      
      {/* Per-epoch decomposition chart -- the same numbers as the breakdown
          table, which is the part of this output a picture actually helps. */}
      <DecompositionChartModal
        opened={showChartModal}
        onClose={() => setShowChartModal(false)}
        categories={epochs.map((e, k) => e.name || `Epoch ${k + 1}`)}
        series={decomp
          .filter(r => (r.raw?.length ?? 0) > 0)
          .map(r => ({ name: r.plain, values: r.raw, kind: r.kind }))}
        title="Per-epoch decomposition"
        filename="wfes_sequential_decomposition"
        categoryLabel="Epoch"
      />

      {/* Trajectory Modal */}
      <Modal
        opened={showTrajectoryModal}
        onClose={() => setShowTrajectoryModal(false)}
        size="xl"
        title="Evolution Trajectories"
      >
        {/* Placeholder: wfes_sequential is an exact solver and emits no
            trajectories; a real visualization here would need dedicated CLI
            support. The previous text promised "sample trajectories" from a
            number-of-runs setting that never existed. */}
        <Stack>
          <Text size="sm" c="dimmed">
            Trajectory visualization is not available: the solver computes exact
            expectations rather than simulating replicate histories.
          </Text>
        </Stack>
      </Modal>
    </WfesViewLayout>
  )
}

export default WfesSequentialViewMantine