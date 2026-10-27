import type { BackgroundWork } from '@shared/background-work'

/**
 * A run blocked on AskUserQuestion is still active, but it is waiting on the
 * reader, not producing output. 「运行中」 would hide that the turn cannot
 * advance until the questions are answered.
 */
export function pendingQuestionStatus(count: number): { label: string; hint: string; waiting: boolean } | undefined {
  if (count <= 0) return undefined
  return {
    label: count === 1 ? '需回答 1 个问题' : `需回答 ${count} 个问题`,
    hint: '本轮在等你的选择，回答后继续',
    waiting: true
  }
}

export function backgroundWorkStatus(work: BackgroundWork | undefined): { label: string; hint: string; waiting: boolean } | undefined {
  if (!work || work.phase === 'inactive') return undefined
  if (work.quiet) return {
    label: '后台状态待确认',
    hint: '长时间未收到新事件，不代表失败；可继续等待或停止',
    waiting: true
  }
  if (work.phase === 'waiting') return {
    label: work.providerId === 'pi' ? '等待子 Agent' : '等待后台任务',
    hint: '新消息将排队等待',
    waiting: true
  }
  return { label: '运行中', hint: '新消息将排队等待', waiting: false }
}
