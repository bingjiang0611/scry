import { describe, expect, it } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

// P3's first step: the host assembly must be able to run outside Electron. That is
// only true if nothing it imports — transitively, through relative imports — needs
// the `electron` runtime. Type-only imports are erased before the module runs, so
// they do not count; a value import that grows out of a type import would.
const ENTRY = resolve(__dirname, 'host-runtime.ts')
const MAIN_ENTRY = resolve(__dirname, '../main/bootstrap/remote-host.ts')
const IMPORT = /import\s+(type\s+)?([\s\S]*?)\s+from\s+'([^']+)'/g

function isValueImport(modifier: string | undefined, specifiers: string): boolean {
  if (modifier) return false
  const parts = specifiers.replace(/[{}]/g, ' ').split(',').map((part) => part.trim()).filter(Boolean)
  // `import { type A, type B }` is fully erased as well.
  return parts.length > 0 && parts.some((part) => !part.startsWith('type '))
}

// Comments mention imports too; a commented-out path must not become an edge.
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

function importsOf(source: string): Array<{ specifier: string; value: boolean }> {
  return [...stripComments(source).matchAll(IMPORT)].map((match) => ({ specifier: match[3]!, value: isValueImport(match[1], match[2]!) }))
}

function resolveRelative(from: string, specifier: string): string | undefined {
  const base = resolve(dirname(from), specifier)
  for (const candidate of [`${base}.ts`, `${base}.tsx`, resolve(base, 'index.ts'), resolve(base, 'index.tsx')]) {
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

// Follows the relative value-import graph. Node builtins and packages are skipped:
// they cannot import this project's modules, so `electron` is only checked as a
// specifier wherever this project reaches for it.
function electronDependents(entry: string): { files: number; electron: string[] } {
  const seen = new Set<string>()
  const electron: string[] = []
  const queue = [entry]
  const route = new Map<string, string>()
  while (queue.length > 0) {
    const file = queue.pop()!
    if (seen.has(file)) continue
    seen.add(file)
    for (const { specifier, value } of importsOf(readFileSync(file, 'utf8'))) {
      // Erased type imports cannot pull a runtime dependency.
      if (!value) continue
      if (specifier === 'electron') { electron.push(`${file} <- ${route.get(file) ?? '?'}`); continue }
      if (!specifier.startsWith('.')) continue
      const target = resolveRelative(file, specifier)
      if (target) { if (!route.has(target)) route.set(target, file); queue.push(target) }
    }
  }
  return { files: seen.size, electron: [...new Set(electron)] }
}

describe('host runtime has no Electron dependency', () => {
  it('never needs the electron runtime through a value import', () => {
    const { files, electron } = electronDependents(ENTRY)
    // A graph of only the entry would make this assertion meaningless.
    expect(files).toBeGreaterThan(20)
    expect(electron).toEqual([])
  })

  // The checker must be able to fail: Electron main imports it directly.
  it('detects Electron in a module that really imports it', () => {
    expect(electronDependents(MAIN_ENTRY).electron.some((entry) => entry.startsWith(MAIN_ENTRY))).toBe(true)
  })
})
