import { readFileSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const IMPORT = /import\s+(type\s+)?([\s\S]*?)\s+from\s+'([^']+)'/g

function isValueImport(modifier: string | undefined, specifiers: string): boolean {
  if (modifier) return false
  const parts = specifiers.replace(/[{}]/g, ' ').split(',').map((part) => part.trim()).filter(Boolean)
  return parts.length > 0 && parts.some((part) => !part.startsWith('type '))
}

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

export function electronDependents(entry: string): { files: number; electron: string[] } {
  const seen = new Set<string>()
  const electron: string[] = []
  const queue = [entry]
  const route = new Map<string, string>()
  while (queue.length > 0) {
    const file = queue.pop()!
    if (seen.has(file)) continue
    seen.add(file)
    for (const { specifier, value } of importsOf(readFileSync(file, 'utf8'))) {
      if (!value) continue
      if (specifier === 'electron') { electron.push(`${file} <- ${route.get(file) ?? '?'}`); continue }
      if (!specifier.startsWith('.')) continue
      const target = resolveRelative(file, specifier)
      if (target) { if (!route.has(target)) route.set(target, file); queue.push(target) }
    }
  }
  return { files: seen.size, electron: [...new Set(electron)] }
}
