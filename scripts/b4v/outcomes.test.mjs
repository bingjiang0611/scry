import { describe, expect, it } from 'vitest'
import { classifySecondStart, classifyTrustStart, continuityVerdict, exclusionHolds, unconfirmedWriteVerdict } from './outcomes.mjs'

const items = (...ids) => ids.map((id) => ({ id }))

describe('b4v continuity across an App restart', () => {
  it('complete when every earlier item is present exactly once', () => {
    expect(continuityVerdict({ before: items('a', 'b'), after: items('a', 'b', 'c'), health: { degraded: false } }))
      .toMatchObject({ verdict: 'complete', pass: true })
  })

  it('a silent gap fails; the same gap with a degraded stream passes as honest', () => {
    const silent = continuityVerdict({ before: items('a', 'b', 'c'), after: items('c'), health: { degraded: false, skippedEvents: 0 } })
    expect(silent).toMatchObject({ verdict: 'gap-silent', pass: false, missingCount: 2 })
    expect(continuityVerdict({ before: items('a', 'b', 'c'), after: items('c'), health: { degraded: true } }))
      .toMatchObject({ verdict: 'gap-flagged', pass: true })
    expect(continuityVerdict({ before: items('a', 'b'), after: items('b'), health: { skippedEvents: 3 } }).verdict).toBe('gap-flagged')
  })

  it('a replayed item or an empty view fails', () => {
    expect(continuityVerdict({ before: items('a'), after: items('a', 'a'), health: null })).toMatchObject({ verdict: 'duplicated', pass: false })
    expect(continuityVerdict({ before: items('a'), after: [], health: { degraded: true } })).toMatchObject({ verdict: 'empty', pass: false })
  })
})

describe('b4v second start on the same profile', () => {
  it('refused when the start fails, queued when it waits for the first, parallel otherwise', () => {
    expect(classifySecondStart({ startError: 'busy' })).toEqual({ outcome: 'refused', reason: 'busy' })
    expect(classifySecondStart({ whileFirstLive: { done: true, error: 'session busy', output: false } }).outcome).toBe('refused')
    expect(classifySecondStart({ whileFirstLive: { done: false, output: false }, afterFirstStopped: { done: true, output: true } }).outcome).toBe('queued')
    expect(classifySecondStart({ whileFirstLive: { done: true, error: null, output: true } }).outcome).toBe('parallel')
    expect(classifySecondStart({ whileFirstLive: { done: false, output: true } }).outcome).toBe('unknown')
  })

  it('a start error the daemon recorded anyway is not credited as a refusal', () => {
    const classified = classifySecondStart({ startError: 'daemon_run_not_bound', recordedDespiteError: true })
    expect(classified.outcome).toBe('unknown')
    expect(exclusionHolds(classified)).toBe(false)
  })

  it('only refused and queued satisfy the exclusion', () => {
    expect(exclusionHolds({ outcome: 'refused' })).toBe(true)
    expect(exclusionHolds({ outcome: 'queued' })).toBe(true)
    expect(exclusionHolds({ outcome: 'parallel' })).toBe(false)
    expect(exclusionHolds({ outcome: 'unknown' })).toBe(false)
  })
})

describe('b4v trust gate outcome', () => {
  it('credits a refusal only when it names the expected cause', () => {
    expect(classifyTrustStart({ startError: 'MCP 配置无法安全执行：MCP server b4v 使用可改变执行目标的 env：NODE_OPTIONS', expectCause: /NODE_OPTIONS/ }).outcome).toBe('refused')
    expect(classifyTrustStart({ startError: 'daemon_unavailable', expectCause: /NODE_OPTIONS/ }).outcome).toBe('failed')
    expect(classifyTrustStart({ run: { done: true, error: 'NODE_OPTIONS', output: false }, expectCause: /NODE_OPTIONS/ }).outcome).toBe('refused')
    expect(classifyTrustStart({ run: { done: true, error: null, output: true } })).toMatchObject({ outcome: 'settled', providerOutput: true })
    expect(classifyTrustStart({ run: { done: null } }).outcome).toBe('unknown')
  })
})

describe('b4v unconfirmed write', () => {
  it('passes only when the App says it does not know', () => {
    expect(unconfirmedWriteVerdict({ state: 'rejected', error: "Error invoking remote method 'agent:stop': Error: daemon_outcome_unknown" }))
      .toMatchObject({ pass: true, verdict: 'daemon_outcome_unknown' })
    expect(unconfirmedWriteVerdict({ state: 'rejected', error: 'daemon_stop_not_confirmed' }).pass).toBe(true)
    expect(unconfirmedWriteVerdict({ state: 'resolved', value: true })).toMatchObject({ pass: false, verdict: 'claimed-outcome' })
    expect(unconfirmedWriteVerdict({ state: 'resolved', value: false }).pass).toBe(false)
    expect(unconfirmedWriteVerdict({ state: 'rejected', error: 'daemon_run_unknown' })).toMatchObject({ pass: false, verdict: 'other-error' })
    expect(unconfirmedWriteVerdict({ state: 'pending' }).pass).toBe(false)
  })
})
