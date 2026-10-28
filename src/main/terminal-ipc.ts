import type { IpcMainInvokeEvent } from 'electron'
import type {
  TerminalCloseRequest,
  TerminalRecordingRequest,
  TerminalRecordingListRequest,
  TerminalResizeRequest,
  TerminalStartRequest,
  TerminalOwnershipRequest,
  TerminalWriteRequest
} from '../shared/terminal'
import type { TerminalManager } from './terminal-manager'
import type { TerminalOutputBridge } from './terminal-output'

/**
 * Terminal IPC surface moved verbatim from the main entry module. Ownership
 * epochs, focus checks and the workspace-changed fence are unchanged: every
 * handler still revalidates the trusted event and the current workspace, and a
 * stale epoch never writes, resizes or closes a session.
 */
export function registerTerminalIpc(deps: {
  handleTrusted: (channel: string, handler: (event: IpcMainInvokeEvent, ...args: never[]) => unknown) => void
  assertTrustedIpcEvent: (event: IpcMainInvokeEvent) => void
  rendererCanReceive: () => boolean
  terminalOutput: TerminalOutputBridge
  getTerminalManager: () => Promise<TerminalManager>
  currentCwd: () => string | undefined
  isShuttingDown: () => boolean
}) {
  const { handleTrusted, assertTrustedIpcEvent, rendererCanReceive, terminalOutput, getTerminalManager } = deps
  handleTrusted('terminal:start', async (event, request: TerminalStartRequest) => {
    const manager = await getTerminalManager()
    if (deps.isShuttingDown() || !rendererCanReceive()) throw new Error('终端窗口已关闭')
    assertTrustedIpcEvent(event)
    const session = manager.start(request)
    const ownershipEpoch = terminalOutput.started(session.id)
    try {
      assertTrustedIpcEvent(event)
      if (!rendererCanReceive()) throw new Error('终端窗口已关闭')
    } catch (error) {
      terminalOutput.detach(session.id)
      throw error
    }
    if (deps.isShuttingDown()) {
      terminalOutput.terminalClosed(session.id)
      manager.close({ id: session.id })
      throw new Error('终端窗口已关闭')
    }
    return { ...session, ownershipEpoch }
  })
  handleTrusted('terminal:active', async (event) => {
    const manager = await getTerminalManager()
    assertTrustedIpcEvent(event)
    return manager.activeSessions()
  })
  handleTrusted('terminal:attach', async (event, request: { id: string }) => {
    const manager = await getTerminalManager()
    assertTrustedIpcEvent(event)
    const session = manager.session(request?.id)
    const ownershipEpoch = terminalOutput.attach(session.id)
    const catchUp = await manager.recordingCheckpoint(session.id)
    try {
      assertTrustedIpcEvent(event)
      if (!rendererCanReceive()) throw new Error('终端窗口已关闭')
    } catch (error) {
      terminalOutput.detach(session.id)
      throw error
    }
    return { ...session, ownershipEpoch, catchUp }
  })
  handleTrusted('terminal:write', async (event, request: TerminalWriteRequest) => {
    const manager = await getTerminalManager()
    if (!rendererCanReceive()) throw new Error('终端窗口已关闭')
    assertTrustedIpcEvent(event)
    if (!terminalOutput.owns(request?.id, request?.ownershipEpoch)) return false as const
    manager.write(request)
    return true as const
  })
  handleTrusted('terminal:resize', async (event, request: TerminalResizeRequest) => {
    const manager = await getTerminalManager()
    if (!rendererCanReceive()) throw new Error('终端窗口已关闭')
    assertTrustedIpcEvent(event)
    if (!terminalOutput.owns(request?.id, request?.ownershipEpoch)) return false as const
    manager.resize(request)
    return true as const
  })
  handleTrusted('terminal:recordingList', async (event, request: TerminalRecordingListRequest) => {
    const manager = await getTerminalManager()
    assertTrustedIpcEvent(event)
    const cwd = deps.currentCwd()
    const page = await manager.listRecordings(request)
    assertTrustedIpcEvent(event)
    if (cwd !== deps.currentCwd()) throw new Error('terminal_recording_workspace_changed')
    return page
  })
  handleTrusted('terminal:recordingRead', async (event, request: TerminalRecordingRequest) => {
    const manager = await getTerminalManager()
    assertTrustedIpcEvent(event)
    return manager.readRecording(request)
  })
  handleTrusted('terminal:recordingDelete', async (event, request: TerminalCloseRequest) => {
    const manager = await getTerminalManager()
    assertTrustedIpcEvent(event)
    await manager.deleteRecording(request?.id)
    assertTrustedIpcEvent(event)
    return true as const
  })
  handleTrusted('terminal:ready', (_event, request: TerminalOwnershipRequest) => {
    if (!request || typeof request.id !== 'string' || !request.id.startsWith('terminal-')) throw new Error('终端 ready 无效')
    return terminalOutput.ready(request.id, request.ownershipEpoch)
  })
  handleTrusted('terminal:ack', (_event, request: TerminalOwnershipRequest & { bytes: number }) => {
    if (!request || typeof request.id !== 'string') throw new Error('终端输出确认无效')
    return terminalOutput.ack(request.id, request.ownershipEpoch, request.bytes)
  })
  handleTrusted('terminal:close', async (event, request: TerminalOwnershipRequest) => {
    const manager = await getTerminalManager()
    if (!rendererCanReceive()) throw new Error('终端窗口已关闭')
    assertTrustedIpcEvent(event)
    if (!terminalOutput.owns(request?.id, request?.ownershipEpoch)) return false as const
    terminalOutput.terminalClosed(request.id)
    manager.close(request)
    return true as const
  })
}
