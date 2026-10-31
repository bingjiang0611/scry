import assert from 'node:assert/strict'
import { chmod, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { enqueueWakeup, runQueueWorker } from '../dist/queue.js'
import { setUploadPolicy } from '../dist/uploader.js'
import { fixture, custody, logs } from './fixtures/recovery-helpers.mjs'

async function changeJob(base, id, change) {
  const path = join(base, 'jobs', `${id}.json`)
  const job = JSON.parse(await readFile(path))
  change(job)
  const bytes = JSON.stringify(job)
  await writeFile(path, bytes)
  return bytes
}

test('queued context cannot replace activation executables or the global admission directory', async (t) => {
  const { root, base, env } = await fixture(t)
  const record = await custody(root, 1)
  const marker = join(root, 'untrusted-executed')
  const executable = join(root, 'untrusted.mjs')
  const untrustedState = join(root, 'untrusted-state')
  await writeFile(executable, `#!/usr/bin/env node\nimport {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)}, 'executed')\n`)
  await chmod(executable, 0o700)
  const id = await enqueueWakeup(root, { ...env, HOST_TRACE_TASK_ID: 'queued-context' })
  await changeJob(base, id, job => {
    job.env.TRANSPORT_CLI_PATH = executable
    job.env.SCRY_CLI_PATH = executable
    job.env.XDG_STATE_HOME = untrustedState
    job.env.SCRY_INSTALLATION_ID_FILE = join(root, 'untrusted-installation')
  })
  await runQueueWorker(root, { ...env, HOST_TRACE_TASK_ID: 'current-context' }, { once: true })
  assert.equal(JSON.parse(await readFile(join(base, 'receipts', `${record.recordId}.json`))).status, 'uploaded')
  const starts = (await logs(env.RECOVERY_TRANSPORT_LOG)).filter(event => event.phase === 'start')
  assert.deepEqual(starts.map(event => event.traceTask), ['queued-context'])
  await assert.rejects(() => stat(marker), { code: 'ENOENT' })
  await assert.rejects(() => stat(untrustedState), { code: 'ENOENT' })
  await assert.rejects(() => stat(join(root, 'untrusted-installation')), { code: 'ENOENT' })
})

test('legacy queued denial is honored but cannot override a later explicit enable', async (t) => {
  const { root, base, env } = await fixture(t)
  const old = await custody(root, 1)
  const legacyEnv = { ...env, SCRY_UPLOAD_TRIGGER: 'completion' }
  let id = await enqueueWakeup(root, legacyEnv)
  await changeJob(base, id, job => { job.env.SCRY_TURN_UPLOAD_ENABLED = '0' })
  await runQueueWorker(root, env, { once: true })
  assert.equal(JSON.parse(await readFile(join(base, 'state.json'))).uploadEnabled, false)
  assert.equal(JSON.parse(await readFile(join(base, 'receipts', `${old.recordId}.json`))).status, 'skipped_disabled')
  assert.equal((await logs(env.RECOVERY_TRANSPORT_LOG)).length, 0)

  id = await enqueueWakeup(root, legacyEnv)
  await changeJob(base, id, job => { job.env.SCRY_TURN_UPLOAD_ENABLED = '0' })
  await setUploadPolicy(root, true, env)
  const fresh = await custody(root, 2)
  await runQueueWorker(root, env)
  assert.equal(JSON.parse(await readFile(join(base, 'state.json'))).uploadEnabled, true)
  const starts = (await logs(env.RECOVERY_TRANSPORT_LOG)).filter(event => event.phase === 'start')
  assert.deepEqual(starts.flatMap(event => event.ids), [fresh.recordId])
  assert.equal(JSON.parse(await readFile(join(base, 'receipts', `${old.recordId}.json`))).status, 'skipped_disabled')
})

test('a current wakeup denial is durable before any detached worker starts', async (t) => {
  const { root, base, env } = await fixture(t)
  await setUploadPolicy(root, true, env)
  const record = await custody(root, 1)
  await enqueueWakeup(root, { ...env, SCRY_TURN_UPLOAD_ENABLED: '0' })
  assert.equal(JSON.parse(await readFile(join(base, 'state.json'))).uploadEnabled, false)
  await runQueueWorker(root, env, { once: true })
  assert.equal(JSON.parse(await readFile(join(base, 'receipts', `${record.recordId}.json`))).status, 'skipped_disabled')
  assert.equal((await logs(env.RECOVERY_TRANSPORT_LOG)).length, 0)
})

for (const key of ['generation', 'rerunRequested']) {
  test(`invalid ${key} preserves the original job bytes and custody for later recovery`, async (t) => {
    const { root, base, env } = await fixture(t)
    const record = await custody(root, 1)
    const id = await enqueueWakeup(root, env)
    const bytes = await changeJob(base, id, job => { job[key] = 'invalid' })
    await runQueueWorker(root, env, { once: true })
    const names = await readdir(join(base, 'jobs', 'dead-letter'))
    assert.equal(names.length, 1)
    assert.equal(await readFile(join(base, 'jobs', 'dead-letter', names[0]), 'utf8'), bytes)
    assert.equal(JSON.parse(await readFile(join(base, 'receipts', `${record.recordId}.json`))).status, 'pending')
    await enqueueWakeup(root, env)
    await runQueueWorker(root, env, { once: true })
    assert.equal(JSON.parse(await readFile(join(base, 'receipts', `${record.recordId}.json`))).status, 'uploaded')
  })
}
