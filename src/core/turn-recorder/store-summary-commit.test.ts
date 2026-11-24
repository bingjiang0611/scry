import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * The summary cache sits inside the commit path, so its failure modes must stay out of the commit
 * result: a record that was written is committed, whatever happened to a derived cache afterwards.
 */
const summary = vi.hoisted(() => ({ appendRecordSummary: vi.fn(), listRecordSummaries: vi.fn() }))
vi.mock('./store-summary.js', () => summary)

const { commitRecord, listRecords } = await import('./store.js')

const roots: string[] = []
afterEach(async () => {
  summary.appendRecordSummary.mockReset()
  summary.listRecordSummaries.mockReset()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const empty = () => ({ status: 'available' as const, quality: 'exact' as const, source: ['fixture'], value: [] })

function draft(): Record<string, unknown> {
  return {
    schemaVersion: 1, recordKind: 'agent_turn', recordId: 'a'.repeat(32), recorderVersion: '0.2.85',
    workspace: { id: 'fixture', root: '/repo' }, provider: { id: 'codex' }, sessionId: 'session-1',
    generation: 1, turnIndex: 1,
    startedAt: '2026-01-01T00:00:00.000Z', completedAt: '2026-01-01T00:00:01.000Z', durationMs: 1_000, status: 'completed',
    user: { status: 'available', quality: 'exact', source: ['fixture'], value: { text: 'x' } },
    assistant: { status: 'available', quality: 'exact', source: ['fixture'], value: { text: 'y' } },
    tools: empty(), skills: empty(), mcps: empty(), hooks: empty(),
    usage: { status: 'unavailable', quality: 'unavailable', source: [] },
    files: empty(), diff: empty(), dangerousOperations: empty(), errors: empty()
  }
}

describe('a derived summary never decides whether a commit succeeded', () => {
  it('keeps the commit successful when the cache cannot be written', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scry-record-summary-commit-'))
    roots.push(root)
    const dataRoot = join(root, '.scry')
    summary.appendRecordSummary.mockRejectedValue(new Error('summary cache is unwritable'))

    await expect(commitRecord(dataRoot, draft() as never)).resolves.toMatchObject({ status: 'committed', record: { sequence: 1 } })
    expect((await listRecords(dataRoot)).map((record) => record.recordId)).toEqual(['a'.repeat(32)])
    expect(summary.appendRecordSummary).toHaveBeenCalledTimes(1)
  })
})
