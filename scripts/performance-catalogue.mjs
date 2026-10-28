import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const { pathFiles, ...header } = JSON.parse(readFileSync(join(root, 'scripts/performance-paths.json'), 'utf8'))
export const catalogueFiles = ['scripts/performance-paths.json', ...pathFiles.map(file => `scripts/${file}`)]
export const catalogue = {
  ...header,
  paths: pathFiles.flatMap(file => JSON.parse(readFileSync(join(root, 'scripts', file), 'utf8')))
}
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
const productionMainFiles = directory => {
  const files = []
  const visit = current => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const file = join(current, entry.name)
      if (entry.isDirectory()) visit(file)
      else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && !entry.name.endsWith('.fixture.ts')) files.push(file)
    }
  }
  visit(directory)
  return files
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
  // Bounded single-quoted literal scan; dynamic namespaces rely on catalogue prefixes.
  for (const source of productionMainFiles(join(root, 'src/main'))) {
    const content = readFileSync(source, 'utf8')
    for (const [, channel] of content.matchAll(/(?:handleTrusted|register)\('([^']+)'/g)) {
      if (!catalogue.excludedChannels.includes(channel) && pathForOperation(`ipc.${channel}`) === 'unmapped') errors.push(`Unmapped channel: ${channel}`)
    }
    for (const [, name] of content.matchAll(/new PerformanceTrace\('([^']+)'/g)) {
      if (pathForOperation(name) === 'unmapped') errors.push(`Unmapped trace: ${name}`)
    }
  }
  if (errors.length) throw new Error(errors.join('\n'))
  return catalogue
}
