/**
 * @file SolverWarnings.tsx
 * @brief The solver's own caveats about a result it nevertheless returned.
 *
 * The WFES tools use stderr to qualify a successful run: the distribution was
 * truncated at --max-t so every moment computed from it is a lower bound, a
 * quantity was renormalised, a fallback stopping rule was used. They say so and
 * exit 0. Until this component existed the GUI read stdout only, so those
 * results were displayed as final answers while the solver had already said
 * they were not.
 *
 * Design constraints, all deliberate:
 *
 *  - Attached to the results, not a toast. A caveat that disappears after four
 *    seconds is a caveat the user can miss while reading the number it applies
 *    to, and it is gone by the time they copy the value into a manuscript.
 *  - Not dismissable. There is no close button and no "don't show again": the
 *    warning is a property of the result on screen and lives exactly as long.
 *  - Verbatim. Each stderr line is rendered as the solver wrote it, in a
 *    monospace block, with no rewording, ranking or summarising -- the solver
 *    knows what it computed and this component does not.
 *
 * Styling follows the phase-type truncation banner (a yellow Mantine Alert with
 * a short explanatory Text) so the two read as one family when both appear.
 * Mantine's Alert and Code carry their own light/dark palettes, so no colour is
 * hard-coded here.
 */
import React from 'react'
import { Alert, Code, MantineSpacing, Text } from '@mantine/core'
import { IconAlertTriangle } from '@tabler/icons-react'

interface SolverWarningsProps {
  /** Verbatim stderr lines from a run that exited 0. */
  warnings?: string[] | null
  /** Bottom margin, matching whatever the surrounding results section uses. */
  mb?: MantineSpacing
}

export const SolverWarnings: React.FC<SolverWarningsProps> = ({ warnings, mb = 'md' }) => {
  // Nothing on stderr is the normal case for a converged run, and it renders
  // nothing at all -- the alert appears only when the solver actually spoke.
  if (!warnings || warnings.length === 0) return null

  return (
    <Alert
      color="yellow"
      mb={mb}
      title="Solver warnings"
      icon={<IconAlertTriangle size={18} />}
      withCloseButton={false}
    >
      <Text size="sm" mb="xs">
        The run completed, but the solver reported the following. These qualify the results
        below -- read them before using the numbers.
      </Text>
      <Code block style={{ whiteSpace: 'pre-wrap' }}>
        {warnings.join('\n')}
      </Code>
    </Alert>
  )
}
