import { describe, expect, it } from 'vitest'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { electronDependents } from '../value-import-graph'

const REPO_ROOT = resolve(__dirname, '../../..')
const MAIN_ENTRY = resolve(REPO_ROOT, 'src/main/index.ts')
const ORCH_DIR = resolve(REPO_ROOT, 'src/host-runtime/orchestration')
const RECORDER_DIR = resolve(REPO_ROOT, 'src/core/turn-recorder')

const IMPORT_RE = /import\s+(type\s+)?([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g
const EXPORT_FROM_RE = /export\s+(type\s+)?(\*|\{[\s\S]*?\})\s+from\s+['"]([^'"]+)['"]/g
const SIDE_EFFECT_IMPORT_RE = /import\s+['"]([^'"]+)['"]/g
const REQUIRE_RE = /require\(\s*['"]([^'"]+)['"]\s*\)/g

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

function isValueImport(modifier: string | undefined, specifiers: string): boolean {
  if (modifier) return false
  const parts = specifiers
    .replace(/[{}]/g, ' ')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
  return parts.length > 0 && parts.some((part) => !part.startsWith('type '))
}

function listTsFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) {
      if (entry === 'recorder-tests' || entry === 'node_modules') continue
      out.push(...listTsFiles(full))
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts') && !entry.endsWith('.d.ts')) {
      out.push(full)
    }
  }
  return out
}

function collectRuntimeSpecifiers(file: string): string[] {
  const source = stripComments(readFileSync(file, 'utf8'))
  const specifiers: string[] = []
  for (const match of source.matchAll(IMPORT_RE)) {
    if (isValueImport(match[1], match[2] ?? '')) specifiers.push(match[3]!)
  }
  for (const match of source.matchAll(EXPORT_FROM_RE)) {
    if (!match[1] && (match[2] === '*' || isValueImport(undefined, match[2] ?? ''))) {
      specifiers.push(match[3]!)
    }
  }
  for (const match of source.matchAll(SIDE_EFFECT_IMPORT_RE)) {
    specifiers.push(match[1]!)
  }
  for (const match of source.matchAll(REQUIRE_RE)) {
    specifiers.push(match[1]!)
  }
  return specifiers
}

function resolveRelativeTs(from: string, specifier: string): string | undefined {
  const normalized = specifier.replace(/\.(?:m?js|cjs)$/, '')
  const base = resolve(dirname(from), normalized)
  const raw = resolve(dirname(from), specifier)
  const candidates = [
    raw,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.mts`,
    resolve(base, 'index.ts'),
    resolve(base, 'index.tsx')
  ]
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return candidate
    } catch {
    }
  }
  return undefined
}

function findReachableModules(entry: string, predicate: (target: string, specifier: string) => boolean): string[] {
  const seen = new Set<string>()
  const hits: string[] = []
  const queue = [entry]
  while (queue.length > 0) {
    const file = queue.pop()!
    if (seen.has(file)) continue
    seen.add(file)
    for (const specifier of collectRuntimeSpecifiers(file)) {
      if (predicate(file, specifier)) {
        hits.push(`${file} -> ${specifier}`)
        continue
      }
      if (!specifier.startsWith('.')) continue
      const target = resolveRelativeTs(file, specifier)
      if (target) {
        if (predicate(target, specifier)) hits.push(`${file} -> ${target}`)
        queue.push(target)
      }
    }
  }
  return hits
}

describe('P4-0 static single-writer and Recorder Core import boundaries', () => {
  it('Electron main never imports src/host-runtime/orchestration/ (Layer 3 single-writer)', () => {
    const violations = findReachableModules(
      MAIN_ENTRY,
      (target, specifier) =>
        target.startsWith(`${ORCH_DIR}/`) ||
        target === ORCH_DIR ||
        specifier.includes('host-runtime/orchestration')
    )
    expect(violations).toEqual([])

    const tmp = mkdtempSync(join(tmpdir(), 'scry-boundary-neg-'))
    try {
      const helper = join(tmp, 'reexport.ts')
      const fakeMain = join(tmp, 'fake-main.ts')
      const rel = resolve(ORCH_DIR, 'event-sink')
      writeFileSync(helper, `export { EventSink } from '${rel}.js'\n`)
      writeFileSync(fakeMain, `export { EventSink } from './reexport.js'\n`)
      const detected = findReachableModules(
        fakeMain,
        (target, specifier) =>
          target.startsWith(`${ORCH_DIR}/`) || specifier.includes('host-runtime/orchestration')
      )
      expect(detected.length).toBeGreaterThan(0)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('Recorder Core never transitively imports better-sqlite3 or orchestration modules (data §3.4)', () => {
    const files = listTsFiles(RECORDER_DIR)
    expect(files.length).toBeGreaterThan(0)
    const isForbidden = (target: string, specifier: string): boolean =>
      specifier === 'better-sqlite3' ||
      target.startsWith(`${ORCH_DIR}/`) ||
      specifier.includes('host-runtime/orchestration') ||
      specifier.includes('orchestration/')
    const violations: string[] = []
    for (const file of files) {
      violations.push(...findReachableModules(file, isForbidden))
    }
    expect(violations).toEqual([])

    const tmp = mkdtempSync(join(tmpdir(), 'scry-recorder-neg-'))
    try {
      const leaf = join(tmp, 'leaf.ts')
      const fakeRecorder = join(tmp, 'fake-recorder.ts')
      writeFileSync(leaf, `import Database from 'better-sqlite3'\nexport const db = Database\n`)
      writeFileSync(fakeRecorder, `export { db } from './leaf.js'\n`)
      expect(findReachableModules(fakeRecorder, isForbidden).length).toBeGreaterThan(0)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('orchestration modules stay on plain-Node boundary (never import electron)', () => {
    const files = listTsFiles(ORCH_DIR)
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      const { electron } = electronDependents(file)
      expect(electron, file).toEqual([])
    }
  })
})
