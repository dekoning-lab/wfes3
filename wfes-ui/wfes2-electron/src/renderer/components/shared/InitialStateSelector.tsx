/**
 * @file InitialStateSelector.tsx
 * @brief How the starting state is specified, in whichever ways a tool offers.
 *
 * Every tool now accepts --initial, but they do not all offer the same
 * alternatives, and pasting an identical three-way control into each view would
 * advertise choices that do not exist:
 *
 *   - wfes_single and wfes_sweep have all three: a fixed copy count, the
 *     integration over the copy numbers a new mutation produces, or a file.
 *   - wfes_switching and wfes_sequential always integrate over starting copies;
 *     their -p is the starting distribution over MODELS or EPOCHS, a separate
 *     control that stays where it is. So the choice here is integrate or file.
 *   - The distribution tools start from one fixed state and have no -p at all:
 *     default or file.
 *   - The WFAFS tools take a starting count but do not integrate: fixed or file.
 *
 * The expected vector length also differs per tool, and a wrong length is the
 * easiest mistake to make, so the caller states it and it is shown next to the
 * picker rather than left to be discovered from an error.
 */
import React from 'react'
import { SegmentedControl, TextInput, Button, Group, Stack, Text } from '@mantine/core'

export type InitialMode = 'fixed' | 'integrate' | 'file'

interface InitialStateSelectorProps {
  /** Which alternatives this tool actually has, in display order. */
  modes: InitialMode[]
  value: InitialMode
  onChange: (mode: InitialMode) => void
  /** Chosen file path, when the mode is 'file'. */
  file: string
  onFileChange: (path: string) => void
  /** Number of probabilities the file must contain, for this model's state space. */
  expectedLength?: number | null
  /** What those states are, e.g. "allele counts 1..2N-1". */
  stateSpace: string
  /**
   * For a concatenated state space, the blocks in order. Without this a reader
   * knows only the total, and a file of the right length whose mass sits in the
   * wrong block is accepted silently -- the run succeeds and answers a
   * different question.
   */
  blocks?: { label: string; length: number }[]
  disabled?: boolean
}

const LABELS: Record<InitialMode, string> = {
  fixed: 'Fixed p',
  integrate: 'Integrate over p',
  file: 'Custom distribution'
}

export const InitialStateSelector: React.FC<InitialStateSelectorProps> = ({
  modes, value, onChange, file, onFileChange, expectedLength, stateSpace, disabled, blocks
}) => {
  // Row ranges are 1-based, matching how a person counts lines in the file.
  let cursor = 1
  const rows = (blocks ?? []).map(b => {
    const from = cursor
    cursor += b.length
    return { ...b, from, to: cursor - 1 }
  })

  return (
  <Stack gap="xs" mt="sm">
    <SegmentedControl
      size="xs"
      value={value}
      onChange={(v) => onChange(v as InitialMode)}
      data={modes.map(m => ({ value: m, label: LABELS[m] }))}
      disabled={disabled}
    />
    {value === 'file' && (
      <Group gap="xs" align="flex-end">
        <TextInput
          style={{ flex: 1 }}
          label="Initial distribution"
          description={
            expectedLength && expectedLength > 0
              ? `CSV column of ${expectedLength.toLocaleString()} probabilities over ${stateSpace}`
              : `CSV column of probabilities over ${stateSpace}`
          }
          placeholder="No file chosen"
          value={file}
          onChange={(e) => onFileChange(e.currentTarget.value)}
        />
        <Button
          variant="default"
          onClick={async () => {
            const f = await (window as any).api.dialog.openFile()
            if (f) onFileChange(f)
          }}
        >
          Browse...
        </Button>
      </Group>
    )}
    {value === 'file' && rows.length > 1 && (
      <Text size="xs" c="dimmed">
        The states run in blocks, in this order:{' '}
        {rows.map((r, i) => (
          <React.Fragment key={r.label}>
            {i > 0 && '; '}
            <Text span size="xs" fw={600} c="dimmed">rows {r.from.toLocaleString()}&ndash;{r.to.toLocaleString()}</Text>
            {' '}{r.label}
          </React.Fragment>
        ))}
        . A file of the right length whose mass sits in the wrong block is a
        valid run answering a different question.
      </Text>
    )}
  </Stack>
  )
}

export default InitialStateSelector
