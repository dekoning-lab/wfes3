import React from 'react'

interface HelpDialogProps {
  isOpen: boolean
  onClose: () => void
}

const HelpDialog: React.FC<HelpDialogProps> = ({ isOpen, onClose }) => {
  if (!isOpen) return null

  const handleLinkClick = (url: string) => {
    window.api.shell.openExternal(url)
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl w-[600px] h-[300px] flex flex-col">
        {/* Header */}
        <div className="px-4 py-3 border-b flex items-center justify-between">
          <h2 className="text-lg font-semibold">About WFES</h2>
          <button
            onClick={onClose}
            className="p-1 hover:bg-gray-100 rounded transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 flex flex-col items-center justify-center p-8 text-center space-y-3">
          <h3 className="text-xl font-bold">WFES - Wright-Fisher Exact Solver</h3>
          
          <p className="text-gray-600">Version 2.0</p>
          
          <p className="text-sm text-gray-600">
            Copyright © 2017-2024 Computational Biology Research Lab
          </p>
          
          <p className="text-sm text-gray-600 max-w-md">
            This program is free software: you can redistribute it and/or modify
            it under the terms of the GNU General Public License as published by
            the Free Software Foundation.
          </p>
          
          <div className="pt-2">
            <button
              onClick={() => handleLinkClick('https://github.com/dekoning-lab/wfes3')}
              className="text-blue-600 hover:text-blue-800 underline text-sm"
            >
              View on GitHub
            </button>
          </div>
          
          <p className="text-sm text-gray-600">
            For questions and support, please contact us through our GitHub repository.
          </p>
          
          <div className="pt-2">
            <button
              onClick={() => handleLinkClick('https://jdekoning.ca/')}
              className="text-blue-600 hover:text-blue-800 underline text-sm"
            >
              Visit our lab website
            </button>
          </div>
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t flex justify-center">
          <button
            onClick={onClose}
            className="px-6 py-2 bg-gray-200 text-gray-700 rounded hover:bg-gray-300 transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
}

export default HelpDialog