/**
 * For every view with an initial-distribution selector: choose "Custom
 * distribution", write a point mass of the length the view says it wants, run,
 * and confirm the spawned command carries --initial.
 *
 * This exists because verify:previews could not catch the defect it was written
 * for. Six views passed --initial in their preview but never in the run, and a
 * preview only emits the flag when a file is chosen -- so with no file selected
 * the preview and the run agreed by both being silent, and the harness passed.
 * Checking the spawned command with a file actually chosen is the only version
 * of this test that means anything.
 *
 * Run with the app up on :9420.
 */
// For every view with a selector: choose Custom distribution, set a file, run,
// and confirm the spawned command carries --initial.
import { readFileSync } from 'fs';
// [view, mode to select first]. The mode matters: wfes_switching sizes its
// state space differently under --fixation and --absorption, and phase-type
// routes SGV to a different binary with a different space. Running only the
// default mode is how a flag that was silently ignored under --fixation went
// unnoticed.
const VIEWS = [
  ['Time-Homogeneous WFES', null],
  ['Substitution with Standing Genetic', null],
  ['General Switching Model', null],
  ['General Switching Model', 'Substitution Model'],
  ['Sequential Switching Model', null],
  ['Time to Extinction and Fixation', null],
  ['Time to Substitution', null],
  ['Time to Substitution', 'Substitution with SGV'],
  ['Stochastic Switching', null],
  ['Deterministic Switching', null]
];
const list = await (await fetch('http://127.0.0.1:9420/json')).json();
const page = list.find(t => t.type==='page' && t.webSocketDebuggerUrl);
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
let id=0; const pend=new Map();
ws.addEventListener('message', e=>{const d=JSON.parse(e.data); if(pend.has(d.id)){pend.get(d.id)(d);pend.delete(d.id);}});
const ev=x=>new Promise(res=>{const i=++id;pend.set(i,res);ws.send(JSON.stringify({id:i,method:'Runtime.evaluate',params:{expression:x,awaitPromise:true,returnByValue:true}}));});
const val=r=>r.result?.result?.value; const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let bad=0;
for (const [view, mode] of VIEWS) {
  await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(e=>/back|home/i.test(e.innerText||'')); if(b)b.click(); return 1})()`); await sleep(700);
  await ev(`(()=>{const a=[...document.querySelectorAll('a')].find(e=>(e.innerText||'').includes(${JSON.stringify(view)})); if(a)a.click(); return 1})()`); await sleep(1300);
  if (mode) {
    const picked = val(await ev(`(()=>{const e=[...document.querySelectorAll('.mantine-SegmentedControl-label, label')].find(x=>(x.textContent||'').trim()===${JSON.stringify(mode)}); if(e){e.click();return 1} return 0})()`));
    if (!picked) { console.log(`  ${(view+' / '+mode).padEnd(46)} could not select mode`); bad++; continue }
    await sleep(900);
  }
  const picked = val(await ev(`(()=>{const l=[...document.querySelectorAll('.mantine-SegmentedControl-label')].find(e=>/Custom distribution/.test(e.textContent||'')); if(l){l.click();return 1} return 0})()`));
  if (!picked) { console.log(`  ${(mode ? view + ' / ' + mode : view).padEnd(46)} no selector`); bad++; continue }
  await sleep(600);
  // read the length the view says it wants, and write a matching point mass
  const desc = val(await ev(`(()=>{const d=[...document.querySelectorAll('.mantine-InputWrapper-description')].map(e=>e.textContent).find(t=>/CSV column/.test(t||'')); return d||''})()`));
  const m = /([\d,]+) probabilities/.exec(desc||'');
  const n = m ? parseInt(m[1].replace(/,/g,'')) : 0;
  if (!n) { console.log(`  ${(mode ? view + ' / ' + mode : view).padEnd(46)} no length stated: ${desc}`); bad++; continue }
  const fs = await import('fs');
  const path = `/tmp/wfes-verify-init/${view.replace(/\W+/g,'_')}.csv`;
  fs.writeFileSync(path, Array.from({length:n},(_,i)=> i===Math.floor(n/4) ? '1':'0').join('\n')+'\n');
  await ev(`(()=>{const inp=document.querySelector('input[placeholder="No file chosen"]');
    const setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
    setter.call(inp,${JSON.stringify(path)}); inp.dispatchEvent(new Event('input',{bubbles:true})); return 1})()`);
  await sleep(600);
  const before = (readFileSync('/tmp/wfes3-app.log','utf8').match(/Executing: [^\n]*/g)||[]).length;
  await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(e=>/execute/i.test(e.innerText||'')); if(b)b.click(); return 1})()`);
  for(let w=0;w<150000;w+=2000){await sleep(2000); if(val(await ev(`document.querySelectorAll('.results-table').length`)))break;}
  await sleep(600);
  const lines = readFileSync('/tmp/wfes3-app.log','utf8').match(/Executing: [^\n]*/g)||[];
  const cmd = lines[before] || '';
  const spawned = cmd.includes('--initial');
  // Spawning the flag is not enough: if the stated length is wrong for the
  // tool's state space, the run errors and the view shows an alert. Checking
  // only the command would have passed a view that tells users the wrong size.
  const state = JSON.parse(val(await ev(`JSON.stringify((()=>{
    const alerts=[...document.querySelectorAll('.mantine-Alert-root')].map(a=>a.innerText.replace(/\\n+/g,' ').slice(0,120))
    return { rows: document.querySelectorAll('.results-table tr').length, alerts }
  })())`)));
  const errored = state.alerts.some(a => /error|initial distribution/i.test(a));
  const ok = spawned && state.rows > 0 && !errored;
  if (!ok) bad++;
  const why = !spawned ? 'MISSING --initial'
            : errored ? 'RUN FAILED: ' + state.alerts.find(a => /error|initial/i.test(a))
            : state.rows === 0 ? 'no results'
            : `ok (${state.rows} result rows)`;
  console.log(`  ${(mode ? view + ' / ' + mode : view).padEnd(46)} n=${String(n).padStart(5)}  ${why}`);
}

// Sojourn Times: one starting count gives one row of N; no count gives the
// whole matrix. Averaging over a distribution of starting states is not offered
// here, and --initial is refused, so the check is that the two scopes differ and
// that the single-count answer tracks the count.
const soj = async (patch) => JSON.parse(val(await ev(`(async()=>{
  const r = await window.api.wfes.single.execute(Object.assign({
    modelType: 'fundamental', populationSize: 50, selectionCoeff: 0.01,
    dominanceCoeff: 0.5, backwardMutation: 1e-4, forwardMutation: 1e-4,
    alpha: 1e-20, outputOptions: {}, executionOptions: { threads: 1 }
  }, ${JSON.stringify(patch)}))
  return JSON.stringify(r)
})()`)));
const t = r => r?.results?.T_abs ?? r?.T_abs;

const p1 = await soj({ startingCopies: 1 });
const p9 = await soj({ startingCopies: 9 });
const all = await soj({});
let sojBad = 0;
const say = (label, ok, detail) => {
  if (!ok) sojBad++;
  console.log(`  Sojourn Times ${label.padEnd(30)} ${ok ? '' : 'FAIL: '}${detail}`);
};
say('p=1 reports its row', Number.isFinite(t(p1)), `T_abs=${t(p1)}`);
say('p=9 reports its row', Number.isFinite(t(p9)), `T_abs=${t(p9)}`);
say('the two counts differ', t(p1) !== t(p9), `${t(p1)} vs ${t(p9)}`);
// No count: the matrix covers every starting state, so there is no single
// T_abs to report. Reporting one here would mean a starting state crept in.
say('no count reports no T_abs', t(all) === undefined, `got ${t(all)}`);
if (sojBad) bad++;

ws.close();
process.exit(bad?1:0);
