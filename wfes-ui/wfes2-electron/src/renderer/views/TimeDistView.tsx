import React, { useState } from 'react'
import { LabeledTextField } from '../components/common/LabeledTextField'
import { LabeledCheckBox } from '../components/common/LabeledCheckBox'
import { LabeledComboBox } from '../components/common/LabeledComboBox'
import TimeDistChart from '../components/TimeDistChart'
import TimeDistChartWindow from '../components/TimeDistChartWindow'
import { wfesService } from '../services/wfesService'

interface TimeDistViewProps {
  onBack: () => void
  hideBackButton?: boolean
}

type ModeType = 'time-dist' | 'time-dist-sgv' | 'time-dist-skip'

interface Component {
  N: string
  s: string
  h: string
  u: string
  v: string
}

const TimeDistView: React.FC<TimeDistViewProps> = ({ onBack, hideBackButton = false }) => {
  const [mode, setMode] = useState<ModeType>('time-dist')
  const [activeTab, setActiveTab] = useState(0)
  const [components, setComponents] = useState<Component[]>([
    { N: '100', s: '0', h: '0.5', u: '0.001', v: '0.001' }
  ])
  const [populationScaled, setPopulationScaled] = useState(true)
  
  // Population parameters
  const [populationParams, setPopulationParams] = useState({
    N: '100',
    a: '1e-20',
    l: '10',
    c: '0.999',
    m: '100000'
  })
  
  // Common parameters for SGV mode
  const [sgvCommonParams, setSgvCommonParams] = useState({
    a: '0.01',
    l: '10',
    c: '10',
    m: '10'
  })
  
  // Mutation parameters
  const [mutationParams, setMutationParams] = useState({
    u: '0.001',
    v: '0.001'
  })
  
  // No recurrent mutation checkbox
  const [noRecurrentMutation, setNoRecurrentMutation] = useState(false)
  
  // Handle population scaling toggle
  const handlePopulationScaledToggle = (newValue: boolean) => {
    if (newValue && !populationScaled) {
      // Converting from raw to scaled values
      if (mode === 'time-dist-sgv') {
        // Update components
        const updatedComponents = components.map(comp => {
          const N = parseInt(comp.N) || 1000
          const rawU = parseFloat(comp.u) || 0
          const rawV = parseFloat(comp.v) || 0
          const rawS = parseFloat(comp.s) || 0
          
          return {
            ...comp,
            u: (rawU * 4 * N).toExponential(3),
            v: (rawV * 4 * N).toExponential(3),
            s: rawS === 0 ? '0' : (rawS * 2 * N).toString()
          }
        })
        setComponents(updatedComponents)
      } else {
        // Update main mutation/selection params
        const N = parseInt(populationParams.N) || 1000
        const rawU = parseFloat(mutationParams.u) || 0
        const rawV = parseFloat(mutationParams.v) || 0
        const rawS = parseFloat(selectionParams.s) || 0
        
        setMutationParams({
          ...mutationParams,
          u: (rawU * 4 * N).toExponential(3),
          v: (rawV * 4 * N).toExponential(3)
        })
        setSelectionParams({
          ...selectionParams,
          s: rawS === 0 ? '0' : (rawS * 2 * N).toString()
        })
      }
    } else if (!newValue && populationScaled) {
      // Converting from scaled to raw values
      if (mode === 'time-dist-sgv') {
        // Update components
        const updatedComponents = components.map(comp => {
          const N = parseInt(comp.N) || 1000
          const scaledU = parseFloat(comp.u) || 0
          const scaledV = parseFloat(comp.v) || 0
          const scaledS = parseFloat(comp.s) || 0
          
          return {
            ...comp,
            u: (scaledU / (4 * N)).toExponential(3),
            v: (scaledV / (4 * N)).toExponential(3),
            s: scaledS === 0 ? '0' : (scaledS / (2 * N)).toExponential(3)
          }
        })
        setComponents(updatedComponents)
      } else {
        // Update main mutation/selection params
        const N = parseInt(populationParams.N) || 1000
        const scaledU = parseFloat(mutationParams.u) || 0
        const scaledV = parseFloat(mutationParams.v) || 0
        const scaledS = parseFloat(selectionParams.s) || 0
        
        setMutationParams({
          ...mutationParams,
          u: (scaledU / (4 * N)).toExponential(3),
          v: (scaledV / (4 * N)).toExponential(3)
        })
        setSelectionParams({
          ...selectionParams,
          s: scaledS === 0 ? '0' : (scaledS / (2 * N)).toExponential(3)
        })
      }
    }
    
    setPopulationScaled(newValue)
  }
  
  // Selection parameters
  const [selectionParams, setSelectionParams] = useState({
    s: '0',
    h: '0.5'
  })
  
  // Output options
  const [outputOptions, setOutputOptions] = useState({
    Q: false,
    R: false,
    P: false,
    Res: true
  })
  
  // Get CPU count for default threads
  const getCpuCount = () => {
    return navigator.hardwareConcurrency || 4
  }

  // Detect platform for library default
  const getDefaultLibrary = () => {
    if (typeof navigator !== 'undefined' && navigator.platform) {
      return navigator.platform.toLowerCase().includes('mac') ? 'Accelerate' : 'Pardiso'
    }
    return 'Accelerate' // Default to accelerate for development
  }

  // Execution parameters
  const [executionParams, setExecutionParams] = useState({
    force: false,
    threads: getCpuCount().toString(),
    library: getDefaultLibrary()
  })
  
  const [results, setResults] = useState<string[]>([])
  const [distribution, setDistribution] = useState<any[]>([])
  const [isExecuting, setIsExecuting] = useState(false)
  const [progress, setProgress] = useState(0)
  const [executionTime, setExecutionTime] = useState('')
  const [showChartWindow, setShowChartWindow] = useState(false)
  
  const addComponent = () => {
    const lastComponent = components[components.length - 1]
    setComponents([...components, { ...lastComponent }])
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
    updatedComponents[index] = { ...updatedComponents[index], [field]: value }
    setComponents(updatedComponents)
  }
  
  const handleExecute = async () => {
    setIsExecuting(true)
    setProgress(0)
    setResults([])
    
    // Set up progress listener
    window.api.wfes.onProgress((data) => {
      if (data.progress !== undefined) {
        setProgress(data.progress)
      }
      if (data.executionTime) {
        setExecutionTime(data.executionTime)
      }
    })
    
    try {
      // Convert population-scaled values to raw values if needed
      let processedComponents = components
      let processedMutationParams = mutationParams
      let processedSelectionParams = selectionParams
      
      if (populationScaled) {
        if (mode === 'time-dist-sgv') {
          // Convert components
          processedComponents = components.map(comp => {
            const N = parseInt(comp.N) || 1000
            return {
              ...comp,
              u: (parseFloat(comp.u) / (4 * N)).toString(),
              v: (parseFloat(comp.v) / (4 * N)).toString(),
              s: (parseFloat(comp.s) / (2 * N)).toString()
            }
          })
        } else {
          // Convert main params
          const N = parseInt(populationParams.N) || 1000
          processedMutationParams = {
            ...mutationParams,
            u: (parseFloat(mutationParams.u) / (4 * N)).toString(),
            v: (parseFloat(mutationParams.v) / (4 * N)).toString()
          }
          processedSelectionParams = {
            ...selectionParams,
            s: (parseFloat(selectionParams.s) / (2 * N)).toString()
          }
        }
      }
      
      const result = await wfesService.executeTimeDist({
        mode,
        components: mode === 'time-dist-sgv' ? processedComponents : undefined,
        populationParams: mode !== 'time-dist-sgv' ? populationParams : undefined,
        sgvCommonParams: mode === 'time-dist-sgv' ? sgvCommonParams : undefined,
        mutationParams: mode !== 'time-dist-sgv' ? processedMutationParams : undefined,
        selectionParams: mode !== 'time-dist-sgv' ? processedSelectionParams : undefined,
        noRecurrentMutation: mode !== 'time-dist-sgv' ? noRecurrentMutation : undefined,
        outputOptions,
        executionParams
      })
      
      setResults(result.results || [])
      setDistribution(result.distribution || [])
      setExecutionTime(result.executionTime || '')
    } catch (error) {
      console.error('Execution error:', error)
    } finally {
      setIsExecuting(false)
      setProgress(100)
      // Clean up progress listener
      window.api.wfes.removeProgressListener()
    }
  }
  
  const handleStop = () => {
    wfesService.stopExecution()
    setIsExecuting(false)
  }
  
  const exportData = (format: 'tsv' | 'csv') => {
    if (!distribution || distribution.length === 0) return
    
    const delimiter = format === 'tsv' ? '\t' : ','
    const headers = ['Time', 'P(ext)', 'P(fix)', 'P(total)', 'CDF(ext)', 'CDF(fix)', 'CDF(total)']
    
    let content = headers.join(delimiter) + '\n'
    content += distribution.map(row => 
      [
        row.time,
        row.p_ext.toExponential(6),
        row.p_fix.toExponential(6),
        row.p_total.toExponential(6),
        (row.cdf_ext || row.cdf || 0).toExponential(6),
        (row.cdf_fix || 0).toExponential(6),
        (row.cdf_total || row.cdf || 0).toExponential(6)
      ].join(delimiter)
    ).join('\n')
    
    // Create blob and download
    const blob = new Blob([content], { type: format === 'tsv' ? 'text/tab-separated-values' : 'text/csv' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `time_dist_${new Date().toISOString().slice(0, 10)}.${format}`
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
  }
  
  const calculateStats = () => {
    if (!distribution || distribution.length === 0) {
      return { meanExt: 0, meanFix: 0, stdExt: 0, stdFix: 0, cdfExt: 0, cdfFix: 0 }
    }
    
    let meanExt = 0
    let meanFix = 0
    let m2Ext = 0
    let m2Fix = 0
    let cdfExt = 0
    let cdfFix = 0

    distribution.forEach((row) => {
      const t = row.time
      meanExt += t * row.p_ext
      meanFix += t * row.p_fix
      m2Ext += t * t * row.p_ext
      m2Fix += t * t * row.p_fix
      cdfExt += row.p_ext
      cdfFix += row.p_fix
    })

    const stats = {
      meanExt: cdfExt > 0 ? meanExt / cdfExt : 0,
      meanFix: cdfFix > 0 ? meanFix / cdfFix : 0,
      stdExt: 0,
      stdFix: 0,
      cdfExt,
      cdfFix
    }

    // Calculate standard deviations
    if (cdfExt > 0) {
      const m2ExtCond = m2Ext / cdfExt
      stats.stdExt = Math.sqrt(m2ExtCond - stats.meanExt * stats.meanExt)
    }
    if (cdfFix > 0) {
      const m2FixCond = m2Fix / cdfFix
      stats.stdFix = Math.sqrt(m2FixCond - stats.meanFix * stats.meanFix)
    }

    return stats
  }
  
  const copyToClipboard = () => {
    let text = ''
    
    // For time-dist mode, include both distribution data and summary stats
    if (mode === 'time-dist' && distribution && distribution.length > 0) {
      text += 'Time\tP(ext)\tP(fix)\tP(total)\tCDF(ext)\tCDF(fix)\tCDF(total)\n'
      text += distribution.map(row => 
        `${row.time}\t${row.p_ext.toExponential(6)}\t${row.p_fix.toExponential(6)}\t${row.p_total.toExponential(6)}\t${(row.cdf_ext || row.cdf || 0).toExponential(6)}\t${(row.cdf_fix || 0).toExponential(6)}\t${(row.cdf_total || row.cdf || 0).toExponential(6)}`
      ).join('\n')
      
      if (results.length > 0) {
        text += '\n\n' + results.join('\n')
      }
    } else {
      text = results.join('\n')
    }
    
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
        <h1 className="native-label font-medium">Time Distribution</h1>
      </div>
      
      <div className="flex-1 overflow-auto">
        <div className="flex gap-4 p-4">
          {/* Column 1: Mode and Parameters */}
          <div className="flex-shrink-0" style={{ width: '450px' }}>
            <div className="mb-4">
              <h3 className="text-sm font-bold mb-2">Mode:</h3>
              <div className="native-panel p-4">
                <div className="space-y-2">
                  <label className="flex items-center">
                    <input
                      type="radio"
                      className="mr-2"
                      checked={mode === 'time-dist'}
                      onChange={() => setMode('time-dist')}
                    />
                    <span className="text-sm">Time Dist.</span>
                  </label>
                  <label className="flex items-center">
                    <input
                      type="radio"
                      className="mr-2"
                      checked={mode === 'time-dist-sgv'}
                      onChange={() => setMode('time-dist-sgv')}
                    />
                    <span className="text-sm">Time Dist. SGV</span>
                  </label>
                  <label className="flex items-center">
                    <input
                      type="radio"
                      className="mr-2"
                      checked={mode === 'time-dist-skip'}
                      onChange={() => setMode('time-dist-skip')}
                    />
                    <span className="text-sm">Time Dist. Skip</span>
                  </label>
                </div>
              </div>
            </div>
            
            {/* Components section for SGV mode */}
            {mode === 'time-dist-sgv' && (
              <div className="mb-4">
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-sm font-semibold">Components:</h3>
                  <LabeledCheckBox
                    label="Population Scaled"
                    checked={populationScaled}
                    onChange={handlePopulationScaledToggle}
                    tooltip="Use population-scaled parameters (4Nu, 4Nv)"
                  />
                </div>
                <div className="native-panel">
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
                  <div className="p-4">
                    {components[activeTab] && (
                      <div className="space-y-3">
                        <LabeledTextField
                          label="N:"
                          value={components[activeTab].N}
                          onChange={(value) => updateComponent(activeTab, 'N', value)}
                          tooltip="Population size"
                        />
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
            )}
            
            {/* Common parameters for SGV mode */}
            {mode === 'time-dist-sgv' && (
              <div className="mb-4 pt-4">
                <div className="native-divider mb-4"></div>
                <h3 className="text-sm font-semibold mb-2">Common Parameters:</h3>
                <div className="space-y-3">
                  <LabeledTextField
                    label="α:"
                    value={sgvCommonParams.a}
                    onChange={(value) => setSgvCommonParams({ ...sgvCommonParams, a: value })}
                    tooltip="Probability cutoff (Ignore transitions with probability below this threshold to speed up computations)"
                  />
                  <div className="grid grid-cols-2 gap-3">
                    <LabeledTextField
                      label="l:"
                      value={sgvCommonParams.l}
                      onChange={(value) => setSgvCommonParams({ ...sgvCommonParams, l: value })}
                      tooltip="Transition probability (lambda)"
                    />
                    <LabeledTextField
                      label="c:"
                      value={sgvCommonParams.c}
                      onChange={(value) => setSgvCommonParams({ ...sgvCommonParams, c: value })}
                      tooltip="Starting probability cutoff (Ignore rare starting copy numbers with probability below this cutoff)"
                    />
                  </div>
                  <LabeledTextField
                    label="m:"
                    value={sgvCommonParams.m}
                    onChange={(value) => setSgvCommonParams({ ...sgvCommonParams, m: value })}
                    tooltip="Maximum generations"
                  />
                </div>
              </div>
            )}
            
            {/* Population parameters for non-SGV modes */}
            {mode !== 'time-dist-sgv' && (
              <div className="mb-4">
                <h3 className="text-sm font-semibold mb-2">Population Parameters:</h3>
                <div className="space-y-3">
                  <LabeledTextField
                    label="N:"
                    value={populationParams.N}
                    onChange={(value) => setPopulationParams({ ...populationParams, N: value })}
                    tooltip="Population size"
                  />
                  <LabeledTextField
                    label="α:"
                    value={populationParams.a}
                    onChange={(value) => setPopulationParams({ ...populationParams, a: value })}
                    tooltip="Probability cutoff (Ignore transitions with probability below this threshold to speed up computations)"
                  />
                  <div className="grid grid-cols-2 gap-3">
                    <LabeledTextField
                      label="c:"
                      value={populationParams.c}
                      onChange={(value) => setPopulationParams({ ...populationParams, c: value })}
                      tooltip="Starting probability cutoff (Ignore rare starting copy numbers with probability below this cutoff)"
                    />
                    <LabeledTextField
                      label="m:"
                      value={populationParams.m}
                      onChange={(value) => setPopulationParams({ ...populationParams, m: value })}
                      tooltip="Maximum generations"
                    />
                  </div>
                </div>
              </div>
            )}
            
            {/* Mutation parameters for non-SGV modes */}
            {mode !== 'time-dist-sgv' && (
              <div className="mb-4 pt-4">
                <div className="native-divider mb-4"></div>
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-sm font-semibold">Mutation Parameters:</h3>
                  <LabeledCheckBox
                    label="Population Scaled"
                    checked={populationScaled}
                    onChange={handlePopulationScaledToggle}
                    tooltip="Use population-scaled parameters (4Nu, 4Nv)"
                  />
                </div>
                <div className="space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <LabeledTextField
                      label={populationScaled ? "4Nu:" : "u:"}
                      value={mutationParams.u}
                      onChange={(value) => setMutationParams({ ...mutationParams, u: value })}
                      tooltip={populationScaled ? "Population-scaled backward mutation rate (4Nu)" : "Backward mutation rate"}
                    />
                    <LabeledTextField
                      label={populationScaled ? "4Nv:" : "v:"}
                      value={mutationParams.v}
                      onChange={(value) => setMutationParams({ ...mutationParams, v: value })}
                      tooltip={populationScaled ? "Population-scaled forward mutation rate (4Nv)" : "Forward mutation rate"}
                    />
                  </div>
                  <LabeledCheckBox
                    label="r:"
                    checked={noRecurrentMutation}
                    onChange={setNoRecurrentMutation}
                    tooltip="No recurrent mutation"
                  />
                </div>
              </div>
            )}
            
            {/* Selection parameters for non-SGV modes */}
            {mode !== 'time-dist-sgv' && (
              <div className="mb-4 pt-4">
                <div className="native-divider mb-4"></div>
                <h3 className="text-sm font-semibold mb-2">Selection Parameters:</h3>
                <div className="space-y-3">
                  <LabeledTextField
                    label={populationScaled ? "2Ns:" : "s:"}
                    value={selectionParams.s}
                    onChange={(value) => setSelectionParams({ ...selectionParams, s: value })}
                    tooltip={populationScaled ? "Population-scaled selection coefficient (2Ns)" : "Selection coefficient"}
                  />
                  <LabeledTextField
                    label="h:"
                    value={selectionParams.h}
                    onChange={(value) => setSelectionParams({ ...selectionParams, h: value })}
                    tooltip="Dominance coefficient"
                  />
                </div>
              </div>
            )}
          </div>
          
          <div className="w-px bg-gray-300 mx-4" />
          
          {/* Column 2: Output Options and Execution */}
          <div className="flex-1">
            <div className="mb-4">
              <h3 className="text-sm font-semibold mb-2">Output Options:</h3>
              <div className="native-panel p-4">
                <div className="grid grid-cols-2 gap-2">
                  <LabeledCheckBox
                    label="Q:"
                    checked={outputOptions.Q}
                    onChange={(checked) => setOutputOptions({ ...outputOptions, Q: checked })}
                    tooltip="Output Q matrix"
                  />
                  <LabeledCheckBox
                    label="Res:"
                    checked={outputOptions.Res}
                    onChange={(checked) => setOutputOptions({ ...outputOptions, Res: checked })}
                    tooltip="Output results"
                  />
                  <LabeledCheckBox
                    label="R:"
                    checked={outputOptions.R}
                    onChange={(checked) => setOutputOptions({ ...outputOptions, R: checked })}
                    tooltip="Output R matrix"
                  />
                  <LabeledCheckBox
                    label="P:"
                    checked={outputOptions.P}
                    onChange={(checked) => setOutputOptions({ ...outputOptions, P: checked })}
                    tooltip="Output P matrix"
                  />
                </div>
              </div>
            </div>
            
            <div className="pt-4">
              <div className="native-divider mb-4"></div>
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
                  onChange={(value) => setExecutionParams({ ...executionParams, library: value })}
                  options={(() => {
                    const isMac = typeof navigator !== 'undefined' && 
                      navigator.platform && navigator.platform.toLowerCase().includes('mac')
                    return isMac ? [
                      { value: 'Accelerate', label: 'Accelerate' },
                      { value: 'ViennaCL', label: 'ViennaCL' }
                    ] : [
                      { value: 'Pardiso', label: 'Pardiso' },
                      { value: 'ViennaCL', label: 'ViennaCL' }
                    ]
                  })()}
                  tooltip="Linear algebra library"
                />
                
                <div className="flex gap-2 mt-4">
                  <button
                    className="native-button flex-1"
                    onClick={handleStop}
                    disabled={!isExecuting}
                  >
                    Stop
                  </button>
                  <button
                    className="native-button native-button-primary flex-1"
                    onClick={handleExecute}
                    disabled={isExecuting}
                  >
                    Execute
                  </button>
                </div>
              </div>
            </div>
            
            <div className="mt-4 pt-4">
              <div className="native-divider mb-4"></div>
              <h3 className="text-sm font-semibold mb-2">Output:</h3>
              
              {/* Statistics Display for standard time-dist mode */}
              {mode === 'time-dist' && distribution && distribution.length > 0 && (() => {
                const stats = calculateStats()
                const formatProbability = (prob: number) => {
                  if (prob < 1e-5) {
                    return prob.toExponential(4)
                  } else {
                    return prob.toFixed(6)
                  }
                }
                return (
                  <div className="mb-4">
                    <div className="flex items-center justify-between mb-2">
                      <p className="text-sm text-gray-600">Time Distribution Statistics:</p>
                      <button
                        onClick={() => setShowChartWindow(true)}
                        className="native-button native-button-primary text-sm px-3 py-1"
                      >
                        View Charts
                      </button>
                    </div>
                    <div className="native-panel p-4">
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <h4 className="font-semibold text-red-600 mb-2">Extinction</h4>
                          <p className="text-sm">Mean T<sub>ext</sub>(approx): {stats.meanExt.toFixed(2)} generations</p>
                          <p className="text-sm">SD T<sub>ext</sub>(approx): {stats.stdExt.toFixed(2)} generations</p>
                          <p className="text-sm">Probability: {formatProbability(stats.cdfExt)}</p>
                        </div>
                        <div>
                          <h4 className="font-semibold text-blue-600 mb-2">Fixation</h4>
                          <p className="text-sm">Mean T<sub>fix</sub>(approx): {stats.meanFix.toFixed(2)} generations</p>
                          <p className="text-sm">SD T<sub>fix</sub>(approx): {stats.stdFix.toFixed(2)} generations</p>
                          <p className="text-sm">Probability: {formatProbability(stats.cdfFix)}</p>
                        </div>
                      </div>
                      <div className="mt-4 pt-4 border-t flex gap-2">
                        <button
                          onClick={() => exportData('tsv')}
                          className="native-button text-sm px-3 py-1"
                        >
                          Export as TSV
                        </button>
                        <button
                          onClick={() => exportData('csv')}
                          className="native-button text-sm px-3 py-1"
                        >
                          Export as CSV
                        </button>
                      </div>
                    </div>
                  </div>
                )
              })()}
              
              {/* Raw results for other modes or summary stats */}
              {(mode !== 'time-dist' || results.length > 0) && (
                <div className="mb-4">
                  <p className="text-sm text-gray-600 mb-2">
                    {mode === 'time-dist' ? 'Summary Statistics:' : 'Results:'}
                  </p>
                  <div className="native-panel h-64 overflow-y-auto p-2 native-scrollbar">
                    {results.map((result, index) => (
                      <div key={index} className="text-sm py-1 hover:bg-gray-50 px-2">
                        {result}
                      </div>
                    ))}
                  </div>
                </div>
              )}
              
              <button
                className="mt-4 native-button native-button-primary w-full"
                onClick={copyToClipboard}
                disabled={results.length === 0 && (!distribution || distribution.length === 0)}
              >
                Copy to Clipboard
              </button>
            </div>
          </div>
        </div>
      </div>
      
      {/* Bottom bar */}
      {isExecuting && (
        <div className="native-header p-4">
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
      
      {/* Chart Window Modal */}
      {showChartWindow && distribution && distribution.length > 0 && (
        <TimeDistChartWindow
          data={distribution}
          cutoff={parseFloat(mode === 'time-dist-sgv' ? sgvCommonParams.c : populationParams.c) || 0.9999}
          onClose={() => setShowChartWindow(false)}
          parameters={{
            N: populationParams.N,
            s: selectionParams.s,
            h: selectionParams.h,
            u: mutationParams.u,
            v: mutationParams.v
          }}
        />
      )}
    </div>
  )
}

export default TimeDistView