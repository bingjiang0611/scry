import { describe, expect, it, vi } from 'vitest'
import type { CapabilityEnvelope, ProviderCommand, ProviderContext } from '../shared/provider'
import { SCRY_WORKFLOW_COMMAND_ID } from '../shared/task-command'
import { createDesktopTaskEntry } from './desktop-task-entry'

const conversation = { id: '00000000-0000-4000-8000-000000000001', cwd: '/synthetic/commands' }
const target = { providerId: 'pi' as const, agentProfileId: 'pi:0000000000000001' }
function fixture() {
  const resolveContinuationKey = vi.fn(async (_context: ProviderContext) => 'native-one')
  const discoverCommands = vi.fn(async (context: ProviderContext): Promise<CapabilityEnvelope<ProviderCommand[]>> => ({
    ...context, state: 'ready', mode: 'read', data: [{ name: 'review', description: 'fixture' }]
  }))
  const notMetadata = () => { throw new Error('metadata must not invoke task/admission/dispatch services') }
  const deps = { store: vi.fn(notMetadata), service: vi.fn(notMetadata), getUserData: vi.fn(notMetadata),
    resolveContinuationKey, discoverCommands }
  return { deps, entry: createDesktopTaskEntry(deps) }
}

describe('production desktop entry command catalogue boundary (mocked native discovery)', () => {
  it('reads known Scry metadata without resolving or launching a native provider', async () => {
    const { entry, deps } = fixture()
    const result = await entry.commands(conversation)
    expect(result.provider).toMatchObject({ state: 'unknown', complete: false })
    expect(result.commands.map(command => command.id)).toEqual([SCRY_WORKFLOW_COMMAND_ID])
    for (const dependency of Object.values(deps)) expect(dependency).not.toHaveBeenCalled()
  })

  it('is lazy and uses only Main-owned workspace/profile for discovery, not requested permissions', async () => {
    const { entry, deps } = fixture()
    expect(deps.discoverCommands).not.toHaveBeenCalled()
    const result = await entry.commands(conversation, { ...target, permissionMode: 'full_access',
      model: { id: 'fixture-model', providerId: 'pi' }, effort: 'high' })
    const expected = { ...target, cwd: conversation.cwd }
    expect(deps.resolveContinuationKey).toHaveBeenNthCalledWith(1, expected)
    expect(deps.resolveContinuationKey).toHaveBeenNthCalledWith(2, expected)
    expect(deps.discoverCommands).toHaveBeenCalledExactlyOnceWith(expected)
    expect(result.provider.complete).toBe(true)
    expect(result.commands[1].origin).toEqual({ kind: 'provider', ...target })
    for (const service of [deps.store, deps.service, deps.getUserData]) expect(service).not.toHaveBeenCalled()
  })

  it('rejects renderer-claimed source, authoring or workspace fields before discovery', async () => {
    const { entry, deps } = fixture()
    for (const fields of [{ source: 'scry_workflow' }, { origin: 'human' }, { authoringSchema: {} }, { cwd: '/unowned' }]) {
      await expect(entry.commands(conversation, { ...target, ...fields })).rejects.toThrow()
    }
    expect(deps.discoverCommands).not.toHaveBeenCalled()
    expect(deps.resolveContinuationKey).not.toHaveBeenCalled()
  })

  it('discards metadata after native identity changes without retrying or sending a task', async () => {
    const { entry, deps } = fixture()
    deps.resolveContinuationKey.mockResolvedValueOnce('native-one').mockResolvedValueOnce('native-two')
    const result = await entry.commands(conversation, target)
    expect(result.provider).toMatchObject({ state: 'unknown', complete: false })
    expect(result.commands.map(command => command.id)).toEqual([SCRY_WORKFLOW_COMMAND_ID])
    expect(deps.discoverCommands).toHaveBeenCalledTimes(1)
    expect(deps.service).not.toHaveBeenCalled()
  })

  it('preserves discovery failure as unknown evidence instead of an available empty directory', async () => {
    const { entry, deps } = fixture()
    deps.discoverCommands.mockRejectedValueOnce(new Error('synthetic native catalogue failure'))
    const result = await entry.commands(conversation, target)
    expect(result.provider).toMatchObject({ state: 'unknown', complete: false, reason: 'Error: synthetic native catalogue failure' })
    expect(result.commands.map(command => command.id)).toEqual([SCRY_WORKFLOW_COMMAND_ID])
    expect(deps.discoverCommands).toHaveBeenCalledTimes(1)
    expect(deps.service).not.toHaveBeenCalled()
  })

  it('keeps a bounded and explicitly truncated failure excerpt, without another discovery attempt', async () => {
    const { entry, deps } = fixture()
    deps.resolveContinuationKey.mockRejectedValueOnce(new Error('x'.repeat(5000)))
    const result = await entry.commands(conversation, target)
    expect(result.provider.reason).toHaveLength(4096)
    expect(result.provider.reasonTruncated).toBe(true)
    expect(result.provider.complete).toBe(false)
    expect(deps.discoverCommands).not.toHaveBeenCalled()
    expect(deps.service).not.toHaveBeenCalled()
  })
})
