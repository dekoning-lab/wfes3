import React from 'react'
import { Paper, Group, Title, ActionIcon, Tooltip, Badge, Box } from '@mantine/core'
import { IconArrowLeft, IconSettings } from '@tabler/icons-react'
import { useMantineTheme } from '@mantine/core'

interface WfesHeaderProps {
  title: string
  onBack?: () => void
  hideBackButton?: boolean
  onOptionsClick?: () => void
  activeOptions?: number
}

export const WfesHeader: React.FC<WfesHeaderProps> = ({
  title,
  onBack,
  hideBackButton = false,
  onOptionsClick,
  activeOptions = 0
}) => {
  const theme = useMantineTheme()

  return (
    <Paper py="sm" px="md" radius={0} style={{ borderBottom: `1px solid ${theme.colors.gray[7]}` }}>
      <Group justify="space-between">
        <Group>
          {!hideBackButton && onBack && (
            <Tooltip label="Back to main menu">
              <ActionIcon onClick={onBack} variant="subtle" size="lg">
                <IconArrowLeft size={20} />
              </ActionIcon>
            </Tooltip>
          )}
          <Title order={4}>{title}</Title>
        </Group>
        {/* The badge counts the output/execution options switched on (files to
            write, force mode); the tooltip says so. */}
        {onOptionsClick && (
          <Tooltip label={activeOptions > 0
            ? `Options & Settings — ${activeOptions} option${activeOptions > 1 ? 's' : ''} enabled (output files, force mode)`
            : 'Options & Settings'}>
            <Box style={{ position: 'relative', padding: '6px' }}>
              <ActionIcon 
                onClick={onOptionsClick} 
                variant="subtle" 
                size="lg"
              >
                <IconSettings size={20} />
              </ActionIcon>
              {activeOptions > 0 && (
                <Badge 
                  size="xs" 
                  color="blue" 
                  variant="filled"
                  style={{ 
                    position: 'absolute', 
                    top: 0, 
                    right: 0,
                    padding: '2px 4px',
                    minWidth: '16px'
                  }}
                >
                  {activeOptions}
                </Badge>
              )}
            </Box>
          </Tooltip>
        )}
      </Group>
    </Paper>
  )
}

export default WfesHeader