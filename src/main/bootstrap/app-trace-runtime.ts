import type { BrowserWindow } from 'electron'
import { createTraceRuntime, type RunRendererSink } from './trace-runtime'

// Main's side of the seam: the run pipeline takes a renderer sink, and only this
// module knows that in Electron the sink is a window's webContents. Keeping it here
// means index.ts does not have to grow, and the pipeline never imports Electron.
export function createAppTraceRuntime(deps: {
  getWindow: () => BrowserWindow | null
  rendererCanReceive: () => boolean
  activeRunSessionKey: (run: Parameters<typeof createTraceRuntime>[0]['activeRunSessionKey'] extends (run: infer R) => unknown ? R : never) => string | null
  dockBadge: Parameters<typeof createTraceRuntime>[0]['dockBadge']
  mainEventId: (prefix: string, runId: string) => string
}) {
  const renderer: RunRendererSink = {
    send: (channel, payload) => { deps.getWindow()?.webContents.send(channel, payload) },
    isFocused: () => Boolean(deps.getWindow()?.isFocused())
  }
  return createTraceRuntime({
    renderer,
    rendererCanReceive: deps.rendererCanReceive,
    activeRunSessionKey: deps.activeRunSessionKey,
    dockBadge: deps.dockBadge,
    mainEventId: deps.mainEventId
  })
}
