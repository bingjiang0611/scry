import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PROVIDER_LABELS } from '../../shared/provider.js'
import { listRecords, listRecordSummaries, recordSummaryPath } from './store.js'
import { commitRecord } from './store.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function dataRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'scry-record-summary-'))
  roots.push(root)
  return join(root, '.scry')
}

const empty = () => ({ status: 'available' as const, quality: 'exact' as const, source: ['fixture'], value: [] })

function draft(sequence: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1, recordKind: 'agent_turn', recordId: `${sequence}`.padStart(2, '0').repeat(16), recorderVersion: '0.2.85',
    workspace: { id: 'fixture', root: '/repo' }, provider: { id: sequence % 2 === 0 ? 'codex' : 'claude' },
    sessionId: `session-${sequence % 3}`, generation: sequence, turnIndex: sequence * 2,
    startedAt: '2026-01-01T00:00:00.000Z', completedAt: '2026-01-01T00:00:01.000Z', durationMs: 1_000, status: 'completed',
    user: { status: 'available', quality: 'exact', source: ['fixture'], value: { text: 'x' } },
    assistant: { status: 'available', quality: 'exact', source: ['fixture'], value: { text: 'y' } },
    tools: empty(), skills: empty(), mcps: empty(), hooks: empty(),
    usage: { status: 'unavailable', quality: 'unavailable', source: [] },
    files: empty(), diff: empty(), dangerousOperations: empty(), errors: empty(),
    ...overrides
  }
}

async function seed(dataRootPath: string, count: number): Promise<void> {
  for (let sequence = 1; sequence <= count; sequence++) {
    await commitRecord(dataRootPath, draft(sequence, sequence % 2 === 0 ? { providerTurnId: `turn-${sequence}` } : {}) as never)
  }
}

/** What the summary is allowed to say: the same fields, in the same order, from the same records. */
async function fromFullParse(dataRootPath: string): Promise<unknown[]> {
  return (await listRecords(dataRootPath)).map((record) => ({
    name: `${String(record.sequence).padStart(20, '0')}-${record.recordId}.json`,
    sequence: record.sequence,
    recordId: record.recordId,
    provider: record.provider.id,
    sessionId: record.sessionId,
    generation: record.generation,
    turnIndex: record.turnIndex,
    providerTurnId: record.providerTurnId ?? null
  }))
}

describe('record summaries are the same answer as a full parse', () => {
  it('matches every record, in file order, when no cache exists yet', async () => {
    const root = await dataRoot()
    await seed(root, 5)
    expect(await listRecordSummaries(root)).toEqual(await fromFullParse(root))
    // A cold read leaves a cache behind, so this is a one-time cost per store.
    expect(JSON.parse(await readFile(recordSummaryPath(root), 'utf8')).schemaVersion).toBe(1)
  })

  it('matches the full parse on a warm read too', async () => {
    const root = await dataRoot()
    await seed(root, 4)
    await listRecordSummaries(root)
    expect(await listRecordSummaries(root)).toEqual(await fromFullParse(root))
  })

  it('keeps appending to the cache at commit, so a warm read sees the new record', async () => {
    const root = await dataRoot()
    await seed(root, 3)
    await listRecordSummaries(root)
    await commitRecord(root, draft(4) as never)
    expect(await listRecordSummaries(root)).toEqual(await fromFullParse(root))
  })
})

describe('the cache is thrown away whenever it cannot be trusted', () => {
  it.each([
    ['missing', async (path: string) => { await rm(path, { force: true }) }],
    ['not JSON', async (path: string) => { await writeFile(path, '{broken') }],
    ['unknown schema', async (path: string) => { await writeFile(path, JSON.stringify({ schemaVersion: 99, entries: [] })) }],
    ['truncated entries', async (path: string) => {
      const cached = JSON.parse(await readFile(path, 'utf8'))
      await writeFile(path, JSON.stringify({ ...cached, entries: cached.entries.slice(0, 2) }))
    }],
    ['an entry that is not a row', async (path: string) => {
      const cached = JSON.parse(await readFile(path, 'utf8'))
      await writeFile(path, JSON.stringify({ schemaVersion: 1, entries: [...cached.entries.slice(0, 2), ['x', 'not-a-provider', 's', 1, 1, null]] }))
    }],
    ['a row for a record that is gone', async (path: string) => {
      const cached = JSON.parse(await readFile(path, 'utf8'))
      await writeFile(path, JSON.stringify({ ...cached, entries: cached.entries.slice(0, -1) }))
    }]
  ])('falls back to a full parse when the cache is %s', async (_label, damage) => {
    const root = await dataRoot()
    await seed(root, 3)
    await listRecordSummaries(root)
    await damage(recordSummaryPath(root))
    expect(await listRecordSummaries(root)).toEqual(await fromFullParse(root))
    // The rebuild replaces the damaged cache instead of leaving it in place.
    expect(JSON.parse(await readFile(recordSummaryPath(root), 'utf8')).entries).toHaveLength(3)
  })

  it('stops reporting a record whose file was removed', async () => {
    const root = await dataRoot()
    await seed(root, 3)
    await listRecordSummaries(root)
    const [first] = await readdir(join(root, 'records'))
    await rm(join(root, 'records', first!))
    const summaries = await listRecordSummaries(root)
    expect(summaries.map((summary) => summary.name)).not.toContain(first)
    expect(summaries).toEqual(await fromFullParse(root))
  })

  it('still fails on a name-valid record whose content cannot be read', async () => {
    const root = await dataRoot()
    await seed(root, 2)
    await listRecordSummaries(root)
    // Damage a record and drop the cache: the rebuild parses, so it must fail like listRecords does.
    const [first] = await readdir(join(root, 'records'))
    await writeFile(join(root, 'records', first!), '{"schemaVersion":1}')
    await rm(recordSummaryPath(root), { force: true })
    await expect(listRecords(root)).rejects.toThrow()
    await expect(listRecordSummaries(root)).rejects.toThrow()
  })

  it('accepts a cached row for every host the shared definition knows', async () => {
    const root = await dataRoot()
    const providers = Object.keys(PROVIDER_LABELS)
    for (const [index, provider] of providers.entries()) {
      await commitRecord(root, draft(index + 1, { provider: { id: provider } }) as never)
    }
    await listRecordSummaries(root)
    // Same file names, unreadable bytes: only a usable cache can answer. A hand-listed subset of
    // hosts would reject the rows of whichever host was added last and fall through to a parse that
    // fails here - so this test fails the day such a list reappears.
    for (const name of await readdir(join(root, 'records'))) {
      await writeFile(join(root, 'records', name), '{"schemaVersion":1}')
    }
    await expect(listRecordSummaries(root)).resolves.toHaveLength(providers.length)
  })

  it('never parses the records on a warm read, which is the whole cost it removes', async () => {
    const root = await dataRoot()
    await seed(root, 2)
    await listRecordSummaries(root)
    const [first] = await readdir(join(root, 'records'))
    await writeFile(join(root, 'records', first!), '{"schemaVersion":1}')
    // Same file names, different bytes: no writer does this (commits only append, archive only moves
    // files out, content-repair never touches stored records). If one ever does, it must delete the
    // cache; this assertion is here so that requirement cannot be forgotten silently.
    await expect(listRecordSummaries(root)).resolves.toHaveLength(2)
    await expect(listRecords(root)).rejects.toThrow()
  })
})
