/**
 * Service layer for WFES calculations
 * Handles communication with the main process via IPC
 * @module wfesService
 */

/**
 * Parameters for WFES Single model execution
 */
export interface WfesSingleParams {
  modelType: string
  populationSize: number
  scaledPopSize?: number
  startingCopies?: number
  integrationCutoff?: number
  observedFrequency?: number
  oddsRatio?: number
  forwardMutation?: number
  backwardMutation?: number
  startMutation: boolean
  selectionCoeff?: number
  dominanceCoeff: number
  outputOptions: {
    writeQ: boolean
    writeR: boolean
    writeB: boolean
    writeN: boolean
    writeNExt: boolean
    writeNFix: boolean
    writeI: boolean
    writeE: boolean
    writeV: boolean
    writeRes: boolean
  }
  executionOptions: {
    force: boolean
    threads: number
    library: string
    solver?: string
    initialDistFile?: string
  }
}

/**
 * Standard result format for WFES calculations
 */
export interface WfesResult {
  success: boolean
  results: any
  executionTime: string
  error?: string
}

/**
 * Service class for managing WFES computations
 * Provides methods for executing different WFES models and handling results
 */
class WfesService {
  /**
   * Execute WFES Single model computation
   * @param {WfesSingleParams} params - Model parameters
   * @returns {Promise<WfesResult>} Computation results
   */
  async executeSingle(params: WfesSingleParams): Promise<WfesResult> {
    try {
      const result = await window.api.wfes.single.execute(params)
      return result
    } catch (error) {
      console.error('WFES Single execution error:', error)
      return {
        success: false,
        results: null,
        executionTime: '0s',
        error: error instanceof Error ? error.message : 'Unknown error'
      }
    }
  }

  /**
   * Execute WFES Sweep model computation
   * @param {any} params - Sweep model parameters
   * @returns {Promise<WfesResult>} Sweep analysis results
   */
  async executeSweep(params: any): Promise<WfesResult> {
    try {
      const result = await window.api.wfes.sweep.execute(params)
      return result
    } catch (error) {
      console.error('WFES Sweep execution error:', error)
      return {
        success: false,
        results: null,
        executionTime: '0s',
        error: error instanceof Error ? error.message : 'Unknown error'
      }
    }
  }

  /**
   * Execute WFES Sequential model computation
   * @param {any} params - Sequential population parameters
   * @returns {Promise<WfesResult>} Sequential analysis results
   */
  async executeSequential(params: any): Promise<WfesResult> {
    try {
      const result = await window.api.wfes.sequential.execute(params)
      return result
    } catch (error) {
      console.error('WFES Sequential execution error:', error)
      return {
        success: false,
        results: null,
        executionTime: '0s',
        error: error instanceof Error ? error.message : 'Unknown error'
      }
    }
  }

  /**
   * Execute WFES Switching model computation
   * @param {any} params - Switching model parameters
   * @returns {Promise<WfesResult>} Switching analysis results
   */
  async executeSwitching(params: any): Promise<WfesResult> {
    try {
      const result = await window.api.wfes.switching.execute(params)
      return result
    } catch (error) {
      console.error('WFES Switching execution error:', error)
      return {
        success: false,
        results: null,
        executionTime: '0s',
        error: error instanceof Error ? error.message : 'Unknown error'
      }
    }
  }

  /**
   * Execute WFAFD (Wright-Fisher Allele Frequency Distribution) computation
   * @param {any} params - WFAFD parameters
   * @returns {Promise<WfesResult>} Frequency distribution results
   */
  async executeWfafd(params: any): Promise<WfesResult> {
    try {
      const result = await window.api.wfes.wfafd.execute(params)
      return result
    } catch (error) {
      console.error('WFAFD execution error:', error)
      return {
        success: false,
        results: null,
        executionTime: '0s',
        error: error instanceof Error ? error.message : 'Unknown error'
      }
    }
  }

  /**
   * Execute WFAFS (Wright-Fisher Allele Frequency Spectrum) computation
   * @param {any} params - WFAFS parameters
   * @returns {Promise<WfesResult>} Frequency spectrum results
   */
  async executeWfafs(params: any): Promise<WfesResult> {
    try {
      const result = await window.api.wfes.wfafs.execute(params)
      return result
    } catch (error) {
      console.error('WFAFS execution error:', error)
      return {
        success: false,
        results: null,
        executionTime: '0s',
        error: error instanceof Error ? error.message : 'Unknown error'
      }
    }
  }

  /**
   * Execute Phase Type computation (distribution or moments)
   * @param {any} params - Phase type parameters including mode
   * @returns {Promise<any>} Distribution data or statistical moments
   */
  async executePhaseType(params: any): Promise<any> {
    try {
      const result = await window.api.wfes.phaseType.execute(params)
      return result
    } catch (error) {
      console.error('Phase Type execution error:', error)
      return {
        success: false,
        results: null,
        executionTime: '0s',
        error: error instanceof Error ? error.message : 'Unknown error'
      }
    }
  }

  /**
   * Execute Time Distribution computation
   * @param {any} params - Time distribution parameters
   * @returns {Promise<WfesResult>} Time distribution results
   */
  async executeTimeDist(params: any): Promise<WfesResult> {
    try {
      const result = await window.api.wfes.timeDist.execute(params)
      return result
    } catch (error) {
      console.error('Time Dist execution error:', error)
      return {
        success: false,
        results: null,
        executionTime: '0s',
        error: error instanceof Error ? error.message : 'Unknown error'
      }
    }
  }

  /**
   * Stop all running WFES computations
   * @returns {Promise<void>}
   */
  async stopExecution(): Promise<void> {
    try {
      await window.api.wfes.stopExecution()
    } catch (error) {
      console.error('Error stopping execution:', error)
    }
  }

  /**
   * Validate parameters for WFES Single model before execution
   * @param {Partial<WfesSingleParams>} params - Parameters to validate
   * @returns {string[]} Array of validation error messages (empty if valid)
   * @remarks Checks model-specific required parameters
   */
  validateSingleParams(params: Partial<WfesSingleParams>): string[] {
    const errors: string[] = []

    if (!params.populationSize || params.populationSize <= 0) {
      errors.push('Population size must be a positive integer')
    }

    if (params.modelType === 'absorption' || params.modelType === 'fixation' || 
        params.modelType === 'establishment' || params.modelType === 'alleleAge') {
      if (!params.startingCopies) {
        errors.push('Starting copies (p) is required for this model type')
      }
    }

    if (params.modelType === 'establishment' && !params.oddsRatio) {
      errors.push('Odds ratio (k) is required for establishment mode')
    }

    if (params.modelType === 'alleleAge' && !params.observedFrequency) {
      errors.push('Observed frequency (x) is required for allele age mode')
    }

    return errors
  }
}

/**
 * Singleton instance of WfesService
 * @exports wfesService
 */
export const wfesService = new WfesService()