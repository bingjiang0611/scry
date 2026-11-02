import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { withRecordLock } from '../dist/custody/receipts.js'
import { notifyRecordCommit } from '../dist/queue.js'
import { sleep } from '../dist/util.js'
import { custody, fixture } from './fixtures/recovery-helpers.mjs'

const jobNames = async base => (await readdir(join(base, 'jobs'))).filter(name => name.endsWith('.json'))

test('a record notification waits for a held record lock instead of being dropped', async (t) => {
  const { root, base, env } = await fixture(t)
  const record = await custody(root, 1)
  const notification = {
    schemaVersion: 2,
    event: 'record-committed',
    workspace: root,
    provider: 'pi',
    sessionId: 'fixture',
    recordId: record.recordId,
    sequence: 1
  }
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  const holder = withRecordLock(base, record.recordId, async () => {
    entered.resolve()
    await release.promise
  })
  try {
    await entered.promise
    const pending = notifyRecordCommit(root, notification, env)
    await sleep(200)
    // Contention must not fail the notification; the job appears once it has
    // the record, without a later wakeup or discovery pass.
    release.resolve()
    await pending
    assert.equal((await jobNames(base)).length, 1)
  } finally {
    release.resolve()
    await holder
  }
})

test('a lock that never yields fails with a typed retryable error', async (t) => {
  const { root, base } = await fixture(t)
  const record = await custody(root, 1)
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  const holder = withRecordLock(base, record.recordId, async () => {
    entered.resolve()
    await release.promise
  })
  try {
    await entered.promise
    await assert.rejects(
      withRecordLock(base, record.recordId, async () => undefined, { waitMs: 200 }),
      error => {
        assert.equal(error.code, 'record_lock_busy')
        assert.equal(error.retryable, true)
        assert.match(error.message, new RegExp(record.recordId))
        return true
      }
    )
  } finally {
    release.resolve()
    await holder
  }
  // The lock is usable again after the holder leaves, so a later notification
  // can still be recorded.
  await withRecordLock(base, record.recordId, async () => undefined, { waitMs: 200 })
  const receipt = JSON.parse(await readFile(join(base, 'receipts', `${record.recordId}.json`), 'utf8'))
  assert.equal(receipt.status, 'pending')
})
