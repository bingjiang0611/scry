import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { RightSurfacePanel } from './components/RightSurfacePanel'
import { TerminalSurface, terminalStartErrorMessage, terminalTabsForActiveSessions } from './components/TerminalSurface'
import {
  RIGHT_SURFACE_DEFINITIONS,
  createRightSurfaceState,
  reduceRightSurfaceState
} from './right-surface'

describe('right surface state', () => {
  it('默认打开并激活纵览', () => {
    expect(createRightSurfaceState()).toEqual({
      openIds: ['overview'],
      activeId: 'overview',
      sideChats: [],
      activeSideChatId: null,
      visible: true,
      maximized: false
    })
  })

  it('初始化时去重，且不接受未打开的激活项', () => {
    expect(createRightSurfaceState({
      openIds: ['files', 'overview', 'files'],
      activeId: 'agents'
    })).toEqual({
      openIds: ['files', 'overview'],
      activeId: 'files',
      sideChats: [],
      activeSideChatId: null,
      visible: true,
      maximized: false
    })
  })

  it('添加 Surface 会追加、激活并显示面板', () => {
    const hidden = createRightSurfaceState({ visible: false })
    const opened = reduceRightSurfaceState(hidden, { type: 'open', kind: 'terminal' })

    expect(opened).toMatchObject({
      openIds: ['overview', 'terminal'],
      activeId: 'terminal',
      visible: true
    })
  })

  it('重复打开只激活，不改变 tab 顺序', () => {
    const state = createRightSurfaceState({ openIds: ['overview', 'files'], activeId: 'files' })
    const reopened = reduceRightSurfaceState(state, { type: 'open', kind: 'overview' })

    expect(reopened.openIds).toEqual(['overview', 'files'])
    expect(reopened.activeId).toBe('overview')
  })

  it('关闭激活 tab 时优先激活其右侧邻居', () => {
    const state = createRightSurfaceState({
      openIds: ['overview', 'files', 'terminal'],
      activeId: 'files'
    })

    expect(reduceRightSurfaceState(state, { type: 'close', kind: 'files' })).toMatchObject({
      openIds: ['overview', 'terminal'],
      activeId: 'terminal'
    })
  })

  it('关闭最右侧激活 tab 时回退到左侧邻居', () => {
    const state = createRightSurfaceState({
      openIds: ['overview', 'agents'],
      activeId: 'agents'
    })

    expect(reduceRightSurfaceState(state, { type: 'close', kind: 'agents' })).toMatchObject({
      openIds: ['overview'],
      activeId: 'overview'
    })
  })

  it('关闭非激活 tab 不会改变当前 Surface', () => {
    const state = createRightSurfaceState({
      openIds: ['overview', 'diff', 'agents'],
      activeId: 'agents'
    })

    expect(reduceRightSurfaceState(state, { type: 'close', kind: 'diff' })).toMatchObject({
      openIds: ['overview', 'agents'],
      activeId: 'agents'
    })
  })

  it('关闭最后一个 tab 后进入空状态', () => {
    const state = createRightSurfaceState({ openIds: ['terminal'], activeId: 'terminal' })

    expect(reduceRightSurfaceState(state, { type: 'close', kind: 'terminal' })).toMatchObject({
      openIds: [],
      activeId: null,
      visible: true
    })
  })

  it('隐藏时退出最大化，重新显示保留已打开内容', () => {
    const state = createRightSurfaceState({
      openIds: ['overview', 'terminal'],
      activeId: 'terminal',
      maximized: true
    })
    const hidden = reduceRightSurfaceState(state, { type: 'hide' })
    const shown = reduceRightSurfaceState(hidden, { type: 'show' })

    expect(hidden).toMatchObject({ visible: false, maximized: false })
    expect(shown).toEqual({
      openIds: ['overview', 'terminal'],
      activeId: 'terminal',
      sideChats: [],
      activeSideChatId: null,
      visible: true,
      maximized: false
    })
  })

  it('只为有效操作创建新状态', () => {
    const state = createRightSurfaceState()

    expect(reduceRightSurfaceState(state, { type: 'activate', kind: 'agents' })).toBe(state)
    expect(reduceRightSurfaceState(state, { type: 'close', kind: 'agents' })).toBe(state)
    expect(reduceRightSurfaceState(state, { type: 'open', kind: 'overview' })).toBe(state)
  })
})

describe('right surface catalog', () => {
  it('完整且无重复地声明六种 Surface', () => {
    expect(RIGHT_SURFACE_DEFINITIONS.map((surface) => surface.kind)).toEqual([
      'overview',
      'files',
      'diff',
      'source-control',
      'terminal',
      'agents'
    ])
  })

  it('只渲染激活 Surface，同时保留后台终端和未保存文件', () => {
    const html = renderToStaticMarkup(createElement(RightSurfacePanel, {
      openIds: ['overview', 'files', 'terminal', 'agents'],
      activeId: 'overview',
      maximized: false,
      contents: {
        overview: createElement('span', null, 'overview-state'),
        files: createElement('span', null, 'files-state'),
        terminal: createElement('span', null, 'terminal-state'),
        agents: createElement('span', null, 'agents-state')
      },
      onOpen: () => {},
      onActivate: () => {},
      onClose: () => {},
      onHide: () => {},
      onToggleMaximized: () => {}
    }))

    expect(html).toContain('overview-state')
    expect(html).toContain('files-state')
    expect(html).toContain('terminal-state')
    expect(html).not.toContain('agents-state')
    expect(html).toMatch(/surface-content-terminal[^>]* hidden=""/)
  })
})

describe('terminal surface tabs', () => {
  it('只展示主进程的可操作错误，不暴露 Electron IPC 包装文案', () => {
    expect(terminalStartErrorMessage(new Error(
      "Error invoking remote method 'terminal:start': Error: 当前绑定的工作目录已不存在"
    ))).toBe('当前绑定的工作目录已不存在')
  })

  it('在查询主进程持有的 Shell 前不抢先启动新终端', () => {
    const html = renderToStaticMarkup(createElement(TerminalSurface, { cwd: '/repo', active: true }))

    expect(html).toContain('role="tablist"')
    expect(html).toContain('正在恢复终端')
    expect(html).toContain('正在检查仍由主进程持有的 Shell')
    expect(html).not.toContain('role="tabpanel"')
    expect(html).toContain('aria-label="回放终端录制"')
    expect(html).toContain('aria-label="删除终端录制"')
    expect(html).toContain('role="status"')
  })

  it('把运行中的主进程会话稳定映射为待接管 tab', () => {
    const sessions = [
      { id: 'terminal-one', pid: 1, cwd: '/repo', cols: 80, rows: 24 },
      { id: 'terminal-two', pid: 2, cwd: '/repo', cols: 120, rows: 40 }
    ]
    expect(terminalTabsForActiveSessions(sessions)).toEqual([
      { key: 'active-terminal-one', title: '终端 1', sessionId: 'terminal-one' },
      { key: 'active-terminal-two', title: '终端 2', sessionId: 'terminal-two' }
    ])
  })
})
