// Population-projection harness.
//
// The point of this view is to produce a file another WFES3 tool will accept as
// --initial. So the test does not stop at "a distribution appeared": it runs
// the projection, checks the numbers against the binomial they must equal, and
// then feeds the saved file back into the CLI. A file the CLI rejects makes the
// whole view pointless, and nothing on screen would show it.
//
//   WFES_SAVE_DIR=/tmp/wfes-exports WFES_NO_REVEAL=1 \
//     npx electron --remote-debugging-port=9420 out/main/index.js &
//   WFES_SAVE_DIR=/tmp/wfes-exports npm run verify:projection
import { readFileSync, readdirSync, existsSync, rmSync, mkdirSync } from 'fs'
import { join } from 'path'
import { execFileSync } from 'child_process'

const SAVE_DIR = process.env.WFES_SAVE_DIR || '/tmp/wfes-exports'
const BIN = join(process.cwd(), '../../wfes-cli/build/bin')

const list = await (await fetch('http://127.0.0.1:9420/json')).json()
const page = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl)
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise(r => ws.addEventListener('open', r))
let id = 0; const pend = new Map()
ws.addEventListener('message', e => { const d = JSON.parse(e.data); if (pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id) } })
const send = (m, p = {}) => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })) })
const ev = x => send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true })
const val = r => r.result?.result?.value
const wait = ms => new Promise(r => setTimeout(r, ms))

let fail = 0
const ck = (name, ok, extra = '') => {
  if (ok) console.log(`  ok    ${name}`)
  else { fail++; console.log(`  FAIL  ${name}${extra ? ' — ' + extra : ''}`) }
}

// Drive the view through its own API rather than typing into NumberInputs,
// whose controlled state does not update from synthetic key events.
const project = async (params) =>
  val(await ev(`(async()=>{
    const r = await window.api.wfes.projection.execute(${JSON.stringify(params)})
    return JSON.stringify(r)
  })()`))

await ev(`(()=>{const a=[...document.querySelectorAll('a')].find(e=>(e.innerText||'').includes('Population Projection'));if(a)a.click();return 1})()`)
await wait(1500)
const shown = val(await ev(`document.body.innerText.replace(/\\s+/g,' ')`))
ck('view reachable from the nav', shown.includes('Projected distribution'))
ck('all three starting modes offered',
   shown.includes('Fixed p') && shown.includes('Integrate over p') && shown.includes('Custom distribution'))

// --- fixed p: must equal Binomial(2*N2, p/(2*N1)) up to the mutation rate ---
const base = {
  sourceSize: 5, targetSize: 10, initialMode: 'fixed', startingCopies: '2',
  selection: '0', dominance: '0.5', backwardMutation: '1e-8', forwardMutation: '1e-8',
  populationScaled: false, alpha: '1e-20'
}
const r1 = JSON.parse(await project(base))
ck('fixed p runs', r1.success === true, r1.error)
const d1 = (r1.distribution || []).map(d => d.probability ?? d.value)
ck('state space is 2*N_target+1', d1.length === 21, `got ${d1.length}`)
ck('normalised', Math.abs(d1.reduce((a, b) => a + b, 0) - 1) < 1e-9)
const comb = (n, k) => { let c = 1; for (let i = 0; i < k; i++) c = c * (n - i) / (i + 1); return c }
const binom = Array.from({ length: 21 }, (_, k) => comb(20, k) * 0.2 ** k * 0.8 ** (20 - k))
const worst = Math.max(...d1.map((x, k) => Math.abs(x - binom[k])))
ck('matches Binomial(20, 0.2)', worst < 1e-6, `worst |diff| ${worst.toExponential(2)}`)

// --- the other two starting modes reach the backend at all ---
const r2 = JSON.parse(await project({ ...base, initialMode: 'integrate', integrationCutoff: '1e-10' }))
ck('integrate over p runs', r2.success === true, r2.error)
ck('integrate gives the target state space', (r2.distribution || []).length === 21)

// --- round trip: every offered format must be accepted by the tools it names ---
// A format whose file the CLI rejects on length is worse than no format: the
// view claims a destination it cannot actually feed. Each is therefore written
// through the real save path and handed to a real CLI.
if (existsSync(SAVE_DIR)) rmSync(SAVE_DIR, { recursive: true, force: true })
mkdirSync(SAVE_DIR, { recursive: true })

const N2 = 5   // small, so a rejected length is obvious rather than slow
await ev(`(()=>{
  const set=(label,val)=>{const el=[...document.querySelectorAll('input')].find(i=>{
    const w=i.closest('.mantine-InputWrapper-root'); return w && w.innerText.startsWith(label)});
    if(el){const p=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
      p.call(el,val); el.dispatchEvent(new Event('input',{bubbles:true}))}}
  set('From (N)','5'); set('To (N)','5');
  return 1})()`)
await wait(900)
await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(e=>/^Execute$/.test((e.innerText||'').trim()));if(b)b.click();return 1})()`)
await wait(2500)

const CASES = [
  { fmt: '0..2N',   rows: 2 * N2 + 1, tool: 'wfafs_deterministic',
    args: path => ['--pop-sizes', `${N2},${N2}`, '--generations', '1,1', '--selection', '0,0', '--dominance', '0.5,0.5',
                   '--backward-mu', '1e-9,1e-9', '--forward-mu', '1e-9,1e-9', '--initial', path, '--json'] },
  { fmt: '1..2N-1', rows: 2 * N2 - 1, tool: 'wfes_single',
    args: path => ['--absorption', '-N', String(N2), '-s', '0', '-h', '0.5',
                   '-u', '1e-9', '-v', '1e-9', '--initial', path, '--json'] },
  { fmt: '0..2N-1', rows: 2 * N2,     tool: 'phase_type_dist',
    args: path => ['-N', String(N2), '-s', '0', '-h', '0.5',
                   '-u', '1e-9', '-v', '1e-9', '--initial', path, '--json'] }
]

for (const c of CASES) {
  const picked = val(await ev(`(()=>{const l=[...document.querySelectorAll('label')].find(e=>(e.innerText||'').trim()===${JSON.stringify(c.fmt)});if(l){l.click();return 1}return 0})()`))
  ck(`format ${c.fmt} selectable`, picked === 1)
  await wait(500)
  const before = existsSync(SAVE_DIR) ? readdirSync(SAVE_DIR) : []
  await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(e=>/Save for --initial/.test(e.innerText||''));if(b)b.click();return 1})()`)
  await wait(1600)
  const after = (existsSync(SAVE_DIR) ? readdirSync(SAVE_DIR) : []).filter(f => !before.includes(f))
  if (!after.length) { ck(`format ${c.fmt} writes a file`, false); continue }
  const path = join(SAVE_DIR, after[0])
  const rows = readFileSync(path, 'utf8').split('\n').filter(l => l.trim() !== '')
  ck(`format ${c.fmt} has ${c.rows} values`, rows.length === c.rows, `got ${rows.length}`)
  ck(`format ${c.fmt} is bare numbers`, rows.every(l => /^[-+0-9.eE]+$/.test(l.trim())))
  const sum = rows.reduce((a, l) => a + parseFloat(l), 0)
  ck(`format ${c.fmt} sums to 1`, Math.abs(sum - 1) < 1e-9, `sum ${sum}`)
  try {
    // maxBuffer: phase_type_dist prints a distribution over up to --max-t time
    // points, which overruns the 1 MB default and throws ENOBUFS. That is not a
    // rejected file, and reading it as one would report a passing tool as broken.
    execFileSync(join(BIN, c.tool), c.args(path),
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 })
    ck(`${c.tool} accepts the ${c.fmt} file`, true)
  } catch (e) {
    ck(`${c.tool} accepts the ${c.fmt} file`, false, String(e.stderr || e).slice(0, 160))
  }
}

console.log(fail ? `\n  ${fail} failure(s)` : '\n  projection correct, and its output is accepted back as --initial')
process.exit(fail ? 1 : 0)
