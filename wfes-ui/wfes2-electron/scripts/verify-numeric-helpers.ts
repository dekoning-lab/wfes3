/**
 * Unit tests for src/renderer/utils/numeric.ts.
 *
 * These cover the renderer half of the zero-parameter bug. The CDP harness
 * (verify-gui-params.mjs) invokes window.api.wfes.single.execute directly with
 * an already-built params object, so it exercises the main-process marshalling
 * but NOT the view code that converts form strings into that object. The views
 * previously used `parseFloat(field) || undefined`, which dropped a valid 0.
 * These assertions pin the replacement helpers' behaviour.
 *
 * Run:  node --experimental-strip-types scripts/verify-numeric-helpers.ts
 */
import { numOrUndefined, intOrUndefined, finiteOrUndefined } from "../src/renderer/utils/numeric.ts";

let failures = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  const ok = Object.is(actual, expected);
  if (!ok) failures++;
  console.log(`  ${ok ? "OK  " : "FAIL"} ${label.padEnd(46)} got=${String(actual)} want=${String(expected)}`);
}

console.log("numOrUndefined - zero must survive (the actual bug)");
check("numOrUndefined('0')", numOrUndefined("0"), 0);
check("numOrUndefined(0)", numOrUndefined(0), 0);
check("numOrUndefined('0.0')", numOrUndefined("0.0"), 0);
check("numOrUndefined('0e0')", numOrUndefined("0e0"), 0);

console.log("\nnumOrUndefined - genuinely absent input must be undefined");
check("numOrUndefined('')", numOrUndefined(""), undefined);
check("numOrUndefined('   ')", numOrUndefined("   "), undefined);
check("numOrUndefined(null)", numOrUndefined(null), undefined);
check("numOrUndefined(undefined)", numOrUndefined(undefined), undefined);
check("numOrUndefined('abc')", numOrUndefined("abc"), undefined);
check("numOrUndefined(NaN)", numOrUndefined(NaN), undefined);
check("numOrUndefined(Infinity)", numOrUndefined(Infinity), undefined);

console.log("\nnumOrUndefined - ordinary values pass through");
check("numOrUndefined('0.5')", numOrUndefined("0.5"), 0.5);
check("numOrUndefined('1e-6')", numOrUndefined("1e-6"), 1e-6);
check("numOrUndefined('-0.01')", numOrUndefined("-0.01"), -0.01);
check("numOrUndefined('1e-20')", numOrUndefined("1e-20"), 1e-20);

console.log("\nintOrUndefined");
check("intOrUndefined('0')", intOrUndefined("0"), 0);
check("intOrUndefined('1')", intOrUndefined("1"), 1);
check("intOrUndefined('100')", intOrUndefined("100"), 100);
check("intOrUndefined('')", intOrUndefined(""), undefined);
check("intOrUndefined('abc')", intOrUndefined("abc"), undefined);
check("intOrUndefined('3.7') truncates", intOrUndefined("3.7"), 3);

console.log("\nfiniteOrUndefined - for values derived by arithmetic");
check("finiteOrUndefined(0)", finiteOrUndefined(0), 0);
check("finiteOrUndefined(-0)", finiteOrUndefined(-0), -0);
check("finiteOrUndefined(0.5)", finiteOrUndefined(0.5), 0.5);
check("finiteOrUndefined(NaN)", finiteOrUndefined(NaN), undefined);
check("finiteOrUndefined(Infinity)", finiteOrUndefined(Infinity), undefined);
// e.g. unscaling 2Ns with a blank N gives NaN, which must not reach the CLI
check("finiteOrUndefined(NaN/(2*NaN))", finiteOrUndefined(NaN / (2 * NaN)), undefined);

console.log(
  failures
    ? `\n${failures} assertion(s) FAILED`
    : "\nall assertions passed: zero survives, blank/unparseable becomes undefined"
);
process.exit(failures ? 1 : 0);
