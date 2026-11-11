// One Qoder daemon per Scry operation.
//
// From SDK 1.0.58 every `query()` runs inside a qodercli daemon, and CLI 1.1.81+ refuses
// the older per-query process (`sdk_worker_removed`). The SDK's default is one shared
// daemon for the whole host process, whose env, auth and executable are fixed at start.
// Scry needs per-run env (managed recorder identity), a per-run process it can name for
// the hook log and an identity-checked kill that cannot reach another run. So each Scry
// operation starts its own daemon, binds its queries to it with `options.daemon`, and
// stops it when the operation ends. Nothing here may start the SDK's shared daemon.

import { execFile } from 'node:child_process'
import { query, qodercliAuth, startDaemon, type Daemon, type Query } from '@qoder-ai/qoder-agent-sdk'
import { runtimeCliEnv } from '../claude-locate'
import { parseProcessSnapshot, type ProcessIdentity, type ProcessRow } from '../process-diagnostics'
import type { ProviderRunRequest } from './types'
import { qoderExecutable } from './qoder-launch'

const STDERR_TAIL_CHARS = 4_000
const LIST_TIMEOUT_MS = 2_000

export interface QoderDaemonLease {
  daemon: Daemon
  /** The daemon process this lease started; undefined when it could not be told apart. */
  pid?: number
  /** Identity captured right after start; signals are refused without it. */
  identity?: ProcessIdentity
  /** Recent daemon stderr, for a readable error when a query fails early. */
  stderrTail(): string
  /** Fires once when the daemon connection or process fails. */
  onFailure(listener: (error: Error) => void): () => void
  /** Idempotent. Resolves once the daemon process has been stopped. */
  stop(): Promise<void>
}

export interface QoderDaemonStartOptions {
  managedRecorder?: boolean
  managedIdentity?: ProviderRunRequest['managedRecorderIdentity']
}

/** Daemon-level env: identical to what the per-query process used to receive. */
export function qoderDaemonEnv(options: QoderDaemonStartOptions): Record<string, string | undefined> {
  const managed = options.managedRecorder === true
  const env = runtimeCliEnv(undefined, managed ? { managedRecorder: true, providerId: 'qoder' } : { providerId: 'qoder' })
  delete env.SCRY_MANAGED_RUN_ID
  delete env.SCRY_MANAGED_PROMPT_HASH
  return {
    ...env,
    ...(managed && options.managedIdentity ? {
      SCRY_MANAGED_RUN_ID: options.managedIdentity.runId,
      SCRY_MANAGED_PROMPT_HASH: options.managedIdentity.promptHash
    } : {}),
    // Waiting is visible in Scry, with explicit user-controlled cancellation.
    // Silence must not trigger the CLI's destructive background wait ceiling.
    QODERCLI_PRINT_BG_WAIT_CEILING_MS: '0'
  }
}

type ChildLister = () => Promise<ProcessRow[]>

const listChildren: ChildLister = () => new Promise((resolve, reject) => {
  execFile(
    '/bin/ps',
    ['-axo', 'pid=,ppid=,stat=,lstart=,command='],
    { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: LIST_TIMEOUT_MS, env: { ...process.env, LC_ALL: 'C' } },
    (error, stdout) => {
      if (error) reject(error)
      else resolve([...parseProcessSnapshot(stdout).values()].filter((row) => row.ppid === process.pid))
    }
  )
})

/**
 * The daemon is the only child started with this executable and `--sdk` while the start
 * lock is held, so a new matching child is unambiguous. Anything else (zero, several, ps
 * unavailable) leaves the pid unknown: the hook log is then reported unavailable and
 * force-kill is refused rather than guessed.
 */
export function pickDaemonChild(before: ReadonlySet<number>, after: readonly ProcessRow[], executable: string): ProcessRow | undefined {
  const fresh = after.filter((row) => !before.has(row.pid) && row.command.includes(executable) && /(^|\s)--sdk(\s|$)/.test(row.command))
  return fresh.length === 1 ? fresh[0] : undefined
}

let startLock: Promise<unknown> = Promise.resolve()

export interface QoderDaemonStarter {
  start: typeof startDaemon
  children: ChildLister
}

const defaultStarter: QoderDaemonStarter = { start: startDaemon, children: listChildren }

export async function startQoderDaemon(
  options: QoderDaemonStartOptions = {},
  starter: QoderDaemonStarter = defaultStarter
): Promise<QoderDaemonLease> {
  const executable = qoderExecutable()
  if (!executable) throw new Error('Qoder CLI 未找到')
  let stderr = ''
  const run = startLock.then(async () => {
    const before = new Set((await starter.children().catch(() => [])).map((row) => row.pid))
    const daemon = await starter.start({
      auth: qodercliAuth(),
      pathToQoderCLIExecutable: executable,
      launchMode: 'process',
      env: qoderDaemonEnv(options),
      stderr: (data) => { stderr = (stderr + data).slice(-STDERR_TAIL_CHARS) }
    })
    const child = pickDaemonChild(before, await starter.children().catch(() => []), executable)
    return { daemon, child }
  })
  // A failed start must not wedge later starts.
  startLock = run.catch(() => undefined)
  let started: Awaited<typeof run>
  try {
    started = await run
  } catch (error) {
    const tail = stderr.trim()
    throw new Error(`Qoder 守护进程启动失败：${(error as Error).message}${tail ? `\n${tail}` : ''}`)
  }
  const { daemon, child } = started
  let stopping: Promise<void> | undefined
  return {
    daemon,
    ...(child ? { pid: child.pid, identity: { pid: child.pid, startedAt: child.startedAt, command: child.command } } : {}),
    stderrTail: () => stderr.trim(),
    onFailure: (listener) => daemon.onFailure(listener),
    stop: () => stopping ??= daemon.stop().catch(() => {})
  }
}

/** Every Scry query goes through here, so none can fall back to the shared daemon. */
export function qoderQuery(
  lease: QoderDaemonLease,
  params: { prompt: Parameters<typeof query>[0]['prompt']; options: Record<string, unknown> }
): Query {
  return query({ prompt: params.prompt, options: { ...params.options, daemon: lease.daemon } as never })
}
