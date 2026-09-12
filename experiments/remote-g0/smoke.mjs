import assert from 'node:assert/strict'
import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { certificates } from './fixture.mjs'
import { loopbackRelay } from './loopback-relay.mjs'
import { decodeWire } from './generated/wire.mjs'

const exec = promisify(execFile)
// SwiftPM's .build/debug symlink changes after cross-compiling for iOS. Resolve
// the host triple's real product path rather than executing that mutable alias.
const packagePath = fileURLToPath(new URL('swift/', import.meta.url))
const { stdout: binPath } = await exec('swift', ['build', '--package-path', packagePath, '--show-bin-path'], { timeout: 30_000 })
const binary = join(binPath.trim(), 'scry-remote-probe')
await access(binary, constants.X_OK)
const identity = await certificates()
const report = []
try {
  for (const configuration of [
    { name: 'valid TLS 1.3 mTLS over outbound WSS', success: true },
    { name: 'wrong outer relay CA', outerCA: 'wrong-ca.pem' },
    { name: 'replaced inner host anchor', innerCA: 'wrong-ca.pem' },
    { name: 'untrusted device certificate', device: 'impostor' },
    { name: 'relay tampers with encrypted record', fault: 'tamper' },
    { name: 'relay disconnects encrypted stream', fault: 'disconnect' },
    { name: 'fresh authenticated connection after failure', success: true }
  ]) {
    const sentinel = `scry-g0-private-${randomUUID()}-👋`
    const instance = await loopbackRelay(identity, { fault: configuration.fault, sentinel })
    try {
      let result
      let failure
      try {
        result = await exec(binary, [String(instance.port), identity.path(configuration.outerCA || 'outer-ca.pem'),
          identity.path(configuration.innerCA || 'inner-ca.pem'), identity.path((configuration.device || 'device') + '.pem'),
          identity.path((configuration.device || 'device') + '.key'), sentinel], { timeout: 15_000, maxBuffer: 1024 * 1024 })
      } catch (error) { failure = error }
      if (configuration.success) {
        assert.equal(failure, undefined, `${configuration.name}: ${failure?.stderr}; ${JSON.stringify(instance.stats)}`)
        const reply = decodeWire('ProbeResponse', JSON.parse(result.stdout.trim()))
        assert.equal(reply.payload, sentinel)
        assert.equal(instance.stats.requests, 1)
        assert.deepEqual(instance.stats.innerTLS, [{ protocol: 'TLSv1.3', resumed: false }])
        assert.ok(instance.stats.frames > 2)
      } else {
        assert.ok(failure, configuration.name + ' must be rejected')
        assert.equal(failure.killed, false, 'negative result must not be a test runner timeout')
        assert.equal(instance.stats.requests, 0, 'no application request accepted on failed channel')
        if (configuration.fault) assert.equal(instance.stats.faultInjected, true)
      }
      assert.equal(instance.stats.plaintextObserved, false)
      report.push({ case: configuration.name, passed: true, ...instance.stats })
    } finally { await instance.cleanup() }
  }
  console.log(JSON.stringify({ scope: 'G0-local transport only; no pairing grant, iPhone, APNs or Provider execution', cases: report }, null, 2))
} finally { await identity.cleanup() }
