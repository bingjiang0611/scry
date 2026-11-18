import { installDaemonChannelGuard, installDaemonChannelResultHandler, requestDaemon } from '../daemon-channel-gate'
import { TERMINAL_RENDERER_ARITY } from '../daemon-local-ops/terminal'

// Daemon mode, App side of the terminal (P3-terminal.md). The daemon runs main's terminal
// handlers without a window of its own, so this window does what those handlers asked of
// it: name its workspace selection, refuse while it cannot receive output, and tell the
// daemon when its renderer went away or the App quits.

export interface TerminalDaemonWindow {
  windowCwd(): string | undefined
  rendererCanReceive(): boolean
  isShuttingDown(): boolean
}

// Where main's handler refused while its window could not receive (terminal-channels.ts).
const NEEDS_WINDOW = new Set(['terminal:start', 'terminal:attach', 'terminal:write', 'terminal:resize', 'terminal:close'])
// Where main re-checked the window after the work: a window gone by then must not own
// the terminal it just started or attached.
const CHECKS_AFTER = new Set(['terminal:start', 'terminal:attach'])
const CLOSED = '终端窗口已关闭'

let installed = false

export function installTerminalDaemonWindow(window: TerminalDaemonWindow): () => void {
  const undo: Array<() => void> = []
  for (const [channel, arity] of Object.entries(TERMINAL_RENDERER_ARITY)) {
    undo.push(installDaemonChannelGuard(channel, async (args) => {
      if (NEEDS_WINDOW.has(channel) && (!window.rendererCanReceive() || (channel === 'terminal:start' && window.isShuttingDown()))) {
        throw new Error(CLOSED)
      }
      // Exactly the renderer's arguments main's handler took, then the workspace.
      const sent = Array.from({ length: arity }, (_, index) => args[index])
      return { args: [...sent, window.windowCwd() ?? null] }
    }))
    if (CHECKS_AFTER.has(channel)) {
      undo.push(installDaemonChannelResultHandler(channel, async (value) => {
        if (window.rendererCanReceive()) return value
        await detachDaemonTerminalRenderer()
        throw new Error(CLOSED)
      }))
    }
  }
  installed = true
  return () => {
    installed = false
    for (const step of undo) step()
  }
}

/** main's terminalOutput.detachRenderer(), for the daemon's bridge. Best effort. */
export async function detachDaemonTerminalRenderer(): Promise<void> {
  if (!installed) return
  try {
    await requestDaemon({ op: 'terminalFeed', method: 'detachRenderer' }, true)
  } catch (error) {
    console.warn('[scry] daemon terminal detach failed:', (error as Error)?.message ?? String(error))
  }
}

/**
 * The App is quitting: its shells end with it, as in process. Bounded, so a daemon that
 * does not answer cannot hold the quit; the daemon reclaims them itself once the App's
 * event feed goes unread.
 */
export async function shutdownDaemonTerminals(timeoutMs = 3_000): Promise<void> {
  if (!installed) return
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      requestDaemon({ op: 'terminalFeed', method: 'shutdown' }, true),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs) })
    ])
  } catch (error) {
    console.warn('[scry] daemon terminal shutdown failed:', (error as Error)?.message ?? String(error))
  } finally {
    if (timer) clearTimeout(timer)
  }
}
