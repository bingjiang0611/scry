import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { fstatSync, watch } from 'node:fs'
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { enqueueWakeup, runQueueWorker, validateNotification } from '../dist/queue.js'
import {
  initializeUploadState,
  localUploadStatus,
  migrateLegacy,
  runUpload,
  setUploadPolicy,
  takeCustody,
  uploadRoot
} from '../dist/uploader.js'
import { run, writeJsonAtomic } from '../dist/util.js'
import { fixture } from './fixtures/reliability-fixture.mjs'
const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url))
const hash = (value) => createHash('sha256').update(value).digest('hex')
const filename = (sequence, recordId) => `${String(sequence).padStart(20, '0')}-${recordId}.json`

async function custody(root, sequence = 1, extra = {}) {
  const recordId = sequence.toString(16).padStart(32, '0')
  const value = {
    schemaVersion: 1,
    sequence,
    recordId,
    workspace: { id: 'fixture', root },
    sessionId: 'session',
    provider: 'pi',
    ...extra
  }
  const raw = JSON.stringify(value, null, 2) + '\n'
  const name = filename(sequence, recordId)
  await writeFile(join(root, '.scry/records', name), raw)
  const event = {
    schemaVersion: 2,
    event: 'record-committed',
    workspace: root,
    provider: 'pi',
    sessionId: 'session',
    sequence,
    recordId,
    recordPath: `records/${name}`,
    sha256: hash(raw)
  }
  await takeCustody(root, event)
  return { value, raw, event, path: join(uploadRoot(root), 'outbox', name) }
}

async function envelope(record, text = record.raw, version = 'none', extra = {}) {
  const value = {
    version: 1,
    sequence: record.value.sequence,
    recordId: record.value.recordId,
    workspaceId: 'fixture',
    redactionVersion: version,
    recordBytes: Buffer.byteLength(text),
    sha256: hash(text),
    record: text,
    ...extra
  }
  await writeFile(record.path, JSON.stringify(value))
  return value
}

async function receipt(base, recordId) {
  return JSON.parse(await readFile(join(base, 'receipts', `${recordId}.json`), 'utf8'))
}
async function calls(env) {
  return (await readFile(env.FAKE_TRANSPORT_LOG, 'utf8')).trim().split('\n').map(JSON.parse)
}

// Legacy and new representations have different authority: preserve an already
// queued legacy payload; never replace its bytes with fresh raw content.
test('legacy payload survives disable, enabled wakeup, local release, and upload', async (t) => {
  const { root, env, base } = await fixture(t)
  const record = await custody(root, 1, { secret: 'raw-secret' })
  const legacy = JSON.stringify({
    ...record.value,
    workspace: { id: 'fixture', root: '<workspace>' },
    secret: '<redacted>'
  })
  const saved = await envelope(record, legacy, 'agent-turn-v1')
  await runUpload(root, { env: { ...env, SCRY_TURN_UPLOAD_ENABLED: '0' } })
  assert.equal((await receipt(base, record.value.recordId)).status, 'skipped_disabled')
  await runUpload(root, { env })
  assert.deepEqual(JSON.parse(await readFile(record.path, 'utf8')), saved)
  assert.equal((await localUploadStatus(root)).disabledHeld, 1)
  await assert.rejects(() => readFile(env.FAKE_TRANSPORT_LOG), { code: 'ENOENT' })

  // Unsetting a runtime flag must not silently override a persisted pause.
  await setUploadPolicy(root, true, env)
  await runQueueWorker(root, env, { once: true })
  const releaseEnv = { ...env }
  delete releaseEnv.SCRY_UPLOADER_NO_SPAWN
  const release = await run(
    process.execPath,
    [cli, 'flush', '--workspace', root, '--release-disabled', record.value.recordId],
    { env: releaseEnv }
  )
  assert.equal(release.exitCode, 0, release.stderr)
  assert.equal((await readdir(join(base, 'jobs'))).filter((name) => name.endsWith('.json')).length, 0)
  await assert.rejects(() => readFile(env.FAKE_TRANSPORT_LOG), { code: 'ENOENT' })
  assert.equal((await runUpload(root, { env })).uploaded, 1)
  assert.equal((await calls(env))[0].payload.records[0], legacy)
  assert.equal((await receipt(base, record.value.recordId)).status, 'uploaded')
  assert.equal((await localUploadStatus(root)).committedPending, 0)
  assert.equal(
    await readFile(join(base, 'outbox/committed', filename(1, record.value.recordId)), 'utf8'),
    record.raw
  )
})

test('equivalent reordered JSON restores canonical raw formatting without resetting retry', async (t) => {
  const { root, env } = await fixture(t)
  const record = await custody(root)
  const reordered = JSON.stringify(Object.fromEntries(Object.entries(record.value).reverse()))
  const retry = { kind: 'report_timeout', attempts: 2, notBeforeMs: Date.now() + 60_000 }
  await envelope(record, reordered, 'none', { localRetry: retry })
  const result = await runUpload(root, { env })
  assert.equal(typeof result.deferredUntilMs, 'number')
  const saved = JSON.parse(await readFile(record.path, 'utf8'))
  assert.equal(saved.record, record.raw)
  assert.equal(saved.sha256, hash(record.raw))
  assert.deepEqual(saved.localRetry, retry)
  await assert.rejects(() => readFile(env.FAKE_TRANSPORT_LOG), { code: 'ENOENT' })
})

test('outbox content and digest conflicts fail before networking and keep custody pending', async (t) => {
  const { root, env, base } = await fixture(t)
  const record = await custody(root)
  await envelope(record, JSON.stringify({ ...record.value, changed: true }))
  await assert.rejects(() => runUpload(root, { env }), { code: 'outbox_conflict', retryable: true })
  await envelope(record, record.raw, 'none', { sha256: '' })
  await assert.rejects(() => runUpload(root, { env }), { code: 'outbox_digest_mismatch', retryable: true })
  assert.equal((await receipt(base, record.value.recordId)).status, 'pending')
  assert.equal((await readdir(join(base, 'dead-letter'))).length, 0)
  await assert.rejects(() => readFile(env.FAKE_TRANSPORT_LOG), { code: 'ENOENT' })
})

test('remote rejection retains legacy bytes before removing the outbox', async (t) => {
  const { root, env, base } = await fixture(t)
  const recordId = 'a'.repeat(32)
  const raw = JSON.stringify({
    schemaVersion: 1,
    sequence: 1,
    recordId,
    workspace: { id: 'fixture', root: '<workspace>' },
    privateText: 'never-in-diagnostic'
  })
  const record = { value: { sequence: 1, recordId }, path: join(base, 'outbox', filename(1, recordId)), raw }
  await envelope(record, raw, 'agent-turn-v1')
  const result = await runUpload(root, { env: { ...env, FAKE_TRANSPORT_MODE: 'rejected' } })
  assert.equal(result.deadLettered, 1)
  assert.equal((await receipt(base, recordId)).status, 'dead_letter')
  assert.equal(await readFile(join(base, 'outbox/committed', filename(1, recordId)), 'utf8'), raw)
  await assert.rejects(() => readFile(record.path), { code: 'ENOENT' })
  for (const name of await readdir(join(base, 'dead-letter'))) {
    assert.equal(
      (await readFile(join(base, 'dead-letter', name), 'utf8')).includes('never-in-diagnostic'),
      false
    )
  }
})

for (const mode of ['rejected', 'conflicted']) {
  test(`terminal ${mode} preserves distinct raw and legacy submitted bytes`, async (t) => {
    const { root, env, base } = await fixture(t)
    const record = await custody(root, 1, { secret: 'canonical-only-secret' })
    const legacy = JSON.stringify({
      ...record.value,
      workspace: { id: 'fixture', root: '<workspace>' },
      secret: '<redacted>'
    })
    await envelope(record, legacy, 'agent-turn-v1')
    assert.equal((await runUpload(root, { env: { ...env, FAKE_TRANSPORT_MODE: mode } })).deadLettered, 1)
    const diagnostic = JSON.parse(
      await readFile(join(base, 'dead-letter', filename(1, record.value.recordId)), 'utf8')
    )
    assert.equal(diagnostic.payloadPath, `outbox/committed/legacy/${filename(1, record.value.recordId)}`)
    assert.equal(diagnostic.sha256, hash(legacy))
    assert.equal(await readFile(join(base, diagnostic.payloadPath), 'utf8'), legacy)
    assert.equal(
      await readFile(join(base, 'outbox/committed', filename(1, record.value.recordId)), 'utf8'),
      record.raw
    )
    assert.equal((await receipt(base, record.value.recordId)).sha256, hash(record.raw))
    await assert.rejects(() => readFile(record.path), { code: 'ENOENT' })
  })
}

test('transport timeout defers without terminally deleting custody bytes', async (t) => {
  const { root, env, base } = await fixture(t)
  const record = await custody(root, 1, { secret: 'canonical-only-secret' })
  const legacy = JSON.stringify({ ...record.value, workspace: { id: 'fixture', root: '<workspace>' }, secret: '<redacted>' })
  await envelope(record, legacy, 'agent-turn-v1', { localRetry: { kind: 'report_timeout', attempts: 11, notBeforeMs: 0 } })
  const result = await runUpload(root, { env: { ...env, FAKE_TRANSPORT_MODE: 'timeout' } })
  assert.equal(typeof result.deferredUntilMs, 'number')
  assert.equal((await localUploadStatus(root)).lastError, undefined)
  assert.equal(JSON.parse(await readFile(join(base, 'health.json'), 'utf8')).status, 'deferred')
  assert.equal((await receipt(base, record.value.recordId)).status, 'pending')
  assert.equal(JSON.parse(await readFile(record.path, 'utf8')).localRetry.attempts, 12)
  assert.equal(JSON.parse(await readFile(record.path, 'utf8')).record, legacy)
  assert.equal(await readFile(join(base, 'outbox/committed', filename(1, record.value.recordId)), 'utf8'), record.raw)
})

test('atomic state writes never recreate a removed workspace ancestor', async (t) => {
  const { root, base } = await fixture(t)
  const removed = `${root}-removed`
  t.after(() => rm(removed, { recursive: true, force: true }))
  await rename(root, removed)
  await assert.rejects(() => writeJsonAtomic(join(base, 'state.json'), { version: 1 }), { code: 'ENOENT' })
  await assert.rejects(() => stat(root), { code: 'ENOENT' })
})

test('explicit migration preserves locks and cursor; absent state stays absent', async (t) => {
  const { root, base } = await fixture(t)
  const statePath = join(base, 'state.json')
  const saved = JSON.stringify({ version: 1, enqueuedThrough: 42, redactionVersion: 'agent-turn-v1' })
  await writeFile(statePath, saved)
  const recordId = 'b'.repeat(32)
  const lock = join(base, 'receipts', `.${recordId}.lock`)
  await writeFile(lock, 'legacy-flock-inode')
  await assert.rejects(() => takeCustody(root, { sequence: 1, recordId }), {
    code: 'legacy_store_requires_migration'
  })
  await migrateLegacy(root)
  assert.equal(await readFile(statePath, 'utf8'), saved)
  assert.equal(await readFile(lock, 'utf8'), 'legacy-flock-inode')
  await rm(statePath)
  await migrateLegacy(root)
  await assert.rejects(() => readFile(statePath), { code: 'ENOENT' })
})

test('managed nested pending turns defer and recorder-disabled never calls transport', async (t) => {
  const { root, env, base } = await fixture(t)
  await custody(root)
  const pending = join(root, '.scry/runtime/pi/hashed-session/turns/turn-1')
  await mkdir(pending, { recursive: true })
  await writeFile(
    join(pending, 'pending-open.json'),
    JSON.stringify({ managedByScry: true, sessionId: 'session' })
  )
  await assert.rejects(
    () =>
      runUpload(root, {
        env: {
          ...env,
          SCRY_RECORDER_MANAGED: '1',
          SCRY_UPLOAD_SESSION_ID: 'session',
          SCRY_PROVIDER_ID: 'pi',
          SCRY_MANAGED_UPLOAD_WAIT_SECONDS: '1'
        }
      }),
    { code: 'managed_turn_pending', retryable: true }
  )
  const state = await readFile(join(base, 'state.json'), 'utf8')
  await runUpload(root, { env: { ...env, SCRY_RECORDER_ENABLED: '0' } })
  assert.equal(await readFile(join(base, 'state.json'), 'utf8'), state)
  await assert.rejects(() => readFile(env.FAKE_TRANSPORT_LOG), { code: 'ENOENT' })
})

test('record timeout attempts are bounded without deleting the payload', async (t) => {
  const { root, env, base } = await fixture(t)
  const record = await custody(root)
  await envelope(record, record.raw, 'none', {
    localRetry: { kind: 'report_timeout', attempts: 11, notBeforeMs: 0 }
  })
  const result = await runUpload(root, { env: { ...env, FAKE_TRANSPORT_MODE: 'timeout' } })
  assert.equal(typeof result.deferredUntilMs, 'number')
  assert.equal((await receipt(base, record.value.recordId)).status, 'pending')
  assert.equal(JSON.parse(await readFile(record.path, 'utf8')).localRetry.attempts, 12)
  assert.equal(
    await readFile(join(base, 'outbox/committed', filename(1, record.value.recordId)), 'utf8'),
    record.raw
  )
  assert.equal((await calls(env)).length, 1)
})

test(
  'new wakeup during export survives completion and clears inherited identity',
  { timeout: 15_000 },
  async (t) => {
    const script = `import { appendFile, access, writeFile } from 'node:fs/promises'
import { watch } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = dirname(fileURLToPath(import.meta.url))
await appendFile(join(root, 'export.log'), JSON.stringify({ trigger: process.env.SCRY_UPLOAD_TRIGGER ?? null, session: process.env.SCRY_UPLOAD_SESSION_ID ?? null, sequence: process.env.SCRY_UPLOAD_EXPECTED_SEQUENCE ?? null }) + '\\n')
try { await access(join(root, 'release')) } catch {
  await new Promise(async resolve => {
    const watcher = watch(root, (_, name) => { if (name === 'release') { watcher.close(); resolve() } })
    await writeFile(join(root, 'ready'), '')
  })
}
console.log(JSON.stringify({records:[],nextCursor:0,snapshotMaxSequence:0,hasMore:false}))
`
    const { root, env, base } = await fixture(t, script)
    const initial = { ...env, SCRY_UPLOAD_TRIGGER: 'session-start', SCRY_UPLOAD_SESSION_ID: 'old' }
    await enqueueWakeup(root, initial)
    let signal
    const ready = new Promise((resolve) => {
      signal = resolve
    })
    const watcher = watch(root, (_, name) => {
      if (name === 'ready') signal()
    })
    t.after(() => watcher.close())
    const worker = runQueueWorker(root, env, { once: true })
    try {
      await Promise.race([
        ready,
        worker.then(() => {
          throw new Error('worker ended before controlled export')
        })
      ])
      const newer = { ...env, SCRY_UPLOAD_SESSION_ID: 'new' }
      delete newer.SCRY_UPLOAD_TRIGGER
      delete newer.SCRY_UPLOAD_EXPECTED_SEQUENCE
      delete newer.SCRY_UPLOAD_RECORD_ID
      await enqueueWakeup(root, newer)
    } finally {
      await writeFile(join(root, 'release'), '')
      await worker
    }
    const path = join(base, 'jobs/wakeup-recovery.json')
    const job = JSON.parse(await readFile(path, 'utf8'))
    assert.equal(job.generation, 2)
    assert.equal(job.env.SCRY_UPLOAD_SESSION_ID, 'new')
    assert.equal(job.env.SCRY_UPLOAD_TRIGGER, null)
    const stale = {
      ...env,
      SCRY_UPLOAD_TRIGGER: 'record-commit',
      SCRY_UPLOAD_EXPECTED_SEQUENCE: '999',
      SCRY_UPLOAD_RECORD_ID: 'f'.repeat(32)
    }
    await runQueueWorker(root, stale, { once: true })
    await assert.rejects(() => readFile(path), { code: 'ENOENT' })
    const exports = (await readFile(join(root, 'export.log'), 'utf8')).trim().split('\n').map(JSON.parse)
    assert.deepEqual(exports, [
      { trigger: 'session-start', session: 'old', sequence: null },
      { trigger: null, session: 'new', sequence: null }
    ])
  }
)

test('preparation time consumes the invocation deadline before export or networking', async (t) => {
  const { root, env } = await fixture(t)
  await custody(root)
  let clock = Date.now()
  t.mock.method(Date, 'now', () => clock)
  const handle = await open(root, 'r')
  const prototype = Object.getPrototypeOf(handle)
  await handle.close()
  const original = prototype.sync
  let advanced = false
  t.mock.method(prototype, 'sync', function () {
    if (!advanced && fstatSync(this.fd).isDirectory()) {
      clock += 31_000
      advanced = true
    }
    return original.call(this)
  })
  await assert.rejects(() => runUpload(root, { env: { ...env, SCRY_UPLOAD_DEADLINE_SECONDS: '30' } }), {
    code: 'upload_deadline_exhausted',
    retryable: true
  })
  await assert.rejects(() => readFile(env.FAKE_TRANSPORT_LOG), { code: 'ENOENT' })
})

test('fresh export discovery preserves content and marks it none', async (t) => {
  const script = `import { readFile } from 'node:fs/promises'
const record = JSON.parse(await readFile(new URL('./export-record.json', import.meta.url), 'utf8'))
console.log(JSON.stringify({records:[record],nextCursor:1,snapshotMaxSequence:1,hasMore:false}))
`
  const { root, env } = await fixture(t, script)
  const record = {
    schemaVersion: 1,
    sequence: 1,
    recordId: 'c'.repeat(32),
    workspace: { id: 'fixture', root },
    provider: 'pi',
    sessionId: 'session',
    text: 'token=unredacted-fixture'
  }
  await writeFile(join(root, 'export-record.json'), JSON.stringify(record))
  await writeFile(join(root, '.scry/records', filename(1, record.recordId)), JSON.stringify(record) + '\n')
  assert.equal((await runUpload(root, { env })).uploaded, 1)
  const sent = (await calls(env))[0]
  assert.equal(sent.payload.redactionVersion, 'none')
  assert.deepEqual(sent.decoded[0], record)
})

test('fresh discovery rejects a changed workspace identity within one export page', async (t) => {
  const script = `import { readFile } from 'node:fs/promises'
const records = JSON.parse(await readFile(new URL('./export-records.json', import.meta.url), 'utf8'))
console.log(JSON.stringify({records,nextCursor:2,snapshotMaxSequence:2,hasMore:false}))
`
  const { root, env, base } = await fixture(t, script)
  const record = {
    schemaVersion: 1,
    sequence: 1,
    recordId: 'd'.repeat(32),
    workspace: { id: 'fixture', root },
    provider: 'pi',
    sessionId: 'session'
  }
  await writeFile(join(root, '.scry/records', filename(1, record.recordId)), JSON.stringify(record) + '\n')
  await writeFile(
    join(root, 'export-records.json'),
    JSON.stringify([
      record,
      { ...record, sequence: 2, recordId: 'e'.repeat(32), workspace: { id: 'different-workspace', root } }
    ])
  )
  const summary = await runUpload(root, { env })
  assert.equal(summary.uploaded, 1)
  const state = JSON.parse(await readFile(join(base, 'state.json'), 'utf8'))
  assert.equal(state.workspaceId, 'fixture')
  assert.equal(state.enqueuedThrough, 2)
  assert.equal((await localUploadStatus(root)).outboxPending, 0)
  assert.equal((await localUploadStatus(root)).deadLetterRecords, 1)
  assert.equal((await calls(env)).length, 1)
})

test('both notification versions accept optional path/hash independently', () => {
  const common = {
    event: 'record-committed',
    workspace: '/fixture',
    provider: 'pi',
    sessionId: 'session',
    sequence: 1,
    recordId: 'a'.repeat(32)
  }
  for (const schemaVersion of [1, 2]) {
    for (const optional of [
      {},
      { recordPath: `records/${filename(1, common.recordId)}` },
      { sha256: '0'.repeat(64) }
    ]) {
      assert.equal(validateNotification({ ...common, schemaVersion, ...optional }).sequence, 1)
    }
  }
})
