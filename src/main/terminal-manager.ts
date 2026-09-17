import { randomUUID } from 'node:crypto'
import { realpathSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { DirectTerminalRecordingBackend, type TerminalRecordingBackend } from './terminal-recording-backend'
import type {
  TerminalCloseRequest,
  TerminalDataEvent,
  TerminalExitEvent,
  TerminalResizeRequest,
  TerminalRecordingRequest,
  TerminalRecordingPage,
  TerminalRecordingListRequest,
  TerminalRecordingListPage,
  TerminalRecordingErrorEvent,
  TerminalSessionInfo,
  TerminalStartRequest,
  TerminalWriteRequest
} from '../shared/terminal'
import {
  TERMINAL_MAX_DIMENSION,
  TERMINAL_MAX_INPUT_BYTES,
  TERMINAL_MAX_SESSIONS
} from '../shared/terminal'

interface Disposable {
  dispose(): void
}

export interface TerminalPtyProcess {
  readonly pid: number
  onData(listener: (data: string) => void): Disposable
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): Disposable
  write(data: string): void
  pause(): void
  resume(): void
  resize(cols: number, rows: number): void
  kill(signal?: string): void
  /** node-pty runtime exposes destroy even though its public IPty type omits it. */
  destroy?(): void
}

export interface TerminalPtySpawnOptions {
  name: string
  cols: number
  rows: number
  cwd: string
  env: Record<string, string | undefined>
}

export interface TerminalPtyFactory {
  spawn(
    shell: string,
    args: string[],
    options: TerminalPtySpawnOptions
  ): TerminalPtyProcess
}

export interface TerminalManagerOptions {
  getCurrentCwd(): string | undefined
  defaultCwd: string
  onData(event: TerminalDataEvent): void
  onExit(event: TerminalExitEvent): void
  pty?: TerminalPtyFactory
  shell?: string
  args?: string[]
  env?: Record<string, string | undefined>
  closeGraceMs?: number
  recordingDirectory?: string
  recordingBackend?: TerminalRecordingBackend
  onRecordingError?(event: TerminalRecordingErrorEvent): void
}

interface ManagedTerminal {
  readonly id: string
  readonly pty: TerminalPtyProcess
  dataSubscription?: Disposable
  exitSubscription?: Disposable
  closing: boolean
  destroyed: boolean
  closeTimer?: ReturnType<typeof setTimeout>
  pauseReasons: Set<'renderer' | 'recording'>
}

const DEFAULT_CLOSE_GRACE_MS = 750

const require = createRequire(import.meta.url)

const defaultPtyFactory: TerminalPtyFactory = {
  spawn(shell, args, options) {
    const nodePty = require('node-pty') as TerminalPtyFactory
    return nodePty.spawn(shell, args, options)
  }
}

function assertId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || id.length === 0) throw new Error('终端 id 无效')
}

function assertDimensions(cols: unknown, rows: unknown): asserts cols is number {
  if (
    !Number.isSafeInteger(cols) ||
    !Number.isSafeInteger(rows) ||
    (cols as number) < 1 ||
    (rows as number) < 1 ||
    (cols as number) > TERMINAL_MAX_DIMENSION ||
    (rows as number) > TERMINAL_MAX_DIMENSION
  ) {
    throw new Error(`终端尺寸必须是 1-${TERMINAL_MAX_DIMENSION} 的整数`)
  }
}

function dispose(subscription: Disposable | undefined): void {
  try {
    subscription?.dispose()
  } catch {
    // A broken listener must not keep a dead PTY registered.
  }
}

function defaultShell(): string {
  if (process.platform === 'win32') return process.env.COMSPEC || 'cmd.exe'
  return process.env.SHELL || '/bin/zsh'
}

function defaultArgs(): string[] {
  return process.platform === 'win32' ? [] : ['-l']
}

function resolveTerminalDirectory(path: string, missingMessage: string): string {
  try {
    const resolved = realpathSync(path)
    if (!statSync(resolved).isDirectory()) throw new Error(missingMessage)
    return resolved
  } catch (error) {
    if (error instanceof Error && error.message === missingMessage) throw error
    const code = (error as NodeJS.ErrnoException)?.code
    if (code === 'ENOENT' || code === 'ENOTDIR') throw new Error(missingMessage)
    throw error
  }
}

export class TerminalManager {
  private readonly sessions = new Map<string, ManagedTerminal>()
  private readonly getCurrentCwd: () => string | undefined
  private readonly defaultCwd: string
  private readonly onData: (event: TerminalDataEvent) => void
  private readonly onExit: (event: TerminalExitEvent) => void
  private readonly pty: TerminalPtyFactory
  private readonly shell: string
  private readonly args: string[]
  private readonly env: Record<string, string | undefined>
  private readonly closeGraceMs: number
  private readonly recordings?: TerminalRecordingBackend
  private readonly onRecordingError: (event: TerminalRecordingErrorEvent) => void
  private readonly emptyWaiters: Array<() => void> = []

  constructor(options: TerminalManagerOptions) {
    this.onRecordingError = options.onRecordingError ?? (() => {})
    if (options.recordingDirectory && options.recordingBackend) throw new Error('终端录制后端配置冲突')
    this.recordings = options.recordingBackend ?? (options.recordingDirectory
      ? new DirectTerminalRecordingBackend(options.recordingDirectory, (id) => {
          this.onRecordingError({ id, message: '终端录制失败，已保存内容可能不完整；Shell 继续运行。' })
        })
      : undefined)
    this.getCurrentCwd = options.getCurrentCwd
    this.defaultCwd = options.defaultCwd
    this.onData = options.onData
    this.onExit = options.onExit
    this.pty = options.pty ?? defaultPtyFactory
    this.shell = options.shell ?? defaultShell()
    this.args = [...(options.args ?? defaultArgs())]
    this.env = { ...(options.env ?? process.env) }
    this.closeGraceMs = options.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS
    if (!this.shell) throw new Error('终端 shell 不能为空')
    if (!Number.isSafeInteger(this.closeGraceMs) || this.closeGraceMs < 0) throw new Error('终端关闭等待时间无效')
  }

  start(request: TerminalStartRequest): TerminalSessionInfo {
    if (!request || (request.cwd !== null && (typeof request.cwd !== 'string' || request.cwd.length === 0))) {
      throw new Error('终端 cwd 无效')
    }
    assertDimensions(request.cols, request.rows)
    if (this.sessions.size >= TERMINAL_MAX_SESSIONS) {
      throw new Error(`最多同时运行 ${TERMINAL_MAX_SESSIONS} 个终端`)
    }

    const boundCwd = this.getCurrentCwd()
    if ((request.cwd === null) !== !boundCwd) throw new Error('终端工作上下文已变化，请重试')
    const currentCwd = boundCwd
      ? resolveTerminalDirectory(
          boundCwd,
          '当前绑定的工作目录已不存在或不是文件夹，请重新绑定项目后再启动终端'
        )
      : resolveTerminalDirectory(
          this.defaultCwd,
          '用户主目录已不存在或不是文件夹，无法启动终端'
        )
    if (request.cwd !== null) {
      const requestedCwd = resolveTerminalDirectory(
        request.cwd,
        '终端工作目录不存在或不是文件夹'
      )
      if (requestedCwd !== currentCwd) throw new Error('终端只能在当前工作区启动')
    }
    const cwd = currentCwd

    const id = `terminal-${randomUUID()}`
    const pty = this.pty.spawn(this.shell, [...this.args], {
      name: 'xterm-256color',
      cols: request.cols,
      rows: request.rows,
      cwd,
      env: { ...this.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' }
    })
    const session: ManagedTerminal = { id, pty, closing: false, destroyed: false, pauseReasons: new Set() }
    this.sessions.set(id, session)
    const info: TerminalSessionInfo = { id, pid: pty.pid, cwd, cols: request.cols, rows: request.rows }
    if (this.recordings) {
      try {
        const startup = this.recordings.start(info)
        info.recording = 'available'
        void startup.catch(() => {
          this.onRecordingError({ id, message: '终端录制不可用；Shell 继续运行。' })
        })
      } catch {
        info.recording = 'unavailable'
        this.onRecordingError({ id, message: '终端录制不可用；Shell 继续运行。' })
      }
    }

    try {
      session.dataSubscription = pty.onData((data) => {
        if (this.sessions.get(id) === session) {
          this.recordings?.append(id, data)
          this.onData({ id, data })
        }
      })
      if (this.sessions.get(id) !== session) dispose(session.dataSubscription)

      session.exitSubscription = pty.onExit(({ exitCode, signal }) => {
        this.finish(session, exitCode ?? null, signal ?? null)
      })
      if (this.sessions.get(id) !== session) dispose(session.exitSubscription)
    } catch (error) {
      if (this.sessions.get(id) === session) this.sessions.delete(id)
      dispose(session.dataSubscription)
      dispose(session.exitSubscription)
      this.recordings?.finish({ id, code: null, signal: null })
      try {
        if (pty.destroy) pty.destroy()
        else pty.kill()
      } catch { /* best-effort rollback after listener setup failure */ }
      throw error
    }

    return info
  }

  async readRecording(request: TerminalRecordingRequest): Promise<TerminalRecordingPage> {
    if (!this.recordings) throw new Error('终端录制不可用')
    const cwd = resolveTerminalDirectory(this.getCurrentCwd() ?? this.defaultCwd, '当前工作目录不可用')
    return this.recordings.read(request, cwd)
  }

  async listRecordings(request: TerminalRecordingListRequest): Promise<TerminalRecordingListPage> {
    if (!this.recordings) throw new Error('终端录制不可用')
    const cwd = resolveTerminalDirectory(this.getCurrentCwd() ?? this.defaultCwd, '当前工作目录不可用')
    const page = await this.recordings.list(request, cwd)
    if (cwd !== resolveTerminalDirectory(this.getCurrentCwd() ?? this.defaultCwd, '当前工作目录不可用')) {
      throw new Error('terminal_recording_workspace_changed')
    }
    return { ...page, items: page.items.map((item) => ({ ...item, active: this.sessions.has(item.id) })) }
  }

  async deleteRecording(id: string): Promise<void> {
    if (this.sessions.has(id)) throw new Error('terminal_recording_still_active')
    if (!this.recordings) throw new Error('终端录制不可用')
    const cwd = resolveTerminalDirectory(this.getCurrentCwd() ?? this.defaultCwd, '当前工作目录不可用')
    await this.recordings.delete(id, cwd)
  }

  write(request: TerminalWriteRequest): void {
    assertId(request?.id)
    if (typeof request.data !== 'string') throw new Error('终端输入必须是字符串')
    if (Buffer.byteLength(request.data, 'utf8') > TERMINAL_MAX_INPUT_BYTES) {
      throw new Error(`单次终端输入不能超过 ${TERMINAL_MAX_INPUT_BYTES} 字节`)
    }
    this.active(request.id).pty.write(request.data)
  }

  // Main-owned flow control only; renderer and recording pressure cannot resume each other early.
  pauseOutput(id: string): void { this.setPause(id, 'renderer', true) }
  resumeOutput(id: string): void { this.setPause(id, 'renderer', false) }
  pauseRecording(id: string): void { this.setPause(id, 'recording', true) }
  resumeRecording(id: string): void { this.setPause(id, 'recording', false) }

  async settleRecordings(): Promise<void> { await this.recordings?.settle() }
  async closeRecordings(): Promise<void> { await this.recordings?.close() }
  async shutdown(): Promise<void> {
    let closeError: unknown
    try { this.closeAll() } catch (error) { closeError = error }
    if (this.sessions.size > 0) await new Promise<void>((resolve) => this.emptyWaiters.push(resolve))
    await this.recordings?.settle()
    await this.recordings?.close()
    if (closeError) throw closeError
  }


  resize(request: TerminalResizeRequest): void {
    assertId(request?.id)
    assertDimensions(request.cols, request.rows)
    this.active(request.id).pty.resize(request.cols, request.rows)
  }

  close(request: TerminalCloseRequest): void {
    assertId(request?.id)
    const session = this.sessions.get(request.id)
    if (!session || session.closing) return
    session.closing = true
    let destroyError: unknown
    try {
      this.destroyPty(session)
    } catch (error) {
      destroyError = error
    }
    if (this.sessions.get(session.id) === session) {
      session.closeTimer = setTimeout(() => {
        // Some node-pty builds fail to report an exit after their master has
        // closed. Release the in-memory session without claiming a process
        // exit code; destroy()/kill() already applied normal terminal-close
        // semantics to the PTY.
        this.finish(session, null, null)
      }, this.closeGraceMs)
    }
    if (destroyError) throw destroyError
  }

  closeAll(): void {
    let firstError: unknown
    for (const session of [...this.sessions.values()]) {
      try {
        this.close({ id: session.id })
      } catch (error) {
        firstError ??= error
      }
    }
    if (firstError) throw firstError
  }

  private setPause(id: string, reason: 'renderer' | 'recording', paused: boolean): void {
    const session = this.sessions.get(id)
    if (!session || session.closing) return
    const wasPaused = session.pauseReasons.size > 0
    if (paused) session.pauseReasons.add(reason)
    else session.pauseReasons.delete(reason)
    const isPaused = session.pauseReasons.size > 0
    if (!wasPaused && isPaused) session.pty.pause()
    else if (wasPaused && !isPaused) session.pty.resume()
  }

  private active(id: string): ManagedTerminal {
    const session = this.sessions.get(id)
    if (!session || session.closing) throw new Error('终端不存在或已退出')
    return session
  }

  private finish(session: ManagedTerminal, code: number | null, signal: number | null): void {
    if (this.sessions.get(session.id) !== session) return
    if (session.closeTimer) clearTimeout(session.closeTimer)
    this.sessions.delete(session.id)
    if (this.sessions.size === 0) for (const resolve of this.emptyWaiters.splice(0)) resolve()
    dispose(session.dataSubscription)
    dispose(session.exitSubscription)
    const event = { id: session.id, code, signal }
    this.recordings?.finish(event)
    this.onExit(event)
  }

  private destroyPty(session: ManagedTerminal): void {
    if (session.destroyed) return
    session.destroyed = true
    if (session.pty.destroy) {
      session.pty.destroy()
      return
    }
    session.pty.kill()
  }
}

export function createTerminalManager(options: TerminalManagerOptions): TerminalManager {
  return new TerminalManager(options)
}
