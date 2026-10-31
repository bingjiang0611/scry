import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile
} from 'node:fs/promises'
import { promisify } from 'node:util'
import { mock, test } from 'node:test'
import { tmpdir } from 'node:os'
import { realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { fixture, writeCanonical, custody, logs, waitFor, reportIds, cli } from './fixtures/recovery-helpers.mjs'
import { enqueueWakeup, runQueueWorker } from '../dist/queue.js'
import { actorIdentity, toolArgumentStyle } from '../dist/transport.js'
import {
  localUploadStatus,
  runUpload,
  setUploadPolicy
} from '../dist/uploader.js'
import { recoverRegistered, registerWorkspace } from '../dist/scheduler.js'

const exec = promisify(execFile)
// The fake report count advances a logical clock. There is no wall-clock sleep.
test('R3 deadline defers after exactly 35 uploaded records and preserves the job budget', { concurrency: false }, async (t) => {
  const clockDir = await realpath(await mkdtemp(join(tmpdir(), 'scry-clock-')))
  t.after(() => rm(clockDir, { recursive: true, force: true }))
  const clock = join(clockDir, 'count')
  await writeFile(clock, '0\n')
  const { root, base, env } = await fixture(t, {
    RECOVERY_CLOCK_FILE: clock,
    SCRY_UPLOAD_DEADLINE_SECONDS: '35'
  })
  const baseNow = Date.now()
  mock.method(Date, 'now', () => baseNow + Number(readFileSync(clock, 'utf8')) * 5_000)
  try {
    for (let sequence = 1; sequence <= 60; sequence++) await custody(root, sequence)
    await enqueueWakeup(root, env)
    await runQueueWorker(root, env, { once: true })

    const firstStatus = await localUploadStatus(root)
    const firstHealth = JSON.parse(await readFile(join(base, 'health.json'), 'utf8'))
    const firstReports = await logs(env.RECOVERY_TRANSPORT_LOG)
    const firstIds = reportIds(firstReports)
    assert.equal(firstIds.length, 35)
    assert.equal(new Set(firstIds).size, 35)
    assert.equal(firstStatus.outboxPending, 25)
    assert.equal(firstHealth.status, 'deferred')
    assert.equal(firstHealth.lastUploadedCount, 35)
    const jobs = (await readdir(join(base, 'jobs'))).filter((entry) => entry.endsWith('.json'))
    assert.equal(jobs.length, 1)
    assert.equal(JSON.parse(await readFile(join(base, 'jobs', jobs[0]), 'utf8')).attempts, 0)

    // The persisted deferred notBefore is in the future at count 7. Advance to count 8;
    // the second invocation then has a fresh 35-second logical budget.
    await writeFile(clock, '8\n')
    await runQueueWorker(root, env, { once: true })
    const finalStatus = await localUploadStatus(root)
    const finalIds = reportIds(await logs(env.RECOVERY_TRANSPORT_LOG))
    assert.equal(finalStatus.outboxPending, 0)
    assert.equal(finalStatus.jobsPending, 0)
    assert.equal(finalIds.length, 60)
    assert.equal(new Set(finalIds).size, 60)
  } finally {
    mock.restoreAll()
  }
})

test('R5 export rejection quarantines an uncustodied bad record without starving good records', async (t) => {
  const { root, base, env } = await fixture(t, { RECOVERY_BAD_SEQUENCE: '2' })
  const good1 = await writeCanonical(root, 1, { fixture: 'good-1' })
  const bad2 = await writeCanonical(root, 2, { schemaVersion: 99 })
  const good5 = await writeCanonical(root, 5, { fixture: 'good-5' })

  const result = await runUpload(root, { env })
  assert.equal(result.uploaded, 2)
  const status = await localUploadStatus(root)
  assert.equal(status.enqueuedThrough, 5)
  const uploadedIds = reportIds(await logs(env.RECOVERY_TRANSPORT_LOG))
  assert.deepEqual(new Set(uploadedIds), new Set([good1.recordId, good5.recordId]))
  assert.equal(uploadedIds.includes(bad2.recordId), false)
  assert.deepEqual(
    await readFile(join(root, '.scry', 'records', bad2.filename)),
    Buffer.from(bad2.raw)
  )
  const payload = await readFile(join(base, 'dead-letter', 'payloads', bad2.filename), 'utf8')
  assert.equal(payload, bad2.raw)
  assert.equal(JSON.parse(await readFile(join(base, 'health.json'), 'utf8')).status, 'healthy')
})

test('R5 unknown exporter failure leaves cursor unchanged while custodied data drains', async (t) => {
  const { root, base, env } = await fixture(t, { RECOVERY_EXPORT_FAILURE: '1' })
  const record = await custody(root, 1)
  await assert.rejects(() => runUpload(root, { env }), { code: 'discovery_blocked' })
  assert.equal(JSON.parse(await readFile(join(base, 'state.json'), 'utf8')).enqueuedThrough, 0)
  assert.equal(JSON.parse(await readFile(join(base, 'receipts', `${record.recordId}.json`), 'utf8')).status, 'uploaded')
  assert.equal((await logs(env.RECOVERY_TRANSPORT_LOG)).filter((entry) => entry.phase === 'start').length, 1)
})

test('wire-size admission dead-letters incompressible records and accepts compressed records', async (t) => {
  const { root, env, base } = await fixture(t)
  const large = await custody(root, 1, { fixture: randomBytes(800_000).toString('base64') })
  const compressed = await custody(root, 2, { fixture: 'x'.repeat(700_000) })
  const result = await runUpload(root, { env })
  assert.equal(result.uploaded, 1)
  assert.equal(result.deadLettered, 1)
  const reports = (await logs(env.RECOVERY_TRANSPORT_LOG)).filter(entry => entry.phase === 'start')
  assert.equal(reports.length, 1)
  assert.ok(reports.every(report => report.bytes <= 512 * 1024))
  assert.equal(JSON.parse(await readFile(join(base, 'receipts', `${large.recordId}.json`), 'utf8')).status, 'dead_letter')
  assert.equal(JSON.parse(await readFile(join(base, 'receipts', `${compressed.recordId}.json`), 'utf8')).status, 'uploaded')
})

test('disable persists across a new CLI process and idempotent enable preserves new custody', async (t) => {
  const { root, env, base } = await fixture(t)
  const one = await custody(root, 1)
  await setUploadPolicy(root, false, env)

  const disabledEnv = { ...env }
  delete disabledEnv.SCRY_TURN_UPLOAD_ENABLED
  await exec(process.execPath, [cli, 'flush', '--workspace', root], { cwd: root, env: disabledEnv })
  assert.equal((await logs(env.RECOVERY_TRANSPORT_LOG)).filter((entry) => entry.phase === 'start').length, 0)

  await writeCanonical(root, 2)
  await setUploadPolicy(root, true, env)
  const three = await custody(root, 3)
  await setUploadPolicy(root, true, env)
  const result = await runUpload(root, { env: disabledEnv })
  assert.equal(result.uploaded, 1)
  assert.equal(JSON.parse(await readFile(join(base, 'receipts', `${one.recordId}.json`), 'utf8')).status, 'skipped_disabled')
  assert.equal(JSON.parse(await readFile(join(base, 'receipts', `${three.recordId}.json`), 'utf8')).status, 'uploaded')
  assert.deepEqual(reportIds(await logs(env.RECOVERY_TRANSPORT_LOG)), [three.recordId])
})

test('actor and tool caches invalidate on atomic auth inode replacement', async (t) => {
  const { root, env } = await fixture(t)
  const authDir = join(root, 'home', '.config', 'transport')
  const auth = join(authDir, 'auth.yaml')
  await mkdir(authDir, { recursive: true })
  await writeFile(auth, JSON.stringify({ subject_id: 'first', nickname: 'First' }))
  assert.equal((await actorIdentity(env)).userId, 'first')
  assert.equal(await toolArgumentStyle(env), 'named')
  assert.equal((await actorIdentity(env)).userId, 'first')
  assert.equal(await toolArgumentStyle(env), 'named')
  await writeFile(`${auth}.new`, JSON.stringify({ subject_id: 'second', nickname: 'Second' }))
  await rename(`${auth}.new`, auth)
  assert.equal((await actorIdentity(env)).userId, 'second')
  assert.equal(await toolArgumentStyle(env), 'named')
  const entries = await logs(env.RECOVERY_TRANSPORT_LOG)
  assert.equal(entries.filter((entry) => entry.phase === 'actor').length, 2)
  assert.equal(entries.filter((entry) => entry.phase === 'schema').length, 2)
})

async function exactWorkerPids(root) {
  const escaped = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = `^${escaped(process.execPath)} ${escaped(cli)} _worker --workspace ${escaped(root)}$`
  try {
    const result = await exec('pgrep', ['-f', pattern])
    return result.stdout.trim().split('\n').filter(Boolean).map((line) => Number(line.trim()))
  } catch (error) {
    if (error?.code === 1) return []
    throw error
  }
}

test('R4 lost wakeup leaves one exact worker and drains a record added while claimed', async (t) => {
  const gateDir = await realpath(await mkdtemp(join(tmpdir(), 'scry-gate-')))
  t.after(() => rm(gateDir, { recursive: true, force: true }))
  const { root, env } = await fixture(t, { RECOVERY_GATE_FILE: join(gateDir, 'gate') })
  const gate = env.RECOVERY_GATE_FILE
  await writeFile(gate, 'hold\n')
  const first = await custody(root, 1)
  let second
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [cli, 'wakeup', '--workspace', root], {
        cwd: root,
        env: { ...env, SCRY_UPLOADER_NO_SPAWN: undefined },
        stdio: 'ignore'
      })
      child.once('error', reject)
      child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`wakeup exit ${code}`)))
    })
    await waitFor(async () => (await logs(env.RECOVERY_TRANSPORT_LOG)).some((entry) => entry.phase === 'start'))
    second = await custody(root, 2)
    const wakeups = Array.from({ length: 10 }, () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [cli, 'wakeup', '--workspace', root], {
        cwd: root,
        env: { ...env, SCRY_UPLOADER_NO_SPAWN: undefined },
        stdio: 'ignore'
      })
      child.once('error', reject)
      child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`wakeup exit ${code}`)))
    }))
    await Promise.all(wakeups)
    await waitFor(async () => (await exactWorkerPids(root)).length === 1)
    await rm(gate, { force: true })
    await waitFor(async () => {
      const status = await localUploadStatus(root)
      return status.outboxPending === 0 && status.jobsPending === 0 && (await exactWorkerPids(root)).length === 0
    }, 10_000)
    assert.deepEqual(reportIds(await logs(env.RECOVERY_TRANSPORT_LOG)).sort(), [first.recordId, second.recordId].sort())
    assert.equal((await localUploadStatus(root)).jobsPending, 0)
  } finally {
    await rm(gate, { force: true })
    await waitFor(async () => (await exactWorkerPids(root)).length === 0, 5_000).catch(async (error) => {
      for (const pid of await exactWorkerPids(root)) process.kill(pid, 'SIGTERM')
      await waitFor(async () => (await exactWorkerPids(root)).length === 0, 5_000)
      throw error
    })
  }
})

test('R6 a cooldown workspace does not starve the other registered workspaces', async (t) => {
  const first = await fixture(t)
  const shared = {
    HOME: first.env.HOME,
    XDG_STATE_HOME: first.env.XDG_STATE_HOME,
    XDG_CONFIG_HOME: first.env.XDG_CONFIG_HOME,
    RECOVERY_TRANSPORT_LOG: first.env.RECOVERY_TRANSPORT_LOG
  }
  const fixtures = [first, await fixture(t, shared), await fixture(t, shared)]
  for (const item of fixtures) {
    await custody(item.root, 1)
    await registerWorkspace(item.root, item.env)
  }
  await enqueueWakeup(first.root, first.env)
  const jobPath = join(first.base, 'jobs', 'wakeup-recovery.json')
  const job = JSON.parse(await readFile(jobPath, 'utf8'))
  job.notBeforeMs = Date.now() + 60_000
  await writeFile(jobPath, JSON.stringify(job))
  await recoverRegistered(first.env)
  assert.equal((await localUploadStatus(first.root)).committedPending, 1)
  assert.equal(reportIds(await logs(shared.RECOVERY_TRANSPORT_LOG)).length, 2)
  assert.equal(JSON.parse(await readFile(jobPath, 'utf8')).notBeforeMs, job.notBeforeMs)
  job.notBeforeMs = 0
  await writeFile(jobPath, JSON.stringify(job))
  await recoverRegistered(first.env)
  assert.equal(reportIds(await logs(shared.RECOVERY_TRANSPORT_LOG)).length, 3)
  assert.equal((await localUploadStatus(first.root)).committedPending, 0)
})

test('R6 registered recovery continues after one unrecoverable workspace setup failure', async (t) => {
  const shared = await realpath(await mkdtemp(join(tmpdir(), 'scry-shared-home-')))
  t.after(() => rm(shared, { recursive: true, force: true }))
  const sharedEnv = {
    HOME: join(shared, 'home'),
    XDG_STATE_HOME: join(shared, 'state'),
    XDG_CONFIG_HOME: join(shared, 'config'),
    RECOVERY_TRANSPORT_LOG: join(shared, 'recovery.log')
  }
  const fixtures = await Promise.all([0, 1, 2].map(() => fixture(t, sharedEnv)))
  for (const item of fixtures) {
    await custody(item.root, 1)
    await registerWorkspace(item.root, item.env)
  }
  const blockedJobs = join(fixtures[1].base, 'jobs')
  await rm(blockedJobs, { recursive: true })
  await writeFile(blockedJobs, 'not a directory')
  await assert.rejects(recoverRegistered(fixtures[0].env), /recovery failed/)
  assert.equal((await localUploadStatus(fixtures[0].root)).outboxPending, 0)
  assert.equal((await localUploadStatus(fixtures[2].root)).outboxPending, 0)
  assert.equal(reportIds(await logs(sharedEnv.RECOVERY_TRANSPORT_LOG)).length, 2)
})

test('R6 global admission holds three processes until two slots are observable', async (t) => {
  const shared = await realpath(await mkdtemp(join(tmpdir(), 'scry-global-cap-')))
  t.after(() => rm(shared, { recursive: true, force: true }))
  const gate = join(shared, 'gate')
  const log = join(shared, 'reports.log')
  await writeFile(gate, 'hold\n')
  const common = {
    HOME: join(shared, 'home'),
    XDG_STATE_HOME: join(shared, 'state'),
    XDG_CONFIG_HOME: join(shared, 'config'),
    RECOVERY_TRANSPORT_LOG: log,
    RECOVERY_GATE_FILE: gate
  }
  const fixtures = await Promise.all([0, 1, 2].map(() => fixture(t, common)))
  for (const item of fixtures) await custody(item.root, 1)
  const children = fixtures.map((item) => spawn(process.execPath, [cli, 'flush', '--workspace', item.root], {
    cwd: item.root,
    env: { ...process.env, ...item.env, ...common, SCRY_UPLOADER_NO_SPAWN: '1' },
    stdio: 'ignore'
  }))
  const childExit = (child) => new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`flush exit ${code}`)))
  })
  const exits = children.map(childExit)
  for (const exit of exits) void exit.catch(() => undefined)
  try {
    await waitFor(async () => {
      const health = await Promise.all(fixtures.map((item) => readFile(join(item.base, 'health.json'), 'utf8').catch(() => '')))
      return health.every((raw) => raw && JSON.parse(raw).status === 'upload_in_progress')
    })
    await waitFor(async () => {
      const entries = await logs(log)
      const slots = await readdir(join(common.XDG_STATE_HOME, 'scry-upload', 'admission')).catch(() => [])
      return entries.filter((entry) => entry.phase === 'start').length >= 2 && slots.includes('slot-0.native') && slots.includes('slot-1.native')
    })
    await assert.rejects(waitFor(async () =>
      (await logs(log)).filter(entry => entry.phase === 'start').length > 2, 600), /bounded wait expired/)
    assert.equal((await logs(log)).filter((entry) => entry.phase === 'start').length, 2)
    await rm(gate, { force: true })
    await Promise.all(exits)
    const active = new Set()
    let maximum = 0
    for (const entry of await logs(log)) {
      if (entry.phase === 'start') {
        active.add(entry.pid)
        maximum = Math.max(maximum, active.size)
      } else if (entry.phase === 'end') active.delete(entry.pid)
    }
    assert.equal(maximum, 2)
  } finally {
    await rm(gate, { force: true })
    for (const child of children) if (!child.killed && child.exitCode === null) child.kill('SIGTERM')
    await Promise.allSettled(exits)
  }
})
