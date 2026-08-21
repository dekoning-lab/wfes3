/**
 * Puts the bundled command-line programs on the user's PATH.
 *
 * A drag-install DMG cannot run scripts, so the application has to offer this
 * itself, the way VS Code installs its `code` command. We symlink each program
 * into a directory that is already on the default PATH rather than editing the
 * user's shell configuration: no dotfile is touched, every shell sees the
 * programs at once, and uninstalling is removing the links.
 *
 * The links point into the application bundle, so `wfes_single` on the PATH is
 * always the version the installed app runs. Moving or deleting the app leaves
 * the links dangling, which `status()` detects and reports as not installed.
 *
 * Symlinking is safe here despite the binaries loading their libraries through
 * @executable_path/lib: dyld resolves a symlink to its target before expanding
 * @executable_path, so a linked program finds the bundle's lib directory. This
 * was verified against the packaged binaries rather than assumed.
 */
import { app } from 'electron'
import { promises as fs } from 'fs'
import { execFile } from 'child_process'
import { promisify } from 'util'
import path from 'path'

const execFileAsync = promisify(execFile)

/**
 * /usr/local/bin is on the default macOS PATH; ~/.local/bin is not.
 * WFES_CLI_INSTALL_DIR redirects this for automated tests, in the same spirit
 * as WFES_SAVE_DIR for the export harnesses. It is not a user-facing setting.
 */
const INSTALL_DIR = process.env.WFES_CLI_INSTALL_DIR || '/usr/local/bin'

export const CLI_PROGRAMS = [
  'wfes_single',
  'wfes_switching',
  'wfes_sequential',
  'wfes_sweep',
  'time_dist',
  'time_dist_dual',
  'time_dist_sgv',
  'phase_type_dist',
  'phase_type_moments',
  'wfafs_deterministic',
  'wfafs_stochastic'
]

export interface CliStatus {
  supported: boolean
  installed: boolean
  installDir: string
  /** Programs linked to THIS bundle. */
  linked: string[]
  /** Programs present but pointing somewhere else -- another copy of the app,
   *  a Homebrew build, or a stale link left by a bundle that has been moved. */
  foreign: string[]
  sourceDir: string
}

function sourceDir(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'bin')
    : path.join(__dirname, '../../../../wfes-cli/build/bin')
}

/**
 * Runs a shell command with administrator privileges, which shows the standard
 * macOS authentication dialog. `with prompt` supplies the reason the user sees.
 */
async function runElevated(script: string): Promise<void> {
  const escaped = script.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  await execFileAsync('/usr/bin/osascript', [
    '-e',
    `do shell script "${escaped}" with prompt "WFES3 needs permission to install its command-line programs." with administrator privileges`
  ])
}

export async function status(): Promise<CliStatus> {
  const src = sourceDir()
  const result: CliStatus = {
    supported: process.platform === 'darwin',
    installed: false,
    installDir: INSTALL_DIR,
    linked: [],
    foreign: [],
    sourceDir: src
  }
  if (!result.supported) return result

  for (const name of CLI_PROGRAMS) {
    const link = path.join(INSTALL_DIR, name)
    try {
      // Compare against the real path of the link target so that a bundle
      // reached through a symlinked /Applications still matches.
      const target = await fs.realpath(link)
      const expected = await fs.realpath(path.join(src, name))
      if (target === expected) result.linked.push(name)
      else result.foreign.push(name)
    } catch {
      // Missing, or a dangling link whose target no longer exists. Either way
      // it is not a working installation of this bundle.
    }
  }
  result.installed = result.linked.length === CLI_PROGRAMS.length
  return result
}

export interface InstallResult {
  ok: boolean
  installed: string[]
  installDir: string
  /** Set when the user cancelled the authentication dialog, so the caller can
   *  stay quiet instead of reporting a failure the user chose. */
  cancelled?: boolean
  error?: string
}

export async function install(): Promise<InstallResult> {
  const src = sourceDir()
  const base: InstallResult = { ok: false, installed: [], installDir: INSTALL_DIR }

  if (process.platform !== 'darwin') {
    return { ...base, error: 'Installing the command-line programs is supported on macOS only.' }
  }

  // Fail before prompting for a password if the programs are not there.
  const missing: string[] = []
  for (const name of CLI_PROGRAMS) {
    try {
      await fs.access(path.join(src, name))
    } catch {
      missing.push(name)
    }
  }
  if (missing.length) {
    return {
      ...base,
      error: `These programs are not in the application bundle: ${missing.join(', ')}.`
    }
  }

  const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`
  const commands = [`/bin/mkdir -p ${q(INSTALL_DIR)}`]
  for (const name of CLI_PROGRAMS) {
    commands.push(`/bin/ln -sf ${q(path.join(src, name))} ${q(path.join(INSTALL_DIR, name))}`)
  }
  const script = commands.join(' && ')

  // Try unprivileged first. On a machine where Homebrew owns /usr/local/bin the
  // user can already write there, and prompting for a password would be rude.
  try {
    await execFileAsync('/bin/sh', ['-c', script])
  } catch {
    try {
      await runElevated(script)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      if (/User canceled|-128/.test(message)) return { ...base, cancelled: true }
      return { ...base, error: message }
    }
  }

  // Report what is actually on disk, not what we asked for.
  const after = await status()
  return {
    ok: after.installed,
    installed: after.linked,
    installDir: INSTALL_DIR,
    error: after.installed ? undefined : 'Some programs could not be linked.'
  }
}

export async function uninstall(): Promise<InstallResult> {
  const base: InstallResult = { ok: false, installed: [], installDir: INSTALL_DIR }
  if (process.platform !== 'darwin') return { ...base, error: 'macOS only.' }

  const before = await status()
  // Remove only links that point at this bundle. A program someone installed
  // by another route is theirs, and deleting it would be overreach.
  if (!before.linked.length) return { ok: true, installed: [], installDir: INSTALL_DIR }

  const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`
  const script = before.linked
    .map((name) => `/bin/rm -f ${q(path.join(INSTALL_DIR, name))}`)
    .join(' && ')

  try {
    await execFileAsync('/bin/sh', ['-c', script])
  } catch {
    try {
      await runElevated(script)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      if (/User canceled|-128/.test(message)) return { ...base, cancelled: true }
      return { ...base, error: message }
    }
  }

  const after = await status()
  return { ok: after.linked.length === 0, installed: [], installDir: INSTALL_DIR }
}
