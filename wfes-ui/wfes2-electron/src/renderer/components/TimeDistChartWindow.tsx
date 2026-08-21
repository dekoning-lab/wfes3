import React, { useState, useEffect } from 'react'
import TimeDistChart from './TimeDistChart'

interface TimeDistData {
  time: number
  p_ext: number
  p_fix: number
  p_total: number
  cdf?: number
  cdf_ext?: number
  cdf_fix?: number
  cdf_total?: number
}

interface TimeDistChartWindowProps {
  data: TimeDistData[]
  cutoff: number
  onClose: () => void
  parameters?: {
    N: string
    s: string
    h: string
    u: string
    v: string
  }
}

const TimeDistChartWindow: React.FC<TimeDistChartWindowProps> = ({ data, cutoff, onClose, parameters }) => {
  const [logScale, setLogScale] = useState(true) // Default to log scale

  // Calculate statistics from the data
  const calculateStats = () => {
    let meanExt = 0
    let meanFix = 0
    let m2Ext = 0
    let m2Fix = 0
    let cdfExt = 0
    let cdfFix = 0

    data.forEach((row) => {
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

  const stats = calculateStats()
  
  // Format probability for display
  const formatProbability = (prob: number) => {
    if (prob < 1e-5) {
      return prob.toExponential(4)
    } else {
      return prob.toFixed(6)
    }
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl flex flex-col" style={{ width: 'calc(min(95vw, 1750px))', height: '85vh' }}>
        <div className="p-4 border-b flex items-center justify-between">
          <h2 className="text-xl font-semibold">Time Distribution Charts</h2>
          <div className="flex items-center gap-4">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={logScale}
                onChange={(e) => setLogScale(e.target.checked)}
                className="form-checkbox"
              />
              <span className="text-sm">Log scale X-axis</span>
            </label>
            <button
              onClick={onClose}
              className="text-gray-500 hover:text-gray-700"
            >
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>
        
        <div className="flex-1 p-6 overflow-auto">
          <TimeDistChart 
            data={data} 
            cutoff={cutoff} 
            showExportButton={true} 
            logScale={logScale}
            parameters={parameters}
          />
          
          <div className="mt-6 space-y-4">
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div className="bg-red-50 p-4 rounded">
                <h3 className="font-semibold text-red-700 mb-2">Extinction Statistics</h3>
                <p>Mean time: {stats.meanExt.toFixed(2)} generations</p>
                <p>Std deviation: {stats.stdExt.toFixed(2)} generations</p>
                <p>Probability: {formatProbability(stats.cdfExt)}</p>
              </div>
              <div className="bg-blue-50 p-4 rounded">
                <h3 className="font-semibold text-blue-700 mb-2">Fixation Statistics</h3>
                <p>Mean time: {stats.meanFix.toFixed(2)} generations</p>
                <p>Std deviation: {stats.stdFix.toFixed(2)} generations</p>
                <p>Probability: {formatProbability(stats.cdfFix)}</p>
              </div>
            </div>
            <p className="text-xs text-gray-600 text-center italic">
              Note: These estimates may differ from standard results because they are computed from the truncation of an infinite sum.
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}

export default TimeDistChartWindow