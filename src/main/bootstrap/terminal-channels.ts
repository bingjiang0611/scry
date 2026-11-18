import type { TerminalCloseRequest, TerminalRecordingRequest, TerminalRecordingListRequest, TerminalResizeRequest, TerminalStartRequest, TerminalOwnershipRequest, TerminalWriteRequest } from '../../shared/terminal'
import type { TerminalManager } from '../terminal-manager'
import type { TerminalOutputBridge } from '../terminal-output'
import type { ChannelHandlers } from './startup-channels'

// The `terminal:*` channels, as main has always answered them, shared with the daemon
// (P3-terminal.md) so daemon mode runs the same logic. The caller checks stay the
// caller's: main asserts the IPC event and that its window can receive; the daemon's App
// asks those before it sends, and the daemon passes none.

export interface TerminalChannelDependencies<E> {
  getTerminalManager: () => Promise<TerminalManager>
  terminalOutput: Pick<TerminalOutputBridge, 'started' | 'attach' | 'detach' | 'owns' | 'ready' | 'ack' | 'terminalClosed'>
  isShuttingDown: () => boolean
  rendererCanReceive: () => boolean
  assertCaller: (event: E) => void
  getCurrentCwd: () => string | undefined
}

export function terminalChannelHandlers<E>(deps: TerminalChannelDependencies<E>) {
  const { getTerminalManager, terminalOutput, isShuttingDown, rendererCanReceive, assertCaller, getCurrentCwd } = deps
  return {
    'terminal:start': async (event: E, request: TerminalStartRequest) => {
      const manager = await getTerminalManager()
      if (isShuttingDown() || !rendererCanReceive()) throw new Error('终端窗口已关闭')
      assertCaller(event)
      const session = manager.start(request)
      const ownershipEpoch = terminalOutput.started(session.id)
      try {
        assertCaller(event)
        if (!rendererCanReceive()) throw new Error('终端窗口已关闭')
      } catch (error) {
        terminalOutput.detach(session.id)
        throw error
      }
      if (isShuttingDown()) {
        terminalOutput.terminalClosed(session.id)
        manager.close({ id: session.id })
        throw new Error('终端窗口已关闭')
      }
      return { ...session, ownershipEpoch }
    },
    'terminal:active': async (event: E) => {
      const manager = await getTerminalManager()
      assertCaller(event)
      return manager.activeSessions()
    },
    'terminal:attach': async (event: E, request: { id: string }) => {
      const manager = await getTerminalManager()
      assertCaller(event)
      const session = manager.session(request?.id)
      const ownershipEpoch = terminalOutput.attach(session.id)
      const catchUp = await manager.recordingCheckpoint(session.id)
      try {
        assertCaller(event)
        if (!rendererCanReceive()) throw new Error('终端窗口已关闭')
      } catch (error) {
        terminalOutput.detach(session.id)
        throw error
      }
      return { ...session, ownershipEpoch, catchUp }
    },
    'terminal:write': async (event: E, request: TerminalWriteRequest) => {
      const manager = await getTerminalManager()
      if (!rendererCanReceive()) throw new Error('终端窗口已关闭')
      assertCaller(event)
      if (!terminalOutput.owns(request?.id, request?.ownershipEpoch)) return false as const
      manager.write(request)
      return true as const
    },
    'terminal:resize': async (event: E, request: TerminalResizeRequest) => {
      const manager = await getTerminalManager()
      if (!rendererCanReceive()) throw new Error('终端窗口已关闭')
      assertCaller(event)
      if (!terminalOutput.owns(request?.id, request?.ownershipEpoch)) return false as const
      manager.resize(request)
      return true as const
    },
    'terminal:recordingList': async (event: E, request: TerminalRecordingListRequest) => {
      const manager = await getTerminalManager()
      assertCaller(event)
      const cwd = getCurrentCwd()
      const page = await manager.listRecordings(request)
      assertCaller(event)
      if (cwd !== getCurrentCwd()) throw new Error('terminal_recording_workspace_changed')
      return page
    },
    'terminal:recordingRead': async (event: E, request: TerminalRecordingRequest) => {
      const manager = await getTerminalManager()
      assertCaller(event)
      return manager.readRecording(request)
    },
    'terminal:recordingDelete': async (event: E, request: TerminalCloseRequest) => {
      const manager = await getTerminalManager()
      assertCaller(event)
      await manager.deleteRecording(request?.id)
      assertCaller(event)
      return true as const
    },
    'terminal:ready': (_event: E, request: TerminalOwnershipRequest) => {
      if (!request || typeof request.id !== 'string' || !request.id.startsWith('terminal-')) throw new Error('终端 ready 无效')
      return terminalOutput.ready(request.id, request.ownershipEpoch)
    },
    'terminal:ack': (_event: E, request: TerminalOwnershipRequest & { bytes: number }) => {
      if (!request || typeof request.id !== 'string') throw new Error('终端输出确认无效')
      return terminalOutput.ack(request.id, request.ownershipEpoch, request.bytes)
    },
    'terminal:close': async (event: E, request: TerminalOwnershipRequest) => {
      const manager = await getTerminalManager()
      if (!rendererCanReceive()) throw new Error('终端窗口已关闭')
      assertCaller(event)
      if (!terminalOutput.owns(request?.id, request?.ownershipEpoch)) return false as const
      terminalOutput.terminalClosed(request.id)
      manager.close(request)
      return true as const
    }
  } satisfies ChannelHandlers
}
