import type { ReactNode } from 'react'

// WFES Type Definitions
// Standardized types for all WFES modules

/**
 * Base parameters common to all WFES models
 */
export interface WfesBaseParams {
  populationSize: number
  selectionCoefficient: number
  dominanceCoefficient: number
  mutationRateForward: number
  mutationRateBackward: number
}

/**
 * Execution options for WFES computations
 */
export interface WfesExecutionOptions {
  threads: number
  library: 'Accelerate' | 'ViennaCL' | 'Pardiso'
  force: boolean
  solver?: string
  initialDistFile?: string
}

export interface WfesOutputOptions {
  /** Destination folder for the matrix/vector files the write* flags request. */
  outputDirectory?: string
  writeQ?: boolean
  writeR?: boolean
  writeB?: boolean
  writeN?: boolean
  writeNExt?: boolean
  writeNFix?: boolean
  writeRes?: boolean
}

/**
 * Standard result format for all WFES computations
 */
export interface WfesResults {
  success: boolean
  results: any
  executionTime: string
  error?: string
}

export interface WfesResultItem {
  /** Rendered label -- a node so quantities can carry subscripts (T_fix). */
  label: ReactNode
  /** ASCII form of the label, used by Copy/Export. See utils/quantityLabels. */
  plain?: string
  value: string | number
  /** Unrounded value, so the clipboard keeps precision the table rounds off. */
  raw?: number | string
  description?: string
}

// Module-specific parameter extensions
/**
 * Parameters specific to WFES Single model
 * @extends {WfesBaseParams}
 */
export interface WfesSingleParams extends WfesBaseParams {
  modelType: 'absorption' | 'fixation' | 'establishment' | 'fundamental' | 'equilibrium' | 'non-absorbing' | 'allele-age'
  alpha?: number
  startingCopies?: number
  observedCopies?: number
  integrationCutoff?: number
  oddsRatio?: number
  noRecurrentMutation?: boolean
}

export interface WfesSweepParams {
  populationSize: number
  selectionCoefficients: number[]
  dominanceCoefficients?: number[]
  mutationRateForward?: number[]
  mutationRateBackward?: number[]
  lambda: number
  alpha?: number
  integrationCutoff?: number
}

export interface WfesSwitchingParams extends WfesBaseParams {
  populationSize2: number
  switchingRate12: number
  switchingRate21: number
  selectionCoefficient2?: number
  dominanceCoefficient2?: number
}

export interface WfesSequentialParams {
  populations: Array<{
    size: number
    selectionCoefficient: number
    dominanceCoefficient: number
    mutationRateForward: number
    mutationRateBackward: number
    generations: number
  }>
}

export interface PhaseTypeParams {
  mode: 'distribution' | 'moments'
  populationSize: number
  selectionCoefficient: number
  dominanceCoefficient: number
  mutationRateForward: number
  mutationRateBackward: number
  samplingFrequency?: number
}

export interface TimeDistParams extends WfesBaseParams {
  generations: number
  startingCopies?: number
  conditional?: boolean
}

export interface WfafsParams {
  populationSize: number
  sampleSize: number
  selectionCoefficient?: number
  dominanceCoefficient?: number
  mutationRateForward?: number
  mutationRateBackward?: number
}

export interface WfafdParams extends WfafsParams {
  // Deterministic version has same params as stochastic
}

// Validation types
export type ValidationRule = (value: any) => boolean | string
export type ValidatorMap = Record<string, ValidationRule>

// Chart/Visualization types
export interface ChartData {
  x: number[]
  y: number[]
  type?: 'line' | 'bar' | 'scatter' | 'heatmap'
  name?: string
}

export interface MatrixData {
  data: number[][]
  rowLabels?: string[]
  colLabels?: string[]
}

// Export types
export type ExportFormat = 'png' | 'svg' | 'csv' | 'json'

export interface ExportOptions {
  format: ExportFormat
  filename?: string
  width?: number
  height?: number
  dpi?: number
}