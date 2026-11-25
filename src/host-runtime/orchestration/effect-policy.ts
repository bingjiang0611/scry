import { OrchestrationStoreError } from './types'

export type EffectKind =
  | 'provider.run.start'
  | 'provider.run.stop'
  | 'question.respond'
  // D4: the conversation file is an export of the event log, so a metadata change writes back through
  // the worker. No producer yet — see docs/plans/remote-runtime-v2/handoff/reports/W20.md (B1).
  | 'conversation.writeback'
  | 'legacy.mirror'

export type EffectPolicyClass = 'process_bound' | 'replayable'

export type EffectRestartBehavior = 'run_start_reconcile' | 'void' | 'requeue'

export interface EffectPolicySpec {
  readonly policy: EffectPolicyClass
  readonly onRestart: EffectRestartBehavior
}

export const ALL_EFFECT_KINDS: readonly EffectKind[] = [
  'provider.run.start',
  'provider.run.stop',
  'question.respond',
  'conversation.writeback',
  'legacy.mirror'
]

/** Centralized outbox policy table (data §4.5). Policy is fixed at enqueue time. */
export const EFFECT_POLICIES: Readonly<Record<EffectKind, EffectPolicySpec>> = {
  'provider.run.start': { policy: 'process_bound', onRestart: 'run_start_reconcile' },
  'provider.run.stop': { policy: 'process_bound', onRestart: 'void' },
  'question.respond': { policy: 'process_bound', onRestart: 'void' },
  'conversation.writeback': { policy: 'replayable', onRestart: 'requeue' },
  'legacy.mirror': { policy: 'replayable', onRestart: 'requeue' }
}

/**
 * A4: recovery must survive an effect kind this build does not know (for example a row written by
 * a newer build, or a corrupt kind). Callers that decide at enqueue time keep using
 * `getEffectPolicy`, which rejects unregistered kinds.
 */
export function findEffectPolicy(kind: string): EffectPolicySpec | undefined {
  return (EFFECT_POLICIES as Record<string, EffectPolicySpec | undefined>)[kind]
}

export function getEffectPolicy(kind: string): EffectPolicySpec {
  const spec = findEffectPolicy(kind)
  if (!spec) {
    throw new OrchestrationStoreError(
      'orchestration_invalid_effect_kind',
      `Unregistered orchestration effect kind: ${kind}`
    )
  }
  return spec
}
