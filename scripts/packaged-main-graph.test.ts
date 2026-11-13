import { describe, expect, it } from 'vitest'
import { reachableMainSources } from './packaged-main-graph.mjs'

const files: Record<string, string> = {
  'out/main/daemon-supervisor.js': 'import { a } from "./chunks/supervisor-1.js";\nimport "./chunks/side-2.js";\nconsole.log(a)',
  'out/main/chunks/supervisor-1.js': 'import { b } from "./shared-3.js";\nexport const a = process.env.ELECTRON_RUN_AS_NODE ?? b',
  'out/main/chunks/side-2.js': 'export {}',
  'out/main/chunks/shared-3.js': 'export const b = 1',
  'out/main/index.js': 'const unrelated = "ELECTRON_RUN_AS_NODE"'
}

describe('packaged main module graph', () => {
  it('follows the entry into the chunks it imports, transitively', () => {
    const graph = reachableMainSources((path) => files[path], 'out/main/daemon-supervisor.js')
    expect([...graph.keys()].sort()).toEqual([
      'out/main/chunks/shared-3.js', 'out/main/chunks/side-2.js', 'out/main/chunks/supervisor-1.js', 'out/main/daemon-supervisor.js'
    ])
    expect([...graph.values()].some((source) => source.includes('ELECTRON_RUN_AS_NODE'))).toBe(true)
  })

  it('does not credit an entry with a literal only an unrelated entry carries', () => {
    const graph = reachableMainSources((path) => files[path], 'out/main/chunks/side-2.js')
    expect([...graph.values()].some((source) => source.includes('ELECTRON_RUN_AS_NODE'))).toBe(false)
  })

  it('fails when an imported module is missing from the package', () => {
    expect(() => reachableMainSources((path) => path.endsWith('daemon-supervisor.js') ? files[path] : undefined, 'out/main/daemon-supervisor.js'))
      .toThrow('packaged main graph is missing out/main/chunks/')
  })
})
