import { DESKTOP_REMOTE_CLIENT_METHODS } from './remote/desktop-client-ipc'
import type { DaemonForwardTable, DaemonLocalOpTable } from './daemon-local-ops/types'
import { CATALOG_LOCAL_OPS } from './daemon-local-ops/catalog'
import { CONVERSATION_LOCAL_OPS } from './daemon-local-ops/conversation'
import { SESSION_LIFECYCLE_FORWARDS, SESSION_LIFECYCLE_LOCAL_OPS } from './daemon-local-ops/session-lifecycle'
import { QUERY_FORWARDS, QUERY_LOCAL_OPS } from './daemon-local-ops/queries'
import { WORKBENCH_FORWARDS, WORKBENCH_LOCAL_OPS } from './daemon-local-ops/workbench'
import { PROJECT_LOCAL_OPS } from './daemon-local-ops/project'
import { TERMINAL_LOCAL_OPS } from './daemon-local-ops/terminal'
import { MCP_LOCAL_OPS } from './daemon-local-ops/mcp'
import { BILLING_LOCAL_OPS } from './daemon-local-ops/billing'
import { PAIRING_LOCAL_OPS } from './daemon-local-ops/pairing'
import { BACKGROUND_SERVICE_LOCAL_OPS } from './daemon-local-ops/background-service'

// Development switch for "the daemon owns runs". Kept here, free of Electron, so the IPC
// registrar can consult it without importing the daemon client assembly.
export const DAEMON_MODE_ENV = 'SCRY_HOST_DAEMON'

export function daemonModeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[DAEMON_MODE_ENV] === '1'
}

/**
 * Channels whose in-process handler stays correct while the daemon owns runs: window,
 * menu, clipboard and theme work, the renderer delivery bridge, main's single-file read
 * references, and the client this App uses to reach other hosts (route `main` in
 * scripts/daemon-ipc-routing*.json). The hosts that client saves are the App's own state,
 * not the daemon's.
 *
 * `agent:setCwd` is the one non-`main` entry. It only sets this window's selection, which
 * the App sends with each daemon submit (daemon-run-surface fills `cwd` from it); it
 * persists nothing. Its handler, like the known-project file channels below, asks the
 * daemon whether the directory is a known project (its local op, through
 * callDaemonChannel); none of them reads the App's copy of those stores.
 * `agent:unreadSessions` answers from this window's mirror of the daemon's unread set
 * (P3f E1b), and refuses by name until the first snapshot arrives.
 *
 * `workspace:openExternal` and `workspace:trash` stay here because the daemon has no
 * shell. They keep main's binding to this window's selection; the cross-project fallback
 * of openExternal takes its known projects from the daemon (bootstrap/workspace.ts).
 */
export const DAEMON_MODE_IN_PROCESS_CHANNELS: ReadonlySet<string> = new Set([
  'agent:clipboardImage', 'agent:focusRun', 'agent:revealProject', 'agent:setCwd',
  'agent:traceAck', 'agent:traceResynchronized', 'agent:unreadSessions', 'agent:viewSessions',
  'app:copyText', 'app:performanceDiagnosticsEnabled', 'app:rendererRestart',
  'app:reportRendererPerformance', 'app:setTheme',
  // «后台服务» actions: dialogs, signals to the verified daemon.lock holder, app.quit (B4-S).
  'remote:backgroundService:quit', 'remote:backgroundService:reconnect', 'remote:backgroundService:restart',
  'runTraces:ack', 'runTraces:confirm', 'runTraces:resync', 'runTraces:setLegacyDemand',
  'runTraces:subscribe', 'runTraces:unsubscribe',
  'workspace:openExternal', 'workspace:openKnownExternal', 'workspace:readKnown', 'workspace:readPageKnown',
  'workspace:resolveFile', 'workspace:trash',
  ...DESKTOP_REMOTE_CLIENT_METHODS.map((method) => `desktopRemote:${method}`)
])

/** Channels whose handler already asks the daemon when the switch is on (B4-L3). */
export const DAEMON_MODE_SERVED_CHANNELS: ReadonlySet<string> = new Set([
  'agent:start', 'agent:activeRun', 'agent:activeRuns', 'agent:focusedRunSnapshot',
  'agent:adoptActiveRun', 'agent:answerQuestion', 'agent:stop', 'agent:steer', 'agent:stopBackgroundTask'
])

/**
 * Channels the daemon answers through a local-only op (B4-L4), one table per group
 * (daemon-local-ops/). The daemon builds the same handler table main registers, so both
 * run one implementation.
 */
export const DAEMON_LOCAL_OP_CHANNELS: DaemonLocalOpTable = {
  ...CATALOG_LOCAL_OPS,
  ...CONVERSATION_LOCAL_OPS,
  ...SESSION_LIFECYCLE_LOCAL_OPS,
  ...QUERY_LOCAL_OPS,
  ...WORKBENCH_LOCAL_OPS,
  ...PROJECT_LOCAL_OPS,
  ...TERMINAL_LOCAL_OPS,
  ...MCP_LOCAL_OPS,
  ...BILLING_LOCAL_OPS,
  ...PAIRING_LOCAL_OPS,
  ...BACKGROUND_SERVICE_LOCAL_OPS
}

/** Channels the daemon answers through an op it already serves paired devices (route `forward`). */
export const DAEMON_FORWARD_CHANNELS: DaemonForwardTable = {
  ...SESSION_LIFECYCLE_FORWARDS,
  ...QUERY_FORWARDS,
  ...WORKBENCH_FORWARDS
}

/** Op names served only on the App's local endpoint; the network endpoint refuses them. */
export const DAEMON_LOCAL_OP_NAMES: ReadonlySet<string> = new Set(Object.values(DAEMON_LOCAL_OP_CHANNELS).map((entry) => entry.op))

export type DaemonChannelForwarder = (call: { op: string; method: string; args: unknown[]; read: boolean }) => Promise<unknown>

/** Sends one existing-op request to the daemon; answers its reply once errors are mapped. */
export type DaemonRequestForwarder = (request: Record<string, unknown>, read: boolean) => Promise<Record<string, unknown>>

let forwarder: DaemonChannelForwarder | undefined
let requestForwarder: DaemonRequestForwarder | undefined

export function installDaemonRequestForwarder(next: DaemonRequestForwarder): () => void {
  requestForwarder = next
  return () => { if (requestForwarder === next) requestForwarder = undefined }
}
const resultHandlers = new Map<string, (value: unknown, args: unknown[]) => unknown>()

/**
 * A split channel: the daemon answers, then the App applies its own part of the result
 * (for agent:loadSession, the window's session selection) and hands the renderer the rest.
 */
export function installDaemonChannelResultHandler(channel: string, handle: (value: unknown, args: unknown[]) => unknown): () => void {
  resultHandlers.set(channel, handle)
  return () => { if (resultHandlers.get(channel) === handle) resultHandlers.delete(channel) }
}

/**
 * What the App does before the daemon is asked: go ahead (maybe with other arguments), or
 * answer itself. `settled` runs once the call ends, whether it answered or failed.
 */
export type DaemonChannelGuardOutcome = { args: unknown[]; settled?: () => void } | { result: unknown }

const guards = new Map<string, (args: unknown[]) => Promise<DaemonChannelGuardOutcome>>()

/**
 * A channel whose App part comes first: a confirmation dialog the daemon cannot show
 * (decided: dialogs stay in main). Answering `result` means the daemon is never asked.
 */
export function installDaemonChannelGuard(channel: string, guard: (args: unknown[]) => Promise<DaemonChannelGuardOutcome>): () => void {
  guards.set(channel, guard)
  return () => { if (guards.get(channel) === guard) guards.delete(channel) }
}

async function guarded(channel: string, args: unknown[], ask: (args: unknown[]) => Promise<unknown>): Promise<unknown> {
  const guard = guards.get(channel)
  const outcome = guard ? await guard(args) : { args }
  if ('result' in outcome) return outcome.result
  try {
    const value = await ask(outcome.args)
    const after = resultHandlers.get(channel)
    return after ? await after(value, outcome.args) : value
  } finally {
    outcome.settled?.()
  }
}

/** One request for an op the daemon serves its App outside any channel (e.g. terminalFeed). */
export async function requestDaemon(request: Record<string, unknown>, read: boolean): Promise<Record<string, unknown>> {
  if (!requestForwarder) throw new Error(`daemon_capability_unavailable:${String(request.op)}`)
  return await requestForwarder(request, read)
}

/** Ask the daemon for one local-op channel directly, without its guard: for a guard's own reads. */
export async function callDaemonChannel(channel: string, args: unknown[]): Promise<unknown> {
  const local = DAEMON_LOCAL_OP_CHANNELS[channel]
  if (!local || !forwarder) throw new Error(`daemon_capability_unavailable:${channel}`)
  return await forwarder({ op: local.op, method: local.method, args, read: local.read })
}

export type DaemonRunFollower = (ledger: { runId: string; seq?: number }) => Promise<{ runId: string; bound: boolean }>

let follower: DaemonRunFollower | undefined

/**
 * Follow a run the daemon recorded for this window (a conversation send) like one it
 * submitted. Registered with the client, resolved per call like the forwarder.
 */
export function installDaemonRunFollower(next: DaemonRunFollower): () => void {
  follower = next
  return () => { if (follower === next) follower = undefined }
}

export function followDaemonRun(ledger: { runId: string; seq?: number }): Promise<{ runId: string; bound: boolean }> {
  if (!follower) return Promise.reject(new Error('daemon_capability_unavailable:follow'))
  return follower(ledger)
}

/**
 * The daemon client registers itself here once daemon mode builds it. Channels resolve
 * the forwarder per call, so registration order against IPC setup does not matter.
 */
export function installDaemonChannelForwarder(next: DaemonChannelForwarder): () => void {
  forwarder = next
  return () => { if (forwarder === next) forwarder = undefined }
}

/**
 * With the switch on, every privileged channel is either listed above or refused with a
 * named absence. An unmigrated in-process handler would read or write the userData the
 * daemon owns as a second owner, or answer from state the daemon no longer keeps; an
 * unclassified new channel is refused too, so the default is closed rather than local.
 */
export function gateDaemonChannel<TListener extends (...args: never[]) => unknown>(
  channel: string,
  listener: TListener,
  env: NodeJS.ProcessEnv = process.env
): TListener {
  if (!daemonModeEnabled(env)) return listener
  if (DAEMON_MODE_IN_PROCESS_CHANNELS.has(channel) || DAEMON_MODE_SERVED_CHANNELS.has(channel)) return listener
  const local = DAEMON_LOCAL_OP_CHANNELS[channel]
  if (local) {
    // The renderer's arguments travel as they are; the daemon runs the same handler
    // main would have run, so its own validation applies unchanged.
    return ((async (_event: unknown, ...args: unknown[]) => {
      if (!forwarder) throw new Error(`daemon_capability_unavailable:${channel}`)
      return await guarded(channel, args, (sent) => forwarder!({ op: local.op, method: local.method, args: sent, read: local.read }))
    }) as unknown) as TListener
  }
  const forward = DAEMON_FORWARD_CHANNELS[channel]
  if (forward) {
    return ((async (_event: unknown, ...args: unknown[]) => {
      if (!requestForwarder) throw new Error(`daemon_capability_unavailable:${channel}`)
      return await guarded(channel, args, async (sent) => {
        const reply = await requestForwarder!(forward.request(sent), forward.read)
        return forward.result ? forward.result(reply, sent) : reply
      })
    }) as unknown) as TListener
  }
  return ((() => { throw new Error(`daemon_capability_unavailable:${channel}`) }) as unknown) as TListener
}
