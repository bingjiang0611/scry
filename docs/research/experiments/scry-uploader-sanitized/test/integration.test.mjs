import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { ensureTransportInstalled } from '../dist/transport.js'
import { initWorkspace, isUploaderBridge } from '../dist/init.js'
import { enqueueWakeup, runQueueWorker } from '../dist/queue.js'
import { localUploadStatus, runUpload } from '../dist/uploader.js'
import { run } from '../dist/util.js'
import { completeClaudeTurn, env, fixtureTransport, workspace } from './fixtures/integration-fixture.mjs'

test('package pins the tested Scry release', async () => {
  const packageJson = JSON.parse(
    await readFile(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')
  )
  assert.equal(packageJson.dependencies['@review/scry-turn-recorder'], '0.2.53')
})

test('native export without a commit callback retains canonical bytes and an ACK receipt', async (t) => {
  await chmod(fixtureTransport, 0o700)
  const root = await workspace()
  t.after(() => rm(root, { recursive: true, force: true }))
  const testEnv = env(join(root, 'transport.log'))
  await initWorkspace(root, 'claude', testEnv)
  const configPath = join(root, 'scry.config.json')
  const config = JSON.parse(await readFile(configPath, 'utf8'))
  delete config.commitHook
  await writeFile(configPath, JSON.stringify(config))
  await completeClaudeTurn(root, testEnv, 'native-discovery')
  const records = await readdir(join(root, '.scry/records'))
  assert.equal(records.length, 1)
  const raw = await readFile(join(root, '.scry/records', records[0]))
  const record = JSON.parse(raw)
  const base = join(root, '.scry/upload')
  assert.deepEqual(await readdir(join(base, 'receipts')), [])
  // Drop init's recovery wakeup as well as omitting record notifications.
  await rm(join(base, 'jobs', 'wakeup-recovery.json'))
  assert.deepEqual((await readdir(join(base, 'jobs'))).filter(name => name.endsWith('.json')), [])
  assert.equal((await runUpload(root, { env: testEnv })).uploaded, 1)
  const receipt = JSON.parse(await readFile(join(base, 'receipts', `${record.recordId}.json`)))
  assert.equal(receipt.status, 'uploaded')
  assert.equal(receipt.remoteStatus, 'inserted')
  assert.equal(receipt.sha256, createHash('sha256').update(raw).digest('hex'))
  assert.deepEqual(await readFile(join(base, 'outbox/committed', records[0])), raw)
  assert.deepEqual(await readFile(join(root, '.scry/records', records[0])), raw)
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
    (await readFile(bridge, 'utf8')).replace('Managed by scry-upload 0.2.6', 'Managed by scry-upload 0.1.4')
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
  assert.equal(uploaded[0].payload.uploaderVersion, 'scry-uploader/0.2.6')
  assert.equal(uploaded[0].decoded[0].sessionId, sessionId)
  assert.equal(uploaded[0].decoded[0].workspace.root, canonicalRoot)
  assert.match(JSON.stringify(uploaded[0].decoded[0].diff), /created\.txt/)
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
