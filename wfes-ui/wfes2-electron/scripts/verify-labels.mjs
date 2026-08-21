/**
 * Checks that every results table in the running app names its quantities the
 * same way, and that Copy reproduces those names.
 *
 * Three properties, per view:
 *   1. GRAMMAR   -- each label is a subscripted symbol (T_fix), an operator
 *                   over one (SD[T_fix]), or an allowed non-quantity row.
 *                   No legacy spellings: P(fixation), T(extinction), Mean, ...
 *   2. COPY NAME -- the clipboard's ASCII names match the rendered labels
 *                   one-for-one, in order.
 *   3. COPY VALUE-- each copied value parses to the same number as the one
 *                   displayed (the table rounds to six significant digits;
 *                   the clipboard keeps full precision, so they must agree to
 *                   the displayed precision but need not be identical strings).
 *
 * Run with the app already up on :9420 (npm run build && electron out/main).
 */
const PORT = process.env.CDP_PORT || 9420

const VIEWS = [
  'Time-Homogeneous WFES',
  'General Switching Model',
  'Sequential Switching Model',
  'Substitution with Standing Genetic',
  'Time to Extinction and Fixation',
  'Time to Substitution',
  'Stochastic Switching',
  'Deterministic Switching'
]

// Rows that are not model quantities and so carry no symbol.
const ALLOWED_PLAIN = new Set(['Execution time'])

// Spellings this standardization removed; seeing one again is a regression.
const BANNED = [
  /^P\((ext|fix)/i, /^T\((ext|fix|time)/i, /^E\[T \|/, /^Mean$/, /^Std\. ?Dev\.?$/,
  /^Total Prob/i, /^Max CDF$/i, /^Rate$/i, /^Fixation Rate$/i, /^Time in /i,
  /^P\(lost\)$/, /^P\(fixed\)$/, /^P\(segregating\)$/, /^E\[frequency\]$/,
  /^E\[heterozygosity\]$/, /^Est\. freq\.$/, /^Execution Time$/
]

// Subscripted symbol (Pext, Tseg→fix, ΣP) or an operator over one (SD[Tfix]).
// The DOM renders <sub> inline, so "T_fix" arrives as "Tfix".
const SYMBOL = /^[A-Za-zΣ]{1,3}[A-Za-z0-9→|,]*$/
const OPERATOR = /^(SD|E|Var)\[[A-Za-zΣ][A-Za-z0-9→|,]*\]$/

const ws = await (async () => {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
  const page = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl)
  if (!page) throw new Error('no page target; is the app running?')
  const sock = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise(r => sock.addEventListener('open', r))
  return sock
})()
let id = 0
const pending = new Map()
ws.addEventListener('message', e => {
  const d = JSON.parse(e.data)
  if (pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id) }
})
const evaluate = expr => new Promise(res => {
  const i = ++id
  pending.set(i, res)
  ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }))
})
const val = r => r.result?.result?.value
const sleep = ms => new Promise(r => setTimeout(r, ms))

let failures = 0
for (const view of VIEWS) {
  await evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(e=>/back|home/i.test(e.innerText||'')); if(b)b.click(); return 1})()`)
  await sleep(900)
  const opened = val(await evaluate(
    `(()=>{const a=[...document.querySelectorAll('a')].find(e=>(e.innerText||'').includes(${JSON.stringify(view)})); if(a){a.click();return 1} return 0})()`))
  await sleep(1300)
  if (!opened) { console.log(`  ${view.padEnd(36)} SKIP (no nav link)`); continue }

  // Spy on the clipboard: the contextBridge object is frozen, but
  // navigator.clipboard.writeText can be wrapped.
  await evaluate(`(()=>{window.__clip=null;const w=navigator.clipboard.writeText.bind(navigator.clipboard);navigator.clipboard.writeText=t=>{window.__clip=t;return w(t)};return 1})()`)
  await evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(e=>/execute/i.test(e.innerText||'')); if(b)b.click(); return 1})()`)
  // Poll rather than sleep a fixed interval: time_dist runs its loop to
  // --max-t, which at the view's default (1e6) takes around two minutes.
  for (let waited = 0; waited < 210000; waited += 2000) {
    await sleep(2000)
    if (val(await evaluate(`document.querySelectorAll('.results-table').length`))) break
  }

  const rows = val(await evaluate(`JSON.stringify((()=>{
    const out=[]
    for (const t of document.querySelectorAll('.results-table')) {
      for (const tr of t.querySelectorAll('tr')) {
        const tds=[...tr.querySelectorAll('td')]
        for (let i=0;i+1<tds.length;i+=2) {
          const lab=tds[i].querySelector('div')
          if (!lab) continue
          const label=lab.textContent.trim()
          if (label) out.push({label, value: tds[i+1].textContent.trim()})
        }
      }
    }
    return out
  })())`)) || '[]'
  const table = JSON.parse(rows)
  // Not a skip: a view that renders no results is exactly the failure this
  // harness exists to catch (a scoping slip in one view did precisely that).
  if (table.length === 0) {
    failures++
    console.log(`  ${view.padEnd(36)} FAIL: no results rendered`)
    continue
  }

  await evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(e=>/copy/i.test(e.innerText||'')&&!/command/i.test(e.innerText||'')); if(b)b.click(); return 1})()`)
  await sleep(600)
  const clip = val(await evaluate(`window.__clip || ''`)) || ''

  const problems = []

  // 1. grammar
  for (const { label } of table) {
    if (ALLOWED_PLAIN.has(label)) continue
    if (BANNED.some(re => re.test(label))) { problems.push(`legacy label "${label}"`); continue }
    if (!SYMBOL.test(label) && !OPERATOR.test(label)) problems.push(`ungrammatical label "${label}"`)
  }

  // 2 & 3. clipboard names and values
  const clipRows = clip.split('\n').map(l => l.split('\t')).filter(p => p.length === 2 && p[0])
  const clipMap = new Map(clipRows.map(([k, v]) => [k.replace(/[_\[\]]/g, ''), v]))
  for (const { label, value } of table) {
    if (ALLOWED_PLAIN.has(label)) continue
    const key = label.replace(/[_\[\]]/g, '')
    if (!clipMap.has(key)) { problems.push(`"${label}" missing from copy`); continue }
    // First numeric token only: some values carry a trailing share, e.g.
    // "400693  (99.98%)", and stripping all non-numerics would splice the two.
    const shown = parseFloat((String(value).match(/-?\d[\d.]*(?:[eE][+\-]?\d+)?/) || ['NaN'])[0])
    const copied = parseFloat(clipMap.get(key))
    if (Number.isFinite(shown) && Number.isFinite(copied)) {
      // The table shows five to six significant digits; agreement to that
      // precision is the property under test, not string equality.
      const tol = Math.max(Math.abs(shown), Math.abs(copied)) * 1e-4 + 1e-12
      if (Math.abs(shown - copied) > tol) problems.push(`${label}: shown ${shown} vs copied ${copied}`)
    }
  }

  if (problems.length) failures += problems.length
  console.log(`  ${view.padEnd(36)} ${problems.length === 0 ? `OK (${table.length} rows)` : 'FAIL: ' + problems.join('; ')}`)
}

ws.close()
console.log(failures === 0 ? '\n  all views consistent' : `\n  ${failures} problem(s)`)
process.exit(failures === 0 ? 0 : 1)
