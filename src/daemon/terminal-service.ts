import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { createTerminalRuntime, type TerminalOutputSink, type TerminalRuntimeDependencies } from '../main/bootstrap/terminal-runtime'
import { terminalChannelHandlers } from '../main/bootstrap/terminal-channels'
import { TERMINAL_RENDERER_ARITY } from '../main/daemon-local-ops/terminal'
import type { LocalOpHandler } from '../main/remote/host-local-ops'
import type { TerminalOutputBridge } from '../main/terminal-output'
import type { DesktopTerminalEvent, DesktopTerminalEvents } from '../shared/desktop-workbench'


const PAGE_BYTES = 512 * 1024
export const RECLAIM_AFTER_MS = 60_000
export const CHECK_EVERY_MS = 5_000

export interface DaemonTerminalServiceDeps extends Pick<TerminalRuntimeDependencies, 'userDataDir' | 'recordingWorkerUrl' | 'pty' | 'inlineRecording' | 'environment'> {
  homeDir: string
  resolveKnownProjectDirectory(cwd: string): string
  notify(): void
  idleMs(): number
  reclaimAfterMs?: number
  checkEveryMs?: number
  log?(message: string): void
}

export interface DaemonTerminalFeed {
  read(cursor?: string): DesktopTerminalEvents
  detachRenderer(): void
  shutdown(): Promise<void>
}

export function createDaemonTerminalService(deps: DaemonTerminalServiceDeps) {
  const workspace = new AsyncLocalStorage<{ cwd: string | undefined }>()
  const streamId = randomUUID()
  const queue: Array<{ cursor: number; event: DesktopTerminalEvent }> = []
  let sequence = 0
  let disposed = false
  const enqueue = (event: DesktopTerminalEvent): void => {
    queue.push({ cursor: ++sequence, event })
    deps.notify()
  }
  const sink: TerminalOutputSink = {
    canSend: () => !disposed,
    data: (events) => enqueue({ kind: 'data', events }),
    exit: (event) => enqueue({ kind: 'exit', event }),
    recordingError: (event) => enqueue({ kind: 'recordingError', event })
  }
  const build = () => createTerminalRuntime({
    sink,
    userDataDir: deps.userDataDir,
    recordingWorkerUrl: deps.recordingWorkerUrl,
    getCurrentCwd: () => workspace.getStore()?.cwd,
    getHomeDir: () => deps.homeDir,
    ...(deps.pty ? { pty: deps.pty } : {}),
    ...(deps.inlineRecording ? { inlineRecording: true } : {}),
    ...(deps.environment ? { environment: deps.environment } : {})
  })
  let runtime = build()
  const output: Pick<TerminalOutputBridge, 'started' | 'attach' | 'detach' | 'owns' | 'ready' | 'ack' | 'terminalClosed'> = {
    started: (id) => runtime.terminalOutput.started(id),
    attach: (id) => runtime.terminalOutput.attach(id),
    detach: (id) => runtime.terminalOutput.detach(id),
    owns: (id, epoch) => runtime.terminalOutput.owns(id, epoch),
    ready: (id, epoch) => runtime.terminalOutput.ready(id, epoch),
    ack: (id, epoch, bytes) => runtime.terminalOutput.ack(id, epoch, bytes),
    terminalClosed: (id) => runtime.terminalOutput.terminalClosed(id)
  }
  const table = terminalChannelHandlers<undefined>({
    getTerminalManager: () => runtime.getTerminalManager(),
    terminalOutput: output,
    isShuttingDown: () => disposed,
    rendererCanReceive: () => !disposed,
    assertCaller: () => undefined,
    getCurrentCwd: () => workspace.getStore()?.cwd
  })

  const resolveWorkspace = (value: unknown): string | undefined => {
    if (value === null || value === undefined) return undefined
    if (typeof value !== 'string' || value.length === 0) throw new Error('终端工作区无效')
    return deps.resolveKnownProjectDirectory(value)
  }
  const localOps: Record<string, LocalOpHandler> = Object.fromEntries(Object.entries(table).map(([channel, handler]) => {
    const arity = TERMINAL_RENDERER_ARITY[channel]!
    const call = (...args: unknown[]) => {
      const cwd = resolveWorkspace(args[arity])
      return workspace.run({ cwd }, () => (handler as (event: undefined, ...values: unknown[]) => unknown)(undefined, ...args.slice(0, arity)))
    }
    return [channel, call]
  }))

  async function reclaim(reason: string): Promise<void> {
    const previous = runtime
    runtime = build()
    previous.terminalOutput.close()
    const manager = previous.getTerminalManagerInstance()
    if (!manager) return
    deps.log?.(`daemon.terminal-reclaimed reason=${reason} sessions=${manager.activeSessions().length}`)
    await manager.shutdown()
  }

  const watch = setInterval(() => {
    if (disposed) return
    const live = runtime.getTerminalManagerInstance()?.activeSessions().length ?? 0
    if (live > 0 && deps.idleMs() > (deps.reclaimAfterMs ?? RECLAIM_AFTER_MS)) {
      void reclaim('app_gone').catch((error) => deps.log?.(`daemon.terminal-reclaim-failed ${(error as Error)?.message ?? String(error)}`))
    }
  }, deps.checkEveryMs ?? CHECK_EVERY_MS)
  watch.unref?.()

  const feed: DaemonTerminalFeed = {
    read(token) {
      const [stream, position] = token?.split(':') ?? []
      const cursor = stream === streamId ? Math.min(Math.max(Number(position) || 0, 0), sequence) : 0
      while (queue.length > 0 && queue[0]!.cursor <= cursor) queue.shift()
      const page: DesktopTerminalEvents = { cursor: `${streamId}:${cursor}`, events: [] }
      let bytes = 0
      for (const row of queue) {
        const size = Buffer.byteLength(JSON.stringify(row.event))
        if (bytes + size > PAGE_BYTES && page.events.length > 0) break
        page.events.push(row.event)
        page.cursor = `${streamId}:${row.cursor}`
        bytes += size
      }
      return page
    },
    detachRenderer: () => runtime.terminalOutput.detachRenderer(),
    shutdown: () => reclaim('app_quit')
  }

  return {
    localOps,
    feed,
    async dispose(): Promise<void> {
      disposed = true
      clearInterval(watch)
      runtime.terminalOutput.close()
      await runtime.getTerminalManagerInstance()?.shutdown()
    }
  }
}
