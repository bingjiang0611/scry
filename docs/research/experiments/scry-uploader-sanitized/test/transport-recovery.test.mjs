import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { actorIdentity } from '../dist/transport.js'
import { enqueueWakeup, runQueueWorker } from '../dist/queue.js'
import { classifyTransport } from '../dist/retry.js'
import { activateRecoveryService, schedulerStatus } from '../dist/scheduler.js'
import { runUpload } from '../dist/uploader.js'
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
  assert.equal(first.uploaded, 0)
  assert.ok(first.deferredUntilMs > Date.now(), 'an unknown failure must schedule a retry, not fail the run')

  // The next run must skip the deferred poison record and drain the rest.
  const second = await runUpload(root, { env: transportEnv })
  assert.equal(second.uploaded, 4)
  assert.equal((await readdir(join(base, 'outbox'))).filter(name => name.endsWith(`${records[0].recordId}.json`)).length, 1)

  // Repeated isolated failures are treated as a request problem and isolated.
  await makeDue(base, records[0].recordId)
  await runUpload(root, { env: transportEnv })
  await makeDue(base, records[0].recordId)
  const final = await runUpload(root, { env: transportEnv })
  assert.equal(final.deadLettered, 1)
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
  for (const sequence of [1, 2]) {
    const other = await fixture(t, { XDG_STATE_HOME: shared.env.XDG_STATE_HOME, RECOVERY_GATE_FILE: gate })
    await custody(other.root, sequence)
    holders.push(other)
    void runUpload(other.root, { env: { ...other.env, RECOVERY_GATE_FILE: gate }, mode: 'flush' }).catch(
      () => undefined
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
})
