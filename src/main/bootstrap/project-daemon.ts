import { isAbsolute } from 'node:path'
import { installDaemonChannelGuard, installDaemonChannelResultHandler } from '../daemon-channel-gate'
import type { PiProfileAddition } from './project-channels'

// Daemon mode: the daemon validates and remembers the chosen folder and stores Pi
// profiles (project-channels.ts); the parts only a window can do stay here. The pickers
// run in this App before the daemon is asked, and what the daemon gets is the picker's
// answer: the renderer's own arguments are dropped, so a compromised renderer cannot
// have a path of its choosing remembered as a project (the daemon's workspace
// authorization input) or run as a Pi launcher.

export interface ProjectDaemonWindow {
  /** The native folder picker; null when cancelled. */
  pickFolder(): Promise<string | null>
  /** The native file picker for a Pi launcher; null when cancelled. */
  pickPiLauncher(): Promise<string | null>
  /** The window's error dialog for a launcher that failed the Pi handshake. */
  notifyPiFailure(message: string): Promise<void>
  /** This window's workspace selection (agent:setCwd, kept in main). */
  windowCwd(): string | undefined
  /** Select the folder the daemon validated and remembered, as agent:setCwd does. */
  applyChosenFolder(dir: string): void
}

function invalidDaemonResponse(): never {
  throw new Error('invalid_daemon_response')
}

export function installProjectDaemonWindow(window: ProjectDaemonWindow): () => void {
  const undo = [
    installDaemonChannelGuard('agent:chooseFolder', async () => {
      const picked = await window.pickFolder()
      return picked === null ? { result: null } : { args: [picked] }
    }),
    // The window selects only after the daemon remembered the folder; a refusal leaves
    // the selection as it was. The daemon's canonical path is selected, not the picker's.
    installDaemonChannelResultHandler('agent:chooseFolder', (value) => {
      if (value === null) return null
      if (typeof value !== 'string' || !isAbsolute(value)) invalidDaemonResponse()
      window.applyChosenFolder(value)
      return value
    }),
    // The probe runs in the window's workspace, as main's did; the daemon checks that it
    // is a project it knows. null (no selection) means the home directory.
    installDaemonChannelGuard('agent:addPiProfile', async () => {
      const picked = await window.pickPiLauncher()
      return picked === null ? { result: null } : { args: [picked, window.windowCwd() ?? null] }
    }),
    installDaemonChannelResultHandler('agent:addPiProfile', async (value) => {
      const addition = value as PiProfileAddition | undefined
      if (addition?.status === 'added' && addition.agent && typeof addition.agent === 'object') return addition.agent
      if (addition?.status === 'failed' && typeof addition.message === 'string') {
        await window.notifyPiFailure(addition.message)
        return null
      }
      return invalidDaemonResponse()
    })
  ]
  return () => { for (const step of undo) step() }
}

/**
 * main filled a context without a cwd from the window's selection. The daemon never
 * learns that selection, so the App fills it before the call, exactly as main did.
 */
export function installProviderContextWindowCwd(windowCwd: () => string | undefined): () => void {
  return installDaemonChannelGuard('agent:invalidateProviderContext', async (args) => {
    const [context, ...rest] = args
    if (!context || typeof context !== 'object' || Array.isArray(context)) return { args }
    const value = context as { cwd?: unknown }
    return { args: [{ ...value, cwd: value.cwd ?? windowCwd() }, ...rest] }
  })
}
