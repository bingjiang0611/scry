import assert from 'node:assert/strict'
import fs from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { recoverRegistered, registeredWorkspaces, registerWorkspace } from '../dist/scheduler.js'
import { run } from '../dist/util.js'
import { fixture, custody, logs } from './fixtures/recovery-helpers.mjs'

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url))

test('one inaccessible registered path cannot prevent recovery of another workspace', async (t) => {
  const good = await fixture(t)
  const bad = await fixture(t)
  await registerWorkspace(bad.root, good.env)
  await registerWorkspace(good.root, good.env)
  const record = await custody(good.root, 1)
  const original = fs.promises.realpath
  fs.promises.realpath = async (...args) => {
    if (String(args[0]) === bad.root) throw Object.assign(new Error('fixture permission denied'), { code: 'EACCES' })
    return await original(...args)
  }
  syncBuiltinESMExports()
  try {
    assert.deepEqual(new Set(await registeredWorkspaces(good.env)), new Set([bad.root, good.root]))
    await assert.rejects(() => recoverRegistered(good.env), AggregateError)
    assert.equal(JSON.parse(await readFile(join(good.base, 'receipts', `${record.recordId}.json`))).status, 'uploaded')
    const health = JSON.parse(await readFile(join(good.env.XDG_CONFIG_HOME, 'scry-upload', 'recovery-health.json')))
    assert.equal(health.failures.length, 1)
    assert.equal(health.failures[0].code, 'EACCES')
    assert.ok(health.failures[0].message.includes(bad.root))
  } finally {
    fs.promises.realpath = original
    syncBuiltinESMExports()
  }
})

test('the CLI can unregister a saved canonical path after its directory is removed', async (t) => {
  const host = await fixture(t)
  const removed = await fixture(t)
  await registerWorkspace(removed.root, host.env)
  await rm(removed.root, { recursive: true, force: true })
  assert.deepEqual(await registeredWorkspaces(host.env), [removed.root])
  const result = await run(process.execPath, [cli, 'unregister', '--workspace', removed.root], { cwd: host.root, env: host.env, timeoutMs: 10_000 })
  assert.equal(result.exitCode, 0, result.stderr)
  assert.deepEqual(await registeredWorkspaces(host.env), [])
  assert.equal((await logs(host.env.RECOVERY_TRANSPORT_LOG)).length, 0)
})
