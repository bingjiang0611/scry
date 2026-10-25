import { exerciseMotionTokens } from './motion-tokens-ui-checks.mjs'
import { exerciseStructure } from './structure-ui-checks.mjs'
import { exerciseOverlays } from './overlays-ui-checks.mjs'
import { exerciseLists } from './lists-ui-checks.mjs'
import { exerciseListStructure } from './lists-structure-ui-checks.mjs'
import { exerciseLoading } from './loading-ui-checks.mjs'
import { nativeUiPointer } from './native-ui-pointer.mjs'

export function specialFixtureSources() {
  return {
    runner: runSpecialFixtures.toString(),
    pointer: nativeUiPointer.toString(),
    loading: exerciseLoading.toString(),
    lists: exerciseLists.toString(),
    listStructure: exerciseListStructure.toString(),
    overlays: exerciseOverlays.toString(),
    motion: exerciseMotionTokens.toString(),
    structure: exerciseStructure.toString()
  }
}

// Serialized into the isolated Electron process. Only the caller owns process exit:
// the default campaign must continue after the optional motion checks.
export async function runSpecialFixtures({ flags, win, paths, sources, screenshots, campaign, logRendererError, setDiagnostic }) {
  const decode = source => Function('return (' + source + ')')()
  if (flags.loading) {
    win.setSize(1400, 900)
    await win.loadFile(paths.loading)
    return { done: true, result: { loading: await decode(sources.loading)(win.webContents, win, sources.pointer, screenshots.loading) } }
  }
  if (flags.lists) {
    win.setSize(1400, 900)
    await win.loadFile(paths.lists)
    return { done: true, result: { lists: await decode(sources.lists)(win.webContents, win, screenshots.lists, sources.pointer, campaign, decode(sources.listStructure)) } }
  }
  if (flags.overlays) {
    win.setSize(1280, 900)
    await win.loadFile(paths.overlays)
    return { done: true, result: { overlays: await decode(sources.overlays)(win.webContents) } }
  }
  if (flags.paneBench) {
    win.setContentSize(1280, 800)
    await win.loadFile(paths.paneBench)
    const paneBenchmark = await win.webContents.executeJavaScript(`(async () => {
      const deadline = Date.now() + 5000
      while (!window.paneExperiment && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 16))
      if (!window.paneExperiment) throw new Error('Pane benchmark did not mount')
      return [await window.paneExperiment('V'), await window.paneExperiment('F')]
    })()`)
    return { done: true, result: { paneBenchmark } }
  }
  if (flags.motion) {
    const motionWin = new win.constructor({ show: false, width: 1400, height: 1000, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true } })
    motionWin.webContents.on('paint', () => {})
    motionWin.webContents.on('console-message', logRendererError)
    motionWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    setDiagnostic(motionWin.webContents)
    await motionWin.loadFile(paths.motion)
    const motionTokens = await decode(sources.motion)(motionWin.webContents)
    motionWin.destroy()
    setDiagnostic(win.webContents)
    return { done: flags.motionOnly, result: { motionTokens } }
  }
  return { done: false, result: {} }
}
