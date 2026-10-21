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

export const workflowControlCopy = {
  stopLimit: '工作流停止命令已达上限；请检查未收敛作用域，不会重发或清空收据',
  invalidStopReceipt: '工作流停止收据合同无效',
  unconfirmedStopReceipt: '停止请求尚未确认持久化，不会重发；修复存储后请再次停止',
  invalidPlanningStopReceipt: '工作流规划停止收据合同无效'
}

export const workflowShutdownCopy = {
  title: 'Scry',
  unconfirmed: '工作流尚未全部收敛，已阻止安全退出；请检查工作流状态并再次停止。',
  storageFailure: '工作流停止意图未能确认持久化，已阻止安全退出；不会重发未知控制命令。',
  initializationFailure: '工作流历史初始化失败，无法确认工作流状态，已阻止安全退出。',
  admissionClosed: '工作流服务正在退出',
  admissionGenerationChanged: '工作流退出准备已开始',
  planningCancelled: '工作流规划已取消',
  planningJournalUnavailable: (id: string) => `工作流规划停止意图无法定位：${id}`,
  recoveredScopeUnavailable: '恢复的工作流作用域没有可用控制，不能证明安全退出',
  convergenceTimeout: '工作流在安全退出期限内未完成有证据的收敛',
  preparationTimeout: '工作流安全退出准备期限已到；未完成的存储或初始化工作仍保持冻结',
  planningJournalMissing: (id: string) => `工作流规划记录缺失：${id}`,
  planningStopIdentityConflict: (id: string) => `工作流规划停止身份冲突：${id}`,
  detail: (ids: readonly string[]) => ids.length ? `未收敛工作流：${ids.join('、')}` : '未收敛工作流状态未知'
}

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
