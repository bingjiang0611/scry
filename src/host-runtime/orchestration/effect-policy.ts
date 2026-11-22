import { OrchestrationStoreError } from './types'

export type EffectKind =
  | 'provider.run.start'
  | 'provider.run.stop'
  | 'question.respond'
  | 'catalog.writeback'
  | 'conversation.writeback'
  | 'catalog.scan'
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
  'catalog.writeback',
  'conversation.writeback',
  'catalog.scan',
  'legacy.mirror'
]

export const EFFECT_POLICIES: Readonly<Record<EffectKind, EffectPolicySpec>> = {
  'provider.run.start': { policy: 'process_bound', onRestart: 'run_start_reconcile' },
  'provider.run.stop': { policy: 'process_bound', onRestart: 'void' },
  'question.respond': { policy: 'process_bound', onRestart: 'void' },
  'catalog.writeback': { policy: 'replayable', onRestart: 'requeue' },
  'conversation.writeback': { policy: 'replayable', onRestart: 'requeue' },
  'catalog.scan': { policy: 'replayable', onRestart: 'requeue' },
  'legacy.mirror': { policy: 'replayable', onRestart: 'requeue' }
}

export function getEffectPolicy(kind: string): EffectPolicySpec {
  const spec = (EFFECT_POLICIES as Record<string, EffectPolicySpec | undefined>)[kind]
  if (!spec) {
    throw new OrchestrationStoreError(
      'orchestration_invalid_effect_kind',
      `Unregistered orchestration effect kind: ${kind}`
    )
  }
  return spec
}
