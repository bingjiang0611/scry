import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runSpecialFixtures } from './session-capability-special-fixtures.mjs'

class FixtureWindow {
  static windows: FixtureWindow[] = []
  webContents = {
    on: vi.fn(),
    setWindowOpenHandler: vi.fn((_handler: () => { action: string }) => {}),
    executeJavaScript: vi.fn()
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
    paths: { motion: 'motion.html', lists: 'lists.html' },
    sources: {
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

  it('propagates motion failure while keeping the failing page available for diagnosis', async () => {
    const args = fixture({ motion: true })
    args.sources.motion = 'async () => { throw new Error("motion failed") }'
    await expect(runSpecialFixtures(args)).rejects.toThrow('motion failed')
    expect(args.setDiagnostic).toHaveBeenLastCalledWith(FixtureWindow.windows[1].webContents)
  })
})
