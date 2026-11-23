import { ipcRenderer } from 'electron'
import type { HostMetricsSnapshot } from '../shared/host-metrics'

// The machine the App runs on (P8 §5). Read-only: the daemon samples on request
// and the App can do nothing else with this surface — no process control.
export const machinesApi = {
  hostMetricsRead: (): Promise<HostMetricsSnapshot> => ipcRenderer.invoke('hostMetrics:read')
}
