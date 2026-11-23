import { clipboard, dialog, nativeTheme } from 'electron'
import type { BrowserWindow } from 'electron'
import type { AgentInputAttachment } from '../../shared/runtime'
import { writeClipboardText } from '../clipboard-text'
import { isRendererPerformanceSample } from '../../shared/performance'
import { performanceRecordingEnabled } from '../performance-timing'
import { recordRendererPerformance } from '../performance-recording'
import { windowBackgroundColor } from '../window-chrome'
import { confirmDelegationSwitchInMain } from '../delegation-policy-dialog'
import { installProjectDaemonWindow } from './project-daemon'
import type { TrustedRegistrar } from './agent-runtime-ipc'

export interface AppAgentBootstrapDependencies {
  handleTrusted: TrustedRegistrar
  getWindow: () => BrowserWindow | null
  dialog: typeof dialog
  setCurrentCwd: (cwd: string | undefined) => void
  getCurrentCwd: () => string | undefined
}

/**
 * The App's own window channels (theme, clipboard, renderer performance) and the window
 * parts of the folder and Pi launcher pickers. The work after a picker (validating and
 * remembering the folder, the Pi handshake and profile store) is the daemon's
 * (project-channels.ts, served as local ops); project-daemon.ts runs the picker first.
 */
export function registerAppAgentHandlers(deps: AppAgentBootstrapDependencies): void {
  const { handleTrusted, getWindow, dialog, setCurrentCwd, getCurrentCwd } = deps
  handleTrusted('app:setTheme', (_event, theme: unknown) => {
    if (theme !== 'dark' && theme !== 'light') throw new Error('无效的界面主题')
    nativeTheme.themeSource = theme
    getWindow()?.setBackgroundColor(windowBackgroundColor(theme))
    return true as const
  })

  handleTrusted('app:copyText', (_event, text: unknown) => writeClipboardText(text, clipboard))
  handleTrusted('app:performanceDiagnosticsEnabled', () => performanceRecordingEnabled())
  handleTrusted('app:reportRendererPerformance', (_event, sample: unknown) => {
    if (!isRendererPerformanceSample(sample)) throw new Error('无效的 renderer 性能样本')
    if (!performanceRecordingEnabled()) return false
    recordRendererPerformance(sample)
    return true
  })

  const pickFolder = async (): Promise<string | null> => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0]
  }
  const pickPiLauncher = async (): Promise<string | null> => {
    const result = await dialog.showOpenDialog({ title: '选择 Pi Agent 启动器', properties: ['openFile'] })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  }
  const notifyPiFailure = async (detail: string): Promise<void> => {
    const options = { type: 'error' as const, title: '无法添加 Pi Agent', message: '所选启动器未通过 Pi RPC 握手', detail }
    if (getWindow() && !getWindow()!.isDestroyed()) await dialog.showMessageBox(getWindow()!, options)
    else await dialog.showMessageBox(options)
  }
  installProjectDaemonWindow({
    pickFolder, pickPiLauncher, notifyPiFailure, windowCwd: getCurrentCwd,
    applyChosenFolder: (dir) => { setCurrentCwd(dir) },
    confirmDelegationSwitch: (req) => confirmDelegationSwitchInMain(
      (win, options) => win && !win.isDestroyed() ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options),
      getWindow() ?? undefined,
      req
    )
  })

  handleTrusted('agent:clipboardImage', () => {
    const image = clipboard.readImage()
    if (image.isEmpty()) return null
    const size = image.getSize()
    const bytes = image.toPNG()
    return {
      kind: 'image',
      name: `clipboard-${Date.now().toString(36)}.png`,
      mimeType: 'image/png',
      dataBase64: bytes.toString('base64'),
      size: bytes.byteLength,
      width: size.width,
      height: size.height
    } satisfies AgentInputAttachment
  })
}
