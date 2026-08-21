import React, { useState } from 'react'
import { AppShell, NavLink, ScrollArea, Image, Text, Group, useMantineColorScheme, Box, Divider } from '@mantine/core'
import { 
  IconCalculator, 
  IconChartLine, 
  IconChartBar,
  IconChevronRight,
  IconSun,
  IconMoon,
  IconDna,
  IconTrendingUp,
  IconBinaryTree,
  IconClock,
  IconChartDots
} from '@tabler/icons-react'
import logoImage from '/wfes_logo_225x140.png'

interface NavigationLayoutProps {
  children?: React.ReactNode
  onNavigate: (view: string) => void
}

const NavigationLayout: React.FC<NavigationLayoutProps> = ({ children, onNavigate }) => {
  const [opened, setOpened] = useState(false)
  const [activeView, setActiveView] = useState<string>('')
  const { colorScheme } = useMantineColorScheme()
  
  const handleNavigate = (view: string) => {
    setActiveView(view)
    onNavigate(view)
  }
  
  return (
    <AppShell
      padding="md"
      navbar={{
        width: 300,
        breakpoint: 'sm',
        collapsed: { mobile: !opened }
      }}
    >
      <AppShell.Navbar p="xs">
        {/* Logo and Title */}
        <AppShell.Section>
          <Box 
            sx={(theme) => ({
              padding: '15px',
              backgroundColor: theme.colorScheme === 'dark' ? 'rgba(75, 85, 99, 0.5)' : 'rgba(249, 250, 251, 0.9)',
              backdropFilter: 'blur(5px)',
              borderRadius: theme.radius.md,
              marginBottom: theme.spacing.xs,
              position: 'relative',
              zIndex: 1
            })}
          >
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
                  <Text size="lg" fw={700} c={colorScheme === 'dark' ? 'white' : 'dark'}>WFES 2</Text>
                  <Text size="xs" c="dimmed">Wright-Fisher Exact Solver</Text>
                </div>
              </Group>
            </Group>
          </Box>
          <Divider my="xs" />
        </AppShell.Section>

        {/* Navigation Links */}
        <AppShell.Section grow component={ScrollArea} mx="-xs" px="xs" mt="sm">
          <NavLink
            label="Solver"
            icon={<IconCalculator size={20} stroke={1.5} />}
            childrenOffset={28}
            defaultOpened
            styles={(theme) => ({
              root: {
                borderRadius: theme.radius.sm,
                marginBottom: 5,
                '&:hover': {
                  backgroundColor: theme.colorScheme === 'dark' ? '#4b5563' : theme.colors.gray[0]
                }
              },
              label: {
                fontSize: theme.fontSizes.sm,
                fontWeight: 600,
                color: theme.colorScheme === 'dark' ? theme.colors.gray[1] : theme.colors.gray[8]
              },
              icon: {
                color: theme.colorScheme === 'dark' ? theme.colors.blue[4] : theme.colors.blue[6]
              }
            })}
          >
            <NavLink 
              label="Single Population" 
              description="Wright-Fisher exact solver"
              onClick={() => handleNavigate('wfes-single')}
              active={activeView === 'wfes-single'}
              icon={<IconDna size={16} />}
              styles={(theme) => ({
                root: {
                  paddingLeft: theme.spacing.xl,
                  borderRadius: theme.radius.sm,
                  '&:hover': {
                    backgroundColor: theme.colorScheme === 'dark' ? '#4b5563' : theme.colors.gray[1]
                  },
                  '&[data-active]': {
                    backgroundColor: theme.colorScheme === 'dark' ? '#1f2937' : theme.colors.blue[0],
                    borderLeft: `3px solid ${theme.colors.blue[5]}`
                  }
                },
                label: {
                  color: theme.colorScheme === 'dark' ? theme.colors.gray[3] : theme.colors.gray[7]
                },
                description: {
                  color: theme.colorScheme === 'dark' ? theme.colors.gray[6] : theme.colors.gray[5]
                }
              })}
            />
            <NavLink 
              label="Substitution with Standing Genetic Variation" 
              description="WFES Sweep"
              onClick={() => handleNavigate('wfes-sweep')}
              active={activeView === 'wfes-sweep'}
              icon={<IconTrendingUp size={16} />}
              styles={(theme) => ({
                root: {
                  paddingLeft: theme.spacing.xl,
                  borderRadius: theme.radius.sm,
                  '&:hover': {
                    backgroundColor: theme.colorScheme === 'dark' ? '#4b5563' : theme.colors.gray[1]
                  },
                  '&[data-active]': {
                    backgroundColor: theme.colorScheme === 'dark' ? '#1f2937' : theme.colors.blue[0],
                    borderLeft: `3px solid ${theme.colors.blue[5]}`
                  }
                },
                label: {
                  color: theme.colorScheme === 'dark' ? theme.colors.gray[3] : theme.colors.gray[7]
                },
                description: {
                  color: theme.colorScheme === 'dark' ? theme.colors.gray[6] : theme.colors.gray[5]
                }
              })}
            />
            <NavLink 
              label="Sequential Switching Model" 
              description="Fixed switching pattern"
              onClick={() => handleNavigate('wfes-sequential')}
              active={activeView === 'wfes-sequential'}
              icon={<IconBinaryTree size={16} />}
              styles={(theme) => ({
                root: {
                  paddingLeft: theme.spacing.xl,
                  borderRadius: theme.radius.sm,
                  '&:hover': {
                    backgroundColor: theme.colorScheme === 'dark' ? '#4b5563' : theme.colors.gray[1]
                  },
                  '&[data-active]': {
                    backgroundColor: theme.colorScheme === 'dark' ? '#1f2937' : theme.colors.blue[0],
                    borderLeft: `3px solid ${theme.colors.blue[5]}`
                  }
                },
                label: {
                  color: theme.colorScheme === 'dark' ? theme.colors.gray[3] : theme.colors.gray[7]
                },
                description: {
                  color: theme.colorScheme === 'dark' ? theme.colors.gray[6] : theme.colors.gray[5]
                }
              })}
            />
            <NavLink 
              label="General Switching Model" 
              description="Stochastic switching"
              onClick={() => handleNavigate('wfes-switching')}
              active={activeView === 'wfes-switching'}
              icon={<IconChartDots size={16} />}
              styles={(theme) => ({
                root: {
                  paddingLeft: theme.spacing.xl,
                  borderRadius: theme.radius.sm,
                  '&:hover': {
                    backgroundColor: theme.colorScheme === 'dark' ? '#4b5563' : theme.colors.gray[1]
                  },
                  '&[data-active]': {
                    backgroundColor: theme.colorScheme === 'dark' ? '#1f2937' : theme.colors.blue[0],
                    borderLeft: `3px solid ${theme.colors.blue[5]}`
                  }
                },
                label: {
                  color: theme.colorScheme === 'dark' ? theme.colors.gray[3] : theme.colors.gray[7]
                },
                description: {
                  color: theme.colorScheme === 'dark' ? theme.colors.gray[6] : theme.colors.gray[5]
                }
              })}
            />
          </NavLink>

          <NavLink
            label="Time-Dependent Allele Frequency Distributions"
            icon={<IconChartBar size={20} stroke={1.5} />}
            childrenOffset={28}
            styles={(theme) => ({
              root: {
                borderRadius: theme.radius.sm,
                marginBottom: 5,
                '&:hover': {
                  backgroundColor: theme.colorScheme === 'dark' ? '#4b5563' : theme.colors.gray[0]
                }
              },
              label: {
                fontSize: theme.fontSizes.sm,
                fontWeight: 600,
                color: theme.colorScheme === 'dark' ? theme.colors.gray[1] : theme.colors.gray[8]
              },
              icon: {
                color: theme.colorScheme === 'dark' ? theme.colors.blue[4] : theme.colors.blue[6]
              }
            })}
          >
            <NavLink 
              label="Stochastic Switching" 
              description="WFAF-S"
              onClick={() => handleNavigate('wfaf-s')}
              active={activeView === 'wfaf-s'}
              icon={<IconChartDots size={16} />}
              styles={(theme) => ({
                root: {
                  paddingLeft: theme.spacing.xl,
                  borderRadius: theme.radius.sm,
                  '&:hover': {
                    backgroundColor: theme.colorScheme === 'dark' ? '#4b5563' : theme.colors.gray[1]
                  },
                  '&[data-active]': {
                    backgroundColor: theme.colorScheme === 'dark' ? '#1f2937' : theme.colors.blue[0],
                    borderLeft: `3px solid ${theme.colors.blue[5]}`
                  }
                },
                label: {
                  color: theme.colorScheme === 'dark' ? theme.colors.gray[3] : theme.colors.gray[7]
                },
                description: {
                  color: theme.colorScheme === 'dark' ? theme.colors.gray[6] : theme.colors.gray[5]
                }
              })}
            />
            <NavLink 
              label="Deterministic Switching" 
              description="WFAF-D"
              onClick={() => handleNavigate('wfaf-d')}
              active={activeView === 'wfaf-d'}
              icon={<IconChartLine size={16} />}
              styles={(theme) => ({
                root: {
                  paddingLeft: theme.spacing.xl,
                  borderRadius: theme.radius.sm,
                  '&:hover': {
                    backgroundColor: theme.colorScheme === 'dark' ? '#4b5563' : theme.colors.gray[1]
                  },
                  '&[data-active]': {
                    backgroundColor: theme.colorScheme === 'dark' ? '#1f2937' : theme.colors.blue[0],
                    borderLeft: `3px solid ${theme.colors.blue[5]}`
                  }
                },
                label: {
                  color: theme.colorScheme === 'dark' ? theme.colors.gray[3] : theme.colors.gray[7]
                },
                description: {
                  color: theme.colorScheme === 'dark' ? theme.colors.gray[6] : theme.colors.gray[5]
                }
              })}
            />
          </NavLink>

          <NavLink
            label="Probability Distributions"
            icon={<IconChartLine size={20} stroke={1.5} />}
            childrenOffset={28}
            styles={(theme) => ({
              root: {
                borderRadius: theme.radius.sm,
                marginBottom: 5,
                '&:hover': {
                  backgroundColor: theme.colorScheme === 'dark' ? '#4b5563' : theme.colors.gray[0]
                }
              },
              label: {
                fontSize: theme.fontSizes.sm,
                fontWeight: 600,
                color: theme.colorScheme === 'dark' ? theme.colors.gray[1] : theme.colors.gray[8]
              },
              icon: {
                color: theme.colorScheme === 'dark' ? theme.colors.blue[4] : theme.colors.blue[6]
              }
            })}
          >
            <NavLink 
              label="Time Distributions" 
              description="Fixation or extinction time distributions"
              onClick={() => handleNavigate('time-dist')}
              active={activeView === 'time-dist'}
              icon={<IconClock size={16} />}
              styles={(theme) => ({
                root: {
                  paddingLeft: theme.spacing.xl,
                  borderRadius: theme.radius.sm,
                  '&:hover': {
                    backgroundColor: theme.colorScheme === 'dark' ? '#4b5563' : theme.colors.gray[1]
                  },
                  '&[data-active]': {
                    backgroundColor: theme.colorScheme === 'dark' ? '#1f2937' : theme.colors.blue[0],
                    borderLeft: `3px solid ${theme.colors.blue[5]}`
                  }
                },
                label: {
                  color: theme.colorScheme === 'dark' ? theme.colors.gray[3] : theme.colors.gray[7]
                },
                description: {
                  color: theme.colorScheme === 'dark' ? theme.colors.gray[6] : theme.colors.gray[5]
                }
              })}
            />
            <NavLink 
              label="Phase Type Distributions" 
              description="Substitution time distributions"
              onClick={() => handleNavigate('phase-type')}
              active={activeView === 'phase-type'}
              icon={<IconChartLine size={16} />}
              styles={(theme) => ({
                root: {
                  paddingLeft: theme.spacing.xl,
                  borderRadius: theme.radius.sm,
                  '&:hover': {
                    backgroundColor: theme.colorScheme === 'dark' ? '#4b5563' : theme.colors.gray[1]
                  },
                  '&[data-active]': {
                    backgroundColor: theme.colorScheme === 'dark' ? '#1f2937' : theme.colors.blue[0],
                    borderLeft: `3px solid ${theme.colors.blue[5]}`
                  }
                },
                label: {
                  color: theme.colorScheme === 'dark' ? theme.colors.gray[3] : theme.colors.gray[7]
                },
                description: {
                  color: theme.colorScheme === 'dark' ? theme.colors.gray[6] : theme.colors.gray[5]
                }
              })}
            />
          </NavLink>
        </AppShell.Section>

        {/* Footer */}
        <AppShell.Section>
          <Divider my="xs" />
          <Box sx={{ padding: '10px', textAlign: 'center' }}>
            <Text size="xs" c="dimmed">
              Version 2.0
            </Text>
          </Box>
        </AppShell.Section>
      </AppShell.Navbar>

      <AppShell.Main>
        {children}
      </AppShell.Main>
    </AppShell>
  )
}

export default NavigationLayout