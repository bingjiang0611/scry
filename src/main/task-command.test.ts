import { describe, expect, it } from 'vitest'
import type { CapabilityEnvelope, ProviderCommand } from '../shared/provider'
import { SCRY_WORKFLOW_COMMAND_ID } from '../shared/task-command'
import { createTaskCommandCatalog, MAX_TASK_COMMANDS, MAX_TASK_COMMAND_BYTES, resolveTaskCommand, type TaskCommandContext } from './task-command'

const context: TaskCommandContext = {
  conversationId: 'fixture-conversation', cwd: '/synthetic/commands',
  target: { providerId: 'pi', agentProfileId: 'pi-one', continuationKey: 'native-one' }
}
const templateId = '00000000-0000-4000-8000-000000000001'
function envelope(data: ProviderCommand[] | null = []): CapabilityEnvelope<ProviderCommand[]> {
  return { providerId: 'pi', agentProfileId: 'pi-one', cwd: context.cwd,
    mode: 'read', state: 'ready', data, observedAt: 123 }
}
const catalog = (data: ProviderCommand[] = []) => createTaskCommandCatalog(context, envelope(data))
function scry(input: string) {
  const result = resolveTaskCommand(`/scry-workflow ${input}`, catalog(), SCRY_WORKFLOW_COMMAND_ID)
  if (result.kind !== 'scry_workflow') throw new Error('expected Scry command')
  return result.command
}

describe('main-owned task command source and grammar', () => {
  it('distinguishes an available empty catalogue from unavailable/partial evidence', () => {
    const ready = catalog()
    expect(ready.provider).toEqual({ state: 'ready', complete: true, reason: undefined, observedAt: 123 })
    expect(resolveTaskCommand('/scry-workflow list', ready).kind).toBe('scry_workflow')
    for (const unavailable of [
      { ...envelope(null), state: 'unsupported' as const, mode: 'none' as const, reason: 'not exposed' },
      { ...envelope([]), state: 'degraded' as const, reason: 'partial evidence' }
    ]) {
      const partial = createTaskCommandCatalog(context, unavailable)
      expect(partial.provider.complete).toBe(false)
      expect(partial.provider.reason).toBe(unavailable.reason)
      expect(() => resolveTaskCommand('/scry-workflow list', partial)).toThrow()
      expect(resolveTaskCommand('/scry-workflow list', partial, SCRY_WORKFLOW_COMMAND_ID).kind).toBe('scry_workflow')
    }
  })

  it('disambiguates Scry/Provider namespace collisions by Main IDs without hijacking native commands', () => {
    const entries = catalog([{ name: '/scry-workflow', description: 'native command', source: 'builtin' }])
    expect(entries.commands.map(command => command.origin.kind)).toEqual(['scry_workflow', 'provider'])
    expect(new Set(entries.commands.map(command => command.id)).size).toBe(2)
    expect(() => resolveTaskCommand('/scry-workflow mode auto', entries)).toThrow()
    expect(resolveTaskCommand('/scry-workflow mode auto', entries, SCRY_WORKFLOW_COMMAND_ID).kind).toBe('scry_workflow')
    const native = resolveTaskCommand('/scry-workflow not-a-scry-operation', entries, entries.commands[1].id)
    expect(native.kind).toBe('provider')
    expect(() => resolveTaskCommand('/another list', entries, SCRY_WORKFLOW_COMMAND_ID)).toThrow()
  })

  it('ignores provider-supplied IDs/origins instead of accepting claimed Scry authority', () => {
    const forged = Object.assign({ name: 'danger', description: 'fixture', source: 'custom' as const },
      { id: SCRY_WORKFLOW_COMMAND_ID, origin: { kind: 'scry_workflow' } })
    const entries = catalog([forged])
    expect(entries.commands[1].id).toMatch(/^provider:[a-f0-9]{64}$/)
    expect(entries.commands[1].origin).toEqual({ kind: 'provider', providerId: 'pi', agentProfileId: 'pi-one' })
    expect(entries.commands[1].nativeSource).toBe('custom')
    expect(() => resolveTaskCommand('/danger', entries, SCRY_WORKFLOW_COMMAND_ID)).toThrow()
    expect(resolveTaskCommand('/danger', entries, entries.commands[1].id).kind).toBe('provider')
  })

  it('binds provider IDs to conversation/workspace/native identity and metadata, not read time', () => {
    const rows = [{ name: 'review', description: 'fixture', argumentHint: '<goal>' }]
    const first = catalog(rows)
    const oldId = first.commands[1].id
    expect(createTaskCommandCatalog(context, { ...envelope(rows), observedAt: 456 }).commands[1].id).toBe(oldId)
    const contexts = [
      { ...context, conversationId: 'other-conversation' },
      { ...context, cwd: '/synthetic/other' },
      { ...context, target: { ...context.target!, continuationKey: 'native-two' } },
      { ...context, target: { ...context.target!, agentProfileId: 'pi-two' } }
    ]
    for (const changed of contexts) {
      const next = createTaskCommandCatalog(changed, { ...envelope(rows), cwd: changed.cwd, agentProfileId: changed.target?.agentProfileId })
      expect(next.commands[1].id).not.toBe(oldId)
      expect(() => resolveTaskCommand('/review goal', next, oldId)).toThrow()
    }
    const changedDefinition = catalog([{ ...rows[0], description: 'changed' }])
    expect(() => resolveTaskCommand('/review goal', changedDefinition, oldId)).toThrow()
  })

  it('rejects ambiguous native definitions because the native interface only addresses names', () => {
    const entries = catalog([
      { name: 'same', description: 'builtin', source: 'builtin' },
      { name: 'same', description: 'custom', source: 'custom' }
    ])
    expect(entries.commands.slice(1).every(command => command.ambiguous)).toBe(true)
    for (const command of entries.commands.slice(1)) {
      expect(() => resolveTaskCommand('/same goal', entries, command.id)).toThrow()
    }
  })

  it('does not turn unknown or malformed slash commands into ordinary routing', () => {
    for (const input of ['/missing', '/', '//scry-workflow list', '/scry-workflow unknown']) {
      expect(() => resolveTaskCommand(input, catalog())).toThrow()
    }
    for (const text of ['ordinary text', '> /scry-workflow run quoted', '```\n/scry-workflow run quoted\n```', '／scry-workflow run quoted']) {
      expect(resolveTaskCommand(text, catalog())).toEqual({ kind: 'plain' })
      expect(() => resolveTaskCommand(text, catalog(), SCRY_WORKFLOW_COMMAND_ID)).toThrow()
    }
  })

  it('parses the documented zero-model control requests without granting mode/fees', () => {
    expect(scry('list')).toEqual({ kind: 'list' })
    for (const value of ['unrestricted', 'small', 'medium', 'large', 'default']) {
      expect(scry(`size ${value}`)).toEqual({ kind: 'size', value })
    }
    for (const mode of ['off', 'manual', 'auto']) expect(scry(`mode ${mode}`)).toEqual({ kind: 'mode', mode })
    for (const invalid of ['size', 'size null', 'size small extra', 'mode', 'mode full_access', 'list extra']) {
      expect(() => scry(invalid)).toThrow()
    }
  })

  it('preserves goal payload after one syntax separator rather than modifying or executing it', () => {
    for (const kind of ['direct', 'run', 'research']) {
      expect(scry(`${kind}   exact goal\nwith quoted /commands  `)).toEqual({ kind, goal: '  exact goal\nwith quoted /commands  ' })
      expect(() => scry(`${kind}   `)).toThrow()
    }
    const input = ' {"argument":"$(not-a-shell)"}  '
    for (const kind of ['template', 'edit']) {
      for (const scope of ['builtin', 'personal', 'project']) {
        expect(scry(`${kind} ${scope}:${templateId} ${input}`)).toEqual({ kind, scope, templateId, input })
      }
      expect(scry(`${kind} ${templateId} ${input}`)).toEqual({ kind, scope: undefined, templateId, input })
      for (const invalid of [`${kind} ../../file goal`, `${kind} other:${templateId} goal`, `${kind} project:${templateId}`, `${kind} project:${templateId}:extra goal`]) {
        expect(() => scry(invalid)).toThrow()
      }
    }
  })

  it('does not publish stale/foreign envelopes as an authoritative current Provider catalogue', () => {
    const rows = [{ name: 'review', description: 'fixture' }]
    for (const native of [
      { ...envelope(rows), providerId: 'claude' as const },
      { ...envelope(rows), agentProfileId: 'pi-other' },
      { ...envelope(rows), cwd: '/synthetic/other' },
      { ...envelope(rows), state: 'unknown' as const }
    ]) {
      const entries = createTaskCommandCatalog(context, native)
      expect(entries.provider.complete).toBe(false)
      expect(entries.commands.map(command => command.id)).toEqual([SCRY_WORKFLOW_COMMAND_ID])
      expect(() => resolveTaskCommand('/review', entries)).toThrow()
    }
    expect(createTaskCommandCatalog({ ...context, target: undefined }, envelope(rows)).commands.length).toBe(1)
  })

  it('fails closed at count/byte bounds and never clips metadata into proof of absence', () => {
    const full = Array.from({ length: MAX_TASK_COMMANDS }, (_, index) => ({ name: `command-${index}`, description: '' }))
    expect(catalog(full).commands.length).toBe(MAX_TASK_COMMANDS + 1)
    for (const rows of [[...full, { name: 'extra', description: '' }], [{ name: 'huge', description: 'x'.repeat(MAX_TASK_COMMAND_BYTES) }]]) {
      const entries = catalog(rows)
      expect(entries.provider.complete).toBe(false)
      expect(entries.provider.state).toBe('unknown')
      expect(entries.commands.map(command => command.id)).toEqual([SCRY_WORKFLOW_COMMAND_ID])
      expect(() => resolveTaskCommand('/scry-workflow list', entries)).toThrow()
      expect(resolveTaskCommand('/scry-workflow list', entries, SCRY_WORKFLOW_COMMAND_ID).kind).toBe('scry_workflow')
    }
  })
})
