import React from 'react'
import { Drawer, Stack, Title, Paper, Checkbox, Text, NumberInput, Select, Divider, Button, Group } from '@mantine/core'
import { WfesOutputOptions, WfesExecutionOptions } from '../../types/wfes'

/**
 * One write-checkbox row: which outputOptions key it toggles, and how it is
 * described. Views pass the list of flags THEIR binary declares; a checkbox
 * for a flag the tool does not have is a control that can only lie.
 */
export interface OutputFlagSpec {
  key: keyof WfesOutputOptions
  label: string
  description: string
}

/**
 * The default set: the six matrix/vector outputs of the absorbing-chain
 * solvers (wfes_single is not a consumer of this drawer; wfes_sequential and
 * wfes_switching declare all six). Views whose binaries declare fewer, or
 * different, flags pass their own list. There is deliberately no "Write Res"
 * here any more: no WFES binary declares such a flag, so the checkbox that
 * used to offer it could never produce a file.
 */
export const DEFAULT_OUTPUT_FLAGS: OutputFlagSpec[] = [
  { key: 'writeQ', label: 'Write Q', description: 'Transient-to-transient transition probability sub-matrix' },
  { key: 'writeR', label: 'Write R', description: 'Transient-to-absorbing transition probability sub-matrix' },
  { key: 'writeB', label: 'Write B', description: 'Absorption probability matrix: B = NR' },
  { key: 'writeN', label: 'Write N', description: 'Fundamental matrix: N = (I-Q)^(-1)' },
  { key: 'writeNExt', label: 'Write N_Ext', description: 'Fundamental matrix, conditioned on extinction' },
  { key: 'writeNFix', label: 'Write N_Fix', description: 'Fundamental matrix, conditioned on fixation' }
]

interface WfesOptionsDrawerProps {
  opened: boolean
  onClose: () => void
  title?: string
  children?: React.ReactNode
  // Standard output options
  outputOptions?: WfesOutputOptions
  onOutputOptionsChange?: (options: WfesOutputOptions) => void
  /**
   * Which write checkboxes this tool offers (defaults to the six standard
   * matrix/vector outputs). Pass only flags the spawned binary declares.
   */
  outputFlags?: OutputFlagSpec[]
  // Standard execution options
  executionOptions?: WfesExecutionOptions
  onExecutionOptionsChange?: (options: WfesExecutionOptions) => void
  /**
   * When set, the Force checkbox renders disabled with this reason: some
   * binaries (phase_type_dist, time_dist, time_dist_dual,
   * wfafs_deterministic) do not declare --force and exit 1 on it, so for
   * them the checkbox must be visibly dead rather than silently dropped.
   */
  forceDisabledReason?: string
  // Additional custom content can be passed as children
}

export const WfesOptionsDrawer: React.FC<WfesOptionsDrawerProps> = ({
  opened,
  onClose,
  title = "Options & Settings",
  children,
  outputOptions,
  onOutputOptionsChange,
  outputFlags = DEFAULT_OUTPUT_FLAGS,
  executionOptions,
  onExecutionOptionsChange,
  forceDisabledReason
}) => {
  const handleOutputOptionChange = (
    key: keyof WfesOutputOptions,
    value: WfesOutputOptions[keyof WfesOutputOptions]
  ) => {
    if (onOutputOptionsChange && outputOptions) {
      onOutputOptionsChange({ ...outputOptions, [key]: value })
    }
  }

  const handleExecutionOptionChange = <K extends keyof WfesExecutionOptions>(
    key: K,
    value: WfesExecutionOptions[K]
  ) => {
    if (onExecutionOptionsChange && executionOptions) {
      onExecutionOptionsChange({ ...executionOptions, [key]: value })
    }
  }

  return (
    <Drawer
      opened={opened}
      onClose={onClose}
      title={title}
      position="right"
      size="sm"
      padding="md"
    >
      <Stack>
        {/* Execution Options - if provided */}
        {executionOptions && onExecutionOptionsChange && (
          <Paper p="md" withBorder>
            <Title order={6} mb="sm">Execution</Title>
            <Stack gap="sm">
              <Checkbox
                label="Force"
                checked={executionOptions.force}
                disabled={!!forceDisabledReason}
                onChange={(e) => handleExecutionOptionChange('force', e.currentTarget.checked)}
                description={forceDisabledReason ?? 'Skip the parameter sanity checks (--force)'}
              />

              <NumberInput
                label="Threads"
                description="Number of CPU threads to use"
                value={executionOptions.threads}
                onChange={(value) => handleExecutionOptionChange('threads', value || 1)}
                min={1}
                max={navigator.hardwareConcurrency || 8}
              />

              <Select
                label="Library"
                description="Linear algebra backend"
                value={executionOptions.library}
                onChange={(value) => handleExecutionOptionChange('library', value as any)}
                // Only backends that are actually compiled into the shipped
                // binaries are offered. Previously this listed ViennaCL and
                // Pardiso -- neither of which exists in the macOS build
                // (WFES_USE_VIENNACL is never defined by wfes-cli/CMakeLists.txt,
                // and MKL/Pardiso is #error'd on Apple Silicon) -- so two of the
                // three choices always produced a runtime error, while
                // SuiteSparse and ParU, which do work, were unreachable.
                // On macOS "Accelerate" and "SuiteSparse" are the SAME solver:
                // SolverFactory routes --library Accelerate to SuiteSparse/UMFPACK
                // whenever SuiteSparse is present, which it always is in the
                // shipped build. Offering them as two entries implied a choice
                // that does not exist and put a backend name in the user's
                // records that never ran. Labelled honestly instead.
                data={
                  window.navigator.platform.toLowerCase().includes('mac')
                    ? [
                        { value: 'Accelerate', label: 'Default (UMFPACK)' },
                        { value: 'ParU', label: 'ParU (SuiteSparse, parallel)' }
                      ]
                    : [
                        { value: 'Pardiso', label: 'Pardiso (Intel MKL)' },
                        { value: 'SuiteSparse', label: 'SuiteSparse (UMFPACK)' },
                        { value: 'ParU', label: 'ParU (SuiteSparse, parallel)' }
                      ]
                }
              />

            </Stack>
          </Paper>
        )}

        {/* Output Options - if provided */}
        {outputOptions && onOutputOptionsChange && outputFlags.length > 0 && (
          <Paper p="md" withBorder>
            <Title order={6} mb="sm">Output Options</Title>
            <Stack gap="sm">
              {outputFlags.map((flag) => (
                <div key={String(flag.key)}>
                  <Checkbox
                    label={flag.label}
                    checked={outputOptions[flag.key] === true}
                    onChange={(e) => handleOutputOptionChange(flag.key, e.currentTarget.checked)}
                  />
                  <Text size="xs" c="dimmed" ml={22}>
                    {flag.description}
                  </Text>
                </div>
              ))}
              <Divider my="xs" />

              {/* Destination for the files the checkboxes above request.
                  The CLI flags take a path; the checkboxes are booleans, so
                  without this the builders had to invent a filename and wrote
                  into the app's working directory. */}
              <div>
                <Text size="sm" fw={500}>Output folder</Text>
                <Text size="xs" c="dimmed" mb={6}>
                  Where the files selected above are written. Defaults to Downloads.
                </Text>
                <Group gap="xs" align="center">
                  <Text size="xs" style={{ flex: 1, wordBreak: 'break-all' }}>
                    {outputOptions.outputDirectory || '(Downloads)'}
                  </Text>
                  <Button
                    size="xs"
                    variant="default"
                    onClick={async () => {
                      const dir = await window.api.dialog.selectDirectory()
                      if (dir) handleOutputOptionChange('outputDirectory', dir)
                    }}
                  >
                    Choose...
                  </Button>
                </Group>
              </div>
            </Stack>
          </Paper>
        )}

        {/* Custom content */}
        {children && (
          <>
            {(outputOptions || executionOptions) && <Divider />}
            {children}
          </>
        )}
      </Stack>
    </Drawer>
  )
}

export default WfesOptionsDrawer
