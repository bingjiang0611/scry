import 'reflect-metadata'
import { mkdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { webcrypto } from 'node:crypto'
import { cryptoProvider } from '@peculiar/x509'
import { createDaemonHostProcess, type DaemonHostProcessOptions } from './host-process'
import { MemoryOutputStore, call, enrollLocal, tempDir } from './host-process.fixtures'
import { createRecentFoldersStore } from '../main/app-store'

cryptoProvider.set(webcrypto as unknown as Parameters<typeof cryptoProvider.set>[0])

// A real test daemon for one local-op group's tests (B4-L4). Test files import
// 'reflect-metadata' first, as host-process.test.ts does: temporary userData and
// workspace, the smoke Provider, the App's local enrollment. Pair with
// `afterEach(cleanupTempDirs)` from host-process.fixtures and always `dispose()`.

export interface TestDaemon {
  root: string
  userDataDir: string
  /** Canonical, and already in the recent folders, as the picker would store it. */
  workspace: string
  host: Awaited<ReturnType<typeof createDaemonHostProcess>>
  /** One local-op call on the App's socket; `absent` lists argument positions left out. */
  localOp(op: string, method: string, args: unknown[], absent?: number[]): Promise<Record<string, any>>
  /** Any other request on the same socket and grant. */
  request(request: Record<string, unknown>): Promise<Record<string, any>>
  dispose(): Promise<void>
}

const ENV = { SCRY_REMOTE_RELAY_ENABLED: '0', SCRY_ELECTRON_SMOKE_PROVIDER: '1', ELECTRON_ENABLE_LOGGING: '1' }
const DEBUG_PORT = '--remote-debugging-port=0'

/** `root`: start again on the userData a disposed test daemon left, as a restart would. */
export async function startTestDaemon(options: Pick<DaemonHostProcessOptions, 'terminal'> & { root?: string } = {}): Promise<TestDaemon> {
  const { root: previous, ...hostOptions } = options
  const root = previous ?? tempDir()
  const userDataDir = join(root, 'userData')
  mkdirSync(join(userDataDir, 'remote', 'ledger'), { recursive: true, mode: 0o700 })
  mkdirSync(join(root, 'workspace'), { recursive: true, mode: 0o700 })
  const workspace = realpathSync(join(root, 'workspace'))
  createRecentFoldersStore(userDataDir).push(workspace)
  const saved = Object.fromEntries(Object.keys(ENV).map((key) => [key, process.env[key]]))
  Object.assign(process.env, ENV)
  process.argv.push(DEBUG_PORT)
  const restore = (): void => {
    const index = process.argv.indexOf(DEBUG_PORT)
    if (index >= 0) process.argv.splice(index, 1)
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
  let host: TestDaemon['host']
  try {
    host = await createDaemonHostProcess({
      userDataDir,
      daemonStateDirectory: join(userDataDir, 'daemon'),
      appPath: process.cwd(),
      resourcesPath: join(process.cwd(), 'resources'),
      appVersion: 'test',
      isPackaged: false,
      createOutputStore: () => new MemoryOutputStore(),
      log: () => undefined,
      ...hostOptions
    })
  } catch (error) {
    restore()
    throw error
  }
  const device = await enrollLocal(host.service)
  const request = (body: Record<string, unknown>) =>
    call(host.channel.socketPath, host.service.caCertificatePEM, device.certPEM, device.keyPEM, body)
  let disposed = false
  return {
    root, userDataDir, workspace, host, request,
    localOp: (op, method, args, absent) => request({ op, method, args, ...(absent ? { absent } : {}) }),
    async dispose() {
      if (disposed) return
      disposed = true
      try { await host.dispose() } finally { restore() }
    }
  }
}
