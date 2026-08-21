/**
 * Check that installing the command-line programs onto the PATH actually works.
 *
 * Runs the real cliInstaller module inside Electron, against a temporary
 * directory rather than /usr/local/bin (WFES_CLI_INSTALL_DIR). The point that
 * needs proving is not that symlinks get created -- it is that a program
 * invoked THROUGH the link still finds the libraries in the bundle, since the
 * binaries load them via @executable_path/lib.
 *
 *   node scripts/verify-cli-install.mjs
 */
import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { fileURLToPath } from 'url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')
const installDir = mkdtempSync(path.join(tmpdir(), 'wfes-cli-install-'))

// electron-vite bundles the whole main process into a single out/main/index.js,
// so there is no separate cliInstaller.js to require. Bundle the real source on
// its own for the test -- this exercises the shipping code, not a copy of it.
//
// It has to land in out/main: unpackaged, the module locates the binaries
// relative to its own __dirname, so anywhere else would look in the wrong place.
const moduleBundle = path.join(root, 'out/main/cliInstaller.test-bundle.cjs')
const esbuild = await import('esbuild')
await esbuild.build({
  entryPoints: [path.join(root, 'src/main/cliInstaller.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
  outfile: moduleBundle
})

// Driven from inside Electron because cliInstaller imports electron's `app`.
const driver = path.join(installDir, 'driver.cjs')
writeFileSync(
  driver,
  `const { app } = require('electron')
process.on('uncaughtException', (e) => {
  console.log('WFES_RESULT:' + JSON.stringify({ fatal: String(e && e.stack || e) }))
  app.exit(1)
})
const installer = require(${JSON.stringify(moduleBundle)})
app.whenReady().then(async () => {
  const out = {}
  out.before = await installer.status()
  // With the override cleared, this unpackaged test bundle must be refused --
  // that is the guard against linking into a build output directory.
  delete process.env.WFES_CLI_ALLOW_ANY_BUNDLE
  out.guard = await installer.install()
  out.afterGuard = await installer.status()
  process.env.WFES_CLI_ALLOW_ANY_BUNDLE = '1'
  out.install = await installer.install()
  out.afterInstall = await installer.status()
  // Run a program THROUGH the link, while the links still exist. This is the
  // check that matters: the binaries load their libraries via
  // @executable_path/lib, so it proves dyld resolves the link to the bundle.
  // A deliberately bare PATH keeps any other copy on this machine out of it.
  try {
    const stdout = require('child_process').execFileSync(
      require('path').join(process.env.WFES_CLI_INSTALL_DIR, 'wfes_single'),
      ['--absorption', '-N', '50', '-s', '0.01', '-h', '0.5', '-u', '1e-6', '-v', '1e-6', '--json'],
      { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } }
    )
    out.linkedRun = { ok: true, pFix: JSON.parse(stdout).results.P_fix }
  } catch (e) {
    out.linkedRun = { ok: false, error: String(e.message).slice(0, 300) }
  }
  out.uninstall = await installer.uninstall()

  // The branch that actually caused the incident: a PACKAGED bundle sitting
  // outside Applications. The checks above only cover the unpackaged case, so
  // simulate a packaged app at various locations and ask the guard directly.
  delete process.env.WFES_CLI_ALLOW_ANY_BUNDLE
  Object.defineProperty(app, 'isPackaged', { get: () => true, configurable: true })
  const home = process.env.HOME
  out.locations = [
    ['/Applications/WFES3.app', true],
    [home + '/Applications/WFES3.app', true],
    ['/Applications/Science/WFES3.app', true],
    [home + '/Builds/WFES3/mac-arm64/WFES3.app', false],
    ['/Volumes/WFES3 3.0.0-beta.3-arm64/WFES3.app', false],
    [home + '/Downloads/WFES3.app', false],
    ['/Applications-elsewhere/WFES3.app', false]
  ].map(([bundle, shouldAllow]) => {
    Object.defineProperty(process, 'resourcesPath', {
      value: require('path').join(bundle, 'Contents', 'Resources'),
      configurable: true
    })
    const verdict = installer.bundleMayInstall()
    return { bundle, shouldAllow, allowed: verdict.ok, reason: verdict.reason }
  })
  process.env.WFES_CLI_ALLOW_ANY_BUNDLE = '1'
  out.afterUninstall = await installer.status()
  console.log('WFES_RESULT:' + JSON.stringify(out))
  app.exit(0)
})
`
)

let raw = ''
try {
  raw = execFileSync(path.join(root, 'node_modules/.bin/electron'), [driver], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120000,
    env: {
      ...process.env,
      WFES_CLI_INSTALL_DIR: installDir,
      WFES_CLI_ALLOW_ANY_BUNDLE: '1',
      ELECTRON_DISABLE_SANDBOX: '1'
    }
  })
} catch (e) {
  raw = String(e.stdout ?? '') + String(e.stderr ?? '')
}
const line = raw.split('\n').find((l) => l.startsWith('WFES_RESULT:'))
if (!line) {
  rmSync(installDir, { recursive: true, force: true })
  rmSync(moduleBundle, { force: true })
  console.error('no result from driver; output was:\n' + raw)
  process.exit(1)
}
const r = JSON.parse(line.slice('WFES_RESULT:'.length))
if (r.fatal) {
  rmSync(installDir, { recursive: true, force: true })
  rmSync(moduleBundle, { force: true })
  console.error('driver threw:\n' + r.fatal)
  process.exit(1)
}

const checks = []
const check = (name, pass, detail = '') => checks.push({ name, pass, detail })

check('starts uninstalled', r.before.installed === false)

// The guard: a bundle outside Applications must not be able to install.
check('refuses to install from a non-Applications bundle', r.guard.ok === false)
check(
  'refusal explains what to do',
  typeof r.guard.error === 'string' && /development build|Applications folder/.test(r.guard.error),
  r.guard.error ?? '(no reason given)'
)
check(
  'refusal leaves the PATH untouched',
  r.afterGuard.linked.length === 0 && r.afterGuard.foreign.length === 0
)

check('install reports success', r.install.ok === true, r.install.error ?? '')
check(
  'all 11 programs linked',
  r.afterInstall.linked.length === 11,
  `linked ${r.afterInstall.linked.length}`
)
check('status agrees it is installed', r.afterInstall.installed === true)

// The real question: does a linked program still resolve its dylibs?
const run = r.linkedRun ?? { ok: false, error: 'driver reported nothing' }
check(
  'program RUNS through the symlink (dylibs resolve)',
  run.ok === true && Math.abs(run.pFix - 0.01572792506873269) < 1e-15,
  run.ok ? `P_fix=${run.pFix}` : run.error
)

check('uninstall reports success', r.uninstall.ok === true, r.uninstall.error ?? '')
check('all links removed', r.afterUninstall.linked.length === 0)

// Packaged bundle, various locations -- the incident's actual branch.
for (const loc of r.locations ?? []) {
  const where = loc.bundle.replace(process.env.HOME, '~')
  check(
    `${loc.shouldAllow ? 'allows' : 'refuses'} packaged bundle at ${where}`,
    loc.allowed === loc.shouldAllow,
    loc.allowed === loc.shouldAllow ? '' : `got allowed=${loc.allowed}`
  )
}

rmSync(installDir, { recursive: true, force: true })
rmSync(moduleBundle, { force: true })

let failed = 0
for (const c of checks) {
  if (!c.pass) failed++
  console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? '  (' + c.detail + ')' : ''}`)
}
console.log(`\n${checks.length - failed}/${checks.length} checks passed`)
process.exit(failed ? 1 : 0)
