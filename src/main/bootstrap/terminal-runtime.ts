import { join } from 'node:path'
import { TerminalOutputBridge } from '../terminal-output'
import { TerminalRecordingWorkerClient } from '../terminal-recording-backend'
import { createTerminalManager, type TerminalManager } from '../terminal-manager'
import { warmShellEnv } from '../claude-locate'
import { defaultShellPath } from '../shell'

export function createTerminalRuntime(deps: { userDataDir: string; getCurrentCwd: () => string | undefined; getHomeDir: () => string; getWindow: () => Electron.BrowserWindow | null; rendererCanReceive: () => boolean }) {
  let terminalManager: TerminalManager | undefined
  let terminalManagerPromise: Promise<TerminalManager> | undefined
  const terminalOutput = new TerminalOutputBridge({
    canSend: deps.rendererCanReceive,
    sendData: (events) => deps.getWindow()?.webContents.send('terminal:data', events),
    sendExit: (event) => deps.getWindow()?.webContents.send('terminal:exit', event),
    pauseTerminal: (id) => terminalManager?.pauseOutput(id),
    resumeTerminal: (id) => terminalManager?.resumeOutput(id),
    warn: (message, id) => console.warn(`[scry] ${message}:`, id)
  })

  async function getTerminalManager(): Promise<TerminalManager> {
    if (terminalManager) return terminalManager
    if (!terminalManagerPromise) {
      terminalManagerPromise = warmShellEnv()
        .then((env) => {
          let manager: TerminalManager | undefined
          const recordingBackend = TerminalRecordingWorkerClient.create(
            join(deps.userDataDir, 'terminal-recordings'),
            {
              onFailure: (id) => {
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
            getCurrentCwd: () => deps.getCurrentCwd(),
            defaultCwd: deps.getHomeDir(),
            onData: (event) => terminalOutput.data(event),
            onExit: (event) => terminalOutput.exit(event),
            recordingBackend,
            onRecordingError: (event) => {
              console.warn('[scry] terminal recording unavailable:', event.id)
              if (deps.rendererCanReceive()) deps.getWindow()?.webContents.send('terminal:recordingError', event)
            },
            shell: env.SHELL || process.env.SHELL || defaultShellPath(),
            env
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
