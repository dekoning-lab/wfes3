import React from 'react'
import { Drawer, Stack, Title, Paper, Checkbox, Text, NumberInput, Select, Divider, Button, Group } from '@mantine/core'
import { WfesOutputOptions, WfesExecutionOptions } from '../../types/wfes'

interface WfesOptionsDrawerProps {
  opened: boolean
  onClose: () => void
  title?: string
  children?: React.ReactNode
  // Standard output options
  outputOptions?: WfesOutputOptions
  onOutputOptionsChange?: (options: WfesOutputOptions) => void
  // Standard execution options
  executionOptions?: WfesExecutionOptions
  onExecutionOptionsChange?: (options: WfesExecutionOptions) => void
  // Additional custom content can be passed as children
}

export const WfesOptionsDrawer: React.FC<WfesOptionsDrawerProps> = ({
  opened,
  onClose,
  title = "Options & Settings",
  children,
  outputOptions,
  onOutputOptionsChange,
  executionOptions,
  onExecutionOptionsChange
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
                onChange={(e) => handleExecutionOptionChange('force', e.currentTarget.checked)}
                description="Skip the parameter sanity checks (--force)"
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
        {outputOptions && onOutputOptionsChange && (
          <Paper p="md" withBorder>
            <Title order={6} mb="sm">Output Options</Title>
            <Stack gap="sm">
              <div>
                <Checkbox 
                  label="Write Q" 
                  checked={outputOptions.writeQ || false} 
                  onChange={(e) => handleOutputOptionChange('writeQ', e.currentTarget.checked)} 
                />
                <Text size="xs" c="dimmed" ml={22}>
                  Transient-to-transient transition probability sub-matrix
                </Text>
              </div>
              <div>
                <Checkbox 
                  label="Write R" 
                  checked={outputOptions.writeR || false} 
                  onChange={(e) => handleOutputOptionChange('writeR', e.currentTarget.checked)} 
                />
                <Text size="xs" c="dimmed" ml={22}>
                  Transient-to-absorbing transition probability sub-matrix
                </Text>
              </div>
              <div>
                <Checkbox 
                  label="Write B" 
                  checked={outputOptions.writeB || false} 
                  onChange={(e) => handleOutputOptionChange('writeB', e.currentTarget.checked)} 
                />
                <Text size="xs" c="dimmed" ml={22}>
                  Absorption probability matrix: B = NR
                </Text>
              </div>
              <div>
                <Checkbox 
                  label="Write N" 
                  checked={outputOptions.writeN || false} 
                  onChange={(e) => handleOutputOptionChange('writeN', e.currentTarget.checked)} 
                />
                <Text size="xs" c="dimmed" ml={22}>
                  Fundamental matrix: N = (I-Q)^(-1)
                </Text>
              </div>
              <div>
                <Checkbox 
                  label="Write N_Ext" 
                  checked={outputOptions.writeNExt || false} 
                  onChange={(e) => handleOutputOptionChange('writeNExt', e.currentTarget.checked)} 
                />
                <Text size="xs" c="dimmed" ml={22}>
                  Fundamental matrix, conditioned on extinction
                </Text>
              </div>
              <div>
                <Checkbox 
                  label="Write N_Fix" 
                  checked={outputOptions.writeNFix || false} 
                  onChange={(e) => handleOutputOptionChange('writeNFix', e.currentTarget.checked)} 
                />
                <Text size="xs" c="dimmed" ml={22}>
                  Fundamental matrix, conditioned on fixation
                </Text>
              </div>
              <div>
                <Checkbox 
                  label="Write Res" 
                  checked={outputOptions.writeRes || false} 
                  onChange={(e) => handleOutputOptionChange('writeRes', e.currentTarget.checked)} 
                />
                <Text size="xs" c="dimmed" ml={22}>
                  Full results summary file
                </Text>
              </div>
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