import { describe, expect, it } from 'vitest'
import type { ActiveRun } from '../../shared/trace'
import { ContextAdmission } from '../context-admission'
import { RunRegistry } from '../run-registry'
import type { RunControl } from './run-control'

/**
 * 启动期预留的顺序证明。生产里 startRun 把「恢复 → 基线 → 注册」整段放在
 * contextAdmission.runMany(provider/profile/cwd) 内，Provider 派发只在注册之后
 * （run-execution 在注册返回后才创建 runtimePromise）。所以同一 provider/profile
 * 的第二个启动不可能在兄弟「已观测基线但还没注册」的窗口里跑恢复。
 *
 * 这里用的都是生产实现：ContextAdmission 的 key 语义、RunRegistry 的 unsettledStates。
 * 不新增预留表：同一 key 下没有可达的空窗。
 */
function state(runId: string, sessionId?: string): ActiveRun {
  return {
    runId, providerId: 'pi', agentProfileId: 'pi:0123456789abcdef', cwd: '/repo',
    ...(sessionId ? { externalSessionId: sessionId, sessionId } : {}),
    userText: runId, items: [], done: false, providerSettled: false
  }
}

function control(runId: string): RunControl {
  return { runId, providerId: 'pi', runtimeProvider: 'pi_rpc', settled: Promise.resolve() } as unknown as RunControl
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('startup reservation between baseline and registration', () => {
  it('serializes recovery and registration for the same provider/profile/cwd', async () => {
    const admission = new ContextAdmission()
    const runs = new RunRegistry<ActiveRun, RunControl>()
    const key = 'pi\0pi:0123456789abcdef\0/repo'
    const observed: string[][] = []
    // 生产顺序：恢复 → 观测基线 → 注册，全部在同一个 admission key 内。
    const startup = (runId: string, sessionId: string) => admission.runMany([key], async () => {
      await tick() // 恢复/基线观测的异步窗口
      observed.push(runs.unsettledStates().map((run) => run.runId))
      await tick()
      runs.register(state(runId, sessionId), control(runId))
    })
    await Promise.all([startup('run-a', 'native-a'), startup('run-b', 'native-b')])
    expect(observed).toEqual([[], ['run-a']])
    expect(runs.unsettledStates().map((run) => run.runId)).toEqual(['run-a', 'run-b'])
  })

  it('would lose that evidence without the shared admission key (negative control)', async () => {
    const runs = new RunRegistry<ActiveRun, RunControl>()
    const observed: string[][] = []
    // 故意绕过 contextAdmission：同一 provider/profile/cwd 的两个启动交错执行。
    const startup = async (runId: string, sessionId: string) => {
      await tick()
      observed.push(runs.unsettledStates().map((run) => run.runId))
      await tick()
      runs.register(state(runId, sessionId), control(runId))
    }
    await Promise.all([startup('run-a', 'native-a'), startup('run-b', 'native-b')])
    expect(observed).toEqual([[], []])
  })

  it('keys the reservation by provider profile, not by the whole workspace', async () => {
    const admission = new ContextAdmission()
    const order: string[] = []
    const first = admission.runMany(['pi\0profile-a\0/repo'], async () => {
      await tick()
      order.push('profile-a')
    })
    const second = admission.runMany(['pi\0profile-b\0/repo'], async () => {
      order.push('profile-b')
      await tick()
    })
    await Promise.all([first, second])
    // 不同 profile 的启动可以并行：它们各自登记自己的原生身份，不抢同一个 resume 指针。
    expect(order).toEqual(['profile-b', 'profile-a'])
  })
})
