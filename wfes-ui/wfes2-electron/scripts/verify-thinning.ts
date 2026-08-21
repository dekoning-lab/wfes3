/**
 * Checks the display thinning, which is the one piece of the charting work that
 * makes a numerical claim: that what you see is a subset of what the solver
 * produced, with the extremes still in it.
 *
 * Run: npm run verify:thinning
 */
import { thinSeries, thinningNote } from '../src/renderer/utils/thinSeries.ts'

let pass = 0
let fail = 0
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { pass++; console.log(`  OK   ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' -- ' + detail : ''}`) }
}

type Row = { t: number; p: number; q: number }
const series = (n: number, f: (i: number) => number): Row[] =>
  Array.from({ length: n }, (_, i) => ({ t: i, p: f(i), q: 1 - f(i) }))

// --- short series are returned untouched --------------------------------
const short = series(50, i => i)
check('short series returned as-is', thinSeries(short, ['p'], 2000) === short)

// --- the budget is respected --------------------------------------------
const long = series(500_000, i => Math.sin(i / 1000))
const thinned = thinSeries(long, ['p', 'q'], 2000)
check('stays within budget', thinned.length <= 2000, `got ${thinned.length}`)
check('actually reduced', thinned.length < long.length / 100, `got ${thinned.length}`)

// --- every returned row is a real row, in order -------------------------
const realRows = thinned.every(r => long[r.t] === r)
check('returns solver rows, not synthesized ones', realRows)
check('x order preserved', thinned.every((r, i) => i === 0 || r.t > thinned[i - 1].t))
check('endpoints kept', thinned[0].t === 0 && thinned[thinned.length - 1].t === 499_999)

// --- a one-point spike survives, which stride sampling cannot promise ----
const spiky = series(100_000, () => 0.001)
spiky[54_321] = { t: 54_321, p: 999, q: 0 }
const spikeKept = thinSeries(spiky, ['p'], 2000).some(r => r.p === 999)
check('single-point spike survives', spikeKept)

// The comparison that motivated the algorithm: keeping every nth point drops
// that same spike unless the modulus happens to land on it.
const stride = spiky.filter((_, i) => i % 50 === 0)
check('stride sampling would have dropped it (why min/max is used)',
  !stride.some(r => r.p === 999))

// --- extremes of EVERY plotted key are kept, not just the first ---------
const twoKeys = series(50_000, i => (i === 111 ? 5 : 0))
twoKeys[222] = { t: 222, p: 0, q: 7 }
const both = thinSeries(twoKeys, ['p', 'q'], 2000)
check('extreme of key 1 kept', both.some(r => r.p === 5))
check('extreme of key 2 kept', both.some(r => r.q === 7))

// --- degenerate inputs ---------------------------------------------------
check('empty input', thinSeries([], ['p'], 2000).length === 0)
check('no keys -> unchanged', thinSeries(long, [], 2000) === long)
check('non-numeric values do not throw',
  thinSeries(series(10_000, () => NaN), ['p'], 500).length <= 500)

// --- the caption is honest ----------------------------------------------
check('note empty when nothing was cut', thinningNote(100, 100) === '')
check('note states both counts', /1,000\b/.test(thinningNote(1000, 500000)) &&
  /500,000/.test(thinningNote(1000, 500000)))

console.log(`\n  ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
