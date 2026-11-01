import { exerciseMotionTokens } from './motion-tokens-ui-checks.mjs'
import { exerciseStructure } from './structure-ui-checks.mjs'
import { exerciseOverlays } from './overlays-ui-checks.mjs'
import { exerciseLists } from './lists-ui-checks.mjs'
import { exerciseListStructure } from './lists-structure-ui-checks.mjs'
import { exerciseLoading } from './loading-ui-checks.mjs'
import { exerciseSidebarActivity } from './sidebar-activity-ui-checks.mjs'
import { exerciseSidebarActivityContinuation } from './sidebar-activity-ui-continuation.mjs'
import { exerciseSidebarUnreadResults } from './sidebar-unread-results-ui-checks.mjs'
import { nativeUiPointer } from './native-ui-pointer.mjs'

// An initial blank WebContents has no debugger target. Load first, then control
// every positive/reduced/forced-colors phase. Serialized dependencies stay explicit.
export async function withFixtureMedia(contents, load, exercise) {
  await load()
  contents.debugger.attach('1.3')
  try {
    await contents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [
      { name: 'prefers-reduced-motion', value: 'no-preference' },
      { name: 'forced-colors', value: 'none' }
    ] })
    const state = await contents.executeJavaScript(`({
      reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
      forcedColors: matchMedia('(forced-colors: active)').matches
    })`)
    if (state.reduced || state.forcedColors) throw new Error(`Normal fixture media not established: ${JSON.stringify(state)}`)
    return await exercise()
  } finally {
    try { await contents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] }) }
    finally { contents.debugger.detach() }
  }
}

export function specialFixtureSources() {
  return {
    runner: runSpecialFixtures.toString(),
    media: withFixtureMedia.toString(),
    pointer: nativeUiPointer.toString(),
    loading: exerciseLoading.toString(),
    lists: exerciseLists.toString(),
    listStructure: exerciseListStructure.toString(),
    overlays: exerciseOverlays.toString(),
    motion: exerciseMotionTokens.toString(),
    structure: exerciseStructure.toString(),
    sidebar: exerciseSidebarActivity.toString(),
    sidebarContinuation: exerciseSidebarActivityContinuation.toString(),
    sidebarUnread: exerciseSidebarUnreadResults.toString()
  }
}

// Serialized into the isolated Electron process. Only the caller owns process exit:
// the default campaign must continue after optional motion and sidebar checks.
export async function runSpecialFixtures({ flags, win, paths, sources, screenshots, campaign, logRendererError, setDiagnostic }) {
  const decode = source => Function('return (' + source + ')')()
  const withMedia = decode(sources.media)
  if (flags.loading) {
    win.setSize(1400, 900)
    return withMedia(win.webContents, () => win.loadFile(paths.loading), async () => ({
      done: true, result: { loading: await decode(sources.loading)(win.webContents, win, sources.pointer, screenshots.loading) }
    }))
  }
  if (flags.lists) {
    win.setSize(1400, 900)
    return withMedia(win.webContents, () => win.loadFile(paths.lists), async () => ({
      done: true, result: { lists: await decode(sources.lists)(win.webContents, win, screenshots.lists, sources.pointer, campaign, decode(sources.listStructure)) }
    }))
  }
  if (flags.overlays) {
    win.setSize(1280, 900)
    return withMedia(win.webContents, () => win.loadFile(paths.overlays), async () => ({
      done: true, result: { overlays: await decode(sources.overlays)(win.webContents) }
    }))
  }
  if (flags.structure) {
    win.setSize(1200, 900)
    return withMedia(win.webContents, () => win.loadFile(paths.structure), async () => ({
      done: true, result: { structure: await decode(sources.structure)(win.webContents) }
    }))
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
  const result = {}
  if (flags.motion) {
    const motionWin = new win.constructor({ show: false, width: 1400, height: 1000, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true } })
    motionWin.webContents.on('paint', () => {})
    motionWin.webContents.on('console-message', logRendererError)
    motionWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    setDiagnostic(motionWin.webContents)
    await motionWin.loadFile(paths.motion)
    result.motionTokens = await decode(sources.motion)(motionWin.webContents)
    motionWin.destroy()
    setDiagnostic(win.webContents)
    if (flags.motionOnly) return { done: true, result }
  }
  if (flags.sidebar) {
    win.setSize(1100, 760)
    await withMedia(win.webContents, () => win.loadFile(paths.sidebar), async () => {
      const exercise = Function('exerciseSidebarActivityContinuation', 'return (' + sources.sidebar + ')')(decode(sources.sidebarContinuation))
      result.sidebarActivity = await exercise(win.webContents, screenshots.sidebar)
      await win.loadFile(paths.sidebar)
      result.sidebarUnreadResults = await decode(sources.sidebarUnread)(win.webContents)
    })
    if (flags.sidebarOnly) return { done: true, result }
  }
  return { done: false, result }
}
