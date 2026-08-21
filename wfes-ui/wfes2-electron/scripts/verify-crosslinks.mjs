// Cross-link harness: the Substitution Model in wfes_single points at the two
// programs that go beyond its mean, and each link must LAND ON ITS OWN TOOL.
//
// The links are only useful if they open the right tool, and "the right tool"
// is a mode inside a shared view -- exactly the shape that was already wrong
// once in this app, where one view pinned itself to a single tool in every
// mode. So each check reads the About introduction of the view it arrives at:
// that text differs per tool, which makes the assertion depend on the
// destination actually changing, not on navigation merely happening.
//
//   npx electron --remote-debugging-port=9420 out/main/index.js &
//   npm run verify:crosslinks
import { readFileSync } from 'fs'
import { join } from 'path'

const ABOUT = join(process.cwd(), '../../about')
const firstSentence = name => {
  const md = readFileSync(join(ABOUT, name + '.md'), 'utf8')
  const body = /^## Description\s*\n([\s\S]*?)(?=\n## )/m.exec(md)[1].trim().replace(/`/g, '')
  return body.split(/(?<=\.)\s/)[0].replace(/\s+/g, ' ').slice(0, 60)
}

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
const text = async () => val(await ev(`document.body.innerText.replace(/\\s+/g,' ')`))

const goSingle = async () => {
  await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(e=>/back|home/i.test(e.innerText||''));if(b)b.click();return 1})()`)
  await wait(600)
  await ev(`(()=>{const a=[...document.querySelectorAll('a')].find(e=>(e.innerText||'').includes('Time-Homogeneous WFES'));if(a)a.click();return 1})()`)
  await wait(1400)
}
const pickMode = async label => {
  await ev(`(()=>{const l=[...document.querySelectorAll('label')].find(e=>(e.innerText||'').trim()===${JSON.stringify(label)});if(l)l.click();return 1})()`)
  await wait(900)
}
const clickLink = async re => {
  const hit = val(await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(e=>${re}.test(e.innerText||''));if(b){b.click();return 1}return 0})()`))
  await wait(1800)
  return hit === 1
}

let fail = 0
const ck = (name, ok, extra = '') => {
  if (ok) console.log(`  ok    ${name}`)
  else { fail++; console.log(`  FAIL  ${name}${extra ? ' — ' + extra : ''}`) }
}

// Two modes carry a note, pointing at different programs, and five carry none.
// The mode is selected explicitly rather than assumed: this view stays mounted
// when the nav link for the view you are already on is clicked, so its mode
// survives from whatever ran before and "the default is absorption" holds only
// on a fresh app.
await goSingle()
await pickMode('Substitution Model')
const shown = await text()
ck('Substitution Model shows the note', shown.includes('Beyond the mean'))
ck('Substitution Model names the phase_type pair',
   shown.includes('Moments (variance, skewness)') && shown.includes('Full probability distribution'))
ck('Substitution Model does NOT name the time_dist pair',
   !shown.includes('Including the wait for a mutation'))
await pickMode('Allele Age')
ck('no note in Allele Age', !(await text()).includes('Beyond the mean'))
await pickMode('Equilibrium Distribution')
ck('no note in Equilibrium Distribution', !(await text()).includes('Beyond the mean'))
await pickMode('Substitution Model')

// Each link opens its own tool, judged by the destination's own About text.
await goSingle(); await pickMode('Substitution Model')
ck('moments link is clickable', await clickLink('/Moments \\(variance/'))
let landed = await text()
ck('moments link opens phase_type_moments', landed.includes(firstSentence('phase_type_moments')),
   'showing another tool')
ck('moments link did NOT open phase_type_dist', !landed.includes(firstSentence('phase_type_dist')))

await goSingle(); await pickMode('Substitution Model')
ck('distribution link is clickable', await clickLink('/Full probability distribution/'))
landed = await text()
ck('distribution link opens phase_type_dist', landed.includes(firstSentence('phase_type_dist')),
   'showing another tool')
ck('distribution link did NOT open phase_type_moments', !landed.includes(firstSentence('phase_type_moments')))

// Standard Wright-Fisher points at the time_dist pair, by the same rule.
await goSingle(); await pickMode('Standard Wright-Fisher')
const std = await text()
ck('Standard WF shows the note', std.includes('Beyond the mean'))
ck('Standard WF names the time_dist pair',
   std.includes('Full probability distributions') && std.includes('Including the wait for a mutation'))
ck('Standard WF does NOT name the phase_type pair',
   !std.includes('Moments (variance, skewness)'))
ck('time_dist link is clickable', await clickLink('/Full probability distributions/'))
landed = await text()
ck('time_dist link opens time_dist', landed.includes(firstSentence('time_dist')))
ck('time_dist link did NOT open time_dist_dual', !landed.includes(firstSentence('time_dist_dual')))

await goSingle(); await pickMode('Standard Wright-Fisher')
ck('dual link is clickable', await clickLink('/Including the wait for a mutation/'))
landed = await text()
ck('dual link opens time_dist_dual', landed.includes(firstSentence('time_dist_dual')))
ck('dual link did NOT open time_dist', !landed.includes(firstSentence('time_dist')))

console.log(fail ? `\n  ${fail} failure(s)` : '\n  both notes scoped correctly; all four links land on their own tool')
process.exit(fail ? 1 : 0)
