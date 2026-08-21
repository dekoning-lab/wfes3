/**
 * @file unicodeToLatex.ts
 * @brief Rewrite Unicode mathematical notation as LaTeX so KaTeX can render it.
 *
 * The about/*.md documentation was written with literal Unicode symbols
 * (N₁, Ψᵢ, ×, →, Γ, x̄ and so on). KaTeX only renders LaTeX inside math
 * delimiters, so those characters would otherwise reach the About panel as raw
 * glyphs. This module is a pure function with no Electron dependency, so it can
 * be unit-tested outside the app; AboutContentService delegates to it.
 *
 * The tables are keyed on the characters that actually occur in about/*.md
 * (surveyed 2026-08-17), plus close relatives that are likely to appear as the
 * documentation grows.
 */

/** Unicode -> LaTeX command, for symbols that stand alone. */
const SYMBOLS: Record<string, string> = {
  '×': '\\times', '→': '\\to', '≥': '\\geq', '≤': '\\leq', '≠': '\\neq',
  '≈': '\\approx', '±': '\\pm', '∞': '\\infty', '∏': '\\prod',
  '∫': '\\int', '∑': '\\sum', 'Σ': '\\Sigma', 'Γ': '\\Gamma',
  'Δ': '\\Delta', 'Λ': '\\Lambda', 'Ψ': '\\Psi', 'Θ': '\\Theta',
  'α': '\\alpha', 'β': '\\beta', 'γ': '\\gamma', 'δ': '\\delta',
  'θ': '\\theta', 'λ': '\\lambda', 'μ': '\\mu', 'π': '\\pi',
  'ρ': '\\rho', 'σ': '\\sigma', 'τ': '\\tau', 'φ': '\\phi',
  'ψ': '\\psi', 'ω': '\\omega', 'ε': '\\epsilon',
}

/** Unicode subscript characters -> their plain equivalent. */
const SUBSCRIPTS: Record<string, string> = {
  '₀': '0', '₁': '1', '₂': '2', '₃': '3', '₄': '4', '₅': '5',
  '₆': '6', '₇': '7', '₈': '8', '₉': '9', '₊': '+', '₋': '-',
  'ᵢ': 'i', 'ⱼ': 'j', 'ₙ': 'n', 'ₖ': 'k', 'ₘ': 'm', 'ₓ': 'x',
}

/** Unicode superscript characters -> their plain equivalent. */
const SUPERSCRIPTS: Record<string, string> = {
  '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5',
  '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9', 'ⁿ': 'n', '⁺': '+', '⁻': '-',
}

/** Every Unicode character this module knows how to convert. */
export const CONVERTIBLE_CHARS: string =
  Object.keys(SYMBOLS).join('') +
  Object.keys(SUBSCRIPTS).join('') +
  Object.keys(SUPERSCRIPTS).join('') +
  '̄' // combining macron

// Sentinels for generated math spans, so adjacent spans can be merged
// unambiguously before real dollar signs are emitted.
const OPEN = '\u0000'
const CLOSE = '\u0001'

const SUB_KEYS = Object.keys(SUBSCRIPTS).join('')
const SUP_KEYS = Object.keys(SUPERSCRIPTS).join('')

const SYMBOL_KEYS = Object.keys(SYMBOLS).join('')
const symbolRe = new RegExp(`[${SYMBOL_KEYS}]`, 'g')

// The "base" a sub/superscript attaches to may itself be a Greek letter or
// other symbol: in "Psi_i" written as the two characters Greek-psi + subscript-i,
// the base is the Greek letter. Including SYMBOL_KEYS here keeps the pair in one
// span and yields \\Psi_{i} rather than two spans merged into "\\Psi _{i}".
const BASE_CLASS = `[A-Za-z0-9\\)\\]${SYMBOL_KEYS}]`
const subRunRe = new RegExp(`(${BASE_CLASS})([${SUB_KEYS}]+)`, 'g')
const supRunRe = new RegExp(`(${BASE_CLASS})([${SUP_KEYS}]+)`, 'g')
const strandedSubRe = new RegExp(`[${SUB_KEYS}]`, 'g')
const strandedSupRe = new RegExp(`[${SUP_KEYS}]`, 'g')
const macronRe = /([A-Za-z])̄/g

// Alternation order matters: fenced code before inline code, $$ before $.
const segmentRe = /(```[\s\S]*?```|`[^`\n]*`)|(\$\$[\s\S]*?\$\$|\$[^$\n]*\$)/g

const mapBase = (base: string): string => SYMBOLS[base] ?? base

const mapRun = (run: string, table: Record<string, string>): string =>
  Array.from(run).map((ch) => table[ch] ?? ch).join('')

/** Replacements valid where math mode is already active. */
function inMath(s: string): string {
  return s
    .replace(subRunRe, (_m, base, run) => `${mapBase(base)}_{${mapRun(run, SUBSCRIPTS)}}`)
    .replace(supRunRe, (_m, base, run) => `${mapBase(base)}^{${mapRun(run, SUPERSCRIPTS)}}`)
    .replace(strandedSubRe, (ch) => `_{${SUBSCRIPTS[ch]}}`)
    .replace(strandedSupRe, (ch) => `^{${SUPERSCRIPTS[ch]}}`)
    .replace(macronRe, '\\bar{$1}')
    .replace(symbolRe, (ch) => SYMBOLS[ch])
}

/** Replacements for ordinary prose, wrapping each result in math mode. */
function inText(s: string): string {
  return s
    .replace(subRunRe, (_m, base, run) =>
      `${OPEN}${mapBase(base)}_{${mapRun(run, SUBSCRIPTS)}}${CLOSE}`)
    .replace(supRunRe, (_m, base, run) =>
      `${OPEN}${mapBase(base)}^{${mapRun(run, SUPERSCRIPTS)}}${CLOSE}`)
    .replace(strandedSubRe, (ch) => `${OPEN}_{${SUBSCRIPTS[ch]}}${CLOSE}`)
    .replace(strandedSupRe, (ch) => `${OPEN}^{${SUPERSCRIPTS[ch]}}${CLOSE}`)
    .replace(macronRe, `${OPEN}\\bar{$1}${CLOSE}`)
    .replace(symbolRe, (ch) => `${OPEN}${SYMBOLS[ch]}${CLOSE}`)
}

/**
 * Convert Unicode mathematical notation in Markdown to LaTeX.
 *
 * Rules, in order:
 *  - Fenced code blocks and inline code are left completely alone; notation
 *    inside them is meant to be read literally (CLI flags, sample output).
 *  - Inside existing $...$ or $$...$$ spans, symbols become bare commands,
 *    since math mode is already active.
 *  - Outside math, a converted symbol is wrapped in $...$. Subscript and
 *    superscript runs attach to the identifier immediately preceding them, so
 *    "N₁" becomes "$N_{1}$" and not "N$_{1}$", which would be a subscript on
 *    nothing.
 *  - A combining macron (x̄, used for means) becomes \bar{x}.
 *  - Adjacent generated spans are merged, so "N₁ × N₂" cannot produce a stray
 *    "$$" that a Markdown parser would read as a display-math delimiter.
 *
 * Accented Latin letters such as é are deliberately NOT touched: they appear in
 * prose and author names, not in mathematics.
 */
export function convertUnicodeToLatex(text: string): string {
  if (!text) return text ?? ''

  let result = ''
  let lastIndex = 0
  let match: RegExpExecArray | null

  segmentRe.lastIndex = 0
  while ((match = segmentRe.exec(text)) !== null) {
    result += inText(text.slice(lastIndex, match.index))
    result += match[1] !== undefined ? match[1] : inMath(match[2])
    lastIndex = segmentRe.lastIndex
  }
  result += inText(text.slice(lastIndex))

  return emitMergedSpans(result)
}

/**
 * Collapse adjacent generated math spans and emit real `$` delimiters.
 *
 * Two spans separated by nothing, or by non-newline whitespace, become one
 * span: "N₁ × N₂" must not yield "$N_{1}$ $\times$ $N_{2}$", because the
 * "$ $" boundaries would be read as display-math delimiters by a Markdown
 * parser. A newline between spans is preserved and keeps them separate, so
 * paragraph structure survives.
 *
 * A single space is inserted when, and only when, joining would run a LaTeX
 * command into a following letter: "N₁×N₂" must become "$N_{1}\times N_{2}$"
 * and not "$N_{1}\timesN_{2}$", since \timesN is an undefined command. Spaces
 * are ignored for layout inside math mode, so adding one never changes the
 * rendered result.
 */
function emitMergedSpans(text: string): string {
  const endsWithCommand = /\\[A-Za-z]+$/
  let out = ''
  let i = 0

  while (i < text.length) {
    const ch = text[i]
    if (ch === CLOSE) {
      let j = i + 1
      while (j < text.length && /[^\S\n]/.test(text[j])) j++
      if (text[j] === OPEN) {
        const gap = text.slice(i + 1, j)
        if (gap) {
          out += gap
        } else if (endsWithCommand.test(out) && /^[A-Za-z]/.test(text[j + 1] ?? '')) {
          out += ' '
        }
        i = j + 1 // drop both sentinels: the spans are now one
        continue
      }
    }
    out += ch
    i++
  }

  return out.split(OPEN).join('$').split(CLOSE).join('$')
}
