/**
 * Tests for src/main/unicodeToLatex.ts.
 *
 * Two layers:
 *  1. Unit assertions on the documented rules.
 *  2. A sweep over the REAL about/*.md files asserting that no convertible
 *     Unicode character survives outside code blocks, and that code blocks come
 *     through byte-identical.
 *
 * Context: index.ts called aboutService.convertUnicodeToLatex in five places
 * while the method did not exist, so every About panel request failed with
 * "convertUnicodeToLatex is not a function".
 *
 * Run: npm run verify:latex
 */
import { readFileSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { convertUnicodeToLatex, CONVERTIBLE_CHARS } from "../src/main/unicodeToLatex.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ABOUT_DIR = join(HERE, "..", "..", "..", "about");

let failures = 0;

function check(label: string, actual: string, expected: string): void {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`  ${ok ? "OK  " : "FAIL"} ${label}`);
  if (!ok) {
    console.log(`         got:  ${JSON.stringify(actual)}`);
    console.log(`         want: ${JSON.stringify(expected)}`);
  }
}

function assert(label: string, cond: boolean, detail = ""): void {
  if (!cond) failures++;
  console.log(`  ${cond ? "OK  " : "FAIL"} ${label}${cond ? "" : "  " + detail}`);
}

console.log("subscripts and superscripts attach to the preceding identifier");
check("N₁ -> $N_{1}$", convertUnicodeToLatex("N₁"), "$N_{1}$");
check("N₁₀ -> $N_{10}$", convertUnicodeToLatex("N₁₀"), "$N_{10}$");
check("Ψᵢ -> $\\Psi_{i}$", convertUnicodeToLatex("Ψᵢ"), "$\\Psi_{i}$");
check("x² -> $x^{2}$", convertUnicodeToLatex("x²"), "$x^{2}$");

console.log("\nstandalone symbols are wrapped in math mode");
check("a × b", convertUnicodeToLatex("a × b"), "a $\\times$ b");
check("α alone", convertUnicodeToLatex("α"), "$\\alpha$");
check("A → B", convertUnicodeToLatex("A → B"), "A $\\to$ B");

console.log("\nadjacent spans merge (no stray $$ that would read as display math)");
const merged = convertUnicodeToLatex("N₁×N₂");
check("N₁×N₂", merged, "$N_{1}\\times N_{2}$");
assert("no '$$' produced", !merged.includes("$$"), merged);

console.log("\nexisting math mode is not double-wrapped");
check("$N₁$ stays one span", convertUnicodeToLatex("$N₁$"), "$N_{1}$");
check("$$α$$ display math", convertUnicodeToLatex("$$α$$"), "$$\\alpha$$");

console.log("\ncode is left alone");
check("inline code", convertUnicodeToLatex("`-N 100 × 2`"), "`-N 100 × 2`");
check(
  "fenced block",
  convertUnicodeToLatex("```\nP_ext × N₁\n```"),
  "```\nP_ext × N₁\n```"
);

console.log("\nmisc");
check("combining macron x̄", convertUnicodeToLatex("x̄"), "$\\bar{x}$");
check("accented prose untouched", convertUnicodeToLatex("Café"), "Café");
check("empty string", convertUnicodeToLatex(""), "");
check("plain ascii untouched", convertUnicodeToLatex("P_fix = 0.5"), "P_fix = 0.5");

console.log("\nsweep over the real about/*.md files");
const convertible = new Set(Array.from(CONVERTIBLE_CHARS));
let files = 0;

/** Remove fenced and inline code so we only inspect prose and math. */
function stripCode(s: string): string {
  return s.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
}

for (const name of readdirSync(ABOUT_DIR).filter((f) => f.endsWith(".md"))) {
  const original = readFileSync(join(ABOUT_DIR, name), "utf-8");
  const converted = convertUnicodeToLatex(original);
  files++;

  const leftover = Array.from(new Set(Array.from(stripCode(converted))))
    .filter((ch) => convertible.has(ch));
  assert(
    `${name}: no convertible Unicode left outside code`,
    leftover.length === 0,
    leftover.length ? `remaining: ${leftover.join(" ")}` : ""
  );

  // Fenced blocks must survive byte-identically.
  const fencesBefore = original.match(/```[\s\S]*?```/g) ?? [];
  const fencesAfter = converted.match(/```[\s\S]*?```/g) ?? [];
  assert(
    `${name}: ${fencesBefore.length} fenced block(s) unchanged`,
    fencesBefore.length === fencesAfter.length &&
      fencesBefore.every((b, i) => b === fencesAfter[i])
  );

  assert(`${name}: no stray '$$$' sequence`, !converted.includes("$$$"));
}

console.log(
  failures
    ? `\n${failures} assertion(s) FAILED across ${files} about file(s)`
    : `\nall assertions passed (${files} about file(s) swept)`
);
process.exit(failures ? 1 : 0);
