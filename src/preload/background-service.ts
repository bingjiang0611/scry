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
  backgroundServiceRuntimeNotice: (): Promise<BackgroundServiceRuntimeNotice | null> =>
    ipcRenderer.invoke('remote:backgroundService:runtimeNotice'),
  restartBackgroundService: (): Promise<BackgroundServiceActionResult> => ipcRenderer.invoke('remote:backgroundService:restart'),
  quitWithBackgroundService: (): Promise<BackgroundServiceActionResult> => ipcRenderer.invoke('remote:backgroundService:quit'),
  reconnectBackgroundService: (): Promise<BackgroundServiceActionResult> => ipcRenderer.invoke('remote:backgroundService:reconnect'),
  setBackgroundServiceLoginStart: (enabled: boolean): Promise<BackgroundServiceActionResult> =>
    ipcRenderer.invoke('remote:backgroundService:setLoginStart', enabled),
  usageLimitResume: (): Promise<{ enabled: boolean }> => ipcRenderer.invoke('remote:backgroundService:usageLimitResume'),
  // C4: one boolean, nothing else. The daemon reads the same file this writes.
  setUsageLimitResume: (enabled: boolean): Promise<{ status: 'done' }> =>
    ipcRenderer.invoke('remote:backgroundService:setUsageLimitResume', enabled),
  setHostCliApproval: (enabled: boolean): Promise<BackgroundServiceActionResult> =>
    ipcRenderer.invoke('remote:hostAdmin:setCliApproval', enabled),
  onBackgroundServiceNotice: (cb: (notice: BackgroundServiceRuntimeNotice | null) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, notice: BackgroundServiceRuntimeNotice | null) => cb(notice)
    ipcRenderer.on('remote:backgroundService:notice', listener)
    return () => ipcRenderer.removeListener('remote:backgroundService:notice', listener)
  },
  onHostAdminOpenDevices: (cb: (payload: { deviceId?: string }) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: { deviceId?: string }) => cb(payload ?? {})
    ipcRenderer.on('remote:hostAdmin:openDevices', listener)
    return () => ipcRenderer.removeListener('remote:hostAdmin:openDevices', listener)
  }
}
