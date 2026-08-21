import React from 'react'
import { useExecuteShortcut } from '../../hooks/useExecuteShortcut'
import { Button, Text, Stack, Group, Loader, Paper, Alert } from '@mantine/core'
import { IconPlayerPlay, IconPlayerStop, IconAlertCircle } from '@tabler/icons-react'

/**
 * Run / stop, plus a busy indicator while a run is in flight.
 *
 * The busy indicator is INDETERMINATE by design. This panel used to take
 * `progress` and `progressMessage` and draw a percentage bar from them, fed by
 * a main-process scraper that looked for progress lines in the solvers' stderr.
 * The solvers print no such lines, so the bar stayed at 0% for the whole of
 * every run -- a measurement of nothing, presented as a measurement. The WFES
 * tools do not report intermediate progress at all (a run is one sparse solve,
 * not a loop that reports), so there is nothing here to be determinate about,
 * and a spinner is the honest form.
 */
interface WfesExecutionPanelProps {
  isExecuting: boolean
  error?: string
  onExecute: () => void
  onStop?: () => void
  executeLabel?: string
  compact?: boolean
}

export const WfesExecutionPanel: React.FC<WfesExecutionPanelProps> = ({
  isExecuting,
  error,
  onExecute,
  onStop,
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

  // Full mode, with the busy indicator
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
              <Text size="sm" c="dimmed">Running...</Text>
            </Group>
          )}
        </Group>

        {isExecuting && (
          <Text size="sm" c="dimmed" ta="center">
            The solver reports no intermediate progress; the run ends when it returns.
          </Text>
        )}
      </Stack>
    </Paper>
  )
}

export default WfesExecutionPanel