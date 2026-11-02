import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { fixture, waitFor } from './fixtures/recovery-helpers.mjs'
import { acquireDirectoryLock } from '../dist/util.js'

const exec = promisify(execFile)

test('unexpected kernel helper death terminates its writer instead of silently losing exclusion', async (t) => {
  const { root, env } = await fixture(t)
  const lock = join(root, 'lost-lease.lock')
  const moduleUrl = new URL('../dist/util.js', import.meta.url).href
  const program = `import { acquireDirectoryLock } from ${JSON.stringify(moduleUrl)};
    await acquireDirectoryLock(process.argv[1]); process.stdout.write('ready\\n')`
  const child = spawn(process.execPath, ['--input-type=module', '-e', program, lock], {
    env, cwd: root, stdio: ['ignore', 'pipe', 'pipe']
  })
  let output = ''
  child.stdout.on('data', chunk => { output += chunk.toString() })
  child.stderr.resume()
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal }))
  })
  try {
    await waitFor(() => output.includes('ready\n'))
    const helpers = (await exec('pgrep', ['-P', String(child.pid)])).stdout.trim().split('\n').map(Number)
    assert.equal(helpers.length, 1)
    const helper = helpers[0]
    const command = (await exec('ps', ['-p', String(helper), '-o', 'command='])).stdout
    assert.ok(command.includes(`${lock}.native`))
    assert.match(command, /\/(?:lockf|flock) /)
    process.kill(helper, 'SIGKILL')
    await waitFor(() => child.signalCode !== null)
    assert.equal((await closed).signal, 'SIGKILL')
    let release
    await waitFor(async () => {
      try {
        release = await acquireDirectoryLock(lock)
        return true
      } catch (error) {
        if (error.message === 'upload worker is already running') return false
        throw error
      }
    })
    await release()
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    await closed
  }
})
