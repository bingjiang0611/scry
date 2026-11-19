import { ipcRenderer } from 'electron'
import type {
  BackgroundServiceActionResult,
  BackgroundServiceRuntimeNotice,
  BackgroundServiceStatus
} from '../shared/background-service'

// The «后台服务» settings section (B4-S S0-1, P5-2). Action channels take no argument
// except setBackgroundServiceLoginStart, which forwards a single boolean; paths, service
// definitions, and native confirmations are all owned by main.
export const backgroundServiceApi = {
  backgroundServiceStatus: (): Promise<BackgroundServiceStatus> => ipcRenderer.invoke('remote:backgroundService:status'),
  restartBackgroundService: (): Promise<BackgroundServiceActionResult> => ipcRenderer.invoke('remote:backgroundService:restart'),
  quitWithBackgroundService: (): Promise<BackgroundServiceActionResult> => ipcRenderer.invoke('remote:backgroundService:quit'),
  reconnectBackgroundService: (): Promise<BackgroundServiceActionResult> => ipcRenderer.invoke('remote:backgroundService:reconnect'),
  setBackgroundServiceLoginStart: (enabled: boolean): Promise<BackgroundServiceActionResult> =>
    ipcRenderer.invoke('remote:backgroundService:setLoginStart', enabled),
  onBackgroundServiceNotice: (cb: (notice: BackgroundServiceRuntimeNotice | null) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, notice: BackgroundServiceRuntimeNotice | null) => cb(notice)
    ipcRenderer.on('remote:backgroundService:notice', listener)
    return () => ipcRenderer.removeListener('remote:backgroundService:notice', listener)
  }
}
