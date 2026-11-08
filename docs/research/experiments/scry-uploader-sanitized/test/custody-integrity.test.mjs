import assert from 'node:assert/strict'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { runQueueWorker } from '../dist/queue.js'
import { run, writeJsonAtomic } from '../dist/util.js'
import { localUploadStatus, runUpload, setUploadPolicy, takeCustody } from '../dist/uploader.js'
import { custodyContentPath } from '../dist/content.js'
import { fixture } from './fixtures/reliability-fixture.mjs'
import { calls, cli, contentCustody, custody, envelope, filename, hash, receipt } from './fixtures/reliability-helpers.mjs'

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

