import React, { useState } from 'react'
import { LabeledTextField } from '../components/common/LabeledTextField'
import { LabeledCheckBox } from '../components/common/LabeledCheckBox'
import { LabeledComboBox } from '../components/common/LabeledComboBox'
import { wfesService } from '../services/wfesService'
import { numOrUndefined, intOrUndefined } from '../utils/numeric'

interface WfesSequentialViewProps {
  onBack: () => void
  hideBackButton?: boolean
}

interface Component {
  id: number
  populationSize: string
  time: string
  probability: string
  forwardMutation: string
  backwardMutation: string
  selectionCoeff: string
  dominanceCoeff: string
  startingCopies: string
}

const getCpuCount = (): number => {
  // Use navigator.hardwareConcurrency if available, otherwise default to 4
  if (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) {
    return navigator.hardwareConcurrency
  }
  return 4
}

const getDefaultLibrary = (): string => {
  // Check if we're on macOS
  const isMac = typeof navigator !== 'undefined' && 
    navigator.platform?.toLowerCase().includes('mac')
  
  return isMac ? 'accelerate' : 'pardiso'
}

const WfesSequentialView: React.FC<WfesSequentialViewProps> = ({ onBack, hideBackButton = false }) => {
  // Components state - start with 2 components
  const [components, setComponents] = useState<Component[]>([
    {
      id: 1,
      populationSize: '100',
      time: '',
      probability: '',
      forwardMutation: '0.001',
      backwardMutation: '0.001',
      selectionCoeff: '0',
      dominanceCoeff: '0.5',
      startingCopies: '1'
    },
    {
      id: 2,
      populationSize: '100',
      time: '',
      probability: '',
      forwardMutation: '0.001',
      backwardMutation: '0.001',
      selectionCoeff: '0',
      dominanceCoeff: '0.5',
      startingCopies: '1'
    }
  ])
  
  const [activeTab, setActiveTab] = useState(0)
  const [populationScaled, setPopulationScaled] = useState(true)
  
  // Common parameters
  const [alpha, setAlpha] = useState('1e-20')
  const [integrationCutoff, setIntegrationCutoff] = useState('1e-10')
  
  // Output options
  const [outputPExt, setOutputPExt] = useState(true)
  const [outputPFix, setOutputPFix] = useState(true)
  const [outputPTmo, setOutputPTmo] = useState(true)
  const [outputTExt, setOutputTExt] = useState(true)
  const [outputTExtStd, setOutputTExtStd] = useState(true)
  const [outputTFix, setOutputTFix] = useState(true)
  const [outputTFixStd, setOutputTFixStd] = useState(true)
  const [outputTTmo, setOutputTTmo] = useState(true)
  const [outputTTmoStd, setOutputTTmoStd] = useState(true)
  const [writeQ, setWriteQ] = useState(false)
  const [writeR, setWriteR] = useState(false)
  
  // Execution parameters
  const [force, setForce] = useState(false)
  const [threads, setThreads] = useState(getCpuCount().toString())
  const [library, setLibrary] = useState(getDefaultLibrary())
  const [solver, setSolver] = useState('direct')
  
  // Execution state
  const [isExecuting, setIsExecuting] = useState(false)
  const [executionTime, setExecutionTime] = useState('')
  const [results, setResults] = useState<any>(null)
  
  const addComponent = () => {
    const newId = Math.max(...components.map(c => c.id)) + 1
    setComponents([...components, {
      id: newId,
      populationSize: '',
      time: '',
      probability: '',
      forwardMutation: '',
      backwardMutation: '',
      selectionCoeff: '',
      dominanceCoeff: '0.5',
      startingCopies: ''
    }])
  }
  
  const removeComponent = (id: number) => {
    if (components.length > 2) {
      setComponents(components.filter(c => c.id !== id))
      if (activeTab >= components.length - 1) {
        setActiveTab(components.length - 2)
      }
    }
  }
  
  const updateComponent = (id: number, field: keyof Component, value: string) => {
    setComponents(components.map(c => 
      c.id === id ? { ...c, [field]: value } : c
    ))
  }
  
  const calculateTotalProbability = (): number => {
    return components.reduce((sum, c) => sum + (parseFloat(c.probability) || 0), 0)
  }
  
  const handlePopulationScaledToggle = (newValue: boolean) => {
    setPopulationScaled(newValue)
    
    // Convert all component values based on toggle
    setComponents(components.map(comp => {
      const n = parseFloat(comp.populationSize)
      
      if (!isNaN(n) && n > 0) {
        const updatedComp = { ...comp }
        
        // Convert mutation rates (4N scaling)
        if (comp.forwardMutation) {
          const u = parseFloat(comp.forwardMutation)
          if (!isNaN(u)) {
            updatedComp.forwardMutation = newValue ? (u * 4 * n).toString() : (u / (4 * n)).toString()
          }
        }
        
        if (comp.backwardMutation) {
          const v = parseFloat(comp.backwardMutation)
          if (!isNaN(v)) {
            updatedComp.backwardMutation = newValue ? (v * 4 * n).toString() : (v / (4 * n)).toString()
          }
        }
        
        // Convert selection coefficient (2N scaling)
        if (comp.selectionCoeff) {
          const s = parseFloat(comp.selectionCoeff)
          if (!isNaN(s)) {
            updatedComp.selectionCoeff = newValue ? (s * 2 * n).toString() : (s / (2 * n)).toString()
          }
        }
        
        return updatedComp
      }
      
      return comp
    }))
  }
  
  const handleExecute = async () => {
    // Validate probabilities sum to 1
    const totalProb = calculateTotalProbability()
    if (Math.abs(totalProb - 1) > 0.0001) {
      alert(`Component probabilities must sum to 1 (current sum: ${totalProb.toFixed(4)})`)
      return
    }
    
    const params = {
      components: components.map(c => {
        const n = parseInt(c.populationSize)
        const baseParams = {
          populationSize: n || undefined,
          time: numOrUndefined(c.time),
          probability: numOrUndefined(c.probability),
          dominanceCoeff: parseFloat(c.dominanceCoeff),
          startingCopies: intOrUndefined(c.startingCopies)
        }
        
        // Convert scaled values back to unscaled for backend if population scaling is enabled
        if (populationScaled && n) {
          return {
            ...baseParams,
            forwardMutation: c.forwardMutation ? parseFloat(c.forwardMutation) / (4 * n) : undefined,
            backwardMutation: c.backwardMutation ? parseFloat(c.backwardMutation) / (4 * n) : undefined,
            selectionCoeff: c.selectionCoeff ? parseFloat(c.selectionCoeff) / (2 * n) : undefined
          }
        } else {
          return {
            ...baseParams,
            forwardMutation: numOrUndefined(c.forwardMutation),
            backwardMutation: numOrUndefined(c.backwardMutation),
            selectionCoeff: numOrUndefined(c.selectionCoeff)
          }
        }
      }),
      alpha: numOrUndefined(alpha),
      integrationCutoff: numOrUndefined(integrationCutoff),
      outputOptions: {
        outputPExt, outputPFix, outputPTmo, 
        outputTExt, outputTExtStd, outputTFix, 
        outputTFixStd, outputTTmo, outputTTmoStd,
        writeQ, writeR
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
      const response = await wfesService.executeSequential(params)
      
      if (response.success) {
        setResults(response.results)
        setExecutionTime(response.executionTime)
      } else {
        alert(`Execution failed: ${response.error || 'Unknown error'}`)
      }
    } catch (error) {
      console.error('Execution error:', error)
      alert('Failed to execute WFES Sequential')
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
        <h1 className="native-label font-medium">WFES Sequential</h1>
      </div>

      {/* Main content area with three columns */}
      <div className="flex-1 flex p-4 gap-4 overflow-auto min-h-0">
        {/* Column 1: Components */}
        <div className="flex-1 min-w-[300px] space-y-4">
          <div>
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-sm font-bold">Components:</h2>
              <button
                onClick={addComponent}
                className="px-2 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700"
              >
                Add Component
              </button>
            </div>
            
            {/* Component Tabs */}
            <div className="flex border-b mb-3 overflow-x-auto">
              {components.map((comp, index) => (
                <button
                  key={comp.id}
                  onClick={() => setActiveTab(index)}
                  className={`px-4 py-2 text-sm font-medium whitespace-nowrap ${
                    activeTab === index
                      ? 'border-b-2 border-blue-600 text-blue-600'
                      : 'text-gray-600 hover:text-gray-800'
                  }`}
                >
                  Component {index + 1}
                </button>
              ))}
            </div>
            
            {/* Component Content */}
            {components[activeTab] && (
              <div className="space-y-4">
                <div className="ml-4 space-y-2">
                  <LabeledTextField
                    label="N"
                    value={components[activeTab].populationSize}
                    onChange={(v) => updateComponent(components[activeTab].id, 'populationSize', v)}
                    type="number"
                    tooltip="Population size"
                    width="w-24"
                  />
                  <LabeledTextField
                    label="t"
                    value={components[activeTab].time}
                    onChange={(v) => updateComponent(components[activeTab].id, 'time', v)}
                    type="number"
                    tooltip="Time in generations"
                    width="w-24"
                  />
                  <LabeledTextField
                    label="pr"
                    value={components[activeTab].probability}
                    onChange={(v) => updateComponent(components[activeTab].id, 'probability', v)}
                    type="number"
                    tooltip="Component probability"
                    width="w-24"
                    error={components[activeTab].probability !== '' && (parseFloat(components[activeTab].probability) < 0 || parseFloat(components[activeTab].probability) > 1)}
                    helperText={components[activeTab].probability !== '' && (parseFloat(components[activeTab].probability) < 0 || parseFloat(components[activeTab].probability) > 1) ? 'Must be between 0 and 1' : ''}
                  />
                  <p className="text-xs text-gray-600">Total probability: {calculateTotalProbability().toFixed(4)}</p>
                  
                  <LabeledTextField
                    label="p"
                    value={components[activeTab].startingCopies}
                    onChange={(v) => updateComponent(components[activeTab].id, 'startingCopies', v)}
                    type="number"
                    tooltip="Starting copies"
                    width="w-24"
                  />
                </div>
                
                <div className="h-px bg-gray-300" />
                
                <div>
                  <h3 className="text-sm font-medium mb-2 ml-4">Mutation:</h3>
                  <div className="ml-4 space-y-2">
                    <LabeledTextField
                      label={populationScaled ? "4Nu" : "u"}
                      value={components[activeTab].forwardMutation}
                      onChange={(v) => updateComponent(components[activeTab].id, 'forwardMutation', v)}
                      type="number"
                      tooltip={populationScaled ? "Scaled forward mutation rate (4Nu)" : "Forward mutation rate"}
                      width="w-24"
                    />
                    <LabeledTextField
                      label={populationScaled ? "4Nv" : "v"}
                      value={components[activeTab].backwardMutation}
                      onChange={(v) => updateComponent(components[activeTab].id, 'backwardMutation', v)}
                      type="number"
                      tooltip={populationScaled ? "Scaled backward mutation rate (4Nv)" : "Backward mutation rate"}
                      width="w-24"
                    />
                  </div>
                </div>
                
                <div className="h-px bg-gray-300" />
                
                <div>
                  <h3 className="text-sm font-medium mb-2 ml-4">Selection:</h3>
                  <div className="ml-4 space-y-2">
                    <LabeledTextField
                      label={populationScaled ? "2Ns" : "s"}
                      value={components[activeTab].selectionCoeff}
                      onChange={(v) => updateComponent(components[activeTab].id, 'selectionCoeff', v)}
                      type="number"
                      tooltip={populationScaled ? "Scaled selection coefficient (2Ns)" : "Selection coefficient"}
                      width="w-24"
                    />
                    <LabeledTextField
                      label="h"
                      value={components[activeTab].dominanceCoeff}
                      onChange={(v) => updateComponent(components[activeTab].id, 'dominanceCoeff', v)}
                      type="number"
                      tooltip="Dominance coefficient"
                      width="w-24"
                    />
                  </div>
                </div>
                
                {components.length > 2 && (
                  <button
                    onClick={() => removeComponent(components[activeTab].id)}
                    className="ml-4 px-3 py-1 text-sm bg-red-600 text-white rounded hover:bg-red-700"
                  >
                    Remove Component
                  </button>
                )}
              </div>
            )}
          </div>
          
          <div className="h-px bg-gray-300" />
          
          {/* Common Parameters */}
          <div>
            <h2 className="text-sm font-bold mb-2">Common Parameters:</h2>
            <div className="ml-4 space-y-2">
              <LabeledCheckBox
                label="Population Scaled"
                checked={populationScaled}
                onChange={handlePopulationScaledToggle}
                tooltip="Toggle population-scaled parameters"
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
                label="c"
                value={integrationCutoff}
                onChange={setIntegrationCutoff}
                type="number"
                tooltip="Starting probability cutoff (Ignore rare starting copy numbers with probability below this cutoff)"
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
              <LabeledCheckBox label="p_ext" checked={outputPExt} onChange={setOutputPExt} />
              <LabeledCheckBox label="p_fix" checked={outputPFix} onChange={setOutputPFix} />
              <LabeledCheckBox label="p_tmo" checked={outputPTmo} onChange={setOutputPTmo} />
              <LabeledCheckBox label="t_ext" checked={outputTExt} onChange={setOutputTExt} />
              <LabeledCheckBox label="t_ext_std" checked={outputTExtStd} onChange={setOutputTExtStd} />
              <LabeledCheckBox label="t_fix" checked={outputTFix} onChange={setOutputTFix} />
              <LabeledCheckBox label="t_fix_std" checked={outputTFixStd} onChange={setOutputTFixStd} />
              <LabeledCheckBox label="t_tmo" checked={outputTTmo} onChange={setOutputTTmo} />
              <LabeledCheckBox label="t_tmo_std" checked={outputTTmoStd} onChange={setOutputTTmoStd} />
              <LabeledCheckBox label="Write Q" checked={writeQ} onChange={setWriteQ} />
              <LabeledCheckBox label="Write R" checked={writeR} onChange={setWriteR} />
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
                options={[
                  ...(typeof navigator !== 'undefined' && navigator.platform?.toLowerCase().includes('mac') 
                    ? [{ value: 'accelerate', label: 'Accelerate' }]
                    : [{ value: 'pardiso', label: 'Pardiso' }]),
                  { value: 'vienna', label: 'ViennaCL' }
                ]}
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
                  disabled={isExecuting || components.some(c => !c.populationSize)}
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
                {outputPExt && <p>p_ext = {results.pExt || 'N/A'}</p>}
                {outputPFix && <p>p_fix = {results.pFix || 'N/A'}</p>}
                {outputPTmo && <p>p_tmo = {results.pTmo || 'N/A'}</p>}
                {outputTExt && <p>t_ext = {results.tExt || 'N/A'}</p>}
                {outputTExtStd && <p>t_ext_std = {results.tExtStd || 'N/A'}</p>}
                {outputTFix && <p>t_fix = {results.tFix || 'N/A'}</p>}
                {outputTFixStd && <p>t_fix_std = {results.tFixStd || 'N/A'}</p>}
                {outputTTmo && <p>t_tmo = {results.tTmo || 'N/A'}</p>}
                {outputTTmoStd && <p>t_tmo_std = {results.tTmoStd || 'N/A'}</p>}
              </div>
            )}
            {results && (
              <button
                onClick={() => {
                  const lines = []
                  if (outputPExt) lines.push(`p_ext: ${results.pExt || 'N/A'}`)
                  if (outputPFix) lines.push(`p_fix: ${results.pFix || 'N/A'}`)
                  if (outputPTmo) lines.push(`p_tmo: ${results.pTmo || 'N/A'}`)
                  if (outputTExt) lines.push(`t_ext: ${results.tExt || 'N/A'}`)
                  if (outputTExtStd) lines.push(`t_ext_std: ${results.tExtStd || 'N/A'}`)
                  if (outputTFix) lines.push(`t_fix: ${results.tFix || 'N/A'}`)
                  if (outputTFixStd) lines.push(`t_fix_std: ${results.tFixStd || 'N/A'}`)
                  if (outputTTmo) lines.push(`t_tmo: ${results.tTmo || 'N/A'}`)
                  if (outputTTmoStd) lines.push(`t_tmo_std: ${results.tTmoStd || 'N/A'}`)
                  navigator.clipboard.writeText(lines.join('\n'))
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
          {isExecuting ? 'Executing WFES Sequential...' : 'Ready'}
        </span>
      </div>
    </div>
  )
}

export default WfesSequentialView