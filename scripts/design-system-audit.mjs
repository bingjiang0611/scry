#!/usr/bin/env node
// Design-system audit for renderer CSS.
//
// Lists declarations that bypass the token scales defined in
// src/renderer/styles-theme-shell.css, raw colors outside theme variables, and
// container button rules that would restyle the primitives. The renderer is held
// at zero findings by design-system.test.ts; this CLI prints them (`--verbose`
// for every line) and exits non-zero when there are any.
// Radius is enforced separately by radius-system.test.ts.
import { readFileSync, readdirSync } from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
export const rendererRoot = join(repoRoot, 'src/renderer')

export const METRICS = /** @type {const} */ (['fontSize', 'fontWeight', 'spacing', 'color', 'layer', 'buttonReset'])

export const METRIC_RULES = {
  fontSize: 'font-size / font shorthand uses a px literal instead of var(--text-*)',
  fontWeight: 'font-weight uses a number instead of var(--weight-*)',
  spacing: 'padding / margin / gap uses a px value off the 4px grid (1px hairline and 2px optical are allowed)',
  color: 'a non-token declaration uses a raw color literal instead of a theme variable',
  layer: 'z-index of 20 or more uses a literal instead of var(--layer-*); literals below 20 are for ordering inside one component',
  buttonReset: 'a container-wide `… button` rule does not exclude the primitives with :not(:where(.btn, .icon-button, [role=tab], .segmented > button)); rules that only set -webkit-app-region, pointer-events or user-select must not exclude them'
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

/** Yields `{ selector, line, properties }` for every style-rule selector (at-rule preludes excluded). */
export function* selectors(source) {
  const text = stripComments(source)
  for (const match of text.matchAll(/([^{};]+)\{/g)) {
    const prelude = match[1].trim()
    if (!prelude || prelude.startsWith('@')) continue
    const line = text.slice(0, match.index + match[0].indexOf(prelude)).split('\n').length
    const bodyStart = match.index + match[0].length
    const body = text.slice(bodyStart, text.indexOf('}', bodyStart))
    const properties = [...body.matchAll(/(?:^|;)\s*(-{0,2}[a-zA-Z][-a-zA-Z0-9_]*)\s*:/g)].map((item) => item[1].toLowerCase())
    for (const selector of splitSelectors(prelude)) yield { selector, line, properties }
  }
}

// `.panel button`, `.panel > button:hover`: a descendant rule whose subject is a bare button.
const CONTAINER_BUTTON = /[\s>]button(?::[a-z-]+(?:\([^()]*\))?)*$/
// `:not(:where(...))` keeps the rule's original specificity; a bare `:not(.btn, …)` would raise it.
const EXCLUDES_PRIMITIVES = /:not\(:where\(\.btn\b/
// Rules that only change behavior must reach every button, primitives included: a primitive
// left out of a macOS `-webkit-app-region: no-drag` rule would sit inside the window drag band.
const BEHAVIOR_PROPERTIES = new Set(['-webkit-app-region', 'pointer-events', 'user-select', '-webkit-user-select'])

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
    if (property === 'z-index' && /^-?\d+$/.test(value) && Math.abs(Number(value)) >= 20) found.layer.push({ line, text })
  }
  for (const { selector, line, properties } of primitiveSheet ? [] : selectors(source)) {
    if (!CONTAINER_BUTTON.test(selector) || EXCLUDES_PRIMITIVES.test(selector)) continue
    if (properties.length > 0 && properties.every((property) => BEHAVIOR_PROPERTIES.has(property))) continue
    found.buttonReset.push({ line, text: selector })
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

function main(argv) {
  const audit = auditRenderer()
  const verbose = argv.includes('--verbose')
  let total = 0
  for (const [file, found] of Object.entries(audit)) {
    const summary = METRICS.filter((metric) => found[metric].length > 0).map((metric) => `${metric} ${found[metric].length}`)
    console.log(`${file}: ${summary.join(', ')}`)
    for (const metric of METRICS) {
      total += found[metric].length
      if (verbose) for (const item of found[metric]) console.log(`  ${metric} L${item.line} ${item.text}`)
    }
  }
  if (total === 0) {
    console.log('design audit: no findings')
    return
  }
  console.error(`\ndesign audit: ${total} findings`)
  for (const [metric, rule] of Object.entries(METRIC_RULES)) console.error(`  ${metric}: ${rule}`)
  process.exitCode = 1
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv.slice(2))
