/**
 * Regression harness for the GUI -> CLI parameter marshalling layer.
 *
 * baseline_tests/validate_baselines.py validates the CLI itself. It cannot
 * catch bugs in the Electron layer that converts form state into CLI
 * arguments -- and that layer is where a silent numerical bug lived: numeric
 * parameters were defaulted with `||`, so a deliberately-entered 0 was
 * replaced by the fallback. h = 0 (fully recessive) was computed as h = 0.5,
 * overstating P_fix by 37.6% with no error shown to the user.
 *
 * This script drives the app's real IPC entry point
 * (window.api.wfes.single.execute) over the Chrome DevTools Protocol -- the
 * same path an Execute button click takes -- and compares each result against
 * the value the CLI produces for the same parameters. The expected values below
 * were produced by invoking wfes_single directly; see the header comment on each
 * case. Every zero-valued case is chosen so that the buggy and correct
 * behaviours give *different* numbers, otherwise the test could not fail.
 *
 * Usage:
 *   npm run build
 *   npx electron --remote-debugging-port=9411 out/main/index.js &
 *   npm run verify:gui            # or: node scripts/verify-gui-params.mjs 9411
 *
 * Exit status is 0 only if every case matches.
 *
 * SCOPE, and what this does NOT cover. It calls the IPC entry point with an
 * already-assembled params object, so it exercises the main-process handler in
 * src/main/index.ts but bypasses the view code that turns form strings into
 * that object. The views had the same class of bug; that half is covered by
 * `npm run verify:numeric` (scripts/verify-numeric-helpers.ts). Note also that
 * only the h=0 case here discriminates the original main-process bug: for
 * s/u/v/alpha, dropping the parameter happens to coincide with the CLI's own
 * default, so those cases were wrong-but-harmless and pass either way. They are
 * kept because they would catch a future default that does not coincide.
 */
const PORT = process.argv[2] ?? "9411";
const RTOL = 1e-5; // CLI prints ~6 s.f.

const BASE = {
  modelType: "absorption",
  populationSize: 100,
  selection: 0.01,
  dominance: 0.5,
  backward_mutation: 1e-6,
  forward_mutation: 1e-6,
  startingCopies: 1,
  library: "Accelerate",
};

// Each expected P_fix comes from:
//   wfes_single --absorption -N 100 -p 1 --library Accelerate \
//               -s <s> -h <h> -u <u> -v <v> [-a <alpha>]
const CASES = [
  { name: "control  s=0.01 h=0.5", patch: {}, expect: 0.011498 },
  { name: "h=0      (recessive)", patch: { dominance: 0 }, expect: 0.00835934 },
  { name: "h=0.25   (non-zero)", patch: { dominance: 0.25 }, expect: 0.00983378 },
  { name: "s=0      (neutral)", patch: { selection: 0 }, expect: 0.00500798 },
  { name: "u=0      (no back mut)", patch: { backward_mutation: 0 }, expect: 0.0115007 },
  { name: "v=0      (no fwd mut)", patch: { forward_mutation: 0 }, expect: 0.0114776 },
  { name: "alpha=0  (no trunc)", patch: { alpha: 0 }, expect: 0.011498 },
];

async function targetUrl(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json`);
  const targets = await res.json();
  const page = targets.find((t) => t.type === "page");
  if (!page) throw new Error("no CDP page target; is the app running with --remote-debugging-port?");
  return page.webSocketDebuggerUrl;
}

function connect(url) {
  const ws = new WebSocket(url);
  let nextId = 1;
  const pending = new Map();
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    }
  });
  const ready = new Promise((res, rej) => {
    ws.addEventListener("open", res);
    ws.addEventListener("error", () => rej(new Error("websocket failed")));
  });
  const send = (method, params) => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  };
  return { ready, send };
}

const main = async () => {
  const { ready, send } = connect(await targetUrl(PORT));
  await ready;
  await send("Runtime.enable", {});

  const probe = await send("Runtime.evaluate", {
    expression: "!!(window.api && window.api.wfes && window.api.wfes.single)",
    returnByValue: true,
  });
  if (probe.result.value !== true) {
    console.error("FAIL: window.api.wfes.single is not exposed to the renderer");
    process.exit(1);
  }

  let failures = 0;
  for (const { name, patch, expect } of CASES) {
    const params = { ...BASE, ...patch };
    const res = await send("Runtime.evaluate", {
      expression:
        `window.api.wfes.single.execute(${JSON.stringify(params)})` +
        `.then(r => JSON.stringify(r)).catch(e => JSON.stringify({success:false,error:String(e)}))`,
      awaitPromise: true,
      returnByValue: true,
      timeout: 120000,
    });

    let got, note = "";
    try {
      const parsed = JSON.parse(res.result.value);
      if (!parsed.success) note = `error: ${String(parsed.error).slice(0, 80)}`;
      else got = parsed.results?.P_fix;
    } catch {
      note = "unparseable IPC response";
    }

    if (typeof got !== "number") {
      console.log(`  FAIL ${name.padEnd(24)} no P_fix returned  ${note}`);
      failures++;
      continue;
    }
    const rel = Math.abs(got - expect) / Math.abs(expect);
    const ok = rel <= RTOL;
    if (!ok) failures++;
    console.log(
      `  ${ok ? "OK  " : "FAIL"} ${name.padEnd(24)} got=${got} cli=${expect} rel=${rel.toExponential(2)}`
    );
  }

  console.log(
    failures
      ? `\n${failures} of ${CASES.length} case(s) FAILED: the GUI is not passing these parameters through faithfully.`
      : `\nAll ${CASES.length} cases match the CLI: zero-valued parameters survive the GUI layer.`
  );
  process.exit(failures ? 1 : 0);
};

setTimeout(() => {
  console.error("TIMEOUT after 300s");
  process.exit(1);
}, 300_000);

main().catch((e) => {
  console.error("FAIL:", e.message);
  process.exit(1);
});
