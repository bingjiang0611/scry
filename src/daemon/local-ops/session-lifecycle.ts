import type { DaemonLocalOpGroup } from './deps'

// Session delete, rename/archive/pin, fork, archived list and purge; then conversation delete/fork.
export const sessionLifecycleLocalOps: DaemonLocalOpGroup = () => ({})
