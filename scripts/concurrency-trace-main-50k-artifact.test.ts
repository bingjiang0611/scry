import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WORKLOAD_STEPS } from './fixtures/concurrency-trace-workload'
import { MAIN_50K_FIXED_ITEMS, MAIN_50K_STAGE_COUNTS } from './fixtures/concurrency-trace-main-50k-sample'
import { stageItemCounts } from './fixtures/concurrency-trace-main-trial'

interface SourceIdentity { status: string; files: Record<string, string>; note?: string; reason?: string }
interface VerifiedArtifact {
  manifestPath: string
  bundlePath: string
  manifestSha256: string
  bundle: { bytes: number; sha256: string }
  buildSource: SourceIdentity
  buildLauncherSource: SourceIdentity
  currentSource: SourceIdentity
  sourceDrift: string[] | null
  driftReason: string | null
}
interface ArtifactModule {
  PROJECT_ROOT: string
  MAIN_TRIAL_ENTRY: string
  FIXED_ITEMS: number
  MEASUREMENT_SOURCES: string[]
  LAUNCHER_SOURCES: string[]
  selectedIdentity(base: string, files: string[]): SourceIdentity
  requiredIdentity(base: string, files: string[]): SourceIdentity
  verifyArtifact(input: { artifactDir: string }): VerifiedArtifact
}
interface CellReportModule {
  EXPECTED_STEPS: string[]
  EXPECTED_STAGE_COUNTS: number[]
}
interface LauncherModule {
  identityIssues(before: Record<string, unknown>, after: Record<string, unknown>): string[]
}

let artifact: ArtifactModule
let launcher: LauncherModule
let cellReport: CellReportModule
beforeAll(async () => {
  artifact = await import(new URL('./fixtures/concurrency-trace-main-artifact.mjs', import.meta.url).href) as ArtifactModule
  launcher = await import(new URL('./concurrency-trace-main-50k.mjs', import.meta.url).href) as LauncherModule
  cellReport = await import(new URL('./fixtures/concurrency-trace-main-cell-report.mjs', import.meta.url).href) as CellReportModule
})

const directories: string[] = []
afterAll(() => { for (const directory of directories) rmSync(directory, { recursive: true, force: true }) })

const OLD_SOURCE = 'scripts/fixtures/concurrency-trace-main-trial.ts'

/**
 * A frozen artifact: bundle bytes that match their manifest, but a manifest whose build-time source identity
 * differs from the tree reading it now, as happens to any baseline after later source edits.
 */
const makeFrozenArtifact = (): { dir: string, tampered: string } => {
  const dir = mkdtempSync(join(tmpdir(), 'scry-main-50k-artifact-'))
  directories.push(dir)
  const bytes = Buffer.from('// frozen baseline bundle\nmodule.exports = 1\n')
  writeFileSync(join(dir, 'main.cjs'), bytes)
  const current = artifact.selectedIdentity(artifact.PROJECT_ROOT, artifact.MEASUREMENT_SOURCES)
  const oldHash = 'c'.repeat(64)
  const manifest = {
    schema: 1,
    entry: artifact.MAIN_TRIAL_ENTRY,
    k: artifact.FIXED_ITEMS,
    bundle: { file: 'main.cjs', sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length },
    builtAtEpochMs: 1_800_000_000_000,
    bundler: 'fixture',
    buildSource: { ...current, files: { ...current.files, [OLD_SOURCE]: oldHash } },
    launcherSource: artifact.selectedIdentity(artifact.PROJECT_ROOT, artifact.LAUNCHER_SOURCES)
  }
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  return { dir, tampered: oldHash }
}

const fingerprint = (dir: string) => ({
  listing: readdirSync(dir).sort().join(','),
  bundle: statSync(join(dir, 'main.cjs')).mtimeMs,
  bundleHash: createHash('sha256').update(readFileSync(join(dir, 'main.cjs'))).digest('hex'),
  manifest: readFileSync(join(dir, 'manifest.json'), 'utf8')
})

describe('50k trial artifact contract', () => {
  it('keeps the launcher literals identical to the fixture contract', () => {
    expect(artifact.FIXED_ITEMS).toBe(MAIN_50K_FIXED_ITEMS)
    expect(cellReport.EXPECTED_STEPS).toEqual([...WORKLOAD_STEPS])
    expect(cellReport.EXPECTED_STAGE_COUNTS).toEqual([...stageItemCounts(50_000)])
    expect([...MAIN_50K_STAGE_COUNTS]).toEqual([...stageItemCounts(50_000)])
  })

  it('runs a frozen baseline whose build-time sources differ, and never rewrites its identity', () => {
    const { dir, tampered } = makeFrozenArtifact()
    const before = fingerprint(dir)
    const verified = artifact.verifyArtifact({ artifactDir: dir })
    // The bundle itself is what runs, so the drift is disclosed instead of refusing the baseline.
    expect(verified.bundle.bytes).toBe(statSync(join(dir, 'main.cjs')).size)
    expect(verified.manifestSha256).toBe(createHash('sha256').update(before.manifest).digest('hex'))
    expect(verified.sourceDrift).toEqual([OLD_SOURCE])
    // Build-time identity stays exactly what the build recorded; the current tree is reported beside it.
    expect(verified.buildSource.files[OLD_SOURCE]).toBe(tampered)
    expect(verified.currentSource.files[OLD_SOURCE]).not.toBe(tampered)
    expect(verified.currentSource.status).toBe('measured')
    expect(verified.buildLauncherSource.status).toBe('measured')
    // Consuming an artifact is read-only: same files, same mtimes, same manifest bytes, no rebuild.
    expect(fingerprint(dir)).toEqual(before)
  })

  it('refuses a bundle that does not match its manifest instead of rebuilding it', () => {
    const { dir } = makeFrozenArtifact()
    const manifestPath = join(dir, 'manifest.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { bundle: { sha256: string } }
    manifest.bundle.sha256 = 'a'.repeat(64)
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    const before = fingerprint(dir)
    expect(() => artifact.verifyArtifact({ artifactDir: dir })).toThrow(/does not match its manifest/)
    expect(fingerprint(dir)).toEqual(before)
  })

  it('detects a changed manifest after the run even though the bundle is unchanged', () => {
    const { dir } = makeFrozenArtifact()
    const first = artifact.verifyArtifact({ artifactDir: dir })
    const manifestPath = join(dir, 'manifest.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { builtAtEpochMs: number }
    manifest.builtAtEpochMs += 1
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    const second = artifact.verifyArtifact({ artifactDir: dir })
    expect(second.bundle.sha256).toBe(first.bundle.sha256)
    expect(second.manifestSha256).not.toBe(first.manifestSha256)
    const before = { bundleSha256: first.bundle.sha256, manifestSha256: first.manifestSha256, launcherFiles: first.currentSource.files }
    const after = { bundleSha256: second.bundle.sha256, manifestSha256: second.manifestSha256, launcherFiles: second.currentSource.files }
    expect(launcher.identityIssues(before, after)).toEqual(['the artifact manifest changed during the run'])
  })

  it('detects a launcher helper that changed during the run', () => {
    const files = artifact.selectedIdentity(artifact.PROJECT_ROOT, artifact.LAUNCHER_SOURCES).files
    const before = { bundleSha256: 'b'.repeat(64), manifestSha256: 'm', launcherFiles: { ...files } }
    const after = { bundleSha256: 'b'.repeat(64), manifestSha256: 'm', launcherFiles: { ...files, [artifact.LAUNCHER_SOURCES[0]]: 'd'.repeat(64) } }
    expect(launcher.identityIssues(before, after)).toEqual([`the launcher helper ${artifact.LAUNCHER_SOURCES[0]} changed during the run`])
    expect(launcher.identityIssues(before, before)).toEqual([])
  })

  it('refuses to build a manifest without sources', () => {
    // A build that cannot read its sources must fail rather than emit a manifest with no provenance.
    expect(() => artifact.requiredIdentity(artifact.PROJECT_ROOT, ['scripts/fixtures/not-a-real-source.ts'])).toThrow(/without its sources/)
    const unavailable = artifact.selectedIdentity(artifact.PROJECT_ROOT, ['scripts/fixtures/not-a-real-source.ts'])
    expect(unavailable.status).toBe('unavailable')
    expect(unavailable.reason).toMatch(/could not hash the selected sources/)
  })
})
