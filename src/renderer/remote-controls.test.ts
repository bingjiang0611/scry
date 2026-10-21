import { describe, expect, it } from 'vitest'
import type { RemoteProviderRef } from '../main/remote/remote-gateway'
import type { AgentRunControls } from '../shared/runtime'
import { remoteControlsValid } from './components/RemoteChat'

const provider: RemoteProviderRef = {
  id: 'pi', label: 'Pi', available: true,
  models: [{ id: 'model', providerId: 'upstream', label: 'Model', efforts: [{ id: 'high', label: 'High' }] }],
  permissions: [{ id: 'full_access', label: 'Full access' }]
}
const controls: AgentRunControls = { model: { id: 'model', providerId: 'upstream' }, effort: 'high', permissionMode: 'full_access' }

describe('remote selected controls readiness', () => {
  it('accepts only observed matching model, effort, and permission', () => {
    expect(remoteControlsValid(provider, controls)).toBe(true)
    expect(remoteControlsValid(provider, { ...controls, model: { id: 'model', providerId: 'other' } })).toBe(false)
    expect(remoteControlsValid(provider, { ...controls, effort: 'removed' })).toBe(false)
    expect(remoteControlsValid(provider, { ...controls, permissionMode: 'default' })).toBe(false)
  })
  it('does not turn a missing, failed or metadata-only catalog into defaults', () => {
    expect(remoteControlsValid(undefined, controls)).toBe(false)
    expect(remoteControlsValid({ ...provider, available: false }, controls)).toBe(false)
    expect(remoteControlsValid({ id: 'pi', label: 'Pi', available: true }, controls)).toBe(false)
  })
  it('blocks a previously selected model after refresh instead of dropping it from submit', () => {
    expect(remoteControlsValid({ ...provider, models: [] }, controls)).toBe(false)
    expect(controls.model).toEqual({ id: 'model', providerId: 'upstream' })
  })
  it('keeps legacy native-default execution when its original contract exposes no controls', () => {
    expect(remoteControlsValid({ id: 'claude', label: 'Claude', available: true }, { permissionMode: 'default' })).toBe(true)
    expect(remoteControlsValid({ id: 'claude', label: 'Claude', available: true }, { permissionMode: 'full_access' })).toBe(false)
  })
})
