import { posix } from 'node:path'

// The main bundle is split into chunks, so a literal an entry needs can live in a chunk
// the entry imports rather than in the entry file. A packaged check that asks "does this
// entry use X" must read the entry's own module graph: the entry plus every relative
// module it imports, transitively. Reading every main file would also accept a literal
// that only some unrelated entry carries.
const RELATIVE_IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*)["'](\.{1,2}\/[^"']+\.js)["']/g

/**
 * @param {(path: string) => string | undefined} read  POSIX path inside the package → source, or undefined when absent
 * @param {string} entry POSIX path of the entry, e.g. "out/main/daemon-supervisor.js"
 * @returns {Map<string, string>} every reachable module path → source
 */
export function reachableMainSources(read, entry) {
  const seen = new Map()
  const pending = [posix.normalize(entry)]
  while (pending.length > 0) {
    const path = pending.pop()
    if (seen.has(path)) continue
    const source = read(path)
    if (source === undefined) throw new Error(`packaged main graph is missing ${path}`)
    seen.set(path, source)
    for (const [, specifier] of source.matchAll(RELATIVE_IMPORT)) pending.push(posix.normalize(posix.join(posix.dirname(path), specifier)))
  }
  return seen
}
