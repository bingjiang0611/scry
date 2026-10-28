import { join } from 'node:path'
import { warmShellEnv } from './claude-locate'
import { createTerminalManager, type TerminalManager } from './terminal-manager'
import { TerminalRecordingWorkerClient } from './terminal-recording-backend'
import { TerminalOutputBridge } from './terminal-output'

export interface MainTerminalRuntimeDeps {
  homeDir: string
  getUserData: () => string
  getCurrentCwd: () => string | undefined
  rendererCanReceive: () => boolean
  getWindow: () => { isDestroyed: () => boolean; webContents: { send: (channel: string, payload: unknown) => void } } | null
}

export function createMainTerminalRuntime(deps: MainTerminalRuntimeDeps): {
  terminalOutput: TerminalOutputBridge
  getTerminalManager: () => Promise<TerminalManager>
  terminalManager: () => TerminalManager | undefined
} {
  let terminalManager: TerminalManager | undefined
  let terminalManagerPromise: Promise<TerminalManager> | undefined
  const terminalOutput = new TerminalOutputBridge({
    canSend: deps.rendererCanReceive,
    sendData: events => deps.getWindow()?.webContents.send('terminal:data', events),
    sendExit: event => deps.getWindow()?.webContents.send('terminal:exit', event),
    pauseTerminal: id => terminalManager?.pauseOutput(id),
    resumeTerminal: id => terminalManager?.resumeOutput(id),
    warn: (message, id) => console.warn(`[scry] ${message}:`, id)
  })
  const getTerminalManager = async (): Promise<TerminalManager> => {
    if (terminalManager) return terminalManager
    if (!terminalManagerPromise) {
      terminalManagerPromise = warmShellEnv()
        .then(env => {
          let manager: TerminalManager | undefined
          const recordingBackend = TerminalRecordingWorkerClient.create(
            join(deps.getUserData(), 'terminal-recordings'),
            {
              onFailure: id => {
                console.warn('[scry] terminal recording unavailable:', id)
                if (deps.rendererCanReceive()) deps.getWindow()?.webContents.send('terminal:recordingError', {
                  id, message: '终端录制失败，已保存内容可能不完整；Shell 继续运行。'
                })
              },
              onFlow: ({ id, paused }) => {
                if (paused) manager?.pauseRecording(id)
                else manager?.resumeRecording(id)
              }
            }
          )
          manager = createTerminalManager({
            getCurrentCwd: deps.getCurrentCwd,
            defaultCwd: deps.homeDir,
            onData: event => terminalOutput.data(event),
            onExit: event => terminalOutput.exit(event),
            recordingBackend,
            onRecordingError: event => {
              console.warn('[scry] terminal recording unavailable:', event.id)
              if (deps.rendererCanReceive()) deps.getWindow()?.webContents.send('terminal:recordingError', event)
            },
            shell: env.SHELL || process.env.SHELL || '/bin/zsh',
            env
          })
          terminalManager = manager
          return manager
        })
        .catch(error => {
          terminalManagerPromise = undefined
          throw error
        })
    }
    return terminalManagerPromise
  }
  return { terminalOutput, getTerminalManager, terminalManager: () => terminalManager }
}
