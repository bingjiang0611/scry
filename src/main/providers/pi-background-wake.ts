/**
 * C3: when the model has answered and only detached work is still running, the answer's run ends —
 * but the session does not go quiet. The Provider keeps reporting that work on the process Scry keeps,
 * and the host wakes the session with an `origin: 'agent'` run when the work reports completion.
 *
 * This watches that kept process. It is deliberately not a second run: the wake is submitted through
 * D1's queue, so it waits behind whatever the user sent in the meantime and shows up as an agent turn.
 */
export interface PiBackgroundWake {
  taskIds: string[]
  /** `continuation`: the extension started the parent again. `terminal`: every task reached a state. */
  reason: 'continuation' | 'terminal' | 'cleared'
}

export interface PiBackgroundObserver {
  /** Stop watching; the caller also stops when the process closes. */
  stop(): void
}

interface WireEvent { [key: string]: unknown }

const SNAPSHOT_PREFIX = 'PI_SUBAGENT_ASYNC_JSON:'
const TERMINAL = new Set(['complete', 'failed', 'paused', 'stopped', 'rejected'])
/** Longer than the session pool's retention: a child cannot outlive the process it reports on. */
const DEFAULT_MAX_MS = 4 * 60 * 60_000

function record(value: unknown): WireEvent {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as WireEvent : {}
}

/**
 * One wake per ended turn. A child that reports twice (a terminal row, then the parent resuming)
 * wakes once, because the second report is the same completion.
 */
export function observePiBackground(
  rpc: { onEvent(listener: (event: WireEvent) => void): () => void },
  input: { taskIds: string[]; onWake: (wake: PiBackgroundWake) => void; maxMs?: number }
): PiBackgroundObserver {
  let stopped = false
  let off = (): void => {}
  const finish = (): void => {
    if (stopped) return
    stopped = true
    off()
    clearTimeout(timer)
  }
  const timer = setTimeout(() => { if (!stopped) { stopped = true; off() } }, input.maxMs ?? DEFAULT_MAX_MS)
  timer.unref?.()
  const wake = (reason: PiBackgroundWake['reason']): void => {
    if (stopped) return
    finish()
    input.onWake({ taskIds: input.taskIds, reason })
  }
  off = rpc.onEvent((event) => {
    if (stopped) return
    if (event.type === 'agent_start') {
      // The extension resumed the parent: the child's result is in that turn, not in this process's
      // idle state. The host wakes the session now rather than waiting for a row that may not repeat.
      wake('continuation')
      return
    }
    if (event.type !== 'extension_ui_request' || event.method !== 'setWidget' || event.widgetKey !== 'subagent-async') return
    const lines = event.widgetLines
    if (!Array.isArray(lines)) {
      // The extension clears the widget once no async job is left; it never replays a terminal row.
      wake('cleared')
      return
    }
    if (lines.length !== 1 || typeof lines[0] !== 'string' || !lines[0].startsWith(SNAPSHOT_PREFIX)) return
    let snapshot: WireEvent
    try { snapshot = record(JSON.parse(lines[0].slice(SNAPSHOT_PREFIX.length))) } catch { return }
    if (snapshot.kind !== 'pi-subagents.async-status-snapshot' || !Array.isArray(snapshot.runs)) return
    const runs = snapshot.runs.map(record)
    // An empty or truncated snapshot is an evidence gap, not completion.
    if (runs.length === 0 || runs.some(run => typeof run.id !== 'string' || !run.id)) return
    if (runs.some(run => !TERMINAL.has(String(run.state)))) return
    wake('terminal')
  })
  return { stop: finish }
}

/**
 * The run's side of the watch: attach once (in the settle tick, so a fast child is not missed), keep
 * the process, and drop the pool entry if the process dies while it is being watched. Lives here so the
 * run module stays a lifecycle story rather than a second watcher implementation.
 */
export function watchPiBackground(input: {
  taskIds: () => string[]
  onWake: (wake: PiBackgroundWake & { sessionId: string; cwd: string | undefined }) => void
  onProcessDied: (sessionId: string) => void
}): {
  attach: (rpc: { onEvent(listener: (event: WireEvent) => void): () => void; reusable(): boolean; onFailure(listener: (error: Error) => void): () => void }, sessionId: string | undefined, cwd: string | undefined) => void
  stop: () => void
} {
  let observer: PiBackgroundObserver | undefined
  let offFailure: (() => void) | undefined
  const stop = (): void => {
    observer?.stop()
    observer = undefined
    offFailure?.()
    offFailure = undefined
  }
  return {
    attach(rpc, sessionId, cwd) {
      if (observer || !rpc.reusable() || !sessionId) return
      observer = observePiBackground(rpc, {
        taskIds: input.taskIds(),
        onWake: (wake) => input.onWake({ ...wake, sessionId, cwd })
      })
      offFailure = rpc.onFailure(() => {
        stop()
        input.onProcessDied(sessionId)
      })
    },
    stop
  }
}
