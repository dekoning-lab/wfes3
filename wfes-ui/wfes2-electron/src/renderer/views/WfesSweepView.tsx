import React, { useState } from 'react'
import { LabeledTextField } from '../components/common/LabeledTextField'
import { LabeledCheckBox } from '../components/common/LabeledCheckBox'
import { LabeledComboBox } from '../components/common/LabeledComboBox'
import { wfesService } from '../services/wfesService'
import { numOrUndefined, intOrUndefined, finiteOrUndefined } from '../utils/numeric'

interface WfesSweepViewProps {
  onBack: () => void
  hideBackButton?: boolean
}

const WfesSweepView: React.FC<WfesSweepViewProps> = ({ onBack, hideBackButton = false }) => {
  // Mode is fixed to Fixation in sweep
  const modelType = 'fixation'
  
  // Population parameters
  const [populationSize, setPopulationSize] = useState('100')
  const [alpha, setAlpha] = useState('1e-20')
  const [lambda, setLambda] = useState('0.01')
  const [integrationCutoff, setIntegrationCutoff] = useState('1e-10')
  const [startingCopies, setStartingCopies] = useState('1')
  
  // Component 1 parameters
  const [comp1ForwardMutation, setComp1ForwardMutation] = useState('0.001')  // 4Nv = 0.001
  const [comp1BackwardMutation, setComp1BackwardMutation] = useState('0.001') // 4Nu = 0.001
  const [comp1SelectionCoeff, setComp1SelectionCoeff] = useState('0')        // 2Ns = 0
  const [comp1DominanceCoeff, setComp1DominanceCoeff] = useState('0.5')
  
  // Component 2 parameters
  const [comp2ForwardMutation, setComp2ForwardMutation] = useState('0.001')  // 4Nv = 0.001
  const [comp2BackwardMutation, setComp2BackwardMutation] = useState('0.001') // 4Nu = 0.001
  const [comp2SelectionCoeff, setComp2SelectionCoeff] = useState('0')        // 2Ns = 0
  const [comp2DominanceCoeff, setComp2DominanceCoeff] = useState('0.5')
  
  // Tab state
  const [activeTab, setActiveTab] = useState(0)
  
  // Population scaling toggle
  const [populationScaled, setPopulationScaled] = useState(true)
  
  // Handle population scaling toggle
  const handlePopulationScaledToggle = (newValue: boolean) => {
    const N = parseInt(populationSize) || 1000
    
    if (newValue && !populationScaled) {
      // Converting from raw to scaled values
      // u → 4Nu, v → 4Nv, s → 2Ns
      // Component 1
      const rawU1 = parseFloat(comp1ForwardMutation) || 0
      const rawV1 = parseFloat(comp1BackwardMutation) || 0
      const rawS1 = parseFloat(comp1SelectionCoeff) || 0
      
      setComp1ForwardMutation((rawU1 * 4 * N).toExponential(3))
      setComp1BackwardMutation((rawV1 * 4 * N).toExponential(3))
      setComp1SelectionCoeff(rawS1 === 0 ? '0' : (rawS1 * 2 * N).toString())
      
      // Component 2
      const rawU2 = parseFloat(comp2ForwardMutation) || 0
      const rawV2 = parseFloat(comp2BackwardMutation) || 0
      const rawS2 = parseFloat(comp2SelectionCoeff) || 0
      
      setComp2ForwardMutation((rawU2 * 4 * N).toExponential(3))
      setComp2BackwardMutation((rawV2 * 4 * N).toExponential(3))
      setComp2SelectionCoeff(rawS2 === 0 ? '0' : (rawS2 * 2 * N).toString())
    } else if (!newValue && populationScaled) {
      // Converting from scaled to raw values
      // 4Nu → u, 4Nv → v, 2Ns → s
      // Component 1
      const scaledU1 = parseFloat(comp1ForwardMutation) || 0
      const scaledV1 = parseFloat(comp1BackwardMutation) || 0
      const scaledS1 = parseFloat(comp1SelectionCoeff) || 0
      
      setComp1ForwardMutation((scaledU1 / (4 * N)).toExponential(3))
      setComp1BackwardMutation((scaledV1 / (4 * N)).toExponential(3))
      setComp1SelectionCoeff(scaledS1 === 0 ? '0' : (scaledS1 / (2 * N)).toExponential(3))
      
      // Component 2
      const scaledU2 = parseFloat(comp2ForwardMutation) || 0
      const scaledV2 = parseFloat(comp2BackwardMutation) || 0
      const scaledS2 = parseFloat(comp2SelectionCoeff) || 0
      
      setComp2ForwardMutation((scaledU2 / (4 * N)).toExponential(3))
      setComp2BackwardMutation((scaledV2 / (4 * N)).toExponential(3))
      setComp2SelectionCoeff(scaledS2 === 0 ? '0' : (scaledS2 / (2 * N)).toExponential(3))
    }
    
    setPopulationScaled(newValue)
  }
  
  // Output options
  const [writeQ, setWriteQ] = useState(false)
  const [writeR, setWriteR] = useState(false)
  const [writeN, setWriteN] = useState(false)
  const [writeB, setWriteB] = useState(false)
  
  // Get CPU count for default threads
  const getCpuCount = () => {
    return navigator.hardwareConcurrency || 4
  }
  
  // Get default library based on platform
  const getDefaultLibrary = () => {
    if (typeof navigator !== 'undefined' && navigator.platform) {
      return navigator.platform.toLowerCase().includes('mac') ? 'accelerate' : 'pardiso'
    }
    return 'accelerate'
  }
  
  // Execution parameters
  const [force, setForce] = useState(false)
  const [threads, setThreads] = useState(getCpuCount().toString())
  const [library, setLibrary] = useState(getDefaultLibrary())
  const [solver, setSolver] = useState('direct')
  
  // Execution state
  const [isExecuting, setIsExecuting] = useState(false)
  const [executionTime, setExecutionTime] = useState('')
  const [results, setResults] = useState<any>(null)
  
  // Validation
  const validatePositiveInteger = (value: string): boolean => {
    const num = parseInt(value)
    return !isNaN(num) && num > 0
  }
  
  const handleExecute = async () => {
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
      modelType,
      populationSize: N,
      alpha: numOrUndefined(alpha),
      lambda: numOrUndefined(lambda),
      integrationCutoff: numOrUndefined(integrationCutoff),
      startingCopies: intOrUndefined(startingCopies),
      components: [
        {
          forwardMutation: finiteOrUndefined(rawForwardMutation1),
          backwardMutation: finiteOrUndefined(rawBackwardMutation1),
          selectionCoeff: finiteOrUndefined(rawSelectionCoeff1),
          dominanceCoeff: parseFloat(comp1DominanceCoeff)
        },
        {
          forwardMutation: finiteOrUndefined(rawForwardMutation2),
          backwardMutation: finiteOrUndefined(rawBackwardMutation2),
          selectionCoeff: finiteOrUndefined(rawSelectionCoeff2),
          dominanceCoeff: parseFloat(comp2DominanceCoeff)
        }
      ],
      outputOptions: {
        writeQ, writeR, writeN, writeB
      },
      executionOptions: {
        force,
        threads: parseInt(threads),
        library,
        solver: library === 'vienna' ? solver : undefined
      }
    }
    
    setIsExecuting(true)
    
    try {
      const response = await wfesService.executeSweep(params)
      
      if (response.success) {
        setResults(response.results)
        setExecutionTime(response.executionTime)
      } else {
        alert(`Execution failed: ${response.error || 'Unknown error'}`)
      }
    } catch (error) {
      console.error('Execution error:', error)
      alert('Failed to execute WFES Sweep')
    } finally {
      setIsExecuting(false)
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
        <h1 className="native-label font-medium">WFES Sweep</h1>
      </div>

      {/* Main content area with three columns */}
      <div className="flex-1 flex p-4 gap-4 overflow-auto min-h-0">
        {/* Column 1: Mode & Input Parameters */}
        <div className="flex-1 min-w-[250px] space-y-4">
          {/* Mode Section */}
          <div>
            <h2 className="text-sm font-bold mb-2">Mode:</h2>
            <div className="ml-4">
              <p className="text-sm">Fixation (Fixed)</p>
            </div>
          </div>

          <div className="h-px bg-gray-300" />

          {/* Components Section */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-sm font-bold">Components:</h2>
              <LabeledCheckBox
                label="Population Scaled"
                checked={populationScaled}
                onChange={handlePopulationScaledToggle}
                tooltip="Use population-scaled parameters (4Nu, 4Nv, 2Ns)"
              />
            </div>
            
            {/* Tabs */}
            <div className="flex border-b mb-3">
              <button
                onClick={() => setActiveTab(0)}
                className={`px-4 py-2 text-sm font-medium ${
                  activeTab === 0
                    ? 'border-b-2 border-blue-600 text-blue-600'
                    : 'text-gray-600 hover:text-gray-800'
                }`}
              >
                Component 1
              </button>
              <button
                onClick={() => setActiveTab(1)}
                className={`px-4 py-2 text-sm font-medium ${
                  activeTab === 1
                    ? 'border-b-2 border-blue-600 text-blue-600'
                    : 'text-gray-600 hover:text-gray-800'
                }`}
              >
                Component 2
              </button>
            </div>
            
            {/* Tab Content */}
            <div className="ml-4 space-y-2">
              {activeTab === 0 ? (
                <>
                  <h3 className="text-sm font-medium mb-2">Mutation:</h3>
                  <LabeledTextField
                    label={populationScaled ? "4Nu" : "u"}
                    value={comp1ForwardMutation}
                    onChange={setComp1ForwardMutation}
                    type="number"
                    tooltip={populationScaled ? "Population-scaled forward mutation rate (4Nu)" : "Forward mutation rate"}
                    width="w-24"
                  />
                  <LabeledTextField
                    label={populationScaled ? "4Nv" : "v"}
                    value={comp1BackwardMutation}
                    onChange={setComp1BackwardMutation}
                    type="number"
                    tooltip={populationScaled ? "Population-scaled backward mutation rate (4Nv)" : "Backward mutation rate"}
                    width="w-24"
                  />
                  
                  <h3 className="text-sm font-medium mb-2 mt-4">Selection:</h3>
                  <LabeledTextField
                    label={populationScaled ? "2Ns" : "s"}
                    value={comp1SelectionCoeff}
                    onChange={setComp1SelectionCoeff}
                    type="number"
                    tooltip={populationScaled ? "Population-scaled selection coefficient (2Ns)" : "Selection coefficient"}
                    width="w-24"
                  />
                  <LabeledTextField
                    label="h"
                    value={comp1DominanceCoeff}
                    onChange={setComp1DominanceCoeff}
                    type="number"
                    tooltip="Dominance coefficient"
                    width="w-24"
                  />
                </>
              ) : (
                <>
                  <h3 className="text-sm font-medium mb-2">Mutation:</h3>
                  <LabeledTextField
                    label={populationScaled ? "4Nu" : "u"}
                    value={comp2ForwardMutation}
                    onChange={setComp2ForwardMutation}
                    type="number"
                    tooltip={populationScaled ? "Population-scaled forward mutation rate (4Nu)" : "Forward mutation rate"}
                    width="w-24"
                  />
                  <LabeledTextField
                    label={populationScaled ? "4Nv" : "v"}
                    value={comp2BackwardMutation}
                    onChange={setComp2BackwardMutation}
                    type="number"
                    tooltip={populationScaled ? "Population-scaled backward mutation rate (4Nv)" : "Backward mutation rate"}
                    width="w-24"
                  />
                  
                  <h3 className="text-sm font-medium mb-2 mt-4">Selection:</h3>
                  <LabeledTextField
                    label={populationScaled ? "2Ns" : "s"}
                    value={comp2SelectionCoeff}
                    onChange={setComp2SelectionCoeff}
                    type="number"
                    tooltip={populationScaled ? "Population-scaled selection coefficient (2Ns)" : "Selection coefficient"}
                    width="w-24"
                  />
                  <LabeledTextField
                    label="h"
                    value={comp2DominanceCoeff}
                    onChange={setComp2DominanceCoeff}
                    type="number"
                    tooltip="Dominance coefficient"
                    width="w-24"
                  />
                </>
              )}
            </div>
          </div>

          <div className="h-px bg-gray-300" />

          {/* Common Parameters Section */}
          <div>
            <h2 className="text-sm font-bold mb-2">Common Parameters:</h2>
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
              <LabeledTextField
                label="l"
                value={lambda}
                onChange={setLambda}
                type="number"
                tooltip="Transition probability"
                width="w-24"
              />
              <LabeledTextField
                label="c"
                value={integrationCutoff}
                onChange={setIntegrationCutoff}
                type="number"
                tooltip="Starting probability cutoff (Ignore rare starting copy numbers with probability below this cutoff)"
                width="w-24"
              />
              <LabeledTextField
                label="p"
                value={startingCopies}
                onChange={setStartingCopies}
                type="number"
                tooltip="Starting number of copies"
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
                tooltip="Write Q matrix to file"
              />
              <LabeledCheckBox
                label="Write R"
                checked={writeR}
                onChange={setWriteR}
                tooltip="Write R matrix to file"
              />
              <LabeledCheckBox
                label="Write N"
                checked={writeN}
                onChange={setWriteN}
                tooltip="Write N matrix to file"
              />
              <LabeledCheckBox
                label="Write B"
                checked={writeB}
                onChange={setWriteB}
                tooltip="Write B matrix to file"
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
                  <div className="text-sm text-gray-600 mb-1">Executing...</div>
                  <div className="w-full bg-gray-200 rounded-full h-2">
                    <div className="bg-blue-600 h-2 rounded-full animate-pulse" style={{ width: '50%' }}></div>
                  </div>
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
            {results && (
              <div className="space-y-1 text-sm">
                <p>T<sub>fix</sub> = {results.tFix || 'N/A'}</p>
                <p>Rate = {results.rate || 'N/A'}</p>
              </div>
            )}
            {results && (
              <button
                onClick={() => {
                  const formattedResults = `T_fix: ${results.tFix || 'N/A'}\nRate: ${results.rate || 'N/A'}`
                  navigator.clipboard.writeText(formattedResults)
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
      <div className="h-9 bg-gray-100 border-t flex items-center px-4 flex-shrink-0">
        <span className="text-sm text-gray-600">
          {isExecuting ? 'Executing WFES Sweep...' : 'Ready'}
        </span>
      </div>
    </div>
  )
}

export default WfesSweepView