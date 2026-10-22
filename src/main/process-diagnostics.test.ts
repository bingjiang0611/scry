import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'
import {
  canSignalCategory,
  captureProcessIdentity,
  classifyProcessRow,
  descendantTree,
  parseProcessSnapshot,
  processIdentityKey,
  readProcessSnapshot,
  signalProcessTreeWithIdentity,
  type ProcessRow
} from './process-diagnostics'

const row = (pid: number, ppid: number, command: string, started = 'Wed Oct 15 10:00:00 2026', status = 'S'): ProcessRow =>
  ({ pid, ppid, status, startedAt: started, command })

const snapshotOf = (rows: ProcessRow[]): ReadonlyMap<number, ProcessRow> =>
  new Map(rows.map((entry) => [entry.pid, entry]))

const lister = (rows: ProcessRow[]) => () => rows
  .map((entry) => `${entry.pid} ${entry.ppid} ${entry.status} ${entry.startedAt} ${entry.command}`)
  .join('\n')

describe('进程身份与快照解析', () => {
  it('身份键由 pid 与启动时间共同构成', () => {
    expect(processIdentityKey({ pid: 42, startedAt: 'Wed Oct 15 10:00:00 2026' })).toBe('42:Wed Oct 15 10:00:00 2026')
  })

  it('解析 ps 输出，保留带空格的命令行', () => {
    const parsed = parseProcessSnapshot([
      '  501   1 S    Wed Oct 15 10:00:00 2026 /bin/sh -c "sleep 30" ',
      'garbage line',
      '  502 501 Z+   Wed Oct 15 10:00:01 2026 (sleep)'
    ].join('\n'))
    expect(parsed.get(501)).toEqual({
      pid: 501,
      ppid: 1,
      status: 'S',
      startedAt: 'Wed Oct 15 10:00:00 2026',
      command: '/bin/sh -c "sleep 30" '
    })
    expect(parsed.get(502)?.status).toBe('Z+')
    expect(parsed.size).toBe(2)
  })

  it('读取真实 ps 快照时能找到当前进程自己', () => {
    const snapshot = readProcessSnapshot()
    expect(snapshot.get(process.pid)?.pid).toBe(process.pid)
  })

  it('异步身份采集只向 lister 请求目标 PID', async () => {
    const calls: number[] = []
    const identity = await captureProcessIdentity(501, (pid) => {
      calls.push(pid)
      return '  501   1 S    Wed Oct 15 10:00:00 2026 claude'
    })
    expect(calls).toEqual([501])
    expect(identity).toEqual({ pid: 501, startedAt: 'Wed Oct 15 10:00:00 2026', command: 'claude' })
  })

  it('身份采集超时返回未知身份', async () => {
    const identity = await captureProcessIdentity(501, () => new Promise<string>(() => {}), 1)
    expect(identity).toEqual({ pid: 501 })
  })
})

describe('类别白名单', () => {
  it('Electron 自身进程不可发信号，Provider 进程树可以', () => {
    const options = { rootPid: 10, rootCategory: 'provider-root' as const }
    expect(classifyProcessRow(row(10, 1, '/usr/local/bin/codex exec'), options)).toBe('provider-root')
    expect(classifyProcessRow(row(11, 10, 'node /tmp/tool.js'), options)).toBe('provider-child')
    expect(classifyProcessRow(row(12, 10, '/path/Electron.app/Contents/MacOS/Electron .'), options)).toBe('electron-main')
    expect(classifyProcessRow(row(13, 10, 'Electron Helper --type=renderer --x'), options)).toBe('electron-renderer')
    expect(classifyProcessRow(row(14, 10, 'Helper --type=gpu-process'), options)).toBe('electron-gpu')
    expect(classifyProcessRow(row(15, 10, 'Helper --type=utility --utility-sub-type=network'), options)).toBe('electron-utility')
    expect(classifyProcessRow(row(16, 1, '/bin/zsh -l'), { rootPid: 16, rootCategory: 'terminal-root' })).toBe('terminal-root')

    expect(['provider-root', 'provider-child', 'terminal-root'].every(canSignalCategory as never)).toBe(true)
    expect(['electron-main', 'electron-renderer', 'electron-gpu', 'electron-utility', 'unknown'].some(canSignalCategory as never)).toBe(false)
  })
})

describe('后代树', () => {
  it('给出 ppid/depth/childPids，并对环状 ppid 保持收敛', () => {
    const tree = descendantTree(snapshotOf([
      row(10, 1, 'codex exec'),
      row(11, 10, 'node tool.js'),
      row(12, 11, 'rg pattern'),
      row(13, 10, 'sleep 30'),
      row(99, 1, 'unrelated'),
      row(14, 14, 'self-parent')
    ]), { rootPid: 10, rootCategory: 'provider-root' })

    expect(tree.map((node) => [node.pid, node.depth, node.childPids])).toEqual([
      [10, 0, [11, 13]],
      [11, 1, [12]],
      [13, 1, []],
      [12, 2, []]
    ])
    expect(tree.every((node) => canSignalCategory(node.category))).toBe(true)
  })

  it('根进程不存在时返回空树', () => {
    expect(descendantTree(snapshotOf([row(99, 1, 'x')]), { rootPid: 10, rootCategory: 'provider-root' })).toEqual([])
  })
})

describe('发信号前的身份校验', () => {
  const identity = { pid: 10, startedAt: 'Wed Oct 15 10:00:00 2026', command: 'codex exec' }

  it('身份一致时对进程组发信号', () => {
    const killed: Array<[number, string]> = []
    const outcome = signalProcessTreeWithIdentity({
      identity,
      signal: 'SIGKILL',
      lister: lister([row(10, 1, 'codex exec'), row(11, 10, 'node tool.js')]),
      kill: (pid, signal) => { killed.push([pid, signal]) },
      selfPid: 777
    })
    expect(outcome).toMatchObject({ status: 'signalled', scope: 'group', identityKey: '10:Wed Oct 15 10:00:00 2026' })
    expect(killed).toEqual([[-10, 'SIGKILL']])
  })

  it('启动时间变化（PID 复用）时拒绝发信号', () => {
    const killed: number[] = []
    const outcome = signalProcessTreeWithIdentity({
      identity,
      signal: 'SIGKILL',
      lister: lister([row(10, 1, 'codex exec', 'Wed Oct 15 11:30:00 2026')]),
      kill: (pid) => { killed.push(pid) },
      selfPid: 777
    })
    expect(outcome).toMatchObject({ status: 'refused', reason: 'identity_changed' })
    expect(killed).toEqual([])
  })

  it('命令行变化时拒绝发信号', () => {
    const outcome = signalProcessTreeWithIdentity({
      identity,
      signal: 'SIGKILL',
      lister: lister([row(10, 1, 'something-else')]),
      kill: () => { throw new Error('不应发信号') },
      selfPid: 777
    })
    expect(outcome).toMatchObject({ status: 'refused', reason: 'identity_changed' })
  })

  it('进程树里出现 Electron 进程时整棵树都不发信号', () => {
    const outcome = signalProcessTreeWithIdentity({
      identity,
      signal: 'SIGKILL',
      lister: lister([row(10, 1, 'codex exec'), row(11, 10, 'Helper --type=renderer')]),
      kill: () => { throw new Error('不应发信号') },
      selfPid: 777
    })
    expect(outcome).toMatchObject({ status: 'refused', reason: 'category_not_signalable' })
    expect((outcome as { detail: string }).detail).toContain('11=electron-renderer')
  })

  it('没有采集到启动时间、或目标是自己/init 时拒绝', () => {
    const noIdentity = signalProcessTreeWithIdentity({ identity: { pid: 10 }, signal: 'SIGKILL', selfPid: 777, kill: () => {} })
    expect(noIdentity).toMatchObject({ status: 'refused', reason: 'identity_unknown' })
    expect(signalProcessTreeWithIdentity({ identity: { pid: 1, startedAt: 'x' }, signal: 'SIGKILL', kill: () => {} }))
      .toMatchObject({ status: 'refused', reason: 'self_or_init' })
    expect(signalProcessTreeWithIdentity({ identity: { pid: 777, startedAt: 'x' }, signal: 'SIGKILL', selfPid: 777, kill: () => {} }))
      .toMatchObject({ status: 'refused', reason: 'self_or_init' })
  })

  it('进程已消失或已成僵尸时报告 already_gone，而不是伪装成功', () => {
    expect(signalProcessTreeWithIdentity({
      identity,
      signal: 'SIGKILL',
      lister: lister([row(99, 1, 'other')]),
      kill: () => { throw new Error('不应发信号') },
      selfPid: 777
    })).toEqual({ status: 'already_gone', reason: 'process_missing' })

    expect(signalProcessTreeWithIdentity({
      identity,
      signal: 'SIGKILL',
      lister: lister([row(10, 1, 'codex exec', identity.startedAt, 'Z+')]),
      kill: () => { throw new Error('不应发信号') },
      selfPid: 777
    })).toEqual({ status: 'already_gone', reason: 'zombie' })
  })

  it('进程组不存在时退回单进程信号', () => {
    const killed: number[] = []
    const outcome = signalProcessTreeWithIdentity({
      identity,
      signal: 'SIGTERM',
      lister: lister([row(10, 1, 'codex exec')]),
      kill: (pid, signal) => {
        if (pid < 0) {
          const error = new Error('no such process group') as Error & { code: string }
          error.code = 'ESRCH'
          throw error
        }
        killed.push(pid)
        void signal
      },
      selfPid: 777
    })
    // 组信号的 ESRCH 说明组已经不存在，这是「已经没了」而不是「改用单进程」
    expect(outcome).toEqual({ status: 'already_gone', reason: 'process_missing' })
    expect(killed).toEqual([])
  })
})

describe('真实进程树（端到端）', () => {
  it('发现真实后代、按身份杀掉整组，并在 PID 身份不符时拒绝', async () => {
    const child = spawn('/bin/sh', ['-c', 'sleep 30 & sleep 30'], { detached: true, stdio: 'ignore' })
    try {
      expect(child.pid).toBeGreaterThan(0)
      // 等 sh 真正派生出两个 sleep
      let tree = descendantTree(readProcessSnapshot(), { rootPid: child.pid!, rootCategory: 'provider-root' })
      for (let attempt = 0; attempt < 50 && tree.length < 3; attempt += 1) {
        await delay(20)
        tree = descendantTree(readProcessSnapshot(), { rootPid: child.pid!, rootCategory: 'provider-root' })
      }
      expect(tree.length).toBeGreaterThanOrEqual(3)
      expect(tree[0]).toMatchObject({ pid: child.pid, depth: 0, category: 'provider-root' })
      expect(tree.slice(1).every((node) => node.depth === 1 && node.category === 'provider-child')).toBe(true)

      const identity = await captureProcessIdentity(child.pid)
      expect(identity?.startedAt).toBeTruthy()

      // 伪造一个启动时间不符的身份：必须拒绝，真实进程树还活着
      expect(signalProcessTreeWithIdentity({
        identity: { ...identity!, startedAt: 'Wed Oct 15 00:00:00 2000' },
        signal: 'SIGKILL'
      })).toMatchObject({ status: 'refused', reason: 'identity_changed' })
      expect(readProcessSnapshot().has(child.pid!)).toBe(true)

      const outcome = signalProcessTreeWithIdentity({ identity: identity!, signal: 'SIGKILL' })
      expect(outcome).toMatchObject({ status: 'signalled', scope: 'group' })

      const pids = tree.map((node) => node.pid)
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const snapshot = readProcessSnapshot()
        const live = pids.filter((pid) => {
          const current = snapshot.get(pid)
          return current && !current.status.startsWith('Z')
        })
        if (live.length === 0) return
        await delay(20)
      }
      throw new Error('进程树未在预期时间内退出')
    } finally {
      try { process.kill(-child.pid!, 'SIGKILL') } catch { /* already gone */ }
    }
  }, 20_000)
})
