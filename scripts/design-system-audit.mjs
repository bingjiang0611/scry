#!/usr/bin/env node
// Design-system debt audit for renderer CSS.
//
// Counts declarations that bypass the token scales defined in
// src/renderer/styles-theme-shell.css. The committed baseline may only shrink:
// `--check` fails when any file/metric grows, `--write` refuses to raise a value.
// Radius is enforced separately (and absolutely) by radius-system.test.ts.
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
export const rendererRoot = join(repoRoot, 'src/renderer')
export const baselinePath = join(rendererRoot, 'design-system-baseline.json')

export const METRICS = /** @type {const} */ (['fontSize', 'fontWeight', 'spacing', 'color', 'buttonReset'])

export const METRIC_RULES = {
  fontSize: 'font-size / font shorthand uses a px literal instead of var(--text-*)',
  fontWeight: 'font-weight uses a number instead of var(--weight-*)',
  spacing: 'padding / margin / gap uses a px value off the 4px grid (1px hairline and 2px optical are allowed)',
  color: 'a non-token declaration uses a raw color literal instead of a theme variable',
  buttonReset: 'a container-wide `… button` rule does not exclude the Button, IconButton, Tabs and Segmented primitives'
}

const SPACING_PROPERTY = /^(?:padding|margin)(?:-(?:top|right|bottom|left|inline|block)(?:-(?:start|end))?)?$|^(?:gap|row-gap|column-gap)$/
const PX_LITERAL = /-?\d*\.?\d+px\b/g
const HAS_PX = /\d*\.?\d+px\b/
const COLOR_LITERAL = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/g

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '))
}

/** Yields `{ property, value, line }` for every declaration in a stylesheet. */
export function* declarations(source) {
  const text = stripComments(source)
  const pattern = /(?:^|[{;])\s*(-{0,2}[a-zA-Z][-a-zA-Z0-9_]*)\s*:\s*([^;{}]*)/g
  for (const match of text.matchAll(pattern)) {
    const end = match.index + match[0].length
    // Selectors such as `a:hover {` match the shape but are followed by `{`.
    if (end < text.length && text[end] !== ';' && text[end] !== '}') continue
    const line = text.slice(0, match.index + match[0].indexOf(match[1])).split('\n').length
    yield { property: match[1].toLowerCase(), value: match[2].trim(), line }
  }
}

function splitSelectors(text) {
  const out = []
  let depth = 0
  let current = ''
  for (const ch of text) {
    if (ch === '(' || ch === '[') depth++
    else if (ch === ')' || ch === ']') depth--
    if (ch === ',' && depth === 0) { out.push(current); current = '' } else current += ch
  }
  out.push(current)
  return out.map((selector) => selector.trim()).filter(Boolean)
}

/** Yields `{ selector, line }` for every style-rule selector (at-rule preludes excluded). */
export function* selectors(source) {
  const text = stripComments(source)
  for (const match of text.matchAll(/([^{};]+)\{/g)) {
    const prelude = match[1].trim()
    if (!prelude || prelude.startsWith('@')) continue
    const line = text.slice(0, match.index + match[0].indexOf(prelude)).split('\n').length
    for (const selector of splitSelectors(prelude)) yield { selector, line }
  }
}

// `.panel button`, `.panel > button:hover`: a descendant rule whose subject is a bare button.
const CONTAINER_BUTTON = /[\s>]button(?::[a-z-]+(?:\([^()]*\))?)*$/
const EXCLUDES_PRIMITIVES = /:not\(\.btn\b/

function withoutClamp(value) {
  return value.replace(/clamp\([^()]*(?:\([^()]*\)[^()]*)*\)/g, '')
}

// Sheets that define the primitives themselves are the one place a bare `button` subject is the point.
const PRIMITIVE_SHEETS = new Set(['styles-buttons.css', 'styles-tabs.css', 'styles-notices.css'])

/** Returns the violations of one stylesheet, grouped by metric. */
export function auditCss(source, { primitiveSheet = false } = {}) {
  /** @type {Record<string, Array<{ line: number, text: string }>>} */
  const found = Object.fromEntries(METRICS.map((metric) => [metric, []]))
  for (const { property, value, line } of declarations(source)) {
    const text = `${property}: ${value}`
    if (property.startsWith('--')) continue
    if (property === 'font-size' && HAS_PX.test(withoutClamp(value))) found.fontSize.push({ line, text })
    if (property === 'font') {
      if (/(?:^|\s)\d*\.?\d+px(?=[\s/]|$)/.test(withoutClamp(value))) found.fontSize.push({ line, text })
      if (/^(?:italic\s+)?\d{3}\b/.test(value)) found.fontWeight.push({ line, text })
    }
    if (property === 'font-weight' && /^\d/.test(value)) found.fontWeight.push({ line, text })
    if (SPACING_PROPERTY.test(property)) {
      for (const literal of value.match(PX_LITERAL) ?? []) {
        const px = Math.abs(Number.parseFloat(literal))
        if (px !== 0 && px !== 1 && px !== 2 && px % 4 !== 0) found.spacing.push({ line, text })
      }
    }
    for (const _ of value.match(COLOR_LITERAL) ?? []) found.color.push({ line, text })
  }
  for (const { selector, line } of primitiveSheet ? [] : selectors(source)) {
    if (CONTAINER_BUTTON.test(selector) && !EXCLUDES_PRIMITIVES.test(selector)) found.buttonReset.push({ line, text: selector })
  }
  return found
}

function cssFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return cssFiles(path)
    return entry.isFile() && entry.name.endsWith('.css') ? [path] : []
  }).sort()
}

/** Audits every renderer stylesheet; files without debt are omitted. */
export function auditRenderer(root = rendererRoot) {
  /** @type {Record<string, Record<string, Array<{ line: number, text: string }>>>} */
  const files = {}
  for (const path of cssFiles(root)) {
    const found = auditCss(readFileSync(path, 'utf8'), { primitiveSheet: PRIMITIVE_SHEETS.has(basename(path)) })
    if (METRICS.some((metric) => found[metric].length > 0)) files[relative(root, path)] = found
  }
  return files
}

/**
 * Audits only the rules with at least one selector matching `scope` (e.g. the sidebar), across
 * every renderer stylesheet. Areas that have been fully cleaned are held at zero
 * with this, which is stricter than the per-file ratchet.
 */
export function auditRendererScope(scope, root = rendererRoot) {
  /** @type {Record<string, Record<string, Array<{ line: number, text: string }>>>} */
  const files = {}
  for (const path of cssFiles(root)) {
    // Blank every rule outside the scope while keeping line numbers stable.
    const source = stripComments(readFileSync(path, 'utf8'))
      .replace(/([^{}]+)\{([^{}]*)\}/g, (rule, prelude) =>
        splitSelectors(prelude).some((selector) => scope.test(selector)) ? rule : rule.replace(/[^\n]/g, ' '))
    const found = auditCss(source, { primitiveSheet: PRIMITIVE_SHEETS.has(basename(path)) })
    if (METRICS.some((metric) => found[metric].length > 0)) files[relative(root, path)] = found
  }
  return files
}

export function countsOf(audit) {
  /** @type {Record<string, Record<string, number>>} */
  const counts = {}
  for (const [file, found] of Object.entries(audit)) {
    counts[file] = Object.fromEntries(METRICS.map((metric) => [metric, found[metric].length]))
  }
  return counts
}

export function totalsOf(counts) {
  const totals = Object.fromEntries(METRICS.map((metric) => [metric, 0]))
  for (const fileCounts of Object.values(counts)) {
    for (const metric of METRICS) totals[metric] += fileCounts[metric] ?? 0
  }
  return totals
}

export function readBaseline(path = baselinePath) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

/**
 * Lists every file/metric whose current count exceeds the baseline. A metric
 * the baseline has never recorded is being introduced: its first `--write`
 * records today's debt, and from then on it can only shrink like the others.
 */
export function regressions(counts, baseline) {
  const out = []
  const recorded = METRICS.filter((metric) => baseline.rules?.[metric] !== undefined)
  for (const [file, fileCounts] of Object.entries(counts)) {
    for (const metric of recorded) {
      const allowed = baseline.files[file]?.[metric] ?? 0
      if (fileCounts[metric] > allowed) out.push({ file, metric, allowed, actual: fileCounts[metric] })
    }
  }
  return out
}

function main(argv) {
  const audit = auditRenderer()
  const counts = countsOf(audit)
  const totals = totalsOf(counts)
  const verbose = argv.includes('--verbose')
  const write = (path) => writeFileSync(path, `${JSON.stringify({ rules: METRIC_RULES, totals, files: counts }, null, 2)}\n`)
  if (argv.includes('--init')) {
    // Bootstrap only: an existing baseline can never be re-recorded upward.
    if (existsSync(baselinePath)) throw new Error('baseline exists; use --write, which only lowers it')
    write(baselinePath)
    console.log(`baseline initialised: ${JSON.stringify(totals)}`)
    return
  }
  const baseline = readBaseline()
  const grown = regressions(counts, baseline)

  if (argv.includes('--write')) {
    if (grown.length > 0) {
      for (const item of grown) console.error(`refusing to raise ${item.file} ${item.metric}: ${item.allowed} -> ${item.actual}`)
      console.error('The baseline only shrinks. Fix the new debt instead of recording it.')
      process.exitCode = 1
      return
    }
    write(baselinePath)
    console.log(`baseline written: ${JSON.stringify(totals)}`)
    return
  }

  for (const [file, found] of Object.entries(audit)) {
    const summary = METRICS.filter((metric) => found[metric].length > 0).map((metric) => `${metric} ${found[metric].length}`)
    console.log(`${file}: ${summary.join(', ')}`)
    if (verbose) {
      for (const metric of METRICS) for (const item of found[metric]) console.log(`  ${metric} L${item.line} ${item.text}`)
    }
  }
  console.log(`\ntotal: ${JSON.stringify(totals)}  baseline: ${JSON.stringify(baseline.totals)}`)
  if (grown.length > 0) {
    for (const item of grown) console.error(`design debt grew: ${item.file} ${item.metric} ${item.allowed} -> ${item.actual}`)
    process.exitCode = 1
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv.slice(2))
