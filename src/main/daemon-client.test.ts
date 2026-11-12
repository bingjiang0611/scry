import 'reflect-metadata'
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { webcrypto } from 'node:crypto'
import { cryptoProvider } from '@peculiar/x509'
import { ensureHostIdentity } from './remote/host-identity'
import { createHostController } from './remote/host-controller-factory'
import { InnerMtlsHost } from './remote/inner-mtls-host'
import { RunOutputFileStore } from './remote/run-output-file'
import { ProviderOperationGate } from './provider-operation-gate'
import { openLocalChannel } from '../daemon/local-channel'
import { localEnrollHandlers, openLocalEnrollSocket, openLocalEnrollmentStore } from '../daemon/local-enrollment'
import { DaemonClient, DaemonClientError, daemonClientPaths, type DaemonClientOptions } from './daemon-client'
import { buildIdentity } from '../shared/build-identity'

// The App-side client against the daemon's real endpoints: the same inner-mTLS host,
// the same enrollment socket, the same unix socket. Only the provider runtime is
// replaced, because the client is under test, not a run.
type PeculiarCrypto = Parameters<typeof cryptoProvider.set>[0]
cryptoProvider.set(webcrypto as unknown as PeculiarCrypto)

const VERSION = '0.2.237'
const BUILD_OLD = '3b04ee8'.padEnd(64, 'a')
const BUILD_NEW = '0bf3e97'.padEnd(64, 'b')
const dirs: string[] = []
const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
  for (const directory of dirs.splice(0)) rmSync(directory, { recursive: true, force: true })
})

async function harness(options: { version?: string; build?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'scry-daemon-client-'))
  dirs.push(root)
  const daemonStateDirectory = join(root, 'daemon')
  const userDataDir = join(root, 'userData')
  const identity = await ensureHostIdentity(join(root, 'identity'))
  const binding = await createHostController({
    stateDirectory: root,
    hostId: identity.hostId,
    anchorSHA256: identity.anchorSHA256,
    verifyCSR: identity.verifyCSR,
    issue: identity.issue,
    authorizeWorkspace: (cwd) => cwd,
    startRun: async () => {},
    gate: new ProviderOperationGate(),
    readSessionStatus: () => 'not_observed',
    createOutputStore: (dir) => new RunOutputFileStore(dir)
  })
  cleanups.push(() => binding.close())
  const server = await identity.issueHostServer()
  const controller = binding.controller
  const localHost = new InnerMtlsHost({
    controller,
    serverCertPEM: server.certificatePEM,
    serverKeyPEM: server.privateKeyPEM,
    caPEM: identity.caCertificatePEM,
    transport: 'local',
    info: buildIdentity(options.version ?? VERSION, options.build)
  })
  cleanups.push(() => localHost.close())
  const channel = await openLocalChannel({ directory: daemonStateDirectory, serve: (stream) => localHost.serve(stream) })
  cleanups.push(() => channel.close())
  const store = openLocalEnrollmentStore(daemonStateDirectory)
  store.ensure(controller.authority.inspectLocal().grants.some((grant) => grant.scope === 'local' && grant.revokedAt === null))
  const enrollSocket = await openLocalEnrollSocket({
    directory: daemonStateDirectory,
    enroll: localEnrollHandlers(store, { enrollLocal: (input, consume) => controller.authority.enrollLocal(input, consume) },
      identity.caCertificatePEM, buildIdentity(options.version ?? VERSION, options.build))
  })
  cleanups.push(() => enrollSocket.close())
  return { root, daemonStateDirectory, userDataDir, controller, store, identity }
}

// A deterministic stand-in for safeStorage: the test only checks that the file is
// unreadable as plaintext and mode 0600, not the platform cipher.
const encrypt = (value: string) => Buffer.from(value.split('').reverse().join(''), 'utf8')
const decrypt = (value: Buffer) => value.toString('utf8').split('').reverse().join('')

function client(env: Awaited<ReturnType<typeof harness>>, overrides: Partial<DaemonClientOptions> = {}) {
  return new DaemonClient({
    paths: daemonClientPaths(env.daemonStateDirectory, env.userDataDir),
    appVersion: VERSION,
    encrypt,
    decrypt,
    ...overrides
  })
}

describe('daemon client admission (L2: probe, enroll, version)', () => {
  it('enrolls once, stores the grant 0600 and reuses it on the next connect', async () => {
    const env = await harness()
    const paths = daemonClientPaths(env.daemonStateDirectory, env.userDataDir)
    const first = client(env)
    expect(await first.connect()).toEqual({ version: VERSION, enrolled: true })
    first.close()
    expect(statSync(paths.statePath).mode & 0o777).toBe(0o600)
    // The stored document is ciphertext from the caller's perspective and carries the
    // private key, so it must not be plaintext PEM.
    expect(readFileSync(paths.statePath, 'utf8')).not.toContain('BEGIN PRIVATE KEY')
    // The one-time secret is spent by the daemon, and the App does not mint another.
    expect(existsSync(paths.secretPath)).toBe(false)

    const second = client(env)
    expect(await second.connect()).toEqual({ version: VERSION, enrolled: false })
    second.close()
    expect(env.controller.authority.inspectLocal().grants.filter((grant) => grant.scope === 'local' && grant.revokedAt === null)).toHaveLength(1)
  })

  it('refuses to enroll when no secret is pending', async () => {
    const env = await harness()
    const pending = client(env)
    expect((await pending.connect()).enrolled).toBe(true)
    pending.close()
    // A second App instance with no stored grant cannot re-enroll: the daemon only
    // writes a secret while no local grant is live.
    const other = client(env, { paths: daemonClientPaths(env.daemonStateDirectory, join(env.userDataDir, 'other')) })
    await expect(other.connect()).rejects.toMatchObject({ reason: 'daemon_enrollment_unavailable' })
  })

  it('reports the daemon version and refuses a daemon built from other sources', async () => {
    const env = await harness({ version: '0.2.199' })
    const mismatch = client(env)
    await expect(mismatch.connect()).rejects.toMatchObject({ reason: 'daemon_version_mismatch', running: '0.2.199' })
    // Nothing was persisted: a version mismatch must not leave a usable grant behind.
    expect(existsSync(daemonClientPaths(env.daemonStateDirectory, env.userDataDir).statePath)).toBe(false)
  })

  // A5: `install:mac:dev` reinstalls without bumping the version, so the old daemon
  // answered with the same version and the new App adopted it.
  it('refuses a daemon of the same version built from other sources, before and after enrolling', async () => {
    // At enrollment: the reply names the daemon's build, and nothing is stored.
    const fresh = await harness({ build: BUILD_OLD })
    await expect(client(fresh, { appBuild: BUILD_NEW }).connect())
      .rejects.toMatchObject({ reason: 'daemon_version_mismatch', running: VERSION, runningBuild: BUILD_OLD })
    expect(existsSync(daemonClientPaths(fresh.daemonStateDirectory, fresh.userDataDir).statePath)).toBe(false)
    // With a stored grant (the A5 path): the build the daemon came from enrolled, and the
    // reinstalled build at the same version meets it on daemonInfo.
    const env = await harness({ build: BUILD_OLD })
    const same = client(env, { appBuild: BUILD_OLD })
    expect(await same.connect()).toEqual({ version: VERSION, build: BUILD_OLD, enrolled: true })
    same.close()
    await expect(client(env, { appBuild: BUILD_NEW }).connect()).rejects.toMatchObject({ reason: 'daemon_version_mismatch', runningBuild: BUILD_OLD })
    expect(await client(env, { appBuild: BUILD_NEW }).daemonInfo()).toEqual({ version: VERSION, build: BUILD_OLD })
    // Control: the refusal kept the grant, and the same build still connects with it.
    expect(await client(env, { appBuild: BUILD_OLD }).connect()).toEqual({ version: VERSION, build: BUILD_OLD, enrolled: false })
  })

  it('refuses a daemon that reports no build id when the App has one', async () => {
    // A daemon from before build ids existed says only its version; that is not proof of
    // the same build, so it is a mismatch rather than an adoption.
    const env = await harness()
    await expect(client(env, { appBuild: BUILD_NEW }).connect()).rejects.toMatchObject({ reason: 'daemon_version_mismatch', running: VERSION })
    const failure = await client(env, { appBuild: BUILD_NEW }).connect().catch((error: unknown) => error) as DaemonClientError
    expect(failure.runningBuild).toBeUndefined()
  })

  it('names the running version only when it is version-shaped', () => {
    expect(new DaemonClientError('daemon_version_mismatch', { running: '0.2.199-beta.1+b7' }).running).toBe('0.2.199-beta.1+b7')
    for (const shown of ['', ' 1.0', '1.0\n请点这里', '<b>1</b>', 'x'.repeat(65)]) {
      expect(new DaemonClientError('daemon_version_mismatch', { running: shown }).running).toBeUndefined()
    }
    expect(new DaemonClientError('daemon_version_mismatch').running).toBeUndefined()
  })

  it('does not re-enroll after the grant is revoked, and clears the stored file', async () => {
    const env = await harness()
    const paths = daemonClientPaths(env.daemonStateDirectory, env.userDataDir)
    const first = client(env)
    await first.connect()
    first.close()
    const grant = env.controller.authority.inspectLocal().grants.find((item) => item.scope === 'local')!
    await env.controller.authority.revoke(grant.deviceId)
    // A revoked grant is a user decision, not a transient failure: no retry, no new
    // secret consumption, and the stale credential is deleted.
    const after = client(env)
    const failure = await after.connect().catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(DaemonClientError)
    expect(failure).toMatchObject({ reason: 'daemon_device_not_authorized' })
    // The stale credential is deleted, so a later attempt says "no grant" instead of
    // presenting a certificate the daemon already refused.
    expect(existsSync(paths.statePath)).toBe(false)
    const later = client(env)
    await expect(later.connect()).rejects.toMatchObject({ reason: 'daemon_enrollment_unavailable' })
  })

  it('knows whether it holds a grant before it has connected', async () => {
    const env = await harness()
    const fresh = client(env)
    expect(fresh.hasGrant).toBe(false)
    await fresh.connect()
    expect(fresh.hasGrant).toBe(true)
    fresh.close()
    // A restarted process reads the same file, so the probe can tell "re-adopt" from
    // "first launch, so enroll".
    expect(client(env).hasGrant).toBe(true)
  })

  it('probes a stopped daemon without discarding the grant it must reconnect with', async () => {
    const env = await harness()
    const paths = daemonClientPaths(env.daemonStateDirectory, env.userDataDir)
    const first = client(env)
    await first.connect()
    first.close()
    // `daemonInfo` is the supervisor's question ("is one there?"). Asking it while the
    // daemon is down must not spend the grant: the daemon is restarted and re-adopted
    // with the same credential, not re-enrolled (its secret is already spent).
    const probing = client(env)
    expect(await probing.daemonInfo()).toEqual({ version: VERSION })
    probing.close()
    // Now the daemon is gone: same question, same answer shape, and the credential
    // survives so the restarted daemon is re-adopted instead of refused.
    const stopped = client(env, { connectLocal: async () => { throw new Error('daemon is not listening') } })
    expect(await stopped.daemonInfo()).toBeUndefined()
    stopped.close()
    expect(existsSync(paths.statePath)).toBe(true)
    const restarted = client(env)
    expect(await restarted.connect()).toEqual({ version: VERSION, enrolled: false })
    restarted.close()
  })

  it('reports a daemon that is not running instead of inventing a grant', async () => {
    const env = await harness()
    const offline = client(env, { paths: daemonClientPaths(join(env.root, 'absent'), env.userDataDir) })
    await expect(offline.connect()).rejects.toMatchObject({ reason: 'daemon_enrollment_unavailable' })
  })

  it('fails closed on a corrupted stored grant rather than overwriting it', async () => {
    const env = await harness()
    const paths = daemonClientPaths(env.daemonStateDirectory, env.userDataDir)
    const first = client(env)
    await first.connect()
    first.close()
    writeFileSync(paths.statePath, encrypt('{"version":1}'), { mode: 0o600 })
    const broken = client(env)
    await expect(broken.connect()).rejects.toMatchObject({ reason: 'daemon_local_grant_corrupt' })
    // Still the caller's evidence to inspect: the file was not replaced.
    expect(decrypt(readFileSync(paths.statePath))).toBe('{"version":1}')
  })

  it('declares the protocol it speaks on every frame', async () => {
    const env = await harness()
    const connected = client(env)
    await connected.connect()
    // A run-channel op: the host refuses a frame that does not declare its protocol,
    // so this is the same answer a real daemon gives the App's run surface.
    await expect(connected.request('control', { op: 'liveRuns', waitMs: 0 }, { replayable: true }))
      .resolves.toMatchObject({ liveRuns: { runs: [] } })
    connected.close()
  })

  it('sends a request on a lane over the local socket after connecting', async () => {
    const env = await harness()
    const connected = client(env)
    await connected.connect()
    const reply = await connected.request('control', { op: 'daemonInfo' }, { replayable: true })
    expect(reply).toMatchObject({ op: 'daemonInfo', version: VERSION })
    connected.close()
    // Closing the client leaves the daemon and its grant intact.
    expect(env.store.present()).toBe(false)
    const again = client(env)
    expect(await again.connect()).toEqual({ version: VERSION, enrolled: false })
    again.close()
  })
})
