import { describe, expect, it } from 'vitest'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { nativeHarnessFiles } from './performance-native.mjs'

const manifestSource = new URL('./performance-paths.json', import.meta.url)
const { pathFiles, ...header }: { pathFiles: string[] } = JSON.parse(readFileSync(manifestSource, 'utf8'))
const catalogue: { paths: Array<{ sources: string[] }> } = {
  ...header,
  paths: pathFiles.flatMap(file => JSON.parse(readFileSync(new URL(file, import.meta.url), 'utf8')))
}
const reportSource = new URL('./performance-report.mjs', import.meta.url)
const journalSource = new URL('./performance-journal-files.mjs', import.meta.url)
const catalogueModuleSource = new URL('./performance-catalogue.mjs', import.meta.url)
const budgetsSource = new URL('./performance-budgets.json', import.meta.url)

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'scry-performance-catalogue-')))
  mkdirSync(join(root, 'scripts'), { recursive: true })
  for (const source of new Set(catalogue.paths.flatMap(path => path.sources))) {
    const target = join(root, source)
    if (basename(source).includes('.')) {
      mkdirSync(join(target, '..'), { recursive: true })
      writeFileSync(target, '')
    } else mkdirSync(target, { recursive: true })
  }
  copyFileSync(reportSource, join(root, 'scripts/performance-report.mjs'))
  copyFileSync(journalSource, join(root, 'scripts/performance-journal-files.mjs'))
  copyFileSync(catalogueModuleSource, join(root, 'scripts/performance-catalogue.mjs'))
  copyFileSync(budgetsSource, join(root, 'scripts/performance-budgets.json'))
  copyFileSync(manifestSource, join(root, 'scripts/performance-paths.json'))
  for (const file of pathFiles) copyFileSync(new URL(file, import.meta.url), join(root, 'scripts', file))
  writeFileSync(join(root, 'src/main/index.ts'), "handleTrusted('agent:detectFast', () => {})\nnew PerformanceTrace('app.startup')")
  writeFileSync(join(root, 'src/main/live-trace-ingestion.ts'), "new PerformanceTrace('agent.trace_content')")
  writeFileSync(join(root, 'src/main/conversation-app-ipc.ts'), "deps.register('conversation:create', () => {})")
  writeFileSync(join(root, 'src/main/workflow-ipc.ts'), "register('workflow:plan', () => {})")
  writeFileSync(join(root, 'src/main/workflow-template-ipc.ts'), "register('workflow:extractTemplate', () => {})")
  writeFileSync(join(root, 'src/main/git.ts'), "register('agent:gitDiff', () => {})")
  writeFileSync(join(root, 'src/main/source-control/ipc.ts'), "register(`sourceControl:${method}`, handler)")
  return root
}

function inventory(root: string) {
  return spawnSync(process.execPath, [join(root, 'scripts/performance-report.mjs'), 'inventory'], { encoding: 'utf8' })
}

describe('performance catalogue literal discovery', () => {
  it('binds every physical catalogue input into native fingerprints and fails closed on a missing fragment', () => {
    for (const file of ['scripts/performance-paths.json', 'scripts/performance-catalogue.mjs', ...pathFiles.map(file => `scripts/${file}`)]) {
      expect(nativeHarnessFiles).toContain(file)
    }
    const root = fixture()
    try {
      rmSync(join(root, 'scripts', pathFiles[0]))
      const missing = inventory(root)
      expect(missing.status).toBe(1)
      expect(missing.stderr).toContain('ENOENT')
      expect(missing.stderr).toContain(pathFiles[0])
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('accepts a healthy fixture and rejects literals in each extracted module', () => {
    const root = fixture()
    try {
      const healthy = inventory(root)
      expect(healthy.status, healthy.stderr).toBe(0)
      expect(JSON.parse(healthy.stdout)).toEqual(catalogue)
      const cases = [
        ['conversation-app-ipc.ts', "deps.register('unclassified.conversation', () => {})"],
        ['analytics-ipc.ts', "deps.handleTrusted('unclassified.analytics', () => {})"],
        ['agent-context-ipc.ts', "deps.handleTrusted('unclassified.context', () => {})"],
        ['provider-discovery-ipc.ts', "deps.handleTrusted('unclassified.provider', () => {})"],
        ['run-ipc.ts', "deps.handleTrusted('unclassified.run', () => {})"],
        ['session-deletion-ipc.ts', "deps.handleTrusted('unclassified.deletion', () => {})"],
        ['recorder-content-ipc.ts', "deps.handleTrusted('unclassified.recorder', () => {})"],
        ['session-fork-ipc.ts', "deps.handleTrusted('unclassified.fork', () => {})"],
        ['workflow-ipc.ts', "register('unclassified.workflow', () => {})"],
        ['workflow-template-ipc.ts', "register('unclassified.template', () => {})"],
        ['git.ts', "register('unclassified.git', () => {})"]
      ]
      for (const [file, literal] of cases) {
        const target = join(root, 'src/main', file)
        writeFileSync(target, readFileSync(target, 'utf8') + `\n${literal}`)
        const result = inventory(root)
        expect(result.status, `${file}: ${result.stderr}`).toBe(1)
        expect(result.stderr).toContain('Unmapped channel: unclassified.')
        writeFileSync(target, readFileSync(target, 'utf8').replace(`\n${literal}`, ''))
      }
      writeFileSync(join(root, 'src/main/new-production-module.ts'), "register('unclassified.new-module', () => {})")
      const newModuleResult = inventory(root)
      expect(newModuleResult.status).toBe(1)
      expect(newModuleResult.stderr).toContain('Unmapped channel: unclassified.new-module')
      rmSync(join(root, 'src/main/new-production-module.ts'))
      writeFileSync(join(root, 'src/main/new-production-module.ts'), "new PerformanceTrace('unclassified.trace')")
      const traceResult = inventory(root)
      expect(traceResult.status).toBe(1)
      expect(traceResult.stderr).toContain('Unmapped trace: unclassified.trace')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
