// Shared components index file
// Export all shared components for easy importing

export { WfesHeader } from './WfesHeader'
export { WfesOptionsDrawer } from './WfesOptionsDrawer'
export { WfesResultsTable } from './WfesResultsTable'
export { 
  WfesParameterInput,
  validateScientificNotation,
  validatePositiveInteger,
  validateProbability,
  validatePositiveNumber
} from './WfesParameterInput'
export { WfesExecutionPanel } from './WfesExecutionPanel'
export { 
  WfesExportButtons,
  exportToCSV,
  exportToJSON,
  generateFilename
} from './WfesExportButtons'
export { WfesViewLayout } from './WfesViewLayout'

// Technical details component with LaTeX support
export { default as TechnicalDetailsPanel, Math } from '../TechnicalDetailsPanel'

// About content panel that loads from markdown files
export { default as AboutContentPanel } from '../AboutContentPanel'
export { default as SwitchingStateDiagram } from './SwitchingStateDiagram'

// Re-export types for convenience
export type { 
  WfesBaseParams,
  WfesExecutionOptions,
  WfesOutputOptions,
  WfesResults,
  WfesResultItem,
  WfesProgressUpdate,
  ExportFormat,
  ExportOptions
} from '../../types/wfes'