import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { mock } from 'node:test'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { actorIdentity } from '../dist/transport.js'
import { enqueueWakeup, runQueueWorker } from '../dist/queue.js'
import { classifyTransport } from '../dist/retry.js'
import { activateRecoveryService, schedulerStatus } from '../dist/scheduler.js'
import { redriveDeadLetters } from '../dist/redrive.js'
import { localUploadStatus, runUpload } from '../dist/uploader.js'
import { fixture, custody, logs, waitFor } from './fixtures/recovery-helpers.mjs'

const jobOf = async (base, id) => JSON.parse(await readFile(join(base, 'jobs', `${id}.json`)))
async function forceDue(base, id, change = () => undefined) {
  const path = join(base, 'jobs', `${id}.json`)
  const job = JSON.parse(await readFile(path))
  job.notBeforeMs = 0
  change(job)
  await writeFile(path, JSON.stringify(job))
}
async function makeDue(base, recordId) {
  const name = (await readdir(join(base, 'outbox'))).find(entry => entry.includes(recordId))
  const path = join(base, 'outbox', name)
  const envelope = JSON.parse(await readFile(path))
  envelope.localRetry = { ...(envelope.localRetry ?? {}), notBeforeMs: 0 }
  await writeFile(path, JSON.stringify(envelope))
}

test('a business error with no status code cannot pin the queue', async (t) => {
  const { root, base, env } = await fixture(t)
  const records = []
  for (const sequence of [1, 2, 3, 4, 5]) records.push(await custody(root, sequence))
  const transportEnv = { ...env, RECOVERY_FAIL_RECORD_ID: records[0].recordId }

  const first = await runUpload(root, { env: transportEnv })
  assert.ok(first.uploaded > 0, 'the run must probe the other half and keep draining')
  assert.ok(first.deferredUntilMs > Date.now(), 'an unknown failure must schedule a retry, not fail the run')
  assert.equal(first.deadLettered, 0, 'one ambiguous failure is not enough to discard a record')

  // Repeated failures of the same record, with the service still answering, are
  // treated as a request problem and isolated.
  let deadLettered = 0
  for (let round = 0; round < 6 && !deadLettered; round++) {
    await makeDue(base, records[0].recordId)
    deadLettered = (await runUpload(root, { env: transportEnv })).deadLettered
  }
  assert.equal(deadLettered, 1)
  assert.deepEqual((await readdir(join(base, 'outbox'))).filter(name => name.endsWith(records[0].recordId + '.json')), [])
  const receipt = JSON.parse(await readFile(join(base, 'receipts', `${records[0].recordId}.json`)))
  assert.equal(receipt.status, 'dead_letter')
  for (const record of records.slice(1))
    assert.equal(JSON.parse(await readFile(join(base, 'receipts', `${record.recordId}.json`))).status, 'uploaded')
  const starts = (await logs(env.RECOVERY_TRANSPORT_LOG)).filter(entry => entry.phase === 'start')
  // 5 records, batched; bounded attempts, never one retry per second forever.
  assert.ok(starts.length <= 12, `unexpected transport churn: ${starts.length}`)
})

test('a successful but malformed response widens backoff without spending the attempt budget', async (t) => {
  const { root, base, env } = await fixture(t)
  await custody(root, 1)
  const jobEnv = { ...env, RECOVERY_MALFORMED_RESPONSE: '1' }
  const id = await enqueueWakeup(root, jobEnv, true)
  await runQueueWorker(root, jobEnv, { once: true })
  const first = await jobOf(base, id)
  assert.equal(first.attempts, 0, 'a deferred failure must not consume the dead-letter budget')
  assert.equal(first.failures, 1)
  const firstDelay = first.notBeforeMs - Date.now()
  assert.ok(firstDelay > 500, `first retry scheduled too early: ${firstDelay}ms`)

  await forceDue(base, id)
  await runQueueWorker(root, jobEnv, { once: true })
  const second = await jobOf(base, id)
  assert.equal(second.failures, 2)
  assert.equal(second.attempts, 0)
  const secondDelay = second.notBeforeMs - Date.now()
  assert.ok(secondDelay > firstDelay * 1.4, `backoff did not grow: ${firstDelay}ms then ${secondDelay}ms`)
})

test('a background wakeup honours the workspace cooldown instead of probing again', async (t) => {
  const { root, base, env } = await fixture(t)
  const record = await custody(root, 1)
  const failing = { ...env, RECOVERY_STATUS: '503' }
  const firstId = await enqueueWakeup(root, failing, true)
  await runQueueWorker(root, failing, { once: true })
  const state = JSON.parse(await readFile(join(base, 'state.json')))
  assert.ok(state.transportCooldownUntilMs > Date.now(), 'a transport failure must open the workspace cooldown')
  const before = (await logs(env.RECOVERY_TRANSPORT_LOG)).filter(entry => entry.phase === 'start').length

  // Simulate a lost notification plus a fresh hook during the outage.
  const jobs = (await readdir(join(base, 'jobs'))).filter(name => name.endsWith('.json'))
  for (const name of jobs)
    await writeFile(
      join(base, 'jobs', name),
      JSON.stringify({ ...JSON.parse(await readFile(join(base, 'jobs', name))), notBeforeMs: 0 })
    )
  await enqueueWakeup(root, failing, true)
  await runQueueWorker(root, failing, { once: true })
  const after = (await logs(env.RECOVERY_TRANSPORT_LOG)).filter(entry => entry.phase === 'start').length
  assert.equal(after, before, 'the cooldown must stop a new wakeup from contacting the endpoint')
  const health = JSON.parse(await readFile(join(base, 'health.json')))
  assert.equal(health.status, 'deferred')
  assert.equal(health.deferredReason, 'workspace_cooldown')
  assert.equal(JSON.parse(await readFile(join(base, 'receipts', `${record.recordId}.json`))).status, 'pending')
})

test('a whoami deadline is a transport timeout, not a login failure', async (t) => {
  const { root, env } = await fixture(t)
  const slow = join(root, 'slow-transport.mjs')
  await writeFile(slow, "#!/usr/bin/env node\nimport { setTimeout as delay } from 'node:timers/promises'\nawait delay(5000)\nprocess.stdout.write('{}\\n')\n")
  await chmod(slow, 0o700)
  const error = await actorIdentity({ ...env, TRANSPORT_CLI_PATH: slow }, 300).then(
    () => null,
    cause => cause
  )
  assert.ok(error, 'the deadline must reject')
  assert.equal(classifyTransport(error).kind, 'timeout')
  assert.doesNotMatch(String(error.message), /未登录|auth login/)
})

test('an explicit denial is still classified as authentication', async (t) => {
  const { root, env } = await fixture(t)
  const denied = join(root, 'denied-transport.mjs')
  await writeFile(denied, "#!/usr/bin/env node\nprocess.stderr.write('SSO unauthorized\\n')\nprocess.exit(1)\n")
  await chmod(denied, 0o700)
  const error = await actorIdentity({ ...env, TRANSPORT_CLI_PATH: denied }, 5_000).then(
    () => null,
    cause => cause
  )
  assert.equal(classifyTransport(error).kind, 'auth')
  assert.match(String(error.message), /未登录/)
})

test('a structured business code is classified without reading message text', async (t) => {
  const { env } = await fixture(t)
  const invalid = Object.assign(new Error('report request was refused'), { businessCode: 'INVALID_ARGUMENT' })
  assert.equal(classifyTransport(invalid).kind, 'deterministic')
  const timeout = Object.assign(new Error('transport 已安装但未登录；请先执行 transport auth login --bss'), { code: 'ETIMEDOUT' })
  assert.equal(classifyTransport(timeout).kind, 'timeout')
})

async function serviceFixture(t) {
  const { root, env } = await fixture(t)
  const bin = join(root, 'bin')
  await mkdir(bin, { recursive: true })
  const log = join(root, 'service.log')
  const darwin = process.platform === 'darwin'
  const script = `#!/bin/sh
printf '%s\\n' "$*" >> ${log}
pattern=\${FAKE_FAIL_PATTERN:-}
if [ -n "$pattern" ]; then
  case "$*" in *"$pattern"*) exit 1 ;; esac
fi
case "$*" in *is-active*) printf 'active\\n' ;; esac
case "$1" in *Linger*) printf "\${FAKE_LINGER:-yes}\\n" ;; esac
exit 0
`
  for (const name of darwin ? ['launchctl'] : ['systemctl', 'loginctl']) {
    const path = join(bin, name)
    await writeFile(path, script)
    await chmod(path, 0o700)
  }
  const serviceEnv = { ...env, PATH: `${bin}:${process.env.PATH}`, FAKE_LINGER: 'no' }
  return { root, env: serviceEnv, log, darwin, path: join(root, 'service.unit') }
}

test('scheduler activation loads and verifies the recovery service', async (t) => {
  const { env, log, darwin, path } = await serviceFixture(t)
  const activation = await activateRecoveryService(env, { platform: darwin ? 'darwin' : 'linux', path })
  assert.equal(activation.loaded, true)
  const calls = (await readFile(log, 'utf8')).trim().split('\n')
  if (darwin) {
    const index = calls.findIndex(line => line.startsWith('bootstrap gui/'))
    assert.ok(index >= 0, `bootstrap was not requested: ${calls.join(' | ')}`)
    assert.ok(calls[index].includes(path))
    assert.ok(calls.some(line => line.startsWith('print gui/')))
    assert.deepEqual(activation.hint, undefined)
  } else {
    assert.ok(calls.includes('--user daemon-reload'))
    assert.ok(calls.includes('--user enable --now scry-uploader.timer'))
    assert.equal(activation.lingerEnabled, false)
    assert.match(String(activation.hint), /enable-linger/)
  }
})

test('scheduler activation fails loudly and status reports the observed state', async (t) => {
  const { env, log, darwin, path } = await serviceFixture(t)
  const pattern = darwin ? 'bootstrap' : 'enable'
  await assert.rejects(
    () => activateRecoveryService({ ...env, FAKE_FAIL_PATTERN: pattern }, { platform: darwin ? 'darwin' : 'linux', path }),
    /failed \(exit 1\)/
  )
  const marker = join(env.XDG_CONFIG_HOME, 'scry-upload', 'install-marker.json')
  await mkdir(join(env.XDG_CONFIG_HOME, 'scry-upload'), { recursive: true })
  await writeFile(marker, JSON.stringify({ version: 1, platform: darwin ? 'darwin' : 'linux', path }))
  const status = await schedulerStatus({ ...env, FAKE_FAIL_PATTERN: darwin ? 'print' : 'is-active' })
  assert.equal(status.activation.state, 'not_loaded')
  const calls = (await readFile(log, 'utf8')).trim().split('\n')
  assert.ok(calls.length > 0)
})

test('lock helper discovery never silently disables exclusion', async (t) => {
  const { root } = await fixture(t)
  const { lockHelper, acquireDirectoryLock } = await import('../dist/locks.js')
  assert.equal(lockHelper('freebsd', { PATH: '/usr/bin' }), undefined)
  const flockOnDisk = ['/usr/bin/flock', '/bin/flock'].some(path => existsSync(path))
  assert.equal(lockHelper('linux', { PATH: '/definitely-missing' }) === undefined, !flockOnDisk)
  const original = process.platform
  Object.defineProperty(process, 'platform', { value: 'freebsd', configurable: true })
  try {
    await assert.rejects(() => acquireDirectoryLock(join(root, 'lock-target')), /kernel lock helper is unavailable/)
  } finally {
    Object.defineProperty(process, 'platform', { value: original, configurable: true })
  }
})

test('a background wakeup gives up its slot wait instead of parking a worker', async (t) => {
  const gate = join(await mkdtemp(join(tmpdir(), 'scry-slot-gate-')), 'gate')
  t.after(() => rm(gate, { force: true }))
  await writeFile(gate, 'hold\n')
  const shared = await fixture(t, { RECOVERY_GATE_FILE: gate })
  // Two gated flushes hold both user-level slots while a wakeup arrives.
  const holders = []
  const holding = []
  for (const sequence of [1, 2]) {
    const other = await fixture(t, { XDG_STATE_HOME: shared.env.XDG_STATE_HOME, RECOVERY_GATE_FILE: gate })
    await custody(other.root, sequence)
    holders.push(other)
    holding.push(
      runUpload(other.root, { env: { ...other.env, RECOVERY_GATE_FILE: gate }, mode: 'flush' }).catch(
        () => undefined
      )
    )
  }
  await waitFor(async () => {
    const started = await Promise.all(
      holders.map(async item => (await logs(item.env.RECOVERY_TRANSPORT_LOG)).filter(e => e.phase === 'start').length)
    )
    return started.reduce((sum, count) => sum + count, 0) >= 2
  })

  const record = await custody(shared.root, 3)
  const jobId = await enqueueWakeup(shared.root, shared.env, true)
  const started = Date.now()
  await runQueueWorker(shared.root, shared.env, { once: true })
  const elapsed = Date.now() - started
  assert.ok(elapsed < 4_000, `a busy slot wait must not park the worker (${elapsed}ms)`)
  const state = JSON.parse(await readFile(join(shared.base, 'state.json')))
  assert.equal(state.transportCooldownUntilMs, undefined, 'slot contention is not an endpoint failure')
  const job = await jobOf(shared.base, jobId)
  assert.equal(job.attempts, 0, 'slot contention must not spend the terminal budget')
  // Queue backoff is 1s with 0.8 jitter; the caller's own hint is at most 1s
  // and unconditional, so only backoff keeps the gap from collapsing.
  assert.ok(job.notBeforeMs >= Date.now() + 700, 'the retry gap must widen with consecutive contention')
  assert.equal(JSON.parse(await readFile(join(shared.base, 'receipts', `${record.recordId}.json`))).status, 'pending')
  await rm(gate, { force: true })
  // Let the two flushes finish before teardown removes their workspaces.
  await Promise.all(holding)
})

async function freeForRetry(base) {
  const path = join(base, 'state.json')
  const state = JSON.parse(await readFile(path))
  // Simulate the cooldown window ending while keeping the failure count.
  delete state.transportCooldownUntilMs
  await writeFile(path, JSON.stringify(state))
  const jobs = join(base, 'jobs')
  for (const name of (await readdir(jobs)).filter(entry => entry.endsWith('.json')))
    await writeFile(join(jobs, name), JSON.stringify({ ...JSON.parse(await readFile(join(jobs, name))), notBeforeMs: 0 }))
  const outbox = join(base, 'outbox')
  for (const name of (await readdir(outbox)).filter(entry => entry.endsWith('.json'))) {
    const target = join(outbox, name)
    const envelope = JSON.parse(await readFile(target))
    if (!envelope.localRetry) continue
    envelope.localRetry.notBeforeMs = 0
    await writeFile(target, JSON.stringify(envelope))
  }
}

async function deadLetterNames(base) {
  return (await readdir(join(base, 'dead-letter')).catch(() => [])).filter(name => /^\d{20}-[a-f0-9]{32,64}\.json$/.test(name))
}

test('a service-wide unrecognised failure never dead-letters intact records', async (t) => {
  const { root, base, env } = await fixture(t)
  const records = []
  for (const sequence of [1, 2, 3, 4, 5]) records.push(await custody(root, sequence))
  const outage = { ...env, RECOVERY_ALL_BUSINESS_ERROR: '服务繁忙，请稍后重试' }
  await enqueueWakeup(root, outage, true)
  const startsPerRun = []
  for (let round = 0; round < 5; round++) {
    const before = (await logs(env.RECOVERY_TRANSPORT_LOG)).filter(entry => entry.phase === 'start').length
    await runQueueWorker(root, outage, { once: true })
    startsPerRun.push((await logs(env.RECOVERY_TRANSPORT_LOG)).filter(entry => entry.phase === 'start').length - before)
    await freeForRetry(base)
  }
  assert.deepEqual(await deadLetterNames(base), [], 'an outage must not bury intact records')
  assert.ok(startsPerRun.every(count => count <= 2), `each run must stay bounded, saw ${startsPerRun.join(',')}`)
  const state = JSON.parse(await readFile(join(base, 'state.json')))
  assert.ok(state.transportFailures >= 1, 'the outage must accumulate the workspace cooldown')
  const outbox = (await readdir(join(base, 'outbox'))).filter(name => name.endsWith('.json'))
  assert.equal(outbox.length, 5)
  for (const name of outbox) {
    const envelope = JSON.parse(await readFile(join(base, 'outbox', name)))
    // A probed half may still be waiting for its next attempt, so the retry
    // record is optional; what matters is that no budget was spent.
    assert.equal(envelope.localRetry?.attempts ?? 0, 0, 'a service failure must not spend a record budget')
  }
  const status = await localUploadStatus(root)
  assert.equal(status.deadLetterRecords, 0)
  assert.equal(status.outboxPending, 5)
})

test('a run too close to its deadline starts no report request', async (t) => {
  const clockDir = await mkdtemp(join(tmpdir(), 'scry-clock-'))
  t.after(() => rm(clockDir, { recursive: true, force: true }))
  const clock = join(clockDir, 'count')
  await writeFile(clock, '0\n')
  const { root, base, env } = await fixture(t, {
    RECOVERY_CLOCK_FILE: clock,
    RECOVERY_CLOCK_ALL_PHASES: '1',
    SCRY_UPLOAD_DEADLINE_SECONDS: '30'
  })
  const baseNow = Date.now()
  // Preparation alone consumes two 10-second steps, leaving less than the
  // 20-second floor, so the report request must never start.
  mock.method(Date, 'now', () => baseNow + Number(readFileSync(clock, 'utf8')) * 10_000)
  try {
    const record = await custody(root, 1)
    await enqueueWakeup(root, env)
    await runQueueWorker(root, env, { once: true })
    const reports = await logs(env.RECOVERY_TRANSPORT_LOG)
    assert.equal(reports.filter(entry => entry.phase === 'start').length, 0, 'no request may be cut by our own deadline')
    const status = await localUploadStatus(root)
    assert.equal(status.timeoutRecords, 0)
    assert.equal(status.outboxPending, 1)
    const state = JSON.parse(await readFile(join(base, 'state.json')))
    assert.equal(state.transportFailures, undefined, 'a budget truncation is not an endpoint failure')
    const envelope = JSON.parse(await readFile(join(base, 'outbox', `${String(1).padStart(20, '0')}-${record.recordId}.json`)))
    assert.equal(envelope.localRetry, undefined)
    assert.equal(JSON.parse(await readFile(join(base, 'receipts', `${record.recordId}.json`))).status, 'pending')
  } finally {
    mock.restoreAll()
  }
})

test('redrive returns a dead-lettered record to the queue and it uploads', async (t) => {
  const { root, base, env } = await fixture(t)
  const record = await custody(root, 1)
  const rejected = { ...env, RECOVERY_FAIL_RECORD_ID: record.recordId, RECOVERY_BUSINESS_CODE: 'INVALID_ARGUMENT' }
  for (let round = 0; round < 3; round++) {
    await runUpload(root, { env: rejected })
    await freeForRetry(base)
  }
  assert.deepEqual(await deadLetterNames(base), [`${String(1).padStart(20, '0')}-${record.recordId}.json`])
  assert.equal(JSON.parse(await readFile(join(base, 'receipts', `${record.recordId}.json`))).status, 'dead_letter')

  const redriven = await redriveDeadLetters(root, { reason: 'fixture redrive' })
  assert.deepEqual(redriven.redriven, [record.recordId])
  assert.deepEqual(redriven.skipped, [])
  assert.equal(JSON.parse(await readFile(join(base, 'receipts', `${record.recordId}.json`))).status, 'pending')
  assert.deepEqual(await deadLetterNames(base), [])
  const archived = JSON.parse(
    await readFile(join(base, 'dead-letter', 'redriven', `${String(1).padStart(20, '0')}-${record.recordId}.json`))
  )
  assert.equal(archived.redrive.reason, 'fixture redrive')

  await freeForRetry(base)
  const result = await runUpload(root, { env })
  assert.equal(result.uploaded, 1)
  assert.equal(JSON.parse(await readFile(join(base, 'receipts', `${record.recordId}.json`))).remoteStatus, 'inserted')
})
