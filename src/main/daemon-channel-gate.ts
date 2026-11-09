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
 * scripts/daemon-ipc-routing.json).
 *
 * `agent:setCwd` is the one non-`main` entry. It only sets this window's selection, which
 * the App sends with each daemon submit (daemon-run-surface fills `cwd` from it); it
 * persists nothing. `agent:unreadSessions` is deliberately absent: its source moved with
 * the runs, and an in-process answer would be an empty list that reads as "nothing
 * unread" instead of "not available".
 */
export const DAEMON_MODE_IN_PROCESS_CHANNELS: ReadonlySet<string> = new Set([
  'agent:clipboardImage', 'agent:focusRun', 'agent:revealProject', 'agent:setCwd',
  'agent:traceAck', 'agent:traceResynchronized',
  'app:copyText', 'app:performanceDiagnosticsEnabled', 'app:rendererRestart',
  'app:reportRendererPerformance', 'app:setTheme',
  'remote:desktop:disable', 'remote:desktop:invite', 'remote:desktop:status',
  'runTraces:ack', 'runTraces:confirm', 'runTraces:resync', 'runTraces:setLegacyDemand',
  'runTraces:subscribe', 'runTraces:unsubscribe',
  'workspace:openKnownExternal', 'workspace:readKnown', 'workspace:readPageKnown', 'workspace:resolveFile'
])

/** Channels whose handler already asks the daemon when the switch is on (B4-L3). */
export const DAEMON_MODE_SERVED_CHANNELS: ReadonlySet<string> = new Set([
  'agent:start', 'agent:activeRun', 'agent:activeRuns', 'agent:focusedRunSnapshot',
  'agent:adoptActiveRun', 'agent:answerQuestion', 'agent:stop', 'agent:steer', 'agent:stopBackgroundTask'
])

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
  return ((() => { throw new Error(`daemon_capability_unavailable:${channel}`) }) as unknown) as TListener
}
