import React, { useState } from 'react'
import PhaseTypeChart from './PhaseTypeChart'

interface PhaseTypeData {
  time: number
  probability: number
  cumulative: number
}

interface PhaseTypeChartWindowProps {
  data: PhaseTypeData[]
  onClose: () => void
  parameters?: {
    N: string
    s: string
    h: string
    u: string
    v: string
  }
}

const PhaseTypeChartWindow: React.FC<PhaseTypeChartWindowProps> = ({ data, onClose, parameters }) => {
  const [logScale, setLogScale] = useState(true) // Default to log scale

  // Calculate statistics from the data
  const calculateStats = () => {
    let mean = 0
    let m2 = 0
    let totalProb = 0

    data.forEach((row) => {
      const t = row.time
      mean += t * row.probability
      m2 += t * t * row.probability
      totalProb += row.probability
    })

    const stats = {
      mean: totalProb > 0 ? mean / totalProb : 0,
      std: 0,
      totalProb,
      maxCDF: data.length > 0 ? data[data.length - 1].cumulative : 0
    }

    // Calculate standard deviation
    if (totalProb > 0) {
      const m2Cond = m2 / totalProb
      stats.std = Math.sqrt(m2Cond - stats.mean * stats.mean)
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
          <h2 className="text-xl font-semibold">Phase Type Distribution Chart</h2>
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
          <PhaseTypeChart 
            data={data} 
            showExportButton={true} 
            logScale={logScale}
            parameters={parameters}
          />
          
          <div className="mt-6 space-y-4">
            <div className="bg-blue-50 p-4 rounded text-sm">
              <h3 className="font-semibold text-blue-700 mb-2">Distribution Statistics</h3>
              <p>Mean time: {stats.mean.toFixed(2)} generations</p>
              <p>Std deviation: {stats.std.toFixed(2)} generations</p>
              <p>Total probability: {formatProbability(stats.totalProb)}</p>
              <p>Max CDF: {formatProbability(stats.maxCDF)}</p>
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

export default PhaseTypeChartWindow