import { expect, it } from 'vitest'
import { deviceEventPayload } from './subscribe-device-fields'

it('ships display evidence without indirectly exposing a private fork or answer identity', () => {
  const payload = deviceEventPayload({
    sessionKey: 'visible', parentSessionKey: 'outside', rootSessionKey: 'outside',
    lineage: { source: { sessionKey: 'outside', runId: 'private-run' } },
    answerId: 'saved-answer', answerSha256: 'private-hash', answeredBy: 'peer:private-fingerprint',
    appRunId: 'local-id', contentRef: 'raw-content',
    cwd: '/work/visible', provider: 'codex', title: 'Session title',
    catalog: { nativeSessionId: 'visible', projectCwd: '/private/project', preview: null, runtimeProvider: null },
    outcome: { value: 'failed', quality: 'exact', status: 'available', source: ['/private/output'] }
  }, cwd => cwd === '/work/visible')
  expect(payload).toEqual({
    sessionKey: 'visible', cwd: '/work/visible', provider: 'codex', title: 'Session title',
    catalog: { nativeSessionId: 'visible', projectCwd: null, preview: null, runtimeProvider: null },
    outcome: { value: 'failed', quality: 'exact', status: 'available' }
  })
})
