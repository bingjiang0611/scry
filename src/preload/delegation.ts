import { ipcRenderer } from 'electron'
import type {
  DelegationActionResult,
  DelegationConfirmCancelRequest,
  DelegationConfirmTaskRequest,
  DelegationProjectPolicyRequest,
  DelegationSessionFullAccessRequest,
  DelegationStateQuery,
  DelegationStateSnapshot,
  DelegationStopSubtasksRequest
} from '../shared/delegation'

export const delegationApi = {
  delegation: {
    getState: (query: DelegationStateQuery): Promise<DelegationStateSnapshot> =>
      ipcRenderer.invoke('delegation:getState', query),
    setProjectPolicy: (request: DelegationProjectPolicyRequest): Promise<DelegationActionResult> =>
      ipcRenderer.invoke('delegation:setProjectPolicy', request),
    setSessionFullAccess: (request: DelegationSessionFullAccessRequest): Promise<DelegationActionResult> =>
      ipcRenderer.invoke('delegation:setSessionFullAccess', request),
    confirmTask: (request: DelegationConfirmTaskRequest): Promise<DelegationActionResult> =>
      ipcRenderer.invoke('delegation:confirmTask', request),
    confirmCancelTask: (request: DelegationConfirmCancelRequest): Promise<DelegationActionResult> =>
      ipcRenderer.invoke('delegation:confirmCancelTask', request),
    stopSessionSubtasks: (request: DelegationStopSubtasksRequest): Promise<DelegationActionResult> =>
      ipcRenderer.invoke('delegation:stopSessionSubtasks', request)
  }
}
