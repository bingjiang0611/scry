import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { redriveDeadLetters } from '../dist/redrive.js'
import { runUpload } from '../dist/uploader.js'
import { fixture, custody } from './fixtures/recovery-helpers.mjs'

const recordName = (sequence, recordId) => `${String(sequence).padStart(20, '0')}-${recordId}.json`

async function freeForRetry(base) {
  const name = (await readdir(join(base, 'outbox'))).find(entry => entry.endsWith('.json'))
  if (!name) return
  const path = join(base, 'outbox', name)
  const envelope = JSON.parse(await readFile(path, 'utf8'))
  envelope.localRetry = { ...(envelope.localRetry ?? {}), notBeforeMs: 0 }
  await writeFile(path, JSON.stringify(envelope))
}

// Dead lettering needs a deterministic rejection, so this reuses the 400 path
// instead of an ambiguous failure.
async function deadLetteredRecord(t) {
  const { root, base, env } = await fixture(t)
  const record = await custody(root, 1)
  const rejected = { ...env, RECOVERY_FAIL_RECORD_ID: record.recordId, RECOVERY_BUSINESS_CODE: 'INVALID_ARGUMENT' }
  for (let round = 0; round < 3; round++) {
    await runUpload(root, { env: rejected })
    await freeForRetry(base)
  }
  const entryPath = join(base, 'dead-letter', recordName(1, record.recordId))
  const receiptPath = join(base, 'receipts', `${record.recordId}.json`)
  assert.equal(JSON.parse(await readFile(receiptPath, 'utf8')).status, 'dead_letter')
  return { root, base, record, entryPath, receiptPath }
}

test('redrive refuses a payload path that is not this record custody file', async (t) => {
  const { root, base, record, entryPath, receiptPath } = await deadLetteredRecord(t)
  const entry = JSON.parse(await readFile(entryPath, 'utf8'))
  // A prefix-only check accepts this escape because the target exists and the
  // metadata can vouch for its bytes; redriving it would upload local state as
  // record content.
  const escape = 'outbox/committed/../../state.json'
  entry.payloadPath = escape
  entry.sha256 = createHash('sha256').update(await readFile(join(base, 'state.json'))).digest('hex')
  await writeFile(entryPath, JSON.stringify(entry))

  const result = await redriveDeadLetters(root, { reason: 'traversal probe' })
  assert.deepEqual(result.redriven, [])
  assert.deepEqual(result.skipped, [{ recordId: record.recordId, reason: 'payload_unavailable' }])
  assert.equal(JSON.parse(await readFile(receiptPath, 'utf8')).status, 'dead_letter')
  assert.deepEqual((await readdir(join(base, 'outbox'))).filter(name => name.endsWith('.json')), [])
})

test('redrive trusts the custody receipt over the dead-letter metadata', async (t) => {
  const { root, base, record, entryPath, receiptPath } = await deadLetteredRecord(t)
  const entry = JSON.parse(await readFile(entryPath, 'utf8'))
  const payloadPath = join(base, entry.payloadPath)
  const tampered = Buffer.from('{"schemaVersion":1,"recordId":"substituted"}')
  await writeFile(payloadPath, tampered)
  // Forge the metadata so it vouches for the substituted bytes. Only the receipt
  // can prove what the uploader actually took custody of.
  entry.sha256 = createHash('sha256').update(tampered).digest('hex')
  await writeFile(entryPath, JSON.stringify(entry))

  const result = await redriveDeadLetters(root)
  assert.deepEqual(result.redriven, [])
  assert.deepEqual(result.skipped, [{ recordId: record.recordId, reason: 'custody_digest_mismatch' }])
  assert.equal(JSON.parse(await readFile(receiptPath, 'utf8')).status, 'dead_letter')
})

test('redrive restores a retained legacy dead letter with its submitted bytes', async (t) => {
  const { root, base, env } = await fixture(t)
  const record = await custody(root, 1)
  // A legacy outbox envelope keeps the redacted bytes that were submitted, which
  // differ from the canonical raw bytes held by the receipt.
  const legacy = JSON.stringify({ ...JSON.parse(record.raw), secret: '<redacted>' })
  await writeFile(
    join(base, 'outbox', recordName(1, record.recordId)),
    JSON.stringify({
      version: 1,
      sequence: 1,
      recordId: record.recordId,
      workspaceId: 'fixture',
      redactionVersion: 'agent-turn-v1',
      recordBytes: Buffer.byteLength(legacy),
      sha256: createHash('sha256').update(legacy).digest('hex'),
      record: legacy
    })
  )
  const rejected = { ...env, RECOVERY_FAIL_RECORD_ID: record.recordId, RECOVERY_BUSINESS_CODE: 'INVALID_ARGUMENT' }
  for (let round = 0; round < 3; round++) {
    await runUpload(root, { env: rejected })
    await freeForRetry(base)
  }
  const entry = JSON.parse(await readFile(join(base, 'dead-letter', recordName(1, record.recordId)), 'utf8'))
  assert.equal(entry.payloadPath, `outbox/committed/legacy/${recordName(1, record.recordId)}`)
  const receipt = JSON.parse(await readFile(join(base, 'receipts', `${record.recordId}.json`), 'utf8'))
  assert.notEqual(receipt.sha256, entry.sha256, 'the retained bytes and the canonical bytes must differ')

  const result = await redriveDeadLetters(root)
  assert.deepEqual(result.redriven, [record.recordId])
  assert.deepEqual(result.skipped, [])
  const outbox = JSON.parse(await readFile(join(base, 'outbox', recordName(1, record.recordId)), 'utf8'))
  assert.equal(outbox.redactionVersion, 'agent-turn-v1')
  assert.equal(outbox.record, legacy)
})
