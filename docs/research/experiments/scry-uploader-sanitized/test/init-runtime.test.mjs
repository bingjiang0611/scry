import assert from 'node:assert/strict'
import { access, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { doctorWorkspace, initWorkspace } from '../dist/init.js'
import { uploadRoot } from '../dist/uploader.js'
import { run } from '../dist/util.js'
import { env, workspace } from './fixtures/integration-fixture.mjs'

const CONFIGURED = { schemaVersion: 1, workspaceId: 'fixture', dataDir: 'custom-store' }
const LEGACY_ENTRY = '.scry/upload/runtime/record-committed'
const ENTRY = 'custom-store/upload/runtime/record-committed'

async function configuredWorkspace(t) {
  const root = await workspace()
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'scry.config.json'), JSON.stringify(CONFIGURED))
  return root
}

test('init places launchers, hook entry and doctor checks beside the configured queue', async (t) => {
  const root = await configuredWorkspace(t)
  const testEnv = env(join(root, 'transport.log'))
  await initWorkspace(root, 'claude', testEnv)

  const config = JSON.parse(await readFile(join(root, 'scry.config.json'), 'utf8'))
  assert.equal(config.commitHook.entry, ENTRY)
  assert.deepEqual(config.commitHook.files, [ENTRY])
  assert.equal(uploadRoot(root), join(root, 'custom-store/upload'))

  const wrapper = await readFile(join(root, '.scry', 'provider-hook.sh'), 'utf8')
  assert.ok(wrapper.includes("runtime='custom-store/upload/runtime'"))
  assert.ok(wrapper.includes('"$workspace/$runtime/wakeup"'))
  assert.ok(!wrapper.includes('.scry/upload/runtime'))

  // Scry's own bridge stays under .scry; uploader state must not appear there.
  assert.ok((await readFile(join(root, '.scry', 'provider-hook-scry.sh'), 'utf8')).length > 0)
  assert.equal((await readdir(join(root, '.scry'))).includes('upload'), false)

  const doctor = await doctorWorkspace(root, testEnv)
  assert.equal(doctor.healthy, true, JSON.stringify(doctor.checks))
})

test('re-running init repoints a hook entry written before dataDir was honored', async (t) => {
  const root = await configuredWorkspace(t)
  const testEnv = env(join(root, 'transport.log'))
  await initWorkspace(root, 'claude', testEnv)
  const config = JSON.parse(await readFile(join(root, 'scry.config.json'), 'utf8'))
  // Simulate the older version that always wrote the .scry path.
  await writeFile(
    join(root, 'scry.config.json'),
    JSON.stringify({ ...config, commitHook: { entry: LEGACY_ENTRY, files: [LEGACY_ENTRY] } })
  )

  await initWorkspace(root, 'claude', testEnv)
  const migrated = JSON.parse(await readFile(join(root, 'scry.config.json'), 'utf8'))
  assert.equal(migrated.commitHook.entry, ENTRY)
  assert.ok(
    (await readFile(join(root, '.scry', 'provider-hook.sh'), 'utf8')).includes('custom-store/upload/runtime')
  )
  assert.equal((await doctorWorkspace(root, testEnv)).healthy, true)
})

test('a foreign commitHook is still refused', async (t) => {
  const root = await configuredWorkspace(t)
  const testEnv = env(join(root, 'transport.log'))
  const foreign = { entry: 'scripts/my-hook.sh', files: ['scripts/my-hook.sh'] }
  await writeFile(join(root, 'scry.config.json'), JSON.stringify({ ...CONFIGURED, commitHook: foreign }))
  await assert.rejects(initWorkspace(root, 'claude', testEnv), /已配置其他 commitHook/)
  assert.deepEqual(JSON.parse(await readFile(join(root, 'scry.config.json'), 'utf8')).commitHook, foreign)
})

test('init without a custom dataDir keeps the historical .scry location', async (t) => {
  const root = await workspace()
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'scry.config.json'), JSON.stringify({ schemaVersion: 1, workspaceId: 'fixture' }))
  const testEnv = env(join(root, 'transport.log'))
  await initWorkspace(root, 'claude', testEnv)
  const config = JSON.parse(await readFile(join(root, 'scry.config.json'), 'utf8'))
  assert.equal(config.commitHook.entry, LEGACY_ENTRY)
  assert.equal(uploadRoot(root), join(root, '.scry/upload'))
})

test('a dataDir with shell metacharacters is quoted, not executed', async (t) => {
  const root = await workspace()
  t.after(() => rm(root, { recursive: true, force: true }))
  const marker = join(root, 'PWNED')
  // Valid single-segment directory name, hostile to a shell command word.
  const dataDir = "s$(touch PWNED)`touch PWNED2`'q"
  await writeFile(join(root, 'scry.config.json'), JSON.stringify({ ...CONFIGURED, dataDir }))
  const testEnv = env(join(root, 'transport.log'))
  await initWorkspace(root, 'claude', testEnv)

  const wrapper = await readFile(join(root, '.scry', 'provider-hook.sh'), 'utf8')
  // The escaped form proves the path is data inside a quoted variable.
  const quote = "'"
  const escaped = quote + dataDir.replaceAll(quote, `${quote}\\${quote}${quote}`) + '/upload/runtime' + quote
  assert.ok(wrapper.includes(`runtime=${escaped}`), wrapper)

  // Running the hook must reach the real launcher and never evaluate the name.
  await run(join(root, '.scry', 'provider-hook.sh'), ['Stop', 'Stop'], {
    cwd: root,
    env: testEnv,
    timeoutMs: 60_000
  })
  await access(join(root, dataDir, 'upload', 'runtime', 'wakeup'))
  const jobs = await readdir(join(root, dataDir, 'upload', 'jobs'))
  assert.ok(jobs.some(name => name.startsWith('wakeup-')), jobs.join(','))
  for (const target of [marker, join(root, 'PWNED2')]) {
    await assert.rejects(() => access(target), { code: 'ENOENT' })
  }
})
