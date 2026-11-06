import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { markedSessions } from './attention'
import {
  recorderHasOpenTurn, recorderPendingHealth, recorderSessionRoot, recorderStaleOpenTurns,
  type RecorderOpenTurnState
} from './runtime-state'

const roots: string[] = []
async function fixture(): Promise<{ dataRoot: string; sessionDir: string }> {
  const dataRoot = await mkdtemp(join(tmpdir(), 'scry-runtime-diagnostics-'))
  roots.push(dataRoot)
  const sessionDir = recorderSessionRoot(dataRoot, 'claude', 'diagnostic-session')
  await mkdir(sessionDir, { recursive: true })
  return { dataRoot, sessionDir }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('runtime diagnostics without an attention index', () => {
  it('counts unreadable queued evidence without treating it as retryable work or replaying it', async () => {
    const { dataRoot, sessionDir } = await fixture()
    const inbox = join(sessionDir, 'inbox-failed')
    await mkdir(inbox)
    const entry = join(inbox, '000000000000001-pending.json')
    await writeFile(entry, '{broken event')
    await writeFile(`${entry}.failure.json`, '{broken sidecar')

    expect(await recorderPendingHealth(dataRoot)).toMatchObject({ pendingCount: 1 })
    expect(await recorderHasOpenTurn(dataRoot)).toBe(false)
    expect(await markedSessions(dataRoot)).toHaveLength(1)
    expect(await readFile(entry, 'utf8')).toBe('{broken event')
    expect(await readFile(`${entry}.failure.json`, 'utf8')).toBe('{broken sidecar')
    await expect(readFile(join(sessionDir, 'open.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each(['managed', 'closing', 'quarantined'] as const)('keeps %s evidence pending after rebuilding the index', async kind => {
    const { dataRoot, sessionDir } = await fixture()
    const open = openTurn(Date.now() - 86_400_000)
    if (kind === 'managed') open.managedByScry = true
    if (kind === 'closing') open.status = 'closing'
    const directory = kind === 'quarantined' ? join(sessionDir, 'turns', '00000001') : sessionDir
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, kind === 'quarantined' ? 'pending-open.json' : 'open.json'), JSON.stringify(open))

    expect(await recorderPendingHealth(dataRoot)).toMatchObject({ pendingCount: 1 })
    expect(await recorderStaleOpenTurns(dataRoot, 3_600_000)).toEqual([])
  })

  it.each([
    { kind: 'no transcript', stale: true },
    { kind: 'missing transcript', stale: true },
    { kind: 'old transcript', stale: true },
    { kind: 'recent transcript', stale: false },
    { kind: 'young turn', stale: false }
  ])('reports $kind without inventing a terminal event', async ({ kind, stale }) => {
    const { dataRoot, sessionDir } = await fixture()
    const now = Date.now()
    const expiryMs = 3_600_000
    const open = openTurn(now - (kind === 'young turn' ? 1_000 : 2 * expiryMs))
    if (['missing transcript', 'old transcript', 'recent transcript'].includes(kind)) {
      open.transcriptPath = join(sessionDir, 'transcript.jsonl')
      if (kind !== 'missing transcript') {
        await writeFile(open.transcriptPath, '')
        const touchedAt = new Date(kind === 'recent transcript' ? now : now - 2 * expiryMs)
        await utimes(open.transcriptPath, touchedAt, touchedAt)
      }
    }
    const source = JSON.stringify(open)
    await writeFile(join(sessionDir, 'open.json'), source)
    const expected = stale ? [{ provider: 'claude', sessionId: open.sessionId,
      startedAt: open.startedAt, ageMs: 2 * expiryMs }] : []

    // Call stale diagnostics first: it must not rely on a previous health/daemon call to rebuild.
    expect(await recorderStaleOpenTurns(dataRoot, expiryMs, now)).toEqual(expected)
    expect(await recorderStaleOpenTurns(dataRoot, expiryMs, now)).toEqual(expected)
    expect(await recorderPendingHealth(dataRoot)).toMatchObject({ pendingCount: 0 })
    expect(await readFile(join(sessionDir, 'open.json'), 'utf8')).toBe(source)
  })
})

function openTurn(startedAt: number): RecorderOpenTurnState {
  return { schemaVersion: 1, provider: 'claude', sessionId: 'diagnostic-session', generation: 1,
    turnIndex: 1, status: 'open', startedAt: new Date(startedAt).toISOString(),
    startFingerprint: 'diagnostic', captures: [] }
}
