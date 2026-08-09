import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  TERMINAL_MAX_DIMENSION,
  TERMINAL_MAX_INPUT_BYTES,
  TERMINAL_MAX_SESSIONS,
  type TerminalDataEvent,
  type TerminalExitEvent
} from '../shared/terminal'
import {
  createTerminalManager,
  type TerminalPtyFactory,
  type TerminalPtyProcess,
  type TerminalPtySpawnOptions
} from './terminal-manager'

class FakePty implements TerminalPtyProcess {
  readonly pid: number
  readonly writes: string[] = []
  readonly resizes: Array<[number, number]> = []
  killError?: Error
  killCount = 0
  destroyError?: Error
  destroyCount = 0
  private dataListener?: (data: string) => void
  private exitListener?: (event: { exitCode: number; signal?: number }) => void

  constructor(pid: number) {
    this.pid = pid
  }

  onData(listener: (data: string) => void) {
    this.dataListener = listener
    return { dispose: () => { this.dataListener = undefined } }
  }

  onExit(listener: (event: { exitCode: number; signal?: number }) => void) {
    this.exitListener = listener
    return { dispose: () => { this.exitListener = undefined } }
  }

  write(data: string): void {
    this.writes.push(data)
  }

  resize(cols: number, rows: number): void {
    this.resizes.push([cols, rows])
  }

  kill(): void {
    this.killCount += 1
    if (this.killError) throw this.killError
  }

  destroy(): void {
    this.destroyCount += 1
    if (this.destroyError) throw this.destroyError
  }

  emitData(data: string): void {
    this.dataListener?.(data)
  }

  emitExit(exitCode: number, signal?: number): void {
    this.exitListener?.({ exitCode, signal })
  }
}

class FakePtyFactory implements TerminalPtyFactory {
  readonly processes: FakePty[] = []
  readonly calls: Array<{ shell: string; args: string[]; options: TerminalPtySpawnOptions }> = []

  spawn(shell: string, args: string[], options: TerminalPtySpawnOptions): FakePty {
    this.calls.push({ shell, args, options })
    const process = new FakePty(1_000 + this.processes.length)
    this.processes.push(process)
    return process
  }
}

const roots: string[] = []

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'scry-terminal-manager-'))
  roots.push(root)
  return realpathSync(root)
}

function fixture(cwd: string, defaultCwd = cwd) {
  const pty = new FakePtyFactory()
  const data: TerminalDataEvent[] = []
  const exits: TerminalExitEvent[] = []
  const manager = createTerminalManager({
    getCurrentCwd: () => cwd,
    defaultCwd,
    onData: (event) => data.push(event),
    onExit: (event) => exits.push(event),
    pty,
    shell: '/test/shell',
    args: ['--login'],
    env: { PATH: '/test/bin', SECRET: 'main-owned' },
    closeGraceMs: 25
  })
  return { manager, pty, data, exits }
}

afterEach(() => {
  vi.useRealTimers()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('TerminalManager', () => {
  it('在当前 cwd 的 realpath 启动 main 控制的 PTY，并转发 data/exit', () => {
    const cwd = workspace()
    const alias = `${cwd}-alias`
    roots.push(alias)
    symlinkSync(cwd, alias)
    const { manager, pty, data, exits } = fixture(cwd)

    const session = manager.start({ cwd: alias, cols: 120, rows: 32 })
    expect(session).toEqual({ id: expect.any(String), pid: 1_000, cwd, cols: 120, rows: 32 })
    expect(pty.calls[0]).toEqual({
      shell: '/test/shell',
      args: ['--login'],
      options: {
        name: 'xterm-256color',
        cols: 120,
        rows: 32,
        cwd,
        env: {
          PATH: '/test/bin',
          SECRET: 'main-owned',
          TERM: 'xterm-256color',
          COLORTERM: 'truecolor'
        }
      }
    })

    pty.processes[0].emitData('hello\r\n')
    pty.processes[0].emitExit(7, 15)
    pty.processes[0].emitData('ignored')
    pty.processes[0].emitExit(8)
    expect(data).toEqual([{ id: session.id, data: 'hello\r\n' }])
    expect(exits).toEqual([{ id: session.id, code: 7, signal: 15 }])
  })

  it('拒绝不是当前工作区的 cwd', () => {
    const current = workspace()
    const other = workspace()
    const { manager, pty } = fixture(current)

    expect(() => manager.start({ cwd: other, cols: 80, rows: 24 })).toThrow('当前工作区')
    expect(pty.calls).toHaveLength(0)
  })

  it('当前绑定的历史工作目录已删除时返回可操作错误', () => {
    const cwd = workspace()
    const defaultCwd = workspace()
    const { manager, pty } = fixture(cwd, defaultCwd)
    rmSync(cwd, { recursive: true, force: true })

    expect(() => manager.start({ cwd, cols: 80, rows: 24 })).toThrow(
      '当前绑定的工作目录已不存在或不是文件夹，请重新绑定项目后再启动终端'
    )
    expect(pty.calls).toHaveLength(0)
  })

  it('拒绝不存在或不是文件夹的终端 cwd', () => {
    const cwd = workspace()
    const missing = join(cwd, 'missing')
    const file = join(cwd, 'file.txt')
    writeFileSync(file, 'not a directory')
    const { manager, pty } = fixture(cwd)

    expect(() => manager.start({ cwd: missing, cols: 80, rows: 24 })).toThrow('终端工作目录不存在或不是文件夹')
    expect(() => manager.start({ cwd: file, cols: 80, rows: 24 })).toThrow('终端工作目录不存在或不是文件夹')
    expect(pty.calls).toHaveLength(0)
  })

  it('未绑定工作区时只在 main 指定的用户主目录启动', () => {
    const defaultCwd = workspace()
    const other = workspace()
    const pty = new FakePtyFactory()
    const manager = createTerminalManager({
      getCurrentCwd: () => undefined,
      defaultCwd,
      onData: () => {},
      onExit: () => {},
      pty
    })

    const session = manager.start({ cwd: null, cols: 80, rows: 24 })
    expect(session.cwd).toBe(defaultCwd)
    expect(pty.calls[0].options.cwd).toBe(defaultCwd)
    expect(() => manager.start({ cwd: other, cols: 80, rows: 24 })).toThrow('工作上下文已变化')
    expect(pty.calls).toHaveLength(1)
  })

  it('绑定状态在 Shell 环境初始化期间变化时拒绝迟到的启动请求', () => {
    const cwd = workspace()
    const pty = new FakePtyFactory()
    const manager = createTerminalManager({
      getCurrentCwd: () => cwd,
      defaultCwd: workspace(),
      onData: () => {},
      onExit: () => {},
      pty
    })

    expect(() => manager.start({ cwd: null, cols: 80, rows: 24 })).toThrow('工作上下文已变化')
    expect(pty.calls).toHaveLength(0)
  })

  it('用户主目录不可用时返回可操作错误且不回退其他目录', () => {
    const defaultCwd = workspace()
    const pty = new FakePtyFactory()
    const manager = createTerminalManager({
      getCurrentCwd: () => undefined,
      defaultCwd,
      onData: () => {},
      onExit: () => {},
      pty
    })
    rmSync(defaultCwd, { recursive: true, force: true })

    expect(() => manager.start({ cwd: null, cols: 80, rows: 24 })).toThrow(
      '用户主目录已不存在或不是文件夹，无法启动终端'
    )
    expect(pty.calls).toHaveLength(0)
  })

  it.each([
    [0, 24],
    [80, 0],
    [1.5, 24],
    [80, Number.NaN],
    [TERMINAL_MAX_DIMENSION + 1, 24]
  ])('拒绝无效尺寸 cols=%s rows=%s', (cols, rows) => {
    const cwd = workspace()
    const { manager } = fixture(cwd)
    expect(() => manager.start({ cwd, cols, rows })).toThrow('终端尺寸')
  })

  it('限制为八个活跃会话，退出后释放名额', () => {
    const cwd = workspace()
    const { manager, pty } = fixture(cwd)
    for (let index = 0; index < TERMINAL_MAX_SESSIONS; index += 1) {
      manager.start({ cwd, cols: 80, rows: 24 })
    }
    expect(() => manager.start({ cwd, cols: 80, rows: 24 })).toThrow('最多同时运行')

    pty.processes[0].emitExit(0)
    expect(() => manager.start({ cwd, cols: 80, rows: 24 })).not.toThrow()
  })

  it('按 UTF-8 字节限制输入，并把 write/resize 交给对应 PTY', () => {
    const cwd = workspace()
    const { manager, pty } = fixture(cwd)
    const session = manager.start({ cwd, cols: 80, rows: 24 })

    manager.write({ id: session.id, data: 'a'.repeat(TERMINAL_MAX_INPUT_BYTES) })
    manager.resize({ id: session.id, cols: 132, rows: 40 })
    expect(pty.processes[0].writes).toEqual(['a'.repeat(TERMINAL_MAX_INPUT_BYTES)])
    expect(pty.processes[0].resizes).toEqual([[132, 40]])
    expect(() => manager.write({ id: session.id, data: `你${'a'.repeat(TERMINAL_MAX_INPUT_BYTES - 2)}` })).toThrow('65536')
  })

  it('close 与重复 exit 幂等，关闭中的会话不再接受输入', () => {
    const cwd = workspace()
    const { manager, pty, exits } = fixture(cwd)
    const session = manager.start({ cwd, cols: 80, rows: 24 })

    manager.close({ id: session.id })
    manager.close({ id: session.id })
    expect(pty.processes[0].destroyCount).toBe(1)
    expect(exits).toEqual([])
    expect(() => manager.write({ id: session.id, data: 'pwd\r' })).toThrow('不存在或已退出')

    pty.processes[0].emitExit(0, 1)
    pty.processes[0].emitExit(0, 1)
    manager.close({ id: session.id })
    expect(exits).toEqual([{ id: session.id, code: 0, signal: 1 }])
    expect(pty.processes[0].destroyCount).toBe(1)
  })

  it('close 超时未收到 onExit 时释放会话并上报未知终态', () => {
    vi.useFakeTimers()
    const cwd = workspace()
    const { manager, pty, exits } = fixture(cwd)
    const session = manager.start({ cwd, cols: 80, rows: 24 })

    manager.close({ id: session.id })
    expect(exits).toEqual([])
    vi.advanceTimersByTime(25)
    expect(exits).toEqual([{ id: session.id, code: null, signal: null }])
    pty.processes[0].emitExit(0)
    expect(exits).toHaveLength(1)
  })

  it('PTY runtime 没有 destroy 时回退到 kill', () => {
    const cwd = workspace()
    const { manager, pty } = fixture(cwd)
    const session = manager.start({ cwd, cols: 80, rows: 24 })
    Object.defineProperty(pty.processes[0], 'destroy', { value: undefined })

    manager.close({ id: session.id })
    expect(pty.processes[0].killCount).toBe(1)
  })

  it('closeAll 即使一个 destroy 失败也继续关闭其他 PTY', () => {
    const cwd = workspace()
    const { manager, pty } = fixture(cwd)
    manager.start({ cwd, cols: 80, rows: 24 })
    manager.start({ cwd, cols: 80, rows: 24 })
    pty.processes[0].destroyError = new Error('destroy failed')

    expect(() => manager.closeAll()).toThrow('destroy failed')
    expect(pty.processes.map((process) => process.destroyCount)).toEqual([1, 1])
  })

  it('write/resize 对退出和未知会话都 fail closed', () => {
    const cwd = workspace()
    const { manager, pty } = fixture(cwd)
    const session = manager.start({ cwd, cols: 80, rows: 24 })
    pty.processes[0].emitExit(0)

    expect(() => manager.write({ id: session.id, data: 'x' })).toThrow('不存在或已退出')
    expect(() => manager.resize({ id: 'missing', cols: 80, rows: 24 })).toThrow('不存在或已退出')
    expect(() => manager.close({ id: 'missing' })).not.toThrow()
  })
})
