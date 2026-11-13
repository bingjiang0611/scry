import type { AgentTurnRecord } from '../../shared/turn-record.js'
import { drainCommitNotifications, HOOK_DRAIN_MAX_RECORDS, HOOK_DRAIN_BUDGET_MS, type CommitNotificationScope } from './store.js'

/**
 * 提交通知的投递位置。`await` 用于 CLI/recover：进程随后就退出，必须先把这一批投递完。
 * `detach` 用于常驻 App：record 已经落盘，向仓库回调投递只是下游观测，绝不能挂在用户看到
 * 轮次收口之前——每条通知都要起一次仓库回调进程，积压时会把“运行中”拖到分钟级。剩余积压由
 * 下一次 hook、`recorder recover` 或 `recorder notify-drain` 继续投递，ACK 游标是持久化的，
 * 因此不会丢证据。
 */
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
  // Presence, not content: a full-policy turn whose body was lost keeps the omitted envelope, while
  // the summary policy removes the output field entirely.
  return [record.tools, record.skills, record.mcps]
    .flatMap((section) => section.value ?? [])
    .some((call) => 'outputContent' in call)
}
