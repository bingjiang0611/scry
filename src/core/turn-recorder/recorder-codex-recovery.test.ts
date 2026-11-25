import { appendFile, mkdtemp, open as openFile, readFile, rm, stat, writeFile, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { handleRecorderHook, recoverRecorder } from './recorder'
import { resetTranscriptReadStats, transcriptReadStats, TRANSCRIPT_WINDOW_LIMIT_BYTES } from './recorder-transcript-io'
import { resetTranscriptAnchorCache, resetTranscriptSnapshotCache } from './recorder-transcript-cache'
import { listRecords, readHealth } from './store'
import { recorderOpenPath, recorderSessionRoot } from './runtime-state'

const roots: string[] = []
afterEach(async () => {
  resetTranscriptAnchorCache()
  resetTranscriptSnapshotCache()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'scry-codex-cursor-'))
  roots.push(root)
  const dataRoot = join(root, '.scry')
  const env = { SCRY_AUTO_UPDATE: '0' }
  const timestamp = new Date().toISOString()
  const transcript = join(root, 'rollout.jsonl')
  const row = (type: string, turn_id = 'target') => JSON.stringify({ timestamp, type: 'event_msg', payload: { type, turn_id } }) + '\n'
  const bytes = TRANSCRIPT_WINDOW_LIMIT_BYTES + 1024 * 1024
  const handle = await openFile(transcript, 'w')
  try {
    await handle.writeFile(row('task_started'))
    await handle.truncate(bytes)
    await handle.write('\n', bytes - 1, 'utf8')
  } finally { await handle.close() }
  await writeFile(join(root, 'scry.config.json'), JSON.stringify({
    schemaVersion: 1, enabled: true, workspaceId: 'codex-cursor', dataDir: '.scry',
    repositories: { mode: 'workspace-only' },
    capture: { prompt: true, assistant: true, toolOutput: 'full', diff: false, hooks: true }
  }))
  const hook = await handleRecorderHook({
    workspace: root, provider: 'codex', event: 'turn.started', env, quiet: true,
    payload: { session_id: 'fixture', turn_id: 'target', rollout_path: transcript, cwd: root, timestamp, prompt: 'fixture' }
  })
  expect(hook.status).toBe('started')
  const poll = async (incremental = true) => {
    resetTranscriptReadStats()
    const result = await recoverRecorder(root, env, undefined, undefined, { incremental })
    return { ...result, ...transcriptReadStats() }
  }
  const openPath = recorderOpenPath(recorderSessionRoot(dataRoot, 'codex', 'fixture'))
  return { transcript, dataRoot, timestamp, row, poll, openPath }
}

it('seals the exact orphan terminal with partial evidence, without adopting the next turn', async () => {
  const f = await fixture()
  await appendFile(f.transcript, f.row('task_complete') + f.row('task_started', 'neighbor') + f.row('task_complete', 'neighbor'))
  expect(await f.poll()).toMatchObject({ recovered: 1, pending: 0, expired: 0 })
  const records = await listRecords(f.dataRoot)
  expect(records).toHaveLength(1)
  expect(records[0]).toMatchObject({
    providerTurnId: 'target', completedAt: f.timestamp, status: 'completed',
    termination: { value: { completedAtSource: 'provider_transcript' } },
    user: { status: 'available', value: { text: 'fixture' } },
    transcript: { status: 'unavailable', omissionReason: expect.stringContaining('truncated transcript window') }
  })
  expect(records[0].diff.status).not.toBe('available')
  expect(await f.poll()).toMatchObject({ recovered: 0, bytesRead: 0, anchorBytesScanned: 0 })
  expect(await readHealth(f.dataRoot)).toMatchObject({ codexTruncatedSealed: 1 })
})

it('finishes cleanup rather than returning pending if the terminal-only record was already committed', async () => {
  const f = await fixture()
  const open = await readFile(f.openPath)
  await appendFile(f.transcript, f.row('task_complete'))
  expect(await f.poll()).toMatchObject({ recovered: 1, pending: 0 })
  const [record] = await listRecords(f.dataRoot)

  // Model a crash after the record became durable but before open.json was removed.
  await writeFile(f.openPath, open)
  expect(await f.poll(false)).toMatchObject({ recovered: 1, pending: 0 })
  await expect(stat(f.openPath)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await listRecords(f.dataRoot)).toEqual([record])
  expect(await readHealth(f.dataRoot)).toMatchObject({ codexTruncatedSealed: 1 })
})

it('verifies an incremental resume when the witness edge bisects an emoji', async () => {
  const f = await fixture()
  // 65 UTF-16 code units: slicing the last 64 would start at the emoji's low surrogate.
  await appendFile(f.transcript, '😀' + 'a'.repeat(62) + '\n')
  expect(await f.poll()).toMatchObject({ recovered: 0, pending: 0 })
  const delta = f.row('task_complete')
  await appendFile(f.transcript, delta)
  expect(await f.poll()).toMatchObject({
    recovered: 1, pending: 0, bytesRead: Buffer.byteLength(delta) + 64, anchorBytesScanned: 0
  })
})

it('persists a miss independently of parser caches, reads only the delta, and waits for a complete row', async () => {
  const f = await fixture()
  await appendFile(f.transcript, f.row('task_complete', 'wrong'))
  const first = await f.poll()
  expect(first).toMatchObject({ recovered: 0 })
  expect(first.bytesRead).toBeGreaterThanOrEqual(TRANSCRIPT_WINDOW_LIMIT_BYTES)
  resetTranscriptAnchorCache()
  resetTranscriptSnapshotCache()
  expect(await f.poll()).toMatchObject({ recovered: 0, bytesRead: 0, anchorBytesScanned: 0 })
  const split = f.row('task_complete').trimEnd()
  await appendFile(f.transcript, split)
  expect(await f.poll()).toMatchObject({ recovered: 0, bytesRead: Buffer.byteLength(split) + 64, anchorBytesScanned: 0 })
  expect(await f.poll()).toMatchObject({ recovered: 0, bytesRead: 0, anchorBytesScanned: 0 })
  expect(await readHealth(f.dataRoot)).toMatchObject({ codexTruncatedUnchanged: 2 })
  await appendFile(f.transcript, '\n')
  expect(await f.poll()).toMatchObject({ recovered: 1, bytesRead: Buffer.byteLength(split) + 65, anchorBytesScanned: 0 })
})

it('re-enters the normal parser if the target start arrives later', async () => {
  const f = await fixture()
  await appendFile(f.transcript, f.row('task_complete', 'wrong'))
  expect(await f.poll()).toMatchObject({ recovered: 0 })
  await appendFile(f.transcript, f.row('task_started') + f.row('task_complete'))
  expect(await f.poll()).toMatchObject({ recovered: 1 })
  expect((await listRecords(f.dataRoot))[0].transcript).toMatchObject({
    status: 'available', value: { sourceCompleteness: 'complete' }
  })
})

it('discards the miss on rotation and recovers from a complete replacement transcript', async () => {
  const f = await fixture()
  await appendFile(f.transcript, f.row('task_complete', 'wrong'))
  expect(await f.poll()).toMatchObject({ recovered: 0 })
  await rename(f.transcript, `${f.transcript}.old`)
  await writeFile(f.transcript, f.row('task_started') + f.row('task_complete'))
  expect(await f.poll()).toMatchObject({ recovered: 1 })
  expect((await listRecords(f.dataRoot))[0]).toMatchObject({
    status: 'completed', transcript: { status: 'available', value: { sourceCompleteness: 'complete' } }
  })
})
