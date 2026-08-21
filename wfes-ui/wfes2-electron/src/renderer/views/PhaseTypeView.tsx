import React, { useState } from 'react'
import { LabeledTextField } from '../components/common/LabeledTextField'
import { LabeledCheckBox } from '../components/common/LabeledCheckBox'
import { LabeledComboBox } from '../components/common/LabeledComboBox'
import PhaseTypeChart from '../components/PhaseTypeChart'
import PhaseTypeChartWindow from '../components/PhaseTypeChartWindow'
import { wfesService } from '../services/wfesService'

interface PhaseTypeViewProps {
  onBack: () => void
  hideBackButton?: boolean
}

type PhaseTypeMode = 'dist' | 'moments'

const PhaseTypeView: React.FC<PhaseTypeViewProps> = ({ onBack, hideBackButton = false }) => {
  // Mode selection
  const [mode, setMode] = useState<PhaseTypeMode>('dist')
  
  // Population parameters
  const [populationParams, setPopulationParams] = useState({
    N: '100',
    a: '1e-20', // Starting frequency/tail truncation
    c: '0.999', // Distribution cutoff (Dist mode only)
    m: '100000', // Max generations (Dist mode only)
    k: '20' // Number of moments (Moments mode only)
  })
  
  // Mutation parameters
  const [mutationParams, setMutationParams] = useState({
    u: '0.001',
    v: '0.001',
    r: true // Recurrent mutation (Moments mode only)
  })
  
  // Selection parameters
  const [selectionParams, setSelectionParams] = useState({
    s: '0',
    h: '0.5'
  })
  
  // Population scaling
  const [populationScaled, setPopulationScaled] = useState(true)
  
  // Output options - mode specific
  const [outputOptions, setOutputOptions] = useState({
    Q: false,
    R: false,
    P: true, // Phase type distribution (Dist mode only)
    Moments: true, // Always true for Moments mode
    Res: false // Results file (Moments mode only)
  })
  
  // Additional parameters for Dist mode
  const [samplingFrequency, setSamplingFrequency] = useState('100')
  
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
    library: getDefaultLibrary(),
    solver: 'BicGStab' // For ViennaCL
  })
  
  const [results, setResults] = useState<{
    // For moments mode
    mean?: string
    std?: string
    moments?: string[]
    // For dist mode
    distribution?: Array<{
      time: number
      probability: number
      cumulative: number
    }>
  }>({})
  const [isExecuting, setIsExecuting] = useState(false)
  const [progress, setProgress] = useState(0)
  const [executionTime, setExecutionTime] = useState('')
  const [showChartWindow, setShowChartWindow] = useState(false)
  
  const handleExecute = async () => {
    setIsExecuting(true)
    setProgress(0)
    setResults({})
    
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
      // Convert parameters based on population scaling
      const N = parseInt(populationParams.N)
      const scaledParams = {
        mode,
        populationParams: {
          N: populationParams.N,
          a: populationParams.a,
          // Only include mode-specific parameters
          ...(mode === 'dist' ? { c: populationParams.c, m: populationParams.m } : {}),
          ...(mode === 'moments' ? { k: populationParams.k } : {})
        },
        mutationParams: {
          u: populationScaled ? 
            (parseFloat(mutationParams.u) / (4 * N)).toExponential(5) : 
            mutationParams.u,
          v: populationScaled ? 
            (parseFloat(mutationParams.v) / (4 * N)).toExponential(5) : 
            mutationParams.v,
          ...(mode === 'moments' ? { r: mutationParams.r } : {})
        },
        selectionParams: {
          s: populationScaled ? 
            (parseFloat(selectionParams.s) / (2 * N)).toExponential(5) : 
            selectionParams.s,
          h: selectionParams.h
        },
        outputOptions: {
          Q: outputOptions.Q,
          R: outputOptions.R,
          ...(mode === 'dist' ? { 
            P: outputOptions.P,
            sampling_frequency: parseInt(samplingFrequency)
          } : {}),
          ...(mode === 'moments' ? { 
            Moments: true, // Always true for moments mode
            Res: outputOptions.Res 
          } : {})
        },
        executionParams: {
          ...executionParams,
          ...(executionParams.library === 'ViennaCL' ? { solver: executionParams.solver } : {})
        }
      }
      
      const result = await wfesService.executePhaseType(scaledParams)
      
      if (mode === 'moments') {
        setResults({
          mean: result.mean,
          std: result.std,
          moments: result.moments || []
        })
      } else {
        setResults({
          distribution: result.distribution || []
        })
        if (result.distribution && result.distribution.length > 0) {
        }
      }
      
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
  
  const copyMomentsToClipboard = () => {
    const text = results.moments?.join('\n') || ''
    navigator.clipboard.writeText(text)
  }
  
  const exportData = (format: 'tsv' | 'csv') => {
    if (!results.distribution || results.distribution.length === 0) return
    
    const delimiter = format === 'tsv' ? '\t' : ','
    const headers = ['Time', 'P(t)', 'CDF']
    
    let content = headers.join(delimiter) + '\n'
    content += results.distribution.map(row => 
      [
        row.time,
        row.probability.toExponential(6),
        row.cumulative.toFixed(6)
      ].join(delimiter)
    ).join('\n')
    
    // Create blob and download
    const blob = new Blob([content], { type: format === 'tsv' ? 'text/tab-separated-values' : 'text/csv' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `phase_type_dist_${new Date().toISOString().slice(0, 10)}.${format}`
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
  }
  
  const calculateStats = () => {
    if (!results.distribution || results.distribution.length === 0) {
      return { mean: 0, std: 0, totalProb: 0, maxCDF: 0 }
    }
    
    let mean = 0
    let m2 = 0
    let totalProb = 0

    results.distribution.forEach((row) => {
      const t = row.time
      mean += t * row.probability
      m2 += t * t * row.probability
      totalProb += row.probability
    })

    const stats = {
      mean: totalProb > 0 ? mean / totalProb : 0,
      std: 0,
      totalProb,
      maxCDF: results.distribution[results.distribution.length - 1].cumulative
    }

    // Calculate standard deviation
    if (totalProb > 0) {
      const m2Cond = m2 / totalProb
      stats.std = Math.sqrt(m2Cond - stats.mean * stats.mean)
    }

    return stats
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
        <h1 className="native-label font-medium">Phase Type</h1>
      </div>
      
      <div className="flex-1 overflow-auto">
        <div className="flex gap-4 p-4">
          {/* Column 1: Mode Selection and Population Parameters */}
          <div className="flex-shrink-0" style={{ width: '293px' }}>
            {/* Mode Selection */}
            <div className="mb-4">
              <h3 className="text-sm font-bold mb-2">Mode:</h3>
              <div className="space-y-2">
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="phaseTypeMode"
                    value="dist"
                    checked={mode === 'dist'}
                    onChange={(e) => setMode(e.target.value as PhaseTypeMode)}
                    className="native-radio"
                  />
                  <span className="text-sm">Phase Type Dist.</span>
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="phaseTypeMode"
                    value="moments"
                    checked={mode === 'moments'}
                    onChange={(e) => setMode(e.target.value as PhaseTypeMode)}
                    className="native-radio"
                  />
                  <span className="text-sm">Phase Type Moments</span>
                </label>
              </div>
            </div>
            
            <div className="native-divider mb-4"></div>
            
            <div className="mb-4">
              <h3 className="text-sm font-bold mb-2">Population Parameters:</h3>
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
                {mode === 'dist' && (
                  <>
                    <LabeledTextField
                      label="c:"
                      value={populationParams.c}
                      onChange={(value) => setPopulationParams({ ...populationParams, c: value })}
                      tooltip="Distribution cutoff (Stop when this fraction of the total probability is computed)"
                    />
                    <LabeledTextField
                      label="m:"
                      value={populationParams.m}
                      onChange={(value) => setPopulationParams({ ...populationParams, m: value })}
                      tooltip="Maximum generations"
                    />
                  </>
                )}
                {mode === 'moments' && (
                  <LabeledTextField
                    label="k:"
                    value={populationParams.k}
                    onChange={(value) => setPopulationParams({ ...populationParams, k: value })}
                    tooltip="Number of moments"
                  />
                )}
                <LabeledCheckBox
                  label="Population Scaled:"
                  checked={populationScaled}
                  onChange={setPopulationScaled}
                  tooltip={mode === 'moments' ? 
                    "Scale mutation parameters by 4N and selection by 2N" : 
                    "Scale mutation and selection parameters by 2N"}
                />
              </div>
            </div>
            
            <div className="mb-4 pt-4">
              <div className="native-divider mb-4"></div>
              <h3 className="text-sm font-bold mb-2">Mutation Parameters:</h3>
              <div className="space-y-3">
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
                {mode === 'moments' && (
                  <LabeledCheckBox
                    label="r:"
                    checked={true}
                    onChange={() => {}}
                    disabled={true}
                    tooltip="Recurrent mutation (always enabled for moments mode)"
                  />
                )}
              </div>
            </div>
          </div>
          
          <div className="w-px bg-gray-300 mx-4" />
          
          {/* Column 2: Selection, Output Options and Execution */}
          <div className="flex-shrink-0" style={{ width: '293px' }}>
            <div className="mb-4">
              <h3 className="text-sm font-bold mb-2">Selection Parameters:</h3>
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
            
            <div className="mb-4 pt-4">
              <div className="native-divider mb-4"></div>
              <h3 className="text-sm font-bold mb-2">Output Options:</h3>
              <div className="native-panel p-4">
                <div className="grid grid-cols-2 gap-2">
                  <LabeledCheckBox
                    label="Q:"
                    checked={outputOptions.Q}
                    onChange={(checked) => setOutputOptions({ ...outputOptions, Q: checked })}
                    tooltip="Output Q matrix"
                  />
                  <LabeledCheckBox
                    label="R:"
                    checked={outputOptions.R}
                    onChange={(checked) => setOutputOptions({ ...outputOptions, R: checked })}
                    tooltip="Output R matrix"
                  />
                  {mode === 'dist' && (
                    <LabeledCheckBox
                      label="P:"
                      checked={outputOptions.P}
                      onChange={(checked) => setOutputOptions({ ...outputOptions, P: checked })}
                      tooltip="Output phase type distribution"
                    />
                  )}
                  {mode === 'moments' && (
                    <>
                      <LabeledCheckBox
                        label="Moments:"
                        checked={true}
                        onChange={() => {}}
                        disabled={true}
                        tooltip="Moments output (always enabled)"
                      />
                      <LabeledCheckBox
                        label="Res:"
                        checked={outputOptions.Res}
                        onChange={(checked) => setOutputOptions({ ...outputOptions, Res: checked })}
                        tooltip="Output results file"
                      />
                    </>
                  )}
                </div>
              </div>
              {mode === 'dist' && (
                <div className="mt-3">
                  <LabeledTextField
                    label="Sampling Frequency:"
                    value={samplingFrequency}
                    onChange={setSamplingFrequency}
                    tooltip="Frequency for chart data sampling"
                  />
                </div>
              )}
            </div>
            
            <div className="pt-4">
              <div className="native-divider mb-4"></div>
              <h3 className="text-sm font-bold mb-2">Execution:</h3>
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
                
                {executionParams.library === 'ViennaCL' && (
                  <LabeledComboBox
                    label="Solver:"
                    value={executionParams.solver}
                    onChange={(value) => setExecutionParams({ ...executionParams, solver: value })}
                    options={[
                      { value: 'GMRes', label: 'GMRes' },
                      { value: 'BicGStab', label: 'BicGStab' }
                    ]}
                    tooltip="ViennaCL solver type"
                  />
                )}
                
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
          </div>
          
          <div className="w-px bg-gray-300 mx-4" />
          
          {/* Column 3: Results */}
          <div className="flex-1">
            <div className="mb-4">
              <h3 className="text-sm font-bold mb-2">Output:</h3>
              
              {mode === 'moments' && results.mean && (
                <>
                  {/* Mean and Std display */}
                  <div className="mb-4 space-y-2">
                    <div className="text-sm">
                      <span className="font-medium">Mean:</span> {results.mean}
                    </div>
                    <div className="text-sm">
                      <span className="font-medium">Std:</span> {results.std}
                    </div>
                  </div>
                  
                  {/* Moments list */}
                  <div className="mb-4">
                    <p className="text-sm text-gray-600 mb-2">Moments:</p>
                    <div className="native-panel h-48 overflow-y-auto p-2 native-scrollbar">
                      {results.moments?.map((moment, index) => (
                        <div key={index} className="text-sm py-1 hover:bg-gray-50 px-2 font-mono">
                          M<sub>{index + 1}</sub> = {moment}
                        </div>
                      ))}
                    </div>
                    <button
                      className="mt-2 native-button native-button-primary w-full"
                      onClick={copyMomentsToClipboard}
                      disabled={!results.moments || results.moments.length === 0}
                    >
                      Copy Moments to Clipboard
                    </button>
                  </div>
                </>
              )}
              
              {mode === 'dist' && results.distribution && results.distribution.length > 0 && (() => {
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
                      <p className="text-sm text-gray-600">Phase Type Distribution Statistics:</p>
                      <button
                        onClick={() => setShowChartWindow(true)}
                        className="native-button native-button-primary text-sm px-3 py-1"
                      >
                        View Chart
                      </button>
                    </div>
                    <div className="native-panel p-4">
                      <div className="space-y-2">
                        <p className="text-sm">Mean time: {stats.mean.toFixed(2)} generations</p>
                        <p className="text-sm">Std deviation: {stats.std.toFixed(2)} generations</p>
                        <p className="text-sm">Total probability: {formatProbability(stats.totalProb)}</p>
                        <p className="text-sm">Max CDF: {formatProbability(stats.maxCDF)}</p>
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
              
              {executionTime && (
                <div className="text-sm text-gray-600 mt-4">
                  Execution time: {executionTime}
                </div>
              )}
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
              Executing...
            </span>
          </div>
        </div>
      )}
      
      {/* Chart Window Modal */}
      {showChartWindow && results.distribution && results.distribution.length > 0 && (
        <PhaseTypeChartWindow
          data={results.distribution}
          onClose={() => setShowChartWindow(false)}
          parameters={{
            N: populationParams.N,
            s: populationScaled ? `2Ns=${selectionParams.s}` : `s=${selectionParams.s}`,
            h: `h=${selectionParams.h}`,
            u: populationScaled ? `4Nu=${mutationParams.u}` : `u=${mutationParams.u}`,
            v: populationScaled ? `4Nv=${mutationParams.v}` : `v=${mutationParams.v}`
          }}
        />
      )}
    </div>
  )
}

export default PhaseTypeView