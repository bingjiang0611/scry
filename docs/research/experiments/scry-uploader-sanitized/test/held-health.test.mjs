import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { pendingReceipts, readReceipt, saveReceipt, withRecordLock } from '../dist/custody/receipts.js'
import { localUploadStatus, releaseDisabled, runUpload, setUploadPolicy, takeCustody } from '../dist/uploader.js'
import { fixture } from './fixtures/reliability-fixture.mjs'

async function heldFixture(t) {
  const context = await fixture(t, "console.log(JSON.stringify({records:[],nextCursor:Number(process.argv[process.argv.indexOf('--after')+1]),snapshotMaxSequence:1,hasMore:false}))")
  const { root, env } = context
  await runUpload(root, { env: { ...env, SCRY_TURN_UPLOAD_ENABLED: '0' } })
  const recordId = 'a'.repeat(32)
  const name = `${'1'.padStart(20, '0')}-${recordId}.json`
  const raw = JSON.stringify({ schemaVersion: 1, sequence: 1, recordId, workspace: { id: 'fixture', root }, provider: 'pi' }) + '\n'
  await writeFile(join(root, '.scry/records', name), raw)
  await takeCustody(root, { sequence: 1, recordId })
  await setUploadPolicy(root, true, env)
  return { ...context, recordId, name, raw }
}

test('held health depends on custody status, not whether an outbox copy exists', async (t) => {
  const { root, base, env, recordId, name, raw } = await heldFixture(t)
  await runUpload(root, { env })
  assert.equal((await localUploadStatus(root)).disabledHeld, 1)
  assert.equal(JSON.parse(await readFile(join(base, 'health.json'))).status, 'held_disabled')
  await writeFile(join(base, 'outbox', name), JSON.stringify({
    version: 1, sequence: 1, recordId, workspaceId: 'fixture', redactionVersion: 'none', record: raw,
    recordBytes: Buffer.byteLength(raw), sha256: createHash('sha256').update(raw).digest('hex')
  }))
  await runUpload(root, { env })
  assert.equal(JSON.parse(await readFile(join(base, 'health.json'))).status, 'held_disabled')
  await assert.rejects(() => readFile(env.FAKE_TRANSPORT_LOG), { code: 'ENOENT' })
  assert.equal(await readFile(join(root, '.scry/records', name), 'utf8'), raw)
  await releaseDisabled(root, recordId)
  await runUpload(root, { env })
  assert.equal(JSON.parse(await readFile(join(base, 'health.json'))).status, 'healthy')
  assert.equal((await localUploadStatus(root)).disabledHeld, 0)
  assert.equal((await readReceipt(base, recordId)).status, 'uploaded')
})

test('held index migrates old receipts once without rescanning archived receipts on wakeup', async (t) => {
  const { hasHeldReceipts } = await import('../dist/custody/receipts.js')
  const { root, base, env, recordId } = await heldFixture(t)
  await rm(join(base, 'held-receipts'), { recursive: true, force: true })
  await rm(join(base, 'held-index.json'), { force: true })
  assert.equal(await hasHeldReceipts(base), true)
  assert.equal(JSON.parse(await readFile(join(base, 'held-index.json'))).version, 1)
  assert.ok(await stat(join(base, 'held-receipts', recordId)))
  // This unrelated archived receipt must not be parsed by each subsequent wakeup.
  await writeFile(join(base, 'receipts', `${'b'.repeat(32)}.json`), '{invalid archive')
  await runUpload(root, { env })
  assert.equal(JSON.parse(await readFile(join(base, 'health.json'))).status, 'held_disabled')
  await assert.rejects(() => readFile(env.FAKE_TRANSPORT_LOG), { code: 'ENOENT' })
})

test('held index cleanup preserves a marker owned by a simultaneous status transition', async (t) => {
  const { hasHeldReceipts } = await import('../dist/custody/receipts.js')
  const { root, base, recordId } = await heldFixture(t)
  assert.equal(await hasHeldReceipts(base), true)
  await releaseDisabled(root, recordId)
  assert.equal(await hasHeldReceipts(base), false)
  const marker = join(base, 'held-receipts', recordId)
  await writeFile(marker, '')
  await withRecordLock(base, recordId, async () => {
    assert.equal(await hasHeldReceipts(base), false)
    assert.ok(await stat(marker))
    const receipt = await readReceipt(base, recordId)
    await saveReceipt(base, { ...receipt, status: 'skipped_disabled' })
  })
  assert.equal(await hasHeldReceipts(base), true)
  assert.deepEqual(await pendingReceipts(base), [])
})
