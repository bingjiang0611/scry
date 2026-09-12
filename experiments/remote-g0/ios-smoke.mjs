import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { writeFile, mkdir, mkdtemp, rm, open } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { certificates } from './fixture.mjs'
import { loopbackRelay } from './loopback-relay.mjs'

const exec = promisify(execFile)
const simulator = process.argv[2]
assert.match(simulator || '', /^[0-9A-F-]{36}$/i, 'Pass the dedicated, already-installed G0 simulator UUID')
const project = fileURLToPath(new URL('../../apps/ios/ScryRemoteG0.xcodeproj', import.meta.url))
// Xcode relocates an app's data container during installation, so the process
// ownership fence must live outside that movable directory.
const lockPath = join(tmpdir(), `scry-g0-ios-${simulator}.lock`)
// One native test fixture per simulator. Never overwrite/remove another run's
// fixture, even if an earlier XCTest already consumed our original file.
const lock = await open(lockPath, 'wx', 0o600)
let identity, relay
let ownMaterial = false
let releaseLock = true
let evidence, materialPath
try {
  evidence = await mkdtemp(join(tmpdir(), 'scry-g0-ios-result-'))
  await lock.writeFile(JSON.stringify({ pid: process.pid, simulator, evidence, startedAt: new Date().toISOString() }))
  // bootstatus -b is idempotent; a prior xcodebuild may have shut it down.
  await exec('xcrun', ['simctl', 'bootstatus', simulator, '-b'], { timeout: 120_000 })
  materialPath = await fixturePath()
  await mkdir(dirname(materialPath), { recursive: true })
  // Do not start the host's TLS handshake deadline while Xcode is compiling.
  await xcode('build-for-testing', 'build.log')
  identity = await certificates()
  relay = await loopbackRelay(identity)
  const encoded = name => identity.read(name).then(bytes => bytes.toString('base64'))
  const fixture = { version: 1, port: relay.port, outerCA: await encoded('outer-ca.pem'), innerCA: await encoded('inner-ca.pem'),
    certificate: await encoded('device.pem'), privateKey: await encoded('device.key') }
  await writeFile(materialPath, JSON.stringify(fixture), { mode: 0o600, flag: 'wx' })
  ownMaterial = true
  await xcode('test-without-building', 'xcodebuild.log', ['-resultBundlePath', join(evidence, 'tests.xcresult')])
  assert.equal(relay.stats.requests, 1, 'native model accepts just one concurrent probe intent')
  assert.deepEqual(relay.stats.innerTLS, [{ protocol: 'TLSv1.3', resumed: false }])
  const { plaintextObserved: _notInspected, ...transportStats } = relay.stats
  const report = { scope: 'Real iOS Simulator app + Keychain + shared NIOSSL transport, not iPhone or pairing', ...transportStats, plaintextInspection: 'not_performed', evidence }
  await writeFile(join(evidence, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
} finally {
  const cleanup = await Promise.allSettled([
    ownMaterial ? cleanupMaterial() : Promise.resolve(),
    relay?.cleanup(), identity?.cleanup(), lock.close()
  ])
  const failures = cleanup.filter(result => result.status === 'rejected')
  if (releaseLock && !failures.length) await rm(lockPath)
  else console.error(`G0 lock retained: ${lockPath}. Inspect the original process/test evidence before any retry.`)
  if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'G0 cleanup incomplete')
}

async function fixturePath() {
  const { stdout } = await exec('xcrun', ['simctl', 'get_app_container', simulator, 'com.scry.remote.g0', 'data'], { timeout: 20_000 })
  return join(stdout.trim(), 'Documents', 'g0-loopback-test-fixture.json')
}

async function cleanupMaterial() {
  // Resolve again after Xcode installation, rather than reporting a cleanup of
  // an obsolete container path as success. The simulator-wide lock is held.
  const current = await fixturePath()
  await rm(current, { force: true })
  if (current !== materialPath) await rm(materialPath, { force: true })
}

async function xcode(action, logName, extra = []) {
  try {
    const output = await exec('xcodebuild', ['-project', project, '-scheme', 'ScryRemoteG0', '-configuration', 'Debug',
      '-destination', `platform=iOS Simulator,id=${simulator}`, '-derivedDataPath', '/tmp/scry-g0-xcode-build',
      '-parallel-testing-enabled', 'NO', ...extra, action], { timeout: 240_000, maxBuffer: 32 * 1024 * 1024 })
    await writeFile(join(evidence, logName), output.stdout + output.stderr)
  } catch (error) {
    // Killing xcodebuild does not prove every test-runner descendant stopped.
    // Preserve the ownership fence on timeout/signal, rather than enable replay.
    if (error.killed || error.signal) releaseLock = false
    await writeFile(join(evidence, logName), (error.stdout || '') + (error.stderr || ''))
    throw new Error(`iOS ${action} failed; inspect ${evidence}/${logName} before retrying`, { cause: error.code })
  }
}
