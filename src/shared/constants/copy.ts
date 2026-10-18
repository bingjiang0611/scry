import type { WorkspaceDiffResult } from '../trace'

type WorkspaceDiffState = WorkspaceDiffResult | null | undefined

function label(result: WorkspaceDiffState): string {
  if (result === undefined) return '尚未采集'
  if (result === null) return '采集中'
  switch (result.status) {
    case 'captured': return '无改动'
    case 'unavailable': return '不可用'
    case 'timeout': return '采集超时'
    case 'failed': return '采集失败'
  }
}

function detail(result: WorkspaceDiffState): string {
  if (!result) return label(result)
  if (result.status === 'captured') return result.files.length ? count(result.files.length) : label(result)
  const reasons: Record<Exclude<WorkspaceDiffResult, { status: 'captured' }>['reason'], string> = {
    not_git: '当前目录不是 Git 工作树',
    no_head: '仓库尚无 HEAD，无法比较改动',
    deadline: 'Git 采集超时',
    git_error: 'Git 采集失败',
    no_baseline: '缺少 Git 比较基线',
    request_failed: '无法读取工作区改动'
  }
  return reasons[result.reason]
}

const count = (value: number): string => `${value} 个工作区文件的 Git 净改动`

export const workspaceDiffCopy = {
  invalidDirectory: '无效的工作目录',
  heading: 'Changes',
  overviewHeading: '工作区未提交改动（vs HEAD）',
  binary: 'binary',
  scope: '当前工作树对比 HEAD（含未跟踪新文件，不含 ignored）· 含本会话之外的改动 · check=结构化文件工具足迹内 · alert=未被结构化文件工具记录',
  label,
  detail,
  count,
  totals: (count: number, added: number, deleted: number) => `${count} files · +${added} −${deleted}`,
  report: (result: WorkspaceDiffState, untouched: number): string => {
    if (!result || result.status !== 'captured') return `- **git diff**：${detail(result)}`
    if (!result.files.length) return '- **git diff**：无改动'
    return `- **git diff**：${result.files.length} 文件${untouched ? `（${untouched} 未经工具标记）` : ''}`
  }
}
