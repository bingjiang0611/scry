import type { ScFile, ScRepository } from '@shared/source-control'

export function isStaged(file: ScFile): boolean {
  return file.index !== '.' && !file.untracked
}

export function commitFiles(repo: ScRepository, selected: string[]): ScFile[] {
  return repo.files.filter((file) => isStaged(file) || selected.includes(file.path))
}

export function commitBlocker(repo: ScRepository, selected: string[]): string | null {
  return repo.writeBlocker ?? repo.actionBlockers.commit ??
    (selected.length ? repo.actionBlockers.stage ?? null : null)
}

export type ScDelivery = {
  repositoryId: string
  branch: string | null
  head: string
  next: 'push' | 'pr'
}

export function nextGitAction(repo: ScRepository, delivery: ScDelivery | null, unknown: boolean) {
  if (unknown) return { action: 'operations', label: '核查操作结果', step: 2 } as const
  const next = delivery?.repositoryId === repo.id && delivery.branch === repo.branch && delivery.head === repo.head
    ? delivery.next : null
  if (next === 'pr') return { action: 'pr', label: '查看 / 创建 Pull Request', step: 3 } as const
  if (next === 'push' || (!repo.files.length && (repo.ahead ?? 0) > 0))
    return { action: 'push', label: '推送分支…', step: 2 } as const
  return { action: 'commit', label: '提交改动…', step: 1 } as const
}
