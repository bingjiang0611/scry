import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { repositoryName } from '../dist/transport.js'
import { safeSnapshotMaxSequence } from '../dist/scry.js'
import { acquireDirectoryLock, run } from '../dist/util.js'
import { initializeUploadState, prepareUploadRoot, pruneAckedBodies, runUpload, setUploadPolicy, takeCustody, uploadRoot } from '../dist/uploader.js'
import { classifyTransport } from '../dist/retry.js'
import { recoverRegistered, registerWorkspace, registeredWorkspaces } from '../dist/scheduler.js'
import { enqueueWakeup } from '../dist/queue.js'

test('run preserves large protocol stdout and drains descendant output on close', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'scry-run-close-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const script = join(root, 'child.mjs')
  await writeFile(
    script,
    "import { spawn } from 'node:child_process'; process.stdout.write('parent'); spawn(process.execPath, ['-e', \"setTimeout(() => process.stdout.write('x'.repeat(70000)), 20)\"], { stdio: ['ignore', 'inherit', 'inherit'] }).unref(); process.stderr.write('diagnostic')\n"
  )
  const result = await run(process.execPath, [script], { timeoutMs: 2_000 })
  assert.equal(result.exitCode, 0)
  assert.equal(result.stdout.length, 70006)
  assert.equal(result.stdout.startsWith('parent'), true)
  assert.equal(result.stderr, 'diagnostic')
})

test('safe enable baseline uses snapshotMaxSequence, not nextCursor', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'scry-highwater-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const scry = join(root, 'scry.mjs')
  await writeFile(scry, "#!/usr/bin/env node\nconsole.log(JSON.stringify({records:[],nextCursor:9007199254740991,snapshotMaxSequence:2690,hasMore:false}))\n")
  await chmod(scry, 0o700)
  assert.equal(await safeSnapshotMaxSequence(root, { ...process.env, SCRY_CLI_PATH: scry }), 2690)
})

test('structured deadline, timeout, and 504 failures classify as retryable transport', () => {
  const deadline = Object.assign(new Error('deadline exceeded'), { code: 'DEADLINE_EXCEEDED' })
  const timeout = Object.assign(new Error('operation failed'), { code: 'ETIMEDOUT' })
  const gateway = Object.assign(new Error('provider response'), { statusCode: 504, stderr: 'gateway timeout' })
  assert.equal(classifyTransport(deadline).kind, 'timeout')
  assert.equal(classifyTransport(timeout).kind, 'timeout')
  assert.equal(classifyTransport(gateway).kind, 'transient')
})

test('poisoned batch is bisected and later records still upload', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'scry-poison-batch-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'scry.config.json'), JSON.stringify({ schemaVersion: 1, workspaceId: 'fixture' }))
  await mkdir(join(root, '.scry', 'records'), { recursive: true })
  const transport = join(root, 'transport.mjs')
  await writeFile(transport, `#!/usr/bin/env node
const args = process.argv.slice(2)
if (args.includes('whoami')) process.stdout.write(JSON.stringify({subject_id:'e',nickname:'n'}))
else if (args.includes('list-tools')) process.stdout.write(JSON.stringify([{name:'submitTurns',inputSchema:{properties:{actorUserId:{},actorNick:{},repo:{},installationId:{},uploaderVersion:{},redactionVersion:{},records:{}}}}]))
else if (args.includes('call-tool')) { let input=''; for await (const c of process.stdin) input += c; const p=JSON.parse(input); const ids=p.records.map(x=>JSON.parse(x).recordId); if (ids.includes(process.env.POISON_ID)) { process.stderr.write('HTTP 400 bad request'); process.exit(1) } const items=ids.map((recordId,index)=>({index,recordId,status:'inserted'})); process.stdout.write(JSON.stringify({success:true,data:{received:items.length,inserted:items.length,duplicated:0,conflicted:0,rejected:0,items}})) }
else process.stdout.write('1.0.0')
`)
  await chmod(transport, 0o700)
  const scry = join(root, 'scry.mjs')
  await writeFile(scry, "#!/usr/bin/env node\nconsole.log(JSON.stringify({records:[],nextCursor:Number(process.argv[process.argv.indexOf('--after')+1]),snapshotMaxSequence:0,hasMore:false}))\n")
  await chmod(scry, 0o700)
  await prepareUploadRoot(root)
  await initializeUploadState(root, 0)
  const env = { ...process.env, TRANSPORT_CLI_PATH: transport, SCRY_CLI_PATH: scry, SCRY_UPLOADER_NO_SPAWN: '1', HOME: join(root, 'home'), XDG_STATE_HOME: join(root, 'state') }
  const ids = []
  for (let sequence = 1; sequence <= 12; sequence++) {
    const recordId = sequence.toString(16).padStart(32, '0')
    ids.push(recordId)
    const name = `${String(sequence).padStart(20, '0')}-${recordId}.json`
    const raw = JSON.stringify({ schemaVersion: 1, sequence, recordId, workspace: { id: 'fixture', root }, provider: 'pi', sessionId: 's' })
    await writeFile(join(root, '.scry', 'records', name), raw)
    await takeCustody(root, { schemaVersion: 2, event: 'record-committed', workspace: root, provider: 'pi', sessionId: 's', sequence, recordId, recordPath: `records/${name}` })
  }
  const poison = ids[0]
  const result = await runUpload(root, { env: { ...env, POISON_ID: poison } })
  assert.equal(typeof result.deferredUntilMs, 'number')
  assert.equal(result.uploaded, 11)
  for (const recordId of ids.slice(1)) {
    const receipt = JSON.parse(await readFile(join(uploadRoot(root), 'receipts', `${recordId}.json`), 'utf8'))
    assert.equal(receipt.status, 'uploaded')
  }
})

test('ten concurrent hook wakeups coalesce to one durable job', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'scry-hook-burst-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'scry.config.json'), JSON.stringify({ schemaVersion: 1, workspaceId: 'fixture' }))
  await prepareUploadRoot(root)
  await initializeUploadState(root, 0)
  const env = { ...process.env, SCRY_UPLOADER_NO_SPAWN: '1', HOME: join(root, 'home'), XDG_STATE_HOME: join(root, 'state') }
  await Promise.all(Array.from({ length: 10 }, () => enqueueWakeup(root, env)))
  const jobs = (await import('node:fs/promises')).readdir(join(uploadRoot(root), 'jobs'))
  assert.equal((await jobs).filter((name) => name.endsWith('.json')).length, 1)
})

test('recovery scans only three explicitly registered workspaces', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'scry-registry-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const scry = join(root, 'scry.mjs')
  await writeFile(scry, "#!/usr/bin/env node\nconsole.log(JSON.stringify({records:[],nextCursor:9007199254740991,snapshotMaxSequence:3,hasMore:false}))\n")
  await chmod(scry, 0o700)
  const env = { ...process.env, HOME: join(root, 'home'), XDG_CONFIG_HOME: join(root, 'config'), SCRY_CLI_PATH: scry, SCRY_RECORDER_ENABLED: '0', SCRY_UPLOADER_NO_SPAWN: '1' }
  const workspaces = []
  for (let index = 0; index < 3; index++) {
    const workspace = join(root, `workspace-${index}`)
    await mkdir(workspace, { recursive: true })
    await writeFile(join(workspace, 'scry.config.json'), JSON.stringify({ schemaVersion: 1, workspaceId: `w-${index}` }))
    await registerWorkspace(workspace, env)
    workspaces.push(await (await import('node:fs/promises')).realpath(workspace))
  }
  assert.deepEqual(await registeredWorkspaces(env), workspaces)
  await recoverRegistered(env)
  assert.deepEqual(await registeredWorkspaces(env), workspaces)
})

test('explicit enable does not release historical held custody', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'scry-enable-policy-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'scry.config.json'), JSON.stringify({ schemaVersion: 1, workspaceId: 'fixture' }))
  await mkdir(join(root, '.scry', 'records'), { recursive: true })
  const scry = join(root, 'scry.mjs')
  await writeFile(scry, "#!/usr/bin/env node\nconsole.log(JSON.stringify({records:[],nextCursor:Number(process.argv[process.argv.indexOf('--after')+1]),snapshotMaxSequence:0,hasMore:false}))\n")
  await chmod(scry, 0o700)
  await prepareUploadRoot(root)
  await initializeUploadState(root, 0)
  const env = { ...process.env, SCRY_CLI_PATH: scry, HOME: join(root, 'home'), XDG_STATE_HOME: join(root, 'state'), SCRY_UPLOADER_NO_SPAWN: '1' }
  const recordId = 'f'.repeat(32)
  const name = `00000000000000000001-${recordId}.json`
  const raw = JSON.stringify({ schemaVersion: 1, sequence: 1, recordId, workspace: { id: 'fixture', root }, provider: 'pi', sessionId: 's' })
  await writeFile(join(root, '.scry', 'records', name), raw)
  await takeCustody(root, { schemaVersion: 2, event: 'record-committed', workspace: root, provider: 'pi', sessionId: 's', sequence: 1, recordId, recordPath: `records/${name}` }, true)
  await setUploadPolicy(root, false, env)
  await setUploadPolicy(root, true, env)
  const receipt = JSON.parse(await readFile(join(uploadRoot(root), 'receipts', `${recordId}.json`), 'utf8'))
  assert.equal(receipt.status, 'skipped_disabled')
})

test('ACKed body pruning keeps the dedupe receipt after thirty days', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'scry-retention-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'scry.config.json'), JSON.stringify({ schemaVersion: 1, workspaceId: 'fixture' }))
  await mkdir(join(root, '.scry', 'records'), { recursive: true })
  await prepareUploadRoot(root)
  const recordId = 'e'.repeat(32)
  const name = `00000000000000000001-${recordId}.json`
  const body = Buffer.from('{"recordId":"' + recordId + '"}')
  await writeFile(join(root, '.scry', 'records', name), body)
  await takeCustody(root, { schemaVersion: 2, event: 'record-committed', workspace: root, provider: 'pi', sessionId: 's', sequence: 1, recordId, recordPath: `records/${name}` })
  const receiptPath = join(uploadRoot(root), 'receipts', `${recordId}.json`)
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'))
  receipt.status = 'uploaded'
  receipt.finishedAt = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString()
  await writeFile(receiptPath, JSON.stringify(receipt))
  assert.equal(await pruneAckedBodies(root), 1)
  await assert.rejects(() => readFile(join(uploadRoot(root), 'outbox', 'committed', name)), { code: 'ENOENT' })
  assert.equal(JSON.parse(await readFile(receiptPath, 'utf8')).status, 'uploaded')
  assert.deepEqual(await readFile(join(root, '.scry', 'records', name)), body)
  await rm(join(root, '.scry', 'records', name))
  const replay = await takeCustody(root, { recordId, sequence: 1, sha256: receipt.sha256 })
  assert.equal(replay.status, 'uploaded')
  assert.ok(replay.bodyPrunedAt)
  await assert.rejects(takeCustody(root, { recordId, sequence: 1, sha256: '0'.repeat(64) }), { code: 'notification_digest_mismatch' })
})

test('repository identity retains host and namespace without credentials', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'scry-repository-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await run('git', ['init', root])
  await writeFile(join(root, 'scry.config.json'), JSON.stringify({ schemaVersion: 1, workspaceId: 'x' }))
  await run('git', ['-C', root, 'remote', 'add', 'origin', 'https://user:token@git.example.test/group/fork/repo.git'])
  assert.equal(await repositoryName(root), 'git.example.test/group/fork/repo')
  await run('git', ['-C', root, 'remote', 'set-url', 'origin', 'https://user:pa@ss@git.example.test/group/fork/repo.git?token=synthetic-query#synthetic-fragment'])
  assert.equal(await repositoryName(root), 'git.example.test/group/fork/repo')
  await run('git', ['-C', root, 'remote', 'set-url', 'origin', 'git@git.example.test:研发/repo.git'])
  assert.equal(await repositoryName(root), 'git.example.test/研发/repo')
  const long = `https://git.example.test/${'a'.repeat(600)}`
  await run('git', ['-C', root, 'remote', 'set-url', 'origin', `${long}/first.git`])
  const first = await repositoryName(root)
  await run('git', ['-C', root, 'remote', 'set-url', 'origin', `${long}/second.git`])
  const second = await repositoryName(root)
  assert.match(first, /^sha256\/[a-f0-9]{64}$/)
  assert.notEqual(first, second)
})

test('simultaneous stale reclaim has one winner', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'scry-lock-reclaim-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const lock = join(root, 'lock')
  await (await import('node:fs/promises')).mkdir(lock)
  await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: 2147483647, createdAt: Date.now() }))
  const results = await Promise.allSettled([acquireDirectoryLock(lock), acquireDirectoryLock(lock)])
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
  const winner = results.find((result) => result.status === 'fulfilled')
  if (winner?.status === 'fulfilled') await winner.value()
})

test('legacy lock with EPERM ownership is fail-closed', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'scry-lock-eperm-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const lock = join(root, 'lock')
  await (await import('node:fs/promises')).mkdir(lock)
  await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, createdAt: Date.now() }))
  const originalKill = process.kill
  process.kill = (() => {
    throw Object.assign(new Error('permission denied'), { code: 'EPERM' })
  })
  try {
    await assert.rejects(() => acquireDirectoryLock(lock), /already running/)
  } finally {
    process.kill = originalKill
  }
})

test('stale release cannot unlock a replacement owner or replace the kernel inode', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'scry-lock-token-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const lock = join(root, 'lock')
  const { stat } = await import('node:fs/promises')
  const release = await acquireDirectoryLock(lock)
  const inode = (await stat(`${lock}.native`)).ino
  await release()
  const replacement = await acquireDirectoryLock(lock)
  try {
    await release()
    await assert.rejects(acquireDirectoryLock(lock), /upload worker is already running/)
    assert.equal((await stat(`${lock}.native`)).ino, inode)
  } finally {
    await replacement()
  }
})
