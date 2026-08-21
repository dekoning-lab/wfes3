import React, { useEffect, useRef, useState, useCallback } from 'react'
import { saveTextFile, saveBlobFile } from '../utils/saveFile'
import { useMantineColorScheme } from '@mantine/core'

interface FundamentalMatrixChartProps {
  data: number[][]
  populationSize: number
  className?: string
  showExportButton?: boolean
  parameters?: {
    N: number
    s: number
    h: number
    u: number
    v: number
  }
}

const FundamentalMatrixChart: React.FC<FundamentalMatrixChartProps> = ({ 
  data, 
  populationSize,
  className = '', 
  showExportButton = true,
  parameters
}) => {
  const { colorScheme } = useMantineColorScheme()
  const containerRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [dimensions, setDimensions] = useState({ width: 600, height: 600 })
  const [hoveredCell, setHoveredCell] = useState<{row: number, col: number, value: number, mouseX?: number, mouseY?: number} | null>(null)
  const [staticImageUrl, setStaticImageUrl] = useState<string | null>(null)
  const [isGeneratingImage, setIsGeneratingImage] = useState(false)
  
  // Use Canvas for large matrices (> 50x50), static image for very large (> 200x200)
  const useCanvas = data.length > 50
  const useStaticImage = data.length > 200
  
  console.log(`FundamentalMatrixChart mounted: size=${data.length}, useCanvas=${useCanvas}, useStaticImage=${useStaticImage}`)

  useEffect(() => {
    const updateDimensions = () => {
      if (containerRef.current) {
        const { width } = containerRef.current.getBoundingClientRect()
        // Use a 1:1 aspect ratio for matrix visualization, but limit the height
        const maxHeight = window.innerHeight * 0.6 // 60% of viewport height
        const desiredHeight = Math.min(width, maxHeight)
        setDimensions({ width, height: desiredHeight })
      }
    }

    updateDimensions()
    window.addEventListener('resize', updateDimensions)
    return () => window.removeEventListener('resize', updateDimensions)
  }, [])

  // Static image generation for very large matrices
  useEffect(() => {
    if (!useStaticImage || !data || data.length === 0) return
    
    console.log(`Generating static image for ${data.length}x${data.length} matrix`)
    setIsGeneratingImage(true)
    
    // Use setTimeout to allow the UI to update with loading state
    setTimeout(() => {
      // Create off-screen canvas
      const offscreenCanvas = document.createElement('canvas')
    const ctx = offscreenCanvas.getContext('2d')
    if (!ctx) return
    
    // Set a reasonable size for the static image
    const imageSize = 800
    offscreenCanvas.width = imageSize
    offscreenCanvas.height = imageSize
    
    const numRows = data.length
    const numCols = data[0]?.length || 0
    
    // Find min and max values for color scaling
    let minValue = Infinity
    let maxValue = -Infinity
    for (let i = 0; i < numRows; i++) {
      for (let j = 0; j < numCols; j++) {
        const value = data[i][j]
        if (value < minValue) minValue = value
        if (value > maxValue) maxValue = value
      }
    }
    
    // Create margins
    const margin = { top: 60, right: 100, bottom: 80, left: 80 }
    const chartWidth = imageSize - margin.left - margin.right
    const chartHeight = imageSize - margin.top - margin.bottom
    
    // Calculate cell dimensions
    const cellWidth = chartWidth / numCols
    const cellHeight = chartHeight / numRows
    
    // Clear canvas
    ctx.fillStyle = colorScheme === 'dark' ? '#1a1a1a' : 'white'
    ctx.fillRect(0, 0, imageSize, imageSize)
    
    // Draw title
    ctx.fillStyle = colorScheme === 'dark' ? '#ffffff' : 'black'
    ctx.font = 'bold 18px sans-serif'
    ctx.textAlign = 'center'
    const title = parameters ? 
      `N=${parameters.N.toLocaleString()}, 2Ns=${(2 * parameters.N * parameters.s).toFixed(1)}, h=${parameters.h}, 4Nu=${(4 * parameters.N * parameters.u).toFixed(3)}, 4Nv=${(4 * parameters.N * parameters.v).toFixed(3)}` :
      'Fundamental Matrix N(i,j)'
    ctx.fillText(title, imageSize / 2, 30)
    
    // Draw matrix cells with downsampling for performance
    const downsample = Math.max(1, Math.floor(numRows / 200))
    for (let i = 0; i < numRows; i += downsample) {
      for (let j = 0; j < numCols; j += downsample) {
        const value = data[i][j]
        const normalized = (value - minValue) / (maxValue - minValue)
        
        // Color interpolation
        let r, g, b
        if (normalized < 0.5) {
          const t = normalized * 2
          r = Math.floor(0 + t * 255)
          g = Math.floor(0 + t * 255)
          b = 255
        } else {
          const t = (normalized - 0.5) * 2
          r = 255
          g = Math.floor(255 - t * 255)
          b = Math.floor(255 - t * 255)
        }
        
        ctx.fillStyle = `rgb(${r},${g},${b})`
        ctx.fillRect(
          margin.left + (j / numCols) * chartWidth,
          margin.top + (i / numRows) * chartHeight,
          Math.ceil(cellWidth * downsample),
          Math.ceil(cellHeight * downsample)
        )
      }
    }
    
    // Draw axes and labels
    ctx.strokeStyle = colorScheme === 'dark' ? '#ffffff' : 'black'
    ctx.lineWidth = 2
    ctx.strokeRect(margin.left, margin.top, chartWidth, chartHeight)
    
    // Draw axis labels
    ctx.fillStyle = colorScheme === 'dark' ? '#ffffff' : 'black'
    ctx.font = '14px sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText('End State (j)', margin.left + chartWidth / 2, imageSize - 30)
    
    ctx.save()
    ctx.translate(40, margin.top + chartHeight / 2)
    ctx.rotate(-Math.PI / 2)
    ctx.fillText('Start State (i)', 0, 0)
    ctx.restore()
    
    // Draw color scale
    const scaleWidth = 20
    const scaleX = imageSize - margin.right + 20
    
    // Draw gradient
    for (let i = 0; i < chartHeight; i++) {
      const normalized = 1 - (i / chartHeight)
      let r, g, b
      if (normalized < 0.5) {
        const t = normalized * 2
        r = Math.floor(0 + t * 255)
        g = Math.floor(0 + t * 255)
        b = 255
      } else {
        const t = (normalized - 0.5) * 2
        r = 255
        g = Math.floor(255 - t * 255)
        b = Math.floor(255 - t * 255)
      }
      ctx.fillStyle = `rgb(${r},${g},${b})`
      ctx.fillRect(scaleX, margin.top + i, scaleWidth, 1)
    }
    
    ctx.strokeStyle = colorScheme === 'dark' ? '#ffffff' : 'black'
    ctx.lineWidth = 1
    ctx.strokeRect(scaleX, margin.top, scaleWidth, chartHeight)
    
    // Scale labels
    ctx.fillStyle = colorScheme === 'dark' ? '#ffffff' : 'black'
    ctx.font = '12px sans-serif'
    ctx.textAlign = 'left'
    ctx.fillText(maxValue.toFixed(2), scaleX + 25, margin.top + 5)
    ctx.fillText(((minValue + maxValue) / 2).toFixed(2), scaleX + 25, margin.top + chartHeight / 2)
    ctx.fillText(minValue.toFixed(2), scaleX + 25, margin.top + chartHeight)
    
    // Add info about downsampling
    if (downsample > 1) {
      ctx.fillStyle = colorScheme === 'dark' ? '#b0b0b0' : 'gray'
      ctx.font = '12px sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText(`(Downsampled ${downsample}x for display)`, imageSize / 2, imageSize - 10)
    }
    
    // Convert to data URL
    const dataUrl = offscreenCanvas.toDataURL('image/png')
    console.log(`Static image generated, downsample factor: ${downsample}`)
    setStaticImageUrl(dataUrl)
    setIsGeneratingImage(false)
    }, 100) // Small delay to show loading state
    
  }, [data, useStaticImage, colorScheme])

  // Canvas rendering effect for medium-sized matrices
  useEffect(() => {
    if (!useCanvas || useStaticImage || !canvasRef.current || !data || data.length === 0) return
    
    const canvas = canvasRef.current
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    
    // Set canvas size
    canvas.width = dimensions.width
    canvas.height = dimensions.height
    
    const numRows = data.length
    const numCols = data[0]?.length || 0
    
    // Find min and max values for color scaling
    const flatData = data.flat()
    const minValue = Math.min(...flatData)
    const maxValue = Math.max(...flatData)
    
    // Create margins
    const margin = { top: 60, right: 100, bottom: 80, left: 80 }
    const chartWidth = dimensions.width - margin.left - margin.right
    const chartHeight = dimensions.height - margin.top - margin.bottom
    
    // Calculate cell dimensions
    const cellWidth = chartWidth / numCols
    const cellHeight = chartHeight / numRows
    
    // Clear canvas
    ctx.fillStyle = colorScheme === 'dark' ? '#1a1a1a' : 'white'
    ctx.fillRect(0, 0, dimensions.width, dimensions.height)
    
    // Draw title
    ctx.fillStyle = colorScheme === 'dark' ? '#ffffff' : 'black'
    ctx.font = 'bold 18px sans-serif'
    ctx.textAlign = 'center'
    const title = parameters ? 
      `N=${parameters.N.toLocaleString()}, 2Ns=${(2 * parameters.N * parameters.s).toFixed(1)}, h=${parameters.h}, 4Nu=${(4 * parameters.N * parameters.u).toFixed(3)}, 4Nv=${(4 * parameters.N * parameters.v).toFixed(3)}` :
      'Fundamental Matrix N(i,j)'
    ctx.fillText(title, dimensions.width / 2, 30)
    
    // Draw matrix cells
    for (let i = 0; i < numRows; i++) {
      for (let j = 0; j < numCols; j++) {
        const value = data[i][j]
        const normalized = (value - minValue) / (maxValue - minValue)
        
        // Color interpolation
        let r, g, b
        if (normalized < 0.5) {
          const t = normalized * 2
          r = Math.floor(0 + t * 255)
          g = Math.floor(0 + t * 255)
          b = 255
        } else {
          const t = (normalized - 0.5) * 2
          r = 255
          g = Math.floor(255 - t * 255)
          b = Math.floor(255 - t * 255)
        }
        
        ctx.fillStyle = `rgb(${r},${g},${b})`
        ctx.fillRect(
          margin.left + j * cellWidth,
          margin.top + i * cellHeight,
          cellWidth,
          cellHeight
        )
      }
    }
    
    // Draw axes and labels
    ctx.strokeStyle = colorScheme === 'dark' ? '#ffffff' : 'black'
    ctx.lineWidth = 2
    ctx.strokeRect(margin.left, margin.top, chartWidth, chartHeight)
    
    // Draw axis labels
    ctx.fillStyle = colorScheme === 'dark' ? '#ffffff' : 'black'
    ctx.font = '14px sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText('End State (j)', margin.left + chartWidth / 2, dimensions.height - 30)
    
    ctx.save()
    ctx.translate(40, margin.top + chartHeight / 2)
    ctx.rotate(-Math.PI / 2)
    ctx.fillText('Start State (i)', 0, 0)
    ctx.restore()
    
    // Draw color scale
    const scaleWidth = 20
    const scaleX = dimensions.width - margin.right + 20
    
    // Draw gradient
    for (let i = 0; i < chartHeight; i++) {
      const normalized = 1 - (i / chartHeight)
      let r, g, b
      if (normalized < 0.5) {
        const t = normalized * 2
        r = Math.floor(0 + t * 255)
        g = Math.floor(0 + t * 255)
        b = 255
      } else {
        const t = (normalized - 0.5) * 2
        r = 255
        g = Math.floor(255 - t * 255)
        b = Math.floor(255 - t * 255)
      }
      ctx.fillStyle = `rgb(${r},${g},${b})`
      ctx.fillRect(scaleX, margin.top + i, scaleWidth, 1)
    }
    
    ctx.strokeStyle = colorScheme === 'dark' ? '#ffffff' : 'black'
    ctx.lineWidth = 1
    ctx.strokeRect(scaleX, margin.top, scaleWidth, chartHeight)
    
    // Scale labels
    ctx.fillStyle = colorScheme === 'dark' ? '#ffffff' : 'black'
    ctx.font = '12px sans-serif'
    ctx.textAlign = 'left'
    ctx.fillText(maxValue.toFixed(2), scaleX + 25, margin.top + 5)
    ctx.fillText(((minValue + maxValue) / 2).toFixed(2), scaleX + 25, margin.top + chartHeight / 2)
    ctx.fillText(minValue.toFixed(2), scaleX + 25, margin.top + chartHeight)
    
  }, [data, dimensions, useCanvas, useStaticImage, colorScheme])

  const exportToSVG = () => {
    if (!svgRef.current) return
    
    // Clone the SVG element
    const svgClone = svgRef.current.cloneNode(true) as SVGSVGElement
    
    // Set export dimensions to 800x800
    svgClone.setAttribute('width', '800')
    svgClone.setAttribute('height', '800')
    svgClone.setAttribute('viewBox', `0 0 ${dimensions.width} ${dimensions.height}`)
    
    // Add title
    const title = document.createElementNS('http://www.w3.org/2000/svg', 'title')
    title.textContent = 'Fundamental Matrix Heatmap'
    svgClone.insertBefore(title, svgClone.firstChild)
    
    // Convert to string
    const svgString = new XMLSerializer().serializeToString(svgClone)
    
    // Create blob and download
    // Through the main process: an <a download> is silently dropped here.
    void saveTextFile(svgString, `fundamental_matrix_N${populationSize}_${new Date().toISOString().slice(0, 10)}.svg`)
  }

  if (!data || data.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-gray-500">
        No data available
      </div>
    )
  }

  const numRows = data.length
  const numCols = data[0]?.length || 0
  
  // Find min and max values for color scaling
  let minValue = Infinity
  let maxValue = -Infinity
  for (let i = 0; i < numRows; i++) {
    for (let j = 0; j < numCols; j++) {
      const value = data[i][j]
      if (value < minValue) minValue = value
      if (value > maxValue) maxValue = value
    }
  }
  
  // Create margins for axes
  const margin = { 
    top: 60, 
    right: 100, 
    bottom: 80, 
    left: 80 
  }
  const chartWidth = dimensions.width - margin.left - margin.right
  const chartHeight = dimensions.height - margin.top - margin.bottom
  
  // Calculate cell dimensions
  const cellWidth = chartWidth / numCols
  const cellHeight = chartHeight / numRows
  
  // Color scale function (blue to red)
  const getColor = (value: number) => {
    const normalized = (value - minValue) / (maxValue - minValue)
    
    // Interpolate between blue (low) and red (high)
    if (normalized < 0.5) {
      // Blue to white
      const t = normalized * 2
      const r = Math.floor(0 + t * 255)
      const g = Math.floor(0 + t * 255) 
      const b = Math.floor(255)
      return `rgb(${r},${g},${b})`
    } else {
      // White to red
      const t = (normalized - 0.5) * 2
      const r = Math.floor(255)
      const g = Math.floor(255 - t * 255)
      const b = Math.floor(255 - t * 255)
      return `rgb(${r},${g},${b})`
    }
  }
  
  return (
    <div ref={containerRef} className={`w-full ${className}`}>
      {useStaticImage && isGeneratingImage ? (
        <div className="flex items-center justify-center h-full">
          <div className="text-center">
            <div className="inline-block animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
            <p className="mt-4 text-gray-600 dark:text-gray-400">Generating visualization for {data.length}×{data.length} matrix...</p>
          </div>
        </div>
      ) : useStaticImage && staticImageUrl ? (
        <>
          <div className="flex items-center justify-center h-full">
            <img 
              src={staticImageUrl} 
              alt="Fundamental Matrix Heatmap" 
              className="max-w-full max-h-full object-contain"
            />
          </div>
          {showExportButton && (
            <div className="mt-2 flex justify-end">
              <button
                onClick={() => {
                  const a = document.createElement('a')
                  a.href = staticImageUrl
                  a.download = `fundamental_matrix_N${populationSize}_${new Date().toISOString().slice(0, 10)}.png`
                  a.click()
                }}
                className="px-3 py-1 text-sm bg-blue-500 text-white rounded hover:bg-blue-600 transition-colors"
              >
                Export PNG
              </button>
            </div>
          )}
        </>
      ) : useCanvas ? (
        <>
          <canvas 
            ref={canvasRef} 
            width={dimensions.width} 
            height={dimensions.height}
            className="w-full h-full"
            style={{ maxWidth: dimensions.width, maxHeight: dimensions.height }}
          />
          {showExportButton && (
            <div className="mt-2 flex justify-end">
              <button
                onClick={() => {
                  if (canvasRef.current) {
                    canvasRef.current.toBlob(blob => {
                      if (blob) {
                        // Binary route: an <a download> is silently dropped here.
                        void saveBlobFile(blob!, `fundamental_matrix_N${populationSize}_${new Date().toISOString().slice(0, 10)}.png`)
                      }
                    })
                  }
                }}
                className="px-3 py-1 text-sm bg-blue-500 text-white rounded hover:bg-blue-600 transition-colors"
              >
                Export PNG
              </button>
            </div>
          )}
        </>
      ) : (
        <>
      <svg ref={svgRef} width={dimensions.width} height={dimensions.height}>
        {/* Title */}
        <text
          x={dimensions.width / 2}
          y={30}
          textAnchor="middle"
          fontSize="18"
          fontWeight="bold"
          fill={colorScheme === 'dark' ? '#ffffff' : '#000000'}
        >
          {parameters ? 
            `N=${parameters.N.toLocaleString()}, 2Ns=${(2 * parameters.N * parameters.s).toFixed(1)}, h=${parameters.h}, 4Nu=${(4 * parameters.N * parameters.u).toFixed(3)}, 4Nv=${(4 * parameters.N * parameters.v).toFixed(3)}` :
            'Fundamental Matrix N(i,j)'
          }
        </text>
        
        <g transform={`translate(${margin.left},${margin.top})`}>
          {/* Matrix cells */}
          {data.map((row, i) => 
            row.map((value, j) => (
              <rect
                key={`cell-${i}-${j}`}
                x={j * cellWidth}
                y={i * cellHeight}
                width={cellWidth}
                height={cellHeight}
                fill={getColor(value)}
                stroke="#e5e7eb"
                strokeWidth="0.5"
                onMouseMove={(e) => {
                  const rect = (e.target as SVGRectElement).getBoundingClientRect()
                  const svgRect = svgRef.current?.getBoundingClientRect()
                  if (svgRect) {
                    setHoveredCell({
                      row: i, 
                      col: j, 
                      value,
                      mouseX: e.clientX - svgRect.left,
                      mouseY: e.clientY - svgRect.top
                    })
                  }
                }}
                onMouseLeave={() => {
                  setHoveredCell(null)
                }}
                style={{ cursor: 'crosshair' }}
              />
            ))
          )}
          
          {/* Axis labels */}
          {/* X-axis labels (columns) */}
          {Array.from({ length: Math.min(numCols, 10) }, (_, i) => {
            const colIndex = Math.floor(i * numCols / 10)
            return (
              <text
                key={`x-label-${i}`}
                x={colIndex * cellWidth + cellWidth / 2}
                y={chartHeight + 20}
                textAnchor="middle"
                fontSize="12"
                fill={colorScheme === 'dark' ? '#ffffff' : '#000000'}
              >
                {colIndex}
              </text>
            )
          })}
          
          {/* Y-axis labels (rows) */}
          {Array.from({ length: Math.min(numRows, 10) }, (_, i) => {
            const rowIndex = Math.floor(i * numRows / 10)
            return (
              <text
                key={`y-label-${i}`}
                x="-10"
                y={rowIndex * cellHeight + cellHeight / 2}
                textAnchor="end"
                fontSize="12"
                fill={colorScheme === 'dark' ? '#ffffff' : '#000000'}
                dominantBaseline="middle"
              >
                {rowIndex}
              </text>
            )
          })}
          
          {/* Axis titles */}
          <text
            x={chartWidth / 2}
            y={chartHeight + 50}
            textAnchor="middle"
            fontSize="14"
            fill={colorScheme === 'dark' ? '#ffffff' : '#000000'}
          >
            End State (j)
          </text>
          
          <text
            x="-40"
            y={chartHeight / 2}
            textAnchor="middle"
            fontSize="14"
            fill={colorScheme === 'dark' ? '#ffffff' : '#000000'}
            transform={`rotate(-90, -40, ${chartHeight / 2})`}
          >
            Start State (i)
          </text>
          
          {/* Color scale */}
          <g transform={`translate(${chartWidth + 20}, 0)`}>
            {/* Color gradient */}
            <defs>
              <linearGradient id="colorGradient" x1="0%" y1="100%" x2="0%" y2="0%">
                <stop offset="0%" stopColor={getColor(minValue)} />
                <stop offset="50%" stopColor={getColor((minValue + maxValue) / 2)} />
                <stop offset="100%" stopColor={getColor(maxValue)} />
              </linearGradient>
            </defs>
            
            <rect
              x="0"
              y="0"
              width="20"
              height={chartHeight}
              fill="url(#colorGradient)"
              stroke={colorScheme === 'dark' ? '#ffffff' : '#000000'}
              strokeWidth="1"
            />
            
            {/* Scale labels */}
            <text x="25" y="0" fontSize="12" fill={colorScheme === 'dark' ? '#ffffff' : '#000000'} dominantBaseline="middle">
              {maxValue.toFixed(2)}
            </text>
            <text x="25" y={chartHeight / 2} fontSize="12" fill={colorScheme === 'dark' ? '#ffffff' : '#000000'} dominantBaseline="middle">
              {((minValue + maxValue) / 2).toFixed(2)}
            </text>
            <text x="25" y={chartHeight} fontSize="12" fill={colorScheme === 'dark' ? '#ffffff' : '#000000'} dominantBaseline="middle">
              {minValue.toFixed(2)}
            </text>
          </g>
        </g>
        
        {/* Tooltip */}
        {hoveredCell && hoveredCell.mouseX !== undefined && hoveredCell.mouseY !== undefined && (
          <>
            {/* Highlight box around hovered cell */}
            <g transform={`translate(${margin.left},${margin.top})`}>
              <rect
                x={hoveredCell.col * cellWidth - 1}
                y={hoveredCell.row * cellHeight - 1}
                width={cellWidth + 2}
                height={cellHeight + 2}
                fill="none"
                stroke={colorScheme === 'dark' ? '#ffffff' : '#000000'}
                strokeWidth="2"
                pointerEvents="none"
              />
            </g>
            {/* Tooltip follows mouse */}
            <g 
              transform={`translate(${
                hoveredCell.mouseX + 15 < dimensions.width - 130 
                  ? hoveredCell.mouseX + 15
                  : hoveredCell.mouseX - 135
              }, ${
                hoveredCell.mouseY + 35 < dimensions.height - 10
                  ? hoveredCell.mouseY + 15
                  : hoveredCell.mouseY - 35
              })`}
              style={{ pointerEvents: 'none' }}
              pointerEvents="none"
            >
              <rect
                x="0"
                y="0"
                width="120"
                height="28"
                fill={colorScheme === 'dark' ? '#2a2a2a' : '#ffffff'}
                stroke={colorScheme === 'dark' ? '#ffffff' : '#000000'}
                strokeWidth="1"
                rx="3"
                opacity="0.95"
              />
              <text x="60" y="18" textAnchor="middle" fontSize="12" fill={colorScheme === 'dark' ? '#ffffff' : '#000000'}>
                N({hoveredCell.row},{hoveredCell.col}) = {hoveredCell.value.toFixed(4)}
              </text>
            </g>
          </>
        )}
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
        </>
      )}
    </div>
  )
}

export default FundamentalMatrixChart