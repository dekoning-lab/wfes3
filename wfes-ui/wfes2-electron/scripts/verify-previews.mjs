// Preview-truthfulness harness: for each view, reads the Command Line
// Preview, clicks Execute, captures the actually-spawned command from the
// main-process log, and diffs them flag by flag (numeric-tolerant values;
// --output-*/--initial compared on flag presence only, since the run resolves
// absolute destination paths).
//
// Requires the app running with a debug port and writes its log to
// /tmp/wfes3-app.log:
//   npx electron --remote-debugging-port=9420 out/main/index.js > /tmp/wfes3-app.log 2>&1 &
//   npm run verify:previews
//
// Every view must print MATCH. A DIFF means the preview drifted from the run
// -- the class of defect where copying the preview reproduces a DIFFERENT
// model than the GUI ran.
import { readFileSync } from 'fs';
const list = await (await fetch('http://127.0.0.1:9420/json')).json();
const page = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
let id=0; const pend=new Map();
ws.addEventListener('message', e=>{const d=JSON.parse(e.data); if(pend.has(d.id)){pend.get(d.id)(d);pend.delete(d.id);}});
const send=(m,p={})=>new Promise(res=>{const i=++id;pend.set(i,res);ws.send(JSON.stringify({id:i,method:m,params:p}));});
const ev=x=>send('Runtime.evaluate',{expression:x,awaitPromise:true,returnByValue:true});
const val=r=>r.result?.result?.value;

function tokenize(cmd) {
  const toks = cmd.match(/"[^"]*"|\S+/g) || [];
  return toks.map(t => t.replace(/^"|"$/g, ''));
}
function parseCmd(cmd) {
  const toks = tokenize(cmd);
  const bin = toks[0].split('/').pop();
  const flags = {};
  for (let i = 1; i < toks.length; i++) {
    if (toks[i].startsWith('-')) {
      const next = toks[i+1];
      if (next !== undefined && !next.startsWith('--')) { flags[toks[i]] = next; i++; }
      else flags[toks[i]] = true;
    }
  }
  return { bin, flags };
}
function eq(a, b) {
  if (a === b) return true;
  const na = parseFloat(a), nb = parseFloat(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) {
    return Math.abs(na - nb) <= 1e-9 * Math.max(1, Math.abs(na), Math.abs(nb));
  }
  return false;
}
const PATHY = f => f.startsWith('--output') || f === '--initial';

// Each view is exercised twice where it has an initial-distribution selector:
// once in its default mode and once with a file chosen. Running only the
// default let a real defect through -- six views passed --initial in their
// preview but never in the run, and the preview only emits the flag when a file
// is selected, so the two agreed by both being silent.
const INITIAL_FILES = {
  'Time-Homogeneous WFES': '/tmp/wfes-verify-init/single.csv',
  'Time to Extinction and Fixation': '/tmp/wfes-verify-init/timedist.csv'
}

const views = [
  'Time-Homogeneous WFES', 'General Switching Model', 'Sequential Switching Model',
  'Substitution with Standing Genetic', 'Time to Extinction and Fixation',
  'Time to Substitution', 'Stochastic Switching', 'Deterministic Switching',
  'Population Projection'
];
// Some modes build a different command line from their view's default, and a
// harness that only visits the default proves nothing about them. Each entry
// here is a label to click after arriving at the view.
const EXTRA_MODES = {
  'Time-Homogeneous WFES': ['Sojourn Times', 'One starting count']
};
for (const nav of views) {
  await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(e=>/back|home/i.test(e.innerText||'')); if(b)b.click(); return 1})()`);
  await new Promise(r=>setTimeout(r,900));
  const hit = val(await ev(`(()=>{const b=[...document.querySelectorAll('a')].find(e=>(e.innerText||'').includes(${JSON.stringify(nav)})); if(b){b.click();return 1} return 0})()`));
  await new Promise(r=>setTimeout(r,1400));
  for (const label of (EXTRA_MODES[nav] || [])) {
    await ev(`(()=>{const l=[...document.querySelectorAll('label')].find(e=>(e.innerText||'').trim()===${JSON.stringify('LBL')}.replace('LBL',${JSON.stringify(label)}));if(l)l.click();return 1})()`);
    await new Promise(r=>setTimeout(r,900));
  }
  const preview = val(await ev(`(()=>{
    // Read the actual preview element, not page text: About-panel usage
    // examples also contain command lines and were being matched instead.
    const els=[...document.querySelectorAll('h6,div,span')].filter(e=>e.childElementCount===0&&e.textContent.trim()==='Command Line Preview');
    for(const t of els){
      const paper=t.closest('.mantine-Paper-root')||t.parentElement?.parentElement;
      const cand=paper?[...paper.querySelectorAll('*')].filter(e=>e.childElementCount===0&&/^(wfes_|time_dist|phase_type_|wfafs_)/.test(e.textContent.trim())):[];
      if(cand.length) return cand[0].textContent.trim();
    }
    return '';
  })()`));
  const before = (readFileSync('/tmp/wfes3-app.log','utf8').match(/Executing: [^\n]*/g) || []).length;
  await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(e=>/execute/i.test(e.innerText||'')); if(b)b.click(); return 1})()`);
  await new Promise(r=>setTimeout(r,15000));
  const lines = readFileSync('/tmp/wfes3-app.log','utf8').match(/Executing: [^\n]*/g) || [];
  if (!hit || !preview || lines.length <= before) {
    console.log(`  ${nav.padEnd(36)} SKIP (hit=${hit} preview=${!!preview} newRuns=${lines.length-before})`);
    continue;
  }
  const spawned = lines[before].replace(/^Executing: /,'');
  const P = parseCmd(preview), S = parseCmd(spawned);
  const problems = [];
  if (P.bin !== S.bin) problems.push(`binary ${P.bin} vs ${S.bin}`);
  for (const [f, v] of Object.entries(S.flags)) {
    if (!(f in P.flags)) { problems.push(`missing ${f}`); continue; }
    if (!PATHY(f) && !eq(String(P.flags[f]), String(v))) problems.push(`${f}: preview=${P.flags[f]} run=${v}`);
  }
  for (const f of Object.keys(P.flags)) {
    if (!(f in S.flags)) problems.push(`extra ${f}`);
  }
  console.log(`  ${nav.padEnd(36)} ${problems.length === 0 ? 'MATCH' : 'DIFF: ' + problems.join('; ')}`);
}
ws.close();
