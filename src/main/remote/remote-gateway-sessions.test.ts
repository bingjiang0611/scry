import { describe, expect, it } from 'vitest'
import { sessionRefs } from './remote-gateway-sanitizers'

// The host reports how many questions block a run so a client can say "waiting for
// answers" instead of "running". Absence stays absent: it is not a zero count.
describe('remote session catalog questions', () => {
  const base = { sessionId: 's1', externalSessionId: 'ext1', providerId: 'qoder', cwd: '/w/a', label: 'hello', ts: 20, isActive: true }

  it('forwards a bounded question count only while the run is blocked', () => {
    expect(sessionRefs([{ ...base, pendingQuestions: 2 }])).toEqual([{ ...base, pendingQuestions: 2 }])
    expect(sessionRefs([{ ...base, pendingQuestions: 250 }])).toEqual([{ ...base, pendingQuestions: 99 }])
    expect(sessionRefs([base])).toEqual([base])
  })

  it('drops counts a host could not have observed', () => {
    for (const pendingQuestions of [0, -1, 1.5, Number.NaN, '2']) {
      expect(sessionRefs([{ ...base, pendingQuestions } as never])).toEqual([base])
    }
  })
})
