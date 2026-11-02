import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { localUploadStatus } from '../../dist/uploader.js'
import { run } from '../../dist/util.js'

export const fixtureTransport = fileURLToPath(new URL('./fake-transport.mjs', import.meta.url))

export async function workspace() {
  const root = await mkdtemp(join(tmpdir(), 'scry-uploader-test-'))
  await run('git', ['init', '-b', 'main'], { cwd: root })
  await run('git', ['config', 'user.email', 'scry-test@example.com'], { cwd: root })
  await run('git', ['config', 'user.name', 'Scry Test'], { cwd: root })
  await writeFile(join(root, 'README.md'), '# fixture\n')
  await run('git', ['add', 'README.md'], { cwd: root })
  await run('git', ['commit', '-m', 'init'], { cwd: root })
  return root
}

export function env(log) {
  return {
    ...process.env,
    TRANSPORT_CLI_PATH: fixtureTransport,
    HOME: join(log, '..', '.home'),
    XDG_STATE_HOME: join(log, '..', '.state'),
    FAKE_TRANSPORT_LOG: log,
    SCRY_UPLOADER_NO_SPAWN: '1'
  }
}

export async function waitForDrain(root, minimumSequence, timeoutMs = 60_000) {
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

export async function clearTransportCooldown(root) {
  // Test control for wall-clock time: the circuit breaker is asserted in
  // transport-recovery.test.mjs, here only the drain path matters.
  const path = join(root, '.scry/upload/state.json')
  const state = JSON.parse(await readFile(path, 'utf8'))
  delete state.transportFailures
  delete state.transportCooldownUntilMs
  await writeFile(path, JSON.stringify(state))
}

export async function completeClaudeTurn(root, testEnv, sessionId, filename = 'created.txt') {
  const hook = join(root, '.scry/provider-hook-scry.sh')
  const hookEnv = { ...testEnv, SCRY_RECORDER_TRANSPORT: 'direct' }
  // Recorder callbacks intentionally filter arbitrary environment keys. Keep
  // fixture workers under test control without weakening that production gate.
  const config = JSON.parse(await readFile(join(root, 'scry.config.json'), 'utf8'))
  if (config.commitHook) {
    const callback = join(root, config.commitHook.entry)
    const launcher = await readFile(callback, 'utf8')
    if (!launcher.includes('export SCRY_UPLOADER_NO_SPAWN=1')) {
      await writeFile(callback, launcher.replace('#!/bin/sh\n', '#!/bin/sh\nexport SCRY_UPLOADER_NO_SPAWN=1\n'))
      assert.match(await readFile(callback, 'utf8'), /export SCRY_UPLOADER_NO_SPAWN=1/)
    }
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
