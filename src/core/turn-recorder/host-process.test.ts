import { describe, expect, it } from 'vitest'
import { MAX_HOST_CHAIN_DEPTH, hostProcessChain, hostProcessState, liveHostProcesses, processTable, validHostChain, type ProcessTableEntry } from './host-process'


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

  it('默认可追溯到 8 层祖先，不会在深层壳包装下漏掉宿主进程', async () => {
    const table = new Map<number, ProcessTableEntry>()
    for (let index = 0; index < 10; index++) {
      const pid = 1000 + index
      const ppid = index === 9 ? 1 : pid + 1
      table.set(pid, { pid, ppid, token: `ticks:${pid}` })
    }
    const chain = await hostProcessChain(1000, undefined, table)
    expect(MAX_HOST_CHAIN_DEPTH).toBe(8)
    expect(chain).toHaveLength(8)
    expect(chain.map((entry) => entry.pid)).toEqual([1000, 1001, 1002, 1003, 1004, 1005, 1006, 1007])

    const shortTable = new Map<number, ProcessTableEntry>([
      [200, { pid: 200, ppid: 201, token: 'ticks:200' }],
      [201, { pid: 201, ppid: 202, token: 'ticks:201' }],
      [202, { pid: 202, ppid: 203, token: 'ticks:202' }],
      [203, { pid: 203, ppid: 204, token: 'ticks:203' }],
      [204, { pid: 204, ppid: 1, token: 'ticks:204' }]
    ])
    const shortChain = await hostProcessChain(200, undefined, shortTable)
    expect(shortChain.map((entry) => entry.pid)).toEqual([200, 201, 202, 203, 204])
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
