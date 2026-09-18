import { access, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseRecorderConfig } from './config.js'
import { writeRecorderContent, readRecorderContent } from './content-store.js'
import { maintainRecorderStore } from './maintenance.js'
import { handleRecorderHook } from './recorder.js'
import { listRecords } from './store.js'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'scry-maintenance-'))
  roots.push(root)
  const raw = {
    schemaVersion: 1,
    enabled: true,
    workspaceId: 'maintenance',
    dataDir: '.scry',
    repositories: { mode: 'workspace-only' },
    storage: { maxBytes: 1024 * 1024, retentionDays: 1, orphanGraceHours: 1 },
    capture: { prompt: true, assistant: true, toolOutput: 'full', diff: false, hooks: true }
  }
  await writeFile(join(root, 'scry.config.json'), JSON.stringify(raw))
  const payload = (extra: Record<string, unknown>) => ({ session_id: 'maintenance-session', timestamp: '2026-01-01T00:00:00.000Z', ...extra })
  await handleRecorderHook({ provider: 'claude', event: 'UserPromptSubmit', workspace: root, payload: payload({ prompt: 'retain referenced' }) })
  await handleRecorderHook({ provider: 'claude', event: 'PreToolUse', workspace: root, payload: payload({ tool_name: 'Bash', tool_use_id: 'call', tool_input: { command: 'echo' } }) })
  await handleRecorderHook({ provider: 'claude', event: 'PostToolUse', workspace: root, payload: payload({ tool_name: 'Bash', tool_use_id: 'call', tool_response: 'referenced body' }) })
  await handleRecorderHook({ provider: 'claude', event: 'Stop', workspace: root, payload: payload({ assistant_response: 'done' }) })
  return { root, dataRoot: join(root, '.scry'), config: parseRecorderConfig(raw) }
}

function contentPath(dataRoot: string, sha256: string): string {
  return join(dataRoot, 'content', 'sha256', sha256.slice(0, 2), `${sha256}.bin`)
}

describe('recorder store maintenance', () => {
  it('plans first, then reclaims only aged unreferenced bodies/temps and compresses rotated logs', async () => {
    const { dataRoot, config } = await fixture()
    const now = Date.parse('2026-02-01T00:00:00.000Z')
    const old = new Date(now - 2 * 60 * 60 * 1_000)
    const orphan = await writeRecorderContent(dataRoot, 'x'.repeat(1024 * 1024 + 128), 'utf8')
    await utimes(contentPath(dataRoot, orphan.sha256), old, old)
    const temp = join(dataRoot, 'records', 'abandoned.tmp')
    await writeFile(temp, 'temporary')
    await utimes(temp, old, old)
    await mkdir(join(dataRoot, 'logs'), { recursive: true })
    await writeFile(join(dataRoot, 'logs', 'recorder.log.1'), 'old log\n'.repeat(100))
    const archivedBody = join(dataRoot, 'archive', 'old', 'content', 'sha256', 'aa', `${'a'.repeat(64)}.bin`)
    await mkdir(join(dataRoot, 'archive', 'old', 'content', 'sha256', 'aa'), { recursive: true })
    await writeFile(archivedBody, 'archived evidence')
    await utimes(archivedBody, old, old)

    const plan = await maintainRecorderStore(dataRoot, config, { now })
    expect(plan).toMatchObject({ applied: false, blockedBy: [], retentionEligible: [expect.objectContaining({ sequence: 1 })] })
    expect(plan.overQuotaBytes).toBeGreaterThan(0)
    expect(plan.orphanContent).toHaveLength(1)
    expect(plan.orphanContent[0].path).toContain(orphan.sha256)
    expect(plan.staleTemps).toHaveLength(1)
    await expect(access(contentPath(dataRoot, orphan.sha256))).resolves.toBeUndefined()

    const applied = await maintainRecorderStore(dataRoot, config, { now, apply: true })
    expect(applied.applied).toBe(true)
    expect(applied.reclaimedBytes).toBeGreaterThan(orphan.bytes)
    await expect(access(contentPath(dataRoot, orphan.sha256))).rejects.toThrow()
    await expect(access(temp)).rejects.toThrow()
    await expect(access(archivedBody)).resolves.toBeUndefined()
    expect(applied.compressedLogs).toEqual(['logs/recorder.log.1.gz'])
    expect((await readFile(join(dataRoot, 'logs', 'recorder.log.1.gz'))).length).toBeGreaterThan(0)

    const [record] = await listRecords(dataRoot)
    const referenced = record.tools.value![0].outputContent!.contentRef!
    await expect(readRecorderContent(dataRoot, referenced)).resolves.toBe('referenced body')
  })

  it('fails closed while an open turn or recent temp can still own an otherwise orphaned body', async () => {
    const { dataRoot, config } = await fixture()
    const now = Date.parse('2026-02-01T00:00:00.000Z')
    const old = new Date(now - 2 * 60 * 60 * 1_000)
    const orphan = await writeRecorderContent(dataRoot, 'unsettled', 'utf8')
    await utimes(contentPath(dataRoot, orphan.sha256), old, old)
    const runtime = join(dataRoot, 'runtime', 'claude', 'pending')
    await mkdir(runtime, { recursive: true })
    await writeFile(join(runtime, 'open.json'), '{}')
    const recentTemp = join(dataRoot, 'records', 'recent.tmp')
    await writeFile(recentTemp, 'live')
    await utimes(recentTemp, new Date(now), new Date(now))

    const report = await maintainRecorderStore(dataRoot, config, { now, apply: true })
    expect(report.applied).toBe(false)
    expect(report.blockedBy).toEqual(expect.arrayContaining(['open_turn', 'recent_temp']))
    await expect(access(contentPath(dataRoot, orphan.sha256))).resolves.toBeUndefined()
  })

  it('does not collect while archive recovery or another recorder lock has unknown ownership', async () => {
    const { dataRoot, config } = await fixture()
    const now = Date.parse('2026-02-01T00:00:00.000Z')
    await writeFile(join(dataRoot, 'archive-journal.json'), '{}')
    const lock = join(dataRoot, 'locks', 'record.lock')
    await mkdir(lock, { recursive: true })
    await writeFile(join(lock, 'owner.json'), '{}')

    const report = await maintainRecorderStore(dataRoot, config, { now, apply: true })
    expect(report.applied).toBe(false)
    expect(report.blockedBy).toEqual(expect.arrayContaining(['archive_journal', 'active_lock']))
  })

  it('rejects invalid retention and quota configuration instead of guessing', () => {
    const base = { schemaVersion: 1, workspaceId: 'x', dataDir: '.scry' }
    expect(() => parseRecorderConfig({ ...base, storage: { maxBytes: 100 } })).toThrow('storage.maxBytes')
    expect(() => parseRecorderConfig({ ...base, storage: { retentionDays: 0 } })).toThrow('storage.retentionDays')
    expect(() => parseRecorderConfig({ ...base, storage: { orphanGraceHours: 0 } })).toThrow('storage.orphanGraceHours')
  })
})
