import { join } from 'path'
import * as os from 'os'
import { spawn, ChildProcess } from 'child_process'
import { app } from 'electron'
import * as path from 'path'
import * as fs from 'fs'

/**
 * Result of executing a WFES backend process
 */
export interface ProcessResult {
  stdout: string
  stderr: string
  exitCode: number
}

/**
 * Service for executing WFES command-line tools from the Electron main process.
 * Manages process lifecycle, argument building, and result parsing for all WFES executables.
 * 
 * @class WfesBackendService
 */
export class WfesBackendService {
  private executablesPath: string
  private activeProcesses: Map<string, ChildProcess> = new Map()

  constructor() {
    // Determine the path to CLI executables based on environment
    this.executablesPath = this.getExecutablesPath()
  }

  /**
   * Determines the path to WFES executables based on the runtime environment
   * @returns {string} Absolute path to the executables directory
   */
  private getExecutablesPath(): string {
    // In development, use the build directory
    if (!app.isPackaged) {
      // Assume we're running from wfes-ui/wfes2-electron directory
      return path.join(__dirname, '../../../../wfes-cli/build/bin')
    }

    // Packaged: the binaries are shipped via electron-builder's extraResources
    // as <resources>/bin. Use process.resourcesPath rather than deriving the
    // location from app.getPath('exe').
    //
    // The previous implementation was path.join(app.getPath('exe'),
    // '../Resources/bin'). getPath('exe') is the executable FILE
    // (.../WFES3.app/Contents/MacOS/WFES3), so a single '..' strips only the
    // filename and yields .../Contents/MacOS/Resources/bin -- one directory
    // too deep. Every computation in the packaged app failed with
    // "Executable not found". process.resourcesPath points straight at
    // .../Contents/Resources on macOS and resources/ on Windows and Linux, so
    // the same expression is correct on all three platforms.
    return path.join(process.resourcesPath, 'bin')
  }

  /**
   * Splits a completed run's stderr into the warning lines shown next to its
   * results.
   *
   * The solvers use stderr to qualify a result they still return: the
   * distribution was truncated at --max-t so every moment from it is a lower
   * bound, a quantity was renormalised, a fallback stopping rule was used.
   * They say so and exit 0, and until now only the failure branch ever read
   * stderr -- so the GUI presented underestimates as final answers.
   *
   * Verbatim by design: lines are trimmed and empties dropped, nothing is
   * classified, reworded, filtered or collapsed. A repeated line is a repeated
   * line (wfes_sequential can warn once per epoch) and stays repeated. A run
   * with nothing to say yields an empty array, which renders nothing -- checked
   * against the binaries: a converged run writes nothing to stderr, and
   * --verbose output goes to stdout.
   *
   * @param {string} stderr - Raw stderr captured from the process
   * @returns {string[]} Non-empty stderr lines, trimmed, in order
   * @private
   */
  private warningsFrom(stderr: string): string[] {
    return (stderr ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
  }

  /**
   * Gets the full path to a specific WFES executable
   * @param {string} toolName - Name of the tool (e.g., 'wfes_single', 'time_dist')
   * @returns {string} Full path to the executable
   * @throws {Error} If executable not found
   */
  private getExecutablePath(toolName: string): string {
    const platform = process.platform
    const executableName = platform === 'win32' ? `${toolName}.exe` : toolName
    const fullPath = path.join(this.executablesPath, executableName)
    
    // Check if executable exists
    if (!fs.existsSync(fullPath)) {
      throw new Error(`Executable not found: ${fullPath}`)
    }
    
    return fullPath
  }

  /**
   * Executes the wfes_single command with specified parameters
   * @param {any} params - Configuration object containing model parameters
   * @returns {Promise<any>} Parsed results including model outputs and optional matrices
   * @throws {Error} If execution fails or output cannot be parsed
   */
  async executeWfesSingle(params: any): Promise<any> {
    const processId = 'wfes_single_' + Date.now()
    
    try {
      // Build command line arguments
      const args = this.buildWfesSingleArgs(params)
      
      // Add JSON output flag
      args.push('--json')
      
      // Execute the process
      const result = await this.executeProcess(
        'wfes_single',
        args,
        processId
      )
      
      // Parse JSON output
      const parsedResult = this.parseJsonOutput(result.stdout)
      const warnings = this.warningsFrom(result.stderr)

      // For fundamental model, check if we need to read the matrix from file
      if (params.model_type === 'fundamental' && parsedResult.model === 'fundamental') {
        console.log('Processing fundamental matrix...')
        // Generate output file and request matrix
        const tmpDir = os.tmpdir()  // '/tmp' hardcoded here broke Windows
        const timestamp = Date.now()
        const matrixFile = `${tmpDir}/wfes_fundamental_${timestamp}.csv`
        const nExtFile = `${tmpDir}/wfes_n_ext_${timestamp}.csv`
        const nFixFile = `${tmpDir}/wfes_n_fix_${timestamp}.csv`
        
        // Remove --json flag for matrix output run
        // Drop --json AND any --output-N the builder already added (with its
        // value), so the re-run's own temp destination is the only one present.
        //
        // --output-I and --output-V are dropped for the same reason they are
        // not re-added: the first run already wrote both to the user's chosen
        // paths, and re-running them here would rewrite identical content --
        // and in V's case pay for a second full N*N product.
        const dropWithValue = new Set(['--output-N', '--output-I', '--output-V'])
        const matrixArgs: string[] = []
        for (let i = 0; i < args.length; i++) {
          if (args[i] === '--json') continue
          if (dropWithValue.has(args[i])) { i++; continue }
          matrixArgs.push(args[i])
        }
        matrixArgs.push('--output-N', matrixFile)
        
        // Add N_ext and N_fix output files if requested
        if (params.output_options?.writeNExt) {
          matrixArgs.push('--output-N-ext', nExtFile)
        }
        if (params.output_options?.writeNFix) {
          matrixArgs.push('--output-N-fix', nFixFile)
        }
        
        console.log('Running with matrix output to:', matrixFile)
        // Re-run with matrix output
        const matrixRun = await this.executeProcess(
          'wfes_single',
          matrixArgs,
          processId + '_matrix'
        )

        // The re-run is the same model with the same parameters, so its stderr
        // repeats what the first run already said. Only something the first run
        // did not say is added -- the user is not shown the same warning twice
        // for what is, to them, one computation.
        for (const line of this.warningsFrom(matrixRun.stderr)) {
          if (!warnings.includes(line)) warnings.push(line)
        }

        // Read and parse the matrices
        const matrixData = await this.readFundamentalMatrix(matrixFile)
        console.log('Matrix data read:', matrixData ? `${matrixData.length}x${matrixData[0]?.length}` : 'null')
        
        if (matrixData) {
          parsedResult.results.fundamental_matrix = matrixData
        }
        
        // Read N_ext if it was requested
        if (params.output_options?.writeNExt && fs.existsSync(nExtFile)) {
          const nExtData = await this.readFundamentalMatrix(nExtFile)
          if (nExtData) {
            parsedResult.results.n_ext = nExtData
          }
        }
        
        // Read N_fix if it was requested
        if (params.output_options?.writeNFix && fs.existsSync(nFixFile)) {
          const nFixData = await this.readFundamentalMatrix(nFixFile)
          if (nFixData) {
            parsedResult.results.n_fix = nFixData
          }
        }
        
        // Clean up temp files
        try {
          await fs.promises.unlink(matrixFile)
          if (fs.existsSync(nExtFile)) await fs.promises.unlink(nExtFile)
          if (fs.existsSync(nFixFile)) await fs.promises.unlink(nFixFile)
        } catch (e) {
          console.warn('Failed to clean up temp files:', e)
        }
      }
      
      return { ...parsedResult, warnings }
    } finally {
      this.activeProcesses.delete(processId)
    }
  }

  /**
   * Executes the wfes_sweep command for selective sweep analysis
   * @param {any} params - Configuration object with sweep parameters
   * @returns {Promise<any>} Parsed JSON results from sweep analysis
   * @throws {Error} If execution fails or output cannot be parsed
   */
  async executeWfesSweep(params: any): Promise<any> {
    const processId = 'wfes_sweep_' + Date.now()
    
    try {
      // Build command line arguments
      const args = this.buildWfesSweepArgs(params)
      
      // Add JSON output flag
      args.push('--json')
      
      // Execute the process
      const result = await this.executeProcess(
        'wfes_sweep',
        args,
        processId
      )
      
      // Parse JSON output
      return {
        ...this.parseJsonOutput(result.stdout),
        warnings: this.warningsFrom(result.stderr)
      }
    } finally {
      this.activeProcesses.delete(processId)
    }
  }

  /**
   * Executes phase_type_dist or phase_type_moments based on mode
   * @param {any} params - Configuration with mode and phase type parameters
   * @returns {Promise<any>} Distribution data or moments statistics
   * @throws {Error} If execution fails or output parsing fails
   */
  async executePhaseType(params: any): Promise<any> {
    const processId = 'phase_type_' + Date.now()
    
    try {
      // Determine which phase type executable to run
      const command = params.mode === 'moments' ? 'phase_type_moments' : 'phase_type_dist'
      
      // Build command line arguments
      const args = this.buildPhaseTypeArgs(params)
      
      // Execute the process
      const result = await this.executeProcess(
        command,
        args,
        processId
      )
      
      // Parse output based on mode
      const warnings = this.warningsFrom(result.stderr)
      if (params.mode === 'moments') {
        return { ...this.parsePhaseTypeMomentsOutput(result.stdout), warnings }
      } else {
        return { ...this.parsePhaseTypeDistOutput(result.stdout), warnings }
      }
    } finally {
      this.activeProcesses.delete(processId)
    }
  }

  /**
   * Executes time distribution calculations (standard, dual, or SGV mode)
   * @param {any} params - Configuration with mode and time distribution parameters
   * @returns {Promise<any>} Parsed distribution data with statistics
   * @throws {Error} If execution fails or output parsing fails
   */
  async executeTimeDist(params: any): Promise<any> {
    const processId = 'time_dist_' + Date.now()
    
    try {
      // Determine which time_dist variant to run
      let command = 'time_dist'
      if (params.mode === 'time-dist-dual') {
        command = 'time_dist_dual'
      } else if (params.mode === 'time-dist-sgv') {
        command = 'time_dist_sgv'
      }
      
      // Build command line arguments
      const args = this.buildTimeDistArgs(params)
      
      // Execute the process
      const result = await this.executeProcess(
        command,
        args,
        processId
      )
      
      // Parse and return results
      const parsedResult = {
        ...this.parseTimeDistOutput(result.stdout, params.mode),
        warnings: this.warningsFrom(result.stderr)
      }
      console.log(`Time dist ${params.mode} parsed result:`, {
        hasResults: !!parsedResult.results,
        resultsLength: parsedResult.results?.length || 0,
        hasDistribution: !!parsedResult.distribution,
        distributionLength: parsedResult.distribution?.length || 0
      })
      return parsedResult
    } finally {
      this.activeProcesses.delete(processId)
    }
  }

  /**
   * Executes WFAFS (Wright-Fisher Allele Frequency Spectrum) analysis
   * @param {any} params - Configuration with mode (deterministic/stochastic) and parameters
   * @returns {Promise<any>} Allele frequency spectrum and statistics
   * @throws {Error} If execution fails or output parsing fails
   */
  async executeWfafs(params: any): Promise<any> {
    const processId = 'wfafs_' + Date.now()
    
    try {
      // Determine which WFAFS variant to run
      const command = params.mode === 'wfafs-deterministic' ? 'wfafs_deterministic' : 'wfafs_stochastic'
      
      // Build command line arguments
      const args = this.buildWfafsArgs(params)
      
      // Execute the process
      const result = await this.executeProcess(
        command,
        args,
        processId
      )
      
      // Parse and return results
      return {
        ...this.parseWfafsOutput(result.stdout, params.mode),
        warnings: this.warningsFrom(result.stderr)
      }
    } finally {
      this.activeProcesses.delete(processId)
    }
  }

  /**
   * Executes WFAFD (Wright-Fisher Allele Frequency Distribution) analysis
   * @param {any} params - Configuration with demographic components and parameters
   * @returns {Promise<any>} Frequency distribution and statistics
   * @throws {Error} If execution fails or output parsing fails
   */
  async executeWfafd(params: any): Promise<any> {
    const processId = 'wfafd_' + Date.now()
    
    try {
      // WFAFD uses the wfafs_deterministic executable
      const command = 'wfafs_deterministic'
      
      // Build command line arguments
      const args = this.buildWfafdArgs(params)
      
      // Execute the process
      const result = await this.executeProcess(
        command,
        args,
        processId
      )
      
      // Parse and return results
      return {
        ...this.parseWfafdOutput(result.stdout),
        warnings: this.warningsFrom(result.stderr)
      }
    } finally {
      this.activeProcesses.delete(processId)
    }
  }

  /**
   * Population projection: one Wright-Fisher generation that also changes the
   * population size, N1 -> N2.
   *
   * This is wfafs_deterministic with two epochs of length zero. Its epoch loop
   * applies each epoch's own matrix for t generations and, between epochs,
   * applies WF::Single(N_i, N_i+1, NON_ABSORBING) -- the rectangular block whose
   * rows are binom_row(2*N2, psi_diploid(i, N1, s, h, u, v)). With both t at
   * zero that block is the only thing applied, which is exactly a one-generation
   * update into the new size and nothing else.
   *
   * Verified against theory: from count 2 at N1=5 (p = 0.2) into N2=10, the
   * result is Binomial(20, 0.2) to within the mutation rate.
   */
  async executeProjection(params: any): Promise<any> {
    const processId = 'projection_' + Date.now()
    try {
      const args = this.buildProjectionArgs(params)
      const result = await this.executeProcess('wfafs_deterministic', args, processId)
      const parsed = this.parseWfafdOutput(result.stdout)
      return {
        ...parsed,
        warnings: this.warningsFrom(result.stderr),
        commandLine: `wfafs_deterministic ${args.join(' ')}`
      }
    } finally {
      this.activeProcesses.delete(processId)
    }
  }

  /**
   * @param params.sourceSize        N1, the size the distribution is given in
   * @param params.targetSize        N2, the size it is projected into
   * @param params.initialMode       'fixed' | 'integrate' | 'file'
   * @param params.startingCopies    starting count, when initialMode is 'fixed'
   * @param params.integrationCutoff cutoff, when initialMode is 'integrate'
   * @param params.initial           path, when initialMode is 'file'
   */
  private buildProjectionArgs(params: any): string[] {
    const N1 = parseInt(params.sourceSize)
    const N2 = parseInt(params.targetSize)
    const args: string[] = []

    // Exactly one starting state, matching the selector in the view.
    if (params.initialMode === 'file' && params.initial) {
      args.push('--initial', params.initial)
    } else if (params.initialMode === 'integrate') {
      args.push('-c', String(params.integrationCutoff ?? 1e-10))
    } else {
      args.push('-p', String(parseInt(params.startingCopies) || 1))
    }

    // The parameters apply to the source population, whose matrix supplies the
    // projection rows; they are repeated for the target epoch because the tool
    // requires one entry per epoch, and the second epoch never runs (t = 0).
    const N = parseFloat(String(N1))
    const scaled = !!params.populationScaled
    const s = parseFloat(params.selection) || 0
    const u = parseFloat(params.backwardMutation) || 0
    const v = parseFloat(params.forwardMutation) || 0
    const h = params.dominance !== undefined ? parseFloat(params.dominance) : 0.5
    const sRaw = scaled ? s / (2 * N) : s
    const uRaw = scaled ? u / (4 * N) : u
    const vRaw = scaled ? v / (4 * N) : v

    args.push('--pop-sizes', `${N1},${N2}`)
    args.push('--generations', '0,0')
    args.push('--selection', `${sRaw},${sRaw}`)
    args.push('--dominance', `${h},${h}`)
    args.push('--backward-mu', `${uRaw},${uRaw}`)
    args.push('--forward-mu', `${vRaw},${vRaw}`)
    if (params.alpha !== undefined && params.alpha !== '') {
      args.push('--alpha', String(params.alpha))
    }
    if (params.executionParams?.threads !== undefined) {
      args.push('--num-threads', String(params.executionParams.threads))
    }
    if (params.executionParams?.library) {
      args.push('--library', this.normalizeLibrary(params.executionParams.library))
    }
    args.push('--json')
    return args
  }

  /**
   * Builds command line arguments for wfes_single executable
   * @param {any} params - Model parameters from frontend
   * @returns {string[]} Array of command line arguments
   * @private
   */
  /**
   * Resolve a destination path for one of the optional matrix/vector outputs.
   *
   * The CLI flags (--output-Q, --output-N, ...) take a path, while the options
   * drawer offers checkboxes. Before this, the builders invented bare relative
   * names like 'Q.csv', which resolve against the app's working directory --
   * arbitrary in development, and read-only inside a packaged .app, so the run
   * failed or the file landed somewhere the user would never find. The drawer
   * now carries an outputDirectory; Downloads is the fallback.
   *
   * Files are named <tool>_<label>.<ext>. Only Q is written by
   * SparseMatrix::saveMarket (MatrixMarket); everything else goes through
   * OutputFormatter as CSV.
   */
  private outputPath(params: any, tool: string, label: string): string {
    const dir =
      params.output_options?.outputDirectory ||
      params.output_directory ||
      app.getPath('downloads')
    const ext = label === 'Q' ? 'mtx' : 'csv'
    return join(dir, `${tool}_${label}.${ext}`)
  }

  /**
   * Canonical capitalisation for the --library value, shared by every builder.
   *
   * Each builder used to carry its own partial chain: the sequential one knew
   * SuiteSparse and ParU, the sweep one did not, and phase-type passed the
   * value through raw -- so the same Select produced differently-normalised
   * argv depending on the tool. Unknown names pass through unchanged; the CLI
   * is the authority on what it accepts.
   */
  private normalizeLibrary(library: any): string {
    const canonical = ['Accelerate', 'Pardiso', 'ViennaCL', 'SuiteSparse', 'ParU']
    const name = String(library)
    const hit = canonical.find((c) => c.toLowerCase() === name.toLowerCase())
    return hit ?? (name.toLowerCase() === 'vienna' ? 'ViennaCL' : name)
  }

  private buildWfesSingleArgs(params: any): string[] {
    const args: string[] = []
    
    // Model type - convert to appropriate CLI flag
    if (params.model_type) {
      switch (params.model_type) {
        case 'absorption':
          args.push('--absorption')
          break
        case 'fixation':
          args.push('--fixation')
          break
        case 'establishment':
          args.push('--establishment')
          break
        case 'fundamental':
          args.push('--fundamental')
          break
        case 'equilibrium':
          args.push('--equilibrium')
          break
        case 'nonAbsorbing':
          args.push('--non-absorbing')
          break
        case 'alleleAge':
          args.push('--allele-age')
          break
        default:
          console.warn(`Unknown model type: ${params.model_type}`)
      }
    }
    
    // Population parameters
    if (params.population_size !== undefined) {
      args.push('--pop-size', params.population_size.toString())
    }
    
    // Alpha parameter (tail truncation weight)
    if (params.alpha !== undefined && params.alpha !== 1e-20) {
      args.push('--alpha', params.alpha.toString())
    }
    
    // Selection parameters
    if (params.selection_coefficient !== undefined) {
      args.push('--selection', params.selection_coefficient.toString())
    }
    if (params.dominance_coefficient !== undefined) {
      args.push('--dominance', params.dominance_coefficient.toString())
    }
    
    // Mutation parameters (skip if not provided or default values)
    if (params.backward_mutation_rate !== undefined && params.backward_mutation_rate !== 1e-9) {
      args.push('--backward-mu', params.backward_mutation_rate.toString())
    }
    if (params.forward_mutation_rate !== undefined && params.forward_mutation_rate !== 1e-9) {
      args.push('--forward-mu', params.forward_mutation_rate.toString())
    }
    if (params.no_recurrent_mutation === true) {
      args.push('--no-recurrent-mu')
    }
    
    // Starting parameters (for non-equilibrium models)
    if (params.starting_copies !== undefined) {
      args.push('--starting-copies', params.starting_copies.toString())
    }
    if (params.observed_copies !== undefined) {
      args.push('--observed-copies', params.observed_copies.toString())
    }
    if (params.num_moments !== undefined) {
      args.push('--num-moments', params.num_moments.toString())
    }
    
    // Generations (for time-based models)
    if (params.generations !== undefined) {
      args.push('--generations', params.generations.toString())
    }
    
    // Integration parameters. --fundamental has no integration over starting
    // states -- sojourn times are conditioned on one -- so the flag is not sent
    // there, and the preview does not show it either.
    if (params.integration_cutoff !== undefined && params.model_type !== 'fundamental') {
      args.push('--integration-cutoff', params.integration_cutoff.toString())
    }
    if (params.odds_ratio !== undefined) {
      args.push('--odds-ratio', params.odds_ratio.toString())
    }
    
    // Solver parameters
    if (params.n_threads !== undefined) {
      args.push('--num-threads', params.n_threads.toString())
    }
    
    // Library selection
    if (params.library) {
      args.push('--library', this.normalizeLibrary(params.library))
    }

    // Parameters the tool accepts but the GUI never sent. Each is emitted only
    // when the caller supplies it, so existing calls are unchanged.
    if (params.block_size !== undefined) {
      args.push('--block-size', params.block_size.toString())
    }
    // The single view has an "initial distribution" file picker whose value
    // (executionParams.initialDistFile) no builder ever read, so the chosen
    // file was silently ignored.
    const initFile = params.initial ?? params.executionParams?.initialDistFile ?? params.executionOptions?.initialDistFile
    if (initFile) { args.push('--initial', initFile.toString()) }
    if (params.force || (params.executionParams?.force ?? params.executionOptions?.force)) { args.push('--force') }
    if (params.verbose) { args.push('--verbose') }

    // Matrix/vector outputs. The drawer has offered these checkboxes all along
    // and this builder emitted none of them, so ticking any of them did nothing.
    const o = params.output_options
    if (o) {
      if (o.writeQ)    args.push('--output-Q',     this.outputPath(params, 'wfes_single', 'Q'))
      if (o.writeR)    args.push('--output-R',     this.outputPath(params, 'wfes_single', 'R'))
      if (o.writeB)    args.push('--output-B',     this.outputPath(params, 'wfes_single', 'B'))
      // --output-N is pushed by the fundamental-matrix re-run below, which
      // strips any copy already present so the two cannot collide.
      if (o.writeN)    args.push('--output-N',     this.outputPath(params, 'wfes_single', 'N'))
      if (o.writeNExt) args.push('--output-N-ext', this.outputPath(params, 'wfes_single', 'N_ext'))
      if (o.writeNFix) args.push('--output-N-fix', this.outputPath(params, 'wfes_single', 'N_fix'))
      // --output-I is written in every model type: the CLI dumps the starting
      // distribution before it branches on the model.
      if (o.writeI)    args.push('--output-I',     this.outputPath(params, 'wfes_single', 'I'))
      // --output-E and --output-V are mode-gated in the CLI -- the writes sit
      // inside the --equilibrium and --fundamental branches respectively, so
      // passing them in any other mode is accepted and then silently ignored.
      // Gate them here as well, so a checkbox left ticked while the user
      // switches modes cannot promise a file that never gets written. The view
      // disables the same two checkboxes outside their mode.
      if (o.writeE && params.model_type === 'equilibrium') {
        args.push('--output-E', this.outputPath(params, 'wfes_single', 'E'))
      }
      if (o.writeV && params.model_type === 'fundamental') {
        args.push('--output-V', this.outputPath(params, 'wfes_single', 'V'))
      }
    }

    return args
  }

  /**
   * Builds command line arguments for wfes_sweep executable
   * @param {any} params - Sweep model parameters including lambda and coefficient arrays
   * @returns {string[]} Array of command line arguments
   * @private
   */
  private buildWfesSweepArgs(params: any): string[] {
    const args: string[] = []
    
    // Model type (always fixation for now)
    args.push('--fixation')
    
    // Population size (required)
    if (params.population_size !== undefined) {
      args.push('--pop-size', params.population_size.toString())
    }
    
    // Selection coefficients (required, comma-separated)
    if (params.selection_coefficients && Array.isArray(params.selection_coefficients)) {
      args.push('--selection', params.selection_coefficients.join(','))
    }
    
    // Lambda (transition probability, required)
    if (params.lambda !== undefined) {
      args.push('--lambda', params.lambda.toString())
    }
    
    // Optional parameters
    if (params.dominance && Array.isArray(params.dominance)) {
      args.push('--dominance', params.dominance.join(','))
    }
    
    if (params.backward_mutation && Array.isArray(params.backward_mutation)) {
      args.push('--backward-mu', params.backward_mutation.join(','))
    }
    
    if (params.forward_mutation && Array.isArray(params.forward_mutation)) {
      args.push('--forward-mu', params.forward_mutation.join(','))
    }
    
    if (params.alpha !== undefined) {
      args.push('--alpha', params.alpha.toString())
    }
    
    if (params.n_threads !== undefined) {
      args.push('--num-threads', params.n_threads.toString())
    }
    
    if (params.integration_cutoff !== undefined) {
      args.push('--integration-cutoff', params.integration_cutoff.toString())
    }
    
    if (params.starting_copies !== undefined) {
      args.push('--starting-copies', params.starting_copies.toString())
    }
    
    // Force parameter
    if (params.force === true) {
      args.push('--force')
    }
    
    // Library selection - default to Accelerate on macOS
    let libraryName = params.library
    if (!libraryName) {
      // Auto-detect platform if no library specified
      const platform = process.platform
      libraryName = platform === 'darwin' ? 'Accelerate' : 'Pardiso'
    }

    args.push('--library', this.normalizeLibrary(libraryName))
    
    // Same as wfes_single: the checkboxes existed, the flags never did.
    const so = params.output_options
    if (so) {
      if (so.writeQ) args.push('--output-Q', this.outputPath(params, 'wfes_sweep', 'Q'))
      if (so.writeR) args.push('--output-R', this.outputPath(params, 'wfes_sweep', 'R'))
      if (so.writeN) args.push('--output-N', this.outputPath(params, 'wfes_sweep', 'N'))
      if (so.writeB) args.push('--output-B', this.outputPath(params, 'wfes_sweep', 'B'))
    }

    // Initial state distribution. Every tool accepts one now; it replaces the
    // fixed starting count or the integration over starting copies.
    const initialFile = params.initial ?? params.executionOptions?.initialDistFile
    if (initialFile) { args.push('--initial', initialFile.toString()) }

    return args
  }

  /**
   * Builds command line arguments for phase_type_dist or phase_type_moments
   * @param {any} params - Phase type parameters including mode (dist/moments)
   * @returns {string[]} Array of command line arguments
   * @private
   * @remarks Uses --distribution-cutoff for dist mode
   */
  private buildPhaseTypeArgs(params: any): string[] {
    const args: string[] = []

    // Population size (required)
    if (params.population_size !== undefined) {
      args.push('--pop-size', params.population_size.toString())
    }

    // Mode-specific parameters
    if (params.mode === 'dist') {
      // Distribution cutoff
      if (params.distribution_cutoff !== undefined) {
        args.push('--distribution-cutoff', params.distribution_cutoff.toString())
      }
      // Max generations
      if (params.max_generations !== undefined) {
        args.push('--max-t', params.max_generations.toString())
      }
    } else if (params.mode === 'moments') {
      // Number of moments
      if (params.num_moments !== undefined) {
        args.push('--n-moments', params.num_moments.toString())
      }
    }

    // Selection parameters
    if (params.selection_coefficient !== undefined) {
      args.push('--selection', params.selection_coefficient.toString())
    }
    if (params.dominance_coefficient !== undefined) {
      args.push('--dominance', params.dominance_coefficient.toString())
    }

    // Mutation parameters
    if (params.backward_mutation_rate !== undefined) {
      args.push('--backward-mu', params.backward_mutation_rate.toString())
    }
    if (params.forward_mutation_rate !== undefined) {
      args.push('--forward-mu', params.forward_mutation_rate.toString())
    }
    // Exclude recurrent mutation (-m on phase_type_moments). The moments-mode
    // "r" checkbox used to arrive as `recurrent_mutation`, a key no builder
    // read, so it could not reach the argv no matter what it held; the handler
    // now forwards it under the name and polarity this flag actually has.
    if (params.noRecurrentMutation) { args.push('--no-recurrent-mu') }

    // Alpha (tail truncation weight). starting_frequency is the handler's
    // historical name for the view's `a` field; it has always been --alpha.
    if (params.starting_frequency !== undefined) {
      args.push('--alpha', params.starting_frequency.toString())
    }

    // Execution parameters
    if (params.n_threads !== undefined) {
      args.push('--num-threads', params.n_threads.toString())
    }

    // Skip parameter checks. Only phase_type_moments declares this flag;
    // phase_type_dist does not, and args-parsing is fatal there -- the run
    // exits 1 with "Flag could not be matched: force" before computing
    // anything, so ticking Force made the distribution mode unusable.
    if (params.force && params.mode === 'moments') {
      args.push('--force')
    }

    // Library selection
    if (params.library) {
      args.push('--library', this.normalizeLibrary(params.library))
    }

    // No --solver here: no WFES binary declares one (phase_type_moments exits
    // 1 with "Flag could not be matched: solver"), and the ViennaCL backend
    // that the option existed for is no longer offered in the library Select.

    // Output options -- the same nested output_options.write* shape every
    // other tool uses (this builder used to read flat output_Q/output_R keys,
    // a second convention that invited exactly the key mismatches that made
    // the sweep and WFAF-S write checkboxes inert).
    const po = params.output_options
    if (po?.writeQ) {
      args.push('--output-Q', this.outputPath(params, 'phase_type', 'Q'))
    }
    if (po?.writeR) {
      args.push('--output-R', this.outputPath(params, 'phase_type', 'R'))
    }
    // --output-P: only phase_type_dist declares it (phase_type_moments does
    // not). It writes the distribution as CSV alongside the normal stdout.
    if (params.mode === 'dist' && po?.writeP) {
      args.push('--output-P', this.outputPath(params, 'phase_type', 'P'))
    }
    // --output-N: only phase_type_moments declares it ("Output moments to
    // file"); phase_type_dist has no such flag and would exit 1 on it.
    if (params.mode === 'moments' && po?.writeN) {
      args.push('--output-N', this.outputPath(params, 'phase_type', 'N'))
    }

    // Parameters the tool accepts but the GUI never sent. Each is emitted only
    // when the caller supplies it, so existing calls are unchanged.
    if (params.verbose) {
      args.push('--verbose')
    }
    if (params.block_size !== undefined) {
      args.push('--block-size', params.block_size.toString())
    }
    if (params.populationParams?.integrationCutoff !== undefined) {
      args.push('--integration-cutoff', params.populationParams.integrationCutoff.toString())
    }

    // Initial state distribution. Every tool accepts one now; it replaces the
    // fixed starting count or the integration over starting copies.
    const initialFile = params.initial ?? params.executionOptions?.initialDistFile
    if (initialFile) { args.push('--initial', initialFile.toString()) }

    // Both modes emit JSON now. dist mode's --json was declared but never
    // consumed by the tool, which is why this was restricted to moments.
    args.push('--json')

    return args
  }

  /**
   * Builds command line arguments for wfes_sequential executable
   * @param {any} params - Sequential model parameters with arrays for each epoch
   * @returns {string[]} Array of command line arguments
   * @private
   */
  private buildWfesSequentialArgs(params: any): string[] {
    const args: string[] = []
    
    // Population sizes (required, comma-separated)
    if (params.population_sizes && Array.isArray(params.population_sizes)) {
      args.push('--pop-sizes', params.population_sizes.join(','))
    }
    
    // Expected times (required, comma-separated)
    if (params.expected_times && Array.isArray(params.expected_times)) {
      args.push('--exp-time', params.expected_times.join(','))
    }
    
    // Selection coefficients (optional, comma-separated)
    if (params.selection_coefficients && Array.isArray(params.selection_coefficients)) {
      args.push('--selection', params.selection_coefficients.join(','))
    }
    
    // Dominance coefficients (optional, comma-separated)
    if (params.dominance_coefficients && Array.isArray(params.dominance_coefficients)) {
      args.push('--dominance', params.dominance_coefficients.join(','))
    }
    
    // Backward mutation rates (optional, comma-separated)
    if (params.backward_mutations && Array.isArray(params.backward_mutations)) {
      args.push('--backward-mu', params.backward_mutations.join(','))
    }
    
    // Forward mutation rates (optional, comma-separated)
    if (params.forward_mutations && Array.isArray(params.forward_mutations)) {
      args.push('--forward-mu', params.forward_mutations.join(','))
    }
    
    // Starting probabilities (optional, comma-separated)
    if (params.starting_probabilities && Array.isArray(params.starting_probabilities)) {
      args.push('--starting-prob', params.starting_probabilities.join(','))
    }
    
    // Fixed starting count in the first epoch (optional)
    if (params.starting_copies !== undefined && params.starting_copies !== null) {
      args.push('--starting-copies', params.starting_copies.toString())
    }
    
    // Integration cutoff
    if (params.integration_cutoff !== undefined) {
      args.push('--integration-cutoff', params.integration_cutoff.toString())
    }
    
    // Alpha (tail truncation weight)
    if (params.alpha !== undefined) {
      args.push('--alpha', params.alpha.toString())
    }
    
    // Number of threads
    if (params.n_threads !== undefined) {
      args.push('--num-threads', params.n_threads.toString())
    }
    
    // Output options
    if (params.output_options) {
      if (params.output_options.writeQ) args.push('--output-Q', this.outputPath(params, 'wfes_sequential', 'Q'))
      if (params.output_options.writeR) args.push('--output-R', this.outputPath(params, 'wfes_sequential', 'R'))
      if (params.output_options.writeN) args.push('--output-N', this.outputPath(params, 'wfes_sequential', 'N'))
      if (params.output_options.writeB) args.push('--output-B', this.outputPath(params, 'wfes_sequential', 'B'))
      if (params.output_options.writeNExt) args.push('--output-N-ext', this.outputPath(params, 'wfes_sequential', 'N_ext'))
      if (params.output_options.writeNFix) args.push('--output-N-fix', this.outputPath(params, 'wfes_sequential', 'N_fix'))
    }
    
    // Force flag
    if (params.force === true) {
      args.push('--force')
    }
    
    // Verbose flag
    if (params.verbose === true) {
      args.push('--verbose')
    }
    
    // Library selection
    let libraryName = params.library
    if (!libraryName) {
      const platform = process.platform
      libraryName = platform === 'darwin' ? 'Accelerate' : 'Pardiso'
    }

    args.push('--library', this.normalizeLibrary(libraryName))
    
    // Initial state distribution. Every tool accepts one now; it replaces the
    // fixed starting count or the integration over starting copies.
    const initialFile = params.initial ?? params.executionOptions?.initialDistFile
    if (initialFile) { args.push('--initial', initialFile.toString()) }

    return args
  }

  /**
   * Builds command line arguments for wfes_switching executable
   * @param {any} params - Switching model parameters including states and transition matrix
   * @returns {string[]} Array of command line arguments
   * @private
   * @remarks Switching matrix is converted to row-major format with semicolon separators
   */
  private buildWfesSwitchingArgs(params: any): string[] {
    const args: string[] = []
    
    // Model type (absorption or fixation)
    if (params.model_type) {
      switch (params.model_type) {
        case 'absorption':
          args.push('--absorption')
          break
        case 'fixation':
          args.push('--fixation')
          break
        default:
          // Default to absorption if not specified
          args.push('--absorption')
      }
    } else {
      // Default to absorption
      args.push('--absorption')
    }
    
    // Population states - build comma-separated lists
    if (params.population_states && Array.isArray(params.population_states)) {
      const N_values = params.population_states.map((s: any) => s.N).join(',')
      const s_values = params.population_states.map((s: any) => s.s).join(',')
      const h_values = params.population_states.map((s: any) => s.h).join(',')
      const u_values = params.population_states.map((s: any) => s.u).join(',')
      const v_values = params.population_states.map((s: any) => s.v).join(',')
      
      args.push('--pop-sizes', N_values)
      args.push('--selection', s_values)
      args.push('--dominance', h_values)
      args.push('--backward-mu', u_values)
      args.push('--forward-mu', v_values)
    }
    
    // Starting probabilities for each state
    if (params.starting_probabilities && Array.isArray(params.starting_probabilities)) {
      args.push('--starting-prob', params.starting_probabilities.join(','))
    } else if (params.starting_state !== undefined && params.population_states) {
      // If only starting state is specified, create probabilities vector
      const n_states = params.population_states.length
      const probs = new Array(n_states).fill(0)
      probs[params.starting_state] = 1.0
      args.push('--starting-prob', probs.join(','))
    }
    
    // Switching matrix - needs to be in row-major format with semicolons separating rows
    if (params.switching_rates && Array.isArray(params.switching_rates) && params.population_states) {
      const n_states = params.population_states.length
      // Initialize matrix with zeros
      const matrix: number[][] = Array(n_states).fill(null).map(() => Array(n_states).fill(0))
      
      // Fill in the off-diagonal rates
      params.switching_rates.forEach((r: any) => {
        const rate = typeof r.rate === 'string' ? parseFloat(r.rate) : r.rate
        matrix[r.from_state][r.to_state] = rate
      })
      
      // Calculate and set diagonal elements (probability of staying in same state)
      for (let i = 0; i < n_states; i++) {
        let rowSum = 0
        for (let j = 0; j < n_states; j++) {
          if (i !== j) {
            rowSum += matrix[i][j]
          }
        }
        matrix[i][i] = Math.max(0, 1 - rowSum)
      }
      
      // Convert to string format: "row1col1,row1col2;row2col1,row2col2"
      const matrixStr = matrix.map(row => row.join(',')).join(';')
      args.push('--switching', matrixStr)
    }
    
    // Alpha (tail truncation weight)
    if (params.alpha !== undefined) {
      args.push('--alpha', params.alpha.toString())
    }
    
    // Integration cutoff
    if (params.integration_cutoff !== undefined) {
      args.push('--integration-cutoff', params.integration_cutoff.toString())
    }
    
    // Execution options
    if (params.execution_options) {
      if (params.execution_options.threads !== undefined) {
        args.push('--num-threads', params.execution_options.threads.toString())
      }
      
      // Library selection
      let libraryName = params.execution_options.library
      if (!libraryName) {
        const platform = process.platform
        libraryName = platform === 'darwin' ? 'Accelerate' : 'Pardiso'
      }

      args.push('--library', this.normalizeLibrary(libraryName))
      
      if (params.execution_options.force) {
        args.push('--force')
      }
    }
    
    // Output options
    if (params.output_options) {
      if (params.output_options.writeQ) args.push('--output-Q', this.outputPath(params, 'wfes_switching', 'Q'))
      if (params.output_options.writeR) args.push('--output-R', this.outputPath(params, 'wfes_switching', 'R'))
      if (params.output_options.writeN) args.push('--output-N', this.outputPath(params, 'wfes_switching', 'N'))
      if (params.output_options.writeB) args.push('--output-B', this.outputPath(params, 'wfes_switching', 'B'))
      if (params.output_options.writeNExt) args.push('--output-N-ext', this.outputPath(params, 'wfes_switching', 'N_ext'))
      if (params.output_options.writeNFix) args.push('--output-N-fix', this.outputPath(params, 'wfes_switching', 'N_fix'))
    }
    
    // Don't add any output format flags here - they will be handled in the execute methods
    
    // Verbose flag
    if (params.verbose) {
      args.push('--verbose')
    }
    
    // Initial state distribution. Every tool accepts one now; it replaces the
    // fixed starting count or the integration over starting copies.
    const initialFile = params.initial ?? params.executionOptions?.initialDistFile
    if (initialFile) { args.push('--initial', initialFile.toString()) }

    return args
  }

  /**
   * Builds command line arguments for time_dist family of executables
   * @param {any} params - Time distribution parameters including mode
   * @returns {string[]} Array of command line arguments
   * @private
   * @remarks Handles time-dist, time-dist-dual, and time-dist-sgv modes
   * @remarks Uses --distribution-cutoff parameter name
   */
  private buildTimeDistArgs(params: any): string[] {
    const args: string[] = []

    console.log('Building args for mode:', params.mode)

    // Initial state distribution, set before the mode branches so both the
    // sgv and non-sgv tools receive it on the same code path.
    const initialFile = params.initial ?? params.executionOptions?.initialDistFile
    if (initialFile) { args.push('--initial', initialFile.toString()) }

    // Which binary this run spawns, used to name its output files: the three
    // tools share this builder but have different state spaces, so their
    // matrices must not overwrite each other in the output folder.
    const toolName =
      params.mode === 'time-dist-sgv' ? 'time_dist_sgv'
        : params.mode === 'time-dist-dual' ? 'time_dist_dual'
        : 'time_dist'

    if (params.mode === 'time-dist-sgv') {
      // SGV mode has components with comma-separated values
      if (params.components && Array.isArray(params.components) && params.components.length > 0) {
        // For SGV, use single population size from first component
        const N = params.components[0].N
        args.push('--pop-size', N.toString())

        // Build comma-separated lists for each parameter
        const s_values = params.components.map(c => c.s).join(',')
        const h_values = params.components.map(c => c.h).join(',')
        const u_values = params.components.map(c => c.u).join(',')
        const v_values = params.components.map(c => c.v).join(',')

        args.push('--selection', s_values)
        args.push('--dominance', h_values)
        args.push('--backward-mu', u_values)
        args.push('--forward-mu', v_values)
      }

      // Lambda parameter (rate of switching)
      if (params.populationParams?.l !== undefined) {
        args.push('--lambda', params.populationParams.l.toString())
      }

      // Other SGV parameters
      if (params.populationParams?.a !== undefined) {
        args.push('--alpha', params.populationParams.a.toString())
      }
      if (params.populationParams?.c !== undefined) {
        args.push('--distribution-cutoff', params.populationParams.c.toString())
      }
      if (params.populationParams?.m !== undefined) {
        args.push('--max-t', params.populationParams.m.toString())
      }

      // SGV-specific execution parameters
      if (params.n_threads !== undefined) {
        args.push('--num-threads', params.n_threads.toString())
      } else if (params.executionParams?.threads !== undefined) {
        args.push('--num-threads', params.executionParams.threads.toString())
      }

      // Library selection for SGV
      if (params.library !== undefined) {
        args.push('--library', this.normalizeLibrary(params.library))
      } else if (params.executionParams?.library) {
        args.push('--library', this.normalizeLibrary(params.executionParams.library))
      }

      // Skip parameter checks. Of the three time-dist binaries only
      // time_dist_sgv declares --force; passing it to the other two is a
      // fatal parse error, which is why this push sits inside the sgv branch.
      if (params.force === true || params.executionParams?.force === true) {
        args.push('--force')
      }
    } else {
      // Non-SGV modes (time-dist and time-dist-dual)
      // Population parameters
      if (params.populationParams?.N !== undefined) {
        args.push('--pop-size', params.populationParams.N.toString())
      }
      if (params.populationParams?.a !== undefined) {
        args.push('--alpha', params.populationParams.a.toString())
      }
      if (params.populationParams?.l !== undefined) {
        args.push('--block-size', params.populationParams.l.toString())
      }
      if (params.populationParams?.c !== undefined) {
        args.push('--distribution-cutoff', params.populationParams.c.toString())
      }
      if (params.populationParams?.m !== undefined) {
        args.push('--max-t', params.populationParams.m.toString())
      }

      // Selection parameters
      if (params.selectionParams?.s !== undefined) {
        args.push('--selection', params.selectionParams.s.toString())
      }
      if (params.selectionParams?.h !== undefined) {
        args.push('--dominance', params.selectionParams.h.toString())
      }

      // Mutation parameters
      if (params.mutationParams?.u !== undefined) {
        args.push('--backward-mu', params.mutationParams.u.toString())
      }
      if (params.mutationParams?.v !== undefined) {
        args.push('--forward-mu', params.mutationParams.v.toString())
      }

      // No recurrent mutation flag
      if (params.noRecurrentMutation === true) {
        args.push('--no-recurrent-mu')
      }

      // Common execution parameters for non-SGV modes
      if (params.n_threads !== undefined) {
        args.push('--num-threads', params.n_threads.toString())
      } else if (params.executionParams?.threads !== undefined) {
        args.push('--num-threads', params.executionParams.threads.toString())
      }

      // Library selection
      if (params.library !== undefined) {
        args.push('--library', this.normalizeLibrary(params.library))
      } else if (params.executionParams?.library) {
        args.push('--library', this.normalizeLibrary(params.executionParams.library))
      }
      // No --force here: time_dist and time_dist_dual do not declare it.
    }

    // Matrix/vector outputs -- all three binaries declare --output-Q,
    // --output-R and --output-P (verified against their --help). This builder
    // used to read no output keys at all, so the view's write checkboxes
    // could not reach the argv no matter what they held.
    const to = params.output_options
    if (to?.writeQ) { args.push('--output-Q', this.outputPath(params, toolName, 'Q')) }
    if (to?.writeR) { args.push('--output-R', this.outputPath(params, toolName, 'R')) }
    if (to?.writeP) { args.push('--output-P', this.outputPath(params, toolName, 'P')) }

    // Parameters the tool accepts but the GUI never sent. Each is emitted only
    // when the caller supplies it, so existing calls are unchanged.
    if (params.populationParams?.integrationCutoff !== undefined) {
      args.push('--integration-cutoff', params.populationParams.integrationCutoff.toString())
    }
    if (params.verbose) { args.push('--verbose') }

    // Always use JSON output for easier parsing
    args.push('--json')

    return args
  }

  /**
   * Builds command line arguments for WFAFD (uses wfafs_deterministic)
   * @param {any} params - WFAFD parameters with demographic components
   * @returns {string[]} Array of command line arguments
   * @private
   * @remarks Converts component arrays to vector format for CLI
   */
  private buildWfafdArgs(params: any): string[] {
    const args: string[] = []
    
    // Starting state: a fixed count (-p) or the mutation-injection
    // integration (-c); a file arrives separately as params.initial.
    if (params.startingFrequency !== undefined && params.startingFrequency !== null) {
      args.push('-p', params.startingFrequency.toString())
    }
    if (params.integrationCutoff !== undefined && params.integrationCutoff !== null) {
      args.push('-c', params.integrationCutoff.toString())
    }
    
    // Build component vectors
    if (params.components && Array.isArray(params.components) && params.components.length > 0) {
      // For WFAFD, we need to convert components to vectors
      const N_values: string[] = []
      const t_values: string[] = []
      const s_values: string[] = []
      const h_values: string[] = []
      const u_values: string[] = []
      const v_values: string[] = []
      
      // Convert population-scaled values if needed
      params.components.forEach((comp: any) => {
        const N = parseInt(comp.N) || 100
        N_values.push(N.toString())
        t_values.push(comp.G || '100')
        
        // Convert values based on population scaling
        if (params.populationScaled) {
          // Values are already scaled, need to unscale them
          const unscaledS = (parseFloat(comp.s) || 0) / (2 * N)
          const unscaledU = (parseFloat(comp.u) || 0) / (4 * N)
          const unscaledV = (parseFloat(comp.v) || 0) / (4 * N)
          
          s_values.push(unscaledS.toString())
          u_values.push(unscaledU.toString())
          v_values.push(unscaledV.toString())
        } else {
          // Values are unscaled, use as is
          s_values.push(comp.s || '0')
          u_values.push(comp.u || '1e-9')
          v_values.push(comp.v || '1e-9')
        }
        
        h_values.push(comp.h || '0.5')
      })
      
      args.push('--pop-sizes', N_values.join(','))
      args.push('--generations', t_values.join(','))
      args.push('--selection', s_values.join(','))
      args.push('--dominance', h_values.join(','))
      args.push('--backward-mu', u_values.join(','))
      args.push('--forward-mu', v_values.join(','))
    }
    
    // Alpha parameter
    if (params.alpha !== undefined) {
      args.push('--alpha', params.alpha.toString())
    }
    
    // Integration mode parameters (Note: wfafs_deterministic doesn't have integration mode options)
    // The integrationMode and aValue from the UI are for future enhancement
    
    // Execution parameters. No --force: wfafs_deterministic does not declare
    // the flag (it is a fatal parse error), so the Force checkbox is disabled
    // with that reason in the WFAF-D view rather than silently dropped here.
    if (params.executionParams) {
      if (params.executionParams.threads !== undefined) {
        args.push('--num-threads', params.executionParams.threads.toString())
      }
      if (params.executionParams.library) {
        args.push('--library', this.normalizeLibrary(params.executionParams.library))
      }
    }

    // No --output-* flags: wfafs_deterministic's only file output is
    // -o/--output-file, and that flag REDIRECTS the whole result stream into
    // the file (stdout becomes empty, and the file is the tab-separated
    // spectrum, not JSON) -- verified against the binary. A GUI run that
    // passed it would lose its own results, so the view offers no write
    // checkboxes for this tool; the results panel's export writes the
    // spectrum instead.

    // Verbose output for debugging
    if (params.verbose) {
      args.push('--verbose')
    }

    // Parameters the tool accepts but the GUI never sent. Each is emitted only
    // when the caller supplies it, so existing calls are unchanged.
    if (params.block_size !== undefined) {
      args.push('--block-size', params.block_size.toString())
    }

    // Initial state distribution. Every tool accepts one now; it replaces the
    // fixed starting count or the integration over starting copies.
    const initialFile = params.initial ?? params.executionOptions?.initialDistFile
    if (initialFile) { args.push('--initial', initialFile.toString()) }

    // Structured output, like every other tool's run path. wfafd was the one
    // holdout still parsed by scraping the default tab-separated stream --
    // a parse that silently dropped zero-probability rows and re-normalized
    // the spectrum, both of which can mask real CLI output problems.
    args.push('--json')

    return args
  }

  /**
   * Builds command line arguments for WFAFS (deterministic or stochastic)
   * @param {any} params - WFAFS parameters including mode and components
   * @returns {string[]} Array of command line arguments
   * @private
   * @remarks Different argument formats for deterministic vs stochastic modes.
   *          Stochastic mode uses a switching model that solves a linear system
   *          for efficiency, avoiding repeated matrix-vector multiplication.
   */
  private buildWfafsArgs(params: any): string[] {
    const args: string[] = []
    
    if (params.mode === 'wfafs-stochastic') {
      // Stochastic mode uses a time-heterogeneous switching model.
      // Each component represents a demographic epoch with population parameters.
      // The model solves (I-Q)X = B to compute allele frequency distributions efficiently,
      // where Q is the compound Wright-Fisher switching matrix.
      if (params.components && Array.isArray(params.components) && params.components.length > 0) {
        // Build comma-separated lists for each parameter
        const N_values = params.components.map(c => c.N).join(',')
        const G_values = params.components.map(c => c.G).join(',')
        const f_values = params.components.map(c => c.f).join(',')
        const s_values = params.components.map(c => c.s).join(',')
        const h_values = params.components.map(c => c.h).join(',')
        const u_values = params.components.map(c => c.u).join(',')
        const v_values = params.components.map(c => c.v).join(',')
        
        args.push('--pop-sizes', N_values)
        args.push('--generations', G_values)
        args.push('--factor', f_values)
        args.push('--selection', s_values)
        args.push('--dominance', h_values)
        args.push('--backward-mu', u_values)
        args.push('--forward-mu', v_values)
      }
      
      // Common parameters
      if (params.commonParams) {
        if (params.commonParams.a !== undefined) {
          args.push('--alpha', params.commonParams.a.toString())
        }
        if (params.commonParams.p !== undefined && params.commonParams.p !== null) {
          args.push('--initial-count', params.commonParams.p.toString())
        }
        if (params.integrationCutoff !== undefined) {
          args.push('--integration-cutoff', params.integrationCutoff.toString())
        }
        if (params.commonParams.noProj === true) {
          args.push('--no-project')
        }
      }
    } else {
      // Deterministic mode
      if (params.startingFrequency !== undefined) {
        args.push('-p', params.startingFrequency.toString())
      }
      
      // For deterministic mode, we need to create vectors even for single values
      if (params.populationSize !== undefined) {
        args.push('--pop-sizes', params.populationSize.toString())
      }
      if (params.generations !== undefined) {
        args.push('--generations', params.generations.toString())
      }
      if (params.selectionCoefficient !== undefined) {
        args.push('--selection', params.selectionCoefficient.toString())
      }
      if (params.dominanceCoefficient !== undefined) {
        args.push('--dominance', params.dominanceCoefficient.toString())
      }
      if (params.mutationRateBackward !== undefined) {
        args.push('--backward-mu', params.mutationRateBackward.toString())
      }
      if (params.mutationRateForward !== undefined) {
        args.push('--forward-mu', params.mutationRateForward.toString())
      }
      if (params.alpha !== undefined) {
        args.push('--alpha', params.alpha.toString())
      }
    }
    
    // Execution parameters
    if (params.executionParams) {
      if (params.executionParams.threads !== undefined) {
        args.push('--num-threads', params.executionParams.threads.toString())
      }
      if (params.executionParams.library) {
        args.push('--library', this.normalizeLibrary(params.executionParams.library))
      }
    }

    // Matrix/vector outputs, stochastic mode only. wfafs_stochastic declares
    // --output-Q/-N/-B and they work (verified: files written, stdout JSON
    // intact). It also declares --output-R/-N-ext/-N-fix/-N-tmo, but those
    // REFUSE at runtime -- its chain is non-absorbing, so the quantities do
    // not exist -- and are therefore not offered or emitted. The old code
    // here read writeQ/writeR/writeSFS: writeR would have aborted the run,
    // and --output-SFS matches no flag in any WFES binary (fatal parse
    // error). wfafs_deterministic (the other user of this builder) declares
    // none of these flags, hence the mode gate.
    if (params.mode === 'wfafs-stochastic') {
      const wo = params.output_options
      if (wo?.writeQ) { args.push('--output-Q', this.outputPath(params, 'wfafs', 'Q')) }
      if (wo?.writeN) { args.push('--output-N', this.outputPath(params, 'wfafs', 'N')) }
      if (wo?.writeB) { args.push('--output-B', this.outputPath(params, 'wfafs', 'B')) }
    }

    // Verbose output for debugging
    if (params.verbose) {
      args.push('--verbose')
    }

    // Parameters the tool accepts but the GUI never sent. Each is emitted only
    // when the caller supplies it, so existing calls are unchanged.
    const wfafsInit = params.initial ?? params.executionParams?.initialDistFile ?? params.executionOptions?.initialDistFile
    if (wfafsInit) { args.push('--initial', wfafsInit.toString()) }
    // --force exists on wfafs_stochastic only; wfafs_deterministic exits 1 on it.
    if (params.mode === 'wfafs-stochastic' &&
        (params.force || (params.executionParams?.force ?? params.executionOptions?.force))) {
      args.push('--force')
    }

    // Request structured output. Previously this builder asked for neither
    // --json nor --csv, so the tool emitted a bare "count<TAB>probability"
    // dump and parseWfafsOutput applied parseInt to the probability column,
    // truncating every value to 0.
    args.push('--json')

    return args
  }

  /**
   * Executes a WFES tool as a child process
   * @param {string} toolName - Name of the executable to run
   * @param {string[]} args - Command line arguments
   * @param {string} processId - Unique identifier for process tracking
   * @returns {Promise<ProcessResult>} Process output and exit code
   * @private
   * @throws {Error} If process fails to start, times out, or exits with error
   * @remarks Includes a 10-minute timeout
   */
  private executeProcess(
    toolName: string,
    args: string[],
    processId: string
  ): Promise<ProcessResult> {
    return new Promise((resolve, reject) => {
      try {
        const executablePath = this.getExecutablePath(toolName)
        
        console.log(`Executing: ${executablePath} ${args.join(' ')}`)
        
        const childProcess = spawn(executablePath, args, {
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true
        })
        
        this.activeProcesses.set(processId, childProcess)
        
        let stdout = ''
        let stderr = ''
        let isKilled = false
        
        // Set up timeout (10 minutes max)
        const timeout = setTimeout(() => {
          if (!isKilled) {
            isKilled = true
            childProcess.kill('SIGTERM')
            reject(new Error('Process timeout: execution exceeded 10 minutes'))
          }
        }, 10 * 60 * 1000)
        
        childProcess.stdout?.on('data', (data) => {
          stdout += data.toString()
        })
        
        // stderr is accumulated, not interpreted. A scraper used to sit here
        // looking for "Progress: n%", "n% complete", "Step n of m" and
        // "Iteration n", and drove a percentage bar in five views from what it
        // found. No WFES binary prints any of those four -- checked against
        // every tool -- so the callback never fired and the bars sat at 0%
        // for the whole run while claiming to measure it. The "Iteration n"
        // pattern was worse than inert: it read an iteration COUNT as a
        // PERCENTAGE, so a solver that did print one would have shown a
        // meaningless number as progress.
        //
        // What the tools do write here are the warnings that qualify a
        // successful result; those are split out by warningsFrom() once the
        // process exits, from this same accumulated text.
        childProcess.stderr?.on('data', (data) => {
          stderr += data.toString()
        })
        
        childProcess.on('error', (error) => {
          clearTimeout(timeout)
          this.activeProcesses.delete(processId)
          
          if (error.code === 'ENOENT') {
            reject(new Error(`Executable not found: ${executablePath}. Make sure WFES CLI tools are built.`))
          } else if (error.code === 'EACCES') {
            reject(new Error(`Permission denied: ${executablePath}. Check file permissions.`))
          } else {
            reject(new Error(`Failed to start process: ${error.message}`))
          }
        })
        
        childProcess.on('close', (code, signal) => {
          clearTimeout(timeout)
          this.activeProcesses.delete(processId)
          
          if (isKilled) {
            return // Error already handled by timeout
          }
          
          if (signal === 'SIGTERM' || signal === 'SIGKILL') {
            reject(new Error('Process was terminated'))
          } else if (code === 0) {
            resolve({ stdout, stderr, exitCode: code })
          } else {
            // Try to extract meaningful error from stderr
            let errorMessage = `Process exited with code ${code}`
            
            const errorPatterns = [
              /error:\s*(.*)/i,
              /exception:\s*(.*)/i,
              /failed:\s*(.*)/i,
              /invalid.*:\s*(.*)/i
            ]
            
            for (const pattern of errorPatterns) {
              const match = stderr.match(pattern)
              if (match) {
                errorMessage = match[1].trim()
                break
              }
            }
            
            if (stderr.trim()) {
              errorMessage += `\nDetails: ${stderr.trim()}`
            }
            
            reject(new Error(errorMessage))
          }
        })
        
      } catch (error) {
        reject(new Error(`Setup error: ${error instanceof Error ? error.message : String(error)}`))
      }
    })
  }

  /**
   * Parses JSON output from WFES executables
   * @param {string} output - Raw stdout from executable
   * @returns {any} Parsed JSON object
   * @private
   * @throws {Error} If JSON parsing fails
   * @remarks Handles both clean JSON and mixed output with banners
   */
  private parseJsonOutput(output: string): any {
    try {
      // With the new changes, banner is suppressed when --json is used
      // First try to parse the entire output as JSON
      const trimmedOutput = output.trim()
      if (trimmedOutput.startsWith('{') && trimmedOutput.endsWith('}')) {
        return JSON.parse(trimmedOutput)
      }
      
      // Fallback: Find JSON in output (for older versions or if banner still appears)
      const lines = output.split('\n')
      let jsonStr = ''
      let inJson = false
      let braceCount = 0
      
      for (const line of lines) {
        const trimmed = line.trim()
        
        if (trimmed.startsWith('{')) {
          inJson = true
          braceCount = 1
          jsonStr = trimmed + '\n'
        } else if (inJson && trimmed) {
          jsonStr += trimmed + '\n'
          
          // Count braces to find complete JSON
          for (const char of trimmed) {
            if (char === '{') braceCount++
            else if (char === '}') braceCount--
          }
          
          if (braceCount === 0) {
            // Found complete JSON
            return JSON.parse(jsonStr.trim())
          }
        }
      }
      
      throw new Error('No complete JSON output found')
    } catch (error) {
      throw new Error(`Failed to parse JSON output: ${error.message}`)
    }
  }

  /**
   * Parses phase type distribution CSV output
   * @param {string} output - Raw CSV output with time,P(t),CDF columns
   * @returns {any} Object with distribution array
   * @private
   * @remarks Returns every point the solver produced. Nothing is stride-sampled
   *          here: the statistics and the CSV export are computed from this
   *          array, so dropping points silently changed the reported numbers.
   *          Charts thin for display at the chart layer instead.
   */
  private parsePhaseTypeDistOutput(output: string): any {
    // phase_type_dist now emits JSON (it declared --json but never consumed it,
    // and printed its banner unconditionally on top of any output). Parse that.
    //
    // The previous text path could never succeed: it only accepted lines
    // containing a comma, while the tool's default stdout is TAB-separated and
    // truncated to the first 10 and last 5 rows with a literal "..." between
    // them -- so even a successful run yielded no distribution.
    try {
      const braceAt = output.indexOf('{')
      if (braceAt >= 0) {
        const parsed = JSON.parse(output.slice(braceAt))
        const dist = Array.isArray(parsed.distribution) ? parsed.distribution : []
        return {
          distribution: dist.map((r: any) => ({
            time: Number(r.time),
            probability: Number(r.P_abs),
            // `cumulative`, not `cdf`: that is the name the view, the chart and
            // the text fallback all read. Emitting `cdf` here left every
            // consumer reading undefined -- F_max showed "—" and the chart's
            // CDF series drew nothing at all.
            cumulative: Number(r.cdf)
          })),
          statistics: {
            model: parsed.model,
            parameters: parsed.parameters ?? {},
            timeStepsComputed: parsed.statistics?.time_steps_computed,
            finalCdf: parsed.statistics?.final_cdf,
            // Whether the run actually converged or merely ran out of
            // generations. Without this the view presents moments from a
            // truncated window as if they were the moments.
            distributionCutoff: parsed.statistics?.distribution_cutoff,
            reachedCutoff: parsed.statistics?.reached_cutoff
          }
        }
      }
    } catch (error) {
      console.error('parsePhaseTypeDistOutput: JSON parse failed, falling back to text', error)
    }
    return this.parsePhaseTypeDistOutputText(output)
  }

  private parsePhaseTypeDistOutputText(output: string): any {
    try {
      // Phase type dist outputs a CSV with columns: time, P(t), CDF
      const lines = output.split('\n')
      const distribution: Array<{time: number, probability: number, cumulative: number}> = []

      // Skip banner and find data start
      let dataStarted = false
      
      for (const line of lines) {
        const trimmed = line.trim()
        
        // Skip empty lines
        if (!trimmed) continue
        
        // Skip banner lines
        if (trimmed.includes('WFES') || trimmed.includes('Wright-Fisher') || 
            trimmed.includes('=====') || trimmed.includes('Program:') ||
            trimmed.includes('██') || trimmed.includes('╗') || trimmed.includes('╝') ||
            trimmed.includes('╚') || trimmed.includes('╔') || trimmed.includes('║')) {
          continue
        }
        
        // Parse data lines - CSV format: time,P(t),CDF
        if (trimmed.includes(',')) {
          const parts = trimmed.split(',')
          if (parts.length >= 3 && !isNaN(parseFloat(parts[0]))) {
            const time = parseInt(parts[0])
            const probability = parseFloat(parts[1])
            const cumulative = parseFloat(parts[2])
            
            distribution.push({ time, probability, cumulative })
            dataStarted = true
          }
        }
      }

      // Every parsed point is returned. Stride sampling used to happen here,
      // which quietly changed the statistics and the exported CSV as well as
      // the chart.
      return { distribution }
    } catch (error) {
      console.error('Failed to parse phase type dist output:', error)
      return { distribution: [] }
    }
  }

  /**
   * Parses phase type moments JSON output
   * @param {string} output - JSON output containing moments and statistics
   * @returns {any} Object with mean, std dev, and raw moments array
   * @private
   * @remarks Extracts statistical moments from JSON structure
   */
  private parsePhaseTypeMomentsOutput(output: string): any {
    try {
      // Parse JSON output
      const result = this.parseJsonOutput(output)
      
      // Extract results from JSON structure
      if (result && result.results) {
        const mean = result.results.mean?.toString() || ''
        const std = result.results.std_dev?.toString() || ''
        const moments = (result.results.raw_moments || []).map((m: number) => m.toString())
        
        return { mean, std, moments }
      }
      
      // Fallback if JSON parsing fails
      console.error('Unexpected JSON structure from phase_type_moments:', result)
      return { mean: '', std: '', moments: [] }
    } catch (error) {
      console.error('Failed to parse phase type moments output:', error)
      return { mean: '', std: '', moments: [] }
    }
  }

  /**
   * Bring every time-dist tool's convergence report onto one shape.
   *
   * time_dist and time_dist_dual nest it under `statistics`. time_dist_sgv
   * reports the same facts at the TOP level of its JSON and names its step
   * count `time_steps` rather than `time_steps_computed`, so reading
   * `jsonResult.statistics` for an SGV run yielded {} -- and a run that
   * captured 2.5e-05 of the distribution's mass was reported as a converged
   * expected time with no warning at all.
   *
   * The names here are deliberately the snake_case ones the CLI itself emits,
   * because TimeDistViewMantine already reads `st.reached_cutoff`,
   * `st.time_steps_computed`, `st.distribution_cutoff` and
   * `st.total_probability_absorption` off this object. Renaming them to
   * camelCase would silently disable the truncation banner in the two views
   * where it currently works. Nothing is invented: a field is filled in only
   * when the tool actually reported it, and a `statistics` object that is
   * already present always wins.
   */
  private normalizeTimeDistStatistics(jsonResult: any): any {
    const statistics: any = { ...(jsonResult?.statistics ?? {}) }
    const lift = (target: string, source: string) => {
      if (statistics[target] === undefined && jsonResult?.[source] !== undefined) {
        statistics[target] = jsonResult[source]
      }
    }
    lift('reached_cutoff', 'reached_cutoff')
    lift('distribution_cutoff', 'distribution_cutoff')
    lift('final_cdf', 'final_cdf')
    // time_dist_sgv's step count. Mapped onto the name the views read.
    lift('time_steps_computed', 'time_steps')
    return statistics
  }

  /**
   * Parses time distribution output (JSON or text format)
   * @param {string} output - Raw output from time_dist executable
   * @param {string} mode - Distribution mode (time-dist, time-dist-dual, time-dist-sgv)
   * @returns {any} Parsed distribution data with statistics
   * @private
   * @throws {Error} If no valid data found
   * @remarks Handles both JSON and legacy text formats
   */
  private parseTimeDistOutput(output: string, mode: string): any {
    try {
      // First try to parse as JSON
      try {
        const jsonResult = JSON.parse(output)
        console.log(`Parsed JSON for ${mode}:`, jsonResult)
        
        // Transform JSON data to expected format
        let distribution: any[] = []
        
        if (mode === 'time-dist-sgv' && jsonResult.distribution) {
          // SGV mode has a different format with arrays
          if (jsonResult.distribution.time && jsonResult.distribution.pdf && jsonResult.distribution.cdf) {
            const times = jsonResult.distribution.time
            const pdfs = jsonResult.distribution.pdf
            const cdfs = jsonResult.distribution.cdf
            
            for (let i = 0; i < times.length; i++) {
              distribution.push({
                time: times[i],
                probability: pdfs[i],
                cumulative: cdfs[i]
              })
            }
          }
        } else if (mode === 'time-dist-dual' && jsonResult.distribution) {
          // time_dist_dual emits: time, P_ext, P_fix, P_total, cdf_total.
          //
          // Previously this guessed at key names that the tool never produced
          // (P_ext_1, Sojourn_12), so every field fell through to its `|| 0`
          // default. The old text fallback compounded it by reading the 4th
          // column -- which is P_total -- into a nonexistent "sojourn" series
          // and discarding the real CDF, then recomputing a discontinuous one
          // from the 15 non-contiguous rows the truncated table exposed.
          //
          // The tool has no per-absorption-type CDF (it tracks only the total),
          // so cdf_ext/cdf_fix are left absent rather than fabricated; the
          // block below no longer back-fills them.
          if (Array.isArray(jsonResult.distribution)) {
            for (const item of jsonResult.distribution) {
              distribution.push({
                time: Number(item.time),
                p_ext: Number(item.P_ext ?? 0),
                p_fix: Number(item.P_fix ?? 0),
                p_total: Number(item.P_total ?? 0),
                cdf_total: Number(item.cdf_total ?? 0)
              })
            }
          }
          
          // Derive the per-absorption-type CDFs, which time_dist_dual does not
          // report (it tracks only the total). Explicitly does NOT touch
          // cdf_total: that comes from the tool and must not be overwritten by
          // a running sum, which is what produced the discontinuous CDF the
          // chart used to display. The old guard keyed on cdf_ext === 0, which
          // was true whenever the first row legitimately had zero cumulative
          // extinction probability.
          if (distribution.length > 0 && distribution[0].cdf_ext === undefined) {
            let cdfExt = 0
            let cdfFix = 0

            distribution.forEach(row => {
              cdfExt += row.p_ext
              cdfFix += row.p_fix

              row.cdf_ext = cdfExt
              row.cdf_fix = cdfFix
            })
          }
        } else if (jsonResult.distribution && Array.isArray(jsonResult.distribution)) {
          // Standard time-dist format
          for (const item of jsonResult.distribution) {
            distribution.push({
              time: item.time,
              p_ext: item.P_ext || 0,
              p_fix: item.P_fix || 0,
              p_total: item.P_total || 0,
              cdf_ext: item.cdf_ext || 0,
              cdf_fix: item.cdf_fix || 0,
              cdf_total: item.cdf_total || 0
            })
          }
        }
        
        // For time-dist-dual, if we have no distribution but have raw data, try to parse it
        if (mode === 'time-dist-dual' && distribution.length === 0 && jsonResult.data) {
          console.log('time-dist-dual: trying to parse from jsonResult.data')
          // Try to parse from alternative data structure
          if (Array.isArray(jsonResult.data)) {
            for (const item of jsonResult.data) {
              distribution.push({
                time: item.time || item.t || item[0],
                p_ext: item.P_ext_1 || item.p_ext || item[1] || 0,
                p_fix: item.P_fix_1 || item.p_fix || item[2] || 0,
                p_total: (item.P_ext_1 || item.p_ext || item[1] || 0) + (item.P_fix_1 || item.p_fix || item[2] || 0),
                sojourn: item.Sojourn_12 || item.sojourn || item[3] || 0,
                cdf_ext: 0,
                cdf_fix: 0,
                cdf_total: 0
              })
            }
            // Calculate cumulative
            let cdfExt = 0, cdfFix = 0, cdfTotal = 0
            distribution.forEach(row => {
              cdfExt += row.p_ext
              cdfFix += row.p_fix
              cdfTotal += row.p_total
              row.cdf_ext = cdfExt
              row.cdf_fix = cdfFix
              row.cdf_total = cdfTotal
            })
          }
        }
        
        return {
          parameters: jsonResult.parameters || {},
          statistics: this.normalizeTimeDistStatistics(jsonResult),
          distribution: distribution,
          results: mode === 'time-dist-sgv' ? 
            distribution.map(d => `${d.time}\t${d.probability}\t${d.cumulative}`) :
            distribution.map(d => `${d.time}\t${d.p_ext}\t${d.p_fix}\t${d.p_total}\t${d.cdf_ext}\t${d.cdf_fix}\t${d.cdf_total}`),
          executionTime: jsonResult.execution_time
        }
      } catch (jsonError) {
        // If JSON parsing fails, fall back to text parsing
        console.log('JSON parsing failed, falling back to text parsing:', jsonError.message)
      }
      
      // Fallback: parse text output
      const lines = output.split('\n')
      const distribution: any[] = []
      const rawResults: string[] = []
      let dataStarted = false
      
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        
        // Parse data lines that contain space-separated numbers
        const parts = trimmed.split(/\s+/)
        if (parts.length >= 3 && !isNaN(parseFloat(parts[0]))) {
          // Check mode and parse accordingly
          if (mode === 'time-dist-dual') {
            // Dual mode has 4 columns: t, P_ext_1, P_fix_1, Sojourn_12
            if (parts.length >= 4) {
              const time = parseInt(parts[0])
              const pExt1 = parseFloat(parts[1])
              const pFix1 = parseFloat(parts[2])
              const sojourn = parseFloat(parts[3])
              
              // Add to distribution array in similar format to standard time-dist
              distribution.push({
                time,
                p_ext: pExt1,
                p_fix: pFix1,
                p_total: pExt1 + pFix1,
                sojourn: sojourn,
                // Calculate cumulative values
                cdf_ext: 0,  // Will be calculated later
                cdf_fix: 0,  // Will be calculated later
                cdf_total: 0 // Will be calculated later
              })
              
              if (pExt1 > 0 || pFix1 > 0 || sojourn > 0) {
                rawResults.push(`t=${time}: P_ext1=${pExt1.toExponential(4)}, P_fix1=${pFix1.toExponential(4)}, Sojourn=${sojourn.toExponential(4)}`)
              }
            }
          } else if (mode === 'time-dist-sgv') {
            // SGV mode has 3 columns: time, P(substitution), CDF
            const time = parseInt(parts[0])
            const probability = parseFloat(parts[1])
            const cumulative = parseFloat(parts[2])
            
            distribution.push({
              time,
              probability,
              cumulative
            })
          } else if (parts.length >= 7) {
            // Standard time-dist mode: Time, P_ext, P_fix, P_total, cdf_ext, cdf_fix, cdf_total
            const time = parseInt(parts[0])
            const p_ext = parseFloat(parts[1])
            const p_fix = parseFloat(parts[2])
            const p_total = parseFloat(parts[3])
            const cdf_ext = parseFloat(parts[4])
            const cdf_fix = parseFloat(parts[5])
            const cdf_total = parseFloat(parts[6])
            
            distribution.push({ 
              time, 
              p_ext, 
              p_fix, 
              p_total, 
              cdf_ext, 
              cdf_fix, 
              cdf_total 
            })
            
            if (p_ext > 0 || p_fix > 0) {
              rawResults.push(`t=${time}: P(ext)=${p_ext.toExponential(4)}, P(fix)=${p_fix.toExponential(4)}, CDF_total=${cdf_total.toFixed(6)}`)
            }
          }
          
          dataStarted = true
        } else if (dataStarted) {
          // Look for summary statistics after the data
          if (trimmed.includes('E[') || trimmed.includes('Expected')) {
            const match = trimmed.match(/[\d.e+-]+/g)
            if (match && match.length > 0) {
              const value = match[match.length - 1] // Get the last number
              if (trimmed.includes('extinction') || trimmed.includes('ext')) {
                rawResults.unshift(`Expected extinction time: ${value}`)
              } else if (trimmed.includes('fixation') || trimmed.includes('fix')) {
                rawResults.unshift(`Expected fixation time: ${value}`)
              } else if (trimmed.includes('sojourn')) {
                rawResults.unshift(`Expected sojourn time: ${value}`)
              }
            }
          } else if (trimmed.includes('Var[') || trimmed.includes('Variance')) {
            const match = trimmed.match(/[\d.e+-]+/g)
            if (match && match.length > 0) {
              const value = match[match.length - 1]
              if (trimmed.includes('extinction') || trimmed.includes('ext')) {
                rawResults.unshift(`Variance of extinction time: ${value}`)
              } else if (trimmed.includes('fixation') || trimmed.includes('fix')) {
                rawResults.unshift(`Variance of fixation time: ${value}`)
              } else if (trimmed.includes('sojourn')) {
                rawResults.unshift(`Variance of sojourn time: ${value}`)
              }
            }
          } else if (trimmed.includes('P_ext') || trimmed.includes('P(extinction)')) {
            const match = trimmed.match(/[\d.e+-]+/)
            if (match) {
              rawResults.unshift(`Total extinction probability: ${match[0]}`)
            }
          } else if (trimmed.includes('P_fix') || trimmed.includes('P(fixation)')) {
            const match = trimmed.match(/[\d.e+-]+/)
            if (match) {
              rawResults.unshift(`Total fixation probability: ${match[0]}`)
            }
          }
        }
      }
      
      // If no data was parsed, check for error messages
      if (rawResults.length === 0 && distribution.length === 0) {
        console.error('No time dist data found in output:', output)
        
        // Look for error messages in the output
        for (const line of lines) {
          if (line.includes('Error') || line.includes('error')) {
            throw new Error(line)
          }
        }
        
        throw new Error('No valid time distribution data found in output')
      }
      
      // Calculate cumulative distributions for time-dist-dual if needed
      if (mode === 'time-dist-dual' && distribution.length > 0) {
        let cdfExt = 0
        let cdfFix = 0
        let cdfTotal = 0
        
        distribution.forEach(row => {
          cdfExt += row.p_ext
          cdfFix += row.p_fix
          cdfTotal += row.p_total
          
          row.cdf_ext = cdfExt
          row.cdf_fix = cdfFix
          row.cdf_total = cdfTotal
        })
      }
      
      return { results: rawResults, distribution }
    } catch (error) {
      throw new Error(`Failed to parse time dist output: ${error.message}`)
    }
  }

  /**
   * Parses WFAFD output to extract allele frequency distribution
   * @param {string} output - Raw output with copy number and probability columns
   * @returns {any} Distribution array and calculated statistics
   * @private
   * @remarks Calculates frequencies, cumulative distribution, and summary stats
   */
  private parseWfafdOutput(output: string): any {
    // JSON path: the run now passes --json. The spectrum arrives as
    // results-free top-level { parameters, spectrum: [{count, probability}] }.
    // No zero-dropping and no re-normalization: the distribution is shown as
    // the solver produced it, so a CLI defect would be visible instead of
    // silently smoothed over.
    try {
      const braceAt = output.indexOf('{')
      if (braceAt >= 0) {
        const parsed = JSON.parse(output.slice(braceAt))
        if (Array.isArray(parsed.spectrum)) {
          const N = Math.max(0, ...parsed.spectrum.map((r: any) => Number(r.count) || 0))
          let cumSum = 0
          const distribution = parsed.spectrum.map((r: any) => {
            const probability = Number(r.probability) || 0
            cumSum += probability
            return {
              copies: Number(r.count) || 0,
              frequency: N > 0 ? (Number(r.count) || 0) / N : 0,
              probability,
              cumulative: cumSum
            }
          })
          const statistics: any = {}
          if (distribution.length > 0) {
            let meanFreq = 0
            for (const item of distribution) meanFreq += item.frequency * item.probability
            statistics.meanFrequency = meanFreq
            let variance = 0
            for (const item of distribution) variance += Math.pow(item.frequency - meanFreq, 2) * item.probability
            statistics.variance = variance
            statistics.fixationProbability = distribution.find((d: any) => d.copies === N)?.probability ?? 0
            statistics.extinctionProbability = distribution.find((d: any) => d.copies === 0)?.probability ?? 0
          }
          return { distribution, statistics, parameters: parsed.parameters ?? {} }
        }
      }
    } catch (error) {
      console.error('parseWfafdOutput: JSON parse failed, falling back to text', error)
    }
    // Text fallback (pre---json output).
    try {
      const lines = output.split('\n')
      const distribution: Array<{
        copies: number,
        frequency: number,
        probability: number,
        cumulative: number
      }> = []
      const statistics: any = {}
      let dataStarted = false
      let totalProbability = 0
      
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        
        // Skip banner lines
        if (trimmed.includes('WFES') || trimmed.includes('Wright-Fisher') || 
            trimmed.includes('=====') || trimmed.includes('Program:') ||
            trimmed.includes('██') || trimmed.includes('╗') || trimmed.includes('╝') ||
            trimmed.includes('╚') || trimmed.includes('╔') || trimmed.includes('║')) {
          continue
        }
        
        // Parse data lines - expected format: copies probability
        const parts = trimmed.split(/\s+/)
        if (parts.length >= 2 && !isNaN(parseInt(parts[0])) && !isNaN(parseFloat(parts[1]))) {
          const copies = parseInt(parts[0])
          const probability = parseFloat(parts[1])
          
          // Skip zero probabilities
          if (probability > 0) {
            distribution.push({
              copies,
              frequency: 0, // Will calculate after knowing population size
              probability,
              cumulative: 0 // Will calculate after all data is parsed
            })
            
            totalProbability += probability
          }
          dataStarted = true
        }
      }
      
      // Infer population size from the distribution
      let N = 0
      if (distribution.length > 0) {
        N = Math.max(...distribution.map(d => d.copies))
      }
      
      // Calculate frequencies and normalize probabilities
      if (N > 0) {
        distribution.forEach(item => {
          item.frequency = item.copies / N
          if (totalProbability > 0) {
            item.probability = item.probability / totalProbability
          }
        })
      }
      
      // Calculate cumulative distribution
      let cumSum = 0
      distribution.forEach(item => {
        cumSum += item.probability
        item.cumulative = cumSum
      })
      
      // Calculate statistics
      if (distribution.length > 0) {
        // Mean frequency
        let meanFreq = 0
        distribution.forEach(item => {
          meanFreq += item.frequency * item.probability
        })
        statistics.meanFrequency = meanFreq
        
        // Variance
        let variance = 0
        distribution.forEach(item => {
          variance += Math.pow(item.frequency - meanFreq, 2) * item.probability
        })
        statistics.variance = variance
        
        // Fixation probability (frequency = 1)
        const fixationItem = distribution.find(d => d.copies === N)
        statistics.fixationProbability = fixationItem ? fixationItem.probability : 0
        
        // Extinction probability (frequency = 0)
        const extinctionItem = distribution.find(d => d.copies === 0)
        statistics.extinctionProbability = extinctionItem ? extinctionItem.probability : 0
      }
      
      return { distribution, statistics }
    } catch (error) {
      throw new Error(`Failed to parse WFAFD output: ${error.message}`)
    }
  }

  /**
   * Parses wfes_sequential CSV output
   * @param {string} output - CSV output with probabilities and times
   * @returns {any} Object with parsed results (P_ext, P_fix, T_ext, etc.)
   * @private
   * @remarks Handles both CSV and standard output formats
   */
  private parseWfesSequentialOutput(output: string): any {
    // wfes_sequential now emits JSON. Parse that in preference to the CSV row,
    // which omits T_ext_std / T_fix_std / T_tmo_std entirely -- the view shows
    // "+/- std" for these, so under CSV those figures could never be real.
    try {
      const braceAt = output.indexOf('{')
      if (braceAt >= 0) {
        const parsed = JSON.parse(output.slice(braceAt))
        const r = parsed.results ?? {}
        // Wrapped in { results } to match the shape the IPC handler reads
        // (index.ts does `results: results.results`) and the CSV fallback.
        return { results: {
          // Spread first so new CLI keys (the per-epoch P_cond_*/T_* arrays)
          // reach the renderer without this whitelist needing to know them;
          // the explicit Number() coercions below still win for the scalars.
          ...r,
          P_ext: Number(r.P_ext),
          P_fix: Number(r.P_fix),
          P_tmo: Number(r.P_tmo),
          T_ext: Number(r.T_ext),
          T_ext_std: Number(r.T_ext_std),
          T_fix: Number(r.T_fix),
          T_fix_std: Number(r.T_fix_std),
          T_tmo: Number(r.T_tmo),
          T_tmo_std: Number(r.T_tmo_std)
        }, parameters: parsed.parameters ?? {} }
      }
    } catch (error) {
      console.error('parseWfesSequentialOutput: JSON parse failed, falling back to CSV', error)
    }
    return this.parseWfesSequentialOutputCsv(output)
  }

  private parseWfesSequentialOutputCsv(output: string): any {
    try {
      const lines = output.split('\n')
      const results: any = {}
      
      // Look for CSV output line
      let csvLine = ''
      for (const line of lines) {
        // Skip banner lines and empty lines
        if (line.includes('WFES') || line.includes('Wright-Fisher') || 
            line.includes('=====') || line.includes('Program:') ||
            line.includes('██') || !line.trim()) {
          continue
        }
        
        // CSV line will have many comma-separated values
        if (line.includes(',') && line.split(',').length > 10) {
          csvLine = line
          break
        }
        
        // Also try to parse regular output format
        if (line.includes('P_ext =')) {
          const match = line.match(/P_ext = ([\d.e+-]+)/)
          if (match) results.P_ext = parseFloat(match[1])
        } else if (line.includes('P_fix =')) {
          const match = line.match(/P_fix = ([\d.e+-]+)/)
          if (match) results.P_fix = parseFloat(match[1])
        } else if (line.includes('P_tmo =')) {
          const match = line.match(/P_tmo = ([\d.e+-]+)/)
          if (match) results.P_tmo = parseFloat(match[1])
        } else if (line.includes('T_ext =')) {
          const match = line.match(/T_ext = ([\d.e+-]+)(?: \+\/- ([\d.e+-]+))?/)
          if (match) {
            results.T_ext = parseFloat(match[1])
            if (match[2]) results.T_ext_std = parseFloat(match[2])
          }
        } else if (line.includes('T_fix =')) {
          const match = line.match(/T_fix = ([\d.e+-]+)(?: \+\/- ([\d.e+-]+))?/)
          if (match) {
            results.T_fix = parseFloat(match[1])
            if (match[2]) results.T_fix_std = parseFloat(match[2])
          }
        } else if (line.includes('T_tmo =')) {
          const match = line.match(/T_tmo = ([\d.e+-]+)(?: \+\/- ([\d.e+-]+))?/)
          if (match) {
            results.T_tmo = parseFloat(match[1])
            if (match[2]) results.T_tmo_std = parseFloat(match[2])
          }
        }
      }
      
      // If we found CSV output, parse it
      if (csvLine) {
        const values = csvLine.split(',').map(v => v.trim())
        
        // The CSV format from the C++ code shows the order is:
        // N1,N2,...,t1,t2,...,s1,s2,...,h1,h2,...,u1,u2,...,v1,v2,...,p1,p2,...,a,P_ext,P_fix,P_tmo,T_ext,T_fix,T_tmo
        // We'll parse the last 6 values which are the results
        if (values.length >= 6) {
          const len = values.length
          results.P_ext = parseFloat(values[len - 6])
          results.P_fix = parseFloat(values[len - 5])
          results.P_tmo = parseFloat(values[len - 4])
          results.T_ext = parseFloat(values[len - 3])
          results.T_fix = parseFloat(values[len - 2])
          results.T_tmo = parseFloat(values[len - 1])
        }
      }
      
      return { results }
      
    } catch (error) {
      console.error('Error parsing WFES Sequential output:', error)
      throw new Error(`Failed to parse WFES Sequential output: ${error.message}`)
    }
  }

  /**
   * Parses wfes_switching output based on model type
   * @param {string} output - Raw output from wfes_switching
   * @param {string} modelType - Either 'absorption' or 'fixation' model
   * @returns {any} Parsed results with probabilities and times
   * @private
   * @remarks Fixation model always has P_fix=1, absorption model has state-specific results
   */
  private parseWfesSwitchingOutput(output: string, modelType: string): any {
    try {
      // First try to parse as JSON
      const jsonMatch = output.match(/\{[\s\S]*\}/)
      if (jsonMatch) {
        const jsonData = JSON.parse(jsonMatch[0])
        
        // Check if results are in the expected structure
        if (jsonData.results) {
          // Return the results with additional state timeline data if needed
          const results = { ...jsonData.results }
          
          // For absorption model, calculate T_abs (expected absorption time)
          if (modelType === 'absorption' && jsonData.results.P_ext !== undefined && 
              jsonData.results.P_fix !== undefined && jsonData.results.T_ext !== undefined && 
              jsonData.results.T_fix !== undefined) {
            // T_abs = P_ext * T_ext + P_fix * T_fix
            results.T_abs = (jsonData.results.P_ext * jsonData.results.T_ext) + 
                           (jsonData.results.P_fix * jsonData.results.T_fix)
          }
          
          // For absorption model, we might want to include state probabilities
          if (modelType === 'absorption' && jsonData.results.P_cond_ext && jsonData.results.P_cond_fix) {
            // Calculate state probabilities (time spent in each state)
            const p_ext = jsonData.results.P_ext || 0
            const p_fix = jsonData.results.P_fix || 0
            const state_probabilities = []
            
            for (let i = 0; i < jsonData.results.P_cond_ext.length; i++) {
              const prob = (jsonData.results.P_cond_ext[i] || 0) + (jsonData.results.P_cond_fix[i] || 0)
              state_probabilities.push(prob)
            }
            
            results.state_probabilities = state_probabilities
          }
          
          return results
        } else {
          // If not, return the whole JSON object as results
          return jsonData
        }
      }
      
      // Fall back to CSV parsing for older versions
      const lines = output.split('\n')
      const results: any = {}
      
      if (modelType === 'fixation') {
        // Parse fixation model output
        // Format: N1,N2,s1,s2,h1,h2,u1,u2,v1,v2,p1,p2,a,T_fix,rate
        let csvLine = ''
        for (const line of lines) {
          // Skip banner lines
          if (line.includes('WFES') || line.includes('Wright-Fisher') || 
              line.includes('=====') || line.includes('Program:') ||
              line.includes('██') || !line.trim()) {
            continue
          }
          
          // Look for CSV line with many comma-separated values
          if (line.includes(',') && line.split(',').length > 10) {
            csvLine = line
            break
          }
          
          // Also parse non-CSV output
          if (line.includes('T_fix =')) {
            const match = line.match(/T_fix = ([\d.e+-]+)/)
            if (match) results.T_fix = parseFloat(match[1])
          } else if (line.includes('Rate =')) {
            const match = line.match(/Rate = ([\d.e+-]+)/)
            if (match) results.rate = parseFloat(match[1])
          }
        }
        
        if (csvLine) {
          const values = csvLine.split(',').map(v => v.trim())
          if (values.length >= 2) {
            // Last two values are T_fix and rate
            results.T_fix = parseFloat(values[values.length - 2])
            results.rate = parseFloat(values[values.length - 1])
          }
        }
        
        // For fixation model, P_fix is always 1 (since extinction is not absorbing)
        results.P_fix = 1.0
        results.P_ext = 0.0
        
      } else {
        // Parse absorption model output
        // CSV format: Model,StartState,P_ext,P_fix,T_abs,T_ext,T_fix
        const dataLines: string[] = []
        let headerFound = false
        
        for (const line of lines) {
          // Skip banner lines
          if (line.includes('WFES') || line.includes('Wright-Fisher') || 
              line.includes('=====') || line.includes('Program:') ||
              line.includes('██') || !line.trim()) {
            continue
          }
          
          // Look for header line
          if (line.includes('Model,StartState,P_ext,P_fix')) {
            headerFound = true
            continue
          }
          
          // Collect data lines after header
          if (headerFound && line.includes(',')) {
            dataLines.push(line)
          }
          
          // Also parse non-CSV output
          if (line.includes('P_ext =')) {
            const match = line.match(/P_ext = ([\d.e+-]+)/)
            if (match) results.P_ext = parseFloat(match[1])
          } else if (line.includes('P_fix =')) {
            const match = line.match(/P_fix = ([\d.e+-]+)/)
            if (match) results.P_fix = parseFloat(match[1])
          } else if (line.includes('T_abs =')) {
            const match = line.match(/T_abs = ([\d.e+-]+)/)
            if (match) results.T_abs = parseFloat(match[1])
          }
        }
        
        // If we have CSV data, aggregate results across models
        if (dataLines.length > 0) {
          let totalPext = 0
          let totalPfix = 0
          let totalTabs = 0
          let totalText = 0
          let totalTfix = 0
          let count = 0
          
          // Also track state probabilities
          const stateProbabilities: { [key: number]: number } = {}
          
          for (const line of dataLines) {
            const values = line.split(',').map(v => v.trim())
            if (values.length >= 7) {
              const model = parseInt(values[0])
              const pExt = parseFloat(values[2])
              const pFix = parseFloat(values[3])
              const tAbs = parseFloat(values[4])
              const tExt = parseFloat(values[5])
              const tFix = parseFloat(values[6])
              
              totalPext += pExt
              totalPfix += pFix
              totalTabs += tAbs
              totalText += tExt
              totalTfix += tFix
              count++
              
              // Track time spent in each state
              if (!stateProbabilities[model]) {
                stateProbabilities[model] = 0
              }
              stateProbabilities[model] += tAbs
            }
          }
          
          if (count > 0) {
            // Average the results
            results.P_ext = totalPext / count
            results.P_fix = totalPfix / count
            results.T_abs = totalTabs / count
            results.T_ext = totalText / count
            results.T_fix = totalTfix / count
            
            // Calculate state probabilities as proportions
            const totalTime = Object.values(stateProbabilities).reduce((a, b) => a + b, 0)
            results.state_probabilities = []
            for (let i = 0; i < Object.keys(stateProbabilities).length; i++) {
              results.state_probabilities[i] = (stateProbabilities[i] || 0) / totalTime
            }
          }
        }
      }
      
      return { results }
      
    } catch (error) {
      console.error('Error parsing WFES Switching output:', error)
      throw new Error(`Failed to parse WFES Switching output: ${error.message}`)
    }
  }

  /**
   * Parses WFAFS output to extract allele frequency spectrum
   * @param {string} output - Raw output with frequency count data
   * @param {string} mode - Either 'wfafs-deterministic' or 'wfafs-stochastic'
   * @returns {any} Spectrum array with statistics
   * @private
   * @remarks Calculates proportions and summary statistics
   */
  private parseWfafsOutput(output: string, mode: string): any {
    // The tools now emit JSON (wfafs_stochastic already did; wfafs_deterministic
    // gained it alongside this change), so parse that rather than scraping text.
    //
    // The previous text path had two defects that made the spectrum unusable:
    // it applied parseInt to the probability column, truncating every value to
    // 0, and it had to skip ASCII-banner lines by pattern-matching box-drawing
    // characters. Both disappear with structured input. A text fallback is kept
    // only for robustness against an older binary on the PATH.
    try {
      const braceAt = output.indexOf('{')
      if (braceAt >= 0) {
        const parsed = JSON.parse(output.slice(braceAt))
        // The two WFAFS tools emit different shapes, so accept both:
        //   wfafs_stochastic    results.distribution[] with allele_count
        //   wfafs_deterministic spectrum[]             with count
        // (Worth unifying upstream eventually; handled here so neither view
        // depends on which binary it happens to be driving.)
        const raw: any[] = Array.isArray(parsed?.results?.distribution)
          ? parsed.results.distribution
          : Array.isArray(parsed.spectrum)
            ? parsed.spectrum
            : Array.isArray(parsed.distribution)
              ? parsed.distribution
              : []
        const rows: Array<{ count: number; probability: number }> = raw.map((r: any) => ({
          count: Number(r.allele_count ?? r.count),
          probability: Number(r.probability)
        }))
        const total = rows.reduce((acc, r) => acc + r.probability, 0)
        return {
          spectrum: rows.map((r) => ({
            frequency: r.count,
            count: r.count,
            expected: r.probability,
            proportion: total > 0 ? r.probability / total : 0
          })),
          statistics: {
            model: parsed.model,
            parameters: parsed.parameters ?? {},
            totalProbability: total,
            states: rows.length
          },
          mode
        }
      }
    } catch (error) {
      console.error('parseWfafsOutput: JSON parse failed, falling back to text', error)
    }
    return this.parseWfafsOutputText(output, mode)
  }

  private parseWfafsOutputText(output: string, mode: string): any {
    try {
      const lines = output.split('\n')
      const spectrum: Array<{
        frequency: number,
        count: number,
        expected: number,
        proportion: number
      }> = []
      const statistics: any = {}
      let dataStarted = false
      let totalSites = 0
      let polymorphicSites = 0
      
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        
        // Skip banner lines
        if (trimmed.includes('WFES') || trimmed.includes('Wright-Fisher') || 
            trimmed.includes('=====') || trimmed.includes('Program:') ||
            trimmed.includes('██') || trimmed.includes('╗') || trimmed.includes('╝') ||
            trimmed.includes('╚') || trimmed.includes('╔') || trimmed.includes('║')) {
          continue
        }
        
        // Parse data lines - expected format: frequency count [expected]
        const parts = trimmed.split(/\s+/)
        if (parts.length >= 2 && !isNaN(parseInt(parts[0])) && !isNaN(parseInt(parts[1]))) {
          const frequency = parseInt(parts[0])
          const count = parseInt(parts[1])
          const expected = parts.length >= 3 ? parseFloat(parts[2]) : 0
          
          spectrum.push({
            frequency,
            count,
            expected,
            proportion: 0 // Will calculate after all data is parsed
          })
          
          totalSites += count
          if (count > 0) polymorphicSites++
          dataStarted = true
        } else if (dataStarted) {
          // Look for summary statistics after data
          if (trimmed.includes('Total sites:') || trimmed.includes('Total:')) {
            const match = trimmed.match(/\d+/)
            if (match) {
              statistics.totalSites = parseInt(match[0])
            }
          } else if (trimmed.includes('Polymorphic sites:') || trimmed.includes('Polymorphic:')) {
            const match = trimmed.match(/\d+/)
            if (match) {
              statistics.polymorphicSites = parseInt(match[0])
            }
          } else if (trimmed.includes('Mean frequency:') || trimmed.includes('Mean:')) {
            const match = trimmed.match(/[\d.e+-]+/)
            if (match) {
              statistics.meanFrequency = parseFloat(match[0])
            }
          }
        }
      }
      
      // Calculate proportions
      if (totalSites > 0) {
        spectrum.forEach(item => {
          item.proportion = item.count / totalSites
        })
      }
      
      // Set statistics if not already parsed from output
      if (!statistics.totalSites) {
        statistics.totalSites = totalSites
      }
      if (!statistics.polymorphicSites) {
        statistics.polymorphicSites = polymorphicSites
      }
      if (!statistics.meanFrequency && spectrum.length > 0) {
        // Calculate mean frequency
        let sum = 0
        let count = 0
        spectrum.forEach(item => {
          sum += item.frequency * item.count
          count += item.count
        })
        statistics.meanFrequency = count > 0 ? sum / count : 0
      }
      
      return { spectrum, statistics }
    } catch (error) {
      throw new Error(`Failed to parse WFAFS output: ${error.message}`)
    }
  }

  /**
   * Executes wfes_sequential for multi-epoch demographic analysis
   * @param {any} params - Sequential model parameters with population arrays
   * @returns {Promise<any>} Parsed results with extinction/fixation probabilities and times
   * @throws {Error} If execution fails
   */
  async executeWfesSequential(params: any): Promise<any> {
    const processId = 'wfes_sequential_' + Date.now()
    
    try {
      // Build command line arguments
      const args = this.buildWfesSequentialArgs(params)
      
      // wfes_sequential now has --json (it was the only tool without any
      // structured output). Requesting JSON rather than CSV also recovers
      // T_ext_std / T_fix_std / T_tmo_std, which the CSV branch omits -- the
      // view renders "+/- std" figures that were previously never populated.
      args.push('--json')
      
      // Execute the process
      const result = await this.executeProcess(
        'wfes_sequential',
        args,
        processId
      )
      
      // Parse CSV output
      return {
        ...this.parseWfesSequentialOutput(result.stdout),
        warnings: this.warningsFrom(result.stderr)
      }

    } catch (error) {
      throw error
    } finally {
      this.activeProcesses.delete(processId)
    }
  }

  /**
   * Executes wfes_switching for time-heterogeneous population analysis
   * @param {any} params - Switching model parameters with states and transition matrix
   * @returns {Promise<any>} Parsed results based on model type (absorption/fixation)
   * @throws {Error} If execution fails
   */
  async executeWfesSwitching(params: any): Promise<any> {
    const processId = 'wfes_switching_' + Date.now()
    
    try {
      // Ensure JSON output
      params.json_output = true
      params.csv_output = false
      
      // Build command line arguments
      const args = this.buildWfesSwitchingArgs(params)
      
      // Add JSON output flag
      args.push('--json')
      
      // Execute the process
      const result = await this.executeProcess(
        'wfes_switching',
        args,
        processId
      )
      
      // Parse output based on model type
      return {
        ...this.parseWfesSwitchingOutput(result.stdout, params.model_type || 'absorption'),
        warnings: this.warningsFrom(result.stderr)
      }
    } finally {
      this.activeProcesses.delete(processId)
    }
  }

  /**
   * Cancels a specific running process
   * @param {string} processId - ID of process to cancel
   * @returns {boolean} True if process was found and cancelled
   */
  cancelProcess(processId: string): boolean {
    const process = this.activeProcesses.get(processId)
    if (process) {
      process.kill('SIGTERM')
      this.activeProcesses.delete(processId)
      return true
    }
    return false
  }

  /**
   * Cancels all active processes
   * @remarks Used during cleanup or application shutdown
   */
  cancelAllProcesses(): void {
    for (const [id, process] of this.activeProcesses) {
      process.kill('SIGTERM')
    }
    this.activeProcesses.clear()
  }
  
  /**
   * Reads fundamental matrix data from CSV file
   * @param {string} filePath - Path to the CSV file
   * @returns {Promise<number[][] | null>} 2D array of matrix values or null if error
   * @private
   * @remarks Used for wfes_single fundamental mode matrix output
   */
  private async readFundamentalMatrix(filePath: string): Promise<number[][] | null> {
    try {
      const content = await fs.promises.readFile(filePath, 'utf-8')
      const lines = content.trim().split('\n')
      
      const matrix: number[][] = []
      for (const line of lines) {
        if (line.trim()) {
          const row = line.split(',').map(val => parseFloat(val.trim()))
          matrix.push(row)
        }
      }
      
      return matrix.length > 0 ? matrix : null
    } catch (error) {
      console.error('Error reading fundamental matrix:', error)
      return null
    }
  }
}

/**
 * Singleton instance of WfesBackendService
 * @type {WfesBackendService}
 * @exports wfesBackendService
 */
export const wfesBackendService = new WfesBackendService()