import React, { useState, useRef, useCallback } from 'react'
import { 
  useMantineColorScheme, 
  ScrollArea, 
  ActionIcon, 
  NavLink,
  Paper,
  Group,
  Text,
  Divider,
  Stack,
  Box,
  Tooltip
} from '@mantine/core'
import { 
  IconCalculator,
  IconArrowsExchange, 
  IconChartLine, 
  IconChartBar,
  IconSun,
  IconMoon,
  IconDna,
  IconTrendingUp,
  IconBinaryTree,
  IconClock,
  IconChartDots,
  IconLayoutSidebarLeftCollapse,
  IconLayoutSidebarLeftExpand,
  IconBrandGithub,
  IconBug
} from '@tabler/icons-react'
import logoImage from '/wfes_logo_225x140.png'

interface ResizableNavLayoutProps {
  children?: React.ReactNode
  onNavigate: (view: string) => void
}

const ResizableNavLayout: React.FC<ResizableNavLayoutProps> = ({ children, onNavigate }) => {
  const [activeView, setActiveView] = useState<string>('')
  const [navWidth, setNavWidth] = useState(350)
  const [isNavCollapsed, setIsNavCollapsed] = useState(false)
  const [isResizing, setIsResizing] = useState(false)
  const { colorScheme, toggleColorScheme } = useMantineColorScheme()
  const navRef = useRef<HTMLDivElement>(null)
  
  const handleNavigate = (view: string) => {
    setActiveView(view)
    onNavigate(view)
  }
  
  const isDark = colorScheme === 'dark'
  
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setIsResizing(true)
  }, [])
  
  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!isResizing) return
    
    const newWidth = Math.max(200, Math.min(500, e.clientX))
    setNavWidth(newWidth)
  }, [isResizing])
  
  const handleMouseUp = useCallback(() => {
    setIsResizing(false)
  }, [])
  
  React.useEffect(() => {
    if (isResizing) {
      document.addEventListener('mousemove', handleMouseMove)
      document.addEventListener('mouseup', handleMouseUp)
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
      
      return () => {
        document.removeEventListener('mousemove', handleMouseMove)
        document.removeEventListener('mouseup', handleMouseUp)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }
    }
  }, [isResizing, handleMouseMove, handleMouseUp])
  
  const toggleNav = () => {
    setIsNavCollapsed(!isNavCollapsed)
  }
  
  return (
    <div className="flex h-screen overflow-hidden relative">
      {/* Toggle button - outside navbar so it's always visible */}
      <Tooltip label={isNavCollapsed ? 'Show navigation' : 'Hide navigation'} position="right">
        <ActionIcon
          onClick={toggleNav}
          size="lg"
          radius="md"
          style={{
            position: 'absolute',
            top: '10px',
            left: isNavCollapsed ? '10px' : `${navWidth - 40}px`,
            zIndex: 100,
            backgroundColor: isDark ? '#374151' : '#f3f4f6',
            transition: 'left 0.3s ease',
            border: `1px solid ${isDark ? '#4b5563' : '#e5e7eb'}`
          }}
        >
          {isNavCollapsed ? <IconLayoutSidebarLeftExpand size={20} /> : <IconLayoutSidebarLeftCollapse size={20} />}
        </ActionIcon>
      </Tooltip>
      
      {/* GitHub button - fixed at bottom right of nav panel */}
      {!isNavCollapsed && (
        <>
          <Tooltip label="View on GitHub" position="left">
            <ActionIcon
              onClick={() => window.open('https://github.com/dekoning-lab/wfes3', '_blank')}
              size="lg"
              radius="md"
              style={{
                position: 'absolute',
                bottom: '10px',
                left: `${navWidth - 40}px`,
                zIndex: 100,
                backgroundColor: isDark ? '#374151' : '#f3f4f6',
                transition: 'left 0.3s ease',
                border: `1px solid ${isDark ? '#4b5563' : '#e5e7eb'}`
              }}
            >
              <IconBrandGithub size={20} />
            </ActionIcon>
          </Tooltip>
          
          {/* Create-an-Issue button, left of GitHub */}
          <Tooltip label="Create an issue on GitHub" position="left">
            <ActionIcon
              onClick={() => window.open('https://github.com/dekoning-lab/wfes3/issues/new', '_blank')}
              size="lg"
              radius="md"
              style={{
                position: 'absolute',
                bottom: '10px',
                left: `${navWidth - 78}px`,
                zIndex: 100,
                backgroundColor: isDark ? '#374151' : '#f3f4f6',
                transition: 'left 0.3s ease',
                border: `1px solid ${isDark ? '#4b5563' : '#e5e7eb'}`
              }}
            >
              <IconBug size={20} />
            </ActionIcon>
          </Tooltip>

        </>
      )}
      
      {/* Sidebar using Mantine components */}
      <Paper 
        ref={navRef}
        className={`h-full flex flex-col navbar-container transition-all duration-300 ${isNavCollapsed ? 'overflow-hidden' : ''}`}
        radius={0}
        p={0}
        style={{
          width: isNavCollapsed ? 0 : navWidth,
          backgroundColor: isDark ? '#1f2937' : '#ffffff',
          borderRight: isNavCollapsed ? 'none' : `1px solid ${isDark ? '#374151' : '#e5e7eb'}`,
          position: 'relative',
          overflow: 'hidden'
        }}
      >
        
        {/* Logo section */}
        <Box p="md" style={{ backgroundColor: isDark ? '#111827' : '#f9fafb', position: 'relative' }}>
          <div 
            style={{ 
              display: 'flex', 
              justifyContent: 'center', 
              alignItems: 'center',
              cursor: 'pointer'
            }}
            onClick={() => handleNavigate('main')}
          >
            <img 
              src={logoImage} 
              alt="WFES Logo" 
              width={100} 
              height={62}
              className="hover:opacity-80 transition-opacity"
              title="Back to home"
            />
          </div>
          <ActionIcon 
            variant="subtle" 
            onClick={toggleColorScheme}
            title="Toggle color scheme"
            size="lg"
            style={{
              position: 'absolute',
              top: '10px',
              right: '10px'
            }}
          >
            {isDark ? <IconSun size={20} /> : <IconMoon size={20} />}
          </ActionIcon>
        </Box>
        
        <Divider />
        
        {/* Tagline */}
        <Box p="md">
          <Text size="md" fw={600} style={{ fontStyle: 'italic', textAlign: 'center', color: isDark ? '#e5e7eb' : '#374151' }}>
            Why simulate when you can <span style={{ fontWeight: 800 }}>solve</span>?
          </Text>
        </Box>
        
        <Divider />
        
        {/* Navigation with ScrollArea */}
        {/* marginBottom reserves the strip where the GitHub and issue
            buttons float, so the last menu rows (and their unfold arrows) can
            never be hidden behind them. */}
        <ScrollArea className="flex-1" p="xs" style={{ marginBottom: 52 }}>
          <Stack gap={0}>
            {/* Solver Section with nested links */}
            <NavLink
              label="Solver"
              leftSection={<IconCalculator size={20} stroke={1.5} />}
              childrenOffset={24}
              defaultOpened
            >
              <NavLink
                label="Time-Homogeneous WFES"
                description="Direct solution of many quantities under variations of the time homogeneous WF model"
                leftSection={<IconDna size={16} />}
                onClick={() => handleNavigate('wfes-single')}
                active={activeView === 'wfes-single'}
              />
              <NavLink
                label="Population Projection"
                description="Project an allele frequency distribution from one population size into another, for use as a starting distribution elsewhere"
                leftSection={<IconArrowsExchange size={16} />}
                onClick={() => handleNavigate('projection')}
                active={activeView === 'projection'}
              />
              <NavLink
                label="General Switching Model"
                description="Direct computation of quantities under general time-heterogeneous WF models with stochastic switching behaviour"
                leftSection={<IconChartDots size={16} />}
                onClick={() => handleNavigate('wfes-switching')}
                active={activeView === 'wfes-switching'}
              />
              <NavLink
                label="Sequential Switching Model"
                description="Compute quantities under WF models that pass through an ordered sequence of epochs, each with a geometrically distributed duration"
                leftSection={<IconBinaryTree size={16} />}
                onClick={() => handleNavigate('wfes-sequential')}
                active={activeView === 'wfes-sequential'}
              />
              <NavLink
                label="Substitution with Standing Genetic Variation"
                description="Direct solution of the substitution rate when populations accumulate variation under one model, and then switch to another (e.g., with positive selection)"
                leftSection={<IconTrendingUp size={16} />}
                onClick={() => handleNavigate('wfes-sweep')}
                active={activeView === 'wfes-sweep'}
              />
            </NavLink>
            
            {/* Time-Dependent Section with nested links */}
            <NavLink
              label="Time-Dependent Allele Frequency Distributions"
              leftSection={<IconChartBar size={20} stroke={1.5} />}
              childrenOffset={24}
            >
              <NavLink
                label="Stochastic Switching"
                description="WFAF-S"
                leftSection={<IconChartDots size={16} />}
                onClick={() => handleNavigate('wfaf-s')}
                active={activeView === 'wfaf-s'}
              />
              <NavLink
                label="Deterministic Switching"
                description="WFAF-D"
                leftSection={<IconChartLine size={16} />}
                onClick={() => handleNavigate('wfaf-d')}
                active={activeView === 'wfaf-d'}
              />
            </NavLink>
            
            {/* Probability Distributions Section with nested links */}
            <NavLink
              label="Probability Distributions"
              leftSection={<IconChartLine size={20} stroke={1.5} />}
              childrenOffset={24}
            >
              <NavLink
                label="Time to Extinction and Fixation"
                description="Direct computation of the PDF (slow) for time to conditional absorption under a general WF model (phase-type distributions)"
                leftSection={<IconClock size={16} />}
                onClick={() => handleNavigate('time-dist')}
                active={activeView === 'time-dist'}
              />
              <NavLink
                label="Time to Substitution"
                description="Direct computation of the PDF (slow) or arbitrarily high moments (fast) for time to substitution under a general WF model (phase-type distribution)"
                leftSection={<IconChartBar size={16} />}
                onClick={() => handleNavigate('phase-type')}
                active={activeView === 'phase-type'}
              />
            </NavLink>
          </Stack>
        </ScrollArea>
        
        {/* Resize handle */}
        {!isNavCollapsed && (
          <div
            onMouseDown={handleMouseDown}
            style={{
              position: 'absolute',
              top: 0,
              right: -2,
              bottom: 0,
              width: '4px',
              cursor: 'col-resize',
              backgroundColor: 'transparent',
              transition: 'background-color 0.2s',
            }}
            className="resize-handle"
          />
        )}
      </Paper>
      
      {/* Main content area - keep it simple */}
      <div 
        className={`flex-1 overflow-auto ${isDark ? 'bg-gray-900' : 'bg-gray-50'}`} 
        style={{ 
          paddingLeft: isNavCollapsed ? '60px' : '0',
          transition: 'padding-left 0.3s ease'
        }}
      >
        {children}
      </div>
    </div>
  )
}

export default ResizableNavLayout