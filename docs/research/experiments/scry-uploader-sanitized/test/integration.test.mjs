import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { ensureTransportInstalled } from '../dist/transport.js'
import { initWorkspace, isUploaderBridge } from '../dist/init.js'
import { enqueueWakeup, runQueueWorker } from '../dist/queue.js'
import { localUploadStatus, runUpload } from '../dist/uploader.js'
import { run } from '../dist/util.js'

const fixtureTransport = fileURLToPath(new URL('./fixtures/fake-transport.mjs', import.meta.url))

test('package pins the tested Scry release', async () => {
  const packageJson = JSON.parse(
    await readFile(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')
  )
  assert.equal(packageJson.dependencies['@review/scry-turn-recorder'], '0.2.53')
})

test('init dependency check installs transport when it is missing', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'scry-uploader-transport-test-'))
  t.after(async () => await rm(root, { recursive: true, force: true }))
  const target = join(root, 'bin', 'transport')
  const testEnv = { ...process.env, TRANSPORT_CLI_PATH: target }
  const installer = `#!/bin/sh
set -e
test "$TRANSPORT_SKIP_OPTIONAL_COMPONENT" = "1"
test "$TRANSPORT_SKIP_PATH" = "1"
test "$TRANSPORT_INSTALL_AUX_CLI" = "0"
mkdir -p "$TRANSPORT_INSTALL_DIR"
cat > "$TRANSPORT_INSTALL_DIR/transport" <<'SCRIPT'
#!/bin/sh
echo 'transport version 9.9.9'
SCRIPT
chmod 700 "$TRANSPORT_INSTALL_DIR/transport"
`
  const installed = await ensureTransportInstalled(testEnv, {
    fetch: async () => new Response(installer, { status: 200 })
  })
  assert.equal(installed, target)
  assert.equal(testEnv.TRANSPORT_CLI_PATH, target)
  assert.equal((await run(target, ['version'])).exitCode, 0)
})

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), 'scry-uploader-test-'))
  await run('git', ['init', '-b', 'main'], { cwd: root })
  await run('git', ['config', 'user.email', 'scry-test@example.com'], { cwd: root })
  await run('git', ['config', 'user.name', 'Scry Test'], { cwd: root })
  await writeFile(join(root, 'README.md'), '# fixture\n')
  await run('git', ['add', 'README.md'], { cwd: root })
  await run('git', ['commit', '-m', 'init'], { cwd: root })
  return root
}

function env(log) {
  return {
    ...process.env,
    TRANSPORT_CLI_PATH: fixtureTransport,
    HOME: join(log, '..', '.home'),
    XDG_STATE_HOME: join(log, '..', '.state'),
    FAKE_TRANSPORT_LOG: log,
    SCRY_UPLOADER_NO_SPAWN: '1'
  }
}

async function waitForDrain(root, minimumSequence, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  let status
  while (Date.now() < deadline) {
    status = await localUploadStatus(root)
    if (status.deadLetterJobs > 0) {
      const directory = join(root, '.scry/upload/jobs/dead-letter')
      const reasons = await Promise.all(
        (await readdir(directory)).map(async (name) => {
          const job = JSON.parse(await readFile(join(directory, name), 'utf8'))
          return { id: job.id, lastError: job.lastError }
        })
      )
      assert.fail(`unexpected terminal jobs: ${JSON.stringify(reasons)}`)
    }
    if (
      Number(status.enqueuedThrough) >= minimumSequence &&
      status.outboxPending === 0 &&
      status.jobsPending === 0
    )
      return status
    await delay(250)
  }
  return status
}

async function completeClaudeTurn(root, testEnv, sessionId, filename = 'created.txt') {
  const hook = join(root, '.scry/provider-hook-scry.sh')
  const hookEnv = { ...testEnv, SCRY_RECORDER_TRANSPORT: 'direct' }
  // Recorder callbacks intentionally filter arbitrary environment keys. Keep
  // fixture workers under test control without weakening that production gate.
  const config = JSON.parse(await readFile(join(root, 'scry.config.json'), 'utf8'))
  const callback = join(root, config.commitHook.entry)
  const launcher = await readFile(callback, 'utf8')
  if (!launcher.includes('export SCRY_UPLOADER_NO_SPAWN=1')) {
    await writeFile(callback, launcher.replace('#!/bin/sh\n', '#!/bin/sh\nexport SCRY_UPLOADER_NO_SPAWN=1\n'))
    assert.match(await readFile(callback, 'utf8'), /export SCRY_UPLOADER_NO_SPAWN=1/)
  }
  const prompt = JSON.stringify({
    session_id: sessionId,
    timestamp: '2026-09-01T00:00:00.000Z',
    prompt: 'create a file'
  })
  assert.equal(
    (
      await run(hook, ['claude', 'UserPromptSubmit'], {
        cwd: root,
        env: hookEnv,
        input: prompt,
        timeoutMs: 20_000
      })
    ).exitCode,
    0
  )
  await writeFile(join(root, filename), `hello from ${sessionId}\n`)
  const stop = JSON.stringify({ session_id: sessionId, timestamp: '2026-09-01T00:00:01.000Z' })
  assert.equal(
    (await run(hook, ['claude', 'Stop'], { cwd: root, env: hookEnv, input: stop, timeoutMs: 20_000 }))
      .exitCode,
    0
  )
}

test('init upgrades an older bridge, preserves the cursor, and uploads a later Scry record', async (t) => {
  await chmod(fixtureTransport, 0o700)
  const root = await workspace()
  t.after(async () => await rm(root, { recursive: true, force: true }))
  const log = join(root, 'transport.log')
  const testEnv = env(log)

  await assert.rejects(() => initWorkspace(root, 'pi', testEnv), /Pi 不通过 scry-upload init 配置/)
  await assert.rejects(() => stat(join(root, '.scry')), { code: 'ENOENT' })
  const first = await initWorkspace(root, 'claude,codex,qoder,opencode', testEnv)
  const canonicalRoot = first.workspace
  assert.equal(first.baselineSequence, 0)
  assert.deepEqual(first.providers, ['claude', 'codex', 'qoder', 'opencode'])
  assert.equal(first.transportPath, fixtureTransport)
  assert.equal(isUploaderBridge(await readFile(join(canonicalRoot, '.scry/provider-hook.sh'), 'utf8')), true)
  assert.match(await readFile(join(canonicalRoot, '.scry/provider-hook.sh'), 'utf8'), /TRANSPORT_CLI_PATH=/)
  assert.match(
    await readFile(join(canonicalRoot, '.scry/upload/runtime/record-committed'), 'utf8'),
    /TRANSPORT_CLI_PATH=/
  )
  assert.match(await readFile(join(canonicalRoot, '.scry/upload/runtime/wakeup'), 'utf8'), /TRANSPORT_CLI_PATH=/)
  assert.match(
    await readFile(join(canonicalRoot, '.scry/provider-hook-scry.sh'), 'utf8'),
    /SCRY_HANDLER_ID=turn-recorder-v1/
  )

  const bridge = join(canonicalRoot, '.scry/provider-hook.sh')
  await writeFile(
    bridge,
    (await readFile(bridge, 'utf8')).replace('Managed by scry-upload 0.2.0', 'Managed by scry-upload 0.1.4')
  )
  assert.match(await readFile(bridge, 'utf8'), /Managed by scry-upload 0\.1\.4/)
  const second = await initWorkspace(root, 'claude,codex,qoder,opencode', testEnv)
  assert.equal(second.baselineSequence, 0)

  const sessionId = 'integration-session'
  await completeClaudeTurn(canonicalRoot, testEnv, sessionId)

  await runUpload(canonicalRoot, { env: testEnv, mode: 'flush' })
  await runQueueWorker(canonicalRoot, testEnv)
  const status = await localUploadStatus(canonicalRoot)
  assert.equal(status.outboxPending, 0)
  assert.equal(status.jobsPending, 0)
  assert.equal(status.enqueuedThrough, 1)
  assert.equal((await initWorkspace(root, 'claude,codex,qoder,opencode', testEnv)).baselineSequence, 1)
  const uploaded = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse)
  assert.equal(uploaded.length, 1)
  assert.equal(uploaded[0].payload.uploaderVersion, 'scry-uploader/0.2.0')
  assert.equal(uploaded[0].decoded[0].sessionId, sessionId)
  assert.equal(uploaded[0].decoded[0].workspace.root, canonicalRoot)
  assert.match(JSON.stringify(uploaded[0].decoded[0].diff), /created\.txt/)
})

test('transport failure keeps the durable outbox and a later flush drains it', async (t) => {
  const root = await workspace()
  t.after(async () => await rm(root, { recursive: true, force: true }))
  const log = join(root, 'transport.log')
  const testEnv = env(log)
  const initialized = await initWorkspace(root, 'claude', testEnv)
  await completeClaudeTurn(initialized.workspace, testEnv, 'retry-session', 'retry.txt')

  await assert.rejects(
    () => runUpload(initialized.workspace, { env: { ...testEnv, FAKE_TRANSPORT_MODE: 'fail' } }),
    { code: 'transport_submitTurns', retryable: true }
  )
  assert.equal((await localUploadStatus(initialized.workspace)).outboxPending, 1)

  const result = await runUpload(initialized.workspace, { env: testEnv })
  assert.equal(result.uploaded, 1)
  assert.equal(result.pending, 0)
  assert.equal((await localUploadStatus(initialized.workspace)).lastError, undefined)
})

test('bounded queue retries preserve payload across exhaustion, cooldown, and worker restart', async (t) => {
  const root = await workspace()
  t.after(async () => await rm(root, { recursive: true, force: true }))
  const log = join(root, 'transport.log')
  const testEnv = env(log)
  const { workspace: canonicalRoot } = await initWorkspace(root, 'claude', testEnv)
  await completeClaudeTurn(canonicalRoot, testEnv, 'automatic-retry-session', 'automatic-retry.txt')

  const jobsDirectory = join(canonicalRoot, '.scry/upload/jobs')
  const outboxDirectory = join(canonicalRoot, '.scry/upload/outbox')
  await writeFile(join(jobsDirectory, 'wakeup-recovery.json'), '{corrupted')
  await Promise.all(Array.from({ length: 10 }, () => enqueueWakeup(canonicalRoot, testEnv)))
  const jobs = (await readdir(jobsDirectory)).filter((name) => name.endsWith('.json'))
  assert.equal(jobs.length, 2) // one callback identity and one coalesced discovery job
  assert.equal(jobs.filter((name) => name === 'wakeup-recovery.json').length, 1)
  const invalid = (await readdir(join(jobsDirectory, 'dead-letter'))).find((name) =>
    name.startsWith('invalid-')
  )
  assert.equal(await readFile(join(jobsDirectory, 'dead-letter', invalid), 'utf8'), '{corrupted')

  const failing = { ...testEnv, FAKE_TRANSPORT_MODE: 'fail' }
  await runQueueWorker(canonicalRoot, failing, { once: true })
  let status = await localUploadStatus(canonicalRoot)
  assert.equal(status.outboxPending, 1)
  assert.equal(status.jobsPending, 2)
  const recordJobPath = join(
    jobsDirectory,
    jobs.find((name) => name.startsWith('record-'))
  )
  const failedJob = JSON.parse(await readFile(recordJobPath, 'utf8'))
  assert.equal(failedJob.attempts, 1)
  // The host-app contract is six job attempts, not unbounded retries.
  failedJob.attempts = 5
  failedJob.notBeforeMs = 0
  await writeFile(recordJobPath, JSON.stringify(failedJob))
  await runQueueWorker(canonicalRoot, failing, { once: true })
  status = await localUploadStatus(canonicalRoot)
  assert.equal(status.jobsPending, 1)
  assert.equal(status.deadLetterJobs, 2)
  assert.equal(status.outboxPending, 1) // exhausting a job never removes its data
  await assert.rejects(() => readFile(recordJobPath), { code: 'ENOENT' })

  await runQueueWorker(canonicalRoot, failing, { once: true })
  const jobPath = join(jobsDirectory, 'wakeup-recovery.json')
  const outboxPath = join(
    outboxDirectory,
    (await readdir(outboxDirectory)).find((name) => name.endsWith('.json'))
  )
  const envelope = JSON.parse(await readFile(outboxPath, 'utf8'))
  envelope.localRetry = { kind: 'report_timeout', attempts: 1, notBeforeMs: Date.now() + 60_000 }
  await writeFile(outboxPath, JSON.stringify(envelope))
  let retryJob = JSON.parse(await readFile(jobPath, 'utf8'))
  retryJob.notBeforeMs = 0
  await writeFile(jobPath, JSON.stringify(retryJob))
  const callsBeforeCooldown = await readFile(log, 'utf8')

  await runQueueWorker(canonicalRoot, testEnv, { once: true })
  status = await localUploadStatus(canonicalRoot)
  assert.equal(status.outboxPending, 1)
  assert.equal(status.jobsPending, 1)
  assert.equal(status.timeoutRecords, 1)
  assert.equal(typeof status.nextRetryAt, 'string')
  assert.equal(await readFile(log, 'utf8'), callsBeforeCooldown)
  retryJob = JSON.parse(await readFile(jobPath, 'utf8'))
  assert.ok(retryJob.notBeforeMs >= envelope.localRetry.notBeforeMs)

  envelope.localRetry.notBeforeMs = 0
  await writeFile(outboxPath, JSON.stringify(envelope))
  retryJob.notBeforeMs = 0
  await writeFile(jobPath, JSON.stringify(retryJob))
  await runQueueWorker(canonicalRoot, testEnv, { once: true })
  status = await localUploadStatus(canonicalRoot)
  assert.equal(status.outboxPending, 0)
  assert.equal(status.jobsPending, 0)
  assert.equal(status.deadLetterJobs, 2)
})

test('a corrupt outbox item is quarantined without blocking later recovery', async (t) => {
  const root = await workspace()
  t.after(async () => await rm(root, { recursive: true, force: true }))
  const testEnv = env(join(root, 'transport.log'))
  const initialized = await initWorkspace(root, 'claude', testEnv)
  const base = join(initialized.workspace, '.scry', 'upload')
  await writeFile(join(base, 'outbox', 'corrupt.json'), '{not-json')

  await runQueueWorker(initialized.workspace, testEnv, { once: true })
  const status = await localUploadStatus(initialized.workspace)
  const jobs = await Promise.all(
    (await readdir(join(base, 'jobs')))
      .filter((name) => name.endsWith('.json'))
      .map(async (name) => JSON.parse(await readFile(join(base, 'jobs', name), 'utf8')))
  )
  assert.equal(status.outboxPending, 0, JSON.stringify(jobs.map((job) => job.lastError)))
  assert.equal(status.jobsPending, 0)
  assert.equal(status.deadLetterRecords, 1)
  const quarantined = (await readdir(join(base, 'dead-letter'))).find((name) => name.endsWith('corrupt.json'))
  assert.equal(await readFile(join(base, 'dead-letter', quarantined), 'utf8'), '{not-json')
})

test('detached worker recovers from a temporary outage without manual flush', async (t) => {
  const root = await workspace()
  t.after(async () => await rm(root, { recursive: true, force: true }))
  const log = join(root, 'transport.log')
  const remainingFailures = join(root, 'failures-left')
  const testEnv = env(log)
  const initialized = await initWorkspace(root, 'claude', testEnv)
  const canonicalRoot = initialized.workspace
  await completeClaudeTurn(canonicalRoot, testEnv, 'background-retry-session', 'background-retry.txt')
  await writeFile(remainingFailures, '2\n')

  const spawnedEnv = { ...testEnv, FAKE_TRANSPORT_FAILS_LEFT_FILE: remainingFailures }
  delete spawnedEnv.SCRY_UPLOADER_NO_SPAWN
  await enqueueWakeup(canonicalRoot, spawnedEnv)

  const status = await waitForDrain(canonicalRoot, 1)
  assert.equal(status?.outboxPending, 0)
  assert.equal(status?.jobsPending, 0)
  assert.equal(status?.deadLetterJobs, 0)
  assert.equal(Number(await readFile(remainingFailures, 'utf8')), 0)
  assert.equal((await readFile(log, 'utf8')).trim().split('\n').length, 3)
})

test('lost success response is retried with the same identity and accepted as duplicate', async (t) => {
  const root = await workspace()
  t.after(async () => await rm(root, { recursive: true, force: true }))
  const log = join(root, 'transport.log')
  const committed = join(root, 'remote-committed-records')
  const testEnv = env(log)
  const initialized = await initWorkspace(root, 'claude', testEnv)
  await completeClaudeTurn(
    initialized.workspace,
    testEnv,
    'ambiguous-success-session',
    'ambiguous-success.txt'
  )

  const spawnedEnv = { ...testEnv, FAKE_TRANSPORT_COMMITTED_FILE: committed }
  delete spawnedEnv.SCRY_UPLOADER_NO_SPAWN
  await enqueueWakeup(initialized.workspace, spawnedEnv)

  const status = await waitForDrain(initialized.workspace, 1)
  assert.equal(status?.outboxPending, 0)
  assert.equal(status?.jobsPending, 0)
  assert.equal(status?.deadLetterRecords, 0)
  const calls = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse)
  assert.equal(calls.length, 2)
  assert.equal(calls[0].decoded[0].recordId, calls[1].decoded[0].recordId)
  assert.equal((await readFile(committed, 'utf8')).trim(), calls[0].decoded[0].recordId)
})

test('a detached retry worker does not recreate a deleted Git workspace', async (t) => {
  const root = await workspace()
  const removed = `${root}-removed`
  t.after(async () => {
    await rm(root, { recursive: true, force: true })
    await rm(removed, { recursive: true, force: true })
  })
  const log = join(root, 'transport.log')
  const testEnv = env(log)
  const initialized = await initWorkspace(root, 'claude', testEnv)
  await completeClaudeTurn(
    initialized.workspace,
    testEnv,
    'deleted-workspace-session',
    'deleted-workspace.txt'
  )

  const spawnedEnv = { ...testEnv, FAKE_TRANSPORT_MODE: 'fail' }
  delete spawnedEnv.SCRY_UPLOADER_NO_SPAWN
  await enqueueWakeup(initialized.workspace, spawnedEnv)
  for (let attempt = 0; attempt < 120; attempt++) {
    const status = await localUploadStatus(initialized.workspace)
    if (Number(status.retryingJobs) > 0) break
    await delay(100)
  }
  // Atomically remove the active path. Concurrent recursive rm can itself fail
  // with ENOTEMPTY while a writer creates a temp file, before deletion occurs.
  await rename(root, removed)
  await delay(2_500)
  await assert.rejects(() => stat(root), { code: 'ENOENT' })
})

test('init refuses to override an existing commitHook', async (t) => {
  const root = await workspace()
  t.after(async () => await rm(root, { recursive: true, force: true }))
  await writeFile(
    join(root, 'scry.config.json'),
    JSON.stringify({
      schemaVersion: 1,
      enabled: true,
      workspaceId: 'fixture',
      dataDir: '.scry',
      commitHook: { entry: 'custom.sh', files: ['custom.sh'] },
      repositories: { mode: 'workspace-only' },
      capture: { prompt: true, assistant: true, toolOutput: 'summary', diff: true, hooks: true }
    })
  )
  await assert.rejects(() => initWorkspace(root, 'claude', env(join(root, 'transport.log'))), /不会覆盖/)
})
