import React, { useEffect, useRef, useState } from 'react'

interface PhaseTypeChartProps {
  data: Array<{
    time: number
    probability: number
    cumulative: number
  }>
  className?: string
  showExportButton?: boolean
  logScale?: boolean
  parameters?: {
    [key: string]: any
  }
}

const PhaseTypeChart: React.FC<PhaseTypeChartProps> = ({ data, className = '', showExportButton = true, logScale = false, parameters }) => {
  const containerRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const [dimensions, setDimensions] = useState({ width: 600, height: 300 })

  useEffect(() => {
    const updateDimensions = () => {
      if (containerRef.current) {
        const { width } = containerRef.current.getBoundingClientRect()
        // Use a 2:1 aspect ratio
        setDimensions({ width, height: width / 2 })
      }
    }

    updateDimensions()
    window.addEventListener('resize', updateDimensions)
    return () => window.removeEventListener('resize', updateDimensions)
  }, [])

  const exportToSVG = () => {
    if (!svgRef.current) return
    
    // Clone the SVG element
    const svgClone = svgRef.current.cloneNode(true) as SVGSVGElement
    
    // Set export dimensions to 800x600
    svgClone.setAttribute('width', '800')
    svgClone.setAttribute('height', '600')
    svgClone.setAttribute('viewBox', `0 0 ${dimensions.width} ${dimensions.height}`)
    
    // Add title and description
    const title = document.createElementNS('http://www.w3.org/2000/svg', 'title')
    title.textContent = 'Phase Type Distribution Chart'
    svgClone.insertBefore(title, svgClone.firstChild)
    
    // Convert to string
    const svgString = new XMLSerializer().serializeToString(svgClone)
    
    // Create blob and download
    const blob = new Blob([svgString], { type: 'image/svg+xml' })
    const url = URL.createObjectURL(blob)
    
    const link = document.createElement('a')
    link.href = url
    link.download = `phase_type_distribution_${new Date().toISOString().slice(0, 10)}.svg`
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

  // Calculate scales
  const maxTime = Math.max(...data.map(d => d.time))
  const maxProb = Math.max(...data.map(d => d.probability))
  
  // Create margins for axes (increase top margin if parameters are present)
  const margin = { 
    top: parameters ? 50 : 20, 
    right: 80, 
    bottom: 50, 
    left: 80 
  }
  const chartWidth = dimensions.width - margin.left - margin.right
  const chartHeight = dimensions.height - margin.top - margin.bottom
  
  // Scale functions (add log scale support for x-axis)
  const minTime = Math.min(...data.map(d => d.time).filter(t => t > 0))
  const scaleX = (time: number) => {
    if (logScale) {
      if (time <= 0) return 0
      const logMin = Math.log10(minTime)
      const logMax = Math.log10(maxTime)
      const logValue = Math.log10(time)
      return ((logValue - logMin) / (logMax - logMin)) * chartWidth
    }
    return (time / maxTime) * chartWidth
  }
  const scaleYProb = (prob: number) => chartHeight - (prob / maxProb) * chartHeight
  const scaleYCDF = (cdf: number) => chartHeight - cdf * chartHeight
  
  // Create SVG paths
  const probPath = data.map((d, i) => {
    const x = scaleX(d.time)
    const y = scaleYProb(d.probability)
    return `${i === 0 ? 'M' : 'L'} ${x},${y}`
  }).join(' ')
  
  const cdfPath = data.map((d, i) => {
    const x = scaleX(d.time)
    const y = scaleYCDF(d.cumulative)
    return `${i === 0 ? 'M' : 'L'} ${x},${y}`
  }).join(' ')
  
  // Generate axis tick values
  const xTicks = logScale 
    ? (() => {
        const logMin = Math.log10(minTime)
        const logMax = Math.log10(maxTime)
        const tickCount = 5
        return Array.from({ length: tickCount }, (_, i) => {
          const t = i / (tickCount - 1)
          const logValue = logMin + t * (logMax - logMin)
          const value = Math.pow(10, logValue)
          return {
            value,
            pos: scaleX(value)
          }
        })
      })()
    : [0, 0.25, 0.5, 0.75, 1].map(t => ({
        value: t * maxTime,
        pos: scaleX(t * maxTime)
      }))
  
  const probTicks = [0, 0.25, 0.5, 0.75, 1].map(t => ({
    value: t * maxProb,
    pos: scaleYProb(t * maxProb)
  }))
  
  const cdfTicks = [0, 0.25, 0.5, 0.75, 1].map(t => ({
    value: t,
    pos: scaleYCDF(t)
  }))

  return (
    <div ref={containerRef} className={`w-full ${className}`}>
      <svg ref={svgRef} width={dimensions.width} height={dimensions.height}>
        {/* Title with parameters */}
        {parameters && (
          <text
            x={dimensions.width / 2}
            y={20}
            textAnchor="middle"
            fontSize="16"
            fontWeight="bold"
            fill="black"
          >
            {Object.entries(parameters).map(([key, value]) => `${key}=${value}`).join(', ')}
          </text>
        )}
        <g transform={`translate(${margin.left},${margin.top})`}>
          {/* Grid lines */}
          {probTicks.map((tick, i) => (
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
          <line x1={chartWidth} y1="0" x2={chartWidth} y2={chartHeight} stroke="black" strokeWidth="2" />
          
          {/* Data curves */}
          <path
            d={probPath}
            fill="none"
            stroke="rgb(75, 192, 192)"
            strokeWidth="2"
          />
          <path
            d={cdfPath}
            fill="none"
            stroke="rgb(255, 99, 132)"
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
              {logScale && tick.value > 0 ? tick.value.toExponential(1) : tick.value.toFixed(0)}
            </text>
          ))}
          
          {/* Y-axis labels (left - probability) */}
          {probTicks.map((tick, i) => (
            <text
              key={`y-prob-${i}`}
              x="-10"
              y={tick.pos + 4}
              textAnchor="end"
              fontSize="12"
              fill="rgb(75, 192, 192)"
            >
              {tick.value.toExponential(1)}
            </text>
          ))}
          
          {/* Y-axis labels (right - CDF) */}
          {cdfTicks.map((tick, i) => (
            <text
              key={`y-cdf-${i}`}
              x={chartWidth + 10}
              y={tick.pos + 4}
              textAnchor="start"
              fontSize="12"
              fill="rgb(255, 99, 132)"
            >
              {tick.value.toFixed(1)}
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
            Time (generations){logScale ? ' - log scale' : ''}
          </text>
          
          <text
            x="-50"
            y={chartHeight / 2}
            textAnchor="middle"
            fontSize="14"
            fill="rgb(75, 192, 192)"
            transform={`rotate(-90, -50, ${chartHeight / 2})`}
          >
            Probability P(t)
          </text>
          
          <text
            x={chartWidth + 50}
            y={chartHeight / 2}
            textAnchor="middle"
            fontSize="14"
            fill="rgb(255, 99, 132)"
            transform={`rotate(90, ${chartWidth + 50}, ${chartHeight / 2})`}
          >
            CDF
          </text>
        </g>
      </svg>
      
      {/* Legend and Export Button */}
      <div className="mt-2 flex justify-between items-center">
        <div className="flex justify-center gap-8 flex-1">
          <div className="flex items-center gap-2">
            <div className="w-4 h-0.5 bg-[rgb(75,192,192)]"></div>
            <span className="text-sm">Probability P(t)</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-4 h-0.5 bg-[rgb(255,99,132)]"></div>
            <span className="text-sm">CDF</span>
          </div>
        </div>
        {showExportButton && (
          <button
            onClick={exportToSVG}
            className="px-3 py-1 text-sm bg-blue-500 text-white rounded hover:bg-blue-600 transition-colors"
          >
            Export SVG
          </button>
        )}
      </div>
    </div>
  )
}

export default PhaseTypeChart