import type { CSSProperties } from 'react'
import type { RemoteSessionRef } from '@shared/desktop-remote'

export type AppView = 'chat' | 'conversation' | 'analytics' | 'meta-prompts' | 'remote'

// A conversation on a saved remote desktop. `generation` remounts the remote
// controller for every opened location, so no run/session state leaks between them.
export interface RemoteTarget {
  connectionId: string
  cwd: string
  session?: RemoteSessionRef
  generation: number
}

export type AppStyle = CSSProperties & {
  '--sidebar-w': string
  '--overview-panel-w': string
}
