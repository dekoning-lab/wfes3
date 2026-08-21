import React, { useState, useEffect } from 'react'
import { useMantineColorScheme } from '@mantine/core'
import WfesSingleView from './views/WfesSingleView'
import WfesSingleViewMantine from './views/WfesSingleViewMantine'
import WfesSingleViewMantine2 from './views/WfesSingleViewMantine2'
import WfesSweepViewMantine from './views/WfesSweepViewMantine'
import WfesSequentialViewMantine from './views/WfesSequentialViewMantine'
import WfesSwitchingViewMantine from './views/WfesSwitchingViewMantine'
import WfafdViewMantine from './views/WfafdViewMantine'
import WfafsViewMantine from './views/WfafsViewMantine'
import TimeDistViewMantine from './views/TimeDistViewMantine'
import PopulationProjectionView from './views/PopulationProjectionView'
import PhaseTypeViewMantine from './views/PhaseTypeViewMantine'
import NavigationLayout from './components/NavigationLayout'
import SimpleNavigationLayout from './components/SimpleNavigationLayout'
import MantineNavigationLayout from './components/MantineNavigationLayout'
import ResizableNavLayout from './components/ResizableNavLayout'
import logoImage from '/wfes_logo_225x140.png'
// Imported rather than referenced as src="/wfes-main.png": the built renderer is
// loaded over file://, where a leading-slash URL resolves to the filesystem root
// instead of the app directory, so the image silently 404s in the packaged app.
// Importing lets Vite emit a correctly based URL for both dev and build.
import mainLogoImage from '/wfes-main.png'

type ViewType = 'main' | 'wfes-single' | 'wfes-sweep' | 'wfes-sequential' | 'wfes-switching' | 
                'wfaf-s' | 'wfaf-d' | 'time-dist' | 'phase-type' | 'projection'

const App: React.FC = () => {
  const [currentView, setCurrentView] = useState<ViewType>('main')
  // A cross-link can ask for a view AND for which of its tools to land on.
  // Kept here because the target view is mounted by this switch, not by the
  // view holding the link.
  const [phaseTypeMoments, setPhaseTypeMoments] = useState(false)
  const [timeDistTool, setTimeDistTool] = useState<'time-dist' | 'time-dist-dual'>('time-dist')
  const [wfesSubMenuVisible, setWfesSubMenuVisible] = useState(false)
  const [useNewLayout, setUseNewLayout] = useState(true) // Toggle this to switch layouts
  const { colorScheme } = useMantineColorScheme()

  // Set initial window size only once when the app starts
  useEffect(() => {
    const setInitialWindowSize = async () => {
      try {
        if (useNewLayout) {
          // Fixed size for navigation layout
          await window.api.window.resize(1400, 900)
        } else {
          // Set initial size for old layout
          await window.api.window.resize(600, 500)
        }
      } catch (error) {
        console.error('Error setting initial window size:', error)
      }
    }
    setInitialWindowSize()
  }, []) // Empty dependency array means this only runs once on mount

  // Only resize for old layout when view changes
  useEffect(() => {
    if (!useNewLayout && currentView !== 'main') {
      const resizeWindow = async () => {
        try {
          switch (currentView) {
            case 'wfes-single':
              await window.api.window.resize(1000, 920)
              break
            case 'wfes-sweep':
              await window.api.window.resize(900, 805)
              break
            case 'wfes-sequential':
            case 'wfes-switching':
            case 'wfaf-d':
            case 'wfaf-s':
              await window.api.window.resize(1000, 800)
              break
            case 'time-dist':
            case 'phase-type':
              await window.api.window.resize(1100, 790)
              break
            default:
              await window.api.window.resize(600, 500)
          }
        } catch (error) {
          console.error('Error resizing window:', error)
        }
      }
      resizeWindow()
    }
  }, [currentView, useNewLayout])

  const handleMainButtonClick = (button: string) => {
    if (button === 'WFES') {
      setWfesSubMenuVisible(!wfesSubMenuVisible)
    } else {
      setWfesSubMenuVisible(false)
      switch (button) {
        case 'WFAF-S':
          setCurrentView('wfaf-s')
          break
        case 'WFAF-D':
          setCurrentView('wfaf-d')
          break
        case 'Time Dist.':
          setCurrentView('time-dist')
          break
        case 'Phase Type':
          setCurrentView('phase-type')
          break
      }
    }
  }

  const handleWfesSubButtonClick = (subButton: string) => {
    switch (subButton) {
      case 'Single':
        setCurrentView('wfes-single')
        break
      case 'Sweep':
        setCurrentView('wfes-sweep')
        break
      case 'Sequential':
        setCurrentView('wfes-sequential')
        break
      case 'Switching':
        setCurrentView('wfes-switching')
        break
    }
  }

  const renderMainView = () => (
    <div className="flex flex-col h-full native-window native-app">
      {/* Main content area - centered */}
      <div className="flex-1 flex flex-col items-center justify-center px-8">
        {/* Logo and title section */}
        <div className="mb-8 text-center">
          <img 
            src={logoImage} 
            alt="WFES Logo" 
            className="mx-auto mb-4"
            width="225"
            height="140"
            onError={(e) => {
              console.error('Failed to load logo');
              (e.target as HTMLImageElement).style.display = 'none';
            }}
          />
          <h1 className="text-2xl font-normal native-label">
            Wright-Fisher Exact Solver
          </h1>
        </div>
        
        {/* Buttons section */}
        <div className="space-y-3">
          {/* First row of buttons */}
          <div className="flex gap-3 justify-center">
            <button
              onClick={() => handleMainButtonClick('WFES')}
              className="native-button native-button-primary w-32"
            >
              WFES
            </button>
            <button
              onClick={() => handleMainButtonClick('WFAF-S')}
              className="native-button native-button-primary w-32"
            >
              WFAF-S
            </button>
          </div>
          
          {/* Second row of buttons */}
          <div className="flex gap-3 justify-center">
            <button
              onClick={() => handleMainButtonClick('WFAF-D')}
              className="native-button native-button-primary w-32"
            >
              WFAF-D
            </button>
            <button
              onClick={() => handleMainButtonClick('Time Dist.')}
              className="native-button native-button-primary w-32"
            >
              Time Dist.
            </button>
          </div>
          
          {/* Third row with single button */}
          <div className="flex justify-center">
            <button
              onClick={() => handleMainButtonClick('Phase Type')}
              className="native-button native-button-primary w-32"
            >
              Phase Type
            </button>
          </div>

          {/* WFES submenu */}
          {wfesSubMenuVisible && (
            <div className="mt-6 pt-6">
              <div className="native-divider mb-4"></div>
              <h2 className="text-center native-label mb-3">
                WFES Models
              </h2>
              <div className="space-y-2">
                <div className="flex gap-3 justify-center">
                  <button
                    onClick={() => handleWfesSubButtonClick('Single')}
                    className="native-button w-28"
                  >
                    Single
                  </button>
                  <button
                    onClick={() => handleWfesSubButtonClick('Sweep')}
                    className="native-button w-28"
                  >
                    Sweep
                  </button>
                </div>
                <div className="flex gap-3 justify-center">
                  <button
                    onClick={() => handleWfesSubButtonClick('Sequential')}
                    className="native-button w-28"
                  >
                    Sequential
                  </button>
                  <button
                    onClick={() => handleWfesSubButtonClick('Switching')}
                    className="native-button w-28"
                  >
                    Switching
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Bottom status bar */}
      <div className="native-header flex items-center px-4">
        <span className="native-label text-xs">Ready</span>
      </div>
    </div>
  )

  const renderView = () => {
    switch (currentView) {
      case 'main':
        return renderMainView()
      case 'wfes-single':
        return <WfesSingleViewMantine2 onBack={() => setCurrentView('main')} onNavigate={handleNavigate} />
      case 'wfes-sweep':
        return <WfesSweepViewMantine onBack={() => setCurrentView('main')} />
      case 'wfes-sequential':
        return <WfesSequentialViewMantine onBack={() => setCurrentView('main')} />
      case 'wfes-switching':
        return <WfesSwitchingViewMantine onBack={() => setCurrentView('main')} />
      case 'wfaf-s':
        return <WfafsViewMantine onBack={() => setCurrentView('main')} />
      case 'wfaf-d':
        return <WfafdViewMantine onBack={() => setCurrentView('main')} />
      case 'time-dist':
        return <TimeDistViewMantine key={`td-${timeDistTool}`} onBack={() => setCurrentView('main')} initialTool={timeDistTool} />
      case 'phase-type':
        return <PhaseTypeViewMantine key={`pt-${phaseTypeMoments}`} onBack={() => setCurrentView('main')} initialMomentsOnly={phaseTypeMoments} />
      case 'projection':
        return <PopulationProjectionView onBack={() => setCurrentView('main')} />
      default:
        return renderMainView()
    }
  }

  // Handler for navigation in new layout
  const handleNavigate = (
    view: string,
    opts?: { momentsOnly?: boolean; timeDistTool?: 'time-dist' | 'time-dist-dual' }
  ) => {
    // A cross-link names the tool it wants; a nav click names none, and must get
    // the view's own default. Without the reset the last cross-link's choice
    // persisted, so opening Time to Extinction and Fixation from the sidebar
    // landed on time_dist_dual because some earlier link had asked for it.
    setPhaseTypeMoments(opts?.momentsOnly ?? false)
    setTimeDistTool(opts?.timeDistTool ?? 'time-dist')
    setCurrentView(view as ViewType)
  }

  // Render with new navigation layout
  if (useNewLayout) {
    const renderContent = () => {
      switch (currentView) {
        case 'wfes-single':
          return <WfesSingleViewMantine2 onBack={() => handleNavigate('main')} hideBackButton={true} onNavigate={handleNavigate} />
        case 'wfes-sweep':
          return <WfesSweepViewMantine onBack={() => handleNavigate('main')} hideBackButton={true} />
        case 'wfes-sequential':
          return <WfesSequentialViewMantine onBack={() => handleNavigate('main')} hideBackButton={true} />
        case 'wfes-switching':
          return <WfesSwitchingViewMantine onBack={() => handleNavigate('main')} hideBackButton={true} />
        case 'wfaf-s':
          return <WfafsViewMantine onBack={() => handleNavigate('main')} hideBackButton={true} />
        case 'wfaf-d':
          return <WfafdViewMantine onBack={() => handleNavigate('main')} hideBackButton={true} />
        case 'time-dist':
          return <TimeDistViewMantine key={`td-${timeDistTool}`} onBack={() => handleNavigate('main')} hideBackButton={true} initialTool={timeDistTool} />
        case 'phase-type':
          // Keyed so a link arriving with a different tool remounts the view and
          // re-seeds its toggle instead of keeping the previous one.
          return <PhaseTypeViewMantine key={`pt-${phaseTypeMoments}`} onBack={() => handleNavigate('main')} hideBackButton={true} initialMomentsOnly={phaseTypeMoments} />
        case 'projection':
          return <PopulationProjectionView onBack={() => handleNavigate('main')} hideBackButton={true} />
        case 'main':
        default:
          return (
            <div className="flex flex-col items-center justify-center h-full">
              <img 
                src={mainLogoImage}
                alt="WFES Logo" 
                className="mb-8"
                style={{ maxHeight: '600px', maxWidth: '90%' }}
              />
              <h2 className="text-3xl font-bold">Wright-Fisher Exact Solver 3</h2>
            </div>
          )
      }
    }

    return (
      <ResizableNavLayout onNavigate={handleNavigate}>
        {renderContent()}
      </ResizableNavLayout>
    )
  }

  // Original layout
  return renderView()
}

export default App