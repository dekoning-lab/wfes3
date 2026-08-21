import React from 'react'
import { useExecuteShortcut } from '../../hooks/useExecuteShortcut'
import { Button, Progress, Text, Stack, Group, Loader, Paper, Alert } from '@mantine/core'
import { IconPlayerPlay, IconPlayerStop, IconAlertCircle } from '@tabler/icons-react'

interface WfesExecutionPanelProps {
  isExecuting: boolean
  progress?: number
  progressMessage?: string
  error?: string
  onExecute: () => void
  onStop?: () => void
  showProgress?: boolean
  executeLabel?: string
  compact?: boolean
}

export const WfesExecutionPanel: React.FC<WfesExecutionPanelProps> = ({
  isExecuting,
  progress = 0,
  progressMessage = '',
  error,
  onExecute,
  onStop,
  showProgress = true,
  executeLabel = 'Execute',
  compact = false
}) => {
  // Cmd+Enter (Ctrl+Enter off macOS) runs the same action as the button.
  // Suppressed while a run is in flight so the shortcut cannot queue a second.
  useExecuteShortcut(onExecute, isExecuting)

  if (compact) {
    // Compact mode - just the button
    return (
      <Group>
        {!isExecuting ? (
          <Button 
            leftSection={<IconPlayerPlay size={16} />}
            onClick={onExecute}
            disabled={isExecuting}
          >
            {executeLabel}
          </Button>
        ) : (
          <Button 
            leftSection={<IconPlayerStop size={16} />}
            color="red"
            onClick={onStop}
            disabled={!onStop}
          >
            Stop
          </Button>
        )}
        {isExecuting && <Loader size="sm" />}
      </Group>
    )
  }

  // Full mode with progress
  return (
    <Paper p="md" withBorder>
      <Stack gap="md">
        {error && (
          <Alert icon={<IconAlertCircle size={16} />} color="red" variant="light">
            {error}
          </Alert>
        )}
        
        <Group justify="space-between">
          <Group>
            {!isExecuting ? (
              <Button 
                leftSection={<IconPlayerPlay size={16} />}
                size="lg"
                onClick={onExecute}
                disabled={isExecuting}
              >
                {executeLabel}
              </Button>
            ) : (
              <Button 
                leftSection={<IconPlayerStop size={16} />}
                size="lg"
                color="red"
                onClick={onStop}
                disabled={!onStop}
              >
                Stop Execution
              </Button>
            )}
          </Group>
          
          {isExecuting && (
            <Group gap="xs">
              <Loader size="sm" />
              <Text size="sm" c="dimmed">Processing...</Text>
            </Group>
          )}
        </Group>
        
        {isExecuting && showProgress && (
          <Stack gap="xs">
            <Progress 
              value={progress} 
              size="lg"
              animate
              striped
              color="blue"
            />
            {progressMessage && (
              <Text size="sm" c="dimmed" ta="center">
                {progressMessage}
              </Text>
            )}
          </Stack>
        )}
      </Stack>
    </Paper>
  )
}

export default WfesExecutionPanel