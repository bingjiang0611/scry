import { describe, expect, it } from 'vitest'
import type { TraceEvent } from '@shared/trace'
import { enqueuePrompt, migrateSessionPromptQueue, type QueuedPrompt } from './App'
import {
  activeSteerIdentityMatches,
  isSteerDrainBlocked,
  latestSteerCapability,
  latestSteerEvidence,
  removeQueuedPromptByMessageId,
  retainProtectedSteerPrompts,
  steerStateForMessage,
  updateQueuedPromptByMessageId
} from './steer'

const prompt = (messageId: string, steer?: QueuedPrompt['steer']): QueuedPrompt => ({
  messageId,
  text: messageId,
  attachments: [],
  request: { providerId: 'pi', expectedExternalSessionId: 'session', cwd: '/repo' },
  ...(steer ? { steer } : {})
})

function event(id: string, patch: Partial<TraceEvent>): TraceEvent {
  return { id, ts: id, runId: 'run', kind: 'harness', stage: 'runtime:steer', ...patch }
}

describe('renderer Steer queue contract', () => {
  it('assigns a stable message id and removes an accepted non-head item by id', () => {
    const queue = enqueuePrompt([], 'first', [], { providerId: 'pi' })
    const withSecond = enqueuePrompt(queue, 'second', [], { providerId: 'pi' })
    expect(withSecond[0].messageId).not.toBe(withSecond[1].messageId)
    expect(removeQueuedPromptByMessageId(withSecond, withSecond[1].messageId).map((item) => item.text)).toEqual(['first'])
  })

  it('keeps the original queue object identity across a session-key migration race', () => {
    const pending = prompt('pending', { status: 'pending' })
    const fresh = prompt('fresh')
    const migrated = migrateSessionPromptQueue(new Map([
      ['provisional', [pending]],
      ['captured', [fresh]]
    ]), 'provisional', 'captured')
    expect(migrated.get('captured')).toEqual([pending, fresh])
    expect(migrated.get('captured')?.[0].steer).toEqual({ status: 'pending' })
  })

  it('quarantines uncertainty and only reconciles authoritative acceptance without ever draining again', () => {
    const unknown = { status: 'unknown' as const, message: 'IPC timeout' }
    expect(isSteerDrainBlocked(unknown)).toBe(true)
    const accepted = steerStateForMessage(unknown, { messageId: 'm', prompt: 'x', attachments: [], status: 'accepted' })
    expect(accepted).toMatchObject({ status: 'accepted' })
    expect(isSteerDrainBlocked(accepted)).toBe(true)
    expect(steerStateForMessage(unknown, { messageId: 'm', prompt: 'x', attachments: [], status: 'rejected' })).toEqual(unknown)
  })

  it('blocks a new retry before its pending trace arrives and an ACK before queue-removal commits', () => {
    const retry = steerStateForMessage({ status: 'pending' }, { messageId: 'm', prompt: 'x', attachments: [], status: 'rejected' })
    expect(retry).toEqual({ status: 'pending' })
    expect(isSteerDrainBlocked(retry)).toBe(true)
    const ack = steerStateForMessage({ status: 'pending' }, { messageId: 'm', prompt: 'x', attachments: [], status: 'accepted' })
    expect(isSteerDrainBlocked(ack)).toBe(true)
    expect(steerStateForMessage({ status: 'rejected', message: 'no' }, { messageId: 'm', prompt: 'x', attachments: [], status: 'pending' })).toMatchObject({ status: 'rejected' })
  })

  it('binds only provisional queue identities during authoritative same-run native session capture', () => {
    const unbound = { ...prompt('unbound'), request: { providerId: 'pi' as const, expectedExternalSessionId: null, cwd: '/repo' } }
    const provisional = { ...prompt('provisional'), request: { ...prompt('provisional').request, expectedExternalSessionId: 'run-1' } }
    const bound = prompt('bound')
    const migrated = migrateSessionPromptQueue(new Map([['new', [unbound, provisional, bound]]]), 'new', 'native', { runId: 'run-1', externalSessionId: 'native-session' })
    expect(migrated.get('native')?.map(item => item.request.expectedExternalSessionId)).toEqual(['native-session', 'native-session', 'session'])
    expect(migrated.get('native')?.map(item => item.messageId)).toEqual(['unbound', 'provisional', 'bound'])
    expect(migrated.get('native')?.[2]).toBe(bound)
  })

  it('uses the latest capability and only the latest evidence per message', () => {
    const items = [
      event('cap-1', { steerCapability: { status: 'unavailable', reason: 'waiting' } }),
      event('cap-2', { steerCapability: { status: 'available', attachments: true } }),
      event('pending', { steer: { messageId: 'm', prompt: 'x', attachments: [], status: 'pending' } }),
      event('accepted', { steer: { messageId: 'm', prompt: 'x', attachments: [], status: 'accepted' } })
    ]
    expect(latestSteerCapability(items)).toEqual({ status: 'available', attachments: true })
    expect(latestSteerEvidence(items).get('m')).toMatchObject({ status: 'accepted', eventId: 'accepted' })
  })

  it('keeps protected messages and attachments when Stop clears ordinary queued prompts', () => {
    const pending = { ...prompt('pending', { status: 'pending' }), attachments: [{ kind: 'image' as const, name: 'diagram.png', mimeType: 'image/png' as const, dataBase64: 'aGk=' }] }
    const queue = [prompt('ordinary'), pending, prompt('unknown', { status: 'unknown' }), prompt('ack'), prompt('in-flight'), prompt('rejected', { status: 'rejected' })]
    const evidence = new Map([['ack', { messageId: 'ack', prompt: 'x', attachments: [], status: 'accepted' as const }]])
    const retained = retainProtectedSteerPrompts(queue, evidence, new Set(['in-flight']))
    expect(retained.map(item => item.messageId)).toEqual(['pending', 'unknown', 'ack', 'in-flight'])
    expect(retained[0]).toBe(pending)
    expect(retained[0].attachments).toBe(pending.attachments)
  })

  it('matches all runtime identity fields before sending', () => {
    const input = {
      request: { providerId: 'pi', agentProfileId: 'pi:a', cwd: '/repo', expectedExternalSessionId: 'session' },
      active: { providerId: 'pi', agentProfileId: 'pi:a', cwd: '/repo', externalSessionId: 'session' },
    }
    expect(activeSteerIdentityMatches(input)).toBe(true)
    expect(activeSteerIdentityMatches({ ...input, request: { ...input.request, cwd: '/other' } })).toBe(false)
  })

  it('updates or removes a queued id without touching other migrated queues', () => {
    const queues = new Map([['session', [prompt('first'), prompt('second')]]])
    const removed = updateQueuedPromptByMessageId(queues, 'second', () => null)
    expect(removed.get('session')?.map((item) => item.messageId)).toEqual(['first'])
  })
})
