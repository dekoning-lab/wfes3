import { ElectronAPI } from '@electron-toolkit/preload'

declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      wfes: {
        single: {
          execute: (params: any) => Promise<{
            success: boolean
            results: any
            // Verbatim stderr lines from a run that still succeeded: truncation
            // and normalisation warnings that qualify the numbers above.
            warnings?: string[]
            executionTime: string
            error?: string
          }>
        }
        sweep: {
          execute: (params: any) => Promise<any>
        }
        sequential: {
          execute: (params: any) => Promise<any>
        }
        switching: {
          execute: (params: any) => Promise<any>
        }
        wfafd: {
          execute: (params: any) => Promise<any>
        }
        projection: {
          execute: (params: any) => Promise<any>
        }
        wfafs: {
          execute: (params: any) => Promise<any>
        }
        phaseType: {
          execute: (params: any) => Promise<{
            success: boolean
            moments: string[]
            distribution: string[]
            warnings?: string[]
            executionTime: string
            error?: string
          }>
        }
        timeDist: {
          execute: (params: any) => Promise<any>
        }
        stopExecution: () => Promise<void>
      }
      dialog: {
        openFile: () => Promise<string | null>
        selectDirectory: () => Promise<string | null>
        defaultOutputDirectory: () => Promise<string>
      }
      window: {
        resize: (width: number, height: number) => Promise<void>
      }
      about: {
        loadContent: (modelName: string) => Promise<{
          description: string
          overview: string
          model: string
          computations: string
          fullContent: string
        }>
      }
    }
  }
}