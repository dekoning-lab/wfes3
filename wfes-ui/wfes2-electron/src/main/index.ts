import { app, BrowserWindow, Menu, shell, ipcMain, dialog } from 'electron'
import { join } from 'path'
import { promises as fsPromises } from 'fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { wfesBackendService } from './wfesBackendService'
import { AboutContentService } from './aboutContentService'
import * as cliInstaller from './cliInstaller'

/**
 * Returns the first argument that is a finite number, otherwise undefined.
 *
 * Use this for every NUMERIC model parameter instead of `||`.
 *
 * Zero is falsy in JavaScript but is a meaningful value for several WFES
 * parameters: h = 0 is a fully recessive allele, s = 0 is neutrality, u = 0 or
 * v = 0 disables mutation in one direction, alpha = 0 disables tail
 * truncation, and the recorded absorption baseline case uses an integration
 * cutoff of 0. Defaulting these with `||` silently replaced a user-supplied 0
 * with the fallback and computed a DIFFERENT MODEL than the one requested,
 * with no error. Concretely, `params.dominance || params.dominanceCoeff || 0.5`
 * turned h = 0 into h = 0.5 and overstated the fixation probability by 37.6%
 * (P_fix 0.011498 instead of the correct 0.00835934 at N=100, s=0.01).
 *
 * `??` alone is not sufficient here: the renderer sends the output of
 * parseFloat(), which is NaN for a blank field rather than null or undefined,
 * and NaN would otherwise be stringified into the CLI arguments.
 *
 * Numeric strings are accepted so views that keep form state as text work too.
 * Deliberately NOT used for strings, booleans or arrays, where falsy really
 * does mean "not supplied" and `||` / `??` remain correct.
 */
function firstFinite(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number') {
      if (Number.isFinite(value)) return value
      continue
    }
    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Number(value)
      if (Number.isFinite(parsed)) return parsed
    }
  }
  return undefined
}

/**
 * Thread count resolved to a positive integer.
 *
 * Unlike the model parameters above, zero is NOT meaningful here -- a run with
 * zero threads is not a different model, it is an invalid request -- so a
 * non-positive or missing value falls back to 1 rather than being forwarded.
 */
function threadCount(...values: unknown[]): number {
  const n = firstFinite(...values)
  return n === undefined || n < 1 ? 1 : Math.trunc(n)
}

/**
 * Creates the main application window with configured settings
 * @returns {void}
 * @remarks Sets up window dimensions, menu, and loads the appropriate content
 */
/**
 * Ask the user, once, whether the command-line programs should go on the PATH.
 *
 * A DMG is a disk image, not an installer: dragging the app to /Applications
 * runs no script, so there is no install step in which to do this. Offering it
 * at first launch is the closest equivalent, and it is how the user reaches the
 * programs from a terminal without knowing they live inside the bundle.
 */
async function offerCliInstallOnFirstRun(parent: BrowserWindow): Promise<void> {
  if (process.platform !== 'darwin' || !app.isPackaged) return

  // Do not offer what would be refused. No marker is written, so a copy that is
  // later moved into Applications still gets asked on its next launch.
  if (!cliInstaller.bundleMayInstall().ok) return

  const marker = join(app.getPath('userData'), 'cli-install-offered')
  try {
    await fsPromises.access(marker)
    return // already asked; never nag again
  } catch {
    // not yet asked
  }

  const current = await cliInstaller.status()
  if (current.installed) {
    await fsPromises.writeFile(marker, '')
    return
  }

  const { response } = await dialog.showMessageBox(parent, {
    type: 'question',
    buttons: ['Install', 'Not Now'],
    defaultId: 0,
    cancelId: 1,
    message: 'Install the command-line programs?',
    detail:
      'The eleven WFES3 programs can also be run from a terminal. ' +
      'You can do this later from the Tools menu.'
  })

  // Record the offer whichever way it goes, so declining is respected.
  await fsPromises.writeFile(marker, '')
  if (response === 0) await installCliTools(parent)
}

async function installCliTools(parent: BrowserWindow): Promise<void> {
  const result = await cliInstaller.install()
  if (result.cancelled) return

  if (result.ok) {
    await dialog.showMessageBox(parent, {
      type: 'info',
      message: 'Command-line programs installed.',
      detail: 'Open a new terminal and run wfes_single --help to get started.'
    })
  } else {
    await dialog.showMessageBox(parent, {
      type: 'error',
      message: 'The command-line programs could not be installed.',
      detail: result.error ?? 'Unknown error.'
    })
  }
}

async function uninstallCliTools(parent: BrowserWindow): Promise<void> {
  const before = await cliInstaller.status()
  if (!before.linked.length) {
    await dialog.showMessageBox(parent, {
      type: 'info',
      message: 'Nothing to remove.',
      detail: 'The command-line programs are not installed.'
    })
    return
  }

  const result = await cliInstaller.uninstall()
  if (result.cancelled) return

  await dialog.showMessageBox(parent, {
    type: result.ok ? 'info' : 'error',
    message: result.ok ? 'Command-line programs removed.' : 'They could not all be removed.',
    detail: result.ok
      ? 'They are still available inside the application.'
      : (result.error ?? 'Unknown error.')
  })
}

/**
 * Absolute path to the window icon, or undefined on platforms that ignore it.
 *
 * macOS takes both the window and dock icon from the bundle's CFBundleIconFile
 * (build/icon.icns, set as mac.icon in electron-builder.yml) and ignores
 * BrowserWindow's `icon` option entirely, so passing one there is at best a
 * no-op. It was worse than a no-op: `build/` is not in electron-builder's
 * `files` list, so in a packaged app join(__dirname, '../../build/icon.png')
 * resolved to a path inside app.asar that does not exist.
 *
 * Windows and Linux DO honour the option, so keep it for them -- resolved
 * against the source tree in dev and against resourcesPath when packaged (see
 * the icon.png entry in electron-builder.yml's extraResources).
 */
function windowIconPath(): string | undefined {
  if (process.platform === 'darwin') return undefined
  return is.dev
    ? join(__dirname, '../../build/icon.png')
    : join(process.resourcesPath, 'icon.png')
}

function createWindow(): void {
  // Create the main browser window
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    resizable: true,
    minWidth: 1200,
    minHeight: 600,
    show: false,
    autoHideMenuBar: false,
    icon: windowIconPath(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
    // After the window is up, so the dialog has a parent and does not appear
    // before the user has seen the application.
    void offerCliInstallOnFirstRun(mainWindow)
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // Create application menu
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'File',
      submenu: [
        { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' }
      ]
    },
    {
      label: 'Settings',
      submenu: [
        {
          label: 'Preferences',
          click: () => {
            // TODO: Open settings dialog
          }
        }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' }
      ]
    },
    {
      label: 'Windows',
      submenu: [
        {
          label: 'Main Window',
          click: () => {
            mainWindow.focus()
          }
        }
      ]
    },
    {
      label: 'Tools',
      submenu: [
        {
          label: 'Install Command-Line Programs…',
          enabled: process.platform === 'darwin',
          click: () => {
            void installCliTools(mainWindow)
          }
        },
        {
          label: 'Remove Command-Line Programs…',
          enabled: process.platform === 'darwin',
          click: () => {
            void uninstallCliTools(mainWindow)
          }
        }
      ]
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'About WFES3',
          click: () => {
            // TODO: Open about dialog
          }
        }
      ]
    }
  ]

  const menu = Menu.buildFromTemplate(template)
  Menu.setApplicationMenu(menu)

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

/**
 * Sets up IPC (Inter-Process Communication) handlers for all WFES operations
 * @returns {void}
 * @remarks Establishes communication between main and renderer processes
 * @remarks Handles execution of all WFES tools and utility operations
 */
function setupIpcHandlers(): void {
  /**
   * Handle window resize requests from renderer
   * @param {IpcMainInvokeEvent} event - IPC event object
   * @param {Object} params - Resize parameters
   * @param {number} params.width - New window width
   * @param {number} params.height - New window height
   */
  ipcMain.handle('window:resize', async (event, { width, height }) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (window) {
      window.setSize(width, height)
      window.center()
    }
  })
  
  /**
   * Handle WFES Single execution requests
   * @param {IpcMainInvokeEvent} event - IPC event object
   * @param {any} params - Model parameters from frontend
   * @returns {Promise<Object>} Execution results with success status
   */
  ipcMain.handle('wfes:single:execute', async (_event, params) => {
    console.log('Executing WFES Single with params:', params)
    
    try {
      // Convert frontend params to backend format
      // Numeric parameters go through firstFinite so that a user-supplied 0 is
      // preserved rather than silently replaced by the fallback. See the
      // comment on firstFinite for why `||` is wrong here.
      const backendParams = {
        model_type: params.modelType,
        population_size: firstFinite(params.population_size, params.populationSize),
        alpha: firstFinite(params.alpha, 1e-20),
        selection_coefficient: firstFinite(params.selection, params.selectionCoeff),
        dominance_coefficient: firstFinite(params.dominance, params.dominanceCoeff, 0.5),
        backward_mutation_rate: firstFinite(params.backward_mutation, params.backwardMutation),
        forward_mutation_rate: firstFinite(params.forward_mutation, params.forwardMutation),
        no_recurrent_mutation: params.noRecurrentMutation || false,
        starting_copies: firstFinite(params.starting_copies, params.startingCopies),
        observed_copies: firstFinite(params.observed_copies, params.observedCopies),
        num_moments: firstFinite(params.num_moments, params.numMoments),
        generations: firstFinite(params.generations),
        integration_cutoff: firstFinite(params.integration_cutoff, params.integrationCutoff, 1e-10),
        odds_ratio: firstFinite(params.odds_ratio, params.oddsRatio, 1.0),
        n_threads: threadCount(params.n_threads, params.numThreads, params.executionOptions?.threads),
        library: params.library || (params.executionOptions?.library) || 'Accelerate',
        output_options: params.outputOptions,
        // Forwarded so the CLI flags the tool has always accepted are reachable.
        // Previously the view's Force checkbox and its initial-distribution file
        // picker were collected here and then dropped on the floor.
        force: params.force ?? params.executionOptions?.force ?? false,
        verbose: params.verbose ?? false,
        block_size: firstFinite(params.block_size, params.blockSize),
        initial: params.initial ?? params.executionOptions?.initialDistFile
      }
      
      // Execute using backend service
      const startTime = Date.now()
      const results = await wfesBackendService.executeWfesSingle(backendParams)
      const executionTime = ((Date.now() - startTime) / 1000).toFixed(3)
      
      console.log('Backend service returned:', JSON.stringify(results, null, 2))
      
      return {
        success: true,
        results: results.results,
        // What the solver said on stderr while still exiting 0. This handler
        // picks fields out of the service result rather than passing it
        // through, so without this line the warnings stop here and the view
        // presents qualified numbers as final ones.
        warnings: results.warnings || [],
        executionTime: `${executionTime}s`
      }
    } catch (error) {
      console.error('WFES Single execution error:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred',
        results: null
      }
    }
  })

  /**
   * Handle WFES Sweep execution requests
   * @param {IpcMainInvokeEvent} event - IPC event object
   * @param {any} params - Sweep model parameters
   * @returns {Promise<Object>} Execution results with fixation probabilities
   */
  ipcMain.handle('wfes:sweep:execute', async (_event, params) => {
    console.log('Executing WFES Sweep with params:', params)
    
    try {
      // Convert frontend params to backend format
      // Scalars use firstFinite to preserve a supplied 0; the array-valued
      // parameters keep ?? because an empty array is truthy and only
      // null/undefined mean "not supplied" for them.
      const backendParams = {
        // Forwarded, or the chosen file never reaches the builder.
        initial: params.initial,
        population_size: firstFinite(params.population_size, params.populationSize),
        selection_coefficients: params.selection_coefficients ?? params.selectionCoefficients,
        lambda: firstFinite(params.lambda),
        dominance: params.dominance ?? [0.5, 0.5],
        backward_mutation: params.backward_mutation ?? params.backwardMutation ?? [1e-9, 1e-9],
        forward_mutation: params.forward_mutation ?? params.forwardMutation ?? [1e-9, 1e-9],
        alpha: firstFinite(params.alpha, 1e-20),
        n_threads: threadCount(params.n_threads, params.numThreads),
        integration_cutoff: firstFinite(params.integration_cutoff, params.integrationCutoff, 1e-10),
        starting_copies: firstFinite(params.starting_copies, params.startingCopies),
        // Everything below was collected by the view, printed in its copyable
        // preview, and then dropped here.
        //
        // --force and --library are the two the run actually noticed: ticking
        // Force did nothing, and choosing a solver library other than the
        // platform default silently ran the default instead, while the preview
        // named the chosen one. Both flags exist on wfes_sweep.
        force: params.force ?? false,
        library: params.library,
        // The sweep view is fixation-only today (modelType is a constant), so
        // this changes no command line; it is forwarded because a handler that
        // drops what the view sends is how the two above went unnoticed.
        model_type: params.model_type,
        // The write flags. Forwarding them does not yet emit --output-Q/R/N/B:
        // the builder reads output_options.writeQ..writeB while the view sends
        // these flat keys, a key-map mismatch left for the reconciliation task.
        // The handler is now transparent, which that task needs.
        output_Q: params.output_Q,
        output_R: params.output_R,
        output_N: params.output_N,
        output_B: params.output_B
        // params.solver is deliberately NOT forwarded: no WFES binary declares
        // --solver (wfes_sweep_main.cpp lists no such flag, and passing one is
        // a fatal parse error), which is why the phase-type handler drops it
        // too. Forwarding it would arm exactly that abort for whichever future
        // change teaches the builder to read it.
      }
      
      // Execute using backend service
      const startTime = Date.now()
      const results = await wfesBackendService.executeWfesSweep(backendParams)
      const executionTime = ((Date.now() - startTime) / 1000).toFixed(3)
      
      return {
        success: true,
        results: results.results,
        warnings: results.warnings || [],
        executionTime: `${executionTime}s`
      }
    } catch (error) {
      console.error('WFES Sweep execution error:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred',
        results: null
      }
    }
  })

  /**
   * Handle Phase Type execution requests (distribution or moments)
   * @param {IpcMainInvokeEvent} event - IPC event object
   * @param {any} params - Phase type parameters including mode
   * @returns {Promise<Object>} Distribution data or statistical moments
   */
  ipcMain.handle('wfes:phaseType:execute', async (_event, params) => {
    console.log('Executing Phase Type with params:', params)
    
    try {
      // Convert frontend params to backend format
      const backendParams = {
        // Forwarded, or the chosen file never reaches the builder.
        initial: params.initial,
        mode: params.mode, // 'dist' or 'moments'
        population_size: parseInt(params.populationParams.N),
        starting_frequency: parseFloat(params.populationParams.a),
        // Mode-specific population parameters
        ...(params.mode === 'dist' ? {
          distribution_cutoff: parseFloat(params.populationParams.c),
          max_generations: parseInt(params.populationParams.m)
        } : {}),
        ...(params.mode === 'moments' ? {
          num_moments: parseInt(params.populationParams.k)
        } : {}),
        selection_coefficient: parseFloat(params.selectionParams.s),
        dominance_coefficient: parseFloat(params.selectionParams.h),
        backward_mutation_rate: parseFloat(params.mutationParams.u),
        forward_mutation_rate: parseFloat(params.mutationParams.v),
        // Recurrent mutation for moments mode
        ...(params.mode === 'moments' ? {
          recurrent_mutation: params.mutationParams.r
        } : {}),
        force: params.executionParams.force,
        n_threads: parseInt(params.executionParams.threads) || 1,
        library: params.executionParams.library || 'Accelerate',
        // No solver is forwarded: no WFES binary declares --solver, and
        // passing one aborts the run at argument parsing.
        // Output options
        output_Q: params.outputOptions.Q,
        output_R: params.outputOptions.R,
        // Destination for the files the write flags request. Without this the
        // arg builder's outputPath() had nothing to read and every file went
        // to Downloads regardless of the folder chosen in the options drawer.
        output_directory: params.outputOptions.outputDirectory,
        ...(params.mode === 'dist' ? {
          output_P: params.outputOptions.P
        } : {}),
        ...(params.mode === 'moments' ? {
          output_Res: params.outputOptions.Res
        } : {})
      }
      
      // Execute using backend service
      const startTime = Date.now()
      const results = await wfesBackendService.executePhaseType(backendParams)
      const executionTime = ((Date.now() - startTime) / 1000).toFixed(3)
      
      // Return mode-specific results
      if (params.mode === 'moments') {
        return {
          success: true,
          mean: results.mean,
          std: results.std,
          moments: results.moments || [],
          warnings: results.warnings || [],
          executionTime: `${executionTime}s`
        }
      } else {
        return {
          success: true,
          distribution: results.distribution || [],
          warnings: results.warnings || [],
          // The parser has always produced `statistics`; this handler dropped
          // it, so everything it carried -- including whether the solver
          // converged or merely ran out of generations -- never reached the
          // view, which then presented truncated moments as final.
          statistics: results.statistics || {},
          executionTime: `${executionTime}s`
        }
      }
    } catch (error) {
      console.error('Phase Type execution error:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred',
        moments: [],
        distribution: []
      }
    }
  })

  /**
   * Handle Time Distribution execution requests
   * @param {IpcMainInvokeEvent} event - IPC event object
   * @param {any} params - Time distribution parameters with mode
   * @returns {Promise<Object>} Time distribution results and statistics
   * @remarks Supports time-dist, time-dist-dual, and time-dist-sgv modes
   */
  ipcMain.handle('wfes:timeDist:execute', async (_event, params) => {
    console.log('Executing Time Dist with params:', params)
    
    try {
      // Convert frontend params to backend format
      const backendParams = {
        // Forwarded, or the chosen file never reaches the builder.
        initial: params.initial,
        mode: params.mode,
        // For SGV mode, pass through components and population params
        components: params.components,
        populationParams: params.populationParams,
        // For non-SGV modes, these are used
        mutationParams: params.mutationParams,
        selectionParams: params.selectionParams,
        noRecurrentMutation: params.noRecurrentMutation,
        outputOptions: params.outputOptions,
        executionParams: params.executionParams,
        // Pass through top-level execution params if they exist (for SGV compatibility)
        n_threads: params.n_threads,
        library: params.library
      }
      
      // Execute using backend service
      const startTime = Date.now()
      const results = await wfesBackendService.executeTimeDist(backendParams)
      const executionTime = ((Date.now() - startTime) / 1000).toFixed(3)
      
      return {
        success: true,
        results: results.results || [],
        distribution: results.distribution || [],
        warnings: results.warnings || [],
        // Dropped here, exactly as in the phase-type handler: the solver's own
        // account of whether it converged never reached the view, so a run that
        // stopped at the generation limit looked identical to one that finished.
        statistics: results.statistics || {},
        executionTime: `${executionTime}s`
      }
    } catch (error) {
      console.error('Time Dist execution error:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred',
        results: []
      }
    }
  })

  // Handle WFAFS execution
  ipcMain.handle('wfes:wfafs:execute', async (_event, params) => {
    console.log('Executing WFAFS with params:', params)
    
    try {
      // Execute using backend service
      const startTime = Date.now()
      const results = await wfesBackendService.executeWfafs(params)
      const executionTime = ((Date.now() - startTime) / 1000).toFixed(3)
      
      return {
        success: true,
        spectrum: results.spectrum || [],
        statistics: results.statistics || {},
        warnings: results.warnings || [],
        executionTime: `${executionTime}s`
      }
    } catch (error) {
      console.error('WFAFS execution error:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred',
        spectrum: []
      }
    }
  })
  
  // Handle WFAFD execution (Wright-Fisher Allele Frequency Distribution)
  ipcMain.handle('wfes:wfafd:execute', async (_event, params) => {
    console.log('Executing WFAFD with params:', params)
    
    try {
      // Execute using backend service
      const startTime = Date.now()
      const results = await wfesBackendService.executeWfafd(params)
      const executionTime = ((Date.now() - startTime) / 1000).toFixed(3)
      
      return {
        success: true,
        distribution: results.distribution || [],
        statistics: results.statistics || {},
        warnings: results.warnings || [],
        executionTime: `${executionTime}s`
      }
    } catch (error) {
      console.error('WFAFD execution error:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred',
        distribution: []
      }
    }
  })
  
  // Population projection: one generation from one population size into
  // another, returning the distribution in the new size.
  ipcMain.handle('wfes:projection:execute', async (_event, params) => {
    console.log('Executing projection with params:', params)
    try {
      const startTime = Date.now()
      const results = await wfesBackendService.executeProjection(params)
      const executionTime = ((Date.now() - startTime) / 1000).toFixed(3)
      return {
        success: true,
        distribution: results.distribution || [],
        statistics: results.statistics || {},
        warnings: results.warnings || [],
        commandLine: results.commandLine,
        executionTime: `${executionTime}s`
      }
    } catch (error) {
      console.error('Projection execution error:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred',
        distribution: []
      }
    }
  })

  // Handle WFES Sequential execution
  ipcMain.handle('wfes:sequential:execute', async (_event, params) => {
    console.log('Executing WFES Sequential with params:', params)
    
    try {
      // Convert frontend params to backend format
      const backendParams = {
        // Forwarded, or the chosen file never reaches the builder.
        initial: params.initial,
        population_sizes: params.population_sizes,
        expected_times: params.expected_times,
        selection_coefficients: params.selection_coefficients,
        dominance_coefficients: params.dominance_coefficients,
        backward_mutations: params.backward_mutations,
        forward_mutations: params.forward_mutations,
        starting_probabilities: params.starting_probabilities,
        // The fixed starting count. Dropped here until now: the view sends it,
        // the builder emits --starting-copies from it and the copyable preview
        // printed it, but it never crossed this boundary -- so choosing "Fixed
        // p" ran the integration over starting copies instead, and the numbers
        // on screen belonged to a model the user had not asked for. At N =
        // 100/1000 with p = 50 that is P_fix = 0.000537 reported where the
        // requested model gives 0.0422, a factor of 79.
        starting_copies: firstFinite(params.starting_copies),
        alpha: firstFinite(params.alpha, 1e-20),
        // No 1e-10 fallback. The parser's own default is 1e-10, so omitting
        // the flag computes the identical model -- but injecting it here put
        // --integration-cutoff into every command line, including the fixed-p
        // and initial-file runs whose preview does not show it. The cutoff is
        // now sent only by the view, and only in the mode that integrates.
        integration_cutoff: firstFinite(params.integration_cutoff),
        n_threads: threadCount(params.execution_options?.threads),
        library: params.execution_options?.library || 'Accelerate',
        force: params.execution_options?.force || false,
        verbose: false,
        output_options: params.output_options
      }
      
      // Execute using backend service
      const startTime = Date.now()
      const results = await wfesBackendService.executeWfesSequential(backendParams)
      const executionTime = ((Date.now() - startTime) / 1000).toFixed(3)
      
      return {
        success: true,
        results: results.results,
        warnings: results.warnings || [],
        executionTime: `${executionTime}s`
      }
    } catch (error) {
      console.error('WFES Sequential execution error:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred',
        results: null
      }
    }
  })
  
  // Handle WFES Switching execution
  ipcMain.handle('wfes:switching:execute', async (_event, params) => {
    console.log('Executing WFES Switching with params:', params)
    
    try {
      // Execute using backend service
      const startTime = Date.now()
      const results = await wfesBackendService.executeWfesSwitching(params)
      const executionTime = ((Date.now() - startTime) / 1000).toFixed(3)

      // This is the one handler that returns the service object wholesale, so
      // the warnings are lifted out to sit alongside `results` here as they do
      // in every other handler -- one place for the view to read them.
      const { warnings = [], ...modelResults } = results
      return {
        success: true,
        results: modelResults,
        warnings,
        executionTime: `${executionTime}s`
      }
    } catch (error) {
      console.error('WFES Switching execution error:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred',
        results: null
      }
    }
  })
  
  // Handle stop execution
  ipcMain.handle('wfes:stopExecution', async () => {
    console.log('Stopping all WFES executions')
    wfesBackendService.cancelAllProcesses()
  })
  
  // Handle file dialog
  ipcMain.handle('dialog:openFile', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [
        { name: 'Text Files', extensions: ['txt', 'csv'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    })
    
    return result.canceled ? null : result.filePaths[0]
  })

  /**
   * Choose a directory for the optional matrix/vector outputs (--output-Q, -R,
   * -N, ...). The CLI flags take a PATH, while the options drawer offers
   * checkboxes, so a destination has to come from somewhere. Previously the
   * builders passed a bare relative name such as 'Q.csv', which lands in the
   * app's working directory -- arbitrary in development and read-only inside a
   * packaged .app.
   */
  ipcMain.handle('dialog:selectDirectory', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Choose a folder for WFES matrix output',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: app.getPath('downloads')
    })
    return result.canceled ? null : result.filePaths[0]
  })

  /** Default destination when the user has not chosen one. */
  ipcMain.handle('dialog:defaultOutputDirectory', async () => app.getPath('downloads'))

  /**
   * Write a file the renderer produced, through a save dialog.
   *
   * Every export in the app used the browser idiom instead: build a Blob, point
   * an <a download> at it, click it. That silently does nothing here -- verified
   * with a minimal in-page test of all three cleanup orderings (append/remove,
   * click-only, deferred revoke): none produced a file, so it is the download
   * itself Electron drops, not the cleanup timing. The renderer got no error
   * either way, which is why the button looked inert.
   *
   * Writing from the main process avoids the whole mechanism. It writes to the
   * output folder (Downloads unless one is chosen) and then reveals the file,
   * so the export is visible rather than silent -- which is the complaint that
   * started this.
   */
  ipcMain.handle('dialog:saveFile', async (_event, args: {
    content: string
    defaultFileName: string
    directory?: string
    /** 'base64' for binary payloads (PNG); text otherwise. */
    encoding?: 'utf8' | 'base64'
  }) => {
    try {
      // WFES_SAVE_DIR lets an automated run direct exports somewhere harmless
      // instead of the user's Downloads; unset in normal use.
      const dir = args.directory || process.env.WFES_SAVE_DIR || app.getPath('downloads')
      const target = join(dir, args.defaultFileName)
      await fsPromises.writeFile(
        target,
        args.encoding === 'base64' ? Buffer.from(args.content, 'base64') : args.content,
        args.encoding === 'base64' ? undefined : 'utf8'
      )
      // Reveal it: the export is otherwise invisible, which is the complaint
      // that started this -- a button that appeared to do nothing. Suppressed
      // for automated runs, which would otherwise open a Finder window per
      // export.
      if (!process.env.WFES_NO_REVEAL) shell.showItemInFolder(target)
      return { saved: true, path: target }
    } catch (error) {
      console.error('dialog:saveFile failed:', error)
      return { saved: false, path: null, error: String(error) }
    }
  })
  
  /**
   * @brief Load About content for a model from markdown files
   * @remarks Loads documentation from the about folder instead of hardcoded content
   */
  ipcMain.handle('about:loadContent', async (event, modelName: string) => {
    try {
      console.log(`IPC: Loading about content for model: ${modelName}`)
      const aboutService = AboutContentService.getInstance()
      const content = await aboutService.loadContent(modelName)
      
      // Convert Unicode to LaTeX notation (temporary until markdown files are updated)
      const result = {
        // The H1 the parser now keeps separate; without it here the renderer
        // never receives a title and the panel shows none.
        title: content.title,
        description: aboutService.convertUnicodeToLatex(content.description),
        overview: aboutService.convertUnicodeToLatex(content.overview),
        model: aboutService.convertUnicodeToLatex(content.model),
        computations: aboutService.convertUnicodeToLatex(content.computations),
        fullContent: aboutService.convertUnicodeToLatex(content.fullContent)
      }
      
      console.log(`IPC: Successfully loaded content for ${modelName}`)
      return result
    } catch (error) {
      console.error('IPC: Failed to load about content:', error)
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      return {
        description: `Failed to load documentation: ${errorMessage}`,
        overview: `Failed to load documentation for ${modelName}. Error: ${errorMessage}`,
        model: '',
        computations: '',
        fullContent: ''
      }
    }
  })
}

// This method will be called when Electron has finished initialization
// Before ready: parts of the macOS menu take the name at initialization. The
// DEV dock label still reads "Electron" -- that comes from the stock dev
// binary's own Info.plist, rebranded by scripts/brand-dev-electron.sh; the
// packaged app is named by electron-builder.yml (productName: WFES3).
app.setName('WFES3')

app.whenReady().then(() => {
  
  // Set the dock icon for macOS -- in DEVELOPMENT ONLY.
  //
  // A packaged build does not need this: the dock and Finder both read
  // CFBundleIconFile from the bundle, which electron-builder populates from
  // mac.icon (build/icon.icns). It used to run in packaged builds too, against
  // a Resources/icon.png that nothing shipped, so every launch logged a
  // "Failed to set dock icon" warning -- while the icon itself was already
  // correct, from the .icns. Resources/icon.png does exist now, for the Windows
  // and Linux window icons, but calling setIcon here would still only re-load an
  // icon macOS has already applied.
  //
  // Dev still needs it, because there is no bundle of our own: electron-vite
  // runs the stock Electron binary, whose Info.plist scripts/brand-dev-electron.sh
  // rebrands but leaves carrying Electron's own icon.
  if (process.platform === 'darwin' && is.dev) {
    const iconPath = join(__dirname, '../../build/icon.png')

    try {
      if (app.dock) {
        app.dock.setIcon(iconPath)
      }
    } catch (error) {
      console.warn('Failed to set dock icon:', error)
    }
  }
  
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.dekoning-lab.wfes2')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

    // Setup IPC handlers
  setupIpcHandlers()

  createWindow()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})