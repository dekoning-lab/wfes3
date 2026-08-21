import React, { useState } from 'react'
import { LabeledTextField } from '../components/common/LabeledTextField'
import { LabeledCheckBox } from '../components/common/LabeledCheckBox'
import { LabeledComboBox } from '../components/common/LabeledComboBox'
import { wfesService } from '../services/wfesService'

interface Component {
  N: string
  G: string
  u: string
  v: string
  s: string
  h: string
}

interface WfafdViewProps {
  onBack: () => void
  hideBackButton?: boolean
}

const WfafdView: React.FC<WfafdViewProps> = ({ onBack, hideBackButton = false }) => {
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

  const [activeTab, setActiveTab] = useState(0)
  const [populationScaled, setPopulationScaled] = useState(true)
  const [components, setComponents] = useState<Component[]>([
    { N: '100', G: '100', u: '0.001', v: '0.001', s: '0', h: '0.5' }
  ])
  const [commonParams, setCommonParams] = useState({
    a: '1e-20',
    p: '10'
  })
  const [executionParams, setExecutionParams] = useState({
    force: false,
    threads: getCpuCount().toString(),
    library: getDefaultLibrary(),
    solver: 'gmres',
    initialDistribution: ''
  })
  const [results, setResults] = useState<string[]>([])
  const [isExecuting, setIsExecuting] = useState(false)
  const [progress, setProgress] = useState(0)
  const [executionTime, setExecutionTime] = useState('')

  const handlePopulationScaledToggle = (checked: boolean) => {
    setPopulationScaled(checked)
    
    // Convert all component values when toggling
    const updatedComponents = components.map(comp => {
      const N = parseFloat(comp.N) || 0
      
      if (checked) {
        // Converting to scaled values
        const scaledU = (parseFloat(comp.u) || 0) * 4 * N
        const scaledV = (parseFloat(comp.v) || 0) * 4 * N
        const scaledS = (parseFloat(comp.s) || 0) * 2 * N
        
        return {
          ...comp,
          u: scaledU.toExponential(5),
          v: scaledV.toExponential(5),
          s: scaledS.toFixed(5)
        }
      } else {
        // Converting back to unscaled values
        const unscaledU = (parseFloat(comp.u) || 0) / (4 * N)
        const unscaledV = (parseFloat(comp.v) || 0) / (4 * N)
        const unscaledS = (parseFloat(comp.s) || 0) / (2 * N)
        
        return {
          ...comp,
          u: unscaledU.toExponential(5),
          v: unscaledV.toExponential(5),
          s: unscaledS.toFixed(5)
        }
      }
    })
    
    setComponents(updatedComponents)
  }

  const addComponent = () => {
    const lastComponent = components[components.length - 1]
    // When adding a new component in scaled mode, ensure the values are properly scaled
    if (populationScaled) {
      const N = parseFloat(lastComponent.N) || 1
      // Get unscaled values
      const unscaledU = (parseFloat(lastComponent.u) || 0) / (4 * N)
      const unscaledV = (parseFloat(lastComponent.v) || 0) / (4 * N)
      const unscaledS = (parseFloat(lastComponent.s) || 0) / (2 * N)
      
      // Create new component with properly scaled values
      const newComponent = {
        ...lastComponent,
        u: (unscaledU * 4 * N).toExponential(5),
        v: (unscaledV * 4 * N).toExponential(5),
        s: (unscaledS * 2 * N).toFixed(5)
      }
      setComponents([...components, newComponent])
    } else {
      setComponents([...components, { ...lastComponent }])
    }
  }

  const removeComponent = (index: number) => {
    if (components.length > 1) {
      const newComponents = components.filter((_, i) => i !== index)
      setComponents(newComponents)
      if (activeTab >= newComponents.length) {
        setActiveTab(newComponents.length - 1)
      }
    }
  }

  const updateComponent = (index: number, field: keyof Component, value: string) => {
    const updatedComponents = [...components]
    const component = updatedComponents[index]
    
    if (field === 'N' && populationScaled) {
      // When N changes and we're in scaled mode, we need to update the scaled values
      const oldN = parseFloat(component.N) || 1
      const newN = parseFloat(value) || 1
      
      // Get unscaled values first
      const unscaledU = (parseFloat(component.u) || 0) / (4 * oldN)
      const unscaledV = (parseFloat(component.v) || 0) / (4 * oldN)
      const unscaledS = (parseFloat(component.s) || 0) / (2 * oldN)
      
      // Re-scale with new N
      const scaledU = unscaledU * 4 * newN
      const scaledV = unscaledV * 4 * newN
      const scaledS = unscaledS * 2 * newN
      
      updatedComponents[index] = {
        ...component,
        N: value,
        u: scaledU.toExponential(5),
        v: scaledV.toExponential(5),
        s: scaledS.toFixed(5)
      }
    } else {
      updatedComponents[index] = { ...updatedComponents[index], [field]: value }
    }
    
    setComponents(updatedComponents)
  }

  const handleFileSelect = async () => {
    try {
      const result = await window.api.dialog.showOpenDialog({
        filters: [{ name: 'CSV files', extensions: ['csv'] }],
        properties: ['openFile']
      })
      if (!result.canceled && result.filePaths.length > 0) {
        setExecutionParams({ ...executionParams, initialDistribution: result.filePaths[0] })
      }
    } catch (error) {
      console.error('Error selecting file:', error)
    }
  }

  const handleExecute = async () => {
    setIsExecuting(true)
    setProgress(0)
    setResults([])
    
    try {
      // Convert to unscaled values if in population-scaled mode
      const componentsToSend = populationScaled 
        ? components.map(comp => {
            const N = parseFloat(comp.N) || 1
            return {
              ...comp,
              u: ((parseFloat(comp.u) || 0) / (4 * N)).toExponential(5),
              v: ((parseFloat(comp.v) || 0) / (4 * N)).toExponential(5),
              s: ((parseFloat(comp.s) || 0) / (2 * N)).toFixed(5)
            }
          })
        : components
      
      const result = await wfesService.executeWfafd({
        components: componentsToSend,
        commonParams,
        executionParams
      })
      
      setResults(result.distribution || [])
      setExecutionTime(result.executionTime || '')
    } catch (error) {
      console.error('Execution error:', error)
    } finally {
      setIsExecuting(false)
      setProgress(100)
    }
  }

  const handleStop = () => {
    wfesService.stopExecution()
    setIsExecuting(false)
  }

  const copyToClipboard = () => {
    const text = results.join('\n')
    navigator.clipboard.writeText(text)
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
        <h1 className="native-label font-medium">WFAFD - Wright-Fisher Allele Frequency Distribution</h1>
      </div>

      <div className="flex-1 overflow-auto">
        <div className="flex gap-4 p-4">
          {/* Column 1: Components and Common Parameters */}
          <div className="flex-shrink-0 w-80">
            <div className="mb-4">
              <h3 className="text-sm font-semibold mb-2">Components:</h3>
              <div className="bg-white rounded-lg shadow-sm border border-gray-200">
                <div className="flex border-b border-gray-200">
                  {components.map((_, index) => (
                    <button
                      key={index}
                      onClick={() => setActiveTab(index)}
                      className={`px-4 py-2 text-sm font-medium border-r border-gray-200 hover:bg-gray-50 relative group ${
                        activeTab === index ? 'bg-blue-50 text-blue-600' : ''
                      }`}
                    >
                      Comp {index + 1}
                      {components.length > 1 && (
                        <svg
                          className="w-3 h-3 absolute top-1 right-1 opacity-0 group-hover:opacity-100 cursor-pointer"
                          onClick={(e) => {
                            e.stopPropagation()
                            removeComponent(index)
                          }}
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      )}
                    </button>
                  ))}
                  <button
                    className="px-4 py-2 text-sm font-medium hover:bg-gray-50 flex items-center gap-1"
                    onClick={addComponent}
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
                    </svg>
                    Add
                  </button>
                </div>
                <div className="p-4 h-64 overflow-y-auto">
                  {components[activeTab] && (
                    <div className="space-y-3">
                      <div className="grid grid-cols-2 gap-3">
                        <LabeledTextField
                          label="N:"
                          value={components[activeTab].N}
                          onChange={(value) => updateComponent(activeTab, 'N', value)}
                          tooltip="Population size"
                        />
                        <LabeledTextField
                          label="G:"
                          value={components[activeTab].G}
                          onChange={(value) => updateComponent(activeTab, 'G', value)}
                          tooltip="Number of generations"
                        />
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <LabeledTextField
                          label={populationScaled ? "4Nu:" : "u:"}
                          value={components[activeTab].u}
                          onChange={(value) => updateComponent(activeTab, 'u', value)}
                          tooltip={populationScaled ? "Population-scaled backward mutation rate (4Nu)" : "Backward mutation rate"}
                        />
                        <LabeledTextField
                          label={populationScaled ? "4Nv:" : "v:"}
                          value={components[activeTab].v}
                          onChange={(value) => updateComponent(activeTab, 'v', value)}
                          tooltip={populationScaled ? "Population-scaled forward mutation rate (4Nv)" : "Forward mutation rate"}
                        />
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <LabeledTextField
                          label={populationScaled ? "2Ns:" : "s:"}
                          value={components[activeTab].s}
                          onChange={(value) => updateComponent(activeTab, 's', value)}
                          tooltip={populationScaled ? "Population-scaled selection coefficient (2Ns)" : "Selection coefficient"}
                        />
                        <LabeledTextField
                          label="h:"
                          value={components[activeTab].h}
                          onChange={(value) => updateComponent(activeTab, 'h', value)}
                          tooltip="Dominance coefficient"
                        />
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div className="border-t border-gray-300 pt-4">
              <h3 className="text-sm font-semibold mb-2">Common Parameters:</h3>
              <div className="space-y-3">
                <LabeledCheckBox
                  label="Population-scaled parameters"
                  checked={populationScaled}
                  onChange={handlePopulationScaledToggle}
                  tooltip="Use population-scaled mutation rates (4Nu, 4Nv) and selection coefficient (2Ns)"
                />
                <LabeledTextField
                  label="a:"
                  value={commonParams.a}
                  onChange={(value) => setCommonParams({ ...commonParams, a: value })}
                  tooltip="Probability mass that is guaranteed to be above 0"
                />
                <LabeledTextField
                  label="p:"
                  value={commonParams.p}
                  onChange={(value) => setCommonParams({ ...commonParams, p: value })}
                  tooltip="Desired number of alleles"
                />
              </div>
            </div>
          </div>

          <div className="w-px bg-gray-300 self-stretch" />

          {/* Column 2: Output Options and Execution */}
          <div className="flex-shrink-0 w-80">
            <div className="mb-4">
              <h3 className="text-sm font-semibold mb-2">Output Options:</h3>
              <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
                <LabeledCheckBox
                  label="Output Distribution:"
                  checked={true}
                  onChange={() => {}}
                  disabled={true}
                  tooltip="Output allele frequency distribution"
                />
              </div>
            </div>

            <div className="border-t border-gray-300 pt-4">
              <h3 className="text-sm font-semibold mb-2">Execution:</h3>
              <div className="space-y-3">
                <div className="flex items-center gap-4">
                  <LabeledCheckBox
                    label="Force:"
                    checked={executionParams.force}
                    onChange={(checked) => setExecutionParams({ ...executionParams, force: checked })}
                    tooltip="Disable parameter range checks"
                  />
                  <LabeledTextField
                    label="t:"
                    value={executionParams.threads}
                    onChange={(value) => setExecutionParams({ ...executionParams, threads: value })}
                    tooltip="Number of threads"
                    className="flex-1"
                  />
                </div>

                <LabeledComboBox
                  label="Library:"
                  value={executionParams.library}
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
                  onChange={(value) => setExecutionParams({ ...executionParams, library: value })}
                  tooltip="Linear algebra library"
                />

                <LabeledComboBox
                  label="Solver:"
                  value={executionParams.solver}
                  options={[
                    { value: 'gmres', label: 'GMRes' },
                    { value: 'bicgstab', label: 'BicGStab' }
                  ]}
                  onChange={(value) => setExecutionParams({ ...executionParams, solver: value })}
                  tooltip="Linear solver"
                  disabled={executionParams.library !== 'vienna'}
                />

                <div className="space-y-2">
                  <LabeledTextField
                    label="Initial Distribution:"
                    value={executionParams.initialDistribution}
                    onChange={(value) => setExecutionParams({ ...executionParams, initialDistribution: value })}
                    tooltip="Path to initial distribution file"
                  />
                  <button
                    className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600 text-sm w-full"
                    onClick={handleFileSelect}
                  >
                    Browse...
                  </button>
                </div>

                <div className="flex gap-2 mt-4">
                  <button
                    className="px-4 py-2 bg-red-500 text-white rounded hover:bg-red-600 disabled:bg-gray-300 disabled:cursor-not-allowed flex-1"
                    onClick={handleStop}
                    disabled={!isExecuting}
                  >
                    Stop
                  </button>
                  <button
                    className="px-4 py-2 bg-green-500 text-white rounded hover:bg-green-600 disabled:bg-gray-300 disabled:cursor-not-allowed flex-1"
                    onClick={handleExecute}
                    disabled={isExecuting}
                  >
                    Execute
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div className="w-px bg-gray-300 self-stretch" />

          {/* Column 3: Results */}
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-semibold mb-2">Output:</h3>
            <p className="text-sm text-gray-600 mb-2">Allele Frequency Distribution:</p>
            <div className="bg-white rounded-lg shadow-sm border border-gray-200 h-64 overflow-y-auto p-2">
              {results.map((result, index) => (
                <div key={index} className="text-sm py-1 hover:bg-gray-50 px-2">
                  {result}
                </div>
              ))}
            </div>
            <button
              className="mt-4 px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600 w-full"
              onClick={copyToClipboard}
              disabled={results.length === 0}
            >
              Copy to Clipboard
            </button>
          </div>
        </div>
      </div>

      {/* Bottom bar */}
      {isExecuting && (
        <div className="border-t border-gray-300 bg-white p-4">
          <div className="flex items-center gap-4">
            <div className="flex-1">
              <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
                <div 
                  className="h-full bg-blue-500 transition-all duration-300"
                  style={{ width: `${progress}%` }}
                />
              </div>
            </div>
            <span className="text-sm text-gray-600">
              {executionTime && `Time: ${executionTime}s`}
            </span>
          </div>
        </div>
      )}
    </div>
  )
}

export default WfafdView