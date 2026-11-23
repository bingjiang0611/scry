import { installDaemonChannelResultHandler } from '../daemon-channel-gate'
import type { SessionSelection } from './session-selection'

/**
 * The daemon loads the history page and reports which session the window now shows; this
 * window applies that selection here, exactly as the loader used to in process, and the
 * renderer gets the page.
 */
export function installDaemonSessionSelection(applySelection: (selection: SessionSelection) => void): () => void {
  return installDaemonChannelResultHandler('agent:loadSession', (value) => {
    if (value === null) return null
    const loaded = value as { page?: unknown; selection?: SessionSelection } | undefined
    if (!loaded || typeof loaded !== 'object' || loaded.page === undefined || !loaded.selection) throw new Error('invalid_daemon_response')
    applySelection(loaded.selection)
    return loaded.page
  })
}
