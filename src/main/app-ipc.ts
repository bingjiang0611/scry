import type { IpcMainInvokeEvent } from 'electron'
import type { BrowserWindow, Clipboard, NativeTheme } from 'electron'
import { isRendererPerformanceSample, type RendererPerformanceSample } from '../shared/performance'
import { writeClipboardText } from './clipboard-text'
import { windowBackgroundColor } from './window-chrome'

/**
 * App-level IPC handlers moved verbatim from the main entry module. Theme
 * selection still validates its input, renderer performance samples are still
 * rejected unless recording is enabled, and clipboard writes stay bounded.
 */
export function registerAppIpc(deps: {
  handleTrusted: (channel: string, handler: (event: IpcMainInvokeEvent, ...args: never[]) => unknown) => void
  window: () => BrowserWindow | null
  nativeTheme: NativeTheme
  clipboard: Clipboard
  performanceRecordingEnabled: () => boolean
  recordRendererPerformance: (sample: RendererPerformanceSample) => void
}) {
  const { handleTrusted, nativeTheme, clipboard, performanceRecordingEnabled, recordRendererPerformance } = deps
  handleTrusted('app:setTheme', (_event, theme: unknown) => {
    if (theme !== 'dark' && theme !== 'light') throw new Error('无效的界面主题')
    nativeTheme.themeSource = theme
    deps.window()?.setBackgroundColor(windowBackgroundColor(theme))
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
}
