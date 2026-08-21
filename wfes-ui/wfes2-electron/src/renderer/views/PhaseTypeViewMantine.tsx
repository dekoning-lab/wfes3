import React, { useState, useEffect, useMemo } from 'react'
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
  Select,
  Box,
  Checkbox,
  Tooltip,
  ActionIcon,
  useMantineTheme,
  Tabs
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
import { WfesOutputOptions, WfesResultItem } from '../types/wfes'
import { qtyRow, sdRow } from '../utils/quantityLabels'
import { wfesService } from '../services/wfesService'
import TimeToSubstitutionChartModal from '../components/TimeToSubstitutionChartModal'
import { Math as MathTeX, SolverWarnings } from '../components/shared'
import AboutContentPanel from '../components/AboutContentPanel'
import SwitchingStateDiagram from '../components/shared/SwitchingStateDiagram'
import { sweepDiagram } from '../utils/switchingDiagrams'
import { useExecuteShortcut } from '../hooks/useExecuteShortcut'

interface PhaseTypeViewProps {
  onBack: () => void
  hideBackButton?: boolean
  /**
   * Which of this view's tools to open on. The Substitution Model in
   * wfes_single links here for the moments and for the full distribution, and
   * a link that lands on the wrong one asks the user to find the toggle
   * themselves. App remounts the view on change, so this is a mount-time seed,
   * not a controlled value.
   */
  initialMomentsOnly?: boolean
}

type ModeType = 'phase-type-dist' | 'phase-type-dist-sgv'

interface Component {
  u: string
  v: string
  s: string
}

/**
 * The captured probability mass, as a percentage a reader can act on.
 *
 * A plain toFixed(2) printed a run that captured 2.4767e-05 of the mass as
 * "0.00%", which reads as a rounding artefact rather than as the shortfall of
 * several orders of magnitude that it is.
 */
const formatCapturedMass = (fraction: number): string => {
  const pct = 100 * fraction
  if (!Number.isFinite(pct)) return '—'
  if (pct === 0) return '0%'
  return pct >= 0.01 ? `${pct.toFixed(2)}%` : `${pct.toExponential(2)}%`
}

const PhaseTypeViewMantine: React.FC<PhaseTypeViewProps> = ({ onBack, hideBackButton = false, initialMomentsOnly = false }) => {
  const theme = useMantineTheme()
  // How the starting state is specified. This tool offers 2 of the three.
  const [initialMode, setInitialMode] = useState<InitialMode>('integrate')
  const [initialDistFile, setInitialDistFile] = useState('')
  const [mode, setMode] = useState<ModeType>('phase-type-dist')
  const [momentsOnly, setMomentsOnly] = useState(initialMomentsOnly)
  // Set when the solver stopped on --max-t instead of converging. The moments
  // below are then computed over a truncated window and are underestimates --
  // measured at N=100, s=0 with the defaults: 311,065 against an exact 400,793
  // from phase_type_moments, 22% low, previously shown without qualification.
  const [truncation, setTruncation] = useState<{ captured: number; steps: number; cutoff: number } | null>(null)
  const [populationScaled, setPopulationScaled] = useState(true)
  const [activeTab, setActiveTab] = useState(0)
  const [components, setComponents] = useState<Component[]>([
    { u: '0.001', v: '0.001', s: '0' },  // Equilibration model
    { u: '0.001', v: '0.001', s: '10' }  // Absorbing model with 2Ns = 10
  ])
  
  // Population parameters
  const [populationSize, setPopulationSize] = useState('100')
  const [a, setA] = useState('1e-20') // Probability cutoff (alpha)
  const [c, setC] = useState('0.999') // Integration cutoff (Dist mode only)
  const [m, setM] = useState('1000000') // Max generations (Dist mode only)
  const [k, setK] = useState('20') // Number of moments (Moments mode only)
  const [oneOverLambda, setOneOverLambda] = useState('1000') // 1/lambda for SGV mode

  /**
   * The SGV mode runs time_dist_sgv, which is a two-regime switching model:
   * variation accumulates under the first regime, a geometric wait of mean
   * 1/lambda passes, and the second regime is terminal. That is the same
   * structure wfes_sweep builds, so it gets the same diagram rather than a
   * second drawing of the same model. Dominance is 0.5 in both regimes because
   * this view sends --dominance 0.5,0.5; the diagram shows what is run.
   */
  const sgvDiagram = useMemo(() => sweepDiagram({
    N: populationSize,
    lambda: String(1 / (parseFloat(oneOverLambda) || 1000)),
    comp1: { s: components[0]?.s ?? '0', h: '0.5',
             u: components[0]?.u ?? '0', v: components[0]?.v ?? '0' },
    comp2: { s: components[1]?.s ?? '0', h: '0.5',
             u: components[1]?.u ?? '0', v: components[1]?.v ?? '0' },
    scaled: populationScaled
  }), [populationSize, oneOverLambda, components, populationScaled])
  
  // Mutation parameters
  const [u, setU] = useState('0.001')
  const [v, setV] = useState('0.001')
  // Recurrent mutation, moments mode. phase_type_moments declares
  // -m/--no-recurrent-mu, so this is a live choice: unticking it excludes
  // recurrent mutation from the model. The checkbox used to be hardcoded
  // true and disabled -- and the value it sent travelled under a key nothing
  // read, so even the wiring behind the frozen control was dead.
  const [r, setR] = useState(true)
  
  // Selection parameters
  const [s, setS] = useState('0')
  const [h, setH] = useState('0.5')
  
  // Output options - mode specific.
  //
  // Every key here names a real flag on the binary the current mode runs:
  // writeQ/writeR exist on all three tools, writeP (--output-P) on
  // phase_type_dist and time_dist_sgv, and writeN (--output-N, "Output
  // moments to file") on phase_type_moments only. The writeMoments/writeRes
  // keys that used to sit here matched no CLI flag and no builder key -- and
  // writeMoments defaulted true, so the options badge read "1" on a fresh
  // view for an output that was never written.
  //
  // writeP defaults off: defaulting it on would drop a CSV in the user's
  // output folder on every run without them asking for one.
  const [outputOptions, setOutputOptions] = useState<WfesOutputOptions & { writeP?: boolean }>({
    writeQ: false,
    writeR: false,
    writeP: false, // Distribution file (dist and SGV modes only)
    writeN: false  // Moments file (moments mode only)
  })

  // Execution options. No `solver`: no WFES binary declares --solver, and
  // ViennaCL is no longer offered in the library Select.
  const [executionOptions, setExecutionOptions] = useState({
    force: false,
    threads: navigator.hardwareConcurrency || 4,
    library: 'Accelerate' as 'Accelerate' | 'Pardiso' | 'SuiteSparse' | 'ParU'
  })
  
  // Results state
  const [results, setResults] = useState<WfesResultItem[]>([])
  const [distribution, setDistribution] = useState<any[]>([])
  const [moments, setMoments] = useState<string[]>([])
  const [isExecuting, setIsExecuting] = useState(false)
  const [executionTime, setExecutionTime] = useState('')
  const [error, setError] = useState('')
  const [showChartModal, setShowChartModal] = useState(false)
  // Whatever the solver wrote to stderr while still exiting 0.
  const [warnings, setWarnings] = useState<string[]>([])

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
    setMoments([])
    setWarnings([])
    setExecutionTime('')
    setError('')
  }
  
  // Helper function to update component values
  const updateComponent = (index: number, field: keyof Component, value: string) => {
    const updatedComponents = [...components]
    updatedComponents[index] = { ...updatedComponents[index], [field]: value }
    setComponents(updatedComponents)
  }

  // Handle mode change
  useEffect(() => {
    clearResults()
  }, [mode])
  
  // Handle population scaling toggle
  const handlePopulationScaledToggle = (newValue: boolean) => {
    const N = parseInt(populationSize) || 100
    
    if (newValue && !populationScaled) {
      // Converting from raw to scaled values
      if (mode === 'phase-type-dist-sgv') {
        // Update components
        const updatedComponents = components.map(comp => {
          const rawU = parseFloat(comp.u) || 0
          const rawV = parseFloat(comp.v) || 0
          const rawS = parseFloat(comp.s) || 0
          
          return {
            u: rawU === 0 ? '0' : (rawU * 4 * N).toString(),
            v: rawV === 0 ? '0' : (rawV * 4 * N).toString(),
            s: rawS === 0 ? '0' : (rawS * 2 * N).toString()
          }
        })
        setComponents(updatedComponents)
      } else {
        // Update single values
        const rawU = parseFloat(u) || 0
        const rawV = parseFloat(v) || 0
        const rawS = parseFloat(s) || 0
        
        setU(rawU === 0 ? '0' : (rawU * 4 * N).toString())
        setV(rawV === 0 ? '0' : (rawV * 4 * N).toString())
        setS(rawS === 0 ? '0' : (rawS * 2 * N).toString())
      }
    } else if (!newValue && populationScaled) {
      // Converting from scaled to raw values
      if (mode === 'phase-type-dist-sgv') {
        // Update components
        const updatedComponents = components.map(comp => {
          const scaledU = parseFloat(comp.u) || 0
          const scaledV = parseFloat(comp.v) || 0
          const scaledS = parseFloat(comp.s) || 0
          
          return {
            u: scaledU === 0 ? '0' : (scaledU / (4 * N)).toString(),
            v: scaledV === 0 ? '0' : (scaledV / (4 * N)).toString(),
            s: scaledS === 0 ? '0' : (scaledS / (2 * N)).toString()
          }
        })
        setComponents(updatedComponents)
      } else {
        // Update single values
        const scaledU = parseFloat(u) || 0
        const scaledV = parseFloat(v) || 0
        const scaledS = parseFloat(s) || 0
        
        setU(scaledU === 0 ? '0' : (scaledU / (4 * N)).toString())
        setV(scaledV === 0 ? '0' : (scaledV / (4 * N)).toString())
        setS(scaledS === 0 ? '0' : (scaledS / (2 * N)).toString())
      }
    }
    
    setPopulationScaled(newValue)
  }
  
  const handleExecute = async () => {
    setIsExecuting(true)
    clearResults()

    try {
      // Convert parameters based on population scaling
      const N = parseInt(populationSize)
      let result: any
      
      if (mode === 'phase-type-dist-sgv') {
        // SGV mode uses time_dist_sgv with 2 components.
        // Exact string conversion -- no toExponential(5). Rounding to six
        // significant figures here was the value that actually shipped to
        // the CLI, silently perturbing any parameter with more precision.
        const scaledComponents = components.map(comp => ({
          u: populationScaled ?
            (parseFloat(comp.u) / (4 * N)).toString() :
            comp.u,
          v: populationScaled ?
            (parseFloat(comp.v) / (4 * N)).toString() :
            comp.v,
          s: populationScaled ?
            (parseFloat(comp.s) / (2 * N)).toString() :
            comp.s
        }))
        
        const sgvParams = {
        
          // SGV routes to time_dist_sgv, a different binary with a different
        
          // state space; it needs the file passed on its own path.
        
          initial: initialMode === 'file' ? (initialDistFile || undefined) : undefined,
          mode: 'time-dist-sgv',
          components: scaledComponents.map((comp, index) => ({
            N: populationSize,
            s: comp.s,
            h: '0.5',
            u: comp.u,
            v: comp.v
          })),
          populationParams: {
            a: a,
            l: (1 / parseFloat(oneOverLambda)).toString(),
            c: c,
            m: m,
            p: populationSize
          },
          // Pass execution parameters at top level for backend compatibility
          n_threads: parseInt(executionOptions.threads),
          library: executionOptions.library,
          // time_dist_sgv declares --force (unlike phase_type_dist), so the
          // drawer's Force checkbox is live in this mode and forwarded here.
          force: executionOptions.force,
          // Write flags -- time_dist_sgv declares --output-Q/-R/-P, so the
          // same checkboxes work in this mode; buildTimeDistArgs names the
          // files time_dist_sgv_*.
          outputOptions: {
            writeQ: outputOptions.writeQ,
            writeR: outputOptions.writeR,
            writeP: outputOptions.writeP,
            outputDirectory: outputOptions.outputDirectory
          }
        }
        
        result = await wfesService.executeTimeDist(sgvParams)
        
        // Process results similar to phase-type-dist
        if (result.distribution && result.distribution.length > 0) {
          const stats = calculateStats(result.distribution)
          // snake_case, because that is what every time-dist tool emits and
          // what parseTimeDistOutput now normalises time_dist_sgv's top-level
          // keys onto. This used to test camelCase names that no time-dist
          // parser produces, so `short` was always false and a run capturing
          // 2.5e-05 of the mass was labelled a converged expected time.
          const st = result.statistics || {}
          const short = st.reached_cutoff === false
          const resultItems: WfesResultItem[] = [
            qtyRow('T_sub', stats.mean, {
              description: short
                ? 'LOWER BOUND: mean over the computed window only, which stopped early (see the warning above)'
                : 'Expected time to substitution under the computed phase-type distribution'
            }),
            sdRow('T_sub', stats.std, short
              ? { description: 'LOWER BOUND: dispersion of the truncated window only' }
              : undefined),
            qtyRow('P_total', stats.totalProb),
            qtyRow('F_max', stats.maxCDF)
          ]
          // The solver's own account of the mass it captured is preferred over
          // our sum over the window; they agree, but the banner should quote
          // the number the tool reported.
          setTruncation(short ? {
            captured: st.final_cdf ?? stats.totalProb,
            steps: st.time_steps_computed ?? 0,
            cutoff: st.distribution_cutoff ?? 0
          } : null)
          setResults(resultItems)
          // The full distribution: the chart thins for display, and the export
          // and the statistics above must see every point.
          setDistribution(result.distribution)
        }
        setWarnings(result.warnings || [])
        setExecutionTime(result.executionTime || '')
      } else {
        // Non-SGV modes (phase-type-dist with or without moments)
        const scaledParams = {
          initial: initialMode === 'file' ? (initialDistFile || undefined) : undefined,
          mode: momentsOnly ? 'moments' : 'dist',
          populationParams: {
            N: populationSize,
            a,
            // Only include mode-specific parameters
            ...(!momentsOnly ? { c, m } : {}),
            ...(momentsOnly ? { k } : {})
          },
          mutationParams: {
            // Exact string conversion -- no toExponential(5); see the SGV
            // branch above for why rounding here corrupted what was run.
            u: populationScaled ?
              (parseFloat(u) / (4 * N)).toString() :
              u,
            v: populationScaled ?
              (parseFloat(v) / (4 * N)).toString() :
              v,
            ...(momentsOnly ? { r } : {})
          },
          selectionParams: {
            s: populationScaled ?
              (parseFloat(s) / (2 * N)).toString() :
              s,
            h
          },
          // The write* keys the builder reads, outputDirectory included.
          // Passed whole: rebuilding this object under different key names
          // (Q/R/P/Res) is what disconnected these checkboxes before.
          // buildPhaseTypeArgs mode-gates writeP (dist only) and writeN
          // (moments only) itself.
          outputOptions,
          executionParams: executionOptions
        }
        
        result = await wfesService.executePhaseType(scaledParams)
        
        if (momentsOnly) {
          // For moments mode, display the mean, std, and moments list
          const resultItems: WfesResultItem[] = []
          // `if (result.mean)` skipped a mean of exactly 0 -- the same
          // falsy-coercion pattern fixed earlier at the IPC boundary.
          if (result.mean !== undefined) {
            resultItems.push(qtyRow('T_sub', result.mean, {
              description: 'Expected time to substitution, from the moments'
            }))
          }
          if (result.std !== undefined) {
            resultItems.push(sdRow('T_sub', result.std))
          }
          setResults(resultItems)
          setMoments(result.moments || [])
        } else {
          // For dist mode, calculate stats from distribution
          if (result.distribution && result.distribution.length > 0) {
            const stats = calculateStats(result.distribution)
            const short = result.statistics?.reachedCutoff === false
            const resultItems: WfesResultItem[] = [
              qtyRow('T_sub', stats.mean, {
                description: short
                  ? 'LOWER BOUND: mean over the computed window only, which stopped early (see the warning above)'
                  : 'Expected time to substitution under the computed phase-type distribution'
              }),
              sdRow('T_sub', stats.std, short
                ? { description: 'LOWER BOUND: dispersion of the truncated window only' }
                : undefined),
              qtyRow('P_total', stats.totalProb),
              qtyRow('F_max', stats.maxCDF)
            ]
            setTruncation(short ? {
              captured: stats.totalProb,
              steps: result.statistics?.timeStepsComputed ?? 0,
              cutoff: result.statistics?.distributionCutoff ?? 0
            } : null)
            setResults(resultItems)
            setDistribution(result.distribution)
          }
        }
        setWarnings(result.warnings || [])
        setExecutionTime(result.executionTime || '')
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
  
  const calculateStats = (dist: Array<{time: number, probability: number, cumulative: number}>) => {
    let mean = 0
    let m2 = 0
    let totalProb = 0

    dist.forEach((row) => {
      const t = row.time
      mean += t * row.probability
      m2 += t * t * row.probability
      totalProb += row.probability
    })

    const stats = {
      mean: totalProb > 0 ? mean / totalProb : 0,
      std: 0,
      totalProb,
      maxCDF: dist[dist.length - 1].cumulative
    }

    // Calculate standard deviation
    if (totalProb > 0) {
      const m2Cond = m2 / totalProb
      stats.std = Math.sqrt(m2Cond - stats.mean * stats.mean)
    }

    return stats
  }
  
  const handleExportData = (format: 'csv' | 'tsv') => {
    if ((mode === 'phase-type-dist' || mode === 'phase-type-dist-sgv') && distribution.length > 0) {
      const delimiter = format === 'tsv' ? '\t' : ','
      const headers = ['Time', 'P(t)', 'CDF']
      
      const data = [
        headers,
        ...distribution.map(row => [
          row.time,
          row.probability.toExponential(6),
          row.cumulative.toFixed(6)
        ])
      ]
      
      const content = data.map(row => row.join(delimiter)).join('\n')
      // Through the main process: an <a download> is silently dropped here.
      void saveTextFile(content, generateFilename(mode === 'phase-type-dist-sgv' ? 'phase_type_dist_sgv' : 'phase_type_dist', format))
    } else if (mode === 'phase-type-dist' && momentsOnly && moments.length > 0) {
      const content = moments.join('\n')
      // Through the main process: an <a download> is silently dropped here.
      void saveTextFile(content, generateFilename('phase_type_moments', 'txt'))
    }
  }
  
  const copyToClipboard = () => {
    if (mode === 'phase-type-dist' && momentsOnly && moments.length > 0) {
      navigator.clipboard.writeText(moments.join('\n'))
    } else {
      const text = results.map(r => `${r.plain ?? r.label}\t${r.raw ?? r.value}`).join('\n')
      navigator.clipboard.writeText(text)
    }
  }
  
  // Build command line string
  const buildCommandLine = () => {
    // Mirrors the actual run: view params -> IPC handler -> the arg builder in
    // wfesBackendService. Verified against the spawned command.
    const N = parseInt(populationSize) || 100
    const dir = outputOptions.outputDirectory || '~/Downloads'
    if (mode === 'phase-type-dist-sgv') {
      // Routed through time_dist_sgv (see the SGV branch of handleExecute).
      // Flag order mirrors buildTimeDistArgs: --initial first, outputs after
      // --library, --json last.
      const parts = ['time_dist_sgv']
      if (initialMode === 'file' && initialDistFile) parts.push(`--initial ${initialDistFile}`)
      const comp = components.map(cp => ({
        s: populationScaled ? ((parseFloat(cp.s) || 0) / (2 * N)).toString() : cp.s,
        u: populationScaled ? ((parseFloat(cp.u) || 0) / (4 * N)).toString() : cp.u,
        v: populationScaled ? ((parseFloat(cp.v) || 0) / (4 * N)).toString() : cp.v
      }))
      parts.push(`--pop-size ${N}`)
      parts.push(`--selection ${comp.map(x => x.s).join(',')}`)
      parts.push(`--dominance 0.5,0.5`)
      parts.push(`--backward-mu ${comp.map(x => x.u).join(',')}`)
      parts.push(`--forward-mu ${comp.map(x => x.v).join(',')}`)
      parts.push(`--lambda ${1 / (parseFloat(oneOverLambda) || 1000)}`)
      parts.push(`--alpha ${a}`)
      parts.push(`--distribution-cutoff ${c}`)
      parts.push(`--max-t ${m}`)
      parts.push(`--num-threads ${executionOptions.threads}`)
      parts.push(`--library ${executionOptions.library}`)
      // time_dist_sgv declares --force (the one tool in its family that does).
      if (executionOptions.force) parts.push('--force')
      if (outputOptions.writeQ) parts.push(`--output-Q ${dir}/time_dist_sgv_Q.mtx`)
      if (outputOptions.writeR) parts.push(`--output-R ${dir}/time_dist_sgv_R.csv`)
      if (outputOptions.writeP) parts.push(`--output-P ${dir}/time_dist_sgv_P.csv`)
      parts.push('--json')
      return parts.join(' ')
    }
    const parts = [momentsOnly ? 'phase_type_moments' : 'phase_type_dist']
    const rawS = populationScaled ? (parseFloat(s) || 0) / (2 * N) : (parseFloat(s) || 0)
    const rawU = populationScaled ? (parseFloat(u) || 0) / (4 * N) : (parseFloat(u) || 0)
    const rawV = populationScaled ? (parseFloat(v) || 0) / (4 * N) : (parseFloat(v) || 0)
    parts.push(`--pop-size ${N}`)
    if (momentsOnly) {
      parts.push(`--n-moments ${parseInt(k) || 20}`)
    } else {
      parts.push(`--distribution-cutoff ${c}`)
      parts.push(`--max-t ${m}`)
    }
    parts.push(`--selection ${rawS}`)
    parts.push(`--dominance ${parseFloat(h) || 0.5}`)
    parts.push(`--backward-mu ${rawU}`)
    parts.push(`--forward-mu ${rawV}`)
    // Excluding recurrent mutation is a real choice on phase_type_moments (-m).
    if (momentsOnly && !r) parts.push('--no-recurrent-mu')
    parts.push(`--alpha ${a}`)
    parts.push(`--num-threads ${executionOptions.threads}`)
    // Only phase_type_moments declares --force; phase_type_dist exits 1 on it.
    if (momentsOnly && executionOptions.force) parts.push('--force')
    parts.push(`--library ${executionOptions.library}`)
    if (outputOptions.writeQ) parts.push(`--output-Q ${dir}/phase_type_Q.mtx`)
    if (outputOptions.writeR) parts.push(`--output-R ${dir}/phase_type_R.csv`)
    if (!momentsOnly && outputOptions.writeP) parts.push(`--output-P ${dir}/phase_type_P.csv`)
    if (momentsOnly && outputOptions.writeN) parts.push(`--output-N ${dir}/phase_type_N.csv`)
    if (initialMode === 'file' && initialDistFile) parts.push(`--initial ${initialDistFile}`)
    parts.push('--json')
    return parts.join(' ')
  }
  
  const copyCommandLine = () => {
    const command = buildCommandLine()
    navigator.clipboard.writeText(command)
  }
  
  // Which drawer controls are live depends on which binary this mode runs.
  const forceAvailable = mode === 'phase-type-dist-sgv' || momentsOnly
  const writePAvailable = mode === 'phase-type-dist-sgv' || (mode === 'phase-type-dist' && !momentsOnly)

  // Count active output options for badge. Only checkbox states that the
  // current mode can actually emit count (a ticked writeN is inert outside
  // moments mode, writeP outside dist/SGV, Force where the binary lacks
  // --force), and the outputDirectory string must not read as an option.
  const activeOutputOptions =
    (outputOptions.writeQ ? 1 : 0) +
    (outputOptions.writeR ? 1 : 0) +
    (writePAvailable && outputOptions.writeP ? 1 : 0) +
    (momentsOnly && mode === 'phase-type-dist' && outputOptions.writeN ? 1 : 0) +
    (forceAvailable && executionOptions.force ? 1 : 0)
  
  // Determine available library options based on platform
  const libraryOptions = (() => {
    const isMac = typeof navigator !== 'undefined' && 
      navigator.platform && navigator.platform.toLowerCase().includes('mac')
    // Only backends compiled into the shipped binaries. ViennaCL requires
    // OpenCL support that is not built ("ViennaCL sparse matrix not available"),
    // and Pardiso is unavailable on Apple Silicon, so offering either produced a
    // runtime error from a control that looked like a valid choice. On macOS
    // "Accelerate" is served by SuiteSparse/UMFPACK, which is what the label says.
    return isMac ? [
      { value: 'Accelerate', label: 'Default (UMFPACK)' },
      { value: 'ParU', label: 'ParU (SuiteSparse, parallel)' }
    ] : [
      { value: 'Pardiso', label: 'Pardiso (Intel MKL)' },
      { value: 'SuiteSparse', label: 'SuiteSparse (UMFPACK)' },
      { value: 'ParU', label: 'ParU (SuiteSparse, parallel)' }
    ]
  })()
  
  // Cmd+Enter (Ctrl+Enter off macOS) fires Execute / Re-execute.
  useExecuteShortcut(handleExecute, isExecuting)

  return (
    <WfesViewLayout
      title="Time to Substitution"
      onBack={onBack}
      hideBackButton={hideBackButton}
      outputOptions={outputOptions}
      onOutputOptionsChange={setOutputOptions}
      // Only flags the binary this mode runs actually declares. All three
      // (phase_type_dist, phase_type_moments, time_dist_sgv) have --output-Q
      // and --output-R; --output-N ("Output moments to file") exists on
      // phase_type_moments alone.
      outputFlags={[
        { key: 'writeQ', label: 'Write Q', description: 'Transient-to-transient transition probability sub-matrix' },
        { key: 'writeR', label: 'Write R', description: 'Transient-to-absorbing transition probability sub-matrix' },
        ...(mode === 'phase-type-dist' && momentsOnly
          ? [{ key: 'writeN' as const, label: 'Write moments (N)', description: 'The computed moments, one per row, as CSV (--output-N)' }]
          : [])
      ]}
      executionOptions={executionOptions}
      onExecutionOptionsChange={setExecutionOptions}
      // --force exists on phase_type_moments and time_dist_sgv; phase_type_dist
      // exits 1 on it, so in that mode the checkbox is visibly dead instead of
      // silently dropped.
      forceDisabledReason={forceAvailable
        ? undefined
        : 'Not available: phase_type_dist does not declare --force'}
      activeOptionsCount={activeOutputOptions}
      optionsContent={
        // The shared drawer has no Write P checkbox, so the flag had no
        // control to be ticked from. phase_type_dist and time_dist_sgv (the
        // SGV mode's binary) declare --output-P; phase_type_moments does not,
        // so it is offered only where it can be honoured.
        writePAvailable ? (
          <Paper p="md" withBorder>
            <Title order={6} mb="sm">Distribution Output</Title>
            <Checkbox
              label="Write P"
              checked={outputOptions.writeP || false}
              onChange={(e) =>
                setOutputOptions({ ...outputOptions, writeP: e.currentTarget.checked })
              }
            />
            <Text size="xs" c="dimmed" ml={22}>
              Write the computed distribution to{' '}
              {mode === 'phase-type-dist-sgv' ? 'time_dist_sgv_P.csv' : 'phase_type_P.csv'} in the
              output folder. The distribution is shown and exported from the results panel
              either way.
            </Text>
          </Paper>
        ) : undefined
      }
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
      {/* Three reachable tools behind two controls: the SGV mode runs
          time_dist_sgv, and the moments toggle runs phase_type_moments. */}
      <AboutContentPanel
        modelName={
          mode === 'phase-type-dist-sgv' ? 'time_dist_sgv'
            : momentsOnly ? 'phase_type_moments'
            : 'phase_type_dist'
        }
      />
      
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
                  { value: 'phase-type-dist', label: 'Substitution Model' },
                  { value: 'phase-type-dist-sgv', label: 'Substitution with SGV' }
                ]}
                orientation="vertical"
                fullWidth
                color="blue"
                size="md"
                className="mode-selector"
              />
              <Text size="sm" c="dimmed" mt="sm">
                {mode === 'phase-type-dist' && 'Compute the probability distribution of the time between substitutions'}
                {mode === 'phase-type-dist-sgv' && 'Compute the probability distribution of the time to next substitution with standing genetic variation'}
              </Text>
              {mode === 'phase-type-dist' && (
                <Switch
                  label="Moments only"
                  description="Moments only — much faster, and exact (no time window)"
                  checked={momentsOnly}
                  onChange={(e) => {
                    setMomentsOnly(e.currentTarget.checked)
                    clearResults()
                  }}
                  mt="md"
                />
              )}
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
                {mode === 'phase-type-dist' && !momentsOnly && (
                  <>
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
                      description="Maximum generations"
                      value={m}
                      onChange={setM}
                      error={!validatePositiveInteger(m)}
                    />
                  </>
                )}
                {mode === 'phase-type-dist' && momentsOnly && (
                  <WfesParameterInput
                    type="text"
                    label="k"
                    description="Number of moments"
                    value={k}
                    onChange={setK}
                    error={!validatePositiveInteger(k)}
                  />
                )}
              </Stack>
            </Paper>
            
            {/* Mutation Parameters */}
            {mode !== 'phase-type-dist-sgv' ? (
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
                  {mode === 'phase-type-dist' && momentsOnly && (
                    <WfesParameterInput
                      type="checkbox"
                      label="r"
                      description="Recurrent mutation (untick to exclude it: --no-recurrent-mu)"
                      value={r}
                      onChange={(checked: boolean) => setR(checked)}
                    />
                  )}
                </Stack>
              </Paper>
            ) : (
              <Paper p="md" withBorder>
                <Title order={6} mb="sm">Component Parameters (SGV)</Title>
                <Text size="xs" c="dimmed" mb="sm">
                  SGV mode models switching from equilibration to absorption with rate λ
                </Text>
                <Tabs value={activeTab.toString()} onChange={(value) => setActiveTab(parseInt(value || '0'))}>
                  <Tabs.List>
                    <Tabs.Tab value="0">Equilibration</Tabs.Tab>
                    <Tabs.Tab value="1">Absorbing</Tabs.Tab>
                  </Tabs.List>
                  
                  {components.map((component, index) => (
                    <Tabs.Panel key={index} value={index.toString()} pt="md">
                      <Stack gap="sm">
                        <WfesParameterInput
                          type="scientific"
                          label={populationScaled ? "4Nu" : "u"}
                          description="Backward mutation rate"
                          value={component.u}
                          onChange={(value) => updateComponent(index, 'u', value)}
                          error={!validateScientificNotation(component.u)}
                        />
                        <WfesParameterInput
                          type="scientific"
                          label={populationScaled ? "4Nv" : "v"}
                          description="Forward mutation rate"
                          value={component.v}
                          onChange={(value) => updateComponent(index, 'v', value)}
                          error={!validateScientificNotation(component.v)}
                        />
                        <WfesParameterInput
                          type="text"
                          label={populationScaled ? "2Ns" : "s"}
                          description="Selection coefficient"
                          value={component.s}
                          onChange={(value) => updateComponent(index, 's', value)}
                          error={!validateScientificNotation(component.s)}
                        />
                      </Stack>
                    </Tabs.Panel>
                  ))}
                </Tabs>
                <WfesParameterInput
                  type="text"
                  label="1/λ"
                  description="Expected generations in equilibration before switching"
                  value={oneOverLambda}
                  onChange={setOneOverLambda}
                  error={!validatePositiveInteger(oneOverLambda)}
                  mt="md"
                />
              </Paper>
            )}
          </Stack>
        </Grid.Col>
        
        {/* Column 2: Results and Selection Parameters */}
        <Grid.Col span={6}>
          <Stack>
            {/* Results */}
            <Paper p="md" withBorder style={{ minHeight: '300px' }}>
              <Group justify="space-between" mb="md">
                <Title order={6}>Results</Title>
                {results.length > 0 && (
                  <Group gap="xs">
                    {(((mode === 'phase-type-dist' && !momentsOnly) || mode === 'phase-type-dist-sgv') && distribution.length > 0) && (
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
                <Alert color="yellow" mb="md" title="Distribution did not converge">
                  <Text size="sm">
                    The solver stopped at the generation limit ({truncation.steps.toLocaleString()}{' '}
                    generations) with {formatCapturedMass(truncation.captured)} of the
                    distribution's mass, short of the {truncation.cutoff} cutoff. The time to
                    substitution and its standard deviation are computed over that window only, so
                    both are UNDERESTIMATES.
                  </Text>
                  <Text size="sm" mt={6}>
                    {mode === 'phase-type-dist-sgv'
                      ? 'Raise the generation limit (m) until the run reaches the cutoff. There is no exact-moments path for the SGV model.'
                      : 'Raise the generation limit, or tick "Moments only" -- that path solves for the moments directly and is exact, with no window and no truncation.'}
                  </Text>
                </Alert>
              )}

              {/* Below the structured banner above, which covers truncation
                  specifically: this is everything the solver itself said,
                  including whatever the banner does not model. Both can appear
                  for one run and neither is suppressed on account of the
                  other. */}
              <SolverWarnings warnings={warnings} />

              {error && (
                <Alert color="red" mb="md">
                  {error}
                </Alert>
              )}
              
              {results.length > 0 ? (
                <Stack>
                  <WfesResultsTable data={results} columns={1} />
                  <Text size="xs" c="dimmed">Execution time: {executionTime}</Text>
                  
                  {/* Show moments list for moments mode */}
                  {mode === 'phase-type-dist' && momentsOnly && moments.length > 0 && (
                    <Paper p="sm" withBorder>
                      <Text size="sm" fw={500} mb="xs">Moments:</Text>
                      <div style={{ maxHeight: '200px', overflowY: 'auto' }}>
                        {moments.map((moment, index) => (
                          <Text key={index} size="xs" style={{ fontFamily: 'monospace' }}>
                            {moment}
                          </Text>
                        ))}
                      </div>
                    </Paper>
                  )}
                  
                  {((mode === 'phase-type-dist' && !momentsOnly && distribution.length > 0) || 
                    (mode === 'phase-type-dist-sgv' && distribution.length > 0) ||
                    (mode === 'phase-type-dist' && momentsOnly && moments.length > 0)) && (
                    <Group mt="md">
                      <WfesExportButtons
                        onExport={(format) => {
                          if (format === 'csv' || format === 'tsv') handleExportData(format as 'csv' | 'tsv')
                          else if (format === 'png' || format === 'svg') {
                            // Open chart modal for visual export
                            setShowChartModal(true)
                          }
                        }}
                        formats={((mode === 'phase-type-dist' && !momentsOnly) || mode === 'phase-type-dist-sgv') ? ['csv', 'tsv', 'png', 'svg'] : ['csv']}
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
                <Stack align="center" justify="center" style={{ height: '200px' }}>
                  {isExecuting ? (
                    <>
                      <Loader size="lg" />
                      <Text size="sm" c="dimmed" mt="md">Running...</Text>
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
            
            {/* Selection Parameters - only for non-SGV modes */}
            {mode !== 'phase-type-dist-sgv' && (
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
            )}
            
            {/* No sampling-frequency control here any more. It described
                itself as affecting only the chart while it actually thinned
                the series that the CSV export was written from -- an export
                whose headers disclosed nothing about the stride. The chart
                thins for display on its own; the export and the statistics
                use every point the solver produced. */}

          </Stack>
        </Grid.Col>
      </Grid>

      {/* The SGV mode is a two-regime switching model, so it gets the same
          structure diagram the other switching views have. The two
          single-model tools in this view have no regimes to draw. */}
      {mode === 'phase-type-dist-sgv' && <SwitchingStateDiagram model={sgvDiagram} />}
      
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
      
          expectedLength={(parseInt(populationSize) || 0) > 0
                      ? (mode === 'phase-type-dist-sgv' ? 4 * parseInt(populationSize) + 1 : 2 * parseInt(populationSize))
                      : null}
                    blocks={(parseInt(populationSize) || 0) > 0 && mode === 'phase-type-dist-sgv' ? [
                      { label: `equilibration phase (counts 0..${2 * parseInt(populationSize)})`, length: 2 * parseInt(populationSize) + 1 },
                      { label: `absorption phase (counts 0..${2 * parseInt(populationSize) - 1})`, length: 2 * parseInt(populationSize) }
                    ] : undefined}
      
          stateSpace={mode === 'phase-type-dist-sgv' ? "the two concatenated SGV phase blocks" : "allele counts 0..2N-1 in the fixation-only model"}
      
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
      <Modal
        opened={showChartModal}
        onClose={() => setShowChartModal(false)}
        size="90%"
        title="Time to Substitution"
      >
        <TimeToSubstitutionChartModal distribution={distribution} />
      </Modal>
    </WfesViewLayout>
  )
}

export default PhaseTypeViewMantine