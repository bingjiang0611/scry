import type { IpcMainInvokeEvent } from 'electron'
import { readAppTraceContentPage } from './trace-tool-content'
import { readAuthorizedRecorderContentPage } from './recorder-content-access'
import { resolveRecorderLocation } from '../core/turn-recorder/config'
import { recorderContentCopy as copy } from '../shared/constants/recorder-content-copy'

/** Recorder content reads retain source/reference validation in their owning main-process seams. */
export function registerRecorderContentIpc(deps: {
  handleTrusted: (channel: string, handler: (event: IpcMainInvokeEvent, ...args: never[]) => unknown) => void
  currentCwd: () => string | undefined
  userDataDir: () => string
}) {
  deps.handleTrusted('agent:recorderContentPage', async (_event, request: unknown) => {
    const cwd = deps.currentCwd() ?? ''
    if (request && typeof request === 'object' && 'source' in request) {
      if (request.source !== 'app-trace') throw new Error(copy.invalidSource)
      const page = await readAppTraceContentPage(deps.userDataDir(), cwd, request)
      if ((deps.currentCwd() ?? '') !== cwd) throw new Error(copy.workspaceChanged)
      return page
    }
    if (!cwd) throw new Error(copy.workspaceUnavailable)
    // Reading is authorized by the selected workspace's validated recorder location and record
    // references, not by the current enablement flag. Existing evidence remains inspectable when
    // capture is disabled or a sentinel is present; no path supplied by the renderer is opened.
    const location = await resolveRecorderLocation(cwd)
    if (deps.currentCwd() !== cwd) throw new Error(copy.workspaceChanged)
    if (!location.valid) throw new Error(copy.unavailable(location.reason))
    return readAuthorizedRecorderContentPage(location.dataRoot, request)
  })
}
