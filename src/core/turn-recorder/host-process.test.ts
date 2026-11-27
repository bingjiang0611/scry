import { describe, expect, it } from 'vitest'
import {
  MAX_HOST_CHAIN_DEPTH,
  hostProcessChain,
  hostProcessState,
  isProviderHostCommand,
  liveHostProcesses,
  processTable,
  validHostChain,
  type ProcessTableEntry
} from './host-process'

const DEAD_PID = 999_999

describe('宿主进程证据', () => {
  it('读得到当前进程的父链，而且不把 init 记进来', async () => {
    const table = await processTable()
    expect(table?.size).toBeGreaterThan(1)
    expect(table?.get(process.pid)).toMatchObject({ pid: process.pid, ppid: process.ppid })
    const chain = await hostProcessChain(process.pid)
    expect(chain.length).toBeGreaterThan(0)
    expect(chain[0]?.pid).toBe(process.pid)
    expect(chain.every((entry) => entry.pid > 1)).toBe(true)
    expect(chain.length).toBeLessThanOrEqual(MAX_HOST_CHAIN_DEPTH)
  })

  it('按 provider 截断到宿主进程为止，不纳入长期存活的 shell 和终端祖先', async () => {
    const table = new Map<number, ProcessTableEntry>([
      [900, { pid: 900, ppid: 1, token: 'ticks:900', command: '/Applications/iTerm.app/Contents/MacOS/iTerm2' }],
      [901, { pid: 901, ppid: 900, token: 'ticks:901', command: '-zsh' }],
      [902, { pid: 902, ppid: 901, token: 'ticks:902', command: '/Users/dev/.codex/bin/codex app-server' }],
      [903, { pid: 903, ppid: 902, token: 'ticks:903', command: '/bin/sh .scry/provider-hook.sh' }],
      [904, { pid: 904, ppid: 903, token: 'ticks:904', command: 'node /usr/local/bin/scry recorder hook' }]
    ])

    const chain = await hostProcessChain(904, { provider: 'codex', table })
    expect(chain.map((entry) => entry.pid)).toEqual([904, 903, 902])

    const whileHostRunning = new Map(table)
    whileHostRunning.delete(904)
    whileHostRunning.delete(903)
    expect(await hostProcessState(chain, whileHostRunning)).toBe('running')

    const afterHostExited = new Map(whileHostRunning)
    afterHostExited.delete(902)
    expect(await hostProcessState(chain, afterHostExited)).toBe('gone')
  })

  it('默认可追溯到 8 层包装壳找到宿主，且识别不出宿主时返回空链（unknown）', async () => {
    const deepTable = new Map<number, ProcessTableEntry>()
    deepTable.set(1008, { pid: 1008, ppid: 1, token: 'ticks:1008', command: '/bin/zsh' })
    deepTable.set(1007, { pid: 1007, ppid: 1008, token: 'ticks:1007', command: '/usr/local/bin/claude' })
    for (let index = 0; index < 7; index++) {
      const pid = 1000 + index
      deepTable.set(pid, { pid, ppid: pid + 1, token: `ticks:${pid}`, command: '/bin/sh wrapper.sh' })
    }
    const chain = await hostProcessChain(1000, { provider: 'claude', table: deepTable })
    expect(MAX_HOST_CHAIN_DEPTH).toBe(8)
    expect(chain).toHaveLength(8)
    expect(chain.map((entry) => entry.pid)).toEqual([1000, 1001, 1002, 1003, 1004, 1005, 1006, 1007])

    const noHostTable = new Map<number, ProcessTableEntry>([
      [200, { pid: 200, ppid: 201, token: 'ticks:200', command: '/bin/sh hook.sh' }],
      [201, { pid: 201, ppid: 202, token: 'ticks:201', command: '/bin/zsh -c "codex"' }],
      [202, { pid: 202, ppid: 1, token: 'ticks:202', command: '/Applications/Terminal.app/Contents/MacOS/Terminal' }]
    ])
    const unknownChain = await hostProcessChain(200, { provider: 'codex', table: noHostTable })
    expect(unknownChain).toEqual([])
    expect(await hostProcessState(unknownChain, noHostTable)).toBe('unknown')
  })

  it('按 provider 识别原生宿主与运行时包装脚本，不误判 shell 祖先', () => {
    expect(isProviderHostCommand('/Users/dev/.codex/bin/codex app-server', 'codex')).toBe(true)
    expect(isProviderHostCommand('node /usr/local/bin/codex', 'codex')).toBe(true)
    expect(isProviderHostCommand('node --experimental-strip-types /opt/@anthropic-ai/claude-code/cli.js', 'claude')).toBe(true)
    expect(isProviderHostCommand('/Applications/Qoder.app/Contents/MacOS/Qoder --flag', 'qoder')).toBe(true)
    expect(isProviderHostCommand('/usr/local/bin/opencode', 'opencode')).toBe(true)
    expect(isProviderHostCommand('node /usr/local/bin/pi --mode rpc', 'pi')).toBe(true)

    expect(isProviderHostCommand('/bin/zsh -c "codex"', 'codex')).toBe(false)
    expect(isProviderHostCommand('-zsh', 'codex')).toBe(false)
    expect(isProviderHostCommand('node -e "codex"', 'codex')).toBe(false)
    expect(isProviderHostCommand('node /path/to/vitest.mjs', 'codex')).toBe(false)
    expect(isProviderHostCommand('/usr/local/bin/claude', 'codex')).toBe(false)
  })

  it('校验宿主链格式并拒绝非法条目', () => {
    expect(validHostChain([{ pid: 42, token: 'Fri Nov 27 10:00:00 2026' }])).toEqual([
      { pid: 42, token: 'Fri Nov 27 10:00:00 2026' }
    ])
    expect(validHostChain([])).toBeUndefined()
    expect(validHostChain([{ pid: 1 }])).toBeUndefined()
    expect(validHostChain([{ pid: 42, token: '   ' }])).toBeUndefined()
    expect(validHostChain([{ pid: 42, token: 'bad\nline' }])).toBeUndefined()
  })

  it('自己的 pid 还活着，虚构的 pid 已经结束', async () => {
    const table = await processTable()
    const self = table?.get(process.pid)
    expect(self).toBeTruthy()
    expect(await liveHostProcesses([self!])).toHaveLength(1)
    expect(await hostProcessState([self!])).toBe('running')
    expect(await liveHostProcesses([{ pid: DEAD_PID }])).toEqual([])
    expect(await hostProcessState([{ pid: DEAD_PID }])).toBe('gone')
  })

  it('pid 被复用时启动标记不同，不算同一个进程', async () => {
    const self = (await processTable())!.get(process.pid)!
    expect(await liveHostProcesses([{ pid: self.pid, token: 'ticks:0' }])).toEqual([])
    expect(await liveHostProcesses([{ pid: self.pid, token: self.token }])).toHaveLength(1)
    expect(await liveHostProcesses([{ pid: self.pid }])).toHaveLength(1)
  })

  it('没有记录就返回 unknown，不把没有证据当成进程已退出', async () => {
    expect(await hostProcessState([])).toBe('unknown')
    expect(await hostProcessState(undefined)).toBe('unknown')
    expect(await liveHostProcesses([])).toEqual([])
  })
})
