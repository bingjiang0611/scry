import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CdpEvaluationError,
  CdpOwnershipError,
  claimRendererOwnership,
  evaluateCdp,
  inspectCdpEndpoint,
  inspectRendererOwnership,
  waitForRendererOwnership,
} from './cdp_ownership.mjs'

const expectedUrl = 'file:///tmp/scry/out/renderer/index.html'
const launchId = 'launch-current'
const finalTarget = {
  id: 'target-a',
  type: 'page',
  url: expectedUrl,
  title: 'Scry',
  webSocketDebuggerUrl: 'ws://example/target-a',
}
const blankTarget = {
  ...finalTarget,
  url: 'about:blank',
}

function snapshot(overrides = {}) {
  return {
    accepted: true,
    url: expectedUrl,
    title: 'Scry Test',
    readyState: 'complete',
    hasDocumentElement: true,
    hasScry: true,
    rootMounted: true,
    appMarker: 'true',
    launchId,
    ...overrides,
  }
}

function sequence(values) {
  let index = 0
  return async () => values[Math.min(index++, values.length - 1)]
}

function fakeClock() {
  let value = 0
  return {
    now: () => value,
    sleep: async (ms) => { value += ms },
    wallNowIso: () => new Date(value).toISOString(),
  }
}

function claimOptions(overrides = {}) {
  return {
    port: 9222,
    expectedUrl,
    launchId,
    timeoutMs: 2_000,
    pollMs: 50,
    verifyDelayMs: 100,
    ...overrides,
  }
}

test('evaluateCdp reports phase, kind, target and elapsed time', async () => {
  const failure = Object.assign(new Error('fixture timeout'), { cdpTransport: true, cdpKind: 'timeout' })
  const times = [100, 137]
  await assert.rejects(
    evaluateCdp(finalTarget, '1 + 1', {
      phase: 'type_reconcile',
      timeoutMs: 20,
      now: () => times.shift() ?? 137,
      command: async () => { throw failure },
    }),
    (error) => error instanceof CdpEvaluationError
      && error.phase === 'type_reconcile'
      && error.kind === 'timeout'
      && error.targetId === finalTarget.id
      && error.elapsedMs === 37
      && error.cdpTransport === true,
  )
})

test('evaluateCdp classifies expression exceptions without losing phase evidence', async () => {
  await assert.rejects(
    evaluateCdp(finalTarget, 'throw new Error()', {
      phase: 'preconditions',
      command: async () => ({ exceptionDetails: { text: 'Uncaught' } }),
    }),
    (error) => error instanceof CdpEvaluationError
      && error.phase === 'preconditions'
      && error.kind === 'expression'
      && error.targetId === finalTarget.id,
  )
})

test('waits through no target and about:blank before claiming the final renderer', async () => {
  const phases = []
  let claimed = false
  const result = await claimRendererOwnership(claimOptions(), {
    listTargets: sequence([[], [blankTarget], [finalTarget], [finalTarget]]),
    evaluate: async (_target, _expression, { phase }) => {
      phases.push(phase)
      if (phase === 'claim') claimed = true
      if (!claimed) return snapshot({ title: 'Scry', appMarker: null, launchId: null })
      return snapshot()
    },
    ...fakeClock(),
  })

  assert.equal(result.evidence.status, 'verified')
  assert.deepEqual(phases, ['inspect', 'claim', 'inspect'])
  assert.equal(result.evidence.actual.targetId, finalTarget.id)
  assert.equal(result.evidence.attempts.polls, 3)
})

test('retries a destroyed execution context before the marker is claimed', async () => {
  let evaluations = 0
  let claimAttempts = 0
  let claimed = false
  const contextError = Object.assign(new Error('Execution context was destroyed'), { protocolCode: -32000 })
  const result = await claimRendererOwnership(claimOptions(), {
    listTargets: async () => [finalTarget],
    evaluate: async (_target, _expression, { phase }) => {
      evaluations += 1
      if (phase === 'claim' && claimAttempts++ === 0) throw contextError
      if (phase === 'claim') claimed = true
      if (!claimed) return snapshot({ title: 'Scry', appMarker: null, launchId: null })
      return snapshot()
    },
    ...fakeClock(),
  })

  assert.equal(result.evidence.status, 'verified')
  assert.equal(result.evidence.attempts.contextDestroyed, 1)
  assert.equal(evaluations, 5)
})

test('retries a transient CDP socket failure before the marker is claimed', async () => {
  let evaluations = 0
  let claimAttempts = 0
  let claimed = false
  const transportError = Object.assign(new Error('CDP Runtime.evaluate socket closed before a response'), { cdpTransport: true })
  const result = await claimRendererOwnership(claimOptions(), {
    listTargets: async () => [finalTarget],
    evaluate: async (_target, _expression, { phase }) => {
      evaluations += 1
      if (phase === 'claim' && claimAttempts++ === 0) throw transportError
      if (phase === 'claim') claimed = true
      if (!claimed) return snapshot({ title: 'Scry', appMarker: null, launchId: null })
      return snapshot()
    },
    ...fakeClock(),
  })

  assert.equal(result.evidence.status, 'verified')
  assert.equal(result.evidence.attempts.transportRetries, 1)
  assert.equal(evaluations, 5)
})

test('waits for complete DOM, preload bridge, and mounted React root', async () => {
  let inspectAttempts = 0
  let claimed = false
  const result = await claimRendererOwnership(claimOptions(), {
    listTargets: async () => [finalTarget],
    evaluate: async (_target, _expression, { phase }) => {
      if (phase === 'inspect' && !claimed && inspectAttempts++ === 0) {
        return snapshot({ accepted: false, readyState: 'loading', rootMounted: false, appMarker: null, launchId: null, title: 'Scry' })
      }
      if (phase === 'claim') claimed = true
      if (!claimed) return snapshot({ title: 'Scry', appMarker: null, launchId: null })
      return snapshot()
    },
    ...fakeClock(),
  })

  assert.equal(result.evidence.status, 'verified')
  assert.equal(inspectAttempts, 2)
})

test('fails closed when the marker disappears during delayed verification', async () => {
  let mutationEvaluations = 0
  let claimed = false
  await assert.rejects(
    claimRendererOwnership(claimOptions(), {
      listTargets: async () => [finalTarget],
      evaluate: async (_target, _expression, { phase }) => {
        if (phase === 'claim') {
          mutationEvaluations += 1
          claimed = true
          return snapshot()
        }
        if (!claimed) return snapshot({ title: 'Scry', appMarker: null, launchId: null })
        return snapshot({ appMarker: null })
      },
      ...fakeClock(),
    }),
    (error) => error instanceof CdpOwnershipError && error.code === 'CDP_OWNERSHIP_UNSTABLE',
  )
  assert.equal(mutationEvaluations, 1)
})

test('rejects multiple page targets without evaluating either one', async () => {
  let evaluations = 0
  await assert.rejects(
    claimRendererOwnership(claimOptions(), {
      listTargets: async () => [finalTarget, { ...blankTarget, id: 'target-b' }],
      evaluate: async () => { evaluations += 1 },
      ...fakeClock(),
    }),
    (error) => error instanceof CdpOwnershipError && error.code === 'CDP_TARGET_AMBIGUOUS',
  )
  assert.equal(evaluations, 0)
})

test('times out without evaluating a renderer that remains about:blank', async () => {
  let evaluations = 0
  await assert.rejects(
    claimRendererOwnership(claimOptions({ timeoutMs: 200 }), {
      listTargets: async () => [blankTarget],
      evaluate: async () => { evaluations += 1 },
      ...fakeClock(),
    }),
    (error) => error instanceof CdpOwnershipError
      && error.code === 'CDP_TARGET_TIMEOUT'
      && error.evidence.actual.targetUrl === 'about:blank',
  )
  assert.equal(evaluations, 0)
})

test('does not swallow an unknown CDP protocol error', async () => {
  const protocolError = Object.assign(new Error('Unexpected protocol failure'), { protocolCode: -32001 })
  await assert.rejects(
    claimRendererOwnership(claimOptions(), {
      listTargets: async () => [finalTarget],
      evaluate: async () => { throw protocolError },
      ...fakeClock(),
    }),
    (error) => error instanceof CdpOwnershipError && error.code === 'CDP_PROTOCOL_ERROR',
  )
})

test('binds ownership to the browser UUID from this launch userData', async () => {
  let evaluations = 0
  await assert.rejects(
    claimRendererOwnership(claimOptions({ expectedBrowserPath: '/devtools/browser/owned' }), {
      getBrowserVersion: async () => ({ webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/browser/foreign' }),
      listTargets: async () => [finalTarget],
      evaluate: async () => { evaluations += 1 },
      ...fakeClock(),
    }),
    (error) => error instanceof CdpOwnershipError && error.code === 'CDP_BROWSER_IDENTITY_MISMATCH',
  )
  assert.equal(evaluations, 0)
})

test('retries a transient read-only verification without rewriting the marker', async () => {
  let evaluations = 0
  const transportError = Object.assign(new Error('socket failed'), { cdpTransport: true })
  const result = await waitForRendererOwnership({
    port: 9222,
    expectedUrl,
    launchId,
    timeoutMs: 500,
  }, {
    listTargets: async () => [finalTarget],
    evaluate: async () => {
      evaluations += 1
      if (evaluations === 1) throw transportError
      return snapshot()
    },
    ...fakeClock(),
  })

  assert.equal(result.evidence.status, 'verified')
  assert.equal(result.evidence.verification.polls, 2)
  assert.equal(evaluations, 2)
})

test('distinguishes a refused CDP endpoint from an unknown endpoint state', async () => {
  const refused = new TypeError('fetch failed', { cause: Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }) })
  const closed = await inspectCdpEndpoint(9222, { getBrowserVersion: async () => { throw refused } })
  const unknown = await inspectCdpEndpoint(9222, { getBrowserVersion: async () => { throw new Error('timed out') } })

  assert.equal(closed.status, 'closed')
  assert.equal(unknown.status, 'unreachable')
})

test('live inspection rejects a marker from another launch without mutating it', async () => {
  let evaluations = 0
  const result = await inspectRendererOwnership({
    port: 9222,
    expectedUrl,
    launchId,
    expectedTargetId: finalTarget.id,
  }, {
    listTargets: async () => [finalTarget, { id: 'worker', type: 'service_worker', url: 'worker.js' }],
    evaluate: async () => {
      evaluations += 1
      return snapshot({ launchId: 'launch-old' })
    },
  })

  assert.equal(result.evidence.status, 'marker_mismatch')
  assert.equal(evaluations, 1)
})

test('live inspection accepts the browser-harness title decoration', async () => {
  const result = await inspectRendererOwnership({
    port: 9222,
    expectedUrl,
    launchId,
    expectedTargetId: finalTarget.id,
  }, {
    listTargets: async () => [finalTarget],
    evaluate: async () => snapshot({ title: '🐴 Scry Test' }),
  })

  assert.equal(result.evidence.status, 'verified')
  assert.equal(result.evidence.actual.title, '🐴 Scry Test')
})
