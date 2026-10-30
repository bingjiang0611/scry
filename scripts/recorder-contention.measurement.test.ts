import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type { AgentTurnRecord } from '../src/shared/turn-record'

const io = vi.hoisted(() => ({ current: null as null | {
  attempts: number; conflicts: number; ownerReads: number; owners: number; peakOwners: number; acquiredAt: number; heldMs: number[]
} }))
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  return {
    ...actual,
    mkdir: async (...args: Parameters<typeof actual.mkdir>) => {
      const sample = io.current
      const lock = String(args[0]).endsWith('/locks/commit.lock')
      if (sample && lock) sample.attempts++
      try {
        const result = await actual.mkdir(...args)
        if (sample && lock) {
          sample.owners++
          sample.peakOwners = Math.max(sample.peakOwners, sample.owners)
          sample.acquiredAt = performance.now()
        }
        return result
      } catch (error) {
        if (sample && lock && (error as NodeJS.ErrnoException).code === 'EEXIST') sample.conflicts++
        throw error
      }
    },
    readFile: (...args: Parameters<typeof actual.readFile>) => {
      if (io.current && String(args[0]).endsWith('/locks/commit.lock/owner.json')) io.current.ownerReads++
      return actual.readFile(...args)
    },
    rm: async (...args: Parameters<typeof actual.rm>) => {
      const sample = io.current
      const result = await actual.rm(...args)
      if (sample && String(args[0]).endsWith('/locks/commit.lock')) {
        sample.heldMs.push(performance.now() - sample.acquiredAt)
        sample.owners--
      }
      return result
    }
  }
})

import { commitRecord, listRecords, verifyStore, RECORDER_VERSION } from '../src/core/turn-recorder/store'
const empty = () => ({ status: 'available' as const, quality: 'exact' as const, source: ['fixture'], value: [] })
function draft(root: string, index: number): Omit<AgentTurnRecord, 'sequence'> {
  return {
    schemaVersion: 1, recordKind: 'agent_turn', recordId: createHash('sha256').update(`record-${index}`).digest('hex'),
    recorderVersion: RECORDER_VERSION, workspace: { id: 'contention-fixture', root }, provider: { id: 'claude' },
    sessionId: `session-${index}`, generation: 1, turnIndex: 1, startedAt: '2026-10-30T00:00:00.000Z',
    completedAt: '2026-10-30T00:00:01.000Z', durationMs: 1000, status: 'completed',
    user: { status: 'available', quality: 'exact', source: ['fixture'], value: { text: 'u'.repeat(4096) } },
    assistant: { status: 'available', quality: 'exact', source: ['fixture'], value: { text: `${index}:${'a'.repeat(65536)}` } },
    tools: empty(), skills: empty(), mcps: empty(), hooks: empty(), files: empty(), diff: empty(),
    dangerousOperations: empty(), errors: empty(), usage: { status: 'unavailable', quality: 'unavailable', source: [] }
  }
}

it('measures real same-workspace commit contention without skipping native ownership, sequence or recovery verification', async () => {
  const samples = []
  for (let round = 0; round < 3; round++) for (const count of [1, 3, 5]) {
    const root = await mkdtemp(join(tmpdir(), 'scry-commit-contention-'))
    const counters = { attempts: 0, conflicts: 0, ownerReads: 0, owners: 0, peakOwners: 0, acquiredAt: 0, heldMs: [] as number[] }
    const drafts = Array.from({ length: count }, (_, index) => draft(root, index))
    const completedMs: number[] = []
    try {
      io.current = counters
      const started = performance.now()
      const committed = await Promise.all(drafts.map(async value => {
        const result = await commitRecord(root, value)
        completedMs.push(performance.now() - started)
        return result
      }))
      io.current = null
      expect(committed.every(result => result.status === 'committed')).toBe(true)
      expect(counters.peakOwners).toBe(1)
      expect(counters.owners).toBe(0)
      const records = await listRecords(root)
      expect(records.map(record => record.sequence)).toEqual(Array.from({ length: count }, (_, index) => index + 1))
      for (const record of records) expect(record.assistant).toEqual(drafts.find(value => value.recordId === record.recordId)!.assistant)
      expect(await verifyStore(root)).toMatchObject({ ok: true, records: count, errors: [] })
      samples.push({ round, count, completedMs, ...counters })
    } finally {
      io.current = null
      await rm(root, { recursive: true, force: true })
    }
  }
  console.log('SCRY_COMMIT_CONTENTION=' + JSON.stringify({ schema: 1, scope: 'same-process same-workspace canonical commits; real filesystem', samples }))
})
