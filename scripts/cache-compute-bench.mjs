import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import { createIncrementalMarkdownPlugin } from '../src/renderer/markdown-incremental.ts'
import { TurnStreamProjectionCache, recordTraceItemsChange } from '../src/renderer/turn-stream-projection.ts'

// Run with Node >=22.18 (native type stripping). Parse/projection only: timings
// exclude transforms, React/DOM, applyTraceBatch array copying, IPC and Providers.
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
function compare(name, control, candidate) {
  control(); candidate()
  const full = [], optimized = []
  for (let trial = 0; trial < 7; trial++) {
    const run = action => { const start = performance.now(); action(); return performance.now() - start }
    if (trial % 2 === 0) { full.push(run(control)); optimized.push(run(candidate)) }
    else { optimized.push(run(candidate)); full.push(run(control)) }
  }
  return { name, controlMedianMs: Number(median(full).toFixed(3)), candidateMedianMs: Number(median(optimized).toFixed(3)),
    ratio: Number((median(full) / median(optimized)).toFixed(2)),
    controlTrialsMs: full.map(value => Number(value.toFixed(3))), candidateTrialsMs: optimized.map(value => Number(value.toFixed(3))) }
}
const processor = plugin => {
  const instance = unified().use(remarkParse).use(remarkGfm)
  return plugin ? instance.use(plugin) : instance
}
const prefixes = {
  'closed-code-prefix': '```ts\n' + 'const value = "cached line"\n'.repeat(1400) + '```\n\nResponse: ',
  'ordinary-prose-control': 'An ordinary paragraph with no code boundary.\n\n'.repeat(850)
}
const results = []
let equivalentTrees = 0
for (const [name, prefix] of Object.entries(prefixes)) {
  const sequence = Array.from({ length: 60 }, (_, index) => prefix + 'new words '.repeat(index + 1))
  const plugin = createIncrementalMarkdownPlugin()
  for (const source of sequence) {
    assert.deepEqual(processor(plugin).parse(source), processor().parse(source))
    equivalentTrees++
  }
  results.push({ ...compare(name,
    () => { for (const source of sequence) processor().parse(source) },
    () => { const incremental = createIncrementalMarkdownPlugin(); for (const source of sequence) processor(incremental).parse(source) }),
    prefixChars: prefix.length, updates: sequence.length })
}
const structural = Array.from({ length: 10_000 }, (_, index) => ({ id: `tool-${index}`, runId: 'run', ts: '',
  kind: 'tool', stage: 'tool_use', tool: 'Read', toolUseId: `tool-${index}` }))
const sequence = () => Array.from({ length: 500 }, (_, index) => [...structural, {
  id: 'live', runId: 'run', ts: '', kind: 'model', stage: 'text_delta', messageId: 'message', text: 'token '.repeat(index + 1)
}])
const control = sequence(), candidate = sequence()
for (let index = 1; index < candidate.length; index++) recordTraceItemsChange(candidate[index], candidate[index - 1], structural.length)
const full = new TurnStreamProjectionCache(), optimized = new TurnStreamProjectionCache()
for (let index = 0; index < candidate.length; index++) {
  const left = full.project(control[index]), right = optimized.project(candidate[index])
  assert.deepEqual(left, right)
}
const project = sequence => { const cache = new TurnStreamProjectionCache(); for (const items of sequence) cache.project(items) }
results.push({ ...compare('production-provenance-vs-full-prefix-scan', () => project(control), () => project(candidate)),
  structuralEvents: structural.length, updates: candidate.length })
const sourceSha256 = {}
for (const path of ['../src/renderer/markdown-incremental.ts', '../src/renderer/turn-stream-projection.ts']) {
  sourceSha256[path] = createHash('sha256').update(await readFile(new URL(path, import.meta.url))).digest('hex')
}
console.log(JSON.stringify({ node: process.version, platform: `${process.platform}/${process.arch}`, sourceSha256,
  scope: 'Parse and projection only; not real App latency', equivalentTrees, equivalentProjections: candidate.length, results }, null, 2))
