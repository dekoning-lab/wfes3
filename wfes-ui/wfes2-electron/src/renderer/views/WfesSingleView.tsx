import React, { useState, useEffect } from 'react'
import { LabeledTextField } from '../components/common/LabeledTextField'
import { LabeledCheckBox } from '../components/common/LabeledCheckBox'
import { LabeledComboBox } from '../components/common/LabeledComboBox'
import EquilibriumChartWindow from '../components/EquilibriumChartWindow'
import FundamentalMatrixWindow from '../components/FundamentalMatrixWindow'
import { numOrUndefined, intOrUndefined, finiteOrUndefined } from '../utils/numeric'

interface WfesSingleViewProps {
  onBack: () => void
  hideBackButton?: boolean
}

type ModelType = 'absorption' | 'fixation' | 'establishment' | 'fundamental' | 'nonAbsorbing' | 'equilibrium' | 'alleleAge'

const WfesSingleView: React.FC<WfesSingleViewProps> = ({ onBack, hideBackButton = false }) => {
  // Model type
  const [modelType, setModelType] = useState<ModelType>('absorption')
  
  // Helper function to clear results and reset execution state
  const clearResults = () => {
    setResults(null)
    setExecutionTime('')
    setProgress(0)
    setProgressMessage('')
  }

  // Get CPU count for default threads
  const getCpuCount = () => {
    return navigator.hardwareConcurrency || 4
  }

  // Population parameters with defaults
  const [populationSize, setPopulationSize] = useState('100')
  const [alpha, setAlpha] = useState('1e-20')
  const [startingCopies, setStartingCopies] = useState('1')
  const [integrateOverP, setIntegrateOverP] = useState(true)
  const [integrationCutoff, setIntegrationCutoff] = useState('1e-10')
  const [observedCopies, setObservedCopies] = useState('1')
  const [oddsRatio, setOddsRatio] = useState('1.0')

  // Population scaling toggle
  const [populationScaled, setPopulationScaled] = useState(true)
  
  // Handle population scaling toggle
  const handlePopulationScaledToggle = (newValue: boolean) => {
    const N = parseInt(populationSize) || 1000
    
    if (newValue && !populationScaled) {
      // Converting from raw to scaled values
      // u → 4Nu, v → 4Nv, s → 2Ns
      const rawU = parseFloat(backwardMutation) || 0
      const rawV = parseFloat(forwardMutation) || 0
      const rawS = parseFloat(selectionCoeff) || 0
      
      setBackwardMutation((rawU * 4 * N).toExponential(3))
      setForwardMutation((rawV * 4 * N).toExponential(3))
      setSelectionCoeff(rawS === 0 ? '0' : (rawS * 2 * N).toString())
    } else if (!newValue && populationScaled) {
      // Converting from scaled to raw values
      // 4Nu → u, 4Nv → v, 2Ns → s
      const scaledU = parseFloat(backwardMutation) || 0
      const scaledV = parseFloat(forwardMutation) || 0
      const scaledS = parseFloat(selectionCoeff) || 0
      
      setBackwardMutation((scaledU / (4 * N)).toExponential(3))
      setForwardMutation((scaledV / (4 * N)).toExponential(3))
      setSelectionCoeff(scaledS === 0 ? '0' : (scaledS / (2 * N)).toExponential(3))
    }
    
    setPopulationScaled(newValue)
  }

  // Mutation parameters with defaults
  const [forwardMutation, setForwardMutation] = useState('0.001')  // 4Nv = 0.001
  const [backwardMutation, setBackwardMutation] = useState('0.001') // 4Nu = 0.001
  const [noRecurrentMutation, setNoRecurrentMutation] = useState(false)

  // Selection parameters with defaults
  const [selectionCoeff, setSelectionCoeff] = useState('0')  // 2Ns = 0
  const [dominanceCoeff, setDominanceCoeff] = useState('0.5')

  // Output options
  const [writeQ, setWriteQ] = useState(false)
  const [writeR, setWriteR] = useState(false)
  const [writeB, setWriteB] = useState(false)
  const [writeN, setWriteN] = useState(false)
  const [writeNExt, setWriteNExt] = useState(false)
  const [writeNFix, setWriteNFix] = useState(false)
  const [writeI, setWriteI] = useState(false)
  const [writeE, setWriteE] = useState(false)
  const [writeV, setWriteV] = useState(false)
  const [writeRes, setWriteRes] = useState(false)

  // Execution parameters with defaults
  const [force, setForce] = useState(false)
  const [threads, setThreads] = useState(getCpuCount().toString())
  // Detect platform for library default
  const getDefaultLibrary = () => {
    if (typeof navigator !== 'undefined' && navigator.platform) {
      return navigator.platform.toLowerCase().includes('mac') ? 'accelerate' : 'pardiso'
    }
    return 'accelerate' // Default to accelerate for development
  }
  
  const [library, setLibrary] = useState(getDefaultLibrary())
  const [solver, setSolver] = useState('direct')
  const [initialDistFile, setInitialDistFile] = useState('')

  // Execution state
  const [isExecuting, setIsExecuting] = useState(false)
  const [executionTime, setExecutionTime] = useState('')
  const [results, setResults] = useState<any>(null)
  const [progress, setProgress] = useState(0)
  const [progressMessage, setProgressMessage] = useState('')
  const [showEquilibriumChart, setShowEquilibriumChart] = useState(false)
  const [showFundamentalMatrix, setShowFundamentalMatrix] = useState(false)

  // Validation
  const validatePositiveInteger = (value: string): boolean => {
    const num = parseInt(value)
    return !isNaN(num) && num > 0
  }

  const validateStartingCopies = (): boolean => {
    const p = parseInt(startingCopies)
    const n = parseInt(populationSize)
    if (isNaN(p) || isNaN(n)) return false

    switch (modelType) {
      case 'absorption':
      case 'alleleAge':
        return p >= 1 && p < 2 * n - 1
      case 'fixation':
        return p >= 1 && p < 2 * n
      case 'establishment':
        return p >= 1 && p < n - 1
      default:
        return true
    }
  }

  // Set up progress listener
  useEffect(() => {
    // Set up progress listener
    const progressListener = (data: any) => {
      if (data.tool === 'wfes_single') {
        setProgress(data.progress)
        setProgressMessage(data.message)
      }
    }

    window.api.wfes.onProgress(progressListener)

    // Cleanup on unmount
    return () => {
      window.api.wfes.removeProgressListener()
    }
  }, [])

  const handleExecute = async () => {
    setIsExecuting(true)
    setProgress(0)
    setProgressMessage('Starting execution...')
    const startTime = Date.now()

    try {
      // Convert population-scaled values to raw values if needed
      const N = parseInt(populationSize)
      let rawForwardMutation = parseFloat(forwardMutation)
      let rawBackwardMutation = parseFloat(backwardMutation)
      let rawSelectionCoeff = parseFloat(selectionCoeff)
      
      if (populationScaled) {
        // Convert from population-scaled to raw values
        // 4Nu → u, 4Nv → v
        rawBackwardMutation = rawBackwardMutation / (4 * N)
        rawForwardMutation = rawForwardMutation / (4 * N)
        // 2Ns → s
        rawSelectionCoeff = rawSelectionCoeff / (2 * N)
      }

      // Prepare parameters for execution
      const params = {
        modelType,
        populationSize: N,
        alpha: numOrUndefined(alpha),
        startingCopies: integrateOverP ? undefined : (intOrUndefined(startingCopies)),
        integrationCutoff: numOrUndefined(integrationCutoff),
        observedCopies: intOrUndefined(observedCopies),
        oddsRatio: numOrUndefined(oddsRatio),
        forwardMutation: finiteOrUndefined(rawForwardMutation),
        backwardMutation: finiteOrUndefined(rawBackwardMutation),
        noRecurrentMutation,
        selectionCoeff: finiteOrUndefined(rawSelectionCoeff),
        dominanceCoeff: parseFloat(dominanceCoeff),
        outputOptions: {
          writeQ, writeR, writeB, writeN, writeNExt, writeNFix,
          writeI, writeE, writeV, writeRes
        },
        executionOptions: {
          force,
          threads: parseInt(threads),
          library,
          solver: library === 'vienna' ? solver : undefined,
          initialDistFile: initialDistFile || undefined
        }
      }

      // Execute via IPC
      const response = await window.api.wfes.single.execute(params)
      
      if (response.success) {
        console.log('Received results:', response.results)
        setResults(response.results)
        setExecutionTime(response.executionTime)
      } else {
        alert(`Execution failed: ${response.error || 'Unknown error'}`)
      }
    } catch (error) {
      console.error('Execution error:', error)
      alert('Failed to execute WFES Single')
    } finally {
      setIsExecuting(false)
      setProgress(0)
      setProgressMessage('')
    }
  }

  const getMockResults = (type: ModelType) => {
    switch (type) {
      case 'absorption':
        return {
          pExt: '0.876544',
          pFix: '0.123456',
          tAbs: '1234.56',
          tAbsStd: '56.78',
          tExt: '987.65',
          tExtStd: '43.21',
          nExt: '2345.67',
          tFixAbsMode: '1567.89',
          tFixStdAbsMode: '67.89'
        }
      case 'fixation':
        return {
          rate: '0.000123',
          tFix: '1234.56',
          tFixStd: '56.78'
        }
      case 'establishment':
        return {
          pEst: '0.234567',
          fEst: '0.456789',
          tEst: '234.56',
          tEstStd: '12.34',
          tSeg: '456.78',
          tSegStd: '23.45',
          tSegEst: '567.89',
          tSegEstStd: '34.56',
          tSegFix: '678.90',
          tSegFixStd: '45.67'
        }
      case 'fundamental':
        return {
          rate: '0.000234'
        }
      case 'nonAbsorbing':
        return {
          eFreqMut: '0.123456',
          eFreqWt: '0.876544'
        }
      case 'equilibrium':
        return {
          eFreqMut: '0.234567',
          eFreqWt: '0.765433'
        }
      case 'alleleAge':
        return {
          eA: '1234.56',
          sA: '567.89'
        }
      default:
        return {}
    }
  }

  const renderResults = () => {
    if (!results) return null
    
    // Handle non-absorbing mode that returns only a message
    if (results.message && modelType !== 'fundamental') {
      return (
        <div className="space-y-1 text-sm text-gray-600">
          <p>{results.message}</p>
        </div>
      )
    }

    switch (modelType) {
      case 'absorption':
        return (
          <div className="space-y-1 text-sm">
            <p>P<sub>ext</sub> = {results.P_ext}</p>
            <p>P<sub>fix</sub> = {results.P_fix}</p>
            <p>T<sub>abs</sub> = {results.T_abs}</p>
            <p>T<sub>abs</sub> Std = {results.T_abs_std}</p>
            <p>T<sub>ext</sub> = {results.T_ext}</p>
            <p>T<sub>ext</sub> Std = {results.T_ext_std}</p>
            <p>N<sub>ext</sub> = {results.N_ext}</p>
            <p>T<sub>fix</sub> = {results.T_fix}</p>
            <p>T<sub>fix</sub> Std = {results.T_fix_std}</p>
          </div>
        )
      case 'fixation':
        return (
          <div className="space-y-1 text-sm">
            <p>Rate = {results.rate}</p>
            <p>T<sub>fix</sub> = {results.T_fix}</p>
            <p>T<sub>fix</sub> Std = {results.T_std}</p>
          </div>
        )
      case 'establishment':
        return (
          <div className="space-y-1 text-sm">
            <p>Est. freq. = {results.est_freq}</p>
            <p>P<sub>est</sub> = {results.P_est}</p>
            <p>T<sub>est</sub> = {results.T_est}</p>
            <p>T<sub>est</sub> Std = {results.T_est_std}</p>
            <p>T<sub>seg</sub> = {results.T_seg}</p>
            <p>T<sub>seg</sub> Std = {results.T_seg_std}</p>
            <p>T<sub>seg→ext</sub> = {results.T_seg_ext}</p>
            <p>T<sub>seg→ext</sub> Std = {results.T_seg_ext_std}</p>
            <p>T<sub>seg→fix</sub> = {results.T_seg_fix}</p>
            <p>T<sub>seg→fix</sub> Std = {results.T_seg_fix_std}</p>
          </div>
        )
      case 'fundamental':
        // Always show button for fundamental mode
        return (
          <div className="space-y-2">
            <div className="space-y-1 text-sm text-gray-600">
              <p>Fundamental matrix calculation completed.</p>
            </div>
            <button
              onClick={() => {
                if (results && results.fundamental_matrix) {
                  const matrixSize = results.fundamental_matrix.length
                  if (matrixSize > 200) {
                    const proceed = window.confirm(
                      `Warning: The fundamental matrix is ${matrixSize}×${matrixSize} (${matrixSize * matrixSize} cells).\n\n` +
                      `For performance reasons, matrices larger than 200×200 will be displayed as a static image.\n` +
                      `- Interactive visualization: up to 50×50\n` +
                      `- Canvas rendering: 51×51 to 200×200\n` +
                      `- Static image: larger than 200×200\n\n` +
                      `Do you want to continue?`
                    )
                    if (!proceed) return
                  }
                  setShowFundamentalMatrix(true)
                } else {
                  alert('No matrix data available. This may be a loading issue.')
                }
              }}
              className="px-3 py-1 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 transition-colors"
            >
              View Matrix Heatmap
            </button>
          </div>
        )
      case 'nonAbsorbing':
        return (
          <div className="space-y-1 text-sm text-gray-600">
            <p>Non-absorbing matrix construction completed.</p>
            <p>Matrix saved to output file (if Q output is enabled).</p>
          </div>
        )
      case 'equilibrium':
        return (
          <div className="space-y-2">
            <div className="space-y-1 text-sm">
              <p>E[freq] = {results.E_freq}</p>
            </div>
            {results.distribution && (
              <button
                onClick={() => setShowEquilibriumChart(true)}
                className="px-3 py-1 text-sm bg-blue-600 text-white rounded hover:bg-blue-700"
              >
                View Distribution
              </button>
            )}
          </div>
        )
      case 'alleleAge':
        return (
          <div className="space-y-1 text-sm">
            <p>E[T] = {results.E_T}</p>
            <p>Std[T] = {results.Std_T}</p>
          </div>
        )
      default:
        return null
    }
  }

  return (
    <div className={`flex flex-col h-full bg-gray-800 dark:bg-gray-800 native-app ${!hideBackButton ? 'native-window' : ''}`}>
      {/* Header */}
      <div className="native-header flex items-center gap-3 px-3">
        {!hideBackButton && (
          <button
            onClick={onBack}
            className="native-button p-1 px-2"
            title="Back to main menu"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
            </svg>
          </button>
        )}
        <h1 className="native-label font-medium">WFES Single</h1>
      </div>

      {/* Main content area with three columns */}
      <div className="flex-1 flex p-4 gap-4 overflow-auto">
        {/* Column 1: Mode & Input Parameters */}
        <div className="flex-1 min-w-[250px] space-y-4">
          {/* Mode Section */}
          <div>
            <h2 className="text-sm font-bold mb-2">Mode:</h2>
            <div className="ml-4 space-y-2">
              {[
                { value: 'absorption', label: 'Absorption', tooltip: 'Absorption probabilities and times' },
                { value: 'fixation', label: 'Fixation', tooltip: 'Calculate fixation rate and time' },
                { value: 'establishment', label: 'Establishment', tooltip: 'Calculate establishment probabilities' },
                { value: 'fundamental', label: 'Fundamental', tooltip: 'Calculate fundamental matrix properties' },
                { value: 'nonAbsorbing', label: 'Non Absorbing', tooltip: 'Non-absorbing steady state' },
                { value: 'equilibrium', label: 'Equilibrium', tooltip: 'Equilibrium frequencies' },
                { value: 'alleleAge', label: 'Allele Age', tooltip: 'Expected age of an allele' }
              ].map(mode => (
                <label key={mode.value} className="flex items-center gap-2 cursor-pointer" title={mode.tooltip}>
                  <input
                    type="radio"
                    name="modelType"
                    value={mode.value}
                    checked={modelType === mode.value}
                    onChange={(e) => {
                      setModelType(e.target.value as ModelType)
                      clearResults()
                    }}
                    className="text-blue-600"
                  />
                  <span className="text-sm">{mode.label}</span>
                </label>
              ))}
            </div>
          </div>

          <div className="h-px bg-gray-300" />

          {/* Population Section */}
          <div>
            <h2 className="text-sm font-bold mb-2">Population:</h2>
            <div className="ml-4 space-y-2">
              <LabeledTextField
                label="N"
                value={populationSize}
                onChange={setPopulationSize}
                type="number"
                error={populationSize !== '' && !validatePositiveInteger(populationSize)}
                helperText={populationSize !== '' && !validatePositiveInteger(populationSize) ? 'Must be positive' : ''}
                tooltip="Population size"
                required
                width="w-24"
              />
              <LabeledTextField
                label="α"
                value={alpha}
                onChange={setAlpha}
                type="number"
                tooltip="Probability cutoff (Ignore transitions with probability below this threshold to speed up computations)"
                width="w-24"
              />
              {(modelType === 'absorption' || modelType === 'fixation' || modelType === 'establishment' || modelType === 'alleleAge') && (
                <>
                  <LabeledCheckBox
                    label="Integrate over p"
                    checked={integrateOverP}
                    onChange={setIntegrateOverP}
                    tooltip="Integrate over distribution of starting copies"
                  />
                  <LabeledTextField
                    label="p"
                    value={startingCopies}
                    onChange={setStartingCopies}
                    type="number"
                    error={startingCopies !== '' && !validateStartingCopies()}
                    tooltip="Starting number of copies"
                    width="w-24"
                    disabled={integrateOverP}
                  />
                </>
              )}
              <LabeledTextField
                label="c"
                value={integrationCutoff}
                onChange={setIntegrationCutoff}
                type="number"
                tooltip="Starting probability cutoff (Ignore rare starting copy numbers with probability below this cutoff)"
                width="w-24"
                disabled={!integrateOverP}
              />
              {modelType === 'alleleAge' && (
                <LabeledTextField
                  label="x"
                  value={observedCopies}
                  onChange={setObservedCopies}
                  type="number"
                  tooltip="Observed number of copies"
                  width="w-24"
                />
              )}
              {modelType === 'establishment' && (
                <LabeledTextField
                  label="k"
                  value={oddsRatio}
                  onChange={setOddsRatio}
                  type="number"
                  tooltip="Odds ratio"
                  width="w-24"
                />
              )}
            </div>
          </div>

          <div className="h-px bg-gray-300" />

          {/* Mutation Section */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-sm font-bold">Mutation:</h2>
              <LabeledCheckBox
                label="Population Scaled"
                checked={populationScaled}
                onChange={handlePopulationScaledToggle}
                tooltip="Use population-scaled parameters (4Nu, 4Nv)"
              />
            </div>
            <div className="ml-4 space-y-2">
              <LabeledTextField
                label={populationScaled ? "4Nu" : "u"}
                value={backwardMutation}
                onChange={setBackwardMutation}
                type="number"
                tooltip={populationScaled ? "Population-scaled backward mutation rate (4Nu)" : "Backward mutation rate"}
                width="w-24"
              />
              <LabeledTextField
                label={populationScaled ? "4Nv" : "v"}
                value={forwardMutation}
                onChange={setForwardMutation}
                type="number"
                tooltip={populationScaled ? "Population-scaled forward mutation rate (4Nv)" : "Forward mutation rate"}
                width="w-24"
              />
              <LabeledCheckBox
                label="m"
                checked={noRecurrentMutation}
                onChange={setNoRecurrentMutation}
                tooltip="No recurrent mutation"
              />
            </div>
          </div>

          <div className="h-px bg-gray-300" />

          {/* Selection Section */}
          <div>
            <h2 className="text-sm font-bold mb-2">Selection:</h2>
            <div className="ml-4 space-y-2">
              <LabeledTextField
                label={populationScaled ? "2Ns" : "s"}
                value={selectionCoeff}
                onChange={setSelectionCoeff}
                type="number"
                tooltip={populationScaled ? "Population-scaled selection coefficient (2Ns)" : "Selection coefficient"}
                width="w-24"
              />
              <LabeledTextField
                label="h"
                value={dominanceCoeff}
                onChange={setDominanceCoeff}
                type="number"
                tooltip="Dominance coefficient"
                width="w-24"
              />
            </div>
          </div>
        </div>

        <div className="w-px bg-gray-300" />

        {/* Column 2: Output Options & Execution */}
        <div className="flex-1 min-w-[250px] space-y-4">
          {/* Output Options */}
          <div>
            <h2 className="text-sm font-bold mb-2">Output Options:</h2>
            <div className="ml-4 space-y-2">
              <LabeledCheckBox
                label="Write Q"
                checked={writeQ}
                onChange={setWriteQ}
                disabled={modelType === 'fundamental' || modelType === 'nonAbsorbing' || modelType === 'equilibrium'}
                tooltip="Write Q matrix to file"
              />
              <LabeledCheckBox
                label="Write R"
                checked={writeR}
                onChange={setWriteR}
                disabled={modelType === 'fundamental' || modelType === 'nonAbsorbing' || modelType === 'equilibrium'}
                tooltip="Write R matrix to file"
              />
              <LabeledCheckBox
                label="Write B"
                checked={writeB}
                onChange={setWriteB}
                disabled={modelType === 'fundamental' || modelType === 'nonAbsorbing' || modelType === 'equilibrium'}
                tooltip="Write B matrix to file"
              />
              <LabeledCheckBox
                label="Write N"
                checked={writeN}
                onChange={setWriteN}
                disabled={modelType === 'fundamental' || modelType === 'nonAbsorbing' || modelType === 'equilibrium'}
                tooltip="Write N matrix to file"
              />
              {modelType === 'absorption' && (
                <>
                  <LabeledCheckBox
                    label="Write N_Ext"
                    checked={writeNExt}
                    onChange={setWriteNExt}
                    tooltip="Write extinction matrix to file"
                  />
                  <LabeledCheckBox
                    label="Write N_Fix"
                    checked={writeNFix}
                    onChange={setWriteNFix}
                    tooltip="Write fixation matrix to file"
                  />
                </>
              )}
              <LabeledCheckBox
                label="Write I"
                checked={writeI}
                onChange={setWriteI}
                disabled={modelType !== 'fundamental' && modelType !== 'equilibrium'}
                tooltip="Write I matrix to file"
              />
              <LabeledCheckBox
                label="Write E"
                checked={writeE}
                onChange={setWriteE}
                disabled={modelType !== 'fundamental' && modelType !== 'equilibrium'}
                tooltip="Write E matrix to file"
              />
              <LabeledCheckBox
                label="Write V"
                checked={writeV}
                onChange={setWriteV}
                disabled={modelType !== 'fundamental' && modelType !== 'equilibrium'}
                tooltip="Write V matrix to file"
              />
              <LabeledCheckBox
                label="Write Res"
                checked={writeRes}
                onChange={setWriteRes}
                disabled={modelType === 'fundamental' || modelType === 'nonAbsorbing' || modelType === 'equilibrium'}
                tooltip="Write results to file"
              />
            </div>
          </div>

          <div className="h-px bg-gray-300" />

          {/* Execution Section */}
          <div>
            <h2 className="text-sm font-bold mb-2">Execution:</h2>
            <div className="ml-4 space-y-2">
              <LabeledCheckBox
                label="Force"
                checked={force}
                onChange={setForce}
                tooltip="Force recalculation"
              />
              <LabeledTextField
                label="t"
                value={threads}
                onChange={setThreads}
                type="number"
                tooltip="Number of threads"
                width="w-20"
              />
              <LabeledComboBox
                label="Library"
                value={library}
                onChange={setLibrary}
                options={(() => {
                  const isMac = typeof navigator !== 'undefined' && 
                    navigator.platform && navigator.platform.toLowerCase().includes('mac')
                  return isMac ? [
                    { value: 'accelerate', label: 'Accelerate' },
                    { value: 'vienna', label: 'ViennaCL' }
                  ] : [
                    { value: 'pardiso', label: 'Pardiso' },
                    { value: 'vienna', label: 'ViennaCL' }
                  ]
                })()}
                tooltip="Linear algebra library"
                width="w-32"
              />
              {library === 'vienna' && (
                <LabeledComboBox
                  label="Solver"
                  value={solver}
                  onChange={setSolver}
                  options={[
                    { value: 'gmres', label: 'GMRes' },
                    { value: 'bicgstab', label: 'BicGStab' }
                  ]}
                  tooltip="Iterative solver type"
                  width="w-32"
                />
              )}
              
              <div className="pt-2">
                <label className="text-sm">Initial Distribution:</label>
                <div className="flex items-center gap-2 mt-1">
                  <input
                    type="text"
                    value={initialDistFile}
                    onChange={(e) => setInitialDistFile(e.target.value)}
                    className="flex-1 px-2 py-1 text-sm border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                    placeholder="Optional file path"
                  />
                  <button
                    className="px-3 py-1 text-sm bg-gray-200 hover:bg-gray-300 rounded transition-colors"
                    onClick={async () => {
                      const filePath = await window.api.dialog.openFile()
                      if (filePath) {
                        setInitialDistFile(filePath)
                      }
                    }}
                  >
                    Browse
                  </button>
                </div>
              </div>

              <div className="flex gap-2 pt-4">
                <button
                  onClick={handleExecute}
                  disabled={isExecuting || !populationSize}
                  className="flex-1 px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors"
                >
                  Execute
                </button>
                <button
                  onClick={() => setIsExecuting(false)}
                  disabled={!isExecuting}
                  className="flex-1 px-4 py-2 border border-gray-300 rounded hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  Stop
                </button>
              </div>

              {isExecuting && (
                <div className="pt-2">
                  <div className="text-sm text-gray-600 mb-1">
                    {progressMessage || 'Executing...'}
                  </div>
                  <div className="w-full bg-gray-200 rounded-full h-2">
                    <div 
                      className="bg-blue-600 h-2 rounded-full transition-all duration-300" 
                      style={{ width: `${Math.max(progress, 5)}%` }}
                    ></div>
                  </div>
                  {progress > 0 && (
                    <div className="text-xs text-gray-500 mt-1">{progress}% complete</div>
                  )}
                </div>
              )}

              {executionTime && (
                <p className="text-sm text-gray-600">Execution time: {executionTime}</p>
              )}
            </div>
          </div>
        </div>

        <div className="w-px bg-gray-300" />

        {/* Column 3: Results */}
        <div className="flex-1 min-w-[250px]">
          <h2 className="text-sm font-bold mb-2">Results:</h2>
          <div className="ml-4">
            {renderResults()}
            {results && (
              <button
                onClick={() => {
                  const formattedResults = Object.entries(results)
                    .map(([key, value]) => `${key}: ${value}`)
                    .join('\n')
                  navigator.clipboard.writeText(formattedResults)
                    .then(() => console.log('Results copied to clipboard'))
                    .catch(err => console.error('Failed to copy:', err))
                }}
                className="mt-4 px-3 py-1 text-sm bg-gray-200 hover:bg-gray-300 rounded transition-colors"
              >
                Copy to Clipboard
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Bottom status bar */}
      <div className="h-9 bg-gray-100 border-t flex items-center px-4">
        <span className="text-sm text-gray-600">
          {isExecuting 
            ? `Executing WFES Single... ${progress > 0 ? `(${progress}%)` : ''}`
            : 'Ready'
          }
        </span>
      </div>

      {/* Equilibrium Chart Modal */}
      {showEquilibriumChart && results?.distribution && (
        <EquilibriumChartWindow
          isOpen={showEquilibriumChart}
          onClose={() => setShowEquilibriumChart(false)}
          data={results.distribution.map((item: any) => ({
            copies: item.copies,
            probability: item.probability
          }))}
          populationSize={parseInt(populationSize)}
          expectedFrequency={parseFloat(results.E_freq)}
          parameters={{
            N: parseInt(populationSize),
            s: parseFloat(selectionCoeff) / (populationScaled ? 2 * parseInt(populationSize) : 1),
            h: parseFloat(dominanceCoeff),
            u: parseFloat(backwardMutation) / (populationScaled ? 4 * parseInt(populationSize) : 1),
            v: parseFloat(forwardMutation) / (populationScaled ? 4 * parseInt(populationSize) : 1)
          }}
        />
      )}

      {/* Fundamental Matrix Modal */}
      {showFundamentalMatrix && results?.fundamental_matrix && (
        <FundamentalMatrixWindow
          isOpen={showFundamentalMatrix}
          onClose={() => setShowFundamentalMatrix(false)}
          data={results.fundamental_matrix}
          populationSize={parseInt(populationSize)}
          parameters={{
            N: parseInt(populationSize),
            s: parseFloat(selectionCoeff) / (populationScaled ? 2 * parseInt(populationSize) : 1),
            h: parseFloat(dominanceCoeff),
            u: parseFloat(backwardMutation) / (populationScaled ? 4 * parseInt(populationSize) : 1),
            v: parseFloat(forwardMutation) / (populationScaled ? 4 * parseInt(populationSize) : 1)
          }}
        />
      )}
    </div>
  )
}

export default WfesSingleView