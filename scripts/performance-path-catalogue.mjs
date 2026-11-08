import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const source = JSON.parse(readFileSync(join(root, 'scripts/performance-paths.json'), 'utf8'))
export const catalogue = { ...source, paths: source.paths.flatMap(path => path.include
  ? JSON.parse(readFileSync(join(root, 'scripts', path.include), 'utf8')) : [path]) }
export const pathForOperation = name => catalogue.paths.find(path =>
  path.benchmarks?.includes(name) || path.operations.some(operation =>
    operation.endsWith(':') ? name.startsWith(operation) : name === operation)
)?.id ?? 'unmapped'

export function checkBenchmarkCoverage(policy) {
  if (!catalogue.paths.length) throw new Error('Empty performance path catalogue')
  const claimed = new Set()
  for (const path of catalogue.paths) {
    if (!path.benchmarks.length || path.benchmarks.some(name => !Object.hasOwn(policy.scenarios, name))) {
      throw new Error(`Missing executable benchmark coverage: ${path.id}`)
    }
    for (const name of path.benchmarks) {
      if (claimed.has(name)) throw new Error(`Benchmark assigned to multiple path groups: ${name}`)
      claimed.add(name)
    }
  }
  for (const name of Object.keys(policy.scenarios)) {
    if (!claimed.has(name)) throw new Error(`Unmapped benchmark scenario: ${name}`)
  }
}

export function checkCatalogue() {
  checkBenchmarkCoverage(JSON.parse(readFileSync(join(root, 'scripts/performance-budgets.json'), 'utf8')))
  const errors = []
  const ids = new Set()
  for (const path of catalogue.paths) {
    if (ids.has(path.id)) errors.push(`Duplicate path: ${path.id}`)
    ids.add(path.id)
    for (const source of path.sources) if (!existsSync(join(root, source))) errors.push(`Missing source: ${source}`)
  }
  // Cover the actual privileged entrypoints, including source-control registration and the
  // enumerated remote namespace. This check deliberately fails on new unclassified channels.
  for (const source of ['src/main/index.ts', 'src/main/source-control/ipc.ts']) {
    const content = readFileSync(join(root, source), 'utf8')
    for (const [, channel] of content.matchAll(/(?:handleTrusted|register)\('([^']+)'/g)) {
      if (!catalogue.excludedChannels.includes(channel) && pathForOperation(`ipc.${channel}`) === 'unmapped') errors.push(`Unmapped channel: ${channel}`)
    }
  }
  for (const source of ['src/main/index.ts', 'src/main/live-trace-ingestion.ts']) {
    for (const [, name] of readFileSync(join(root, source), 'utf8').matchAll(/new PerformanceTrace\('([^']+)'/g)) {
      if (pathForOperation(name) === 'unmapped') errors.push(`Unmapped trace: ${name}`)
    }
  }
  if (errors.length) throw new Error(errors.join('\n'))
  return catalogue
}
