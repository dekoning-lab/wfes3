import React, { useState } from 'react'
import { LabeledTextField } from '../components/common/LabeledTextField'
import { LabeledCheckBox } from '../components/common/LabeledCheckBox'
import { LabeledComboBox } from '../components/common/LabeledComboBox'
import { wfesService } from '../services/wfesService'
import { numOrUndefined, intOrUndefined } from '../utils/numeric'

interface WfesSwitchingViewProps {
  onBack: () => void
  hideBackButton?: boolean
}

interface Component {
  id: number
  populationSize: string
  startingCopies: string
  switchingRates: string[]
  forwardMutation: string
  backwardMutation: string
  selectionCoeff: string
  dominanceCoeff: string
}

const WfesSwitchingView: React.FC<WfesSwitchingViewProps> = ({ onBack, hideBackButton = false }) => {
  // Helper functions
  const getCpuCount = (): number => {
    // Use navigator.hardwareConcurrency to get logical CPU cores
    // Default to 1 if not available
    return navigator.hardwareConcurrency || 1
  }

  const getDefaultLibrary = (): string => {
    // Check if running on macOS
    const isMac = navigator.platform.toLowerCase().includes('mac') || 
                  navigator.userAgent.toLowerCase().includes('mac')
    
    return isMac ? 'accelerate' : 'pardiso'
  }

  // Mode state
  const [mode, setMode] = useState<'absorption' | 'fixation'>('absorption')
  
  // Population scaling state
  const [populationScaled, setPopulationScaled] = useState(true)
  
  // Components state - start with 2 components
  const [components, setComponents] = useState<Component[]>([
    {
      id: 1,
      populationSize: '100',
      startingCopies: '1',
      switchingRates: ['0.01', '0.01'],
      forwardMutation: '0.001',
      backwardMutation: '0.001',
      selectionCoeff: '0',
      dominanceCoeff: '0.5'
    },
    {
      id: 2,
      populationSize: '100',
      startingCopies: '1',
      switchingRates: ['0.01', '0.01'],
      forwardMutation: '0.001',
      backwardMutation: '0.001',
      selectionCoeff: '0',
      dominanceCoeff: '0.5'
    }
  ])
  
  const [activeTab, setActiveTab] = useState(0)
  
  // Common parameters
  const [alpha, setAlpha] = useState('1e-20')
  const [integrationCutoff, setIntegrationCutoff] = useState('1e-10')
  
  // Output options
  const [writeQ, setWriteQ] = useState(false)
  const [writeR, setWriteR] = useState(false)
  const [writeN, setWriteN] = useState(false)
  const [writeB, setWriteB] = useState(false)
  const [writeNExt, setWriteNExt] = useState(false)
  const [writeNFix, setWriteNFix] = useState(false)
  const [writeRes, setWriteRes] = useState(false)
  
  // Execution parameters
  const [force, setForce] = useState(false)
  const [threads, setThreads] = useState(String(getCpuCount()))
  const [library, setLibrary] = useState(getDefaultLibrary())
  const [solver, setSolver] = useState('direct')
  
  // Execution state
  const [isExecuting, setIsExecuting] = useState(false)
  const [executionTime, setExecutionTime] = useState('')
  const [results, setResults] = useState<any>(null)
  
  const addComponent = () => {
    const newId = Math.max(...components.map(c => c.id)) + 1
    const newSwitchingRates = new Array(components.length + 1).fill('')
    
    // Update existing components' switching rates arrays
    const updatedComponents = components.map(c => ({
      ...c,
      switchingRates: [...c.switchingRates, '']
    }))
    
    setComponents([...updatedComponents, {
      id: newId,
      populationSize: '',
      startingCopies: '',
      switchingRates: newSwitchingRates,
      forwardMutation: '',
      backwardMutation: '',
      selectionCoeff: '',
      dominanceCoeff: '0.5'
    }])
  }
  
  const removeComponent = (id: number) => {
    if (components.length > 2) {
      const indexToRemove = components.findIndex(c => c.id === id)
      const updatedComponents = components
        .filter(c => c.id !== id)
        .map(c => ({
          ...c,
          switchingRates: c.switchingRates.filter((_, i) => i !== indexToRemove)
        }))
      
      setComponents(updatedComponents)
      if (activeTab >= updatedComponents.length) {
        setActiveTab(updatedComponents.length - 1)
      }
    }
  }
  
  const updateComponent = (id: number, field: keyof Component, value: any) => {
    setComponents(components.map(c => 
      c.id === id ? { ...c, [field]: value } : c
    ))
  }
  
  const updateSwitchingRate = (id: number, index: number, value: string) => {
    setComponents(components.map(c => {
      if (c.id === id) {
        const newRates = [...c.switchingRates]
        newRates[index] = value
        return { ...c, switchingRates: newRates }
      }
      return c
    }))
  }
  
  const handlePopulationScalingToggle = (newValue: boolean) => {
    // Convert all mutation and selection values when toggling
    const updatedComponents = components.map(comp => {
      const N = parseInt(comp.populationSize) || 1
      
      if (newValue) {
        // Converting from unscaled to scaled
        return {
          ...comp,
          forwardMutation: comp.forwardMutation ? String(parseFloat(comp.forwardMutation) * 4 * N) : '',
          backwardMutation: comp.backwardMutation ? String(parseFloat(comp.backwardMutation) * 4 * N) : '',
          selectionCoeff: comp.selectionCoeff ? String(parseFloat(comp.selectionCoeff) * 2 * N) : ''
        }
      } else {
        // Converting from scaled to unscaled
        return {
          ...comp,
          forwardMutation: comp.forwardMutation ? String(parseFloat(comp.forwardMutation) / (4 * N)) : '',
          backwardMutation: comp.backwardMutation ? String(parseFloat(comp.backwardMutation) / (4 * N)) : '',
          selectionCoeff: comp.selectionCoeff ? String(parseFloat(comp.selectionCoeff) / (2 * N)) : ''
        }
      }
    })
    
    setComponents(updatedComponents)
    setPopulationScaled(newValue)
  }
  
  const handleExecute = async () => {
    const params = {
      mode,
      components: components.map(c => {
        const N = parseInt(c.populationSize) || 1
        
        // Convert scaled values back to unscaled for backend
        const forwardMut = c.forwardMutation ? parseFloat(c.forwardMutation) : undefined
        const backwardMut = c.backwardMutation ? parseFloat(c.backwardMutation) : undefined
        const selCoeff = c.selectionCoeff ? parseFloat(c.selectionCoeff) : undefined
        
        return {
          populationSize: intOrUndefined(c.populationSize),
          startingCopies: intOrUndefined(c.startingCopies),
          switchingRates: c.switchingRates.map(r => parseFloat(r) || 0),
          forwardMutation: populationScaled && forwardMut !== undefined ? forwardMut / (4 * N) : forwardMut,
          backwardMutation: populationScaled && backwardMut !== undefined ? backwardMut / (4 * N) : backwardMut,
          selectionCoeff: populationScaled && selCoeff !== undefined ? selCoeff / (2 * N) : selCoeff,
          dominanceCoeff: parseFloat(c.dominanceCoeff)
        }
      }),
      alpha: numOrUndefined(alpha),
      integrationCutoff: numOrUndefined(integrationCutoff),
      outputOptions: {
        writeQ, writeR, writeN, writeB, writeNExt, writeNFix, writeRes
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
      const response = await wfesService.executeSwitching(params)
      
      if (response.success) {
        setResults(response.results)
        setExecutionTime(response.executionTime)
      } else {
        alert(`Execution failed: ${response.error || 'Unknown error'}`)
      }
    } catch (error) {
      console.error('Execution error:', error)
      alert('Failed to execute WFES Switching')
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
        <h1 className="native-label font-medium">WFES Switching</h1>
      </div>

      {/* Main content area with three columns */}
      <div className="flex-1 flex p-4 gap-4 overflow-auto min-h-0">
        {/* Column 1: Mode & Components */}
        <div className="flex-1 min-w-[350px] space-y-4 overflow-y-auto">
          {/* Mode Section */}
          <div>
            <h2 className="text-sm font-bold mb-2">Mode:</h2>
            <div className="ml-4 space-y-2">
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="mode"
                  value="absorption"
                  checked={mode === 'absorption'}
                  onChange={(e) => setMode(e.target.value as 'absorption')}
                  className="text-blue-600"
                />
                <span className="text-sm">Absorption</span>
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="mode"
                  value="fixation"
                  checked={mode === 'fixation'}
                  onChange={(e) => setMode(e.target.value as 'fixation')}
                  className="text-blue-600"
                />
                <span className="text-sm">Fixation</span>
              </label>
            </div>
          </div>
          
          <div className="h-px bg-gray-300" />
          
          {/* Population Scaling */}
          <div>
            <LabeledCheckBox
              label="Population-scaled parameters"
              checked={populationScaled}
              onChange={handlePopulationScalingToggle}
              tooltip="Scale mutation rates by 4N and selection by 2N"
            />
          </div>
          
          <div className="h-px bg-gray-300" />
          
          {/* Components Section */}
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
                  <h3 className="text-sm font-medium mb-2 ml-4">Switching Rates (r):</h3>
                  <div className="ml-4 space-y-2">
                    {components.map((_, index) => (
                      <LabeledTextField
                        key={index}
                        label={`To comp ${index + 1}`}
                        value={components[activeTab].switchingRates[index]}
                        onChange={(v) => updateSwitchingRate(components[activeTab].id, index, v)}
                        type="number"
                        tooltip={`Rate of switching to component ${index + 1}`}
                        width="w-24"
                        disabled={index === activeTab}
                      />
                    ))}
                  </div>
                </div>
                
                <div className="h-px bg-gray-300" />
                
                <div>
                  <h3 className="text-sm font-medium mb-2 ml-4">Mutation:</h3>
                  <div className="ml-4 space-y-2">
                    <LabeledTextField
                      label={populationScaled ? "u (4Nu)" : "u"}
                      value={components[activeTab].forwardMutation}
                      onChange={(v) => updateComponent(components[activeTab].id, 'forwardMutation', v)}
                      type="number"
                      tooltip={populationScaled ? "Forward mutation rate (scaled by 4N)" : "Forward mutation rate"}
                      width="w-24"
                    />
                    <LabeledTextField
                      label={populationScaled ? "v (4Nv)" : "v"}
                      value={components[activeTab].backwardMutation}
                      onChange={(v) => updateComponent(components[activeTab].id, 'backwardMutation', v)}
                      type="number"
                      tooltip={populationScaled ? "Backward mutation rate (scaled by 4N)" : "Backward mutation rate"}
                      width="w-24"
                    />
                  </div>
                </div>
                
                <div className="h-px bg-gray-300" />
                
                <div>
                  <h3 className="text-sm font-medium mb-2 ml-4">Selection:</h3>
                  <div className="ml-4 space-y-2">
                    <LabeledTextField
                      label={populationScaled ? "s (2Ns)" : "s"}
                      value={components[activeTab].selectionCoeff}
                      onChange={(v) => updateComponent(components[activeTab].id, 'selectionCoeff', v)}
                      type="number"
                      tooltip={populationScaled ? "Selection coefficient (scaled by 2N)" : "Selection coefficient"}
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
                disabled={mode === 'fixation'}
              />
              <LabeledCheckBox
                label="Write B"
                checked={writeB}
                onChange={setWriteB}
                tooltip="Write B matrix to file"
              />
              {mode === 'absorption' && (
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
                label="Write Res"
                checked={writeRes}
                onChange={setWriteRes}
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
                  const isMac = navigator.platform.toLowerCase().includes('mac') || 
                               navigator.userAgent.toLowerCase().includes('mac')
                  
                  if (isMac) {
                    return [
                      { value: 'accelerate', label: 'Accelerate' },
                      { value: 'vienna', label: 'ViennaCL' }
                    ]
                  } else {
                    return [
                      { value: 'pardiso', label: 'Pardiso' },
                      { value: 'vienna', label: 'ViennaCL' }
                    ]
                  }
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
                {mode === 'absorption' ? (
                  <>
                    <p>P<sub>ext</sub> = {results.pExt || 'N/A'}</p>
                    <p>P<sub>fix</sub> = {results.pFix || 'N/A'}</p>
                    <p>T<sub>abs</sub> = {results.tAbs || 'N/A'}</p>
                    <p>T<sub>abs</sub> Std = {results.tAbsStd || 'N/A'}</p>
                    <p>T<sub>ext</sub> = {results.tExt || 'N/A'}</p>
                    <p>T<sub>ext</sub> Std = {results.tExtStd || 'N/A'}</p>
                    <p>T<sub>fix</sub> = {results.tFix || 'N/A'}</p>
                    <p>T<sub>fix</sub> Std = {results.tFixStd || 'N/A'}</p>
                  </>
                ) : (
                  <>
                    <p>T<sub>fix</sub> = {results.tFix || 'N/A'}</p>
                    <p>Rate = {results.rate || 'N/A'}</p>
                  </>
                )}
              </div>
            )}
            {results && (
              <button
                onClick={() => {
                  const lines = []
                  if (mode === 'absorption') {
                    lines.push(`P_ext: ${results.pExt || 'N/A'}`)
                    lines.push(`P_fix: ${results.pFix || 'N/A'}`)
                    lines.push(`T_abs: ${results.tAbs || 'N/A'}`)
                    lines.push(`T_abs_std: ${results.tAbsStd || 'N/A'}`)
                    lines.push(`T_ext: ${results.tExt || 'N/A'}`)
                    lines.push(`T_ext_std: ${results.tExtStd || 'N/A'}`)
                    lines.push(`T_fix: ${results.tFix || 'N/A'}`)
                    lines.push(`T_fix_std: ${results.tFixStd || 'N/A'}`)
                  } else {
                    lines.push(`T_fix: ${results.tFix || 'N/A'}`)
                    lines.push(`Rate: ${results.rate || 'N/A'}`)
                  }
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
          {isExecuting ? 'Executing WFES Switching...' : 'Ready'}
        </span>
      </div>
    </div>
  )
}

export default WfesSwitchingView