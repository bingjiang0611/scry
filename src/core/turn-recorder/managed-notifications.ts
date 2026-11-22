import type { AgentTurnRecord } from '../../shared/turn-record.js'
import { drainCommitNotifications, HOOK_DRAIN_MAX_RECORDS, HOOK_DRAIN_BUDGET_MS, type CommitNotificationScope } from './store.js'

export type CommitNotificationDelivery = 'await' | 'detach'

export async function deliverCommitNotifications(
  dataRoot: string,
  env: NodeJS.ProcessEnv | undefined,
  delivery: CommitNotificationDelivery,
  scope?: CommitNotificationScope
): Promise<void> {
  const drain = (): Promise<unknown> => drainCommitNotifications(dataRoot, env, {
    maxRecords: HOOK_DRAIN_MAX_RECORDS,
    budgetMs: HOOK_DRAIN_BUDGET_MS,
    ...(scope ? { scope } : {})
  })
  if (delivery === 'detach') {
    void drain().catch(() => undefined)
    return
  }
  await drain()
}

export function recordKeepsToolBodies(record: AgentTurnRecord): boolean {
  return [record.tools, record.skills, record.mcps]
    .flatMap((section) => section.value ?? [])
    .some((call) => 'outputContent' in call)
}
