import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import type { ITheme } from '@xterm/xterm'
import { TERMINAL_MAX_SESSIONS, type TerminalExitEvent, type TerminalRecordingSummary } from '@shared/terminal'
import { Icon } from './primitives/Icon'
import { TerminalHistory } from './TerminalHistory'
import { replayTerminalRecording } from '../terminal-recording-replay'

type TerminalStatus = 'starting' | 'running' | 'exited' | 'error' | 'readonly'

interface TerminalTab {
  key: string
  title: string
  recordingId?: string
}

interface TerminalControls {
  clear: () => void
  focus: () => void
  restart: () => void
  replay: () => void
  deleteRecording: () => void
}

let terminalTabSequence = 0

function nextTerminalTab(titleNumber: number): TerminalTab {
  terminalTabSequence += 1
  return { key: `terminal-${terminalTabSequence}`, title: `终端 ${titleNumber}` }
}

function xtermTheme(): ITheme {
  return {
    background: '#090b0e',
    foreground: '#eceef2',
    cursor: '#d9dde5',
    cursorAccent: '#090b0e',
    selectionBackground: '#2e5f725c',
    black: '#15191f',
    red: '#ef767a',
    green: '#7ed9a0',
    yellow: '#d9b86c',
    blue: '#79b8d1',
    magenta: '#c395d8',
    cyan: '#70c9cf',
    white: '#d9dde5',
    brightBlack: '#68707d',
    brightRed: '#ff9396',
    brightGreen: '#9be7b6',
    brightYellow: '#e6cb8a',
    brightBlue: '#98cce0',
    brightMagenta: '#d5afe5',
    brightCyan: '#91dce0',
    brightWhite: '#ffffff'
  }
}

function exitText(event: TerminalExitEvent): string {
  if (event.signal != null) return `Shell 已退出 · signal ${event.signal}`
  return event.code == null ? 'Shell 已退出' : `Shell 已退出 · code ${event.code}`
}

export function terminalStartErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '')
}

function TerminalPane({
  tabKey,
  tabId,
  panelId,
  cwd,
  active,
  onControls,
  onStatus,
  onRecordingMessage,
  recordingId
}: {
  tabKey: string
  tabId: string
  panelId: string
  cwd: string | null
  recordingId?: string
  active: boolean
  onControls: (key: string, controls: TerminalControls | null) => void
  onStatus: (key: string, status: TerminalStatus) => void
  onRecordingMessage: (key: string, message: string | undefined) => void
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const terminalIdRef = useRef<string | null>(null)
  const recordingIdRef = useRef<string | null>(null)
  const replayRef = useRef<Promise<void> | null>(null)
  const deletingRecordingRef = useRef(false)
  const startSequenceRef = useRef(0)
  const activeRef = useRef(active)
  const [error, setError] = useState<string | null>(null)
  const [exit, setExit] = useState<TerminalExitEvent | null>(null)
  activeRef.current = active

  const resize = useCallback((): void => {
    const terminal = terminalRef.current
    const fit = fitRef.current
    const host = hostRef.current
    if (!terminal || !fit || !host || !activeRef.current || host.clientWidth < 1 || host.clientHeight < 1) return
    try {
      fit.fit()
      const id = terminalIdRef.current
      if (id) void window.scry.terminalResize(id, terminal.cols, terminal.rows).catch(() => {})
    } catch {
      // A hidden or detaching pane can report a transient zero-sized viewport.
    }
  }, [])

  const start = useCallback(async (): Promise<void> => {
    const terminal = terminalRef.current
    if (!terminal || recordingId) return
    const sequence = ++startSequenceRef.current
    await replayRef.current
    if (sequence !== startSequenceRef.current || terminalRef.current !== terminal) return
    recordingIdRef.current = null
    onRecordingMessage(tabKey, undefined)
    const previous = terminalIdRef.current
    terminalIdRef.current = null
    if (previous) await window.scry.terminalClose(previous).catch(() => false)
    terminal.reset()
    setError(null)
    setExit(null)
    onStatus(tabKey, 'starting')
    terminal.writeln('\x1b[38;5;244m正在启动本机 Shell…\x1b[0m')
    requestAnimationFrame(resize)
    try {
      const session = await window.scry.terminalStart({
        cwd,
        cols: Math.max(2, terminal.cols),
        rows: Math.max(1, terminal.rows)
      })
      if (sequence !== startSequenceRef.current) {
        await window.scry.terminalClose(session.id).catch(() => false)
        return
      }
      terminal.reset()
      terminalIdRef.current = session.id
      recordingIdRef.current = session.id
      if (session.recording === 'unavailable') onRecordingMessage(tabKey, '原文录制不可用；Shell 继续运行。')
      await window.scry.terminalReady(session.id)
      onStatus(tabKey, 'running')
      requestAnimationFrame(() => {
        resize()
        if (activeRef.current) terminal.focus()
      })
    } catch (startError) {
      if (sequence !== startSequenceRef.current) return
      const message = terminalStartErrorMessage(startError)
      setError(message)
      onStatus(tabKey, 'error')
      terminal.reset()
      terminal.writeln(`\x1b[31m终端启动失败：${message}\x1b[0m`)
    }
  }, [cwd, onStatus, onRecordingMessage, resize, tabKey, recordingId])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const terminal = new Terminal({
      allowProposedApi: false,
      convertEol: false,
      cursorBlink: !recordingId,
      disableStdin: Boolean(recordingId),
      cursorStyle: 'bar',
      fontFamily: '"SFMono-Regular", "SF Mono", Menlo, Consolas, monospace',
      fontSize: 12,
      lineHeight: 1.35,
      scrollback: 5_000,
      theme: xtermTheme()
    })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(host)
    terminalRef.current = terminal
    fitRef.current = fit

    const input = terminal.onData((data) => {
      const id = terminalIdRef.current
      if (id) void window.scry.terminalWrite(id, data).catch(() => {})
    })
    const offData = window.scry.onTerminalData((event) => {
      if (event.id !== terminalIdRef.current) return
      const bytes = new TextEncoder().encode(event.data).byteLength
      terminal.write(event.data, () => {
        void window.scry.terminalAck(event.id, bytes).catch(() => {})
      })
    })
    const offRecordingError = window.scry.onTerminalRecordingError((event) => {
      if (event.id === terminalIdRef.current) onRecordingMessage(tabKey, event.message)
    })
    const offExit = window.scry.onTerminalExit((event) => {
      if (event.id !== terminalIdRef.current) return
      terminalIdRef.current = null
      setExit(event)
      onStatus(tabKey, 'exited')
      terminal.writeln(`\r\n\x1b[38;5;244m${exitText(event)}\x1b[0m`)
    })
    const observer = new ResizeObserver(() => resize())
    observer.observe(host)
    const paneControls: TerminalControls = {
      clear: () => terminal.clear(),
      focus: () => terminal.focus(),
      restart: () => void start(),
      replay: () => {
        const id = recordingIdRef.current
        if (!id || terminalIdRef.current || replayRef.current || deletingRecordingRef.current) return
        const sequence = ++startSequenceRef.current
        terminal.reset()
        onRecordingMessage(tabKey, '正在从磁盘回放原文…')
        const current = () => sequence === startSequenceRef.current
        replayRef.current = replayTerminalRecording(id, window.scry.terminalRecordingRead,
          (text) => new Promise<void>((resolve) => terminal.write(text, resolve)), current)
          .then((page) => {
            if (!current() || !page) return
            onRecordingMessage(tabKey, page.state === 'complete'
              ? '录制回放完成 · 只读 · 显示保留最近 5000 行'
              : '录制不完整，仅回放已确认落盘的内容。')
          })
          .catch((error) => { if (current()) onRecordingMessage(tabKey, `回放失败：${terminalStartErrorMessage(error)}`) })
          .finally(() => { replayRef.current = null })
      },
      deleteRecording: () => {
        const id = recordingIdRef.current
        if (!id || terminalIdRef.current || deletingRecordingRef.current) return
        deletingRecordingRef.current = true
        const sequence = ++startSequenceRef.current
        void (async () => {
          await replayRef.current
          if (sequence !== startSequenceRef.current) return
          await window.scry.terminalRecordingDelete(id)
          if (sequence !== startSequenceRef.current) return
          recordingIdRef.current = null
          onRecordingMessage(tabKey, '磁盘录制已删除；当前屏幕内容不受影响。')
        })().catch((error) => {
          if (sequence === startSequenceRef.current) onRecordingMessage(tabKey, `删除失败：${terminalStartErrorMessage(error)}`)
        }).finally(() => { deletingRecordingRef.current = false })
      }
    }
    onControls(tabKey, paneControls)
    if (recordingId) {
      recordingIdRef.current = recordingId
      onStatus(tabKey, 'readonly')
      resize()
      paneControls.replay()
    } else {
      void start()
    }

    return () => {
      startSequenceRef.current += 1
      observer.disconnect()
      offData()
      offExit()
      offRecordingError()
      input.dispose()
      onControls(tabKey, null)
      const id = terminalIdRef.current
      terminalIdRef.current = null
      if (id) void window.scry.terminalClose(id).catch(() => false)
      terminal.dispose()
      terminalRef.current = null
      fitRef.current = null
    }
  }, [onControls, onStatus, onRecordingMessage, resize, start, tabKey, recordingId])

  useEffect(() => {
    if (!active) return
    requestAnimationFrame(() => {
      resize()
      terminalRef.current?.focus()
    })
  }, [active, resize])

  return (
    <div
      id={panelId}
      className="terminal-pane"
      role="tabpanel"
      aria-labelledby={tabId}
      tabIndex={0}
      hidden={!active}
    >
      <div
        ref={hostRef}
        className="terminal-xterm"
        aria-label={recordingId ? `终端录制，只读 ${recordingId}` : cwd ? `终端，工作目录 ${cwd}` : '终端，未绑定项目，初始目录为用户主目录'}
      />
      {!recordingId && (error || exit) && (
        <button type="button" className="terminal-restart" onClick={() => void start()}>
          <Icon name="refresh" /> 重新启动
        </button>
      )}
    </div>
  )
}

export function TerminalSurface({ cwd, active }: { cwd: string | null; active: boolean }) {
  const rootId = useId().replaceAll(':', '')
  const [tabs, setTabs] = useState<TerminalTab[]>(() => [nextTerminalTab(1)])
  const [activeKey, setActiveKey] = useState(() => tabs[0].key)
  const [statuses, setStatuses] = useState<Record<string, TerminalStatus>>({})
  const [recordingMessages, setRecordingMessages] = useState<Record<string, string | undefined>>({})
  const onRecordingMessage = useCallback((key: string, message: string | undefined): void => {
    setRecordingMessages((current) => ({ ...current, [key]: message }))
  }, [])
  const controls = useRef(new Map<string, TerminalControls>())
  const tabRefs = useRef(new Map<string, HTMLButtonElement>())
  const addButtonRef = useRef<HTMLButtonElement>(null)
  const pendingCloseFocusRef = useRef<{ targetKey: string | null } | null>(null)
  const nextTitleNumber = useRef(2)
  const [historyOpen, setHistoryOpen] = useState(false)
  const openRecording = (item: TerminalRecordingSummary): void => {
    if (item.active) return
    const existing = tabs.find((tab) => tab.recordingId === item.id)
    if (existing) setActiveKey(existing.key)
    else {
      if (tabs.length >= TERMINAL_MAX_SESSIONS) return
      const tab = { key: `recording-${item.id}`, title: `录制 ${item.id.slice(9, 17)}`, recordingId: item.id }
      setTabs((current) => [...current, tab])
      setActiveKey(tab.key)
    }
    setHistoryOpen(false)
  }

  const registerControls = useCallback((key: string, value: TerminalControls | null): void => {
    if (value) controls.current.set(key, value)
    else controls.current.delete(key)
  }, [])
  const setStatus = useCallback((key: string, status: TerminalStatus): void => {
    setStatuses((current) => ({ ...current, [key]: status }))
  }, [])

  const addTab = (): void => {
    if (tabs.length >= TERMINAL_MAX_SESSIONS) return
    const tab = nextTerminalTab(nextTitleNumber.current++)
    setTabs((current) => [...current, tab])
    setActiveKey(tab.key)
  }
  const closeTab = (key: string): void => {
    const index = tabs.findIndex((tab) => tab.key === key)
    if (index < 0) return
    const next = tabs.filter((tab) => tab.key !== key)
    const targetKey = key === activeKey
      ? next[Math.min(index, next.length - 1)]?.key ?? null
      : activeKey || null
    pendingCloseFocusRef.current = { targetKey }
    setTabs(next)
    setRecordingMessages((current) => {
      const next = { ...current }
      delete next[key]
      return next
    })
    if (key === activeKey) setActiveKey(targetKey ?? '')
    setStatuses((current) => {
      const next = { ...current }
      delete next[key]
      return next
    })
  }

  useEffect(() => {
    const pending = pendingCloseFocusRef.current
    if (!pending) return
    pendingCloseFocusRef.current = null
    if (pending.targetKey) {
      tabRefs.current.get(pending.targetKey)?.focus()
      return
    }
    addButtonRef.current?.focus()
  }, [tabs])

  const activateAndFocusTab = (key: string): void => {
    setActiveKey(key)
    tabRefs.current.get(key)?.focus()
  }

  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, key: string): void => {
    if (tabs.length < 1) return
    const index = tabs.findIndex((tab) => tab.key === key)
    let target: TerminalTab | undefined
    if (event.key === 'ArrowLeft') target = tabs[(index - 1 + tabs.length) % tabs.length]
    if (event.key === 'ArrowRight') target = tabs[(index + 1) % tabs.length]
    if (event.key === 'Home') target = tabs[0]
    if (event.key === 'End') target = tabs[tabs.length - 1]
    if (!target) return
    event.preventDefault()
    activateAndFocusTab(target.key)
  }

  const activeControls = controls.current.get(activeKey)
  const canReplay = statuses[activeKey] === 'exited' || statuses[activeKey] === 'readonly'
  return (
    <section className="terminal-surface" aria-label="本机终端">
      <div className="terminal-toolbar">
        <div className="terminal-tabs" role="tablist" aria-label="终端会话">
          {tabs.map((tab) => (
            <div className={`terminal-tab ${activeKey === tab.key ? 'active' : ''}`} role="presentation" key={tab.key}>
              <button
                ref={(node) => {
                  if (node) tabRefs.current.set(tab.key, node)
                  else tabRefs.current.delete(tab.key)
                }}
                id={`${rootId}-${tab.key}-tab`}
                type="button"
                role="tab"
                aria-selected={activeKey === tab.key}
                aria-controls={`${rootId}-${tab.key}-panel`}
                tabIndex={activeKey === tab.key ? 0 : -1}
                onClick={() => setActiveKey(tab.key)}
                onKeyDown={(event) => onTabKeyDown(event, tab.key)}
              >
                <Icon name="terminal" />
                <span>{tab.title}</span>
                <i className={`terminal-state ${statuses[tab.key] ?? 'starting'}`} aria-hidden="true" />
              </button>
              <button type="button" className="terminal-tab-close" onClick={() => closeTab(tab.key)} aria-label={`关闭 ${tab.title}`}>
                <Icon name="x" />
              </button>
            </div>
          ))}
          <button ref={addButtonRef} type="button" className="terminal-action" onClick={addTab} disabled={tabs.length >= TERMINAL_MAX_SESSIONS} title="新建终端" aria-label="新建终端">
            <Icon name="plus" />
          </button>
        </div>
        <div className="terminal-actions">
          <button type="button" className="terminal-action" onClick={() => setHistoryOpen(true)} title="当前工作区的磁盘录制" aria-label="终端录制历史"><Icon name="archive" /></button>
          <button type="button" className="terminal-action" onClick={() => activeControls?.replay()} disabled={!canReplay} title="Shell 退出后回放录制（只读）" aria-label="回放终端录制">
            <Icon name="undo" />
          </button>
          <button type="button" className="terminal-action" onClick={() => activeControls?.deleteRecording()} disabled={!canReplay} title="Shell 退出后删除磁盘录制（不清屏）" aria-label="删除终端录制">
            <Icon name="trash" />
          </button>
          <button type="button" className="terminal-action" onClick={() => activeControls?.restart()} disabled={!activeControls || !!tabs.find((tab) => tab.key === activeKey)?.recordingId} title="重新启动终端" aria-label="重新启动终端">
            <Icon name="refresh" />
          </button>
          <button type="button" className="terminal-action" onClick={() => activeControls?.clear()} disabled={!activeControls} title="清空显示（不影响 Shell 或磁盘录制）" aria-label="清空终端显示">
            <Icon name="x" />
          </button>
        </div>
      </div>

      <div className="terminal-stage">
        {tabs.length === 0 ? (
          <div className="terminal-empty">
            <Icon name="terminal" lg />
            <strong>没有打开的终端</strong>
            <span>终端以当前 macOS 用户权限运行；未绑定项目时从用户主目录启动。</span>
            <button type="button" className="btn" onClick={addTab}>启动终端</button>
          </div>
        ) : tabs.map((tab) => (
          <TerminalPane
            key={`${cwd ?? '~'}:${tab.key}`}
            tabKey={tab.key}
            tabId={`${rootId}-${tab.key}-tab`}
            panelId={`${rootId}-${tab.key}-panel`}
            cwd={cwd}
            recordingId={tab.recordingId}
            active={active && activeKey === tab.key}
            onControls={registerControls}
            onStatus={setStatus}
            onRecordingMessage={onRecordingMessage}
          />
        ))}
      </div>
      {historyOpen && <TerminalHistory key={cwd ?? '~'} cwd={cwd} canOpen={tabs.length < TERMINAL_MAX_SESSIONS} onOpen={openRecording} onClose={() => setHistoryOpen(false)} />}
      <footer className="terminal-foot" role="status">{recordingMessages[activeKey] ?? '本机 Shell · 当前用户权限 · 原文录制（可能含密钥）'}</footer>
    </section>
  )
}
