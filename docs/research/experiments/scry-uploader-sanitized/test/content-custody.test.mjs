import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { localUploadStatus, runUpload, setUploadPolicy, takeCustody } from '../dist/uploader.js'
import { custodyContentPath } from '../dist/content.js'
import { fixture } from './fixtures/reliability-fixture.mjs'
import { calls, contentCustody, custody, envelope, filename, hash, receipt } from './fixtures/reliability-helpers.mjs'

test('full referenced content survives deletion of source canonical and CAS, with exact body ACK', async (t) => {
  const { root, env, base } = await fixture(t)
  const { record, body, sha256 } = await contentCustody(root)
  const retained = await receipt(base, record.value.recordId)
  assert.match(retained.contentSha256, /^[a-f0-9]{64}$/)
  await rm(join(root, '.scry/content'), { recursive: true })
  await rm(join(root, '.scry/records', filename(1, record.value.recordId)))
  assert.equal((await runUpload(root, { env })).uploaded, 1)
  const sent = (await calls(env))[0]
  assert.deepEqual(sent.decoded[0], record.value)
  const blob = JSON.parse(sent.contents[0])[0]
  assert.equal(blob.sha256, sha256)
  assert.equal(Buffer.from(blob.dataBase64, 'base64').toString('utf8'), body)
  assert.equal(hash(sent.contents[0]), retained.contentSha256)
  assert.equal((await receipt(base, record.value.recordId)).sha256, hash(record.raw))
})

test('unsupported receiver is checked before writing a content envelope', async (t) => {
  const { root, env, base } = await fixture(t)
  const { record } = await contentCustody(root)
  await assert.rejects(() => runUpload(root, { env: { ...env, FAKE_TRANSPORT_MODE: 'no-content' } }),
    { code: 'content_protocol_unavailable', retryable: true })
  await assert.rejects(readFile(env.FAKE_TRANSPORT_LOG), { code: 'ENOENT' })
  assert.equal((await receipt(base, record.value.recordId)).status, 'pending')
})

// The internal receiver may not expose the capability tool at all. The run must
// fail with the concrete cause (redacted), and the record must stay deliverable.
test('a failed capability probe reports its cause without leaking a credential', async (t) => {
  const { root, env, base } = await fixture(t)
  const { record } = await contentCustody(root)
  await assert.rejects(() => runUpload(root, { env: { ...env, FAKE_TRANSPORT_MODE: 'capability-error' } }), (error) => {
    assert.equal(error.code, 'transport_contentCapabilities')
    assert.equal(error.retryable, true)
    assert.match(error.message, /unknown tool "queryAgentTurnUploadCapabilities"/)
    assert.doesNotMatch(error.message, /sk-live-abcdef/)
    return true
  })
  assert.equal((await receipt(base, record.value.recordId)).status, 'pending')
})

for (const mode of ['content-ack-missing', 'content-ack-corrupt']) {
  test(`${mode} cannot mark a canonical-only success as complete`, async (t) => {
    const { root, env, base } = await fixture(t)
    const { record } = await contentCustody(root)
    await assert.rejects(() => runUpload(root, { env: { ...env, FAKE_TRANSPORT_MODE: mode } }),
      { code: 'content_ack_missing', retryable: true })
    assert.equal((await receipt(base, record.value.recordId)).status, 'pending')
    assert.equal((await calls(env)).length, 1)
  })
}

test('lost content success response replays identical canonical and body bytes', async (t) => {
  const { root, env, base } = await fixture(t)
  const { record } = await contentCustody(root)
  const replayEnv = { ...env, FAKE_TRANSPORT_COMMITTED_FILE: join(root, 'remote-ids') }
  // A lost response is an unknown outcome, not a terminal failure: the record
  // stays pending with a local cooldown instead of failing the whole run.
  const first = await runUpload(root, { env: replayEnv })
  assert.equal(first.uploaded, 0)
  assert.equal((await receipt(base, record.value.recordId)).status, 'pending')
  assert.ok(first.deferredUntilMs > Date.now(), 'an unknown outcome must defer the record, not fail the run')
  // Replay only after the recorded local cooldown, so the same bytes are resent.
  await new Promise((resolve) => setTimeout(resolve, first.deferredUntilMs - Date.now() + 250))
  await rm(join(root, '.scry/content'), { recursive: true })
  const result = await runUpload(root, { env: replayEnv })
  assert.equal(result.duplicated, 1)
  const sent = await calls(env)
  assert.equal(sent.length, 2)
  assert.deepEqual(sent[0].payload.records, sent[1].payload.records)
  assert.equal((await receipt(base, record.value.recordId)).status, 'uploaded')
})

test('corrupt retained body refuses notification ACK and upload, without rewriting corruption', async (t) => {
  const { root, env, base } = await fixture(t)
  const { record } = await contentCustody(root)
  const path = custodyContentPath(base, 1, record.value.recordId)
  const broken = (await readFile(path, 'utf8')) + '\n'
  await writeFile(path, broken)
  await assert.rejects(() => takeCustody(root, record.event), { code: 'content_custody_corrupt' })
  await assert.rejects(() => runUpload(root, { env }), { code: 'content_custody_corrupt' })
  assert.equal(await readFile(path, 'utf8'), broken)
  assert.equal((await receipt(base, record.value.recordId)).status, 'pending')
  await assert.rejects(readFile(env.FAKE_TRANSPORT_LOG), { code: 'ENOENT' })
})

