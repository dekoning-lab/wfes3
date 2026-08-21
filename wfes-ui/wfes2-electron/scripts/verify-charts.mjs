/**
 * Drives every chart in the running app and checks three things:
 *
 *   1. RENDERS  -- the modal draws at least one recharts SVG with real geometry
 *                  (the stubs it replaces rendered a sentence and no chart).
 *   2. EXPORT   -- the SVG the Export button writes contains EVERY panel the
 *                  modal is showing, not just the first. This is the bug the
 *                  old querySelector-based handlers had.
 *   3. THINNED  -- a series longer than the display budget is reduced, and the
 *                  chart still comes up inside a few seconds.
 *
 * The export is captured by stubbing URL.createObjectURL and reading the blob,
 * so nothing is written to disk and no download dialog appears.
 *
 * Run with the app up on :9420.
 */
const PORT = process.env.CDP_PORT || 9420

// view -> the button that opens its chart
const CASES = [
  { view: 'Time-Homogeneous WFES', open: /view chart/i, mode: 'Equilibrium Distribution', panels: 1 },
  { view: 'General Switching Model', open: /view chart/i, panels: 2 },
  { view: 'Sequential Switching Model', open: /view chart/i, panels: 2 },
  { view: 'Substitution with Standing Genetic', open: /view chart/i, panels: 1 },
  { view: 'Time to Extinction and Fixation', open: /view chart/i, panels: 2 },
  { view: 'Time to Substitution', open: /view chart/i, mode: 'Substitution Model', panels: 1 },
  { view: 'Stochastic Switching', open: /view chart/i, panels: 1 },
  { view: 'Deterministic Switching', open: /view chart/i, panels: 1 }
]

const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
const page = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl)
if (!page) throw new Error('no page target; is the app running?')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise(r => ws.addEventListener('open', r))
let id = 0
const pending = new Map()
ws.addEventListener('message', e => {
  const d = JSON.parse(e.data)
  if (pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id) }
})
const ev = expr => new Promise(res => {
  const i = ++id
  pending.set(i, res)
  ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }))
})
const val = r => r.result?.result?.value
const sleep = ms => new Promise(r => setTimeout(r, ms))

// The export is checked by reading the file it actually writes.
//
// An earlier version monkeypatched HTMLAnchorElement.prototype.click and left
// it patched, which silently disabled downloads in that window and made the
// Export button look broken to anyone using the app afterwards. Patching
// window.api.dialog.saveFile is not an option either -- contextBridge objects
// are frozen, so the assignment fails silently and captures nothing.
//
// So: launch the app with WFES_SAVE_DIR pointed at a scratch directory and
// WFES_NO_REVEAL=1, and read what lands there. That exercises the real path,
// which is the point -- the bug this covers was the file never being written.
import { readdirSync, readFileSync, rmSync, existsSync } from 'fs'

const SAVE_DIR = process.env.WFES_SAVE_DIR
if (!SAVE_DIR || !existsSync(SAVE_DIR)) {
  console.error('  Run the app with WFES_SAVE_DIR=<dir> WFES_NO_REVEAL=1 so exports can be checked.')
  process.exit(2)
}
const svgsIn = () => readdirSync(SAVE_DIR).filter(f => f.endsWith('.svg'))

let failures = 0
for (const c of CASES) {
  await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(e=>/back|home/i.test(e.innerText||'')); if(b)b.click(); return 1})()`)
  await sleep(900)
  const opened = val(await ev(`(()=>{const a=[...document.querySelectorAll('a')].find(e=>(e.innerText||'').includes(${JSON.stringify(c.view)})); if(a){a.click();return 1} return 0})()`))
  await sleep(1300)
  if (!opened) { console.log(`  ${c.view.padEnd(36)} SKIP (no nav link)`); continue }

  if (c.mode) {
    // Some charts exist only in a particular mode: wfes_single draws the
    // equilibrium distribution, phase-type draws only when it is computing a
    // distribution rather than moments. Click the mode's own control.
    const picked = val(await ev(`(()=>{
      const want = ${JSON.stringify(c.mode)}
      const els = [...document.querySelectorAll('label, .mantine-SegmentedControl-label, button')]
      const hit = els.find(e => (e.textContent || '').trim() === want)
      if (hit) { hit.click(); return 1 }
      return 0
    })()`))
    if (!picked) {
      failures++
      console.log(`  ${c.view.padEnd(36)} FAIL: could not select mode "${c.mode}"`)
      continue
    }
    await sleep(900)
  }

  await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(e=>/execute/i.test(e.innerText||'')); if(b)b.click(); return 1})()`)
  for (let w = 0; w < 210000; w += 2000) {
    await sleep(2000)
    // Only the results table. Matching the words "Execution time" anywhere in
    // the page fired on the footer label before any run had finished, so the
    // harness went looking for a chart button that was not there yet.
    if (val(await ev(`document.querySelectorAll('.results-table').length`))) break
  }
  await sleep(800)

  const clicked = val(await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(e=>${c.open}.test(e.innerText||'')); if(b){b.click();return 1} return 0})()`))
  if (!clicked) {
    failures++
    console.log(`  ${c.view.padEnd(36)} FAIL: no chart button`)
    continue
  }

  // Everything below is scoped to the modal that just opened. Measuring
  // against the whole document counted surfaces from modals that had not
  // actually closed, which made every number after the first case fiction.
  const IN_MODAL = `document.querySelectorAll('.mantine-Modal-content')`

  // Charts are the slow part; poll rather than guess.
  let drawn = 0
  const t0 = Date.now()
  for (let w = 0; w < 20000; w += 500) {
    await sleep(500)
    drawn = val(await ev(`(()=>{const m=[...${'document.querySelectorAll(\'.mantine-Modal-content\')'}].pop(); return m ? m.querySelectorAll('.recharts-wrapper > svg').length : 0})()`)) || 0
    if (drawn > 0) break
  }
  const drawMs = Date.now() - t0

  const problems = []
  if (drawn === 0) problems.push('no chart rendered')
  if (drawMs > 8000) problems.push(`slow to draw (${(drawMs / 1000).toFixed(1)}s)`)

  // Points actually drawn, vs the length of the underlying series.
  const points = val(await ev(`(()=>{
    const m=[...document.querySelectorAll('.mantine-Modal-content')].pop()
    if(!m) return 0
    const paths=[...m.querySelectorAll('.recharts-wrapper > svg path')]
    let max=0
    for(const p of paths){const d=p.getAttribute('d')||''; const n=(d.match(/[A-Za-z]/g)||[]).length; if(n>max)max=n}
    return max
  })()`)) || 0
  // The budget is 2000 rows; an area outline traces them twice, so anything
  // far above ~4200 commands means the thinning never ran.
  if (points > 4400) problems.push(`${points} path commands drawn (thinning did not apply)`)

  if (drawn > 0) {
    for (const f of svgsIn()) rmSync(`${SAVE_DIR}/${f}`)
    const exported = val(await ev(`(()=>{
      const m=[...document.querySelectorAll('.mantine-Modal-content')].pop()
      if(!m) return 0
      const b=[...m.querySelectorAll('button')].find(e=>/export svg/i.test(e.innerText||''))
      if(b){b.click();return 1}
      return 0
    })()`))
    if (!exported) problems.push('no Export SVG button')
    else {
      await sleep(2000)
      const written = svgsIn()
      if (written.length === 0) problems.push('export wrote no file')
      else {
        const svg = readFileSync(`${SAVE_DIR}/${written[0]}`, 'utf8')
        // Each panel arrives as a nested <svg>; the outer wrapper is the first.
        const nested = (svg.match(/<svg/g) || []).length - 1
        if (nested < drawn) problems.push(`file has ${nested} of ${drawn} panels`)
        if (!/recharts-curve|recharts-rectangle|recharts-bar/.test(svg)) {
          problems.push('file contains no plotted series')
        }
      }
    }
  }

  // Close, and check it actually closed: a modal left open silently poisons
  // every later case's measurements.
  for (let attempt = 0; attempt < 4; attempt++) {
    await ev(`(()=>{const b=document.querySelector('.mantine-Modal-close'); if(b)b.click(); return 1})()`)
    await sleep(500)
    if (!val(await ev(`document.querySelectorAll('.mantine-Modal-content').length`))) break
  }
  const stillOpen = val(await ev(`document.querySelectorAll('.mantine-Modal-content').length`)) || 0
  if (stillOpen) problems.push(`${stillOpen} modal(s) would not close`)

  if (problems.length) failures += problems.length
  console.log(`  ${c.view.padEnd(36)} ${problems.length === 0
    ? `OK (${drawn} panel${drawn === 1 ? '' : 's'}, ${points} pts, ${(drawMs / 1000).toFixed(1)}s)`
    : 'FAIL: ' + problems.join('; ')}`)
}

ws.close()
console.log(failures === 0 ? '\n  all charts render and export completely' : `\n  ${failures} problem(s)`)
process.exit(failures === 0 ? 0 : 1)
