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
    env: { ...process.env, WFES_CLI_INSTALL_DIR: installDir, ELECTRON_DISABLE_SANDBOX: '1' }
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

rmSync(installDir, { recursive: true, force: true })
rmSync(moduleBundle, { force: true })

let failed = 0
for (const c of checks) {
  if (!c.pass) failed++
  console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? '  (' + c.detail + ')' : ''}`)
}
console.log(`\n${checks.length - failed}/${checks.length} checks passed`)
process.exit(failed ? 1 : 0)
