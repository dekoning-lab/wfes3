import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

/**
 * Custom API object exposed to the renderer process
 * Provides secure access to WFES backend functionality and system dialogs
 * @remarks All communication with main process goes through these methods
 */
const api = {
  /**
   * WFES computation APIs
   */
  wfes: {
    /**
     * Execute WFES Single model computation
     * @param {any} params - Model parameters
     * @returns {Promise<any>} Computation results
     */
    single: {
      execute: (params: any) => ipcRenderer.invoke('wfes:single:execute', params)
    },
    /**
     * Execute WFES Sweep model computation
     * @param {any} params - Sweep parameters
     * @returns {Promise<any>} Fixation probabilities
     */
    sweep: {
      execute: (params: any) => ipcRenderer.invoke('wfes:sweep:execute', params)
    },
    /**
     * Execute WFES Sequential model computation
     * @param {any} params - Sequential population parameters
     * @returns {Promise<any>} Sequential analysis results
     */
    sequential: {
      execute: (params: any) => ipcRenderer.invoke('wfes:sequential:execute', params)
    },
    /**
     * Execute WFES Switching model computation
     * @param {any} params - Switching model parameters
     * @returns {Promise<any>} Switching analysis results
     */
    switching: {
      execute: (params: any) => ipcRenderer.invoke('wfes:switching:execute', params)
    },
    /**
     * Execute WFAFD computation
     * @param {any} params - Allele frequency distribution parameters
     * @returns {Promise<any>} Frequency distribution results
     */
    wfafd: {
      execute: (params: any) => ipcRenderer.invoke('wfes:wfafd:execute', params)
    },
    /** Project a distribution from one population size into another. */
    projection: {
      execute: (params: any) => ipcRenderer.invoke('wfes:projection:execute', params)
    },
    /**
     * Execute WFAFS computation
     * @param {any} params - Allele frequency spectrum parameters
     * @returns {Promise<any>} Frequency spectrum results
     */
    wfafs: {
      execute: (params: any) => ipcRenderer.invoke('wfes:wfafs:execute', params)
    },
    /**
     * Execute Phase Type computation
     * @param {any} params - Phase type parameters including mode
     * @returns {Promise<any>} Distribution or moments results
     */
    phaseType: {
      execute: (params: any) => ipcRenderer.invoke('wfes:phaseType:execute', params)
    },
    /**
     * Execute Time Distribution computation
     * @param {any} params - Time distribution parameters
     * @returns {Promise<any>} Time distribution results
     */
    timeDist: {
      execute: (params: any) => ipcRenderer.invoke('wfes:timeDist:execute', params)
    },
    /**
     * Stop all running WFES computations
     * @returns {Promise<void>}
     */
    stopExecution: () => ipcRenderer.invoke('wfes:stopExecution'),
    /**
     * Register a progress update callback
     * @param {Function} callback - Function to call with progress updates
     */
    onProgress: (callback: (data: any) => void) => {
      ipcRenderer.on('wfes:progress', (_event, data) => callback(data))
    },
    /**
     * Remove all progress listeners
     */
    removeProgressListener: () => {
      ipcRenderer.removeAllListeners('wfes:progress')
    }
  },
  /**
   * System dialog APIs
   */
  dialog: {
    /**
     * Open file selection dialog
     * @returns {Promise<string|null>} Selected file path or null if cancelled
     */
    openFile: () => ipcRenderer.invoke('dialog:openFile'),
    /**
     * Choose a folder for matrix/vector output files
     * @returns {Promise<string|null>} Selected directory or null if cancelled
     */
    selectDirectory: () => ipcRenderer.invoke('dialog:selectDirectory'),
    /** Default output folder (the user's Downloads directory) */
    defaultOutputDirectory: () => ipcRenderer.invoke('dialog:defaultOutputDirectory'),
    /**
     * Save renderer-produced text through a native save dialog.
     * @returns {Promise<{saved: boolean, path: string|null}>}
     */
    saveFile: (args: { content: string; defaultFileName: string; directory?: string; encoding?: 'utf8' | 'base64' }) =>
      ipcRenderer.invoke('dialog:saveFile', args)
  },
  /**
   * Window management APIs
   */
  window: {
    /**
     * Resize the main window
     * @param {number} width - New window width
     * @param {number} height - New window height
     * @returns {Promise<void>}
     */
    resize: (width: number, height: number) => ipcRenderer.invoke('window:resize', { width, height })
  },
  
  /**
   * About/Documentation APIs
   */
  about: {
    /**
     * Load About content for a specific model from markdown files
     * @param {string} modelName - Name of the model (e.g., 'wfes_single', 'time_dist')
     * @returns {Promise<{description: string, overview: string, model: string, computations: string, fullContent: string}>} About content sections
     */
    loadContent: (modelName: string) => ipcRenderer.invoke('about:loadContent', modelName)
  }
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}