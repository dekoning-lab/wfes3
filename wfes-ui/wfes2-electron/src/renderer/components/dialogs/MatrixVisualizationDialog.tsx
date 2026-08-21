import React, { useState } from 'react'

interface MatrixVisualizationDialogProps {
  isOpen: boolean
  onClose: () => void
  matrices?: {
    I?: string // Base64 encoded image
    Q?: string
    R?: string
    B?: string
    N?: string
    N_ext?: string
    N_fix?: string
    N_tmo?: string
    V?: string
    E?: string
    P?: string
  }
}

const MatrixVisualizationDialog: React.FC<MatrixVisualizationDialogProps> = ({
  isOpen,
  onClose,
  matrices = {}
}) => {
  const [selectedMatrix, setSelectedMatrix] = useState<string>('Q')
  const [zoom, setZoom] = useState(1)
  const [position, setPosition] = useState({ x: 0, y: 0 })
  const [isDragging, setIsDragging] = useState(false)
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 })

  if (!isOpen) return null

  const availableMatrices = Object.entries(matrices)
    .filter(([_, data]) => data)
    .map(([key, _]) => key)

  const handleMouseDown = (e: React.MouseEvent) => {
    setIsDragging(true)
    setDragStart({ x: e.clientX - position.x, y: e.clientY - position.y })
  }

  const handleMouseMove = (e: React.MouseEvent) => {
    if (isDragging) {
      setPosition({
        x: e.clientX - dragStart.x,
        y: e.clientY - dragStart.y
      })
    }
  }

  const handleMouseUp = () => {
    setIsDragging(false)
  }

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault()
    const delta = e.deltaY > 0 ? 0.9 : 1.1
    setZoom(prev => Math.min(Math.max(0.5, prev * delta), 3))
  }

  const resetZoom = () => {
    setZoom(1)
    setPosition({ x: 0, y: 0 })
  }

  const handleDownload = async () => {
    const matrixData = matrices[selectedMatrix as keyof typeof matrices]
    if (matrixData) {
      // Convert base64 to blob and download
      const response = await fetch(`data:image/png;base64,${matrixData}`)
      const blob = await response.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `matrix_${selectedMatrix}.png`
      a.click()
      URL.revokeObjectURL(url)
    }
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl w-[500px] h-[500px] flex flex-col">
        {/* Header */}
        <div className="px-4 py-3 border-b flex items-center justify-between">
          <h2 className="text-lg font-semibold">Matrix Visualization</h2>
          <button
            onClick={onClose}
            className="p-1 hover:bg-gray-100 rounded transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Matrix selector buttons on the right */}
        <div className="flex flex-1">
          {/* Image viewer */}
          <div 
            className="flex-1 relative overflow-hidden bg-gray-100 cursor-move"
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
            onWheel={handleWheel}
          >
            {matrices[selectedMatrix as keyof typeof matrices] ? (
              <img
                src={`data:image/png;base64,${matrices[selectedMatrix as keyof typeof matrices]}`}
                alt={`Matrix ${selectedMatrix}`}
                className="absolute"
                style={{
                  transform: `translate(${position.x}px, ${position.y}px) scale(${zoom})`,
                  transformOrigin: 'center',
                  userSelect: 'none',
                  pointerEvents: 'none'
                }}
              />
            ) : (
              <div className="h-full flex items-center justify-center text-gray-500">
                No matrix data available
              </div>
            )}
          </div>

          {/* Matrix buttons */}
          <div className="w-24 border-l bg-gray-50 p-2 space-y-1 overflow-y-auto">
            {availableMatrices.map(matrix => (
              <button
                key={matrix}
                onClick={() => setSelectedMatrix(matrix)}
                className={`w-full px-3 py-2 text-sm rounded transition-colors ${
                  selectedMatrix === matrix
                    ? 'bg-blue-500 text-white'
                    : 'bg-white hover:bg-gray-100'
                }`}
              >
                {matrix.replace('_', ' ')}
              </button>
            ))}
          </div>
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t flex justify-between">
          <button
            onClick={resetZoom}
            className="px-4 py-2 bg-gray-200 text-gray-700 rounded hover:bg-gray-300 transition-colors"
          >
            Reset Zoom
          </button>
          <div className="flex gap-2">
            <button
              onClick={handleDownload}
              className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600 transition-colors"
            >
              Download
            </button>
            <button
              onClick={onClose}
              className="px-4 py-2 bg-gray-200 text-gray-700 rounded hover:bg-gray-300 transition-colors"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

export default MatrixVisualizationDialog