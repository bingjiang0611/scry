import { ipcRenderer } from 'electron'
import type { BackgroundServiceActionResult, BackgroundServiceStatus } from '../shared/background-service'

// The «后台服务» settings section (B4-S S0-1). None of these takes an argument: the
// renderer cannot name a process, a path or a confirmation answer; main asks the user in
// its own dialogs and signals only the verified daemon.lock holder.
export const backgroundServiceApi = {
  backgroundServiceStatus: (): Promise<BackgroundServiceStatus> => ipcRenderer.invoke('remote:backgroundService:status'),
  restartBackgroundService: (): Promise<BackgroundServiceActionResult> => ipcRenderer.invoke('remote:backgroundService:restart'),
  quitWithBackgroundService: (): Promise<BackgroundServiceActionResult> => ipcRenderer.invoke('remote:backgroundService:quit'),
  reconnectBackgroundService: (): Promise<BackgroundServiceActionResult> => ipcRenderer.invoke('remote:backgroundService:reconnect')
}
