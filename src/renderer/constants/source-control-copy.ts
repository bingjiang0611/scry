import type { ScOperation, ScRepository } from '@shared/source-control'

export const sourceControlActionNames = {
  stage: '暂存', unstage: '取消暂存', commit: '提交', fetch: '获取远端',
  push: '推送', createPr: '创建 PR', review: '提交审查', merge: '合并 PR',
  prepareWorkspace: '准备会话工作区'
} satisfies Record<ScOperation['action'], string>
export const sourceControlStatusNames = {
  running: '执行中', succeeded: '已确认', failed: '失败', unknown: '结果未知'
} satisfies Record<ScOperation['status'], string>

export const sourceControlFileCopy = {
  include: (path: string) => `纳入本次提交 ${path}`,
  staged: '已暂存 · 将纳入提交',
  partiallyStaged: '部分已暂存 · 保留原有选择',
  unstage: (path: string) => `取消暂存 ${path}`,
  unstageDetail: (path: string) => `取消暂存 ${path}。保留工作区文件，不丢弃改动。`,
  minus: '−', untracked: 'U'
}

export const sourceControlOperationCopy = {
  title: '操作证据 · 不自动重放',
  empty: '本仓库没有本机操作记录。',
  label: (op: ScOperation) => `${sourceControlActionNames[op.action]} · ${sourceControlStatusNames[op.status]}${op.acknowledged ? ' · 已人工核查' : ''}`,
  viewPr: '查看 PR',
  reviewId: (id: number) => `review ID ${id}`,
  reconcile: '只读核查',
  acknowledge: '我已人工核查…',
  acknowledgeTitle: '确认已人工核查',
  acknowledgeDetail: '结果仍保留为 unknown。仅解除后续操作阻断，不重试、不回滚、不宣称成功。请先在 Git/GitHub 确认现场。'
}

export const sourceControlRepositoryCopy = {
  title: '仓库详情',
  head: (head: string | null) => `HEAD ${head ?? '尚无提交'}`,
  branch: (repo: ScRepository) => `分支：${repo.branch ?? 'Detached HEAD'} · 上游：${repo.upstream ?? '未设置'}`,
  tracking: (repo: ScRepository) => `跟踪引用：↑${repo.ahead ?? '未知'} ↓${repo.behind ?? '未知'}，不代表实时远端状态。`,
  observedAt: (time: number) => `读取时间：${new Date(time).toLocaleString()}`,
  note: '真实 Git 状态不等于 Agent 文件足迹。刷新会清除候选文件选择，不修改实际暂存区。',
  close: '关闭'
}

export const sourceControlTransportCopy = {
  title: (action: 'push' | 'fetch') => action === 'push' ? '确认推送' : '确认获取远端',
  remote: '选择 remote',
  chooseRemote: '请选择 remote',
  noRemote: '没有可用远端',
  missingRemote: '尚未配置远端，请先在终端添加 remote。',
  detail: (action: 'push' | 'fetch', repo: ScRepository) => action === 'push'
    ? `将 ${repo.head?.slice(0, 10) ?? '无提交'} 推送到 refs/heads/${repo.branch ?? '无分支'}。直接更新此分支，包括它是默认分支的情况；不强推，不自动提交或创建分支/PR。`
    : '更新远端跟踪引用；不改工作区，不 prune。',
  cancel: '取消',
  confirm: (action: 'push' | 'fetch', branch: string | null) => action === 'push'
    ? `确认推送到 ${branch ?? '无分支'}` : '确认 Fetch'
}
