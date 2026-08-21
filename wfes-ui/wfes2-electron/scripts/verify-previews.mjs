/**
 * Preview-truthfulness and control-wiring harness (audit 7.4).
 *
 * Turns the whole "control that silently does nothing" defect class into a
 * test failure. For every view it checks that:
 *
 *   1. the rendered Command Line Preview is STRING-EQUAL to the argv the main
 *      process actually spawns (shell-tokenized; a leading ~/ in the preview
 *      is expanded, since the preview is a shell command and the run resolves
 *      absolute paths);
 *   2. toggling a control changes the spawned argv in exactly the declared
 *      way (or the control is rendered disabled with a reason);
 *   3. every flag in both the preview and the argv exists in the spawned
 *      binary's --help, and none is on that binary's runtime-refusal list
 *      (flags the parser accepts and the tool then rejects, e.g.
 *      wfafs_stochastic --output-R, or wfes_switching -c under --fixation).
 *
 * Two modes:
 *
 *   node scripts/verify-previews.mjs          # headless fixture mode
 *   node scripts/verify-previews.mjs --app    # drive the running app (CDP)
 *
 * FIXTURE MODE needs no running app. It renders the REAL views with
 * react-dom/server (Mantine's Button/Checkbox/etc. wrapped so closures are
 * reachable -- scripts/preview-harness/), invokes each view's own Execute
 * closure to capture the params it sends, feeds those params to the REAL
 * ipcMain handlers from src/main/index.ts (electron stubbed), and reads the
 * argv the REAL builders produce; child_process.spawn is stubbed so no
 * solver actually runs. Nothing is transcribed by hand on either side.
 *
 * View-level probes re-render the view with one control's initial state
 * changed (the same state the control writes) and re-check everything.
 * Handler-level probes patch the captured params object at the exact key the
 * control writes and check the argv alone -- used where a state's initial
 * value is too generic to override unambiguously. Each probe declares the
 * tokens it expects to appear or disappear, so toggling the WRONG state
 * cannot pass by accident.
 *
 * APP MODE is the original end-to-end check: it walks the running app's
 * navigation, reads each view's real preview, clicks Execute, and compares
 * against the command line the main process logs. Start the app with:
 *
 *   npm run build
 *   WFES_SAVE_DIR=/tmp/wfes-exports WFES_NO_REVEAL=1 \
 *     npx electron --remote-debugging-port=9420 out/main/index.js \
 *     > /tmp/wfes3-app.log 2>&1 &
 *   npm run verify:previews:app
 */
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import Module from 'node:module'
import { join, basename, dirname } from 'node:path'
import { readFileSync, existsSync, mkdtempSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const CLI_BUILD = join(REPO, '../../wfes-cli/build')
const BIN_DIR = join(CLI_BUILD, 'bin')
const require_ = createRequire(import.meta.url)

let failures = 0
let checks = 0
// process.stdout directly: fixture mode intercepts console.log to capture
// the main process's "Executing:" lines, and the harness's own reporting
// must not disappear into that interceptor.
const report = (msg) => process.stdout.write(msg + '\n')
const fail = (msg) => { failures++; report(`  FAIL ${msg}`) }
const ok = (msg) => { report(`  OK   ${msg}`) }
const note = (msg) => { report(`       ${msg}`) }

// ---------------------------------------------------------------------------
// Shared: command tokenization and comparison
// ---------------------------------------------------------------------------

/** Shell-style tokenization: double-quoted segments are one token. */
function tokenize(cmd) {
  const toks = cmd.match(/"[^"]*"|\S+/g) || []
  return toks.map((t) => t.replace(/^"|"$/g, ''))
}

/**
 * The preview is a shell command, so a leading ~/ names the same file the
 * run's absolute path does; expand it before comparing.
 */
function expandTilde(tok) {
  return tok.startsWith('~/') ? join(homedir(), tok.slice(2)) : tok
}

/** ["--flag","v",...] from a full command string, binary name dropped. */
function argTokens(cmd) {
  const toks = tokenize(cmd)
  return { bin: basename(toks[0]), args: toks.slice(1).map(expandTilde) }
}

function flagsIn(tokens) {
  return tokens.filter((t) => /^--?[A-Za-z]/.test(t))
}

/** First difference between two token arrays, for readable failures. */
function firstDiff(a, b) {
  const n = Math.max(a.length, b.length)
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return `token ${i}: preview=${JSON.stringify(a[i])} run=${JSON.stringify(b[i])}`
  }
  return ''
}

// ---------------------------------------------------------------------------
// Shared: CLI ground truth (--help, parsed once per binary)
// ---------------------------------------------------------------------------

const helpCache = new Map()
function declaredFlags(bin) {
  if (helpCache.has(bin)) return helpCache.get(bin)
  const exe = join(BIN_DIR, bin)
  if (!existsSync(exe)) throw new Error(`binary not built: ${exe} (build wfes-cli first)`)
  const text = execFileSync(exe, ['--help'], { encoding: 'utf8' })
  const flags = new Set()
  for (const line of text.split('\n')) {
    if (!/^\s+-/.test(line)) continue
    // Option-definition lines: flags live before the 2-space description gap.
    const head = line.trimStart().split(/\s{2,}/)[0]
    for (const m of head.matchAll(/(--?[A-Za-z][A-Za-z0-9-]*)/g)) flags.add(m[1])
  }
  helpCache.set(bin, flags)
  return flags
}

/**
 * Flags each binary's --help declares but the tool then refuses at runtime,
 * measured against the built binaries (see the T5 report). Emitting one of
 * these is as fatal as emitting an unknown flag, so the harness treats them
 * identically. The `when` guard covers mode-conditional refusals.
 */
const RUNTIME_REFUSALS = [
  { bin: 'wfafs_stochastic', flags: ['--output-R', '--output-N-ext', '--output-N-fix', '--output-N-tmo'], note: 'non-absorbing model; the tool errors at runtime' },
  { bin: 'wfes_switching', flags: ['--integration-cutoff', '-c'], when: (args) => args.includes('--fixation'), note: 'refused under --fixation (non-default -c exits 1)' },
  // wfes_single (T5b/CX1b): every --output-* flag and both starting-state
  // parameters are now mode-scoped -- passing one outside its mode is a hard
  // error (nonzero exit, named diagnostic), not the old silent no-op. Each
  // rule below is one row of CX1b's per-mode matrix; WfesSingleViewMantine2's
  // canWrite*/canUseStartingState/canUseInitialFile gates exist to keep the
  // GUI from ever emitting these, so a rule firing here means that gating
  // regressed.
  { bin: 'wfes_single',
    flags: ['--output-R', '--output-N', '--output-N-ext', '--output-N-fix', '--output-B', '--output-I', '--starting-copies', '--initial'],
    when: (args) => args.includes('--equilibrium'),
    note: 'the stationary distribution has no absorbing state and does not depend on a starting state' },
  { bin: 'wfes_single',
    flags: ['--output-R', '--output-N', '--output-N-ext', '--output-N-fix', '--output-B', '--output-I'],
    when: (args) => args.includes('--non-absorbing'),
    note: 'the full transition matrix has no absorbing state' },
  { bin: 'wfes_single', flags: ['--output-N-ext'],
    when: (args) => args.includes('--fixation'),
    note: 'extinction is transient under --fixation, whose only absorbing state is fixation' },
  { bin: 'wfes_single', flags: ['--output-N-ext', '--output-N-fix', '--initial'],
    when: (args) => args.includes('--establishment'),
    note: "establishment's truncated absorbing states are extinction/establishment (not extinction/fixation), and a supplied --initial distribution can never match its truncated state space" },
  { bin: 'wfes_single', flags: ['--output-I'],
    when: (args) => args.includes('--fundamental') && !args.includes('--starting-copies'),
    note: 'with no -p, --fundamental computes the whole matrix and uses no starting distribution' }
]

function checkFlags(label, bin, cmdTokens) {
  const declared = declaredFlags(bin)
  for (const f of flagsIn(cmdTokens)) {
    if (!declared.has(f)) {
      fail(`${label}: flag ${f} does not exist in ${bin} --help`)
      return false
    }
  }
  for (const rule of RUNTIME_REFUSALS) {
    if (rule.bin !== bin) continue
    if (rule.when && !rule.when(cmdTokens)) continue
    for (const f of rule.flags) {
      if (cmdTokens.includes(f)) {
        fail(`${label}: ${bin} refuses ${f} at runtime (${rule.note})`)
        return false
      }
    }
  }
  return true
}

// ---------------------------------------------------------------------------
// Fixture mode
// ---------------------------------------------------------------------------

async function fixtureMode() {
  console.log('verify:previews -- fixture mode (real views + real handlers, spawn stubbed)\n')
  const ESBUILD = join(REPO, 'node_modules/@esbuild/darwin-arm64/bin/esbuild')
  const esbuild = existsSync(ESBUILD) ? ESBUILD : 'npx'
  const esbuildArgs = existsSync(ESBUILD) ? [] : ['esbuild']
  const OUT = mkdtempSync(join(tmpdir(), 'wfes-verify-previews-'))

  const viewBundle = join(OUT, 'views.bundle.cjs')
  execFileSync(esbuild, [...esbuildArgs,
    join(REPO, 'scripts/preview-harness/entry.tsx'),
    '--bundle', '--platform=node', '--format=cjs',
    `--alias:@mantine/core=${join(REPO, 'scripts/preview-harness/mantine-shim.tsx')}`,
    '--external:react', '--external:react-dom', '--external:react-dom/server',
    '--loader:.css=empty',
    `--outfile=${viewBundle}`
  ], { stdio: ['ignore', 'ignore', 'inherit'] })

  const mainBundle = join(OUT, 'main.bundle.cjs')
  execFileSync(esbuild, [...esbuildArgs,
    join(REPO, 'src/main/index.ts'),
    '--bundle', '--platform=node', '--format=cjs',
    '--external:electron', `--outfile=${mainBundle}`
  ], { stdio: ['ignore', 'ignore', 'inherit'] })

  // getExecutablesPath(): packaged -> join(process.resourcesPath, 'bin').
  process.resourcesPath = CLI_BUILD

  // -- stub electron and child_process for the bundled main process ---------
  const handlers = new Map()
  const spawned = []
  const origLoad = Module._load
  const repoRequire = createRequire(join(REPO, 'package.json'))
  Module._load = function (request, parent, isMain) {
    if (/^react(-dom)?(\/|$)/.test(request)) {
      return origLoad.call(this, repoRequire.resolve(request), parent, isMain)
    }
    if (request === 'electron') {
      class BrowserWindow {
        constructor() { this.webContents = { setWindowOpenHandler() {} } }
        on() {}
        show() {}
        focus() {}
        loadURL() {}
        loadFile() {}
        setSize() {}
        center() {}
        static getAllWindows() { return [] }
        static fromWebContents() { return null }
      }
      return {
        app: {
          isPackaged: true,
          // outputPath() falls back to app.getPath('downloads'); returning
          // the real Downloads folder makes the run's absolute paths equal
          // the preview's ~-expanded ones.
          getPath: (name) => (name === 'downloads' ? join(homedir(), 'Downloads') : OUT),
          setName() {},
          setAppUserModelId() {},
          whenReady: () => Promise.resolve(),
          on() {},
          quit() {},
          dock: null
        },
        BrowserWindow,
        Menu: { buildFromTemplate: () => ({}), setApplicationMenu() {} },
        ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
        dialog: {
          showMessageBox: async () => ({ response: 1 }),
          showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
          showSaveDialog: async () => ({ canceled: true })
        },
        shell: { openExternal() {}, showItemInFolder() {} },
        nativeTheme: { on() {} }
      }
    }
    if (request === 'child_process' || request === 'node:child_process') {
      const real = origLoad.call(this, request, parent, isMain)
      return {
        ...real,
        // The argv is logged (and captured below) before spawn is called;
        // the process itself must not run -- the harness would otherwise
        // pay for a real solve per probe. Close immediately with exit 0.
        spawn: () => ({
          stdout: { on() {} },
          stderr: { on() {} },
          on(ev, cb) { if (ev === 'close') setImmediate(() => cb(0, null)) },
          kill() {}
        })
      }
    }
    return origLoad.call(this, request, parent, isMain)
  }

  const realLog = console.log
  console.log = (...a) => {
    const first = a[0]
    if (typeof first === 'string' && first.startsWith('Executing: ')) {
      spawned.push(first.slice('Executing: '.length))
    }
  }
  const say = (...a) => realLog(...a)

  require_(mainBundle)
  await new Promise((r) => setTimeout(r, 50)) // app.whenReady().then(...) queues

  // -- render machinery -----------------------------------------------------
  const React = require_(join(REPO, 'node_modules/react'))
  const realUseState = React.useState
  const views = require_(viewBundle)

  let capturedParams = null
  let capturedChannel = null
  const capture = (channel) => async (params) => {
    capturedParams = params
    capturedChannel = channel
    return { success: false, error: 'fixture: not executed here' }
  }
  globalThis.window = {
    api: {
      wfes: {
        single: { execute: capture('wfes:single:execute') },
        sweep: { execute: capture('wfes:sweep:execute') },
        sequential: { execute: capture('wfes:sequential:execute') },
        switching: { execute: capture('wfes:switching:execute') },
        wfafs: { execute: capture('wfes:wfafs:execute') },
        wfafd: { execute: capture('wfes:wfafd:execute') },
        timeDist: { execute: capture('wfes:timeDist:execute') },
        phaseType: { execute: capture('wfes:phaseType:execute') },
        projection: { execute: capture('wfes:projection:execute') },
        stopExecution: async () => {}
      },
      dialog: {
        openFile: async () => null,
        selectDirectory: async () => null,
        defaultOutputDirectory: async () => join(homedir(), 'Downloads'),
        saveFile: async () => ({ saved: false, path: null })
      },
      about: { loadContent: async () => ({ description: '', overview: '', model: '', computations: '', fullContent: '' }) }
    },
    navigator: globalThis.navigator
  }
  // The capture stub answers success:false, and some views alert() on that.
  globalThis.alert = () => {}

  /**
   * Initial-state overrides, applied through useState interception -- the
   * same values the real controls write, installed as the initial state so a
   * single static render shows the toggled UI. Matchers:
   *   { str: from, to }                   -- a distinctive string initializer
   *   { objKey: k, patch: {...} }         -- an object initializer carrying k
   *   { boolNth: v, occurrence: n, to }   -- the n-th `v`-valued initializer
   */
  const makeUseState = (overrides) => {
    const counters = new Map()
    return (init) => {
      let value = init
      for (const o of overrides) {
        if (o.str !== undefined && value === o.str) value = o.to
        else if (o.objKey && value && typeof value === 'object' && !Array.isArray(value) && o.objKey in value) {
          value = { ...value, ...o.patch }
        } else if (o.boolNth !== undefined && value === o.boolNth) {
          const seen = counters.get(o) ?? 0
          counters.set(o, seen + 1)
          if (seen === o.occurrence) value = o.to
        }
      }
      return realUseState(value)
    }
  }

  const decode = (s) => s
    .replace(/&quot;/g, '"').replace(/&#x27;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

  // The preview text node: a known binary name followed by flags. Short
  // flags too (-p, -c): the WFAF-D and projection previews start with one.
  // The LAST match is taken -- the Command Line Preview papers sit at the
  // bottom of every view, below anything else that could look like a command.
  const PREVIEW_RE = /(?:^|>)((?:wfes_single|wfes_sweep|wfes_sequential|wfes_switching|wfafs_stochastic|wfafs_deterministic|phase_type_dist|phase_type_moments|time_dist_sgv|time_dist_dual|time_dist) -{1,2}[A-Za-z][^<]+)</g

  /** Render one view in one state; click Execute; run the real handler. */
  async function drive(spec, state) {
    React.useState = makeUseState(state.overrides ?? [])
    let html
    try {
      html = views.render(spec.view, state.props ?? {})
    } finally {
      React.useState = realUseState
    }
    const matches = [...html.matchAll(PREVIEW_RE)]
    const preview = matches.length > 0 ? decode(matches.at(-1)[1]).trim() : ''
    const controls = (globalThis.__controls || []).slice()
    const buttons = (globalThis.__buttons || []).slice()
    const exec = buttons.find((b) => /^execute$/i.test(b.label.trim()))
      || buttons.find((b) => /execute|project/i.test(b.label))
    if (!exec) throw new Error(`${spec.view}: no Execute button captured`)
    capturedParams = null
    capturedChannel = null
    const before = spawned.length
    await exec.onClick()
    let argvLine = null
    if (capturedParams !== null) {
      const handler = handlers.get(capturedChannel)
      if (!handler) throw new Error(`no handler for ${capturedChannel}`)
      try {
        await handler({ sender: { send() {} } }, capturedParams)
      } catch {
        /* parsing the stubbed empty stdout fails; the argv is already logged */
      }
      argvLine = spawned[before] ?? null
    }
    return { html, preview, controls, params: capturedParams, argvLine }
  }

  async function runArgvFor(spec, params) {
    const handler = handlers.get(spec.channel)
    const before = spawned.length
    try {
      await handler({ sender: { send() {} } }, params)
    } catch { /* see above */ }
    return spawned[before] ?? null
  }

  const setPath = (obj, path, value) => {
    const keys = path.split('.')
    let cur = obj
    for (const k of keys.slice(0, -1)) cur = cur[k]
    cur[keys.at(-1)] = value
  }

  // -- the per-view specification -------------------------------------------
  //
  // states: full view states -- each is rendered, executed, and checked for
  //   preview==argv string equality plus flag existence.
  // stateProbes: view-level control toggles (initial-state override); checked
  //   like a state AND against the base argv for the declared token changes.
  // paramsProbes: handler-level control toggles for states whose initializers
  //   are too generic to override unambiguously; the captured params object
  //   is patched at the exact key the control writes.
  // disabledControls: controls that must render disabled, with a stated
  //   reason, because the binary cannot honour them.
  const SPECS = [
    {
      view: 'single', bin: 'wfes_single', channel: 'wfes:single:execute',
      states: [
        { name: 'absorption/fixed (default)' },
        { name: 'integrate over p', overrides: [{ str: 'fixed', to: 'integrate' }] },
        { name: 'file mode (no file chosen)', overrides: [{ str: 'fixed', to: 'file' }] },
        { name: 'fixation', overrides: [{ str: 'absorption', to: 'fixation' }] },
        { name: 'fundamental', overrides: [{ str: 'absorption', to: 'fundamental' }] },
        { name: 'equilibrium', overrides: [{ str: 'absorption', to: 'equilibrium' }] },
        { name: 'establishment', overrides: [{ str: 'absorption', to: 'establishment' }] },
        { name: 'allele age', overrides: [{ str: 'absorption', to: 'alleleAge' }] },
        { name: 'non-absorbing', overrides: [{ str: 'absorption', to: 'nonAbsorbing' }] },
        // T5b: 'file' carried over from a previous mode (the harness injects
        // it the same way a stale prior selection would survive a mode
        // switch) must render and build argv without error in a mode whose
        // control no longer offers it -- proving canUseInitialFile's `modes`
        // restriction (InitialStateSelector's SegmentedControl loses the
        // 'file' option) does not desync from the CLI it is modelling.
        // Like every other view's "file mode (no file chosen)" state, no
        // path is ever picked here, so --initial itself never reaches argv
        // in this state regardless of the mode gate -- this does not, on its
        // own, prove --initial gets suppressed once a path IS chosen. That
        // half is covered by code review against CX1b's matrix instead: see
        // canUseInitialFile's definition, used identically by both the argv
        // builder and the preview.
        { name: 'equilibrium (initialMode stuck on file)',
          overrides: [{ str: 'absorption', to: 'equilibrium' }, { str: 'fixed', to: 'file' }] },
        { name: 'establishment (initialMode stuck on file)',
          overrides: [{ str: 'absorption', to: 'establishment' }, { str: 'fixed', to: 'file' }] },
        { name: 'library ParU', overrides: [{ str: 'Accelerate', to: 'ParU' }],
          base: 'absorption/fixed (default)', adds: ['ParU'] }
      ],
      paramsProbes: [
        { control: 'Write Q', path: 'outputOptions.writeQ', value: true, adds: ['--output-Q'] },
        { control: 'Write R', path: 'outputOptions.writeR', value: true, adds: ['--output-R'] },
        { control: 'Write B', path: 'outputOptions.writeB', value: true, adds: ['--output-B'] },
        { control: 'Write N', path: 'outputOptions.writeN', value: true, adds: ['--output-N'] },
        { control: 'Write N_Ext', path: 'outputOptions.writeNExt', value: true, adds: ['--output-N-ext'] },
        { control: 'Write N_Fix', path: 'outputOptions.writeNFix', value: true, adds: ['--output-N-fix'] },
        { control: 'Write I', path: 'outputOptions.writeI', value: true, adds: ['--output-I'] },
        { control: 'Write E (equilibrium)', state: 'equilibrium', path: 'outputOptions.writeE', value: true, adds: ['--output-E'] },
        { control: 'Write V (fundamental)', state: 'fundamental', path: 'outputOptions.writeV', value: true, adds: ['--output-V'] },
        { control: 'Force', path: 'executionOptions.force', value: true, adds: ['--force'] },
        { control: 'Disable recurrent mutation', path: 'noRecurrentMutation', value: true, adds: ['--no-recurrent-mu'] }
      ],
      // T5b: every checkbox the CX1b mode x flag matrix newly restricts must
      // render disabled with a stated reason in a mode that refuses it. The
      // single view puts the reason in a sibling <Text>, not a `description`
      // prop Checkbox forwards to the harness's control recorder, so this
      // checks the rendered HTML directly -- the same technique the
      // wfes_switching spec above uses for its one gated field. Each
      // substring is quote-free so it survives react-dom/server's text
      // escaping unmodified (see decode() above, needed only for the
      // preview text, not this check).
      htmlExpect: [
        { state: 'equilibrium', contains: 'requires a model with an absorbing state',
          why: 'Write R/B/N must say why they are disabled in Equilibrium Distribution' },
        { state: 'equilibrium', contains: 'requires a model with a starting distribution',
          why: 'Write I must say why it is disabled in Equilibrium Distribution' },
        { state: 'fixation', contains: 'requires Standard Wright-Fisher, Sojourn Times, or Allele Age',
          why: 'Write N_Ext must say why it is disabled in the Substitution Model' },
        { state: 'establishment', contains: 'requires Standard Wright-Fisher, Substitution Model, Sojourn Times, or Allele Age',
          why: 'Write N_Fix must say why it is disabled in Establishment Properties' },
        { state: 'fundamental', contains: 'requires a single starting count',
          why: 'Write I must say why it is disabled in Sojourn Times without a single starting count' }
      ]
    },
    {
      view: 'sweep', bin: 'wfes_sweep', channel: 'wfes:sweep:execute',
      states: [
        { name: 'fixed p (default)' },
        { name: 'integrate over p', overrides: [{ str: 'fixed', to: 'integrate' }],
          base: 'fixed p (default)', removes: ['--starting-copies'] },
        { name: 'file mode (no file chosen)', overrides: [{ str: 'fixed', to: 'file' }] }
      ],
      stateProbes: [
        { control: 'Write Q', overrides: [{ objKey: 'writeQ', patch: { writeQ: true } }], adds: ['--output-Q'] },
        { control: 'Write R', overrides: [{ objKey: 'writeR', patch: { writeR: true } }], adds: ['--output-R'] },
        { control: 'Write N', overrides: [{ objKey: 'writeN', patch: { writeN: true } }], adds: ['--output-N'] },
        { control: 'Write B', overrides: [{ objKey: 'writeB', patch: { writeB: true } }], adds: ['--output-B'] },
        { control: 'Force', overrides: [{ objKey: 'force', patch: { force: true } }], adds: ['--force'] },
        { control: 'Library', overrides: [{ objKey: 'library', patch: { library: 'ParU' } }], adds: ['ParU'] }
      ]
    },
    {
      view: 'sequential', bin: 'wfes_sequential', channel: 'wfes:sequential:execute',
      states: [
        { name: 'integrate (default)' },
        { name: 'fixed p', overrides: [{ str: 'integrate', to: 'fixed' }],
          base: 'integrate (default)', adds: ['--starting-copies'], removes: ['--integration-cutoff'] },
        { name: 'file mode (no file chosen)', overrides: [{ str: 'integrate', to: 'file' }] }
      ],
      stateProbes: [
        { control: 'Write Q', overrides: [{ objKey: 'writeQ', patch: { writeQ: true } }], adds: ['--output-Q'] },
        { control: 'Write R', overrides: [{ objKey: 'writeQ', patch: { writeR: true } }], adds: ['--output-R'] },
        { control: 'Write N', overrides: [{ objKey: 'writeQ', patch: { writeN: true } }], adds: ['--output-N'] },
        { control: 'Write B', overrides: [{ objKey: 'writeQ', patch: { writeB: true } }], adds: ['--output-B'] },
        { control: 'Write N_Ext', overrides: [{ objKey: 'writeQ', patch: { writeNExt: true } }], adds: ['--output-N-ext'] },
        { control: 'Write N_Fix', overrides: [{ objKey: 'writeQ', patch: { writeNFix: true } }], adds: ['--output-N-fix'] },
        { control: 'Force', overrides: [{ objKey: 'force', patch: { force: true } }], adds: ['--force'] },
        { control: 'Library', overrides: [{ objKey: 'force', patch: { library: 'ParU' } }], adds: ['ParU'] }
      ],
      refusalProbes: [
        // The T4-review gate: "Fixed p" with a blank count must refuse to
        // execute -- silently integrating while the UI says fixed is the
        // exact defect class this harness exists to keep dead.
        { name: 'fixed p with blank count refuses to run',
          overrides: [{ str: 'integrate', to: 'fixed' }, { str: '1', to: '' }] }
      ]
    },
    {
      view: 'switching', bin: 'wfes_switching', channel: 'wfes:switching:execute',
      states: [
        { name: 'absorption (default)' },
        { name: 'fixation', overrides: [{ str: 'absorption', to: 'fixation' }],
          base: 'absorption (default)', removes: ['--integration-cutoff'] },
        { name: 'file mode (no file chosen)', overrides: [{ str: 'integrate', to: 'file' }] }
      ],
      stateProbes: [
        { control: 'Write Q', overrides: [{ objKey: 'writeQ', patch: { writeQ: true } }], adds: ['--output-Q'] },
        { control: 'Write R', overrides: [{ objKey: 'writeQ', patch: { writeR: true } }], adds: ['--output-R'] },
        { control: 'Write N', overrides: [{ objKey: 'writeQ', patch: { writeN: true } }], adds: ['--output-N'] },
        { control: 'Write B', overrides: [{ objKey: 'writeQ', patch: { writeB: true } }], adds: ['--output-B'] },
        { control: 'Write N_Ext', overrides: [{ objKey: 'writeQ', patch: { writeNExt: true } }], adds: ['--output-N-ext'] },
        { control: 'Write N_Fix', overrides: [{ objKey: 'writeQ', patch: { writeNFix: true } }], adds: ['--output-N-fix'] },
        { control: 'Force', overrides: [{ objKey: 'force', patch: { force: true } }], adds: ['--force'] },
        { control: 'Library', overrides: [{ objKey: 'force', patch: { library: 'ParU' } }], adds: ['ParU'] }
      ],
      htmlExpect: [
        { state: 'fixation', contains: 'not applicable to the Substitution Model',
          why: 'the disabled c field must say why it is disabled' }
      ]
    },
    {
      view: 'wfafs', bin: 'wfafs_stochastic', channel: 'wfes:wfafs:execute',
      states: [
        { name: 'fixed count (default)' },
        { name: 'integrate', overrides: [{ str: 'fixed', to: 'integrate' }],
          base: 'fixed count (default)', adds: ['--integration-cutoff'], removes: ['--initial-count'] },
        { name: 'file mode (no file chosen)', overrides: [{ str: 'fixed', to: 'file' }] }
      ],
      stateProbes: [
        { control: 'Write Q', overrides: [{ objKey: 'writeQ', patch: { writeQ: true } }], adds: ['--output-Q'] },
        { control: 'Write N', overrides: [{ objKey: 'writeQ', patch: { writeN: true } }], adds: ['--output-N'] },
        { control: 'Write B', overrides: [{ objKey: 'writeQ', patch: { writeB: true } }], adds: ['--output-B'] },
        { control: 'No Projection', overrides: [{ objKey: 'noProj', patch: { noProj: true } }], adds: ['--no-project'] },
        { control: 'Force', overrides: [{ objKey: 'force', patch: { force: true } }], adds: ['--force'] },
        { control: 'Library', overrides: [{ objKey: 'force', patch: { library: 'ParU' } }], adds: ['ParU'] }
      ]
    },
    {
      view: 'wfafd', bin: 'wfafs_deterministic', channel: 'wfes:wfafd:execute',
      states: [
        { name: 'fixed count (default)' },
        // buildWfafdArgs emits the short -c (and -p) forms; the preview does too.
        { name: 'integrate', overrides: [{ str: 'fixed', to: 'integrate' }],
          base: 'fixed count (default)', adds: ['-c'], removes: ['-p'] },
        { name: 'file mode (no file chosen)', overrides: [{ str: 'fixed', to: 'file' }] }
      ],
      stateProbes: [
        { control: 'Library', overrides: [{ objKey: 'force', patch: { library: 'ParU' } }], adds: ['ParU'] }
      ],
      disabledControls: [
        { label: 'Force', reason: /does not declare --force/ }
      ]
    },
    {
      view: 'timedist', bin: 'time_dist', channel: 'wfes:timeDist:execute',
      states: [
        { name: 'time_dist (default)' },
        { name: 'time_dist_dual', props: { initialTool: 'time-dist-dual' }, bin: 'time_dist_dual' },
        { name: 'file mode (no file chosen)', overrides: [{ str: 'integrate', to: 'file' }] }
      ],
      stateProbes: [
        { control: 'Write Q', overrides: [{ objKey: 'writeQ', patch: { writeQ: true } }], adds: ['--output-Q'] },
        { control: 'Write R', overrides: [{ objKey: 'writeQ', patch: { writeR: true } }], adds: ['--output-R'] },
        { control: 'Write P', overrides: [{ objKey: 'writeQ', patch: { writeP: true } }], adds: ['--output-P'] },
        { control: 'Library', overrides: [{ objKey: 'force', patch: { library: 'ParU' } }], adds: ['ParU'] }
      ],
      paramsProbes: [
        { control: 'No recurrent mutation', path: 'noRecurrentMutation', value: true, adds: ['--no-recurrent-mu'] }
      ],
      disabledControls: [
        { label: 'Force', reason: /time_dist and time_dist_dual do not declare --force/ }
      ]
    },
    {
      view: 'phasetype', bin: 'phase_type_dist', channel: 'wfes:phaseType:execute',
      states: [
        { name: 'distribution (default)' },
        { name: 'moments', props: { initialMomentsOnly: true }, bin: 'phase_type_moments' },
        { name: 'SGV', overrides: [{ str: 'phase-type-dist', to: 'phase-type-dist-sgv' }],
          bin: 'time_dist_sgv', channel: 'wfes:timeDist:execute' },
        { name: 'file mode (no file chosen)', overrides: [{ str: 'integrate', to: 'file' }] }
      ],
      stateProbes: [
        { control: 'Write Q (dist)', overrides: [{ objKey: 'writeQ', patch: { writeQ: true } }], adds: ['--output-Q'] },
        { control: 'Write R (dist)', overrides: [{ objKey: 'writeQ', patch: { writeR: true } }], adds: ['--output-R'] },
        { control: 'Write P (dist)', overrides: [{ objKey: 'writeQ', patch: { writeP: true } }], adds: ['--output-P'] },
        { control: 'Write Q (moments)', props: { initialMomentsOnly: true }, bin: 'phase_type_moments',
          overrides: [{ objKey: 'writeQ', patch: { writeQ: true } }], adds: ['--output-Q'], base: 'moments' },
        { control: 'Write moments (N)', props: { initialMomentsOnly: true }, bin: 'phase_type_moments',
          overrides: [{ objKey: 'writeQ', patch: { writeN: true } }], adds: ['--output-N'], base: 'moments' },
        { control: 'Force (moments)', props: { initialMomentsOnly: true }, bin: 'phase_type_moments',
          overrides: [{ objKey: 'force', patch: { force: true } }], adds: ['--force'], base: 'moments' },
        { control: 'Force (SGV)', overrides: [{ str: 'phase-type-dist', to: 'phase-type-dist-sgv' }, { objKey: 'force', patch: { force: true } }],
          bin: 'time_dist_sgv', channel: 'wfes:timeDist:execute', adds: ['--force'], base: 'SGV' },
        { control: 'Write P (SGV)', overrides: [{ str: 'phase-type-dist', to: 'phase-type-dist-sgv' }, { objKey: 'writeQ', patch: { writeP: true } }],
          bin: 'time_dist_sgv', channel: 'wfes:timeDist:execute', adds: ['--output-P'], base: 'SGV' },
        { control: 'Library', overrides: [{ objKey: 'force', patch: { library: 'ParU' } }], adds: ['ParU'] }
      ],
      paramsProbes: [
        { control: 'r (recurrent mutation, moments)', state: 'moments', bin: 'phase_type_moments',
          path: 'mutationParams.r', value: false, adds: ['--no-recurrent-mu'] },
        // In dist mode Force is disabled AND, defensively, the builder must
        // drop a force that arrives anyway: phase_type_dist exits 1 on it.
        { control: 'Force is inert by design in dist mode', path: 'executionParams.force', value: true, adds: [], removes: [], expectNoChange: true }
      ],
      disabledControlStates: [{ name: 'dist', props: {} }],
      disabledControls: [
        { label: 'Force', reason: /phase_type_dist does not declare --force/ }
      ]
    },
    {
      view: 'projection', bin: 'wfafs_deterministic', channel: 'wfes:projection:execute',
      states: [
        { name: 'fixed count (default)' },
        { name: 'integrate', overrides: [{ str: 'fixed', to: 'integrate' }],
          base: 'fixed count (default)', adds: ['-c'], removes: ['-p'] }
      ]
    }
  ]

  for (const spec of SPECS) {
    say(`\n== ${spec.view}`)
    const baseArgv = new Map()

    for (const state of spec.states) {
      checks++
      const bin = state.bin ?? spec.bin
      const r = await drive(spec, state)
      if (!r.argvLine) { fail(`${spec.view} [${state.name}]: no argv spawned`); continue }
      const run = argTokens(r.argvLine)
      baseArgv.set(state.name, run)
      if (!r.preview) { fail(`${spec.view} [${state.name}]: no Command Line Preview found in markup`); continue }
      const prev = argTokens(r.preview)
      if (prev.bin !== run.bin) {
        fail(`${spec.view} [${state.name}]: preview binary ${prev.bin} != spawned ${run.bin}`)
      } else if (run.bin !== bin) {
        fail(`${spec.view} [${state.name}]: spawned ${run.bin}, expected ${bin}`)
      } else if (prev.args.join(' ') !== run.args.join(' ')) {
        fail(`${spec.view} [${state.name}]: preview != argv -- ${firstDiff(prev.args, run.args)}`)
        note(`preview: ${prev.bin} ${prev.args.join(' ')}`)
        note(`argv   : ${run.bin} ${run.args.join(' ')}`)
      } else if (checkFlags(`${spec.view} [${state.name}]`, bin, run.args)) {
        ok(`${spec.view} [${state.name}]: preview == argv (string-equal), all flags real`)
      }
      // Declared diffs vs a base state, when the spec names one.
      if (state.base && baseArgv.has(state.base)) {
        const b = baseArgv.get(state.base).args
        for (const t of state.adds ?? []) {
          checks++
          if (run.args.includes(t) && !b.includes(t)) ok(`${spec.view} [${state.name}]: adds ${t}`)
          else fail(`${spec.view} [${state.name}]: expected to add ${t}`)
        }
        for (const t of state.removes ?? []) {
          checks++
          if (!run.args.includes(t) && b.includes(t)) ok(`${spec.view} [${state.name}]: removes ${t}`)
          else fail(`${spec.view} [${state.name}]: expected to remove ${t}`)
        }
      }
    }

    const defaultState = spec.states[0]
    const defaultArgv = baseArgv.get(defaultState.name)

    for (const probe of spec.stateProbes ?? []) {
      checks++
      const bin = probe.bin ?? spec.bin
      const state = { name: `probe: ${probe.control}`, overrides: probe.overrides, props: probe.props }
      const r = await drive({ ...spec, channel: probe.channel ?? spec.channel }, state)
      if (!r.argvLine) { fail(`${spec.view} probe ${probe.control}: no argv spawned`); continue }
      const run = argTokens(r.argvLine)
      const base = probe.base ? baseArgv.get(probe.base) : defaultArgv
      const added = run.args.filter((t) => !base.args.includes(t))
      const missing = (probe.adds ?? []).filter((t) => !added.includes(t))
      let good = missing.length === 0
      if (!good) fail(`${spec.view} probe ${probe.control}: argv did not gain ${missing.join(' ')}`)
      // The toggled state must ALSO keep the preview truthful.
      const prev = argTokens(r.preview || 'x')
      if (good && (r.preview === '' || prev.args.join(' ') !== run.args.join(' '))) {
        good = false
        fail(`${spec.view} probe ${probe.control}: preview != argv in toggled state -- ${firstDiff(prev.args, run.args)}`)
      }
      if (good && checkFlags(`${spec.view} probe ${probe.control}`, bin, run.args)) {
        ok(`${spec.view} probe ${probe.control}: control reaches argv (${(probe.adds ?? []).join(' ')})`)
      }
    }

    for (const probe of spec.paramsProbes ?? []) {
      checks++
      const bin = probe.bin ?? spec.bin
      const stateName = probe.state
        ? spec.states.find((s) => s.name.startsWith(probe.state))?.name ?? defaultState.name
        : defaultState.name
      const stateSpec = spec.states.find((s) => s.name === stateName) ?? defaultState
      const r = await drive(spec, stateSpec)
      if (!r.params) { fail(`${spec.view} params-probe ${probe.control}: no params captured`); continue }
      const base = argTokens(r.argvLine)
      const patched = structuredClone(r.params)
      setPath(patched, probe.path, probe.value)
      const line = await runArgvFor({ channel: capturedChannel }, patched)
      if (!line) { fail(`${spec.view} params-probe ${probe.control}: no argv spawned`); continue }
      const run = argTokens(line)
      if (probe.expectNoChange) {
        if (run.args.join(' ') === base.args.join(' ')) {
          ok(`${spec.view} params-probe ${probe.control}: argv unchanged, as designed`)
        } else {
          fail(`${spec.view} params-probe ${probe.control}: argv changed but must not -- ${firstDiff(base.args, run.args)}`)
        }
        continue
      }
      const added = run.args.filter((t) => !base.args.includes(t))
      const missing = (probe.adds ?? []).filter((t) => !added.includes(t))
      if (missing.length > 0) {
        fail(`${spec.view} params-probe ${probe.control}: argv did not gain ${missing.join(' ')}`)
      } else if (checkFlags(`${spec.view} params-probe ${probe.control}`, bin, run.args)) {
        ok(`${spec.view} params-probe ${probe.control}: key reaches argv (${(probe.adds ?? []).join(' ')})`)
      }
    }

    for (const probe of spec.refusalProbes ?? []) {
      checks++
      const before = spawned.length
      const r = await drive(spec, { name: probe.name, overrides: probe.overrides })
      if (r.params === null && spawned.length === before) {
        ok(`${spec.view} refusal: ${probe.name}`)
      } else {
        fail(`${spec.view} refusal: ${probe.name} -- the view executed anyway`)
      }
    }

    for (const exp of spec.htmlExpect ?? []) {
      checks++
      const state = spec.states.find((s) => s.name === exp.state)
      const r = await drive(spec, state)
      if (r.html.includes(exp.contains)) ok(`${spec.view} [${exp.state}]: ${exp.why}`)
      else fail(`${spec.view} [${exp.state}]: markup lacks ${JSON.stringify(exp.contains)} (${exp.why})`)
    }

    for (const dc of spec.disabledControls ?? []) {
      checks++
      const stateSpec = (spec.disabledControlStates ?? [{}])[0]
      const r = await drive(spec, { name: 'disabled-control check', props: stateSpec.props })
      const hit = r.controls.find((c) => c.label === dc.label && c.disabled)
      if (!hit) {
        fail(`${spec.view}: control "${dc.label}" is not rendered disabled`)
      } else if (!dc.reason.test(hit.description ?? '')) {
        fail(`${spec.view}: disabled "${dc.label}" lacks its reason (got: ${JSON.stringify(hit.description)})`)
      } else {
        ok(`${spec.view}: "${dc.label}" disabled with reason`)
      }
    }
  }

  console.log = realLog
  say(`\n${checks} checks, ${failures} failure(s)`)
  process.exit(failures === 0 ? 0 : 1)
}

// ---------------------------------------------------------------------------
// App mode (CDP against the running app)
// ---------------------------------------------------------------------------

async function appMode() {
  console.log('verify:previews -- app mode (CDP on 127.0.0.1:9420)\n')
  let list
  try {
    list = await (await fetch('http://127.0.0.1:9420/json')).json()
  } catch {
    console.error('The app is not reachable on 127.0.0.1:9420. Start it with:')
    console.error('  npm run build')
    console.error('  WFES_SAVE_DIR=/tmp/wfes-exports WFES_NO_REVEAL=1 \\')
    console.error('    npx electron --remote-debugging-port=9420 out/main/index.js > /tmp/wfes3-app.log 2>&1 &')
    process.exit(2)
  }
  const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((r) => ws.addEventListener('open', r))
  let id = 0
  const pend = new Map()
  ws.addEventListener('message', (e) => {
    const d = JSON.parse(e.data)
    if (pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id) }
  })
  const send = (m, p = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })) })
  const ev = (x) => send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true })
  const val = (r) => r.result?.result?.value

  // File-driven --initial runs are exercised by verify:initial; here every
  // view is visited in its default mode (plus the extra modes below) and the
  // live preview is held to string equality with the spawned command.
  const views = [
    'Time-Homogeneous WFES', 'General Switching Model', 'Sequential Switching Model',
    'Substitution with Standing Genetic', 'Time to Extinction and Fixation',
    'Time to Substitution', 'Stochastic Switching', 'Deterministic Switching',
    'Population Projection'
  ]
  // Some modes build a different command line from their view's default; each
  // entry is a label to click after arriving at the view.
  const EXTRA_MODES = { 'Time-Homogeneous WFES': ['Sojourn Times', 'One starting count'] }

  for (const nav of views) {
    await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(e=>/back|home/i.test(e.innerText||'')); if(b)b.click(); return 1})()`)
    await new Promise((r) => setTimeout(r, 900))
    const hit = val(await ev(`(()=>{const b=[...document.querySelectorAll('a')].find(e=>(e.innerText||'').includes(${JSON.stringify(nav)})); if(b){b.click();return 1} return 0})()`))
    await new Promise((r) => setTimeout(r, 1400))
    for (const label of (EXTRA_MODES[nav] || [])) {
      await ev(`(()=>{const l=[...document.querySelectorAll('label')].find(e=>(e.innerText||'').trim()===${JSON.stringify(label)});if(l)l.click();return 1})()`)
      await new Promise((r) => setTimeout(r, 900))
    }
    const preview = val(await ev(`(()=>{
      const els=[...document.querySelectorAll('h6,div,span')].filter(e=>e.childElementCount===0&&e.textContent.trim()==='Command Line Preview');
      for(const t of els){
        const paper=t.closest('.mantine-Paper-root')||t.parentElement?.parentElement;
        const cand=paper?[...paper.querySelectorAll('*')].filter(e=>e.childElementCount===0&&/^(wfes_|time_dist|phase_type_|wfafs_)/.test(e.textContent.trim())):[];
        if(cand.length) return cand[0].textContent.trim();
      }
      return '';
    })()`))
    const before = (readFileSync('/tmp/wfes3-app.log', 'utf8').match(/Executing: [^\n]*/g) || []).length
    await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(e=>/execute/i.test(e.innerText||'')); if(b)b.click(); return 1})()`)
    await new Promise((r) => setTimeout(r, 15000))
    const lines = readFileSync('/tmp/wfes3-app.log', 'utf8').match(/Executing: [^\n]*/g) || []
    checks++
    if (!hit || !preview || lines.length <= before) {
      console.log(`  ${nav.padEnd(36)} SKIP (hit=${hit} preview=${!!preview} newRuns=${lines.length - before})`)
      failures++
      continue
    }
    const spawnedLine = lines[before].replace(/^Executing: /, '')
    const P = argTokens(preview)
    const S = argTokens(spawnedLine)
    const problems = []
    if (P.bin !== S.bin) problems.push(`binary ${P.bin} vs ${S.bin}`)
    else if (P.args.join(' ') !== S.args.join(' ')) problems.push(firstDiff(P.args, S.args))
    if (problems.length === 0 && !checkFlags(nav, S.bin, S.args)) problems.push('flag check failed (see above)')
    if (problems.length === 0) console.log(`  ${nav.padEnd(36)} MATCH (string-equal)`)
    else { failures++; console.log(`  ${nav.padEnd(36)} DIFF: ${problems.join('; ')}`) }
  }
  ws.close()
  console.log(`\n${checks} checks, ${failures} failure(s)`)
  process.exit(failures === 0 ? 0 : 1)
}

if (process.argv.includes('--app')) await appMode()
else await fixtureMode()
