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
 *   3. every flag in the spawned argv exists in that binary's --help, and
 *      none is on its runtime-refusal list (flags the parser accepts and the
 *      tool then rejects, e.g. wfafs_stochastic --output-R, or
 *      wfes_switching -c under --fixation) -- checked on the argv alone; the
 *      string-equality in (1) is what covers the preview.
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

/**
 * The dual of RUNTIME_REFUSALS: flags each binary's parser still ACCEPTS
 * though its --help no longer advertises them. The canonical-flag-table
 * commit ("Give every WFES short flag exactly one meaning") renamed the
 * advertised spellings (--pop-sizes became -N/--pop-size; wfafs_stochastic's
 * --initial-count became -p/--starting-copies) and kept each old long form
 * as a deliberately hidden alias -- "stays accepted (the GUI emits it) but
 * unadvertised" (args_parser.cpp, at every AliasedValueFlag site) -- which
 * the --help parse above cannot see. AliasedValueFlag binds every spelling
 * to the same option, so an emitted alias cannot be silently dropped.
 * Measured against the built binaries: given the hidden spelling, each bin
 * below parses past the flag and fails on the NEXT missing required
 * argument; given an unknown flag it fails at the flag itself. These two
 * entries cover all four hidden-alias sites the parser declares.
 */
const HIDDEN_ALIASES = [
  { bins: ['wfes_sequential', 'wfes_switching', 'wfafs_stochastic', 'wfafs_deterministic'],
    flag: '--pop-sizes' },
  { bins: ['wfafs_stochastic'], flag: '--initial-count' }
]

function checkFlags(label, bin, cmdTokens) {
  const declared = declaredFlags(bin)
  for (const f of flagsIn(cmdTokens)) {
    if (!declared.has(f) && !HIDDEN_ALIASES.some((r) => r.bins.includes(bin) && r.flag === f)) {
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
// T5c item 2: control -> state assertion.
//
// Every probe above proves the STATE it patches reaches the argv. That is
// not the same claim as "the control the user sees is the one wired to that
// state" -- a deleted drawer row, a relabelled checkbox, or a checkbox that
// reads/writes the WRONG key can all still pass the argv check, because the
// override patches the state directly rather than going through the
// control. assertControlWired closes that gap: it requires a control
// rendered under the expected label, enabled, and showing the toggled
// value -- checked/value, whichever the control kind has.
// ---------------------------------------------------------------------------

/**
 * For a stateProbes probe, the {label, key, target} the rendered control
 * must show after the probe's own overrides are applied. Only the LAST
 * override carrying a `.patch` is used -- the others (if any) are mode
 * selectors like `{ str: 'phase-type-dist', to: 'phase-type-dist-sgv' }`
 * that pick which binary runs, not the control under test.
 */
function controlTargetFromOverrides(overrides) {
  const reversed = [...(overrides ?? [])].reverse()
  const patchOverride = reversed.find((o) => o.patch)
  if (patchOverride) {
    const entries = Object.entries(patchOverride.patch)
    if (entries.length === 0) return null
    const [key, target] = entries[entries.length - 1]
    return { key, target }
  }
  // The single view's write-flag probes (T5c item 2) target a boolean
  // useState initializer directly -- there is no `outputOptions` object to
  // patch a key on -- so the control-under-test carries a `boolNth`/`strNth`
  // override instead of a `patch` one. Same "last one wins, earlier ones are
  // mode selectors" rule as above.
  const nthOverride = reversed.find((o) => o.boolNth !== undefined || o.strNth !== undefined)
  if (nthOverride) return { key: null, target: nthOverride.to }
  return null
}

/**
 * label: the control's rendered label (probe.controlLabel ?? probe.control).
 * target: the value the control should show post-toggle -- a boolean checks
 *   against the control's `checked` (Checkbox/Switch), anything else against
 *   its `value` (Select/SegmentedControl).
 */
function assertControlWired(where, label, target, controls) {
  // T5c item 4: bind by label through a uniqueness assertion, not .find's
  // first-match -- .find would silently pass this check against the WRONG
  // control if a relabel or a copy-paste ever left two controls sharing one
  // label, since the toggled one might not be the one it happens to find
  // first.
  const matches = controls.filter((c) => c.label === label)
  if (matches.length === 0) {
    fail(`${where}: no control labelled ${JSON.stringify(label)} is rendered (deleted row, or relabelled?)`)
    return
  }
  if (matches.length > 1) {
    fail(`${where}: expected exactly one control labelled ${JSON.stringify(label)}, found ${matches.length}`)
    return
  }
  const ctrl = matches[0]
  if (ctrl.disabled) {
    fail(`${where}: control ${JSON.stringify(label)} is rendered disabled, not toggled`)
    return
  }
  const field = typeof target === 'boolean' ? 'checked' : 'value'
  const actual = ctrl[field]
  if (actual !== target) {
    fail(`${where}: control ${JSON.stringify(label)} renders ${field}=${JSON.stringify(actual)}, expected ${JSON.stringify(target)} (bound to the wrong key?)`)
    return
  }
  ok(`${where}: control ${JSON.stringify(label)} renders the toggled state`)
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
  // The stubbed spawn (above) closes with empty stdout, so every probe's own
  // IPC handler fails to parse a JSON result and logs that failure via
  // console.error before returning success:false -- expected here, and
  // reported nowhere the harness reads from, but it drowns the OK/FAIL
  // lines in ~1 line of "Failed to parse JSON output" noise per check.
  // Silenced for the duration of fixture mode only; esbuild's own stderr
  // (a real build failure) goes straight to the inherited fd above and
  // never passes through this.
  const realError = console.error
  console.error = () => {}
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
   *   { strNth: v, occurrence: n, to }    -- the n-th `v`-valued STRING
   *                                          initializer, for a default (e.g.
   *                                          '0') shared by more than one
   *                                          field in the same view
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
        } else if (o.strNth !== undefined && value === o.strNth) {
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
          base: 'absorption/fixed (default)', adds: ['ParU'] },
        // T5c item 3: alpha omitted at its own CLI default is already this
        // state's behaviour (see buildCommandLine's `alphaVal !== 1e-20`
        // gate and buildWfesSingleArgs's matching one) -- a blank field
        // resolves to the same 1e-20 and so must produce the SAME argv as
        // the default state, preview included. Guards against a blank
        // field instead reaching the CLI as the literal string "NaN".
        { name: 'blank alpha', overrides: [{ str: '1e-20', to: '' }] }
      ],
      // T5c item 1: the same silent-model-swap gate as WfesSequentialViewMantine
      // (and, as of this task, WfesSweepViewMantine) -- "Fixed p" with a blank
      // count must refuse to run rather than send --integration-cutoff alone
      // while the UI still says "Fixed p".
      refusalProbes: [
        { name: 'fixed p with blank count refuses to run', overrides: [{ str: '1', to: '' }] },
        // The same defect class through the Sojourn Times scope control,
        // which the gate above never reaches (modeHasStartingState excludes
        // 'fundamental'): --fundamental sends no --integration-cutoff either
        // way, so a blank count under "One starting count" would not carry a
        // stray flag -- it would silently compute the FULL fundamental
        // matrix (all starting states, 2N-1 solves) while the UI still says
        // one count. 'all' is sojournScope's initializer, unique in this
        // view; '1' is startingCopies', as in the probe above.
        { name: 'sojourn single count with blank count refuses to run',
          overrides: [{ str: 'absorption', to: 'fundamental' }, { str: 'all', to: 'single' }, { str: '1', to: '' }] }
      ],
      // T5c item 2 (the Important from this review round): assertControlWired's
      // three-part exists+enabled+checked check runs only for stateProbes --
      // paramsProbes never re-renders after patching, so it cannot show what
      // the CONTROL displays, only that captured params reached argv. All
      // nine write-flag checkboxes below used to be paramsProbes, leaving the
      // mis-binding class (a checkbox reading/writing the wrong key) unguarded
      // on exactly the view CX1b just rewired. boolNth:false targets each
      // one's own `useState(false)` initializer directly, in the order they
      // are declared (occurrence 0 = optionsDrawerOpen, 1 = mutationOnly, so
      // the nine writeX fields start at 2); verified against the source by
      // counting every `useState(false)` call from the top of the component.
      stateProbes: [
        { control: 'Write Q', overrides: [{ boolNth: false, occurrence: 2, to: true }], adds: ['--output-Q'] },
        { control: 'Write R', overrides: [{ boolNth: false, occurrence: 3, to: true }], adds: ['--output-R'] },
        { control: 'Write B', overrides: [{ boolNth: false, occurrence: 4, to: true }], adds: ['--output-B'] },
        { control: 'Write N', overrides: [{ boolNth: false, occurrence: 5, to: true }], adds: ['--output-N'] },
        { control: 'Write N_Ext', overrides: [{ boolNth: false, occurrence: 6, to: true }], adds: ['--output-N-ext'] },
        { control: 'Write N_Fix', overrides: [{ boolNth: false, occurrence: 7, to: true }], adds: ['--output-N-fix'] },
        { control: 'Write I', overrides: [{ boolNth: false, occurrence: 8, to: true }], adds: ['--output-I'] },
        // base: 'equilibrium'/'fundamental' -- these two ALSO need the mode
        // switch (the flag is refused outside its own mode), so the diff is
        // taken against that mode's own argv, not the default state's.
        { control: 'Write E (equilibrium)', controlLabel: 'Write E',
          overrides: [{ str: 'absorption', to: 'equilibrium' }, { boolNth: false, occurrence: 9, to: true }],
          adds: ['--output-E'], base: 'equilibrium' },
        { control: 'Write V (fundamental)', controlLabel: 'Write V',
          overrides: [{ str: 'absorption', to: 'fundamental' }, { boolNth: false, occurrence: 10, to: true }],
          adds: ['--output-V'], base: 'fundamental' }
      ],
      paramsProbes: [
        { control: 'Force', path: 'executionOptions.force', value: true, adds: ['--force'] },
        { control: 'Disable recurrent mutation', path: 'noRecurrentMutation', value: true, adds: ['--no-recurrent-mu'] }
      ],
      // T5b: every checkbox the CX1b mode x flag matrix newly restricts must
      // render disabled with a stated reason in a mode that refuses it. As of
      // T5c item 6 the reason lives in the Checkbox's own `description` prop
      // for these six too (the sibling <Text> is gone, matching Write E/V's
      // pattern above) -- but disabledControls' single shared
      // disabledControlStates render can't exercise six controls that are
      // disabled in mutually exclusive modes (Write E needs a NON-equilibrium
      // mode to be disabled at all, while these six need equilibrium/
      // fixation/establishment/fundamental instead), so this still checks the
      // rendered HTML directly rather than moving to that per-control
      // mechanism. Each substring is quote-free so it survives
      // react-dom/server's text escaping unmodified (see decode() above,
      // needed only for the preview text, not this check).
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
          why: 'Write I must say why it is disabled in Sojourn Times without a single starting count' },
        // T5c/T5b Important 1: canWriteI's --fundamental clause used to check
        // only sojournScope === 'single', so a blank/invalid count under "One
        // starting count" left Write I ENABLED (canWriteI wrongly true) --
        // this state never appears via a NAMED spec.states entry because
        // executeModel's own gate (T5c Important 1b) already refuses to run
        // it, which would make the ordinary states-loop's "no argv spawned"
        // check fail regardless of canWriteI; overrides here render the
        // SAME state inline instead, and this check is decoupled from
        // execution entirely -- it only inspects the static markup canWriteI
        // controls. RED against the pre-fix canWriteI (Write I renders
        // enabled, so this text never appears); GREEN once the fundamental
        // clause also requires validateStartingCopies().
        { state: 'fundamental, single scope, blank count',
          overrides: [{ str: 'absorption', to: 'fundamental' }, { str: 'all', to: 'single' }, { str: '1', to: '' }],
          contains: 'requires a single starting count',
          why: 'Write I must say why it is disabled when Sojourn Times/"One starting count" is left blank (canWriteI must require a SET count)' }
      ],
      // T5c item 7: Write E and Write V now carry their disabled-reason in
      // the Checkbox's own `description` prop (previously a sibling <Text>
      // the shim's control recorder never saw), so -- unlike Write R/B/N/
      // N_Ext/N_Fix/I above, which stay on the htmlExpect/raw-markup check --
      // these two can use the same description-regex check every other
      // view's disabled Force checkbox uses. Both are disabled in the
      // default (absorption/fixed) state, so no disabledControlStates
      // override is needed.
      disabledControls: [
        { label: 'Write E', reason: /requires the Equilibrium model/ },
        { label: 'Write V', reason: /requires the Fundamental model/ }
      ]
    },
    {
      view: 'sweep', bin: 'wfes_sweep', channel: 'wfes:sweep:execute',
      states: [
        { name: 'fixed p (default)' },
        { name: 'integrate over p', overrides: [{ str: 'fixed', to: 'integrate' }],
          base: 'fixed p (default)', removes: ['--starting-copies'] },
        { name: 'file mode (no file chosen)', overrides: [{ str: 'fixed', to: 'file' }] },
        // T5c item 3: alpha is always sent with a fallback default (see
        // buildCommandLine's `numOrUndefined(alpha) ?? 1e-20`, matched by
        // the run's firstFinite(params.alpha, 1e-20) in the IPC handler), so
        // a blank field must produce the SAME argv as the default state --
        // guards against a blank field instead silently dropping --alpha
        // from the argv while the preview still shows it (or vice versa).
        { name: 'blank alpha', overrides: [{ str: '1e-20', to: '' }] }
      ],
      // T5c item 1 (the Important from the T5 review): "Fixed p" with a
      // blank/non-numeric count must refuse to run. Unlike Sequential, this
      // view already defaults to 'fixed', so no initialMode override is
      // needed -- only the count. startingCopies' own default ('0') is
      // shared with both components' selection coefficients (also '0'), so
      // a plain `str` override would blank all three; strNth's occurrence
      // count (0-indexed, in render/useState order) targets startingCopies
      // alone -- it is the FIRST '0'-initialized field in this view.
      refusalProbes: [
        { name: 'fixed p with blank count refuses to run', overrides: [{ strNth: '0', occurrence: 0, to: '' }] }
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
        { name: 'file mode (no file chosen)', overrides: [{ str: 'integrate', to: 'file' }] },
        // T5c item 3: alpha is always sent with a fallback default (see
        // buildCommandLine's `parseFloat(alpha) || 1e-20`, matched by the
        // run's own `parseFloat(alpha) || 1e-20`), so a blank field must
        // produce the SAME argv as the default state.
        { name: 'blank alpha', overrides: [{ str: '1e-20', to: '' }] }
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
        { name: 'file mode (no file chosen)', overrides: [{ str: 'integrate', to: 'file' }] },
        // T5c item 3 (the Important from the T5 review): alpha and the
        // absorption-only integration cutoff both used to reach the CLI as
        // the literal string "NaN" when blank (parseFloat('') with no
        // numOrUndefined discipline -- validateScientificNotation treats ''
        // as valid, so the blank triggered no validation error above and was
        // never caught before execute). Both are now omitted when blank, so
        // this state's argv drops the two flags relative to the default.
        { name: 'blank alpha and integration cutoff',
          overrides: [{ str: '1e-20', to: '' }, { str: '1e-10', to: '' }],
          base: 'absorption (default)', removes: ['--alpha', '--integration-cutoff'] }
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
        { name: 'file mode (no file chosen)', overrides: [{ str: 'fixed', to: 'file' }] },
        // T5c item 3: --alpha (commonParams.a) used to reach the run as a
        // bare flag with an empty value token when blank (the joined
        // "Executing:" log and the preview both collapse an empty argv
        // element into adjacent whitespace, so the naive preview==argv
        // string check alone did not catch it -- see the `removes` check
        // below, which looks at the actual token instead). Omitted when
        // blank now. commonParams.p (--initial-count) had the identical
        // blank-token bug and used to be tested here too, alongside alpha --
        // but T5c item 7 (this review round) now gates execution entirely on
        // a blank p in 'fixed' mode (see the refusalProbes entry below), so
        // blank p no longer reaches argv-building to omit a flag from; it
        // refuses to run before that, a strictly stronger guarantee than "ran
        // and omitted the flag". Testing it here too would now conflict with
        // that gate (the state would refuse to execute, failing this loop's
        // "no argv spawned" check) rather than confirm anything further.
        { name: 'blank alpha', overrides: [{ objKey: 'p', patch: { a: '' } }],
          base: 'fixed count (default)', removes: ['--alpha'] }
      ],
      // T5c item 7: "Fixed p" with a blank count used to run anyway and
      // silently integrate (wfafs_stochastic falls back to its own internal
      // integration-cutoff default when it gets neither --initial-count nor
      // --integration-cutoff) -- the same silent-model-swap gate every other
      // fixed-count view already refuses. This view already defaults to
      // 'fixed' (see 'fixed count (default)' above), so no initialMode
      // override is needed, only the count; objKey/patch, not `str`, because
      // commonParams.p lives on an object initializer, not a bare string one.
      refusalProbes: [
        { name: 'fixed p with blank count refuses to run', overrides: [{ objKey: 'p', patch: { p: '' } }] }
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
        { name: 'file mode (no file chosen)', overrides: [{ str: 'fixed', to: 'file' }] },
        // T5c item 3 (the Important from the T5 review): -p used to reach
        // the run as "-p NaN" (a bare parseInt with no fallback) while the
        // preview showed "-p 0" (parseInt(...) || 0) -- the two disagreed on
        // what a blank count meant. --alpha had the same blank-token bug as
        // wfafs_stochastic's commonParams.a. Both are omitted when blank now.
        { name: 'blank alpha and starting copies',
          overrides: [{ str: '1e-20', to: '' }, { str: '1', to: '' }],
          base: 'fixed count (default)', removes: ['--alpha', '-p'] }
      ],
      stateProbes: [
        { control: 'Library', overrides: [{ objKey: 'force', patch: { library: 'ParU' } }], adds: ['ParU'] }
      ],
      // T5c item 4: a smuggled force must be proven absent from argv, as
      // phase_type_dist already is above -- wfafs_deterministic does not
      // declare --force (that is why the Force checkbox is disabled below),
      // and buildWfafdArgs must silently drop one that arrives anyway rather
      // than passing it through to a binary that exits 1 on it.
      paramsProbes: [
        { control: 'Force is inert by design for wfafs_deterministic', path: 'executionParams.force', value: true, adds: [], removes: [], expectNoChange: true }
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
        { name: 'file mode (no file chosen)', overrides: [{ str: 'integrate', to: 'file' }] },
        // T5c item 3: --alpha used to reach the run as a bare flag with an
        // empty value token when blank (buildTimeDistArgs's guard is
        // `!== undefined`, which a blank STRING passes unchanged). Omitted
        // when blank now.
        { name: 'blank alpha', overrides: [{ str: '1e-20', to: '' }],
          base: 'time_dist (default)', removes: ['--alpha'] }
      ],
      stateProbes: [
        { control: 'Write Q', overrides: [{ objKey: 'writeQ', patch: { writeQ: true } }], adds: ['--output-Q'] },
        { control: 'Write R', overrides: [{ objKey: 'writeQ', patch: { writeR: true } }], adds: ['--output-R'] },
        { control: 'Write P', overrides: [{ objKey: 'writeQ', patch: { writeP: true } }], adds: ['--output-P'] },
        { control: 'Library', overrides: [{ objKey: 'force', patch: { library: 'ParU' } }], adds: ['ParU'] }
      ],
      paramsProbes: [
        { control: 'No recurrent mutation', path: 'noRecurrentMutation', value: true, adds: ['--no-recurrent-mu'] },
        // T5c item 4: a smuggled force must be proven absent from argv, as
        // phase_type_dist already is above -- neither time_dist nor
        // time_dist_dual declares --force (that is why the Force checkbox is
        // disabled below), and buildTimeDistArgs's non-SGV branch must never
        // emit it even if one arrives in executionParams.
        { control: 'Force is inert by design for time_dist/time_dist_dual', path: 'executionParams.force', value: true, adds: [], removes: [], expectNoChange: true }
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
        { name: 'file mode (no file chosen)', overrides: [{ str: 'integrate', to: 'file' }] },
        // T5c item 3: dist mode's alpha (starting_frequency in the
        // wfes:phaseType:execute handler) is always sent with a fallback
        // default (see buildCommandLine's `numOrUndefined(a) ?? 1e-20`,
        // matched by the handler's firstFinite(params.populationParams.a,
        // 1e-20)), so a blank field must produce the SAME argv as the
        // default state -- guards against it instead reaching the CLI as
        // the literal string "NaN".
        { name: 'blank alpha', overrides: [{ str: '1e-20', to: '' }] }
      ],
      // controlLabel: the parenthetical in `control` (dist/moments/SGV)
      // disambiguates this SPEC's own report lines -- the same rendered
      // label ("Write Q", "Force", ...) appears in more than one mode -- but
      // it is not the literal label React renders, so assertControlWired
      // needs the real one. 'Write moments (N)' needs no override: that
      // parenthetical IS the label (see the outputFlags entry in
      // PhaseTypeViewMantine.tsx).
      stateProbes: [
        { control: 'Write Q (dist)', controlLabel: 'Write Q', overrides: [{ objKey: 'writeQ', patch: { writeQ: true } }], adds: ['--output-Q'] },
        { control: 'Write R (dist)', controlLabel: 'Write R', overrides: [{ objKey: 'writeQ', patch: { writeR: true } }], adds: ['--output-R'] },
        { control: 'Write P (dist)', controlLabel: 'Write P', overrides: [{ objKey: 'writeQ', patch: { writeP: true } }], adds: ['--output-P'] },
        { control: 'Write Q (moments)', controlLabel: 'Write Q', props: { initialMomentsOnly: true }, bin: 'phase_type_moments',
          overrides: [{ objKey: 'writeQ', patch: { writeQ: true } }], adds: ['--output-Q'], base: 'moments' },
        { control: 'Write moments (N)', props: { initialMomentsOnly: true }, bin: 'phase_type_moments',
          overrides: [{ objKey: 'writeQ', patch: { writeN: true } }], adds: ['--output-N'], base: 'moments' },
        { control: 'Force (moments)', controlLabel: 'Force', props: { initialMomentsOnly: true }, bin: 'phase_type_moments',
          overrides: [{ objKey: 'force', patch: { force: true } }], adds: ['--force'], base: 'moments' },
        { control: 'Force (SGV)', controlLabel: 'Force', overrides: [{ str: 'phase-type-dist', to: 'phase-type-dist-sgv' }, { objKey: 'force', patch: { force: true } }],
          bin: 'time_dist_sgv', channel: 'wfes:timeDist:execute', adds: ['--force'], base: 'SGV' },
        { control: 'Write P (SGV)', controlLabel: 'Write P', overrides: [{ str: 'phase-type-dist', to: 'phase-type-dist-sgv' }, { objKey: 'writeQ', patch: { writeP: true } }],
          bin: 'time_dist_sgv', channel: 'wfes:timeDist:execute', adds: ['--output-P'], base: 'SGV' },
        { control: 'Library', overrides: [{ objKey: 'force', patch: { library: 'ParU' } }], adds: ['ParU'] }
      ],
      paramsProbes: [
        { control: 'r (recurrent mutation, moments)', controlLabel: 'r', state: 'moments', bin: 'phase_type_moments',
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
          base: 'fixed count (default)', adds: ['-c'], removes: ['-p'] },
        // T5c item 3: -p used to be silently substituted with 1 when blank
        // (`parseInt(startingCopies) || 1`, identically in the preview and
        // in buildProjectionArgs), so both sides agreed on a fabricated
        // model instead of on the truth. Omitted when blank now, like every
        // other view's starting-count field.
        { name: 'blank starting count', overrides: [{ str: '1', to: '' }],
          base: 'fixed count (default)', removes: ['-p'] }
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
      // T5c item 2: the argv assertion above is satisfied by patching the
      // STATE directly (that is what `overrides` does); it says nothing
      // about the CONTROL the user actually sees. Assert one exists under
      // the probe's label, is enabled, and renders the toggled value.
      const ct = controlTargetFromOverrides(probe.overrides)
      if (ct) {
        checks++
        assertControlWired(`${spec.view} probe ${probe.control}`, probe.controlLabel ?? probe.control, ct.target, r.controls)
      }
    }

    for (const probe of spec.paramsProbes ?? []) {
      checks++
      const bin = probe.bin ?? spec.bin
      // T5c item 5: exact match, not startsWith -- a prefix match risks
      // picking the WRONG state when one state name prefixes another (single
      // spec's 'equilibrium' vs 'equilibrium (initialMode stuck on file)'
      // used to rely on 'equilibrium' simply appearing first in the array).
      const stateSpec = probe.state
        ? (spec.states.find((s) => s.name === probe.state) ?? defaultState)
        : defaultState
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
      // T5c item 2 (existence/disabled half): paramsProbes patch the
      // captured params object directly and never re-render, so there is no
      // toggled render here to check checked/value against -- see
      // assertControlWired's use in the stateProbes loop above for the full
      // three-part check. This still catches a deleted drawer row or a
      // relabelled control, using the render already captured in `r` (the
      // named/default state, not toggled).
      checks++
      {
        const label = probe.controlLabel ?? probe.control
        const ctrl = r.controls.find((c) => c.label === label)
        if (!ctrl) fail(`${spec.view} params-probe ${probe.control}: no control labelled ${JSON.stringify(label)} is rendered`)
        else if (ctrl.disabled) fail(`${spec.view} params-probe ${probe.control}: control ${JSON.stringify(label)} is rendered disabled`)
        else ok(`${spec.view} params-probe ${probe.control}: control ${JSON.stringify(label)} is rendered and enabled`)
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
      // Most entries name a state already declared in spec.states (looked up
      // by exact name, as everywhere else). An entry can instead carry its
      // own inline `overrides` -- needed for a state that must NOT also be a
      // spec.states entry, because rendering it there would demand a
      // successful execution (the states-loop requires argvLine); this
      // check only reads static markup and never depends on argv at all.
      const state = exp.overrides ? { name: exp.state ?? 'inline', overrides: exp.overrides } : spec.states.find((s) => s.name === exp.state)
      const r = await drive(spec, state)
      if (r.html.includes(exp.contains)) ok(`${spec.view} [${state.name}]: ${exp.why}`)
      else fail(`${spec.view} [${state.name}]: markup lacks ${JSON.stringify(exp.contains)} (${exp.why})`)
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
  console.error = realError
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
