import { describe, expect, it, vi } from 'vitest'
import type { AgentStartRequest } from '../../shared/runtime'
import type { ManagedConversationStart } from '../conversation-service-deps'
import { ManagedLaunches, MAX_PENDING_LAUNCHES, abandonRefusedLaunch, conversationIntentId } from './managed-launches'

const request: AgentStartRequest = { prompt: 'hello', providerId: 'claude', cwd: '/w', attachments: [] }
const managed = (runId: string) => ({ conversationId: 'c1', runId } as unknown as ManagedConversationStart)

describe('managed conversation launches', () => {
  it('submits only routing, and answers the send once the run is registered', async () => {
    const launches = new ManagedLaunches()
    const submit = vi.fn(() => ({ runId: 'ledger-1', seq: 7 }))
    const sent = launches.start(request, managed('run-1'), submit)
    expect(submit).toHaveBeenCalledWith(conversationIntentId('run-1'), expect.any(String))
    const detail = JSON.parse((submit.mock.calls[0] as unknown as [string, string])[1])
    expect(detail).toEqual({ cwd: '/w', providerId: 'claude', prompt: 'hello', conversation: { conversationId: 'c1', runId: 'run-1' } })
    const launch = launches.take('run-1')
    expect(launch?.request).toBe(request)
    launch!.started('run-1')
    await expect(sent).resolves.toEqual({ runId: 'run-1' })
    expect(launches.receipt('run-1')).toEqual({ runId: 'ledger-1', seq: 7 })
    expect(launches.receipt('run-1')).toBeUndefined()
  })

  it('is claimed once, so a second dispatch or a restarted daemon finds nothing', () => {
    const launches = new ManagedLaunches()
    void launches.start(request, managed('run-1'), () => ({ runId: 'ledger-1' })).catch(() => undefined)
    expect(launches.take('run-1')).toBeDefined()
    expect(launches.take('run-1')).toBeUndefined()
    expect(new ManagedLaunches().take('run-1')).toBeUndefined()
  })

  it('fails the send when the ledger refuses the run before it is claimed', async () => {
    const launches = new ManagedLaunches()
    const sent = launches.start(request, managed('run-1'), () => ({ runId: 'ledger-1' }))
    launches.abandon('run-1', new Error('denied'))
    await expect(sent).rejects.toThrow('denied')
    expect(launches.receipt('run-1')).toBeUndefined()
    // A claimed launch is the dispatch's to settle; a late abandon changes nothing.
    const second = launches.start(request, managed('run-2'), () => ({ runId: 'ledger-2' }))
    const claimed = launches.take('run-2')!
    launches.abandon('run-2', new Error('late'))
    claimed.started('run-2')
    await expect(second).resolves.toEqual({ runId: 'run-2' })
  })

  it('withdraws the launch when the intent was not recorded', async () => {
    const launches = new ManagedLaunches()
    await expect(launches.start(request, managed('run-1'), () => { throw new Error('ledger_full') })).rejects.toThrow('ledger_full')
    expect(launches.take('run-1')).toBeUndefined()
  })

  it('refuses a different run id and stays bounded', async () => {
    const launches = new ManagedLaunches()
    const sent = launches.start(request, managed('run-1'), () => ({ runId: 'ledger-1' }))
    launches.take('run-1')!.started('other')
    await expect(sent).rejects.toThrow('不同的 runId')
    for (let index = 0; index < MAX_PENDING_LAUNCHES; index++) {
      void launches.start(request, managed(`busy-${index}`), () => ({ runId: `ledger-${index}` })).catch(() => undefined)
    }
    await expect(launches.start(request, managed('one-more'), () => ({ runId: 'x' }))).rejects.toThrow('conversation_start_busy')
  })

  it('fails the send for a refusal of the App\'s own intent, and ignores a device naming it', async () => {
    const launches = new ManagedLaunches()
    const sent = launches.start(request, managed('run-1'), () => ({ runId: 'ledger-1' }))
    const detail = JSON.stringify({ providerId: 'claude', conversation: { conversationId: 'c1', runId: 'run-1' } })
    abandonRefusedLaunch(launches, { detail, grantScope: 'remote', error: new Error('device') })
    abandonRefusedLaunch(launches, { detail: 'not json', grantScope: 'local', error: new Error('garbage') })
    expect(launches.take('run-1')).toBeDefined()
    const again = launches.start(request, managed('run-2'), () => ({ runId: 'ledger-2' }))
    abandonRefusedLaunch(launches, { detail: detail.replace('run-1', 'run-2'), grantScope: 'local', error: new Error('policy') })
    await expect(again).rejects.toThrow('policy')
    void sent.catch(() => undefined)
  })
})
