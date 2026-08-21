import React, { useState } from 'react'
import { Container } from '@mantine/core'
import { WfesHeader } from './WfesHeader'
import { WfesOptionsDrawer, OutputFlagSpec } from './WfesOptionsDrawer'
import { WfesOutputOptions, WfesExecutionOptions } from '../../types/wfes'

interface WfesViewLayoutProps {
  title: string
  onBack?: () => void
  hideBackButton?: boolean
  children: React.ReactNode
  // Options drawer content
  optionsContent?: React.ReactNode
  outputOptions?: WfesOutputOptions
  onOutputOptionsChange?: (options: WfesOutputOptions) => void
  /** Which write checkboxes this tool's drawer offers; see WfesOptionsDrawer. */
  outputFlags?: OutputFlagSpec[]
  executionOptions?: WfesExecutionOptions
  onExecutionOptionsChange?: (options: WfesExecutionOptions) => void
  /** When set, Force renders disabled with this reason; see WfesOptionsDrawer. */
  forceDisabledReason?: string
  // Helper to count active options for badge
  activeOptionsCount?: number
}

export const WfesViewLayout: React.FC<WfesViewLayoutProps> = ({
  title,
  onBack,
  hideBackButton = false,
  children,
  optionsContent,
  outputOptions,
  onOutputOptionsChange,
  outputFlags,
  executionOptions,
  onExecutionOptionsChange,
  forceDisabledReason,
  activeOptionsCount
}) => {
  const [optionsDrawerOpen, setOptionsDrawerOpen] = useState(false)

  // Calculate active options if not provided. Only true checkbox states
  // count: the outputDirectory string also lives in outputOptions and a
  // truthy path must not read as an "active option".
  const activeOptions = activeOptionsCount !== undefined ? activeOptionsCount : (() => {
    let count = 0
    if (outputOptions) {
      count += Object.values(outputOptions).filter(v => v === true).length
    }
    if (executionOptions?.force) count++
    return count
  })()

  const showOptionsButton = !!(optionsContent || outputOptions || executionOptions)

  return (
    <div className="flex flex-col h-full bg-gray-800 dark:bg-gray-800 native-window">
      <WfesHeader
        title={title}
        onBack={onBack}
        hideBackButton={hideBackButton}
        onOptionsClick={showOptionsButton ? () => setOptionsDrawerOpen(true) : undefined}
        activeOptions={activeOptions}
      />

      <Container fluid p="md" className="flex-1 overflow-auto">
        {children}
      </Container>

      {showOptionsButton && (
        <WfesOptionsDrawer
          opened={optionsDrawerOpen}
          onClose={() => setOptionsDrawerOpen(false)}
          outputOptions={outputOptions}
          onOutputOptionsChange={onOutputOptionsChange}
          outputFlags={outputFlags}
          executionOptions={executionOptions}
          onExecutionOptionsChange={onExecutionOptionsChange}
          forceDisabledReason={forceDisabledReason}
        >
          {optionsContent}
        </WfesOptionsDrawer>
      )}
    </div>
  )
}

export default WfesViewLayout