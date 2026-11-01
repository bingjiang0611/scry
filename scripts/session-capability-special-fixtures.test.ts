import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runSpecialFixtures, withFixtureMedia } from './session-capability-special-fixtures.mjs'

class FixtureWindow {
  static windows: FixtureWindow[] = []
  webContents = {
    on: vi.fn(),
    setWindowOpenHandler: vi.fn((_handler: () => { action: string }) => {}),
    executeJavaScript: vi.fn().mockResolvedValue({ reduced: false, forcedColors: false }),
    debugger: { attach: vi.fn(), sendCommand: vi.fn().mockResolvedValue({}), detach: vi.fn() }
  }
  setSize = vi.fn()
  setContentSize = vi.fn()
  loadFile = vi.fn(async (_path: string) => {})
  destroy = vi.fn()
  constructor(readonly options: unknown = {}) { FixtureWindow.windows.push(this) }
}

function fixture(flags: Record<string, boolean>) {
  return {
    flags, win: new FixtureWindow(),
    paths: { motion: 'motion.html', lists: 'lists.html', loading: 'loading.html', overlays: 'overlays.html', structure: 'structure.html', sidebar: 'sidebar.html' },
    sources: {
      media: withFixtureMedia.toString(),
      loading: 'async () => ({ checked: true })',
      overlays: 'async () => ({ checked: true })',
      structure: 'async () => ({ checked: true })',
      sidebar: 'async () => ({ continuation: exerciseSidebarActivityContinuation() })',
      sidebarContinuation: '() => "continued"',
      sidebarUnread: 'async () => ({ checked: true })',
      motion: 'async () => ({ checked: true })',
      lists: 'async (_contents, _win, screenshot, pointer, campaign, structure) => ({ screenshot, pointer, campaign, structure: structure() })',
      listStructure: '() => "structure-ran"', pointer: 'native-pointer-source'
    },
    screenshots: { loading: 'loading.png', lists: 'lists.png' },
    campaign: 'baseline', logRendererError: vi.fn(), setDiagnostic: vi.fn()
  }
}

beforeEach(() => { FixtureWindow.windows = [] })

describe('special UI fixture campaign ownership', () => {
  it('continues the default campaign after motion without destroying its main window', async () => {
    const args = fixture({ motion: true, motionOnly: false })
    expect(await runSpecialFixtures(args)).toEqual({ done: false, result: { motionTokens: { checked: true } } })
    const motion = FixtureWindow.windows[1]
    expect(motion.options).toMatchObject({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true } })
    expect(motion.webContents.setWindowOpenHandler.mock.calls[0][0]()).toEqual({ action: 'deny' })
    expect(motion.destroy).toHaveBeenCalledOnce()
    expect(args.win.destroy).not.toHaveBeenCalled()
    expect(args.setDiagnostic.mock.calls.map(([contents]) => contents)).toEqual([motion.webContents, args.win.webContents])
  })

  it('finishes only when motion-only was explicitly selected', async () => {
    expect(await runSpecialFixtures(fixture({ motion: true, motionOnly: true }))).toMatchObject({ done: true })
  })

  it('leaves ordinary fixtures untouched when no special mode is selected', async () => {
    const args = fixture({})
    expect(await runSpecialFixtures(args)).toEqual({ done: false, result: {} })
    expect(args.win.loadFile).not.toHaveBeenCalled()
    expect(FixtureWindow.windows).toHaveLength(1)
  })

  it('keeps the list campaign screenshot and structure checks separate from loading', async () => {
    expect(await runSpecialFixtures(fixture({ lists: true }))).toEqual({
      done: true,
      result: { lists: { screenshot: 'lists.png', pointer: 'native-pointer-source', campaign: 'baseline', structure: 'structure-ran' } }
    })
  })

  it.each(['loading', 'lists', 'overlays', 'structure', 'sidebar'])('loads the %s fixture before establishing media and releases one debugger', async mode => {
    const args = fixture({ [mode]: true })
    await runSpecialFixtures(args)
    const debuggerApi = args.win.webContents.debugger
    expect(debuggerApi.attach).toHaveBeenCalledOnce()
    expect(debuggerApi.sendCommand).toHaveBeenNthCalledWith(1, 'Emulation.setEmulatedMedia', { features: [
      { name: 'prefers-reduced-motion', value: 'no-preference' }, { name: 'forced-colors', value: 'none' }
    ] })
    expect(args.win.loadFile.mock.invocationCallOrder[0]).toBeLessThan(debuggerApi.attach.mock.invocationCallOrder[0])
    expect(debuggerApi.sendCommand.mock.invocationCallOrder[0]).toBeLessThan(args.win.webContents.executeJavaScript.mock.invocationCallOrder[0])
    expect(debuggerApi.sendCommand).toHaveBeenLastCalledWith('Emulation.setEmulatedMedia', { features: [] })
    expect(debuggerApi.detach).toHaveBeenCalledOnce()
  })

  it('keeps the serialized sidebar continuation and later unread checks in the same media scope', async () => {
    const args = fixture({ motion: true, sidebar: true, sidebarOnly: true })
    expect(await runSpecialFixtures(args)).toEqual({ done: true, result: {
      motionTokens: { checked: true }, sidebarActivity: { continuation: 'continued' }, sidebarUnreadResults: { checked: true }
    } })
    expect(args.win.loadFile.mock.calls).toEqual([['sidebar.html'], ['sidebar.html']])
    expect(args.win.webContents.debugger.attach).toHaveBeenCalledOnce()
  })

  it('clears media and detaches when an early positive assertion fails', async () => {
    const args = fixture({ overlays: true })
    args.sources.overlays = 'async () => { throw new Error("positive control failed") }'
    await expect(runSpecialFixtures(args)).rejects.toThrow('positive control failed')
    expect(args.win.webContents.debugger.sendCommand).toHaveBeenLastCalledWith('Emulation.setEmulatedMedia', { features: [] })
    expect(args.win.webContents.debugger.detach).toHaveBeenCalledOnce()
  })

  it('does not treat media-command acknowledgement as established normal controls', async () => {
    const args = fixture({ loading: true })
    args.win.webContents.executeJavaScript.mockResolvedValue({ reduced: true, forcedColors: false })
    args.sources.loading = 'async () => { throw new Error("exercise must not run") }'
    await expect(runSpecialFixtures(args)).rejects.toThrow('Normal fixture media not established')
    expect(args.win.loadFile).toHaveBeenCalledOnce()
    expect(args.win.webContents.debugger.detach).toHaveBeenCalledOnce()
  })

  it('does not attach to a missing target when initial navigation fails', async () => {
    const args = fixture({ lists: true })
    args.win.loadFile.mockRejectedValue(new Error('navigation failed'))
    await expect(runSpecialFixtures(args)).rejects.toThrow('navigation failed')
    expect(args.win.webContents.executeJavaScript).not.toHaveBeenCalled()
    expect(args.win.webContents.debugger.attach).not.toHaveBeenCalled()
    expect(args.win.webContents.debugger.detach).not.toHaveBeenCalled()
  })

  it('propagates motion failure while keeping the failing page available for diagnosis', async () => {
    const args = fixture({ motion: true })
    args.sources.motion = 'async () => { throw new Error("motion failed") }'
    await expect(runSpecialFixtures(args)).rejects.toThrow('motion failed')
    expect(args.setDiagnostic).toHaveBeenLastCalledWith(FixtureWindow.windows[1].webContents)
  })
})
