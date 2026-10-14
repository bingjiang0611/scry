import 'reflect-metadata'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomUUID, webcrypto } from 'node:crypto'
import { chmodSync, mkdtempSync, statSync, watch } from 'node:fs'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect as tlsConnect, type ConnectionOptions, type TLSSocket } from 'node:tls'
import {
  BasicConstraintsExtension,
  ExtendedKeyUsage,
  ExtendedKeyUsageExtension,
  KeyUsagesExtension,
  KeyUsageFlags,
  Pkcs10CertificateRequestGenerator,
  X509CertificateGenerator,
  cryptoProvider
} from '@peculiar/x509'

type PeculiarCrypto = Parameters<typeof cryptoProvider.set>[0]
const NODE_CRYPTO = webcrypto as unknown as PeculiarCrypto
cryptoProvider.set(NODE_CRYPTO)

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const MAX_REQUEST_BYTES = 1_310_720
// Matches the authenticated structured-history/trace source bound.
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024
const MAX_TUNNEL_READY_MS = 10_000
const SSH_PATH = '/usr/bin/ssh'

export interface DesktopDeviceIdentity {
  keyPEM: string
  csrPEM: string
  bootstrapCertPEM: string
  publicKeySHA256: string
}

export interface DesktopSshTunnelOptions {
  username: string
  hostname: string
  port: number
  pairPort: number
  runPort: number
}

export interface DesktopSshTunnel {
  pairPath: string
  runPath: string
  readonly alive: boolean
  close(): Promise<void>
}

export interface DesktopTlsRequestOptions {
  path?: string
  host?: string
  port?: number
  caPEM: string
  certPEM: string
  keyPEM: string
  request: unknown
  signal?: AbortSignal
  timeoutMs?: number
}

function pem(der: ArrayBuffer, label: string): string {
  const body = Buffer.from(der).toString('base64').replace(/(.{64})/g, '$1\n').replace(/\n$/, '')
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`
}

function digest(bytes: ArrayBuffer | Uint8Array): string {
  return createHash('sha256').update(Buffer.from(bytes as Uint8Array)).digest('hex')
}

export async function generateDesktopDeviceIdentity(): Promise<DesktopDeviceIdentity> {
  const keys = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const keyPEM = pem(await webcrypto.subtle.exportKey('pkcs8', keys.privateKey), 'PRIVATE KEY')
  const csr = await Pkcs10CertificateRequestGenerator.create({
    name: 'CN=scry-desktop-bootstrap',
    keys,
    signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' }
  })
  const bootstrap = await X509CertificateGenerator.createSelfSigned({
    serialNumber: randomUUID().replace(/-/g, ''),
    name: 'CN=scry-desktop-bootstrap',
    notBefore: new Date(Date.now() - 60_000),
    notAfter: new Date(Date.now() + 365 * 86_400_000),
    signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' },
    keys,
    extensions: [
      new BasicConstraintsExtension(false, undefined, true),
      new KeyUsagesExtension(KeyUsageFlags.digitalSignature, true),
      new ExtendedKeyUsageExtension([ExtendedKeyUsage.clientAuth])
    ]
  }, NODE_CRYPTO)
  return {
    keyPEM,
    csrPEM: csr.toString('pem'),
    bootstrapCertPEM: bootstrap.toString('pem'),
    publicKeySHA256: digest(await webcrypto.subtle.exportKey('spki', keys.publicKey))
  }
}

function validatePort(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1 || value > 65_535) throw new Error(`invalid_${name}`)
  return value
}

function validateSshPart(value: string, name: string, pattern: RegExp): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 253 || !pattern.test(value)) throw new Error(`invalid_${name}`)
  return value
}

function validateTunnelOptions(options: DesktopSshTunnelOptions): DesktopSshTunnelOptions {
  const username = validateSshPart(options.username, 'username', /^[A-Za-z0-9][A-Za-z0-9._-]*$/)
  const hostname = validateSshPart(options.hostname, 'hostname', /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?))*$/)
  return {
    username,
    hostname,
    port: validatePort(options.port, 'port'),
    pairPort: validatePort(options.pairPort, 'pair_port'),
    runPort: validatePort(options.runPort, 'run_port')
  }
}

function sshArguments(options: DesktopSshTunnelOptions, pairPath: string, runPath: string): string[] {
  return [
    '-F', '/dev/null',
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ForwardAgent=no',
    '-o', 'RequestTTY=no',
    '-o', 'ControlMaster=no',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ConnectTimeout=8',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=2',
    '-o', 'PermitLocalCommand=no',
    '-o', 'RemoteCommand=none',
    '-p', String(options.port),
    '-N', '-T',
    '-L', `${pairPath}:127.0.0.1:${options.pairPort}`,
    '-L', `${runPath}:127.0.0.1:${options.runPort}`,
    '--', `${options.username}@${options.hostname}`
  ]
}

function isSocket(path: string): boolean {
  try { return statSync(path).isSocket() } catch { return false }
}

function childExited(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const done = (): void => {
      child.off('exit', done)
      child.off('close', done)
      child.off('error', done)
      resolve()
    }
    child.once('exit', done)
    child.once('close', done)
    child.once('error', done)
  })
}

async function removePrivateDirectory(directory: string): Promise<void> {
  await fs.rm(directory, { recursive: true, force: true })
}

async function waitForTunnelReady(child: ChildProcess, directory: string, pairPath: string, runPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let spawned = false
    let settled = false
    const timer = setTimeout(() => finish(new Error('ssh_tunnel_ready_timeout')), MAX_TUNNEL_READY_MS)
    const directoryWatcher = watch(directory, { persistent: false }, () => check())
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      directoryWatcher.close()
      child.off('spawn', onSpawn)
      child.off('error', onError)
      child.off('exit', onExit)
      if (error) reject(error)
      else resolve()
    }
    const check = (): void => {
      if (spawned && isSocket(pairPath) && isSocket(runPath)) finish()
    }
    const onSpawn = (): void => { spawned = true; check() }
    const onError = (error: Error): void => finish(error)
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => finish(new Error(`ssh_tunnel_exited:${code ?? signal ?? 'unknown'}`))
    child.once('spawn', onSpawn)
    child.once('error', onError)
    child.once('exit', onExit)
    check()
  })
}

export async function openDesktopSshTunnel(options: DesktopSshTunnelOptions): Promise<DesktopSshTunnel> {
  const validated = validateTunnelOptions(options)
  const directory = mkdtempSync(join(tmpdir(), 'scry-desktop-'))
  chmodSync(directory, 0o700)
  const pairPath = join(directory, 'pair.sock')
  const runPath = join(directory, 'run.sock')
  let child: ChildProcess | undefined
  let closed = false
  try {
    child = spawn(SSH_PATH, sshArguments(validated, pairPath, runPath), { stdio: ['ignore', 'ignore', 'ignore'] })
    // An error listener is required even after readiness: a failed owned child
    // must not become an uncaught EventEmitter error before close() is called.
    child.on('error', () => {})
    await waitForTunnelReady(child, directory, pairPath, runPath)
    const close = async (): Promise<void> => {
      if (closed) return
      closed = true
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
      if (child) await childExited(child)
      await removePrivateDirectory(directory)
    }
    const sshProcess = child
    return { pairPath, runPath, get alive() { return !closed && sshProcess.exitCode === null && sshProcess.signalCode === null }, close }
  } catch (error) {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    if (child) await childExited(child)
    await removePrivateDirectory(directory)
    throw error
  }
}

function abortError(): Error {
  const error = new Error('desktop_tls_request_aborted')
  error.name = 'AbortError'
  return error
}

function requestError(message: string): Error {
  return new Error(`desktop_tls_request_${message}`)
}

export function desktopTlsRequest(options: DesktopTlsRequestOptions): Promise<unknown> {
  const hasPath = options.path !== undefined
  const hasTcp = options.host !== undefined || options.port !== undefined
  if (hasPath === hasTcp || (hasTcp && (options.host === undefined || options.port === undefined))) {
    return Promise.reject(requestError('invalid_endpoint'))
  }
  if (hasPath && (typeof options.path !== 'string' || options.path.length === 0 || options.path.includes('\0'))) {
    return Promise.reject(requestError('invalid_path'))
  }
  if (hasTcp && (typeof options.host !== 'string' || options.host.length === 0 || options.host.includes('\0'))) {
    return Promise.reject(requestError('invalid_host'))
  }
  if (hasTcp) {
    try { validatePort(options.port as number, 'port') }
    catch (error) { return Promise.reject(error) }
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120_000) return Promise.reject(requestError('invalid_timeout'))
  let payload: string
  try {
    const encoded = JSON.stringify(options.request)
    if (typeof encoded !== 'string') throw new Error('not_json')
    payload = `${encoded}\n`
  } catch { return Promise.reject(requestError('invalid_request')) }
  if (Buffer.byteLength(payload) > MAX_REQUEST_BYTES) return Promise.reject(requestError('request_too_large'))
  if (options.signal?.aborted) return Promise.reject(abortError())

  const connectOptions: ConnectionOptions = {
    ...(hasPath ? { path: options.path as string } : { host: options.host as string, port: options.port as number }),
    ca: options.caPEM,
    cert: options.certPEM,
    key: options.keyPEM,
    servername: 'scry-host',
    minVersion: 'TLSv1.3',
    maxVersion: 'TLSv1.3',
    rejectUnauthorized: true
  }
  return new Promise<unknown>((resolve, reject) => {
    let socket: TLSSocket | undefined
    let settled = false
    let timer: NodeJS.Timeout | undefined
    let buffer = Buffer.alloc(0)
    const finish = (error?: Error, value?: unknown): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      socket?.removeAllListeners()
      // A reset can arrive while destroy is closing the underlying stream.
      socket?.on('error', () => {})
      socket?.destroy()
      if (error) reject(error)
      else resolve(value)
    }
    const onAbort = (): void => finish(abortError())
    const onTimeout = (): void => finish(requestError('timeout'))
    options.signal?.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(onTimeout, timeoutMs)
    try {
      socket = tlsConnect(connectOptions)
      if (settled) { socket.destroy(); return }
    } catch (error) {
      finish(error instanceof Error ? error : requestError('connect'))
      return
    }
    socket.once('secureConnect', () => {
      if (settled) return
      socket?.write(payload)
    })
    socket.on('data', (chunk: Buffer) => {
      if (settled) return
      if (buffer.length + chunk.length > MAX_RESPONSE_BYTES) { finish(requestError('response_too_large')); return }
      buffer = Buffer.concat([buffer, chunk])
      const end = buffer.indexOf(10)
      if (end < 0) return
      if (end !== buffer.length - 1) { finish(requestError('pipelined_response')); return }
      let value: unknown
      try { value = JSON.parse(buffer.subarray(0, end).toString('utf8')) }
      catch { finish(requestError('invalid_response')); return }
      finish(undefined, value)
    })
    socket.once('error', (error) => finish(error instanceof Error ? error : requestError('socket')))
    socket.once('end', () => { if (!settled) finish(requestError('eof')) })
  })
}
