import { describe, expect, it } from 'vitest'
import { hostProcessChain, hostProcessState, liveHostProcesses, processTable } from './host-process'

/**
 * Host evidence is an observation, never a guess: a process is "still running" only when the pid
 * names the same process it named at capture time.
 */

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
    // 只走到宿主那一层：链再长就会碰到终端或窗口进程，它们本来就比会话活得久。
    expect(chain.length).toBeLessThanOrEqual(3)
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
    // 记不清启动标记时不能反过来证明“是同一个进程”，只有明确不同才排除。
    expect(await liveHostProcesses([{ pid: self.pid }])).toHaveLength(1)
  })

  it('没有记录就返回 unknown，不把没有证据当成进程已退出', async () => {
    expect(await hostProcessState([])).toBe('unknown')
    expect(await hostProcessState(undefined)).toBe('unknown')
    expect(await liveHostProcesses([])).toEqual([])
  })
})
