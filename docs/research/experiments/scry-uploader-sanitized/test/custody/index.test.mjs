import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { fstatSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  finishCustody,
  pausePending,
  readReceipt,
  releaseDisabled,
  takeCustody
} from '../../dist/custody/index.js'

const id = (letter) => letter.repeat(32)
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), 'scry-custody-'))
  await writeFile(
    join(root, 'scry.config.json'),
    JSON.stringify({ schemaVersion: 1, workspaceId: 'fixture' })
  )
  await mkdir(join(root, '.scry', 'records'), { recursive: true })
  return root
}

function event(root, sequence, recordId, raw, extra = {}) {
  const name = `${String(sequence).padStart(20, '0')}-${recordId}.json`
  return {
    schemaVersion: 2,
    event: 'record-committed',
    workspace: root,
    provider: 'pi',
    sessionId: 'session',
    recordId,
    sequence,
    recordPath: `records/${name}`,
    sha256: sha256(raw),
    ...extra
  }
}

async function putRecord(root, sequence, recordId, raw) {
  const name = `${String(sequence).padStart(20, '0')}-${recordId}.json`
  await writeFile(join(root, '.scry', 'records', name), raw)
  return name
}

async function outboxEnvelope(root, sequence, recordId, record) {
  const upload = join(root, '.scry', 'upload')
  const name = `${String(sequence).padStart(20, '0')}-${recordId}.json`
  await mkdir(join(upload, 'outbox'), { recursive: true })
  await writeFile(
    join(upload, 'outbox', name),
    JSON.stringify({
      version: 1,
      sequence,
      recordId,
      workspaceId: 'fixture',
      redactionVersion: 'agent-turn-v1',
      recordBytes: Buffer.byteLength(record),
      record
    })
  )
}

test('custody replay is byte exact after the source is removed', async (t) => {
  const root = await workspace()
  t.after(() => rm(root, { recursive: true, force: true }))
  const recordId = id('a')
  const raw = Buffer.from('{"raw":true, "bytes":[0,255]}')
  const name = await putRecord(root, 1, recordId, raw)
  const receipt = await takeCustody(root, event(root, 1, recordId, raw))
  await rm(join(root, '.scry', 'records', name))
  const replay = await takeCustody(root, event(root, 1, recordId, raw))
  assert.equal(replay.sha256, receipt.sha256)
  assert.deepEqual(await readFile(join(root, '.scry', 'upload', 'outbox', 'committed', name)), raw)
})

test('directory fsync failure rejects both first custody and replay ACK', async (t) => {
  const root = await workspace()
  t.after(() => rm(root, { recursive: true, force: true }))
  const raw = Buffer.from('{"durable":true}')
  const recordId = id('e')
  const name = await putRecord(root, 1, recordId, raw)
  const handle = await open(root, 'r')
  const prototype = Object.getPrototypeOf(handle)
  await handle.close()
  const original = prototype.sync
  const inject = () =>
    t.mock.method(prototype, 'sync', function () {
      if (fstatSync(this.fd).isDirectory()) throw new Error('injected directory fsync failure')
      return original.call(this)
    })
  const first = inject()
  await assert.rejects(
    () => takeCustody(root, event(root, 1, recordId, raw)),
    /injected directory fsync failure/
  )
  first.mock.restore()
  await takeCustody(root, event(root, 1, recordId, raw))
  await rm(join(root, '.scry', 'records', name))
  const replay = inject()
  await assert.rejects(
    () => takeCustody(root, event(root, 1, recordId, raw)),
    /injected directory fsync failure/
  )
  replay.mock.restore()
  assert.equal((await takeCustody(root, event(root, 1, recordId, raw))).status, 'pending')
})

test('a failed custody source leaves no receipt', async (t) => {
  const root = await workspace()
  t.after(() => rm(root, { recursive: true, force: true }))
  const recordId = id('b')
  const name = `${String(1).padStart(20, '0')}-${recordId}.json`
  await mkdir(join(root, '.scry', 'records', name), { recursive: true })
  await assert.rejects(() => takeCustody(root, event(root, 1, recordId, Buffer.from('x'))))
  assert.equal(await readReceipt(join(root, '.scry', 'upload'), recordId), null)
})

test('source symlink escape and orphan target conflicts fail closed', async (t) => {
  const root = await workspace()
  t.after(() => rm(root, { recursive: true, force: true }))
  const recordId = id('c')
  const raw = Buffer.from('inside')
  const name = await putRecord(root, 1, recordId, raw)
  const outside = join(root, 'outside.json')
  await writeFile(outside, Buffer.from('outside'))
  await rm(join(root, '.scry', 'records', name))
  await symlink(outside, join(root, '.scry', 'records', name))
  await assert.rejects(
    () => takeCustody(root, event(root, 1, recordId, Buffer.from('outside'))),
    /record path escapes/
  )

  await rm(join(root, '.scry', 'records', name))
  await writeFile(join(root, '.scry', 'records', name), raw)
  const upload = join(root, '.scry', 'upload', 'outbox', 'committed')
  await mkdir(upload, { recursive: true })
  await writeFile(join(upload, name), Buffer.from('different'))
  await assert.rejects(() => takeCustody(root, event(root, 1, recordId, raw)), { code: 'custody_conflict' })
})

test('invalid receipt identity and hash are rejected', async (t) => {
  const root = await workspace()
  t.after(() => rm(root, { recursive: true, force: true }))
  const recordId = id('d')
  const receipts = join(root, '.scry', 'upload', 'receipts')
  await mkdir(receipts, { recursive: true })
  await writeFile(
    join(receipts, `${recordId}.json`),
    JSON.stringify({ version: 1, recordId: id('e'), sequence: 1, sha256: '0'.repeat(64), status: 'pending' })
  )
  await assert.rejects(
    () => readReceipt(join(root, '.scry', 'upload'), recordId),
    /receipt identity mismatch/
  )
})

test('pause retains legacy outbox bytes and pauses receipt-only custody', async (t) => {
  const root = await workspace()
  t.after(() => rm(root, { recursive: true, force: true }))
  const legacyId = id('f')
  const receiptOnlyId = id('a')
  const legacy = '{"legacy":true}'
  await outboxEnvelope(root, 1, legacyId, legacy)
  const receiptRaw = Buffer.from('{"receiptOnly":true}')
  const receiptName = await putRecord(root, 2, receiptOnlyId, receiptRaw)
  await takeCustody(root, event(root, 2, receiptOnlyId, receiptRaw))
  await rm(join(root, '.scry', 'records', receiptName))
  await pausePending(root)
  const legacyReceipt = await readReceipt(join(root, '.scry', 'upload'), legacyId)
  const receiptOnly = await readReceipt(join(root, '.scry', 'upload'), receiptOnlyId)
  assert.equal(legacyReceipt.status, 'skipped_disabled')
  assert.equal(receiptOnly.status, 'skipped_disabled')
  assert.equal(
    await readFile(
      join(root, '.scry', 'upload', 'outbox', 'committed', `${String(1).padStart(20, '0')}-${legacyId}.json`),
      'utf8'
    ),
    legacy
  )
  await releaseDisabled(root, legacyId)
  assert.equal((await readReceipt(join(root, '.scry', 'upload'), legacyId)).status, 'pending')
  await releaseDisabled(root, legacyId)
})

test('finish rejects missing custody and leaves the legacy envelope untouched', async (t) => {
  const root = await workspace()
  t.after(() => rm(root, { recursive: true, force: true }))
  const recordId = id('b')
  const record = '{"legacy":true}'
  await outboxEnvelope(root, 1, recordId, record)
  await assert.rejects(
    () => finishCustody(
      root,
      {
        version: 1,
        sequence: 1,
        recordId,
        workspaceId: 'fixture',
        redactionVersion: 'agent-turn-v1',
        recordBytes: Buffer.byteLength(record),
        record
      },
      'uploaded',
      'inserted'
    ),
    { code: 'custody_missing' }
  )
  assert.equal(await readReceipt(join(root, '.scry', 'upload'), recordId), null)
  assert.equal(
    await readFile(
      join(root, '.scry', 'upload', 'outbox', `${String(1).padStart(20, '0')}-${recordId}.json`),
      'utf8'
    ).then(Boolean),
    true
  )
})
