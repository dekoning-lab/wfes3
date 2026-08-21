import React from 'react'
import PhaseTypeChart from '../PhaseTypeChart'

interface SimpleChartDialogProps {
  isOpen: boolean
  onClose: () => void
  title?: string
  data?: {
    time: number
    probability: number
    cumulative: number
  }[]
}

const SimpleChartDialog: React.FC<SimpleChartDialogProps> = ({
  isOpen,
  onClose,
  title = 'Phase Type Distribution',
  data
}) => {
  if (!isOpen) return null

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl w-[900px] max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="px-4 py-3 border-b flex items-center justify-between">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button
            onClick={onClose}
            className="p-1 hover:bg-gray-100 rounded transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Chart content */}
        <div className="flex-1 p-4 overflow-y-auto">
          <PhaseTypeChart data={data || []} className="min-h-[400px]" />
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-gray-200 text-gray-700 rounded hover:bg-gray-300 transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
}

export default SimpleChartDialog