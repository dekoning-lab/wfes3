import React from 'react'
import { saveTextFile, saveBlobFile } from '../utils/saveFile'
import FundamentalMatrixChart from './FundamentalMatrixChart'

interface FundamentalMatrixWindowProps {
  isOpen: boolean
  onClose: () => void
  data: number[][]
  populationSize: number
  parameters: {
    N: number
    s: number
    h: number
    u: number
    v: number
  }
}

const FundamentalMatrixWindow: React.FC<FundamentalMatrixWindowProps> = ({
  isOpen,
  onClose,
  data,
  populationSize,
  parameters
}) => {
  if (!isOpen) return null

  const handleExportPNG = () => {
    const svg = document.querySelector('.fundamental-matrix-container svg') as SVGElement
    if (!svg) return

    const svgData = new XMLSerializer().serializeToString(svg)
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    const img = new Image()

    canvas.width = 800
    canvas.height = 800

    img.onload = () => {
      ctx!.fillStyle = 'white'
      ctx!.fillRect(0, 0, canvas.width, canvas.height)
      ctx!.drawImage(img, 0, 0)
      
      canvas.toBlob(blob => {
        // Binary route: an <a download> is silently dropped here.
        void saveBlobFile(blob!, `fundamental_matrix_N${parameters.N}.png`)
      })
    }

    img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svgData)))
  }

  const handleExportSVG = () => {
    const svg = document.querySelector('.fundamental-matrix-container svg') as SVGElement
    if (!svg) return

    const svgData = new XMLSerializer().serializeToString(svg)
    // Through the main process: an <a download> is silently dropped here.
    void saveTextFile(svgData, `fundamental_matrix_N${parameters.N}.svg`)
  }

  const handleExportData = () => {
    // Create CSV content - matrix format
    const csvContent = data.map(row => row.join(',')).join('\n')

    // Through the main process: an <a download> is silently dropped here.
    void saveTextFile(csvContent, `fundamental_matrix_N${parameters.N}.csv`)
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div 
        className="bg-white rounded-lg shadow-xl p-4 relative overflow-hidden"
        style={{
          width: '90%',
          height: '90%',
          maxWidth: '1400px',
          maxHeight: '90vh'
        }}
      >
        <button
          onClick={onClose}
          className="absolute top-4 right-4 text-gray-500 hover:text-gray-700"
        >
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>

        <div className="h-full flex flex-col overflow-hidden">
          <div className="flex items-center justify-between mb-2 flex-shrink-0">
            <h2 className="text-xl font-semibold">Fundamental Matrix Visualization</h2>
            <div className="flex items-center gap-4">
              <button
                onClick={handleExportPNG}
                className="px-3 py-1 text-sm bg-blue-600 text-white rounded hover:bg-blue-700"
              >
                Export PNG
              </button>
              <button
                onClick={handleExportSVG}
                className="px-3 py-1 text-sm bg-blue-600 text-white rounded hover:bg-blue-700"
              >
                Export SVG
              </button>
              <button
                onClick={handleExportData}
                className="px-3 py-1 text-sm bg-green-600 text-white rounded hover:bg-green-700"
              >
                Export Data
              </button>
            </div>
          </div>

          <div className="bg-gray-50 p-2 rounded mb-2 flex-shrink-0">
            <div className="grid grid-cols-3 gap-4 text-sm">
              <div>
                <span className="font-medium">Population Size (N):</span> {parameters.N}
              </div>
              <div>
                <span className="font-medium">Selection (2Ns):</span> {(2 * parameters.N * parameters.s).toFixed(3)}
              </div>
              <div>
                <span className="font-medium">Dominance (h):</span> {parameters.h}
              </div>
              <div>
                <span className="font-medium">Forward Mutation (4Nu):</span> {(4 * parameters.N * parameters.u).toFixed(6)}
              </div>
              <div>
                <span className="font-medium">Backward Mutation (4Nv):</span> {(4 * parameters.N * parameters.v).toFixed(6)}
              </div>
              <div>
                <span className="font-medium">Matrix Size:</span> {data.length} × {data[0]?.length || 0}
              </div>
            </div>
            <div className="mt-2 text-sm text-gray-600">
              The fundamental matrix N(i,j) represents the expected number of visits to state j starting from state i before absorption.
            </div>
          </div>

          <div className="flex-1 fundamental-matrix-container overflow-auto">
            <FundamentalMatrixChart
              data={data}
              populationSize={populationSize}
              className="h-full"
              showExportButton={false}
            />
          </div>
        </div>
      </div>
    </div>
  )
}

export default FundamentalMatrixWindow