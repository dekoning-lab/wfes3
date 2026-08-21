import React, { useEffect, useRef, useState } from 'react'
import { saveTextFile } from '../utils/saveFile'

interface EquilibriumChartProps {
  data: Array<{
    copies: number
    probability: number
  }>
  populationSize: number
  className?: string
  showExportButton?: boolean
  logScale?: boolean
}

const EquilibriumChart: React.FC<EquilibriumChartProps> = ({ 
  data, 
  populationSize,
  className = '', 
  showExportButton = true, 
  logScale = false 
}) => {
  const containerRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const [dimensions, setDimensions] = useState({ width: 600, height: 400 })

  useEffect(() => {
    const updateDimensions = () => {
      if (containerRef.current) {
        const { width } = containerRef.current.getBoundingClientRect()
        // Use a 3:2 aspect ratio for equilibrium distribution
        setDimensions({ width, height: width * 2 / 3 })
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
    title.textContent = 'Equilibrium Frequency Distribution'
    svgClone.insertBefore(title, svgClone.firstChild)
    
    // Convert to string
    const svgString = new XMLSerializer().serializeToString(svgClone)
    
    // Create blob and download
    // Through the main process: an <a download> is silently dropped here.
    void saveTextFile(svgString, `equilibrium_distribution_N${populationSize}_${new Date().toISOString().slice(0, 10)}.svg`)
  }

  if (!data || data.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-gray-500">
        No data available
      </div>
    )
  }

  // Convert copies to frequency and filter out very small probabilities
  const frequencyData = data
    .map(d => ({
      frequency: d.copies / (2 * populationSize),
      probability: d.probability
    }))
    .filter(d => d.probability > 1e-10)

  // Calculate scales
  const maxFreq = 1
  const minProb = Math.min(...frequencyData.map(d => d.probability))
  const maxProb = Math.max(...frequencyData.map(d => d.probability))
  
  // Create margins for axes
  const margin = { 
    top: 40, 
    right: 80, 
    bottom: 60, 
    left: 80 
  }
  const chartWidth = dimensions.width - margin.left - margin.right
  const chartHeight = dimensions.height - margin.top - margin.bottom
  
  // Scale functions
  const scaleX = (freq: number) => (freq / maxFreq) * chartWidth
  
  const scaleY = (prob: number) => {
    if (logScale && prob > 0) {
      const logMin = Math.log10(Math.max(minProb, 1e-10))
      const logMax = Math.log10(maxProb)
      const logValue = Math.log10(Math.max(prob, 1e-10))
      return chartHeight - ((logValue - logMin) / (logMax - logMin)) * chartHeight
    }
    return chartHeight - (prob / maxProb) * chartHeight
  }
  
  // Create SVG path
  const path = frequencyData.map((d, i) => {
    const x = scaleX(d.frequency)
    const y = scaleY(d.probability)
    return `${i === 0 ? 'M' : 'L'} ${x},${y}`
  }).join(' ')
  
  // Generate axis tick values
  const xTicks = [0, 0.2, 0.4, 0.6, 0.8, 1].map(t => ({
    value: t,
    pos: scaleX(t)
  }))
  
  const yTicks = logScale
    ? (() => {
        const logMin = Math.log10(Math.max(minProb, 1e-10))
        const logMax = Math.log10(maxProb)
        const tickCount = 5
        return Array.from({ length: tickCount }, (_, i) => {
          const t = i / (tickCount - 1)
          const logValue = logMin + t * (logMax - logMin)
          const value = Math.pow(10, logValue)
          return {
            value,
            pos: scaleY(value)
          }
        }).filter(tick => isFinite(tick.value) && !isNaN(tick.value))
      })()
    : [0, 0.25, 0.5, 0.75, 1].map(t => ({
        value: t * maxProb,
        pos: scaleY(t * maxProb)
      }))

  return (
    <div ref={containerRef} className={`w-full ${className}`}>
      <svg ref={svgRef} width={dimensions.width} height={dimensions.height}>
        {/* Title */}
        <text
          x={dimensions.width / 2}
          y={25}
          textAnchor="middle"
          fontSize="16"
          fontWeight="bold"
          fill="black"
        >
          Equilibrium Frequency Distribution
        </text>
        
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
            d={path}
            fill="none"
            stroke="#3b82f6"
            strokeWidth="2"
          />
          
          {/* Data points (only show a subset for performance) */}
          {frequencyData.filter((_, i) => i % Math.max(1, Math.floor(frequencyData.length / 50)) === 0).map((d, i) => (
            <circle
              key={`point-${i}`}
              cx={scaleX(d.frequency)}
              cy={scaleY(d.probability)}
              r="3"
              fill="#3b82f6"
            />
          ))}
          
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
              {tick.value.toFixed(1)}
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
              {(() => {
                if (!isFinite(tick.value) || isNaN(tick.value)) return ''
                if (logScale) {
                  return tick.value < 1e-3 ? tick.value.toExponential(1) : tick.value.toFixed(3)
                }
                return tick.value.toExponential(2)
              })()}
            </text>
          ))}
          
          {/* Axis labels */}
          <text
            x={chartWidth / 2}
            y={chartHeight + 45}
            textAnchor="middle"
            fontSize="14"
            fill="black"
          >
            Allele Frequency
          </text>
          
          <text
            x="-50"
            y={chartHeight / 2}
            textAnchor="middle"
            fontSize="14"
            fill="black"
            transform={`rotate(-90, -50, ${chartHeight / 2})`}
          >
            Probability{logScale ? ' (log scale)' : ''}
          </text>
        </g>
      </svg>
      
      {/* Export Button */}
      {showExportButton && (
        <div className="mt-2 flex justify-end">
          <button
            onClick={exportToSVG}
            className="px-3 py-1 text-sm bg-blue-500 text-white rounded hover:bg-blue-600 transition-colors"
          >
            Export SVG
          </button>
        </div>
      )}
    </div>
  )
}

export default EquilibriumChart