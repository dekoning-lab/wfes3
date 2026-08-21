import React, { useEffect, useRef, useState } from 'react'

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

interface TimeDistChartProps {
  data: TimeDistData[]
  className?: string
  showExportButton?: boolean
  cutoff?: number
  logScale?: boolean
  parameters?: {
    N: string
    s: string
    h: string
    u: string
    v: string
  }
}

const TimeDistChart: React.FC<TimeDistChartProps> = ({ data, className = '', showExportButton = true, cutoff = 0.999, logScale = false, parameters }) => {
  const containerRef = useRef<HTMLDivElement>(null)
  const svgExtRef = useRef<SVGSVGElement>(null)
  const svgFixRef = useRef<SVGSVGElement>(null)
  const [dimensions, setDimensions] = useState({ width: 600, height: 300 })

  useEffect(() => {
    const updateDimensions = () => {
      if (containerRef.current) {
        const { width } = containerRef.current.getBoundingClientRect()
        // Use a 2:1 aspect ratio for the entire container
        setDimensions({ width: width / 2 - 10, height: width / 4 })
      }
    }

    updateDimensions()
    window.addEventListener('resize', updateDimensions)
    return () => window.removeEventListener('resize', updateDimensions)
  }, [])

  const exportToSVG = (type: 'extinction' | 'fixation') => {
    const svgRef = type === 'extinction' ? svgExtRef.current : svgFixRef.current
    if (!svgRef) return
    
    // Clone the SVG element
    const svgClone = svgRef.cloneNode(true) as SVGSVGElement
    
    // Set better dimensions for export
    svgClone.setAttribute('width', '800')
    svgClone.setAttribute('height', '600')
    svgClone.setAttribute('viewBox', `0 0 ${dimensions.width} ${dimensions.height}`)
    
    // Add title and description
    const title = document.createElementNS('http://www.w3.org/2000/svg', 'title')
    title.textContent = `Time Distribution - ${type === 'extinction' ? 'Extinction' : 'Fixation'} PDF`
    svgClone.insertBefore(title, svgClone.firstChild)
    
    // Convert to string
    const svgString = new XMLSerializer().serializeToString(svgClone)
    
    // Create blob and download
    const blob = new Blob([svgString], { type: 'image/svg+xml' })
    const url = URL.createObjectURL(blob)
    
    const link = document.createElement('a')
    link.href = url
    link.download = `time_dist_${type}_${new Date().toISOString().slice(0, 10)}.svg`
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    
    URL.revokeObjectURL(url)
  }

  if (!data || data.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-gray-500">
        No data available
      </div>
    )
  }

  // Filter data based on CDF cutoff
  // For extinction: keep data until cdf_ext reaches cutoff
  // For fixation: keep data until cdf_fix reaches cutoff
  let extCutoffIndex = data.length
  let fixCutoffIndex = data.length
  
  for (let i = 0; i < data.length; i++) {
    if ((data[i].cdf_ext || 0) >= cutoff && extCutoffIndex === data.length) {
      extCutoffIndex = i + 1  // Include the point that crosses the cutoff
    }
    if ((data[i].cdf_fix || 0) >= cutoff && fixCutoffIndex === data.length) {
      fixCutoffIndex = i + 1  // Include the point that crosses the cutoff
    }
  }
  
  // Calculate scales separately for extinction and fixation
  const extData = data.slice(0, extCutoffIndex).filter(d => d.p_ext > 0)
  const fixData = data.slice(0, fixCutoffIndex).filter(d => d.p_fix > 0)
  
  const maxTimeExt = extData.length > 0 ? Math.max(...extData.map(d => d.time)) : 1
  const maxProbExt = extData.length > 0 ? Math.max(...extData.map(d => d.p_ext)) : 1
  
  const maxTimeFix = fixData.length > 0 ? Math.max(...fixData.map(d => d.time)) : 1
  const maxProbFix = fixData.length > 0 ? Math.max(...fixData.map(d => d.p_fix)) : 1
  
  // Create margins for axes
  const margin = { top: parameters ? 40 : 20, right: 20, bottom: 50, left: 80 }
  const chartWidth = dimensions.width - margin.left - margin.right
  const chartHeight = dimensions.height - margin.top - margin.bottom

  const renderChart = (
    type: 'extinction' | 'fixation',
    svgRef: React.RefObject<SVGSVGElement>,
    chartData: TimeDistData[],
    maxTime: number,
    maxProb: number,
    color: string
  ) => {
    if (chartData.length === 0) {
      return (
        <div className="flex items-center justify-center h-full text-gray-500 text-sm">
          No {type} events
        </div>
      )
    }

    // Scale functions
    const scaleX = (time: number) => {
      if (logScale && time > 0) {
        // Use log scale, but handle time=0 specially
        const logMin = Math.log10(1) // Start at 1 for log scale
        const logMax = Math.log10(maxTime)
        const logValue = Math.log10(Math.max(1, time))
        return ((logValue - logMin) / (logMax - logMin)) * chartWidth
      } else {
        return (time / maxTime) * chartWidth
      }
    }
    const scaleY = (prob: number) => chartHeight - (prob / maxProb) * chartHeight
    
    // Create SVG path
    const probPath = chartData.map((d, i) => {
      const x = scaleX(d.time)
      const y = scaleY(type === 'extinction' ? d.p_ext : d.p_fix)
      return `${i === 0 ? 'M' : 'L'} ${x},${y}`
    }).join(' ')
    
    // Generate axis tick values
    const xTicks = logScale ? 
      // For log scale, generate ticks at powers of 10
      (() => {
        const ticks = []
        const minPower = 0 // 10^0 = 1
        const maxPower = Math.ceil(Math.log10(maxTime))
        for (let i = minPower; i <= maxPower; i++) {
          const value = Math.pow(10, i)
          if (value <= maxTime) {
            ticks.push({ value, pos: scaleX(value) })
          }
        }
        return ticks
      })() :
      // Linear scale ticks
      [0, 0.25, 0.5, 0.75, 1].map(t => ({
        value: t * maxTime,
        pos: scaleX(t * maxTime)
      }))
    
    const yTicks = [0, 0.25, 0.5, 0.75, 1].map(t => ({
      value: t * maxProb,
      pos: scaleY(t * maxProb)
    }))

    return (
      <svg ref={svgRef} width={dimensions.width} height={dimensions.height}>
        <g transform={`translate(${margin.left},${margin.top})`}>
          {/* Grid lines */}
          {yTicks.map((tick, i) => (
            <line
              key={`h-${i}`}
              x1="0"
              y1={tick.pos}
              x2={chartWidth}
              y2={tick.pos}
              stroke="#e5e7eb"
              strokeWidth="1"
            />
          ))}
          {xTicks.map((tick, i) => (
            <line
              key={`v-${i}`}
              x1={tick.pos}
              y1="0"
              x2={tick.pos}
              y2={chartHeight}
              stroke="#e5e7eb"
              strokeWidth="1"
            />
          ))}
          
          {/* Axes */}
          <line x1="0" y1={chartHeight} x2={chartWidth} y2={chartHeight} stroke="black" strokeWidth="2" />
          <line x1="0" y1="0" x2="0" y2={chartHeight} stroke="black" strokeWidth="2" />
          
          {/* Data curve */}
          <path
            d={probPath}
            fill="none"
            stroke={color}
            strokeWidth="2"
          />
          
          {/* X-axis labels */}
          {xTicks.map((tick, i) => (
            <text
              key={`x-label-${i}`}
              x={tick.pos}
              y={chartHeight + 20}
              textAnchor="middle"
              fontSize="12"
              fill="black"
            >
              {tick.value.toFixed(0)}
            </text>
          ))}
          
          {/* Y-axis labels */}
          {yTicks.map((tick, i) => (
            <text
              key={`y-label-${i}`}
              x="-10"
              y={tick.pos + 4}
              textAnchor="end"
              fontSize="12"
              fill="black"
            >
              {tick.value.toExponential(1)}
            </text>
          ))}
          
          {/* Axis labels */}
          <text
            x={chartWidth / 2}
            y={chartHeight + 40}
            textAnchor="middle"
            fontSize="14"
            fill="black"
          >
            {type === 'extinction' ? 'Extinction Time (generations)' : 'Fixation Time (generations)'}
          </text>
          
          <text
            x="-50"
            y={chartHeight / 2}
            textAnchor="middle"
            fontSize="14"
            fill="black"
            transform={`rotate(-90, -50, ${chartHeight / 2})`}
          >
            Probability
          </text>
          
          {/* Title with parameters */}
          {parameters && (
            <text
              x={chartWidth / 2}
              y="-15"
              textAnchor="middle"
              fontSize="14"
              fill="black"
            >
              N={parameters.N}, 2Ns={parameters.s}, h={parameters.h}, 4Nu={parameters.u}, 4Nv={parameters.v}
            </text>
          )}
        </g>
      </svg>
    )
  }

  return (
    <div ref={containerRef} className={`w-full ${className}`}>
      <div className="flex gap-4">
        {/* Extinction Chart */}
        <div className="flex-1">
          {renderChart('extinction', svgExtRef, extData, maxTimeExt, maxProbExt, 'rgb(220, 38, 38)')}
          {showExportButton && extData.length > 0 && (
            <button
              onClick={() => exportToSVG('extinction')}
              className="mt-2 px-3 py-1 text-sm bg-red-500 text-white rounded hover:bg-red-600 transition-colors w-full"
            >
              Export Extinction SVG
            </button>
          )}
        </div>
        
        {/* Fixation Chart */}
        <div className="flex-1">
          {renderChart('fixation', svgFixRef, fixData, maxTimeFix, maxProbFix, 'rgb(37, 99, 235)')}
          {showExportButton && fixData.length > 0 && (
            <button
              onClick={() => exportToSVG('fixation')}
              className="mt-2 px-3 py-1 text-sm bg-blue-500 text-white rounded hover:bg-blue-600 transition-colors w-full"
            >
              Export Fixation SVG
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

export default TimeDistChart