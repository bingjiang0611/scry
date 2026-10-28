import { createHash } from 'node:crypto'
import type { ConversationTarget } from '../shared/conversation'
import type { CapabilityEnvelope, ProviderCommand } from '../shared/provider'
import { taskCommandCopy as copy } from '../shared/constants/copy'
import { isWorkflowSizeGuideline } from '../shared/workflow-size'
import {
  SCRY_WORKFLOW_COMMAND_ID, type ResolvedTaskCommand, type ScryTaskCommand,
  type TaskCommandCatalog, type TaskCommandDescriptor
} from '../shared/task-command'
import { templateIdPattern } from './workflow-template-identity'

export type TaskCommandContext = Readonly<{ conversationId: string; cwd: string; target?: ConversationTarget }>

export class TaskCommandResolutionError extends Error {
  constructor(readonly code: 'invalid' | 'stale' | 'unknown' | 'source_required', message: string) { super(message) }
}
const digest = (value: string): string => createHash('sha256').update(value).digest('hex')
const boundedReason = (reason: string | undefined): { reason?: string; reasonTruncated?: true } =>
  reason !== undefined && reason.length > 4096 ? { reason: reason.slice(0, 4096), reasonTruncated: true } : { reason }
// Fail closed rather than treating a clipped catalogue as proof of absence.
// A real provider exceeding these bounds needs a paged command catalogue before
// the limit can be raised; neither name matching nor source choice may guess.
export const MAX_TASK_COMMANDS = 512
export const MAX_TASK_COMMAND_BYTES = 256 * 1024
const scryCommand: TaskCommandDescriptor = {
  id: SCRY_WORKFLOW_COMMAND_ID, name: 'scry-workflow', description: copy.description,
  argumentHint: copy.argumentHint, origin: { kind: 'scry_workflow' }, ambiguous: false
}

/** Caller supplies main-owned conversation/native identity and discovery data.
 * IDs bind metadata to that scope; they are not permissions, config-content
 * fingerprints, or a claim that native command implementations are immutable. */
export function createTaskCommandCatalog(context: TaskCommandContext, native?: CapabilityEnvelope<ProviderCommand[]>): TaskCommandCatalog {
  const scope = digest(JSON.stringify([context.conversationId, context.cwd, context.target?.providerId ?? null,
    context.target?.agentProfileId ?? null, context.target?.continuationKey ?? null]))
  const unavailable = (reason: string): TaskCommandCatalog => ({ scope,
    provider: { state: 'unknown', complete: false, ...boundedReason(reason), observedAt: native?.observedAt }, commands: [scryCommand] })
  const target = context.target
  if (!target || !native) return unavailable(native?.reason ?? copy.unavailable)
  if (native.providerId !== target.providerId || native.agentProfileId !== target.agentProfileId ||
    (native.cwd !== undefined && native.cwd !== context.cwd)) return unavailable(copy.stale)
  const provider = { state: native.state, complete: native.state === 'ready' && native.mode !== 'none' && native.data !== null,
    ...boundedReason(native.reason), observedAt: native.observedAt }
  if (native.data === null || native.mode === 'none' || (native.state !== 'ready' && native.state !== 'degraded')) {
    return { scope, provider, commands: [scryCommand] }
  }
  if (native.data.length > MAX_TASK_COMMANDS) return unavailable(copy.oversized)
  const normalized: Array<{ row: ProviderCommand; serialized: string }> = []
  let bytes = 0
  for (const command of native.data) {
    // Never propagate a provider-supplied id/origin as Main source authority.
    const row = { name: command.name.replace(/^\//, ''), description: command.description,
      argumentHint: command.argumentHint, source: command.source }
    if (!row.name || /[\s/]/u.test(row.name)) return unavailable(copy.invalid)
    const serialized = JSON.stringify(row)
    bytes += Buffer.byteLength(serialized)
    if (bytes > MAX_TASK_COMMAND_BYTES) return unavailable(copy.oversized)
    normalized.push({ row, serialized })
  }
  const counts = new Map<string, number>()
  for (const { row } of normalized) counts.set(row.name, (counts.get(row.name) ?? 0) + 1)
  const commands: TaskCommandDescriptor[] = [scryCommand, ...normalized.map(({ row, serialized }) => ({
    id: `provider:${digest(`${scope}\n${serialized}`)}`, name: row.name, description: row.description,
    argumentHint: row.argumentHint, origin: { kind: 'provider' as const, providerId: target.providerId,
      ...(target.agentProfileId === undefined ? {} : { agentProfileId: target.agentProfileId }) },
    nativeSource: row.source, ambiguous: counts.get(row.name)! > 1
  }))]
  return { scope, provider, commands }
}

/** Only the first top-level command position is interpreted. Quoted text,
 * code blocks, selected references, attachments and history are not inputs here.
 * Consume one syntax separator, preserving the remaining message verbatim. */
function word(input: string): { token: string; rest: string } | null {
  const match = input.match(/^([^\s]+)(?:\s([\s\S]*))?$/u)
  return match ? { token: match[1], rest: match[2] ?? '' } : null
}
function parseScryCommand(argumentsText: string): ScryTaskCommand {
  const command = word(argumentsText.trimStart())
  if (!command) throw new TaskCommandResolutionError('invalid', copy.invalid)
  const { token, rest } = command
  if (token === 'list' && !rest.trim()) return { kind: 'list' }
  if (token === 'size') {
    const value = rest.trim()
    if (value === 'default' || isWorkflowSizeGuideline(value)) return { kind: 'size', value }
  }
  if (token === 'mode') {
    const mode = rest.trim()
    if (mode === 'off' || mode === 'manual' || mode === 'auto') return { kind: 'mode', mode }
  }
  if ((token === 'direct' || token === 'run' || token === 'research') && rest.trim()) return { kind: token, goal: rest }
  if (token === 'template' || token === 'edit') {
    const selected = word(rest.trimStart())
    if (!selected || !selected.rest.trim()) throw new TaskCommandResolutionError('invalid', copy.invalid)
    const parts = selected.token.split(':')
    const [scope, templateId] = parts.length === 1 ? [undefined, parts[0]] : parts
    if (parts.length > 2 || (scope !== undefined && scope !== 'builtin' && scope !== 'personal' && scope !== 'project') ||
      !templateIdPattern.test(templateId)) throw new TaskCommandResolutionError('invalid', copy.invalid)
    return { kind: token, scope, templateId, input: selected.rest }
  }
  throw new TaskCommandResolutionError('invalid', copy.invalid)
}

export function resolveTaskCommand(prompt: string, catalog: TaskCommandCatalog, selectedId?: string): ResolvedTaskCommand {
  const raw = prompt.trimStart()
  if (!raw.startsWith('/')) {
    if (selectedId !== undefined) throw new TaskCommandResolutionError('stale', copy.stale)
    return { kind: 'plain' }
  }
  const position = word(raw.slice(1))
  if (!position || /\//u.test(position.token)) throw new TaskCommandResolutionError('invalid', copy.invalid)
  const matches = catalog.commands.filter(command => command.name === position.token)
  let descriptor: TaskCommandDescriptor
  if (selectedId !== undefined) {
    const selected = matches.find(command => command.id === selectedId)
    if (!selected) throw new TaskCommandResolutionError('stale', copy.stale)
    descriptor = selected
  } else {
    // Missing or degraded metadata cannot prove the Provider has no colliding
    // command. An explicit Main-owned selector can still choose Scry itself.
    if (!catalog.provider.complete) throw new TaskCommandResolutionError('source_required', copy.unavailable)
    if (matches.length > 1) throw new TaskCommandResolutionError('source_required', copy.chooseSource)
    if (!matches.length) throw new TaskCommandResolutionError('unknown', copy.unknown)
    descriptor = matches[0]
  }
  if (descriptor.ambiguous) throw new TaskCommandResolutionError('source_required', copy.chooseSource)
  return descriptor.origin.kind === 'scry_workflow'
    ? { kind: 'scry_workflow', descriptor, command: parseScryCommand(position.rest) }
    : { kind: 'provider', descriptor }
}
