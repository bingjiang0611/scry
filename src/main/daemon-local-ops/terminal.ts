import type { DaemonLocalOpTable } from './types'

// Terminal (P3-terminal.md): main's own terminal:* handlers, run by the daemon's App
// terminal service. Not the device op desktopWorkbench: that one keeps one manager per
// certificate and workspace, so it cannot list every live terminal, and its recordings
// follow a certificate the App loses when it enrolls again.
export const TERMINAL_LOCAL_OPS: DaemonLocalOpTable = {
  'terminal:start': { op: 'terminal', method: 'start', read: false },
  'terminal:active': { op: 'terminal', method: 'active', read: true },
  'terminal:attach': { op: 'terminal', method: 'attach', read: false },
  'terminal:write': { op: 'terminal', method: 'write', read: false },
  'terminal:resize': { op: 'terminal', method: 'resize', read: false },
  'terminal:ready': { op: 'terminal', method: 'ready', read: false },
  'terminal:ack': { op: 'terminal', method: 'ack', read: false },
  'terminal:close': { op: 'terminal', method: 'close', read: false },
  'terminal:recordingList': { op: 'terminal', method: 'recordingList', read: true },
  'terminal:recordingRead': { op: 'terminal', method: 'recordingRead', read: true },
  'terminal:recordingDelete': { op: 'terminal', method: 'recordingDelete', read: false }
}

/**
 * How many arguments each channel takes from the renderer. The App appends the window's
 * workspace after them (the daemon has no selection of its own), so the daemon knows
 * where the renderer's arguments end.
 */
export const TERMINAL_RENDERER_ARITY: Readonly<Record<string, number>> = Object.fromEntries(
  Object.keys(TERMINAL_LOCAL_OPS).map((channel) => [channel, channel === 'terminal:active' ? 0 : 1])
)
