// About-panel harness: every reachable tool must show ITS OWN introduction.
//
// Two views run more than one binary behind a mode control, and both pinned
// AboutContentPanel to a single document, so the second mode explained a tool
// the user was not running. The test therefore depends on the TEXT CHANGING
// when the mode changes -- a check that the panel merely rendered would have
// passed throughout the defect.
//
//   npx electron --remote-debugging-port=9420 out/main/index.js &
//   npm run verify:about
import { readFileSync } from 'fs'
import { join } from 'path'

const ABOUT = join(process.cwd(), '../../about')
const descOf = name => {
  const md = readFileSync(join(ABOUT, name + '.md'), 'utf8')
  return /^## Description\s*\n([\s\S]*?)(?=\n## )/m.exec(md)[1].trim()
}
// Program names are written as `wfes_single` in the source; the renderer emits
// them as <code> text, so the backticks are markup and must come off before the
// expectation is compared against what the panel actually shows.
const plain = md => md.replace(/`/g, '')
const first = name => plain(descOf(name)).split(/(?<=\.)\s/)[0].replace(/\s+/g, ' ').slice(0, 60)

// Compounds are checked against the source with any hard-wrap break removed, so
// the rendered text has to show them intact. Measured behaviour today: the
// renderer joins a soft-wrapped line with a space, EXCEPT after a hyphen, where
// it joins with nothing -- so "Wright-\nFisher" does render as "Wright-Fisher".
// This check exists to catch that behaviour changing, not a defect now present.
const hyphenated = name => [...new Set(
  plain(descOf(name)).replace(/-\n/g, '-').replace(/\s+/g, ' ').match(/\b\w+(?:-\w+)+\b/g) || []
)]

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

const go = async nav => {
  await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(e=>/back|home/i.test(e.innerText||''));if(b)b.click();return 1})()`)
  await wait(700)
  await ev(`(()=>{const a=[...document.querySelectorAll('a')].find(e=>(e.innerText||'').includes(${JSON.stringify(nav)}));if(a)a.click();return 1})()`)
  await wait(1300)
}
// Open the collapsed panel, then read the rendered Description paragraph.
const readAbout = async () => {
  await ev(`(()=>{const h=[...document.querySelectorAll('button,div[role=button]')].find(e=>/^show details$/i.test((e.innerText||'').trim()));if(h)h.click();return 1})()`)
  await wait(800)
  return val(await ev(`(()=>{const t=document.body.innerText.replace(/\\s+/g,' ');return t})()`))
}
const clickLabel = async re => {
  await ev(`(()=>{const l=[...document.querySelectorAll('label,button')].find(e=>${re}.test(e.innerText||''));if(l)l.click();return 1})()`)
  await wait(1400)
}

let fail = 0
const check = (label, text, expectDoc, rejectDocs) => {
  const want = first(expectDoc)
  const ok = text.includes(want)
  const wrong = rejectDocs.filter(d => text.includes(first(d)))
  const split = hyphenated(expectDoc).filter(w => !text.includes(w))
  if (ok && !wrong.length && !split.length) console.log(`  ok    ${label} -> ${expectDoc}`)
  else if (ok && !wrong.length) { fail++; console.log(`  FAIL  ${label}: word broken across the wrap: ${split.join(', ')}`) }
  else { fail++; console.log(`  FAIL  ${label}: expected ${expectDoc}${wrong.length ? `, found ${wrong.join(',')}` : ', not found'}`) }
}

// Eight single-tool views.
const SIMPLE = [
  ['Time-Homogeneous WFES', 'wfes_single'],
  ['General Switching Model', 'wfes_switching'],
  ['Sequential Switching Model', 'wfes_sequential'],
  ['Substitution with Standing Genetic', 'wfes_sweep'],
  ['Stochastic Switching', 'wfafs_stochastic'],
  ['Deterministic Switching', 'wfafs_deterministic'],
  ['Population Projection', 'population_projection']
]
for (const [nav, doc] of SIMPLE) { await go(nav); check(nav, await readAbout(), doc, []) }

// Time to Extinction and Fixation: two modes, two binaries.
await go('Time to Extinction and Fixation')
check('time_dist (default mode)', await readAbout(), 'time_dist', ['time_dist_dual'])
await clickLabel('/including mutation time/i')
check('time_dist (dual mode)', await readAbout(), 'time_dist_dual', ['time_dist'])

// Time to Substitution: three tools behind a mode and a toggle.
await go('Time to Substitution')
check('phase_type (default)', await readAbout(), 'phase_type_dist', ['phase_type_moments', 'time_dist_sgv'])
await clickLabel('/moments/i')
check('phase_type (moments)', await readAbout(), 'phase_type_moments', ['phase_type_dist'])
// SGV mode runs a third binary, time_dist_sgv, from the same view.
await clickLabel('/substitution with sgv/i')
check('phase_type (SGV mode)', await readAbout(), 'time_dist_sgv', ['phase_type_dist', 'phase_type_moments'])

console.log(fail ? `\n  ${fail} panel(s) show the wrong tool` : '\n  every mode shows its own tool')
process.exit(fail ? 1 : 0)
