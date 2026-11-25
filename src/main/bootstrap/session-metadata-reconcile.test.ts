import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createSessionMetadataRecorder, type PendingMetadataEntry } from './session-metadata-reconcile'

let dirs: string[] = []
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
})

function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'scry-sm-rec-'))
  dirs.push(dir)
  return join(dir, 'pending.json')
}

const entry: PendingMetadataEntry = {
  externalSessionId: 'native-1',
  providerId: 'pi',
  cwd: '/tmp/project',
  change: { kind: 'rename', title: '新名字' },
  actor: 'user:local'
}

// R10: the catalog file is already written when the event is attempted, so an authority that cannot
// record must not turn a completed rename into a failed one — and the missing event must still land.
describe('R10: session metadata recording survives an unavailable authority', () => {
  it('returns normally when recording throws and keeps the entry for reconciliation', async () => {
    const file = tempFile()
    const recorder = createSessionMetadataRecorder({
      file,
      record: () => { throw new Error('store exploded') }
    })
    expect(() => recorder.record(entry)).not.toThrow()
    await recorder.settled()
    const queued = JSON.parse(readFileSync(file, 'utf8')) as PendingMetadataEntry[]
    expect(queued).toEqual([entry])
  })

  it('queues an unavailable result and replays it once the authority can write', async () => {
    const file = tempFile()
    let available = false
    const recorded: PendingMetadataEntry[] = []
    const recorder = createSessionMetadataRecorder({
      file,
      record: (input) => {
        if (!available) return { status: 'unavailable', reason: 'session_not_found' }
        recorded.push(input)
        return { status: 'recorded' }
      }
    })
    recorder.record(entry)
    await recorder.settled()
    // A recorded change is never queued.
    available = true
    recorder.record({ ...entry, change: { kind: 'pin', pinned: true } })
    await recorder.settled()
    expect(recorded).toHaveLength(1)

    expect(await recorder.reconcile()).toBe(1)
    expect(recorded.map((input) => input.change)).toEqual([{ kind: 'pin', pinned: true }, entry.change])
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual([])
  })

  it('keeps an entry that still cannot be recorded at startup', async () => {
    const file = tempFile()
    writeFileSync(file, JSON.stringify([entry]))
    const recorder = createSessionMetadataRecorder({
      file,
      record: () => ({ status: 'unavailable', reason: 'session_not_found' })
    })
    expect(await recorder.reconcile()).toBe(0)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual([entry])
    rmSync(file, { force: true })
    expect(existsSync(file)).toBe(false)
  })
})
