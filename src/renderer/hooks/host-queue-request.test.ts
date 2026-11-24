import { describe, expect, it } from 'vitest'
import { hostQueueRequestFor } from './host-queue-model'

// D1: the App sends the identity it really has. Blank fields are dropped rather than sent as empty
// strings, because an empty cwd would make the host resolve a different session.
describe('hostQueueRequestFor', () => {
  it('keeps the identity fields the session has', () => {
    expect(hostQueueRequestFor({ sessionId: 's-1', providerId: 'codex', cwd: '/w' }))
      .toEqual({ sessionId: 's-1', providerId: 'codex', cwd: '/w' })
  })

  it('drops blanks and answers null without a session', () => {
    expect(hostQueueRequestFor({ sessionId: 's-1', providerId: '', cwd: null })).toEqual({ sessionId: 's-1' })
    expect(hostQueueRequestFor({ sessionId: null, providerId: 'codex' })).toBeNull()
    expect(hostQueueRequestFor({ sessionId: '' })).toBeNull()
  })
})
