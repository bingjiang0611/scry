import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { validateNotification } from '../dist/queue.js'
import { validateReportResponse } from '../dist/uploader.js'
import { acquireDirectoryLock } from '../dist/util.js'

const envelope = (sequence, recordId) => ({
  version: 1,
  sequence,
  recordId,
  workspaceId: 'fixture',
  redactionVersion: 'agent-turn-v1',
  recordBytes: 2,
  record: '{}'
})

test('record commit notification is strict and identity-only', () => {
  const workspace = '/tmp/project'
  const value = {
    schemaVersion: 1,
    event: 'record-committed',
    workspace,
    provider: 'claude',
    sessionId: 'session-1',
    recordId: 'a'.repeat(32),
    sequence: 1
  }
  assert.deepEqual(validateNotification(value, workspace), value)
  assert.throws(() => validateNotification({ ...value, prompt: 'must not be here' }, workspace), /格式无效/)
})

test('report response must match every record and aggregate count', () => {
  const batch = [
    ['/tmp/1.json', envelope(1, 'a'.repeat(32))],
    ['/tmp/2.json', envelope(2, 'b'.repeat(32))]
  ]
  const response = {
    received: 2,
    inserted: 1,
    duplicated: 1,
    conflicted: 0,
    rejected: 0,
    items: [
      { index: 1, recordId: 'b'.repeat(32), status: 'duplicated' },
      { index: 0, recordId: 'a'.repeat(32), status: 'inserted' }
    ]
  }
  assert.deepEqual(validateReportResponse(response, batch).map((item) => item.status), ['inserted', 'duplicated'])
  assert.throws(() => validateReportResponse({ ...response, inserted: 2 }, batch), /计数不匹配/)
})

test('a fresh lock left by a dead process is reclaimed immediately', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'scry-uploader-lock-'))
  t.after(async () => await rm(root, { recursive: true, force: true }))
  const lock = join(root, 'lock')
  await mkdir(lock)
  await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: 2_147_483_647, createdAt: Date.now() }))
  const release = await acquireDirectoryLock(lock)
  await release()
})
