import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { evaluateBoundaryReport, scanMainImportBoundary } from './main-import-boundary.mjs'

const REPO_ROOT = resolve(import.meta.dirname, '..')

function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'scry-main-boundary-test-'))
  return run(dir).finally(() => rmSync(dir, { recursive: true, force: true }))
}

describe('S3 prep: scripts/main-import-boundary static ratchet and negative controls', () => {
  it('passes on current src/main/index.ts against ratchet baseline with zero orchestration violations', async () => {
    const baseline = JSON.parse(
      readFileSync(join(REPO_ROOT, 'scripts/main-import-boundary-baseline.json'), 'utf8')
    )
    const report = await scanMainImportBoundary('src/main/index.ts')
    expect(report.orchestrationImporters).toEqual([])
    const evaluation = evaluateBoundaryReport(report, baseline)
    expect(evaluation.ok).toBe(true)
    expect(evaluation.newViolations).toEqual({
      orchestrationImporters: [],
      forbiddenPackages: [],
      forbiddenModules: [],
      nonWhitelistedChildProcess: []
    })
  })

  it('negative control: fails when node-pty or better-sqlite3 is imported or dynamically required', async () => {
    await withTempDir(async (dir) => {
      const entry = join(dir, 'inject-pty.ts')
      writeFileSync(
        entry,
        `const pty = require('node-pty')\nconst sqlite = require('better-sqlite3')\nexport { pty, sqlite }\n`
      )
      const report = await scanMainImportBoundary(entry)
      const evaluation = evaluateBoundaryReport(report, null)
      expect(evaluation.ok).toBe(false)
      expect(evaluation.newViolations.forbiddenPackages.some((v: string) => v.includes('node-pty'))).toBe(true)
      expect(evaluation.newViolations.forbiddenPackages.some((v: string) => v.includes('better-sqlite3'))).toBe(true)
    })
  })

  it('negative control: fails when a non-whitelisted module imports node:child_process', async () => {
    await withTempDir(async (dir) => {
      const entry = join(dir, 'inject-spawn.ts')
      writeFileSync(entry, `import { spawn } from 'node:child_process'\nexport const run = () => spawn('echo', ['hi'])\n`)
      const report = await scanMainImportBoundary(entry)
      const evaluation = evaluateBoundaryReport(report, null)
      expect(evaluation.ok).toBe(false)
      expect(evaluation.newViolations.nonWhitelistedChildProcess.length).toBeGreaterThan(0)
    })
  })

  it('negative control: hard-fails on any orchestration import even if baseline is provided', async () => {
    await withTempDir(async (dir) => {
      const entry = join(dir, 'inject-orch.ts')
      const orchTarget = join(REPO_ROOT, 'src/host-runtime/orchestration/mode.ts')
      writeFileSync(entry, `import { parseOrchestrationMode } from ${JSON.stringify(orchTarget)}\nexport { parseOrchestrationMode }\n`)
      const report = await scanMainImportBoundary(entry)
      const baseline = JSON.parse(
        readFileSync(join(REPO_ROOT, 'scripts/main-import-boundary-baseline.json'), 'utf8')
      )
      const evaluation = evaluateBoundaryReport(report, baseline)
      expect(evaluation.ok).toBe(false)
      expect(evaluation.newViolations.orchestrationImporters.length).toBeGreaterThan(0)
    })
  })
})
