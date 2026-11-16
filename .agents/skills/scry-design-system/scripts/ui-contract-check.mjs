#!/usr/bin/env node
// Pre-push review aid for renderer style and markup changes.
//
// Lists three things a design-system change can break without any unit test failing, each of
// which reached CI on PR #94:
//   1. Selectors that are new relative to the base. Deleting a rule can leave its prefix on the
//      next rule ('.mp-row .mp-icon-button {…}\n.mp-detail {' became '.mp-row .mp-detail {'),
//      which silently disables a live rule. Intended new selectors are fine; spliced ones are not.
//   2. Classes the base rendered that no renderer source mentions any more, while a UI smoke in
//      scripts/ still selects them.
//   3. UI smoke assertions that pin an exact computed value (px, weight, rect size). A deliberate
//      value change (6px gap snapped to 8px) needs the smoke updated in the same change.
//
// Usage: node .agents/skills/scry-design-system/scripts/ui-contract-check.mjs [base-ref]
// The base ref defaults to origin/main. Read-only; prints findings and always exits 0.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { selectors } from '../../../../scripts/design-system-audit.mjs'

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const base = process.argv[2] ?? 'origin/main'
const git = (...args) => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 << 20 })
const PRIMITIVE_EXCLUSION = ":not(:where(.btn, .icon-button, [role='tab'], .segmented > button))"
const normalize = (selector) => selector.replace(/\s+/g, ' ').trim()

function files(directory, test) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : files(path, test)
    return entry.isFile() && test(entry.name) ? [path] : []
  })
}

// New files have no base version; git's complaint about that is expected, so stderr is dropped.
function showAtBase(path) {
  try { return execFileSync('git', ['show', `${base}:${path}`], { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'ignore'] }) } catch { return null }
}

// 1. New selectors in changed stylesheets.
const changedCss = git('diff', '--name-only', base, '--', 'src/renderer').split('\n')
  .filter((path) => path.endsWith('.css') && existsSync(join(repoRoot, path)))
const newSelectors = []
for (const path of changedCss) {
  const before = showAtBase(path)
  if (before === null) continue
  const old = new Set([...selectors(before)].map(({ selector }) => normalize(selector)))
  for (const { selector, line } of selectors(readFileSync(join(repoRoot, path), 'utf8'))) {
    const current = normalize(selector)
    if (old.has(current) || old.has(normalize(current.replaceAll(PRIMITIVE_EXCLUSION, '')))) continue
    newSelectors.push(`${path}:${line}  ${current}`)
  }
}

// 2. Classes no longer rendered but still selected by UI smokes.
const CLASS_ATTRIBUTE = /className=(?:"([^"]*)"|\{`([^`]*)`\}|\{'([^']*)'\})/g
const classTokens = (text) => {
  const out = new Set()
  for (const match of text.matchAll(CLASS_ATTRIBUTE)) {
    // A token touching a template placeholder (`modal--${kind}`) is only a prefix, not a class.
    const value = (match[1] ?? match[2] ?? match[3]).replace(/\$\{[^}]*\}/g, '\u0000')
    for (const token of value.split(/\s+/)) if (/^[a-z][a-z0-9_-]+$/.test(token)) out.add(token)
  }
  return out
}
const isSource = (name) => /\.(?:tsx?|mts)$/.test(name) && !/\.test\./.test(name)
const baseSources = git('ls-tree', '-r', '--name-only', base, 'src/renderer').split('\n').filter((path) => path.endsWith('.tsx') && !path.includes('.test.'))
const baseClasses = new Set(baseSources.flatMap((path) => [...classTokens(showAtBase(path) ?? '')]))
const currentSource = files(join(repoRoot, 'src/renderer'), isSource).map((path) => readFileSync(path, 'utf8')).join('\n')
const smokeFiles = files(join(repoRoot, 'scripts'), (name) => name.endsWith('.mjs') && !name.includes('.test.'))
const smokeText = smokeFiles.map((path) => [relative(repoRoot, path), readFileSync(path, 'utf8')])
const goneButSelected = []
for (const name of [...baseClasses].sort()) {
  if (new RegExp(`\\b${name}\\b`).test(currentSource)) continue
  const selector = new RegExp(`\\.${name}(?![a-zA-Z0-9_-])`)
  const users = smokeText.filter(([, text]) => selector.test(text)).map(([path]) => path)
  if (users.length) goneButSelected.push(`.${name}  ←  ${users.join(', ')}`)
}

// 3. Smoke assertions that pin exact computed values.
const PINNED = /(?:===|!==)\s*'-?\d+(?:\.\d+)?px(?:\s+-?\d+(?:\.\d+)?px)*'|font(?:Weight|Size)\)?\s*(?:===|!==)\s*'\d+(?:px)?'|getBoundingClientRect\(\)\.(?:height|width)\s*(?:===|!==)\s*\d+/
const pinned = []
for (const [path, text] of smokeText) {
  text.split('\n').forEach((line, index) => {
    if (PINNED.test(line)) pinned.push(`${path}:${index + 1}  ${line.trim().slice(0, 160)}`)
  })
}

const section = (title, rows, empty) => {
  console.log(`\n## ${title} (${rows.length})`)
  console.log(rows.length ? rows.join('\n') : empty)
}
console.log(`UI contract check against ${base}`)
section('New selectors in changed stylesheets — confirm each is intended, not a spliced prefix', newSelectors, 'none')
section('Classes no longer rendered but still selected by UI smokes — update the smoke or keep the hook class', goneButSelected, 'none')
section('UI smoke assertions pinning exact values — re-check any whose value this change moves', pinned, 'none')
