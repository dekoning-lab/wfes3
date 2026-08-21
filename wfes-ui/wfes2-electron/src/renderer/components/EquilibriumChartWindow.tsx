import React, { useState } from 'react'
import { saveTextFile, saveBlobFile } from '../utils/saveFile'
import EquilibriumChart from './EquilibriumChart'
import { LabeledCheckBox } from './common/LabeledCheckBox'

interface EquilibriumChartWindowProps {
  isOpen: boolean
  onClose: () => void
  data: Array<{
    copies: number
    probability: number
  }>
  populationSize: number
  expectedFrequency: number
  parameters: {
    N: number
    s: number
    h: number
    u: number
    v: number
  }
}

const EquilibriumChartWindow: React.FC<EquilibriumChartWindowProps> = ({
  isOpen,
  onClose,
  data,
  populationSize,
  expectedFrequency,
  parameters
}) => {
  const [logScale, setLogScale] = useState(false)

  if (!isOpen) return null

  const handleExportPNG = () => {
    const svg = document.querySelector('.equilibrium-chart-container svg') as SVGElement
    if (!svg) return

    const svgData = new XMLSerializer().serializeToString(svg)
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    const img = new Image()

    canvas.width = 800
    canvas.height = 600

    img.onload = () => {
      ctx!.fillStyle = 'white'
      ctx!.fillRect(0, 0, canvas.width, canvas.height)
      ctx!.drawImage(img, 0, 0)
      
      canvas.toBlob(blob => {
        // Binary route: an <a download> is silently dropped here.
        void saveBlobFile(blob!, `equilibrium_distribution_N${parameters.N}.png`)
      })
    }

    img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svgData)))
  }

  const handleExportSVG = () => {
    const svg = document.querySelector('.equilibrium-chart-container svg') as SVGElement
    if (!svg) return

    const svgData = new XMLSerializer().serializeToString(svg)
    // Through the main process: an <a download> is silently dropped here.
    void saveTextFile(svgData, `equilibrium_distribution_N${parameters.N}.svg`)
  }

  const handleExportData = () => {
    // Create CSV content
    const csvContent = [
      'copies,frequency,probability',
      ...data.map(d => `${d.copies},${d.copies / (2 * populationSize)},${d.probability}`)
    ].join('\n')

    // Through the main process: an <a download> is silently dropped here.
    void saveTextFile(csvContent, `equilibrium_distribution_N${parameters.N}.csv`)
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div 
        className="bg-white rounded-lg shadow-xl p-6 relative"
        style={{
          width: '95%',
          height: '85%',
          maxWidth: '1200px',
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

        <div className="h-full flex flex-col">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-semibold">Equilibrium Frequency Distribution</h2>
            <div className="flex items-center gap-4">
              <LabeledCheckBox
                label="Log Scale"
                checked={logScale}
                onChange={setLogScale}
                tooltip="Use logarithmic scale for probability axis"
              />
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

          <div className="bg-gray-50 p-3 rounded mb-4">
            <div className="grid grid-cols-3 gap-4 text-sm">
              <div>
                <span className="font-medium">Expected Frequency:</span> {expectedFrequency.toFixed(6)}
              </div>
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
            </div>
          </div>

          <div className="flex-1 equilibrium-chart-container">
            <EquilibriumChart
              data={data}
              populationSize={populationSize}
              logScale={logScale}
              className="h-full"
              showExportButton={false}
            />
          </div>
        </div>
      </div>
    </div>
  )
}

export default EquilibriumChartWindow