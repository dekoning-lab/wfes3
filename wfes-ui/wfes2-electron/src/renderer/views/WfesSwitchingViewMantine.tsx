import React, { useState, useMemo } from 'react'
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
  SegmentedControl,
  Box,
  Tooltip,
  Checkbox,
  useMantineTheme
} from '@mantine/core'
import { IconChartLine, IconCopy, IconPlus, IconX, IconClock, IconPlayerPlay } from '@tabler/icons-react'
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
import { WfesSwitchingParams, WfesResultItem } from '../types/wfes'
import { wfesService } from '../services/wfesService'
import { Math as MathTeX, SolverWarnings } from '../components/shared'
import AboutContentPanel from '../components/AboutContentPanel'
import SwitchingRatesMatrix from '../components/SwitchingRatesMatrix'
import { useExecuteShortcut } from '../hooks/useExecuteShortcut'
import SwitchingStateDiagram from '../components/shared/SwitchingStateDiagram'
import { generalSwitchingDiagram } from '../utils/switchingDiagrams'
import { formatResultsCopy } from '../utils/resultsCopy'
import DecompositionChartModal from '../components/DecompositionChartModal'
import { qtyRow, QUANTITIES, type QuantityKey } from '../utils/quantityLabels'

interface WfesSwitchingViewProps {
  onBack: () => void
  hideBackButton?: boolean
}

interface PopulationState {
  id: string
  name: string
  N: string
  s: string
  h: string
  u: string
  v: string
}

interface SwitchingRate {
  fromState: string
  toState: string
  rate: string
}

const WfesSwitchingViewMantine: React.FC<WfesSwitchingViewProps> = ({ onBack, hideBackButton = false }) => {
  const theme = useMantineTheme()
  // How the starting state is specified. This tool offers 2 of the three.
  const [initialMode, setInitialMode] = useState<InitialMode>('integrate')
  const [initialDistFile, setInitialDistFile] = useState('')
  const [populationScaled, setPopulationScaled] = useState(true)
  const [activeStateTab, setActiveStateTab] = useState('0')
  
  // Population states
  const [populationStates, setPopulationStates] = useState<PopulationState[]>([
    { id: '1', name: 'State 1', N: '100', s: '0', h: '0.5', u: '0.001', v: '0.001' },
    { id: '2', name: 'State 2', N: '100', s: '0.01', h: '0.5', u: '0.001', v: '0.001' }
  ])
  
  // Switching rates between states
  const [switchingRates, setSwitchingRates] = useState<SwitchingRate[]>([
    { fromState: '1', toState: '2', rate: '0.01' },
    { fromState: '2', toState: '1', rate: '0.01' }
  ])
  
  // Additional parameters
  const [alpha, setAlpha] = useState('1e-20') // Probability cutoff
  /**
   * Probability of starting in each model state, as a comma-separated string.
   *
   * The default is all mass in the first state. That is a WFES3 choice, not the
   * CLI's: wfes_switching with no --starting-prob applies a uniform
   * distribution (dvec::Constant(n_models, 1/n_models)). So the value is held
   * explicitly here and always sent, which keeps the dialog, the model diagram,
   * the command preview and the solver showing one number. It must be resized
   * whenever a state is added or removed, or the length check against
   * populationStates fails and wfes_switching rejects the vector.
   */
  const massInFirstState = (n: number) =>
    Array.from({ length: n }, (_, i) => (i === 0 ? '1' : '0')).join(',')
  const [startingProbabilities, setStartingProbabilities] = useState<string>(massInFirstState(2))
  const [modelType, setModelType] = useState('absorption')
  const [integrationCutoff, setIntegrationCutoff] = useState('1e-10') // c parameter
  
  // Output options
  const [outputOptions, setOutputOptions] = useState({
    writePExt: false,
    writePFix: false,
    writeTExt: false,
    writeTFix: false,
    writeStateProbs: false,
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
  // Per-state result decomposition, rendered as quantity-rows × state-columns.
  // `raw` carries the numbers themselves: the table needs the formatted
  // strings, the chart needs the values, and re-parsing the strings back into
  // numbers would be a needless round trip through a lossy format.
  const [decomp, setDecomp] = useState<
    { label: React.ReactNode; plain: string; description: string; values: string[]; raw: number[]; kind: 'probability' | 'time' }[]
  >([])
  const [isExecuting, setIsExecuting] = useState(false)

  // UI state
  const [showSwitchingRatesModal, setShowSwitchingRatesModal] = useState(false)
  const [executionTime, setExecutionTime] = useState('')
  const [error, setError] = useState('')
  // Whatever the solver wrote to stderr while still exiting 0.
  const [warnings, setWarnings] = useState<string[]>([])
  const [showChartModal, setShowChartModal] = useState(false)
  
  // Helper function to clear results and reset execution state
  const clearResults = () => {
    setResults([])
    setWarnings([])
    setExecutionTime('')
    setError('')
  }
  
  // Handle population scaling toggle
  const handlePopulationScaledToggle = (newValue: boolean) => {
    const updatedStates = populationStates.map(state => {
      const N = parseInt(state.N) || 100
      
      if (newValue && !populationScaled) {
        // Converting from raw to scaled values
        const rawU = parseFloat(state.u) || 0
        const rawV = parseFloat(state.v) || 0
        const rawS = parseFloat(state.s) || 0
        
        return {
          ...state,
          u: rawU === 0 ? '0' : (rawU * 4 * N).toString(),
          v: rawV === 0 ? '0' : (rawV * 4 * N).toString(),
          s: rawS === 0 ? '0' : (rawS * 2 * N).toString()
        }
      } else if (!newValue && populationScaled) {
        // Converting from scaled to raw values
        const scaledU = parseFloat(state.u) || 0
        const scaledV = parseFloat(state.v) || 0
        const scaledS = parseFloat(state.s) || 0
        
        return {
          ...state,
          u: scaledU === 0 ? '0' : (scaledU / (4 * N)).toString(),
          v: scaledV === 0 ? '0' : (scaledV / (4 * N)).toString(),
          s: scaledS === 0 ? '0' : (scaledS / (2 * N)).toString()
        }
      }
      
      return state
    })
    
    setPopulationStates(updatedStates)
    setPopulationScaled(newValue)
  }
  
  const addPopulationState = () => {
    const newId = (Math.max(...populationStates.map(s => parseInt(s.id))) + 1).toString()
    const lastState = populationStates[populationStates.length - 1]
    const newState: PopulationState = {
      ...lastState,
      id: newId,
      name: `State ${newId}`
    }
    
    setPopulationStates([...populationStates, newState])
    
    // Add switching rates to/from the new state
    const newRates: SwitchingRate[] = []
    populationStates.forEach(state => {
      newRates.push({ fromState: state.id, toState: newId, rate: '0.01' })
      newRates.push({ fromState: newId, toState: state.id, rate: '0.01' })
    })
    setSwitchingRates([...switchingRates, ...newRates])
    
    // Resize the starting distribution: existing weights kept, new state zero.
    setStartingProbabilities(
      [...startingProbabilities.split(',').map(x => x.trim()), '0']
        .slice(0, populationStates.length + 1).join(',')
    )
    
    setActiveStateTab((populationStates.length).toString())
  }
  
  const removePopulationState = (id: string) => {
    if (populationStates.length <= 2) return // Need at least 2 states
    
    const newStates = populationStates.filter(s => s.id !== id)
    setPopulationStates(newStates)
    
    // Remove switching rates involving this state
    const newRates = switchingRates.filter(r => r.fromState !== id && r.toState !== id)
    setSwitchingRates(newRates)
    
    // Update active tab if needed
    if (activeStateTab === populationStates.findIndex(s => s.id === id).toString()) {
      setActiveStateTab('0')
    }
    
    // Drop the removed state's weight and renormalise. If that leaves nothing
    // (the user removed the only state carrying mass), fall back to the default
    // rather than sending a zero vector, which the solver rejects.
    const idx = populationStates.findIndex(st => st.id === id)
    const kept = startingProbabilities.split(',')
      .map(x => parseFloat(x.trim()) || 0)
      .filter((_, i) => i !== idx)
    const total = kept.reduce((a, b) => a + b, 0)
    setStartingProbabilities(
      total > 0 ? kept.map(v => String(v / total)).join(',')
                : massInFirstState(newStates.length)
    )
  }
  
  const updatePopulationState = (id: string, field: keyof PopulationState, value: string) => {
    const updatedStates = populationStates.map(state => 
      state.id === id ? { ...state, [field]: value } : state
    )
    setPopulationStates(updatedStates)
  }
  
  const updateSwitchingRate = (fromState: string, toState: string, rate: string) => {
    const updatedRates = switchingRates.map(r => 
      r.fromState === fromState && r.toState === toState 
        ? { ...r, rate } 
        : r
    )
    setSwitchingRates(updatedRates)
  }
  
  const handleExecute = async () => {
    setIsExecuting(true)
    clearResults()
    
    try {
      // Validate parameters
      const errors: string[] = []
      
      // Check population states
      if (populationStates.length < 2) {
        errors.push('At least 2 population states are required')
      }
      
      populationStates.forEach((state, idx) => {
        if (!validatePositiveInteger(state.N)) {
          errors.push(`State ${idx + 1}: Invalid population size`)
        }
        if (!validateScientificNotation(state.s)) {
          errors.push(`State ${idx + 1}: Invalid selection coefficient`)
        }
        if (!validateProbability(state.h)) {
          errors.push(`State ${idx + 1}: Invalid dominance coefficient`)
        }
        if (!validateScientificNotation(state.u)) {
          errors.push(`State ${idx + 1}: Invalid backward mutation rate`)
        }
        if (!validateScientificNotation(state.v)) {
          errors.push(`State ${idx + 1}: Invalid forward mutation rate`)
        }
      })
      
      // Check switching rates
      switchingRates.forEach((rate) => {
        if (!validateProbability(rate.rate)) {
          const fromState = populationStates.find(s => s.id === rate.fromState)
          const toState = populationStates.find(s => s.id === rate.toState)
          errors.push(`Invalid switching rate from ${fromState?.name} to ${toState?.name}`)
        }
      })
      
      // Check other parameters
      if (!validateScientificNotation(alpha)) {
        errors.push('Invalid alpha value')
      }
      
      if (!validateScientificNotation(integrationCutoff)) {
        errors.push('Invalid integration cutoff (c)')
      }
      
      if (errors.length > 0) {
        setError(errors.join('\n'))
        setIsExecuting(false)
        return
      }
      
      // Parse starting probabilities if provided
      let startingProbs: number[] | undefined
      if (startingProbabilities.trim()) {
        try {
          startingProbs = startingProbabilities.split(',').map(p => parseFloat(p.trim()))
          
          // Validate probabilities
          if (startingProbs.length !== populationStates.length) {
            errors.push(`Starting probabilities must have ${populationStates.length} values (comma-separated)`)
          } else {
            const sum = startingProbs.reduce((a, b) => a + b, 0)
            if (Math.abs(sum - 1.0) > 0.001) {
              errors.push('Starting probabilities must sum to 1.0')
            }
            startingProbs.forEach((p, i) => {
              if (p < 0 || p > 1) {
                errors.push(`Starting probability ${i + 1} must be between 0 and 1`)
              }
            })
          }
        } catch (e) {
          errors.push('Invalid starting probabilities format')
        }
      }
      
      // Prepare parameters for backend
      const params = {
        // The chosen initial distribution. Every builder reads params.initial
        // before its own nested fallbacks.
        initial: initialMode === 'file' ? (initialDistFile || undefined) : undefined,
        // Population states
        population_states: populationStates.map(state => ({
          id: state.id,
          N: parseInt(state.N),
          s: populationScaled ? parseFloat(state.s) / (2 * parseInt(state.N)) : parseFloat(state.s),
          h: parseFloat(state.h),
          u: populationScaled ? parseFloat(state.u) / (4 * parseInt(state.N)) : parseFloat(state.u),
          v: populationScaled ? parseFloat(state.v) / (4 * parseInt(state.N)) : parseFloat(state.v)
        })),
        
        // Switching rates matrix
        switching_rates: switchingRates.map(rate => ({
          from_state: parseInt(rate.fromState) - 1, // Convert to 0-based index
          to_state: parseInt(rate.toState) - 1,
          rate: parseFloat(rate.rate)
        })),
        
        // Starting parameters
        starting_probabilities: startingProbs, // Starting probabilities from modal
        integration_cutoff: parseFloat(integrationCutoff),
        
        // Model parameters
        alpha: parseFloat(alpha),
        model_type: modelType,
        
        // Output options
        output_options: outputOptions,
        
        // Execution options
        execution_options: executionOptions
      }
      
      console.log('Executing WFES Switching with params:', params)
      
      // Execute via backend service
      const result = await wfesService.executeSwitching(params)
      
      console.log('WFES Switching result:', result)
      
      if (result.success && result.results) {
        // Process results
        const resultItems: WfesResultItem[] = []
        
        console.log('Processing results:', result.results)
        
        if (result.results) {
          // Format numbers based on magnitude
          const formatNumber = (value: number, isTime: boolean = false) => {
            if (isTime) {
              // For time values, use fixed notation
              if (value < 10) return value.toFixed(4)
              if (value < 100) return value.toFixed(3)
              if (value < 1000) return value.toFixed(2)
              if (value < 10000) return value.toFixed(1)
              return value.toFixed(0)
            } else {
              // For probabilities and rates
              if (Math.abs(value) < 1e-10) return '0'
              if (Math.abs(value) < 1e-3 || Math.abs(value) > 1e4) {
                return value.toExponential(4)
              }
              return value.toPrecision(6)
            }
          }
          
          // Extract probability results.
          //
          // Semantics (from wfes_switching_main.cpp): under --absorption EVERY
          // model state has both boundaries absorbing, so absorption can occur
          // in any state, and the headline P/T are aggregated over the state
          // absorption happens in and averaged over the start distribution.
          // The CLI also emits the per-state decompositions (P_cond_*,
          // T_uncond, T_cond_*), which were previously dropped here.
          if (result.results.P_ext !== undefined) {
            resultItems.push(qtyRow('P_ext', result.results.P_ext, {
              description: 'Extinction in any model state, averaged over the starting distribution'
            }))
          }
          if (result.results.P_fix !== undefined) {
            resultItems.push(qtyRow('P_fix', result.results.P_fix, {
              description: 'Fixation in any model state, averaged over the starting distribution'
            }))
          }
          
          // Extract time results
          if (result.results.T_ext !== undefined) {
            resultItems.push(qtyRow('T_ext', result.results.T_ext, {
              description: 'Expected time to absorption given extinction, in any state'
            }))
          }
          if (result.results.T_fix !== undefined) {
            resultItems.push(qtyRow('T_fix', result.results.T_fix, {
              description: 'Expected time to absorption given fixation, in any state'
            }))
          }

          // Per-state decompositions: one COLUMN per state rather than a long
          // flat list of rows (which made the results panel a single
          // disorganised column). Row sums reproduce the headline values:
          // Σ_k P(ext in state k) = P(extinction); Σ_k E[time in k | ext] = E[T | ext].
          const decompRows: { label: React.ReactNode; plain: string; description: string; values: string[]; raw: number[]; kind: 'probability' | 'time' }[] = []
          const addDecompRow = (arr: unknown, key: QuantityKey, time = false) => {
            if (Array.isArray(arr) && arr.length > 0) {
              const q = QUANTITIES[key]
              decompRows.push({
                label: q.node, plain: q.plain, description: q.description,
                raw: [], kind: 'probability',
                values: arr.map(x =>
                  typeof x === 'number' && isFinite(x) ? formatNumber(x, time) : '—'),
                raw: arr.map(x => (typeof x === 'number' && isFinite(x) ? x : NaN)),
                kind: time ? 'time' : 'probability'
              })
            }
          }
          addDecompRow(result.results.P_cond_ext, 'P_ext_k')
          addDecompRow(result.results.P_cond_fix, 'P_fix_k')
          // The per-state absorption total. This was previously shown as a set
          // of headline rows labelled "Time in <state>" with a percentage --
          // but the underlying array (built in wfesBackendService as
          // P_cond_ext + P_cond_fix) is where absorption ENDED, not time spent.
          // It belongs in the per-state columns, described for what it is.
          if (Array.isArray(result.results.P_cond_ext) && Array.isArray(result.results.P_cond_fix)) {
            const q = QUANTITIES.P_k
            const totals = result.results.P_cond_ext.map(
              (x: number, k: number) => (x || 0) + (result.results.P_cond_fix[k] || 0))
            decompRows.push({
              label: q.node, plain: q.plain, description: q.description,
              values: totals.map((t: number) => (isFinite(t) ? formatNumber(t) : '—')),
              raw: totals,
              kind: 'probability'
            })
          }
          // Derived conditionals: the rows above are JOINT probabilities
          // P(outcome ∧ end state k). Dividing by the headline outcome
          // probability gives "given the outcome, where did it happen?".
          // Guarded on the denominator: if P_ext is ~0 (or P_fix is), the
          // conditional is undefined and the row is simply omitted.
          const addDerivedRow = (arr: unknown, total: unknown, key: QuantityKey) => {
            if (Array.isArray(arr) && typeof total === 'number' && isFinite(total) && total > 0) {
              const q = QUANTITIES[key]
              decompRows.push({
                label: q.node, plain: q.plain, description: q.description,
                values: arr.map(x => {
                  if (typeof x !== 'number' || !isFinite(x)) return '—'
                  const pct = (100 * x) / total
                  return pct > 0 && pct < 0.01 ? '<0.01%' : `${pct.toFixed(2)}%`
                })
              })
            }
          }
          addDerivedRow(result.results.P_cond_ext, result.results.P_ext, 'P_k_ext')
          addDerivedRow(result.results.P_cond_fix, result.results.P_fix, 'P_k_fix')
          addDecompRow(result.results.T_uncond, 'T_k', true)
          addDecompRow(result.results.T_cond_ext, 'T_k_ext', true)
          addDecompRow(result.results.T_cond_fix, 'T_k_fix', true)
          setDecomp(decompRows)
          if (result.results.T_abs !== undefined) {
            resultItems.push(qtyRow('T_abs', result.results.T_abs, {
              description: 'Derived as P_ext·T_ext + P_fix·T_fix; the solver does not report it'
            }))
          }
          
          // For fixation model, add rate if available
          if (result.results.rate !== undefined) {
            resultItems.push(qtyRow('R_sub', result.results.rate))
          }
          
          // Execution time is reported under the table, not as a row in it:
          // the results table holds model quantities only.
        }
        
        setWarnings(result.warnings || [])
        if (resultItems.length === 0) {
          console.warn('No results extracted from response')
          setError('No results were returned from the computation')
        } else {
          setResults(resultItems)
          setExecutionTime(result.executionTime || '0s')
        }
        
      } else {
        const errorMsg = result.error || 'Execution failed - no results returned'
        console.error('Execution failed:', errorMsg)
        setError(errorMsg)
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
    // Exports the per-state decomposition -- the data this tool actually
    // produces. The previous version read `stateData`, a state that was
    // declared, never assigned, and shaped like a per-generation timeline
    // (Time, State1_Prob, ...) that no WFES tool emits. It could only ever
    // return early, so this button has never written a file.
    if (decomp.length === 0) return

    const delimiter = format === 'tsv' ? '\t' : ','
    const columns = populationStates.map((st, k) => st.name || `State ${k + 1}`)
    const rows = [
      ['Quantity', ...columns],
      ...decomp.map(r => [r.plain, ...r.values])
    ]

    const content = rows.map(row => row.join(delimiter)).join('\n')
    // Through the main process: an <a download> is silently dropped here.
    void saveTextFile(content, generateFilename('wfes_switching', format))
  }
  
  const copyToClipboard = () => {
    // Copies EVERYTHING on screen: headline stats plus the per-state
    // breakdown, tab-separated so it pastes into a spreadsheet as a grid.
    // The old handler serialized only the headline list.
    navigator.clipboard.writeText(formatResultsCopy(
      'WFES Switching results',
      results,
      [{
        title: 'Per-state breakdown',
        columns: populationStates.map((st, k) => st.name || `State ${k + 1}`),
        rows: decomp.map(r => ({ plain: r.plain, values: r.values })),
        notes: ['In the probability rows the state is where absorption ended; in the time rows it is where time was spent en route, conditional on the outcome.']
      }]
    ))
  }
  
  // Build command line string
  const buildCommandLine = () => {
    const parts = ['wfes_switching']
    
    // Model type
    parts.push(`--${modelType}`)
    
    // Build comma-separated lists for population parameters
    const N_values = populationStates.map(s => s.N).join(',')
    const s_values = populationStates.map(s => {
      const N = parseInt(s.N) || 100
      return populationScaled ? (parseFloat(s.s) / (2 * N)).toString() : s.s
    }).join(',')
    const h_values = populationStates.map(s => s.h).join(',')
    const u_values = populationStates.map(s => {
      const N = parseInt(s.N) || 100
      return populationScaled ? (parseFloat(s.u) / (4 * N)).toString() : s.u
    }).join(',')
    const v_values = populationStates.map(s => {
      const N = parseInt(s.N) || 100
      return populationScaled ? (parseFloat(s.v) / (4 * N)).toString() : s.v
    }).join(',')
    
    parts.push(`--pop-sizes ${N_values}`)
    parts.push(`--selection ${s_values}`)
    parts.push(`--dominance ${h_values}`)
    parts.push(`--backward-mu ${u_values}`)
    parts.push(`--forward-mu ${v_values}`)
    
    // Switching rates matrix - build matrix string
    const n_states = populationStates.length
    const matrix: number[][] = Array(n_states).fill(null).map(() => Array(n_states).fill(0))
    
    // Fill in the off-diagonal rates
    switchingRates.forEach(rate => {
      const fromIdx = parseInt(rate.fromState) - 1
      const toIdx = parseInt(rate.toState) - 1
      matrix[fromIdx][toIdx] = parseFloat(rate.rate) || 0
    })
    
    // Calculate and set diagonal elements (probability of staying in same state)
    for (let i = 0; i < n_states; i++) {
      let rowSum = 0
      for (let j = 0; j < n_states; j++) {
        if (i !== j) {
          rowSum += matrix[i][j]
        }
      }
      matrix[i][i] = Math.max(0, 1 - rowSum)
    }
    
    // Convert to string format: "row1col1,row1col2;row2col1,row2col2"
    const matrixStr = matrix.map(row => row.join(',')).join(';')
    parts.push(`--switching "${matrixStr}"`)
    
    // Starting probabilities. When the field is empty the run omits the flag
    // and the CLI applies its uniform default -- so the preview omits it too.
    // The previous fallback printed "--starting-prob 1,0" here, a flag the run
    // never sent: anyone copying the preview to reproduce a GUI result got a
    // DIFFERENT model (all mass in state 1 instead of uniform).
    if (startingProbabilities.trim()) {
      parts.push(`--starting-prob ${startingProbabilities}`)
    }
    
    // Integration cutoff
    parts.push(`--integration-cutoff ${integrationCutoff}`)
    
    // Alpha
    parts.push(`--alpha ${alpha}`)
    
    // Output options
    // Output flags mirror the run's builder: real keys, with the destination
    // paths the run resolves. The old writePExt/writePFix keys existed nowhere.
    const dir = (outputOptions as any).outputDirectory || '~/Downloads'
    if ((outputOptions as any).writeQ) parts.push(`--output-Q ${dir}/wfes_switching_Q.mtx`)
    if ((outputOptions as any).writeR) parts.push(`--output-R ${dir}/wfes_switching_R.csv`)
    if ((outputOptions as any).writeN) parts.push(`--output-N ${dir}/wfes_switching_N.csv`)
    if ((outputOptions as any).writeB) parts.push(`--output-B ${dir}/wfes_switching_B.csv`)
    if ((outputOptions as any).writeNExt) parts.push(`--output-N-ext ${dir}/wfes_switching_N_ext.csv`)
    if ((outputOptions as any).writeNFix) parts.push(`--output-N-fix ${dir}/wfes_switching_N_fix.csv`)
    
    // Add JSON output flag
    if (initialMode === 'file' && initialDistFile) parts.push(`--initial ${initialDistFile}`)
    parts.push('--json')
    
    // Execution options
    if (executionOptions.force) parts.push('--force')
    parts.push(`--num-threads ${executionOptions.threads}`)
    
    // The run passes the library name through as-is; 'mkl'/'viennacl' were fictions.
    parts.push(`--library ${executionOptions.library}`)
    
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

  // Live state diagram of the model as configured. Uses the SAME index
  // mapping as the params builder (parseInt(id) - 1), so the diagram shows
  // exactly what the run will use.
  const diagramModel = useMemo(() => {
    // Start distribution: null when the field is empty, which the diagram
    // labels as the CLI's uniform default -- matching what the run actually
    // does (the builder omits --starting-prob entirely).
    let startProbs: number[] | null = null
    if (startingProbabilities.trim()) {
      const parsed = startingProbabilities.split(',').map(x => parseFloat(x.trim()))
      if (parsed.length === populationStates.length && parsed.every(Number.isFinite)) {
        startProbs = parsed
      }
    }
    return generalSwitchingDiagram(
      populationStates,
      switchingRates.map(r => ({
        from: parseInt(r.fromState) - 1,
        to: parseInt(r.toState) - 1,
        p: parseFloat(r.rate)
      })),
      populationScaled,
      startProbs
    )
  }, [populationStates, switchingRates, populationScaled, startingProbabilities])

  return (
    <WfesViewLayout
      title="General Switching Model"
      onBack={onBack}
      hideBackButton={hideBackButton}
      outputOptions={outputOptions}
      onOutputOptionsChange={setOutputOptions}
      executionOptions={executionOptions}
      onExecutionOptionsChange={setExecutionOptions}
      activeOptionsCount={activeOutputOptions}
    >
      {/* Technical Details */}
      <AboutContentPanel modelName="wfes_switching" />
      
      <Grid>
        {/* Column 1: Mode */}
        <Grid.Col span={4}>
          <Paper p="md" withBorder style={{ height: '400px' }}>
            <Title order={6} mb="sm">Mode</Title>
            <Box style={{ width: '100%' }}>
              <SegmentedControl
                value={modelType}
                onChange={setModelType}
                data={[
                  { value: 'absorption', label: 'Standard Wright-Fisher' },
                  { value: 'fixation', label: 'Substitution Model' }
                ]}
                orientation="vertical"
                fullWidth
                color="blue"
                size="md"
              />
            </Box>
            <Text size="xs" c="dimmed" mt="xs" style={{ minHeight: '40px' }}>
              {modelType === 'absorption' 
                ? 'Extinction and fixation are both absorbing'
                : 'Fixation only is absorbing, giving substitution-rate properties'
              }
            </Text>
          </Paper>
        </Grid.Col>

        {/* Column 2: Results */}
        <Grid.Col span={8}>
          <Paper p="md" withBorder style={{ height: '400px', display: 'flex', flexDirection: 'column' }}>
            <Group justify="space-between" mb="md" style={{ flexShrink: 0 }}>
              <Title order={6}>Results</Title>
              {results.length > 0 && (
                <Group gap="xs">
                  {decomp.length > 0 && (
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

            <Box style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
              {error && (
                <Alert color="red" mb="md">
                  {error}
                </Alert>
              )}
              
              {results.length > 0 ? (
              <Stack gap="sm" style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
                <Box style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
                  {/* Headline statistics side by side; the per-state
                      decomposition gets its own table below, one column per
                      state, instead of stretching everything into one long
                      column. */}
                  <WfesResultsTable data={results} columns={2} />
                  {decomp.length > 0 && (
                    <>
                      <Divider my="sm" label="Per-state breakdown" labelPosition="center" />
                      {/* Mantine v8 applies striping, borders and padding via its
                          Table.* sub-components; raw thead/td children rendered
                          with browser defaults (see the sequential view). */}
                      <Table size="sm" striped withColumnBorders>
                        <Table.Thead>
                          <Table.Tr>
                            <Table.Th style={{ textAlign: 'left' }}>Quantity</Table.Th>
                            {populationStates.map((st, k) => (
                              <Table.Th key={k} style={{ textAlign: 'right' }}>{st.name || `State ${k + 1}`}</Table.Th>
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
                        Note: the state column means two different things. In the
                        probability rows it is where absorption <em>ended</em>; in the
                        time rows it is where time was <em>spent</em> en route —
                        conditional on the outcome, wherever it ended.
                      </Text>
                    </>
                  )}
                </Box>
                
                <Divider />
                
                <Stack gap="xs">
                  <Text size="xs" c="dimmed">Execution time: {executionTime}</Text>
                  
                  <Group gap="sm">
                    {!isExecuting && (
                      <Button 
                        leftSection={<IconPlayerPlay size={16} />}
                        size="sm"
                        onClick={handleExecute}
                      >
                        Re-execute
                      </Button>
                    )}
                    {decomp.length > 0 && (
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
                    )}
                  </Group>
                </Stack>
              </Stack>
            ) : (
              <Stack align="center" justify="center" style={{ height: '300px' }}>
                {isExecuting ? (
                  <>
                    <Loader size="lg" />
                    <Text size="sm" c="dimmed">Running the switching model...</Text>
                  </>
                ) : (
                  <>
                    <Text size="sm" c="dimmed">
                      No results yet. Configure states and click Execute.
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
            </Box>
          </Paper>
        </Grid.Col>
      </Grid>

      {/* Population States and Additional Parameters below */}
      <Grid mt="md">
        <Grid.Col span={12}>
          <Stack>
            {/* Population States */}
            <Paper p="md" withBorder>
              <Group justify="space-between" mb="sm">
                <Title order={6}>Population States</Title>
                <Group gap="xs">
                  <Switch 
                    label="Population Scaled" 
                    checked={populationScaled}
                    onChange={(e) => handlePopulationScaledToggle(e.currentTarget.checked)}
                  />
                  <Button 
                    variant="light" 
                    size="sm"
                    leftSection={<IconClock size={16} />}
                    onClick={() => setShowSwitchingRatesModal(true)}
                  >
                    Configure Rates
                  </Button>
                </Group>
              </Group>
              
              <Tabs value={activeStateTab} onChange={setActiveStateTab}>
                <Tabs.List>
                  {populationStates.map((state, index) => (
                    <Tabs.Tab 
                      key={state.id} 
                      value={index.toString()}
                      rightSection={
                        populationStates.length > 2 && (
                          <ActionIcon 
                            size="xs" 
                            onClick={(e) => {
                              e.stopPropagation()
                              removePopulationState(state.id)
                            }}
                          >
                            <IconX size={14} />
                          </ActionIcon>
                        )
                      }
                    >
                      {state.name}
                    </Tabs.Tab>
                  ))}
                  <ActionIcon 
                    variant="light" 
                    size="sm" 
                    onClick={addPopulationState}
                    style={{ marginLeft: 8 }}
                  >
                    <IconPlus size={16} />
                  </ActionIcon>
                </Tabs.List>
                
                {populationStates.map((state, index) => (
                  <Tabs.Panel key={state.id} value={index.toString()} pt="md">
                    <Stack gap="sm">
                      <WfesParameterInput
                        type="text"
                        label="State Name"
                        value={state.name}
                        onChange={(value) => updatePopulationState(state.id, 'name', value)}
                      />
                      <WfesParameterInput
                        type="text"
                        label="N"
                        description="Population size"
                        value={state.N}
                        onChange={(value) => updatePopulationState(state.id, 'N', value)}
                        error={!validatePositiveInteger(state.N)}
                      />
                      <Group grow>
                        <WfesParameterInput
                          type="text"
                          label={populationScaled ? "2Ns" : "s"}
                          description="Selection coefficient"
                          value={state.s}
                          onChange={(value) => updatePopulationState(state.id, 's', value)}
                          error={!validateScientificNotation(state.s)}
                        />
                        <WfesParameterInput
                          type="text"
                          label="h"
                          description="Dominance coefficient"
                          value={state.h}
                          onChange={(value) => updatePopulationState(state.id, 'h', value)}
                          error={!validateProbability(state.h)}
                        />
                      </Group>
                      <Group grow>
                        <WfesParameterInput
                          type="scientific"
                          label={populationScaled ? "4Nu" : "u"}
                          description="Backward mutation rate"
                          value={state.u}
                          onChange={(value) => updatePopulationState(state.id, 'u', value)}
                          error={!validateScientificNotation(state.u)}
                        />
                        <WfesParameterInput
                          type="scientific"
                          label={populationScaled ? "4Nv" : "v"}
                          description="Forward mutation rate"
                          value={state.v}
                          onChange={(value) => updatePopulationState(state.id, 'v', value)}
                          error={!validateScientificNotation(state.v)}
                        />
                      </Group>
                    </Stack>
                  </Tabs.Panel>
                ))}
              </Tabs>
            </Paper>
            
            {/* Additional Parameters */}
            <Paper p="md" withBorder>
              <Title order={6} mb="sm">Additional Parameters</Title>
              <Stack gap="sm">
                <Alert color="blue" mb="sm">
                  <Text size="sm">
                    By default the starting allele count is integrated over the
                    distribution a new mutation produces, within each starting
                    model state (weighted by the start-state probabilities
                    above). Supplying a custom initial distribution below
                    replaces that default entirely: it specifies the joint
                    distribution over model states and allele counts.
                  </Text>
                </Alert>
                <WfesParameterInput
                  type="scientific"
                  label="c"
                  description="Integration cutoff"
                  helpText="Minimum probability threshold for including starting copy numbers in the integration. Lower values include more terms but increase computation time."
                  value={integrationCutoff}
                  onChange={setIntegrationCutoff}
                  error={!validateScientificNotation(integrationCutoff)}
                />
                <WfesParameterInput
                  type="scientific"
                  label="α"
                  description="Transition probability cutoff"
                  helpText="Probability mass trimmed from the tails of each matrix row (α/2 per tail), which the row is renormalised after"
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

          modes={['integrate', 'file']}

          value={initialMode}

          onChange={(m) => { setInitialMode(m); if (m !== 'file') setInitialDistFile('') }}

          file={initialDistFile}

          onFileChange={setInitialDistFile}

          expectedLength={populationStates.reduce((a, st) => a + (2 * (parseInt(st.N) || 0) - (modelType === 'fixation' ? 0 : 1)), 0) || null}
                    blocks={populationStates.map((st, k) => ({
                      label: `${st.name || `State ${k + 1}`} (N=${st.N}, counts ${modelType === 'fixation' ? '0' : '1'}..${2 * (parseInt(st.N) || 0) - 1})`,
                      length: 2 * (parseInt(st.N) || 0) - (modelType === 'fixation' ? 0 : 1)
                    }))}

          stateSpace={modelType === 'fixation' ? "the concatenated states of all model states" : "the concatenated transient states of all model states"}

        />

      </Paper>


      {/* Command Line Preview - Full width */}
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
      
      {/* Switching Rates Matrix Modal */}
      <Modal
        opened={showSwitchingRatesModal}
        onClose={() => setShowSwitchingRatesModal(false)}
        size="90%"
        title="Configure Switching Rates"
      >
        <SwitchingRatesMatrix
          states={populationStates}
          rates={switchingRates}
          onRateChange={updateSwitchingRate}
          onAddState={addPopulationState}
          onRemoveState={removePopulationState}
          onUpdateStateName={updatePopulationState}
          startingProbabilities={startingProbabilities ? startingProbabilities.split(',') : undefined}
          onStartingProbabilitiesChange={(probs) => setStartingProbabilities(probs.join(','))}
          disabled={isExecuting}
        />
      </Modal>
      
      {/* Chart Modal.
          Not a timeline: wfes_switching reports scalars and per-state
          decompositions, and no tool in the suite emits a trajectory through
          time, so the "State Probability Timeline" this replaces could only
          ever have been invented. This charts the decomposition the solver
          does report. */}
      <DecompositionChartModal
        opened={showChartModal}
        onClose={() => setShowChartModal(false)}
        categories={populationStates.map((st, k) => st.name || `State ${k + 1}`)}
        series={decomp
          .filter(r => (r.raw?.length ?? 0) > 0)
          .map(r => ({ name: r.plain, values: r.raw, kind: r.kind }))}
        title="Per-state decomposition"
        filename="wfes_switching_decomposition"
        categoryLabel="Model state"
      />
      
    </WfesViewLayout>
  )
}

export default WfesSwitchingViewMantine