import { OrchestrationStoreError } from './types'

export type EffectKind =
  | 'provider.run.start'
  | 'provider.run.stop'
  | 'question.respond'
  // The conversation turn of a finished run is concluded by the daemon on the terminal path and by
  // startup reconciliation, not through this table: an effect kind with no producer is a claim, not a
  // plan. See docs/plans/remote-runtime-v2/handoff/reports/W20-5.md.
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
  'legacy.mirror'
]

/** Centralized outbox policy table (data §4.5). Policy is fixed at enqueue time. */
export const EFFECT_POLICIES: Readonly<Record<EffectKind, EffectPolicySpec>> = {
  'provider.run.start': { policy: 'process_bound', onRestart: 'run_start_reconcile' },
  'provider.run.stop': { policy: 'process_bound', onRestart: 'void' },
  'question.respond': { policy: 'process_bound', onRestart: 'void' },
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
