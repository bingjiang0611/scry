import type { BackgroundWork } from '@shared/background-work'

export function backgroundWorkStatus(work: BackgroundWork | undefined): { label: string; hint: string; waiting: boolean } | undefined {
  if (!work || work.phase === 'inactive') return undefined
  if (work.quiet) return {
    label: '后台状态待确认',
    hint: '长时间未收到新事件，不代表失败；可继续等待或停止',
    waiting: true
  }
  if (work.phase === 'waiting') return {
    label: '等待后台任务',
    hint: '新消息将排队等待',
    waiting: true
  }
  return { label: '运行中', hint: '新消息将排队等待', waiting: false }
}
