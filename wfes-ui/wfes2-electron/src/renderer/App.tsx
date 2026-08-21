import React, { useState, useEffect } from 'react'
import { useMantineColorScheme } from '@mantine/core'
import WfesSingleViewMantine2 from './views/WfesSingleViewMantine2'
import WfesSweepViewMantine from './views/WfesSweepViewMantine'
import WfesSequentialViewMantine from './views/WfesSequentialViewMantine'
import WfesSwitchingViewMantine from './views/WfesSwitchingViewMantine'
import WfafdViewMantine from './views/WfafdViewMantine'
import WfafsViewMantine from './views/WfafsViewMantine'
import TimeDistViewMantine from './views/TimeDistViewMantine'
import PopulationProjectionView from './views/PopulationProjectionView'
import PhaseTypeViewMantine from './views/PhaseTypeViewMantine'
import ResizableNavLayout from './components/ResizableNavLayout'
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
  const { colorScheme } = useMantineColorScheme()

  // Set initial window size only once when the app starts
  useEffect(() => {
    const setInitialWindowSize = async () => {
      try {
        await window.api.window.resize(1400, 900)
      } catch (error) {
        console.error('Error setting initial window size:', error)
      }
    }
    setInitialWindowSize()
  }, []) // Empty dependency array means this only runs once on mount

  // Handler for navigation from the sidebar and from cross-links
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

export default App