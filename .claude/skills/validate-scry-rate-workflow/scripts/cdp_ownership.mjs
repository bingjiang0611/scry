const DEFAULT_IO_TIMEOUT_MS = 5_000
const DEFAULT_VERIFY_TIMEOUT_MS = 2_000

export const DEFAULT_SCRY_OWNERSHIP_SPEC = Object.freeze({
  title: 'Scry Test',
  decoratedTitle: '🐴 Scry Test',
  appAttribute: 'data-scry-test-app',
  appValue: 'true',
  launchAttribute: 'data-scry-test-launch-id',
})

export class CdpOwnershipError extends Error {
  constructor(code, phase, message, evidence, options = {}) {
    super(message, options)
    this.name = 'CdpOwnershipError'
    this.code = code
    this.phase = phase
    this.evidence = evidence
  }
}

export class CdpEvaluationError extends Error {
  constructor({ phase, kind, targetId, elapsedMs, message, cause }) {
    super(message, cause ? { cause } : undefined)
    this.name = 'CdpEvaluationError'
    this.code = 'CDP_EVALUATION_FAILED'
    this.phase = phase
    this.kind = kind
    this.targetId = targetId
    this.elapsedMs = elapsedMs
    // Keep the original classification visible to the ownership retry loop.
    if (cause?.protocolCode !== undefined) this.protocolCode = cause.protocolCode
    if (cause?.cdpTransport === true) this.cdpTransport = true
  }
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

function protocolError(message, code) {
  const error = new Error(message)
  error.protocolCode = code
  return error
}

function transportError(message, kind = 'transport') {
  const error = new Error(message)
  error.cdpTransport = true
  error.cdpKind = kind
  return error
}

function isContextDestroyed(error) {
  if (error?.protocolCode !== -32000) return false
  return /Execution context was destroyed|Cannot find (?:default )?execution context|Cannot find context with specified id|No execution context with given id|Inspected target navigated or closed/i.test(errorText(error))
}

function isTransportError(error) {
  return error?.cdpTransport === true
}

function errorCodes(error, seen = new Set()) {
  if (!error || typeof error !== 'object' || seen.has(error)) return []
  seen.add(error)
  const codes = typeof error.code === 'string' ? [error.code] : []
  if (error.cause) codes.push(...errorCodes(error.cause, seen))
  if (Array.isArray(error.errors)) {
    for (const nested of error.errors) codes.push(...errorCodes(nested, seen))
  }
  return codes
}

function isConnectionRefused(error) {
  return errorCodes(error).includes('ECONNREFUSED')
}

async function fetchJson(url, timeoutMs) {
  let response
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  } catch (error) {
    if (isConnectionRefused(error)) throw error
    const wrapped = transportError(`CDP request transport failed: ${errorText(error)}`)
    wrapped.cause = error
    throw wrapped
  }
  if (!response.ok) throw new Error(`CDP request failed: HTTP ${response.status}`)
  return await response.json()
}

async function listTargetsDefault(port, timeoutMs = DEFAULT_IO_TIMEOUT_MS) {
  const value = await fetchJson(`http://127.0.0.1:${port}/json/list`, timeoutMs)
  return Array.isArray(value) ? value : []
}

async function getBrowserVersionDefault(port, timeoutMs = DEFAULT_IO_TIMEOUT_MS) {
  const value = await fetchJson(`http://127.0.0.1:${port}/json/version`, timeoutMs)
  if (!value || typeof value !== 'object') throw new Error('CDP browser version is not an object')
  return value
}

async function commandDefault(target, method, params, timeoutMs = DEFAULT_IO_TIMEOUT_MS) {
  if (typeof WebSocket !== 'function') throw new Error('WebSocket is unavailable in this Node runtime')
  if (!target?.webSocketDebuggerUrl) throw new Error('CDP target has no webSocketDebuggerUrl')
  return await new Promise((resolve, reject) => {
    const socket = new WebSocket(target.webSocketDebuggerUrl)
    let settled = false
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { socket.close() } catch {}
      callback(value)
    }
    const timer = setTimeout(() => finish(reject, transportError(`CDP ${method} timed out`, 'timeout')), timeoutMs)
    socket.addEventListener('open', () => socket.send(JSON.stringify({ id: 1, method, params })))
    socket.addEventListener('message', (event) => {
      let payload
      try {
        payload = JSON.parse(String(event.data))
      } catch (error) {
        finish(reject, new Error(`invalid CDP response: ${errorText(error)}`))
        return
      }
      if (payload.id !== 1) return
      if (payload.error) {
        finish(reject, protocolError(payload.error.message ?? `CDP ${method} failed`, payload.error.code))
        return
      }
      finish(resolve, payload.result)
    })
    socket.addEventListener('error', () => finish(reject, transportError(`CDP ${method} socket failed`)))
    socket.addEventListener('close', () => {
      if (!settled) finish(reject, transportError(`CDP ${method} socket closed before a response`))
    })
  })
}

function evaluationKind(error) {
  if (isContextDestroyed(error)) return 'context_destroyed'
  if (error?.cdpKind === 'timeout') return 'timeout'
  if (isTransportError(error)) return 'transport'
  if (error?.cdpKind === 'expression') return 'expression'
  if (error?.protocolCode !== undefined) return 'protocol'
  return 'unknown'
}

export async function evaluateCdp(target, expression, options = {}) {
  const phase = options.phase ?? 'evaluate'
  const targetId = target?.id ?? null
  const now = options.now ?? Date.now
  const startedAt = now()
  const command = options.command ?? commandDefault
  try {
    const result = await command(target, 'Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    }, options.timeoutMs ?? DEFAULT_IO_TIMEOUT_MS)
    if (result?.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description
        ?? result.exceptionDetails.text
        ?? 'CDP expression failed'
      const error = new Error(detail)
      error.cdpKind = 'expression'
      throw error
    }
    return result?.result?.value
  } catch (cause) {
    if (cause instanceof CdpEvaluationError) throw cause
    const elapsedMs = Math.max(0, now() - startedAt)
    const kind = evaluationKind(cause)
    throw new CdpEvaluationError({
      phase,
      kind,
      targetId,
      elapsedMs,
      message: `CDP ${phase} failed (${kind}, target=${targetId ?? 'unknown'}, ${elapsedMs}ms): ${errorText(cause)}`,
      cause,
    })
  }
}

function browserPath(version) {
  const raw = version?.webSocketDebuggerUrl
  if (typeof raw !== 'string' || raw.length === 0) throw new Error('CDP browser version has no webSocketDebuggerUrl')
  const path = new URL(raw).pathname
  if (!path.startsWith('/devtools/browser/')) throw new Error(`unexpected CDP browser path: ${path}`)
  return path
}

export async function inspectCdpEndpoint(port, dependencies = {}, timeoutMs = DEFAULT_IO_TIMEOUT_MS) {
  const getBrowserVersion = dependencies.getBrowserVersion ?? getBrowserVersionDefault
  try {
    const version = await getBrowserVersion(port, timeoutMs)
    return { status: 'open', browserPath: browserPath(version), error: null }
  } catch (error) {
    if (isConnectionRefused(error)) return { status: 'closed', browserPath: null, error: null }
    return { status: 'unreachable', browserPath: null, error: errorText(error) }
  }
}

export async function cdpEndpointOpen(port) {
  const result = await inspectCdpEndpoint(port)
  if (result.status === 'open') return true
  if (result.status === 'closed') return false
  throw new Error(`CDP endpoint state is unknown: ${result.error}`)
}

function pageTargets(targets) {
  return targets.filter((target) => target?.type === 'page')
}

function targetSummary(target) {
  return {
    id: target?.id ?? null,
    type: target?.type ?? null,
    url: target?.url ?? null,
    title: target?.title ?? null,
    hasDebuggerUrl: Boolean(target?.webSocketDebuggerUrl),
  }
}

function normalizeTitle(rawTitle) {
  if (rawTitle === DEFAULT_SCRY_OWNERSHIP_SPEC.title) {
    return { canonicalTitle: DEFAULT_SCRY_OWNERSHIP_SPEC.title, titleDecoration: null }
  }
  if (rawTitle === DEFAULT_SCRY_OWNERSHIP_SPEC.decoratedTitle) {
    return { canonicalTitle: DEFAULT_SCRY_OWNERSHIP_SPEC.title, titleDecoration: 'browser-harness' }
  }
  return { canonicalTitle: null, titleDecoration: null }
}

function snapshotExpression() {
  return `(() => {
    const root = document.documentElement
    return {
      url: window.location.href,
      title: document.title,
      readyState: document.readyState,
      hasDocumentElement: root !== null,
      hasScry: typeof window.scry === 'object' && window.scry !== null,
      rootMounted: Boolean(document.getElementById('root')?.childElementCount),
      appMarker: root?.getAttribute(${JSON.stringify(DEFAULT_SCRY_OWNERSHIP_SPEC.appAttribute)}) ?? null,
      launchId: root?.getAttribute(${JSON.stringify(DEFAULT_SCRY_OWNERSHIP_SPEC.launchAttribute)}) ?? null
    }
  })()`
}

function claimExpression(expectedUrl, launchId) {
  return `(() => {
    const expectedUrl = ${JSON.stringify(expectedUrl)}
    const expectedLaunchId = ${JSON.stringify(launchId)}
    const root = document.documentElement
    const ready = window.location.href === expectedUrl
      && document.readyState === 'complete'
      && root !== null
      && typeof window.scry === 'object'
      && window.scry !== null
      && Boolean(document.getElementById('root')?.childElementCount)
    if (ready) {
      document.title = ${JSON.stringify(DEFAULT_SCRY_OWNERSHIP_SPEC.title)}
      root.setAttribute(${JSON.stringify(DEFAULT_SCRY_OWNERSHIP_SPEC.appAttribute)}, ${JSON.stringify(DEFAULT_SCRY_OWNERSHIP_SPEC.appValue)})
      root.setAttribute(${JSON.stringify(DEFAULT_SCRY_OWNERSHIP_SPEC.launchAttribute)}, expectedLaunchId)
    }
    return {
      accepted: ready,
      url: window.location.href,
      title: document.title,
      readyState: document.readyState,
      hasDocumentElement: root !== null,
      hasScry: typeof window.scry === 'object' && window.scry !== null,
      rootMounted: Boolean(document.getElementById('root')?.childElementCount),
      appMarker: root?.getAttribute(${JSON.stringify(DEFAULT_SCRY_OWNERSHIP_SPEC.appAttribute)}) ?? null,
      launchId: root?.getAttribute(${JSON.stringify(DEFAULT_SCRY_OWNERSHIP_SPEC.launchAttribute)}) ?? null
    }
  })()`
}

function expectedEvidence(expectedUrl, launchId, expectedBrowserPath) {
  return {
    url: expectedUrl,
    title: DEFAULT_SCRY_OWNERSHIP_SPEC.title,
    appMarker: DEFAULT_SCRY_OWNERSHIP_SPEC.appValue,
    launchId,
    browserPath: expectedBrowserPath ?? null,
  }
}

function isReady(actual, expectedUrl) {
  return Boolean(
    actual
    && actual.url === expectedUrl
    && actual.readyState === 'complete'
    && actual.hasDocumentElement === true
    && actual.hasScry === true
    && actual.rootMounted === true
  )
}

function isOwned(actual, expectedUrl, launchId) {
  return Boolean(
    isReady(actual, expectedUrl)
    && normalizeTitle(actual.title).canonicalTitle === DEFAULT_SCRY_OWNERSHIP_SPEC.title
    && actual.appMarker === DEFAULT_SCRY_OWNERSHIP_SPEC.appValue
    && actual.launchId === launchId
  )
}

function observation(status, options, pages, actual = null, extra = {}) {
  const normalized = actual ? normalizeTitle(actual.title) : { canonicalTitle: null, titleDecoration: null }
  return {
    schemaVersion: 2,
    status,
    port: options.port,
    expected: expectedEvidence(options.expectedUrl, options.launchId, options.expectedBrowserPath),
    actual: {
      browserPath: extra.actualBrowserPath ?? null,
      targetId: pages[0]?.id ?? null,
      targetUrl: pages[0]?.url ?? null,
      pageTargetCount: pages.length,
      ...(actual ?? {}),
      ...normalized,
    },
    targets: pages.map(targetSummary),
    ...(extra.error ? { error: extra.error } : {}),
  }
}

function classify(actual, expectedUrl, launchId) {
  if (!isReady(actual, expectedUrl)) return 'renderer_not_ready'
  if (actual.appMarker !== DEFAULT_SCRY_OWNERSHIP_SPEC.appValue || actual.launchId !== launchId) return 'marker_mismatch'
  if (normalizeTitle(actual.title).canonicalTitle !== DEFAULT_SCRY_OWNERSHIP_SPEC.title) return 'title_mismatch'
  return 'verified'
}

function errorStatus(error) {
  if (isConnectionRefused(error)) return 'cdp_closed'
  if (isContextDestroyed(error)) return 'context_unstable'
  if (isTransportError(error)) return 'cdp_unreachable'
  return 'protocol_error'
}

export async function inspectRendererOwnership(options, dependencies = {}) {
  const listTargets = dependencies.listTargets ?? listTargetsDefault
  const getBrowserVersion = dependencies.getBrowserVersion ?? getBrowserVersionDefault
  const evaluate = dependencies.evaluate ?? evaluateCdp
  const ioTimeoutMs = options.ioTimeoutMs ?? DEFAULT_IO_TIMEOUT_MS
  let actualBrowserPath = null

  if (options.expectedBrowserPath) {
    try {
      actualBrowserPath = browserPath(await getBrowserVersion(options.port, ioTimeoutMs))
    } catch (error) {
      return {
        target: null,
        evidence: observation(errorStatus(error), options, [], null, { error: errorText(error) }),
      }
    }
    if (actualBrowserPath !== options.expectedBrowserPath) {
      return {
        target: null,
        evidence: observation('browser_identity_mismatch', options, [], null, { actualBrowserPath }),
      }
    }
  }

  let targets
  try {
    targets = await listTargets(options.port, ioTimeoutMs)
  } catch (error) {
    return {
      target: null,
      evidence: observation(errorStatus(error), options, [], null, { actualBrowserPath, error: errorText(error) }),
    }
  }
  const pages = pageTargets(targets)
  if (pages.length === 0) return { target: null, evidence: observation('target_missing', options, pages, null, { actualBrowserPath }) }
  if (pages.length !== 1) return { target: null, evidence: observation('target_ambiguous', options, pages, null, { actualBrowserPath }) }
  const target = pages[0]
  if (target.url !== options.expectedUrl) return { target, evidence: observation('target_not_final', options, pages, null, { actualBrowserPath }) }
  if (!target.id || !target.webSocketDebuggerUrl) {
    return { target, evidence: observation('renderer_not_ready', options, pages, null, { actualBrowserPath }) }
  }
  if (options.expectedTargetId && target.id !== options.expectedTargetId) {
    return { target, evidence: observation('target_drift', options, pages, null, { actualBrowserPath }) }
  }

  let actual
  try {
    actual = await evaluate(target, snapshotExpression(), { phase: 'inspect', timeoutMs: ioTimeoutMs })
  } catch (error) {
    return {
      target,
      evidence: observation(errorStatus(error), options, pages, null, { actualBrowserPath, error: errorText(error) }),
    }
  }

  if (options.expectedBrowserPath) {
    try {
      const confirmedBrowserPath = browserPath(await getBrowserVersion(options.port, ioTimeoutMs))
      if (confirmedBrowserPath !== options.expectedBrowserPath) {
        return {
          target: null,
          evidence: observation('browser_identity_mismatch', options, pages, actual, { actualBrowserPath: confirmedBrowserPath }),
        }
      }
    } catch (error) {
      return {
        target: null,
        evidence: observation(errorStatus(error), options, pages, actual, { actualBrowserPath, error: errorText(error) }),
      }
    }
  }

  return {
    target,
    evidence: observation(classify(actual, options.expectedUrl, options.launchId), options, pages, actual, { actualBrowserPath }),
  }
}

const READ_ONLY_RETRYABLE = new Set([
  'cdp_unreachable',
  'context_unstable',
  'target_missing',
  'target_not_final',
  'renderer_not_ready',
])

export async function waitForRendererOwnership(options, dependencies = {}) {
  const sleep = dependencies.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)))
  const now = dependencies.now ?? Date.now
  const timeoutMs = options.timeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS
  const pollMs = options.pollMs ?? 100
  const deadline = now() + timeoutMs
  let polls = 0
  let last
  while (now() < deadline) {
    polls += 1
    const remaining = Math.max(100, deadline - now())
    last = await inspectRendererOwnership({
      ...options,
      ioTimeoutMs: Math.min(DEFAULT_IO_TIMEOUT_MS, remaining),
    }, dependencies)
    if (last.evidence.status === 'verified' || !READ_ONLY_RETRYABLE.has(last.evidence.status)) {
      return {
        ...last,
        evidence: { ...last.evidence, verification: { polls, timeoutMs } },
      }
    }
    await sleep(Math.min(pollMs, Math.max(0, deadline - now())))
  }
  return {
    target: last?.target ?? null,
    evidence: {
      ...(last?.evidence ?? observation('cdp_unreachable', options, [], null, { error: 'no verification sample completed' })),
      status: 'verification_unavailable',
      verification: {
        polls,
        timeoutMs,
        lastStatus: last?.evidence?.status ?? null,
      },
    },
  }
}

export async function claimRendererOwnership({
  port,
  expectedUrl,
  expectedBrowserPath,
  launchId,
  timeoutMs = 30_000,
  pollMs = 250,
  verifyDelayMs = 500,
  verifyTimeoutMs = DEFAULT_VERIFY_TIMEOUT_MS,
  isAlive = () => true,
}, dependencies = {}) {
  const evaluate = dependencies.evaluate ?? evaluateCdp
  const sleep = dependencies.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)))
  const now = dependencies.now ?? Date.now
  const wallNowIso = dependencies.wallNowIso ?? (() => new Date().toISOString())
  const deadline = now() + timeoutMs
  const baseOptions = { port, expectedUrl, expectedBrowserPath, launchId }
  const timing = {
    firstPageSeenAt: null,
    finalTargetSeenAt: null,
    claimedAt: null,
    verifiedAt: null,
    verifyDelayMs,
  }
  const attempts = { polls: 0, evaluations: 0, contextDestroyed: 0, transportRetries: 0 }
  let lastEvidence = observation('target_missing', baseOptions, [])

  const finalize = (evidence) => ({ ...evidence, timing, attempts })
  const fail = (code, phase, message, evidence = lastEvidence, cause) => {
    throw new CdpOwnershipError(code, phase, message, finalize(evidence), cause ? { cause } : {})
  }

  const delayedVerify = async (targetId) => {
    const remainingBeforeDelay = deadline - now()
    if (remainingBeforeDelay <= verifyDelayMs) {
      fail('CDP_TARGET_TIMEOUT', 'verify', `Scry renderer ownership was not ready within ${timeoutMs}ms`)
    }
    await sleep(verifyDelayMs)
    const remaining = deadline - now()
    const verified = await waitForRendererOwnership({
      ...baseOptions,
      expectedTargetId: targetId,
      timeoutMs: Math.max(1, Math.min(verifyTimeoutMs, remaining)),
      pollMs: 100,
    }, dependencies)
    if (verified.evidence.status !== 'verified') {
      const unavailable = verified.evidence.status === 'verification_unavailable'
      fail(
        unavailable ? 'CDP_VERIFICATION_UNAVAILABLE' : 'CDP_OWNERSHIP_UNSTABLE',
        'verify',
        `renderer ownership delayed verification failed: ${verified.evidence.status}`,
        verified.evidence,
      )
    }
    if (!isAlive()) fail('CDP_ABORTED', 'verify', 'Scry Test exited after renderer ownership verification', verified.evidence)
    timing.verifiedAt = wallNowIso()
    return { target: verified.target, evidence: finalize(verified.evidence) }
  }

  while (now() < deadline) {
    if (!isAlive()) fail('CDP_ABORTED', 'claim', 'Scry Test exited before renderer ownership was verified')
    attempts.polls += 1
    const remaining = Math.max(100, deadline - now())
    const probe = await inspectRendererOwnership({
      ...baseOptions,
      ioTimeoutMs: Math.min(DEFAULT_IO_TIMEOUT_MS, remaining),
    }, dependencies)
    lastEvidence = probe.evidence
    if (probe.evidence.actual.pageTargetCount > 0 && timing.firstPageSeenAt === null) timing.firstPageSeenAt = wallNowIso()
    if (probe.evidence.actual.targetUrl === expectedUrl && timing.finalTargetSeenAt === null) timing.finalTargetSeenAt = wallNowIso()

    if (probe.evidence.status === 'verified') {
      timing.claimedAt ??= wallNowIso()
      return await delayedVerify(probe.evidence.actual.targetId)
    }
    if (probe.evidence.status === 'target_ambiguous') {
      fail('CDP_TARGET_AMBIGUOUS', 'claim', `expected one Scry renderer page, got ${probe.evidence.actual.pageTargetCount}`)
    }
    if (probe.evidence.status === 'browser_identity_mismatch') {
      fail('CDP_BROWSER_IDENTITY_MISMATCH', 'claim', 'CDP browser identity does not match this launch userData')
    }
    if (probe.evidence.status === 'protocol_error') {
      fail('CDP_PROTOCOL_ERROR', 'claim', `CDP ownership probe failed: ${probe.evidence.error ?? 'protocol error'}`)
    }
    if (probe.evidence.status === 'context_unstable') attempts.contextDestroyed += 1
    if (probe.evidence.status === 'cdp_unreachable') attempts.transportRetries += 1

    const actual = probe.evidence.actual
    if (probe.target && isReady(actual, expectedUrl)) {
      let claimed
      try {
        attempts.evaluations += 1
        claimed = await evaluate(probe.target, claimExpression(expectedUrl, launchId), {
          phase: 'claim',
          timeoutMs: Math.min(DEFAULT_IO_TIMEOUT_MS, remaining),
        })
      } catch (error) {
        if (isContextDestroyed(error)) {
          attempts.contextDestroyed += 1
          lastEvidence = observation('context_unstable', baseOptions, [probe.target], null, { error: errorText(error) })
          await sleep(pollMs)
          continue
        }
        if (isTransportError(error)) {
          attempts.transportRetries += 1
          lastEvidence = observation('cdp_unreachable', baseOptions, [probe.target], null, { error: errorText(error) })
          await sleep(pollMs)
          continue
        }
        lastEvidence = observation('protocol_error', baseOptions, [probe.target], null, { error: errorText(error) })
        fail('CDP_PROTOCOL_ERROR', 'claim', `CDP ownership claim failed: ${errorText(error)}`, lastEvidence, error)
      }
      lastEvidence = observation(claimed?.accepted ? 'claimed' : 'renderer_not_ready', baseOptions, [probe.target], claimed, {
        actualBrowserPath: probe.evidence.actual.browserPath,
      })
      if (!claimed?.accepted) {
        await sleep(pollMs)
        continue
      }
      if (!isOwned(claimed, expectedUrl, launchId)) {
        fail('CDP_OWNERSHIP_REJECTED', 'claim', 'renderer rejected the ownership marker')
      }
      timing.claimedAt = wallNowIso()
      return await delayedVerify(probe.target.id)
    }

    if (probe.evidence.status === 'cdp_closed'
      || probe.evidence.status === 'cdp_unreachable'
      || probe.evidence.status === 'context_unstable'
      || probe.evidence.status === 'target_missing'
      || probe.evidence.status === 'target_not_final'
      || probe.evidence.status === 'renderer_not_ready') {
      await sleep(pollMs)
      continue
    }
    fail('CDP_OWNERSHIP_REJECTED', 'claim', `renderer ownership probe was rejected: ${probe.evidence.status}`)
  }

  const code = attempts.contextDestroyed > 0 && lastEvidence.status === 'context_unstable'
    ? 'CDP_CONTEXT_UNSTABLE'
    : 'CDP_TARGET_TIMEOUT'
  fail(code, 'claim', `Scry renderer ownership was not ready within ${timeoutMs}ms`)
}
