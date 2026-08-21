import React, { useEffect, useRef, useState, useImperativeHandle, forwardRef } from 'react'
import { saveTextFile } from '../utils/saveFile'
import { useMantineTheme } from '@mantine/core'

interface EquilibriumChartProps {
  data: Array<{
    copies: number
    probability: number
  }>
  populationSize: number
  className?: string
  showExportButton?: boolean
  logScale?: boolean
  parameters?: {
    N: number
    s: number
    h: number
    u: number
    v: number
  }
}

export interface EquilibriumChartRef {
  exportToSVG: () => void
}

const EquilibriumChartMantine = forwardRef<EquilibriumChartRef, EquilibriumChartProps>(({ 
  data, 
  populationSize,
  className = '', 
  showExportButton = true, 
  logScale = false,
  parameters 
}, ref) => {
  const theme = useMantineTheme()
  const containerRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const [dimensions, setDimensions] = useState({ width: 600, height: 400 })

  useImperativeHandle(ref, () => ({
    exportToSVG
  }))

  useEffect(() => {
    const updateDimensions = () => {
      if (containerRef.current) {
        const { width } = containerRef.current.getBoundingClientRect()
        // Reduced height for better fit - was width * 2/3, now width * 0.45 (30% reduction)
        setDimensions({ width, height: width * 0.45 })
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
    
    // Set white background for export
    const background = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
    background.setAttribute('width', dimensions.width.toString())
    background.setAttribute('height', dimensions.height.toString())
    background.setAttribute('fill', 'white')
    svgClone.insertBefore(background, svgClone.firstChild)
    
    // Change all colors to black for export
    svgClone.querySelectorAll('text').forEach(text => {
      text.setAttribute('fill', 'black')
    })
    
    svgClone.querySelectorAll('line').forEach(line => {
      const stroke = line.getAttribute('stroke')
      // Convert axes to black
      if (line.getAttribute('stroke-width') === '2') {
        line.setAttribute('stroke', 'black')
      } else {
        // Convert grid lines to light gray
        line.setAttribute('stroke', '#cccccc')
      }
    })
    
    // Also update paths (the data curve)
    svgClone.querySelectorAll('path').forEach(path => {
      if (path.getAttribute('fill') === 'none') {
        path.setAttribute('stroke', '#3b82f6') // Keep blue for data
      }
    })
    
    // Update circles (data points)
    svgClone.querySelectorAll('circle').forEach(circle => {
      circle.setAttribute('fill', '#3b82f6') // Keep blue for data points
    })
    
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
  
  // Create margins for axes - reduced from original
  const margin = { 
    top: 35, 
    right: 60, 
    bottom: 50, 
    left: 70 
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

  // Colors for dark mode - force dark mode since we're always in dark theme
  const textColor = '#ffffff'  // white for dark mode
  const gridColor = theme.colors.dark[5]
  const axisColor = '#ffffff'  // white for dark mode

  return (
    <div ref={containerRef} className={`w-full ${className}`}>
      <svg ref={svgRef} width={dimensions.width} height={dimensions.height}>
        {/* Title */}
        <text
          x={dimensions.width / 2}
          y={20}
          textAnchor="middle"
          fontSize="14"
          fontWeight="bold"
          fill={textColor}
        >
          {parameters ? 
            `N=${parameters.N.toLocaleString()}, 2Ns=${(2 * parameters.N * parameters.s).toFixed(1)}, h=${parameters.h}, 4Nu=${(4 * parameters.N * parameters.u).toFixed(3)}, 4Nv=${(4 * parameters.N * parameters.v).toFixed(3)}` :
            'Equilibrium Frequency Distribution'
          }
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
              stroke={gridColor}
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
              stroke={gridColor}
              strokeWidth="1"
            />
          ))}
          
          {/* Axes */}
          <line x1="0" y1={chartHeight} x2={chartWidth} y2={chartHeight} stroke={axisColor} strokeWidth="2" />
          <line x1="0" y1="0" x2="0" y2={chartHeight} stroke={axisColor} strokeWidth="2" />
          
          {/* Data curve */}
          <path
            d={path}
            fill="none"
            stroke={theme.colors.blue[6]}
            strokeWidth="2"
          />
          
          {/* Data points (only show a subset for performance) */}
          {frequencyData.filter((_, i) => i % Math.max(1, Math.floor(frequencyData.length / 50)) === 0).map((d, i) => (
            <circle
              key={`point-${i}`}
              cx={scaleX(d.frequency)}
              cy={scaleY(d.probability)}
              r="2"
              fill={theme.colors.blue[6]}
            />
          ))}
          
          {/* X-axis labels */}
          {xTicks.map((tick, i) => (
            <text
              key={`x-label-${i}`}
              x={tick.pos}
              y={chartHeight + 15}
              textAnchor="middle"
              fontSize="11"
              fill={textColor}
            >
              {tick.value.toFixed(1)}
            </text>
          ))}
          
          {/* Y-axis labels */}
          {yTicks.map((tick, i) => (
            <text
              key={`y-label-${i}`}
              x="-8"
              y={tick.pos + 3}
              textAnchor="end"
              fontSize="11"
              fill={textColor}
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
            y={chartHeight + 35}
            textAnchor="middle"
            fontSize="13"
            fill={textColor}
          >
            Allele Frequency
          </text>
          
          <text
            x="-45"
            y={chartHeight / 2}
            textAnchor="middle"
            fontSize="13"
            fill={textColor}
            transform={`rotate(-90, -45, ${chartHeight / 2})`}
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
})

EquilibriumChartMantine.displayName = 'EquilibriumChartMantine'

export default EquilibriumChartMantine