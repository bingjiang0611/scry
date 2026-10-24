import { ipcRenderer } from 'electron'
import type { RemoteStatus, RemotePairingCode, RemoteDevice } from '../shared/remote'
import type { DesktopRemoteAPI, DesktopHostAccess } from '../shared/desktop-remote'

export const remoteApi = {
  desktopRemote: {
    workbench: (id, request) => ipcRenderer.invoke('desktopRemote:workbench', id, request),
    list: () => ipcRenderer.invoke('desktopRemote:list'),
    pair: (input) => ipcRenderer.invoke('desktopRemote:pair', input),
    finishPairing: (id) => ipcRenderer.invoke('desktopRemote:finishPairing', id),
    updateSsh: (id, ssh) => ipcRenderer.invoke('desktopRemote:updateSsh', id, ssh),
    connect: (id) => ipcRenderer.invoke('desktopRemote:connect', id),
    disconnect: (id) => ipcRenderer.invoke('desktopRemote:disconnect', id),
    forget: (id) => ipcRenderer.invoke('desktopRemote:forget', id),
    catalog: (id) => ipcRenderer.invoke('desktopRemote:catalog', id),
    providerControls: (id, context) => ipcRenderer.invoke('desktopRemote:providerControls', id, context),
    commands: (id, context) => ipcRenderer.invoke('desktopRemote:commands', id, context),
    sessionAction: (id, context, action) => ipcRenderer.invoke('desktopRemote:sessionAction', id, context, action),
    forkSession: (id, request) => ipcRenderer.invoke('desktopRemote:forkSession', id, request),
    deleteSession: (id, request) => ipcRenderer.invoke('desktopRemote:deleteSession', id, request),
    directories: (id, path, cursor, snapshot) => ipcRenderer.invoke('desktopRemote:directories', id, path, cursor, snapshot),
    selectDirectory: (id, path) => ipcRenderer.invoke('desktopRemote:selectDirectory', id, path),
    history: (id, context, before, snapshot) => ipcRenderer.invoke('desktopRemote:history', id, context, before, snapshot),
    trace: (id, context, runId, knownAttachmentCount?: number) => ipcRenderer.invoke('desktopRemote:trace', id, context, runId, knownAttachmentCount),
    traceDelta: (id, context, runId, after, knownAttachmentCount?: number) => ipcRenderer.invoke('desktopRemote:traceDelta', id, context, runId, after, knownAttachmentCount),
    intents: (id) => ipcRenderer.invoke('desktopRemote:intents', id),
    submit: (id, input) => ipcRenderer.invoke('desktopRemote:submit', id, input),
    intentStatus: (id, intentId) => ipcRenderer.invoke('desktopRemote:intentStatus', id, intentId),
    resolveIntent: (id, intentId) => ipcRenderer.invoke('desktopRemote:resolveIntent', id, intentId),
    runStatus: (id, runId) => ipcRenderer.invoke('desktopRemote:runStatus', id, runId),
    liveRun: (id, context) => ipcRenderer.invoke('desktopRemote:liveRun', id, context),
    stop: (id, runId) => ipcRenderer.invoke('desktopRemote:stop', id, runId),
    answer: (id, runId, response) => ipcRenderer.invoke('desktopRemote:answer', id, runId, response),
    files: (id, context, path, cursor) => ipcRenderer.invoke('desktopRemote:files', id, context, path, cursor),
    file: (id, context, path, offset, snapshot) => ipcRenderer.invoke('desktopRemote:file', id, context, path, offset, snapshot)
  } satisfies DesktopRemoteAPI,
  remoteDesktopHostStatus: (): Promise<DesktopHostAccess> => ipcRenderer.invoke('remote:desktop:status'),
  remoteDesktopHostInvite: (): Promise<string> => ipcRenderer.invoke('remote:desktop:invite'),
  remoteDesktopHostDisable: (): Promise<void> => ipcRenderer.invoke('remote:desktop:disable'),
  // Trusted-LOCAL remote-access pairing (Mac's own UI only).
  remoteStatus: (): Promise<RemoteStatus> => ipcRenderer.invoke('remote:status'),
  remoteBeginPairing: (): Promise<RemotePairingCode> => ipcRenderer.invoke('remote:pairing:begin'),
  remoteConfirmPairing: (pairingId: string, expectedPublicKeySHA256: string): Promise<RemoteDevice> =>
    ipcRenderer.invoke('remote:pairing:confirm', pairingId, expectedPublicKeySHA256),
  remoteCancelPairing: (pairingId: string): Promise<void> => ipcRenderer.invoke('remote:pairing:cancel', pairingId),
  remoteRevokeDevice: (deviceId: string): Promise<void> => ipcRenderer.invoke('remote:device:revoke', deviceId)
}
