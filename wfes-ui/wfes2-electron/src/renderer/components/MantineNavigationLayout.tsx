import React, { useState } from 'react'
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
  Badge
} from '@mantine/core'
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
  IconChartDots,
  IconBrandGithub
} from '@tabler/icons-react'
import logoImage from '/wfes_logo_225x140.png'

interface MantineNavigationLayoutProps {
  children?: React.ReactNode
  onNavigate: (view: string) => void
}

const MantineNavigationLayout: React.FC<MantineNavigationLayoutProps> = ({ children, onNavigate }) => {
  const [activeView, setActiveView] = useState<string>('')
  const { colorScheme, toggleColorScheme } = useMantineColorScheme()
  
  const handleNavigate = (view: string) => {
    setActiveView(view)
    onNavigate(view)
  }
  
  const isDark = colorScheme === 'dark'
  
  return (
    <div className="flex h-screen overflow-hidden">
      {/* Sidebar using Mantine components */}
      <Paper 
        className="w-[300px] h-full flex flex-col navbar-container"
        radius={0}
        p={0}
        style={{
          backgroundColor: isDark ? '#1f2937' : '#ffffff',
          borderRight: `1px solid ${isDark ? '#374151' : '#e5e7eb'}`,
          position: 'relative',
          overflow: 'hidden'
        }}
      >
        {/* Logo section */}
        <Box p="md" style={{ backgroundColor: isDark ? '#111827' : '#f9fafb' }}>
          <Group justify="space-between">
            <Group>
              <img 
                src={logoImage} 
                alt="WFES Logo" 
                width={60} 
                height={37}
                className=""
              />
              <div>
                <Text size="lg" fw={700}>WFES 2</Text>
                <Text size="xs" c="dimmed">Wright-Fisher Exact Solver</Text>
              </div>
            </Group>
            <ActionIcon 
              variant="subtle" 
              onClick={toggleColorScheme}
              title="Toggle color scheme"
              size="lg"
            >
              {isDark ? <IconSun size={20} /> : <IconMoon size={20} />}
            </ActionIcon>
          </Group>
        </Box>
        
        <Divider />
        
        {/* Navigation with ScrollArea */}
        <ScrollArea className="flex-1" p="xs">
          <Stack gap={0}>
            {/* Solver Section with nested links */}
            <NavLink
              label="Solver"
              leftSection={<IconCalculator size={20} stroke={1.5} />}
              childrenOffset={28}
              defaultOpened
            >
              <NavLink
                label={
                  <Group gap="xs">
                    <Text>Single Population</Text>
                    <Badge size="xs" variant="filled" color="blue">
                      Main
                    </Badge>
                  </Group>
                }
                description="Wright-Fisher exact solver"
                leftSection={<IconDna size={16} />}
                onClick={() => handleNavigate('wfes-single')}
                active={activeView === 'wfes-single'}
              />
              <NavLink
                label="Substitution with Standing Genetic Variation"
                description="WFES Sweep"
                leftSection={<IconTrendingUp size={16} />}
                onClick={() => handleNavigate('wfes-sweep')}
                active={activeView === 'wfes-sweep'}
              />
              <NavLink
                label="Sequential Switching Model"
                description="Fixed switching pattern"
                leftSection={<IconBinaryTree size={16} />}
                onClick={() => handleNavigate('wfes-sequential')}
                active={activeView === 'wfes-sequential'}
              />
              <NavLink
                label="General Switching Model"
                description="Stochastic switching"
                leftSection={<IconChartDots size={16} />}
                onClick={() => handleNavigate('wfes-switching')}
                active={activeView === 'wfes-switching'}
              />
            </NavLink>
            
            {/* Time-Dependent Section with nested links */}
            <NavLink
              label="Time-Dependent Allele Frequency Distributions"
              leftSection={<IconChartBar size={20} stroke={1.5} />}
              childrenOffset={28}
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
              childrenOffset={28}
            >
              <NavLink
                label="Time Distributions"
                description="Fixation or extinction time distributions"
                leftSection={<IconClock size={16} />}
                onClick={() => handleNavigate('time-dist')}
                active={activeView === 'time-dist'}
              />
              <NavLink
                label="Phase Type Distributions"
                description="Substitution time distributions"
                leftSection={<IconChartBar size={16} />}
                onClick={() => handleNavigate('phase-type')}
                active={activeView === 'phase-type'}
              />
            </NavLink>
          </Stack>
        </ScrollArea>
        
        <Divider />
        
        {/* Footer */}
        <Box p="md">
          <Text size="xs" c="dimmed" style={{ textAlign: 'center' }}>Version 2.0</Text>
          <Group justify="center" mt="xs" gap="xs">
            <ActionIcon
              variant="subtle"
              size="sm"
              onClick={() => window.open('https://github.com/dekoning-lab/wfes3', '_blank')}
              title="View on GitHub"
            >
              <IconBrandGithub size={16} />
            </ActionIcon>
            <Text 
              size="lg" 
              fw={600} 
              style={{ 
                fontFamily: 'Courier New, monospace', 
                color: '#ffffff',
                cursor: 'pointer'
              }}
              onClick={() => window.open('https://github.com/dekoning-lab/wfes3', '_blank')}
            >
              de koning lab
            </Text>
          </Group>
        </Box>
      </Paper>
      
      {/* Main content area - keep it simple */}
      <div className={`flex-1 overflow-auto ${isDark ? 'bg-gray-900' : 'bg-gray-50'}`}>
        {children}
      </div>
    </div>
  )
}

export default MantineNavigationLayout