import React, { useState } from 'react'
import { useMantineColorScheme } from '@mantine/core'
import { 
  IconCalculator, 
  IconChartLine, 
  IconChartBar,
  IconSun,
  IconMoon,
  IconDna,
  IconTrendingUp,
  IconBinaryTree,
  IconClock,
  IconChartDots
} from '@tabler/icons-react'
import logoImage from '/wfes_logo_225x140.png'

interface SimpleNavigationLayoutProps {
  children?: React.ReactNode
  onNavigate: (view: string) => void
}

const SimpleNavigationLayout: React.FC<SimpleNavigationLayoutProps> = ({ children, onNavigate }) => {
  const [activeView, setActiveView] = useState<string>('')
  const { colorScheme, toggleColorScheme } = useMantineColorScheme()
  
  const handleNavigate = (view: string) => {
    setActiveView(view)
    onNavigate(view)
  }
  
  const isDark = colorScheme === 'dark'
  
  return (
    <div className="flex h-screen overflow-hidden">
      {/* Sidebar */}
      <div className={`w-[300px] h-full overflow-y-auto border-r ${isDark ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-200'}`}>
        {/* Logo section */}
        <div className={`p-4 mb-4 ${isDark ? 'bg-gray-900' : 'bg-gray-50'}`}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <img 
                src={logoImage} 
                alt="WFES Logo" 
                width={60} 
                height={37}
                className=""
              />
              <div>
                <h1 className={`text-lg font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>WFES 2</h1>
                <p className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>Wright-Fisher Exact Solver</p>
              </div>
            </div>
            <button
              onClick={toggleColorScheme}
              className={`p-2 rounded ${isDark ? 'hover:bg-gray-700' : 'hover:bg-gray-200'}`}
              title="Toggle color scheme"
            >
              {isDark ? <IconSun size={20} /> : <IconMoon size={20} />}
            </button>
          </div>
        </div>
        
        {/* Navigation */}
        <nav className="px-3">
          <div className="mb-6">
            <h2 className={`px-3 mb-2 text-sm font-semibold ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
              Solver
            </h2>
            <div className="space-y-1">
              <button
                onClick={() => handleNavigate('wfes-single')}
                className={`w-full text-left px-3 py-2 rounded text-sm ${
                  activeView === 'wfes-single' 
                    ? isDark ? 'bg-blue-900 text-blue-200' : 'bg-blue-50 text-blue-700'
                    : isDark ? 'hover:bg-gray-700 text-gray-300' : 'hover:bg-gray-100 text-gray-700'
                }`}
              >
                Single Population
              </button>
              <button
                onClick={() => handleNavigate('wfes-sweep')}
                className={`w-full text-left px-3 py-2 rounded text-sm ${
                  activeView === 'wfes-sweep' 
                    ? isDark ? 'bg-blue-900 text-blue-200' : 'bg-blue-50 text-blue-700'
                    : isDark ? 'hover:bg-gray-700 text-gray-300' : 'hover:bg-gray-100 text-gray-700'
                }`}
              >
                Substitution with Standing Genetic Variation
              </button>
              <button
                onClick={() => handleNavigate('wfes-sequential')}
                className={`w-full text-left px-3 py-2 rounded text-sm ${
                  activeView === 'wfes-sequential' 
                    ? isDark ? 'bg-blue-900 text-blue-200' : 'bg-blue-50 text-blue-700'
                    : isDark ? 'hover:bg-gray-700 text-gray-300' : 'hover:bg-gray-100 text-gray-700'
                }`}
              >
                Sequential Switching Model
              </button>
              <button
                onClick={() => handleNavigate('wfes-switching')}
                className={`w-full text-left px-3 py-2 rounded text-sm ${
                  activeView === 'wfes-switching' 
                    ? isDark ? 'bg-blue-900 text-blue-200' : 'bg-blue-50 text-blue-700'
                    : isDark ? 'hover:bg-gray-700 text-gray-300' : 'hover:bg-gray-100 text-gray-700'
                }`}
              >
                General Switching Model
              </button>
            </div>
          </div>
          
          <div className="mb-6">
            <h2 className={`px-3 mb-2 text-sm font-semibold ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
              Time-Dependent Allele Frequency Distributions
            </h2>
            <div className="space-y-1">
              <button
                onClick={() => handleNavigate('wfaf-s')}
                className={`w-full text-left px-3 py-2 rounded text-sm ${
                  activeView === 'wfaf-s' 
                    ? isDark ? 'bg-blue-900 text-blue-200' : 'bg-blue-50 text-blue-700'
                    : isDark ? 'hover:bg-gray-700 text-gray-300' : 'hover:bg-gray-100 text-gray-700'
                }`}
              >
                Stochastic Switching
              </button>
              <button
                onClick={() => handleNavigate('wfaf-d')}
                className={`w-full text-left px-3 py-2 rounded text-sm ${
                  activeView === 'wfaf-d' 
                    ? isDark ? 'bg-blue-900 text-blue-200' : 'bg-blue-50 text-blue-700'
                    : isDark ? 'hover:bg-gray-700 text-gray-300' : 'hover:bg-gray-100 text-gray-700'
                }`}
              >
                Deterministic Switching
              </button>
            </div>
          </div>
          
          <div className="mb-6">
            <h2 className={`px-3 mb-2 text-sm font-semibold ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
              Probability Distributions
            </h2>
            <div className="space-y-1">
              <button
                onClick={() => handleNavigate('time-dist')}
                className={`w-full text-left px-3 py-2 rounded text-sm ${
                  activeView === 'time-dist' 
                    ? isDark ? 'bg-blue-900 text-blue-200' : 'bg-blue-50 text-blue-700'
                    : isDark ? 'hover:bg-gray-700 text-gray-300' : 'hover:bg-gray-100 text-gray-700'
                }`}
              >
                Time Distributions
              </button>
              <button
                onClick={() => handleNavigate('phase-type')}
                className={`w-full text-left px-3 py-2 rounded text-sm ${
                  activeView === 'phase-type' 
                    ? isDark ? 'bg-blue-900 text-blue-200' : 'bg-blue-50 text-blue-700'
                    : isDark ? 'hover:bg-gray-700 text-gray-300' : 'hover:bg-gray-100 text-gray-700'
                }`}
              >
                Phase Type Distributions
              </button>
            </div>
          </div>
        </nav>
        
        {/* Footer */}
        <div className={`mt-auto p-4 text-center border-t ${isDark ? 'border-gray-700' : 'border-gray-200'}`}>
          <p className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>Version 2.0</p>
        </div>
      </div>
      
      {/* Main content */}
      <div className={`flex-1 overflow-auto ${isDark ? 'bg-gray-900' : 'bg-gray-50'}`}>
        {children}
      </div>
    </div>
  )
}

export default SimpleNavigationLayout