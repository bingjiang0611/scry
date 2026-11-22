import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { readIdentity } from './b4v/process-identity.mjs'
import { sampleDaemonResources } from './daemon-resource-sampling.mjs'

it('samples RSS and CPU from the live lock holder of this benchmark only', async () => {
  const root = mkdtempSync(join(tmpdir(), 'scry-resource-sampling-'))
  const home = join(root, 'home')
  const userData = join(root, 'userData')
  const daemonState = join(userData, 'daemon')
  const lock = join(daemonState, 'daemon.lock')
  mkdirSync(home)
  mkdirSync(daemonState, { recursive: true })
  const child = spawn(process.execPath, ['-e', 'process.stdin.resume()'], {
    env: { HOME: home, SCRY_DAEMON_STATE_DIR: daemonState, SCRY_DAEMON_USER_DATA_DIR: userData },
    stdio: ['pipe', 'ignore', 'ignore']
  })
  const exited = once(child, 'exit')
  await once(child, 'spawn')
  const identity = readIdentity(child.pid)
  try {
    expect(identity).toBeDefined()
    expect(sampleDaemonResources(userData)).toMatchObject({ status: 'unavailable' })

    writeFileSync(lock, JSON.stringify(identity))
    const sample = sampleDaemonResources(userData)
    expect(sample).toMatchObject({ status: 'measured', pid: child.pid })
    expect(sample.rssBytes).toBeGreaterThan(0)
    expect(sample.cpuTimeMs).toBeGreaterThanOrEqual(0)

    const foreign = join(root, 'foreign')
    mkdirSync(join(foreign, 'daemon'), { recursive: true })
    writeFileSync(join(foreign, 'daemon', 'daemon.lock'), JSON.stringify(identity))
    expect(sampleDaemonResources(foreign)).toMatchObject({ status: 'unavailable' })

    writeFileSync(lock, JSON.stringify({ ...identity, identityKey: 'retired holder' }))
    expect(sampleDaemonResources(userData)).toMatchObject({ status: 'unavailable' })
  } finally {
    child.stdin.end()
    await exited
    rmSync(root, { recursive: true, force: true })
  }
})
