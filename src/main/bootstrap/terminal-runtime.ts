import { join } from 'node:path'
import { TerminalOutputBridge } from '../terminal-output'
import { TerminalRecordingWorkerClient } from '../terminal-recording-backend'
import { createTerminalManager, type TerminalManager, type TerminalPtyFactory } from '../terminal-manager'
import { warmShellEnv } from '../claude-locate'
import { defaultShellPath } from '../shell'
import type { TerminalDataEvent, TerminalExitEvent, TerminalRecordingErrorEvent } from '../../shared/terminal'

/** Where terminal output goes: main's window, or the daemon's queue for its App. */
export interface TerminalOutputSink {
  canSend(): boolean
  data(events: TerminalDataEvent[]): void
  exit(event: TerminalExitEvent): void
  recordingError(event: TerminalRecordingErrorEvent): void
}

type TerminalRuntimeTarget =
  | { getWindow: () => Electron.BrowserWindow | null; rendererCanReceive: () => boolean; sink?: undefined }
  | { sink: TerminalOutputSink; getWindow?: undefined; rendererCanReceive?: undefined }

export type TerminalRuntimeDependencies = TerminalRuntimeTarget & {
  userDataDir: string
  recordingWorkerUrl: URL
  getCurrentCwd: () => string | undefined
  getHomeDir: () => string
  /** Tests: a fake PTY, the recording in this process, and a fixed shell environment. */
  pty?: TerminalPtyFactory
  inlineRecording?: boolean
  environment?: () => Promise<Record<string, string | undefined>>
}

function windowSink(getWindow: () => Electron.BrowserWindow | null, rendererCanReceive: () => boolean): TerminalOutputSink {
  return {
    canSend: rendererCanReceive,
    data: (events) => getWindow()?.webContents.send('terminal:data', events),
    exit: (event) => getWindow()?.webContents.send('terminal:exit', event),
    recordingError: (event) => { if (rendererCanReceive()) getWindow()?.webContents.send('terminal:recordingError', event) }
  }
}

export function createTerminalRuntime(deps: TerminalRuntimeDependencies) {
  const sink = deps.sink ?? windowSink(deps.getWindow, deps.rendererCanReceive)
  let terminalManager: TerminalManager | undefined
  let terminalManagerPromise: Promise<TerminalManager> | undefined
  const terminalOutput = new TerminalOutputBridge({
    canSend: () => sink.canSend(),
    sendData: (events) => sink.data(events),
    sendExit: (event) => sink.exit(event),
    pauseTerminal: (id) => terminalManager?.pauseOutput(id),
    resumeTerminal: (id) => terminalManager?.resumeOutput(id),
    warn: (message, id) => console.warn(`[scry] ${message}:`, id)
  })
  const recordingDirectory = join(deps.userDataDir, 'terminal-recordings')

  async function getTerminalManager(): Promise<TerminalManager> {
    if (terminalManager) return terminalManager
    if (!terminalManagerPromise) {
      terminalManagerPromise = (deps.environment ?? warmShellEnv)()
        .then((env) => {
          let manager: TerminalManager | undefined
          const recordingBackend = deps.inlineRecording ? undefined : TerminalRecordingWorkerClient.create(
            recordingDirectory,
            {
              onFailure: (id) => {
                console.warn('[scry] terminal recording unavailable:', id)
                sink.recordingError({ id, message: '终端录制失败，已保存内容可能不完整；Shell 继续运行。' })
              },
              onFlow: ({ id, paused }) => {
                if (paused) manager?.pauseRecording(id)
                else manager?.resumeRecording(id)
              }
            },
            deps.recordingWorkerUrl
          )
          manager = createTerminalManager({
            getCurrentCwd: () => deps.getCurrentCwd(),
            defaultCwd: deps.getHomeDir(),
            onData: (event) => terminalOutput.data(event),
            onExit: (event) => terminalOutput.exit(event),
            ...(recordingBackend ? { recordingBackend } : { recordingDirectory }),
            onRecordingError: (event) => {
              console.warn('[scry] terminal recording unavailable:', event.id)
              sink.recordingError(event)
            },
            shell: env.SHELL || process.env.SHELL || defaultShellPath(),
            env,
            ...(deps.pty ? { pty: deps.pty } : {})
          })
          terminalManager = manager
          return manager
        })
        .catch((error) => {
          terminalManagerPromise = undefined
          throw error
        })
    }
    return terminalManagerPromise
  }

  return { terminalOutput, getTerminalManager, getTerminalManagerInstance: () => terminalManager }
}
