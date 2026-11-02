import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { run, sleep } from '../dist/util.js'
import { fixture } from './fixtures/recovery-helpers.mjs'

const transport = fileURLToPath(new URL('./fixtures/recovery-transport.mjs', import.meta.url))
const request = JSON.stringify({ records: [JSON.stringify({ recordId: 'a'.repeat(32) })] })

// Removes the gate at the moment the fixture's own check reports it present, so
// watch() sees a missing file. This is the real interleaving, made deterministic.
const PRELOAD = `
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
const check = fs.existsSync
let fired = false
fs.existsSync = path => {
  const present = check(path)
  if (present && !fired && path === process.env.RECOVERY_GATE_FILE) {
    fired = true
    fs.unlinkSync(path)
  }
  return present
}
syncBuiltinESMExports()
`

test('a gate released between the existence check and the watch releases the request', async (t) => {
  const { root, env } = await fixture(t)
  const gate = join(root, 'gate')
  const preload = join(root, 'release-gate.mjs')
  await writeFile(preload, PRELOAD)

  // Control: a gate that is already gone behaves the same way.
  const released = await run(process.execPath, [transport, 'call-tool'], {
    env: { ...env, RECOVERY_GATE_FILE: gate },
    input: request,
    timeoutMs: 20000
  })
  assert.equal(released.exitCode, 0, released.stderr)
  assert.equal(JSON.parse(released.stdout).success, true)

  await writeFile(gate, 'hold\n')
  const raced = await run(process.execPath, ['--import', preload, transport, 'call-tool'], {
    env: { ...env, RECOVERY_GATE_FILE: gate },
    input: request,
    timeoutMs: 20000
  })
  assert.equal(raced.exitCode, 0, raced.stderr)
  assert.equal(JSON.parse(raced.stdout).success, true)
  await rm(gate, { force: true })
})

test('a held gate keeps the request open until the gate is released', async (t) => {
  const { root, env } = await fixture(t)
  const gate = join(root, 'gate')
  await writeFile(gate, 'hold\n')
  const child = spawn(process.execPath, [transport, 'call-tool'], {
    env: { ...env, RECOVERY_GATE_FILE: gate },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  let stdout = ''
  child.stdout.on('data', chunk => { stdout += chunk.toString() })
  child.stderr.resume()
  child.stdin.end(request)
  const closed = new Promise(resolve => child.once('close', code => resolve(code)))
  try {
    await sleep(400)
    assert.equal(child.exitCode, null, 'a held gate must not answer early')
    assert.equal(stdout, '')
    await rm(gate, { force: true })
    assert.equal(await closed, 0)
    assert.equal(JSON.parse(stdout).success, true)
  } finally {
    await rm(gate, { force: true })
    if (child.exitCode === null) child.kill('SIGTERM')
  }
})
