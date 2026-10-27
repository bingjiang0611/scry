import type { CSSProperties } from 'react'
import type { DesktopRemoteHistory, RemoteSessionRef } from '@shared/desktop-remote'

export type AppView = 'chat' | 'conversation' | 'analytics' | 'meta-prompts' | 'remote'

export type PreparedRemoteHistory =
  | { status: 'ready'; history: DesktopRemoteHistory }
  | { status: 'error'; error: string }

// A conversation on a saved remote desktop. `generation` remounts the remote
// controller for every opened location, so no run/session state leaks between them.
export interface RemoteTarget {
  connectionId: string
  cwd: string
  session?: RemoteSessionRef
  preparedHistory?: PreparedRemoteHistory
  generation: number
}

export type AppStyle = CSSProperties & {
  '--sidebar-w': string
  '--overview-panel-w': string
}
