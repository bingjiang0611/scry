import { installDaemonChannelGuard, installDaemonChannelResultHandler } from '../daemon-channel-gate'

const CHANNEL = 'agent:recorderContentPage'

/**
 * Daemon mode: recorder and App trace content are read in the daemon (its userData, its
 * project authority), but the workspace they are read for is this window's selection,
 * which only main holds. The App appends that selection after the renderer's request and
 * drops anything else the renderer sent; the daemon re-validates it and refuses a
 * directory it does not know. The renderer contract is unchanged.
 */
export function installRecorderContentWindowCwd(windowCwd: () => string | undefined): () => void {
  const undo = [
    installDaemonChannelGuard(CHANNEL, async ([request]) => {
      const cwd = windowCwd() ?? ''
      // In process a recorder read without a workspace is refused before anything is
      // read; an app-trace read (it names a source) reads the no-workspace bucket.
      if (!cwd && !(request && typeof request === 'object' && 'source' in request)) throw new Error('recorder_workspace_unavailable')
      return { args: [request, cwd] }
    }),
    // In process the handler checks the selection again after reading; here the read
    // happened in the daemon, so this window checks it once the reply is back.
    installDaemonChannelResultHandler(CHANNEL, (value, args) => {
      if ((windowCwd() ?? '') !== args[1]) throw new Error('recorder_workspace_changed')
      return value
    })
  ]
  return () => { for (const step of undo) step() }
}
