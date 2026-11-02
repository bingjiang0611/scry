import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { readReceipt } from '../dist/custody/receipts.js'
import { localUploadStatus, runUpload, setUploadPolicy } from '../dist/uploader.js'
import { custody, fixture, logs } from './fixtures/recovery-helpers.mjs'

const starts = async env => (await logs(env.RECOVERY_TRANSPORT_LOG)).filter(event => event.phase === 'start')

test('a first enable keeps queued custody pending instead of holding it', async (t) => {
  const { root, base, env } = await fixture(t)
  const queued = await custody(root, 1)
  // Fresh state from init: no policy has ever been written.
  assert.equal(JSON.parse(await readFile(join(base, 'state.json'), 'utf8')).uploadEnabled, undefined)
  assert.equal((await readReceipt(base, queued.recordId)).status, 'pending')

  const state = await setUploadPolicy(root, true, env)
  assert.equal(state.uploadEnabled, true)
  assert.equal(state.disabledThrough, undefined, 'a workspace that was never disabled has no high-water')
  assert.equal((await readReceipt(base, queued.recordId)).status, 'pending')
  assert.equal((await localUploadStatus(root)).disabledHeld, 0)

  const result = await runUpload(root, { env })
  assert.equal(result.uploaded, 1)
  assert.deepEqual((await starts(env)).flatMap(event => event.ids), [queued.recordId])
})

test('enable after an explicit disable still holds the disabled interval', async (t) => {
  const { root, base, env } = await fixture(t)
  const held = await custody(root, 1)
  await setUploadPolicy(root, false, env)
  assert.equal((await readReceipt(base, held.recordId)).status, 'skipped_disabled')

  const state = await setUploadPolicy(root, true, env)
  assert.equal(state.uploadEnabled, true)
  const fresh = await custody(root, 2)
  const result = await runUpload(root, { env })
  assert.equal(result.uploaded, 1)
  assert.deepEqual((await starts(env)).flatMap(event => event.ids), [fresh.recordId])
  assert.equal((await readReceipt(base, held.recordId)).status, 'skipped_disabled')
  assert.equal((await localUploadStatus(root)).disabledHeld, 1)
})

test('enabling twice stays idempotent and keeps the recorded cutoff', async (t) => {
  const { root, base, env } = await fixture(t)
  const held = await custody(root, 1)
  await setUploadPolicy(root, false, env)
  const first = await setUploadPolicy(root, true, env)
  const second = await setUploadPolicy(root, true, env)
  assert.equal(second.uploadEnabled, true)
  assert.equal(second.disabledThrough, first.disabledThrough)
  assert.equal(second.enabledEpoch, first.enabledEpoch)
  assert.equal((await readReceipt(base, held.recordId)).status, 'skipped_disabled')
})
