/**
 * 按已规范化的工作区路径串行化写操作。
 *
 * 工作区写入是「读当前内容 → 比对 revision → 写回」。两个并发写请求可以在比对和写回
 * 之间交错，于是两边都认为自己基于最新内容，而后写的一方悄悄覆盖了前一方——用户看到
 * 的是编辑凭空消失，而不是一条冲突提示。租约把同一工作区的写操作排成队列，让 revision
 * 比对和写回成为一个不可分割的区间。
 *
 * 这是进程内租约：它只保证 Scry 自己的写入互不覆盖，不保证外部编辑器或 Agent 的并发
 * 写入；那一层仍由 revision 比对负责报错。
 */

interface Lease {
  /** 队尾：新请求挂在它后面。 */
  tail: Promise<void>
  /** 引用计数：归零才回收，避免长寿 Map 把每个访问过的工作区都留住。 */
  holders: number
}

const leases = new Map<string, Lease>()

export async function withWorkspaceLease<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const existing = leases.get(key)
  const lease: Lease = existing ?? { tail: Promise.resolve(), holders: 0 }
  if (!existing) leases.set(key, lease)
  lease.holders += 1
  const predecessor = lease.tail
  let release: () => void = () => {}
  lease.tail = new Promise<void>((resolve) => { release = resolve })
  // 前驱失败不应阻塞后继：它的错误由它自己的调用方处理。
  await predecessor.catch(() => {})
  try {
    return await operation()
  } finally {
    release()
    lease.holders -= 1
    if (lease.holders === 0 && leases.get(key) === lease) leases.delete(key)
  }
}

/** 当前持有或等待该租约的请求数。诊断与测试用。 */
export function workspaceLeaseHolders(key: string): number {
  return leases.get(key)?.holders ?? 0
}

/** 已登记的租约数量，用于证明租约会被回收而不是无界增长。 */
export function workspaceLeaseCount(): number {
  return leases.size
}
