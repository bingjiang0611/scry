import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import type { ITheme } from '@xterm/xterm'
import { type TerminalExitEvent, type TerminalRecordingSummary, type TerminalSessionDescriptor } from '@shared/terminal'
import { Icon } from './primitives/Icon'
import { TerminalHistory } from './TerminalHistory'
import { replayTerminalRecording } from '../terminal-recording-replay'
import { defaultTerminalApi, type TerminalApi } from '../workbench-api'

type TerminalStatus = 'starting' | 'running' | 'exited' | 'error' | 'readonly'

interface TerminalTab {
  key: string
  title: string
  recordingId?: string
  sessionId?: string
}

interface TerminalControls {
  clear: () => void
  focus: () => void
  restart: () => void
  replay: () => void
  deleteRecording: () => void
  close: () => void
}

let terminalTabSequence = 0

function nextTerminalTab(titleNumber: number): TerminalTab {
  terminalTabSequence += 1
  return { key: `terminal-${terminalTabSequence}`, title: `终端 ${titleNumber}` }
}

export function terminalTabsForActiveSessions(sessions: TerminalSessionDescriptor[]): TerminalTab[] {
  return sessions.map((session, index) => ({
    key: `active-${session.id}`,
    title: `终端 ${index + 1}`,
    sessionId: session.id
  }))
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

export function exitText(event: TerminalExitEvent): string {
  if (event.signal != null && event.signal !== 0) return `Shell 已退出 · signal ${event.signal}`
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
  scopeId,
  active,
  onControls,
  onStatus,
  onRecordingMessage,
  recordingId,
  sessionId,
  api,
  machineLabel
}: {
  tabKey: string
  tabId: string
  panelId: string
  cwd: string | null
  scopeId?: string
  recordingId?: string
  sessionId?: string
  active: boolean
  onControls: (key: string, controls: TerminalControls | null) => void
  onStatus: (key: string, status: TerminalStatus) => void
  onRecordingMessage: (key: string, message: string | undefined) => void
  api: TerminalApi
  machineLabel: string
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const terminalIdRef = useRef<string | null>(null)
  const ownershipEpochRef = useRef<number | null>(null)
  const recordingIdRef = useRef<string | null>(null)
  const replayRef = useRef<Promise<void> | null>(null)
  const deletingRecordingRef = useRef(false)
  const explicitCloseRef = useRef(false)
  const startSequenceRef = useRef(0)
  const activeRef = useRef(active)
  const cwdRef = useRef(cwd)
  const [shellCwd, setShellCwd] = useState(cwd)
  cwdRef.current = cwd
  const [error, setError] = useState<string | null>(null)
  const [connectionError, setConnectionError] = useState<string | null>(null)
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
      const ownershipEpoch = ownershipEpochRef.current
      if (id && ownershipEpoch != null) void api.terminalResize(id, ownershipEpoch, terminal.cols, terminal.rows).catch(() => {})
    } catch {
      // A hidden or detaching pane can report a transient zero-sized viewport.
    }
  }, [api])

  const start = useCallback(async (): Promise<void> => {
    const terminal = terminalRef.current
    if (!terminal || recordingId) return
    explicitCloseRef.current = false
    const sequence = ++startSequenceRef.current
    await replayRef.current
    if (sequence !== startSequenceRef.current || terminalRef.current !== terminal) return
    recordingIdRef.current = null
    onRecordingMessage(tabKey, undefined)
    const previous = terminalIdRef.current
    const previousEpoch = ownershipEpochRef.current
    terminalIdRef.current = null
    ownershipEpochRef.current = null
    if (previous && previousEpoch != null) await api.terminalClose(previous, previousEpoch).catch(() => false)
    terminal.reset()
    setError(null)
    setExit(null)
    onStatus(tabKey, 'starting')
    terminal.writeln(`\x1b[38;5;244m正在启动 ${machineLabel} Shell…\x1b[0m`)
    requestAnimationFrame(resize)
    try {
      // Session navigation must not recreate xterm or restart this Shell. Only
      // an explicit start/restart reads the latest bound workspace, which main validates.
      const session = await api.terminalStart({
        cwd: cwdRef.current,
        scopeId,
        cols: Math.max(2, terminal.cols),
        rows: Math.max(1, terminal.rows)
      })
      if (sequence !== startSequenceRef.current) {
        if (explicitCloseRef.current) await api.terminalClose(session.id, session.ownershipEpoch).catch(() => false)
        else await api.terminalDetach?.(session.id, session.ownershipEpoch)
        return
      }
      terminal.reset()
      terminalIdRef.current = session.id
      ownershipEpochRef.current = session.ownershipEpoch
      recordingIdRef.current = session.id
      setShellCwd(session.cwd)
      if (session.recording === 'unavailable') onRecordingMessage(tabKey, '原文录制不可用；Shell 继续运行。')
      const owned = await api.terminalReady(session.id, session.ownershipEpoch)
      if (!owned || sequence !== startSequenceRef.current) return
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
  }, [api, onStatus, onRecordingMessage, resize, tabKey, recordingId, scopeId, machineLabel])

  const adopt = useCallback(async (): Promise<void> => {
    const terminal = terminalRef.current
    if (!terminal || !sessionId) return
    explicitCloseRef.current = false
    const sequence = ++startSequenceRef.current
    terminal.reset()
    setError(null)
    setExit(null)
    onStatus(tabKey, 'starting')
    terminal.writeln('\x1b[38;5;244m正在接管仍在运行的 Shell…\x1b[0m')
    try {
      const session = await api.terminalAttach(sessionId)
      if (sequence !== startSequenceRef.current || terminalRef.current !== terminal) {
        if (explicitCloseRef.current) await api.terminalClose(session.id, session.ownershipEpoch).catch(() => false)
        else await api.terminalDetach?.(session.id, session.ownershipEpoch)
        return
      }
      terminal.reset()
      terminalIdRef.current = session.id
      ownershipEpochRef.current = session.ownershipEpoch
      recordingIdRef.current = session.id
      setShellCwd(session.cwd)
      if (session.catchUp.state === 'unavailable') {
        onRecordingMessage(tabKey, '接管成功；此前屏幕原文不可回放，后续输出仍会继续显示。')
      } else if (session.catchUp.endOffset > 0) {
        onRecordingMessage(tabKey, '正在追赶断连期间的磁盘原文…')
        const current = () => sequence === startSequenceRef.current && terminalIdRef.current === session.id && ownershipEpochRef.current === session.ownershipEpoch
        replayRef.current = replayTerminalRecording(
          session.id,
          api.terminalRecordingRead,
          (text) => new Promise<void>((resolve) => terminal.write(text, resolve)),
          current,
          session.catchUp.endOffset
        ).then(() => undefined)
        await replayRef.current
        replayRef.current = null
        if (!current()) return
        onRecordingMessage(tabKey, session.catchUp.state === 'partial'
          ? '已接管 Shell；仅追赶到可确认落盘的部分原文。'
          : '已接管 Shell，并追赶到切换时的完整落盘原文。')
      }
      const owned = await api.terminalReady(session.id, session.ownershipEpoch)
      if (!owned || sequence !== startSequenceRef.current) return
      onStatus(tabKey, 'running')
      requestAnimationFrame(() => {
        resize()
        if (activeRef.current) terminal.focus()
      })
    } catch (adoptError) {
      if (sequence !== startSequenceRef.current) return
      const message = terminalStartErrorMessage(adoptError)
      setError(message)
      onStatus(tabKey, 'error')
      terminal.reset()
      terminal.writeln(`\x1b[31m终端接管失败：${message}\x1b[0m`)
    } finally {
      replayRef.current = null
    }
  }, [api, onStatus, onRecordingMessage, resize, sessionId, tabKey])

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
      const ownershipEpoch = ownershipEpochRef.current
      if (id && ownershipEpoch != null) void api.terminalWrite(id, ownershipEpoch, data).catch((reason) => setError(`终端输入结果未确认，请勿自动重发：${String(reason)}`))
    })
    const offConnection = api.onTerminalConnectionError?.(setConnectionError)
    const offData = api.onTerminalData((event) => {
      if (event.id !== terminalIdRef.current || event.ownershipEpoch !== ownershipEpochRef.current) return
      const bytes = new TextEncoder().encode(event.data).byteLength
      terminal.write(event.data, () => {
        void api.terminalAck(event.id, event.ownershipEpoch, bytes).catch((reason) => setConnectionError(`终端输出确认未完成：${String(reason)}`))
      })
    })
    const offRecordingError = api.onTerminalRecordingError((event) => {
      if (event.id === terminalIdRef.current) onRecordingMessage(tabKey, event.message)
    })
    const offExit = api.onTerminalExit((event) => {
      if (event.id !== terminalIdRef.current || event.ownershipEpoch !== ownershipEpochRef.current) return
      terminalIdRef.current = null
      ownershipEpochRef.current = null
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
        replayRef.current = replayTerminalRecording(id, api.terminalRecordingRead,
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
          await api.terminalRecordingDelete(id)
          if (sequence !== startSequenceRef.current) return
          recordingIdRef.current = null
          onRecordingMessage(tabKey, '磁盘录制已删除；当前屏幕内容不受影响。')
        })().catch((error) => {
          if (sequence === startSequenceRef.current) onRecordingMessage(tabKey, `删除失败：${terminalStartErrorMessage(error)}`)
        }).finally(() => { deletingRecordingRef.current = false })
      },
      close: () => {
        explicitCloseRef.current = true
        startSequenceRef.current += 1
        const id = terminalIdRef.current
        const ownershipEpoch = ownershipEpochRef.current
        terminalIdRef.current = null
        ownershipEpochRef.current = null
        if (id && ownershipEpoch != null) void api.terminalClose(id, ownershipEpoch).catch(() => false)
      }
    }
    onControls(tabKey, paneControls)
    if (recordingId) {
      recordingIdRef.current = recordingId
      onStatus(tabKey, 'readonly')
      resize()
      paneControls.replay()
    } else if (sessionId) {
      void adopt()
    } else {
      void start()
    }

    return () => {
      startSequenceRef.current += 1
      observer.disconnect()
      offData()
      offExit()
      offRecordingError()
      offConnection?.()
      input.dispose()
      onControls(tabKey, null)
      if (terminalIdRef.current && ownershipEpochRef.current != null) {
        void api.terminalDetach?.(terminalIdRef.current, ownershipEpochRef.current).catch((reason) => console.warn('远程终端分离结果未确认', reason))
      }
      terminalIdRef.current = null
      ownershipEpochRef.current = null
      terminal.dispose()
      terminalRef.current = null
      fitRef.current = null
    }
  }, [api, adopt, onControls, onStatus, onRecordingMessage, resize, sessionId, start, tabKey, recordingId])

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
        aria-label={recordingId ? `终端录制，只读 ${recordingId}` : shellCwd ? `终端，启动目录 ${shellCwd}` : '终端，未绑定项目，初始目录为用户主目录'}
      />
      {(error || connectionError) && <div className="workspace-error" role="alert">{error ?? connectionError}</div>}
      {!recordingId && (error || exit) && (
        <button type="button" className="terminal-restart" onClick={() => void start()}>
          <Icon name="refresh" /> 重新启动
        </button>
      )}
    </div>
  )
}

export function TerminalSurface({ cwd, active, scopeId, api: injectedApi, machineLabel = '本机' }: { cwd: string | null; active: boolean; scopeId?: string; api?: TerminalApi; machineLabel?: string }) {
  const rootId = useId().replaceAll(':', '')
  const api = useMemo(() => injectedApi ?? defaultTerminalApi, [injectedApi])
  const [tabs, setTabs] = useState<TerminalTab[]>([])
  const [activeKey, setActiveKey] = useState('')
  const [hydrated, setHydrated] = useState(false)
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

  useEffect(() => {
    // After reload, hidden workbenches must neither steal focus nor spawn shells
    // before their workspace has been selected. Mounted shells keep consuming output.
    if (hydrated || !active) return
    let current = true
    void api.terminalActive().then((sessions) => {
      if (!current) return
      const restored = terminalTabsForActiveSessions(sessions.filter((session) => session.scopeId === scopeId))
      const initial = restored.length > 0 ? restored : [nextTerminalTab(1)]
      nextTitleNumber.current = initial.length + 1
      setTabs(initial)
      setActiveKey(initial[0].key)
      setHydrated(true)
    }).catch((error) => {
      if (!current) return
      const initial = nextTerminalTab(1)
      setTabs([initial])
      setActiveKey(initial.key)
      setRecordingMessages({ [initial.key]: `无法查询运行中的 Shell：${terminalStartErrorMessage(error)}` })
      setHydrated(true)
    })
    return () => { current = false }
  }, [active, api, hydrated, scopeId])

  const openRecording = (item: TerminalRecordingSummary): void => {
    if (item.active) return
    const existing = tabs.find((tab) => tab.recordingId === item.id)
    if (existing) setActiveKey(existing.key)
    else {
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
    const tab = nextTerminalTab(nextTitleNumber.current++)
    setTabs((current) => [...current, tab])
    setActiveKey(tab.key)
  }
  const closeTab = (key: string): void => {
    const index = tabs.findIndex((tab) => tab.key === key)
    controls.current.get(key)?.close()
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
    <section className="terminal-surface" aria-label={`${machineLabel}终端`}>
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
          <button ref={addButtonRef} type="button" className="terminal-action" onClick={addTab} disabled={!hydrated} title="新建终端" aria-label="新建终端">
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
        {!hydrated ? (
          <div className="terminal-empty">
            <Icon name="terminal" lg />
            <strong>正在恢复终端…</strong>
            <span>正在检查仍由主进程持有的 Shell。</span>
          </div>
        ) : tabs.length === 0 ? (
          <div className="terminal-empty">
            <Icon name="terminal" lg />
            <strong>没有打开的终端</strong>
            <span>终端以 {machineLabel} 上的当前 macOS 用户权限运行；未绑定项目时从用户主目录启动。</span>
            <button type="button" className="btn" onClick={addTab}>启动终端</button>
          </div>
        ) : tabs.map((tab) => (
          <TerminalPane
            key={tab.key}
            tabKey={tab.key}
            tabId={`${rootId}-${tab.key}-tab`}
            panelId={`${rootId}-${tab.key}-panel`}
            cwd={cwd}
            scopeId={scopeId}
            recordingId={tab.recordingId}
            sessionId={tab.sessionId}
            active={active && activeKey === tab.key}
            onControls={registerControls}
            onStatus={setStatus}
            onRecordingMessage={onRecordingMessage}
            api={api}
            machineLabel={machineLabel}
          />
        ))}
      </div>
      {historyOpen && <TerminalHistory key={cwd ?? '~'} cwd={cwd} canOpen onOpen={openRecording} onClose={() => setHistoryOpen(false)} api={api} />}
      <footer className="terminal-foot" role="status">{recordingMessages[activeKey] ?? `${machineLabel} Shell · 当前用户权限 · 原文录制（可能含密钥）`}</footer>
    </section>
  )
}
