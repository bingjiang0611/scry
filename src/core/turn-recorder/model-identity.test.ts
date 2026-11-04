import { describe, expect, it } from 'vitest'
import type { TraceEvent } from '../../shared/trace'
import { resolveModelIdentity } from './recorder'
import { lifecycleTraceEvents } from './recorder-lifecycle-events'

const modelEvent = (complete: boolean, ids: string[], modelTier?: string): TraceEvent => ({
  id: `provider-model-${ids.join('-')}-${complete}-${modelTier ?? ''}`,
  ts: '2026-01-01T00:00:00.000Z',
  runId: 'r',
  kind: 'harness',
  stage: 'provider_model',
  runtimeMetadata: { modelIds: ids, ...(modelTier ? { modelTier } : {}), complete }
})

describe('resolveModelIdentity', () => {
  it('accepts one complete provider observation as fact with its provenance', () => {
    expect(resolveModelIdentity([modelEvent(true, ['gpt-6-astra'])], new Set(['gpt-6-astra']), undefined))
      .toEqual({ model: 'gpt-6-astra', status: 'observed', source: 'provider_model_event' })
  })

  it('labels a billed usage model as observed but from the usage event', () => {
    expect(resolveModelIdentity([], new Set(), 'claude-opus-4-6'))
      .toEqual({ model: 'claude-opus-4-6', status: 'observed', source: 'usage_event' })
  })

  it('retains a provider logical model tier without inventing a concrete model id', () => {
    expect(resolveModelIdentity([modelEvent(true, [], 'Ultimate')], new Set(), undefined))
      .toEqual({ modelTier: 'Ultimate', status: 'observed', source: 'provider_model_event' })
  })

  it('retains a logical tier alongside one authoritative native model id', () => {
    expect(resolveModelIdentity([modelEvent(true, ['qoder-native-1'], 'Ultimate')], new Set(['qoder-native-1']), undefined))
      .toEqual({ model: 'qoder-native-1', modelTier: 'Ultimate', status: 'observed', source: 'provider_model_event' })
  })

  it.each([
    { payload: {}, complete: true },
    { payload: { model_ids: ['native-model'], model_ids_complete: false }, complete: false },
    { payload: { model_ids: [null], model_ids_complete: true }, complete: false },
    { payload: { model_ids_complete: false }, complete: false }
  ])('a Qoder tier never upgrades explicit incomplete or invalid model evidence: %j', ({ payload, complete }) => {
    const events = lifecycleTraceEvents({ provider: 'qoder', event: 'Stop', runId: 'r', captureOutput: false,
      payload: { session_id: 's', model: 'Ultimate', ...payload } })
    expect(events.find(event => event.stage === 'provider_model')?.runtimeMetadata)
      .toMatchObject({ modelTier: 'Ultimate', complete })
  })

  it('reports an incomplete observation instead of dropping the model silently', () => {
    const result = resolveModelIdentity([modelEvent(false, ['gpt-6-astra'])], new Set(['gpt-6-astra']), undefined)
    expect(result.status).toBe('incomplete')
    expect(result.model).toBeUndefined()
    expect(result.source).toBeUndefined()
    expect(result.omissionReason).toContain('incomplete')
  })

  it('reports an empty observation as incomplete rather than unobserved', () => {
    const result = resolveModelIdentity([modelEvent(false, [])], new Set(), undefined)
    expect(result.status).toBe('incomplete')
    expect(result.omissionReason).toContain('no usable model id')
  })

  it('surfaces several ids in one turn as a conflict and never picks one', () => {
    const events = [modelEvent(true, ['gpt-6-astra']), modelEvent(true, ['claude-opus-4-6'])]
    const result = resolveModelIdentity(events, new Set(['gpt-6-astra', 'claude-opus-4-6']), undefined)
    expect(result.status).toBe('conflict')
    expect(result.model).toBeUndefined()
    expect(result.omissionReason).toContain('2 distinct model ids')
  })

  it('never falls back to the usage model once provider events exist', () => {
    const result = resolveModelIdentity([modelEvent(false, ['gpt-6-astra'])], new Set(['gpt-6-astra']), 'claude-opus-4-6')
    expect(result.model).toBeUndefined()
    expect(result.status).toBe('incomplete')
  })

  it('reports a fully unobserved model with a reason instead of an empty field', () => {
    const result = resolveModelIdentity([], new Set(), undefined)
    expect(result).toEqual({
      status: 'unobserved',
      omissionReason: 'provider exposed no model id to lifecycle hooks or usage events'
    })
  })

  it('treats an empty usage model string as unobserved, not as an observed empty model', () => {
    expect(resolveModelIdentity([], new Set(), '').status).toBe('unobserved')
  })
})
