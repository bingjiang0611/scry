import { execFile, execFileSync } from 'node:child_process'

/**
 * 进程身份化与后代树诊断。
 *
 * PID 可以复用。只拿一个数字去 `process.kill(-pid)` 的代码，在目标已经退出、PID 被
 * 新进程（可能正是 Scry 自己的 Electron helper）接手时，会杀掉完全无关的进程树。
 * 所以这里的身份是 `(pid, 启动时间)`，并且在每次发信号**之前**重新校验；校验不过
 * 就拒绝发信号，如实返回 refused，而不是「尽力一试」。
 *
 * 另一条硬约束是类别白名单：只有我们自己派生的 Provider 进程树和终端根进程允许被
 * 发信号；Electron 自身的 main/renderer/GPU/utility 进程永远不允许。这样即使身份
 * 校验被某种边界情况绕过，也不会把 App 自己杀掉。
 */

export interface ProcessRow {
  pid: number
  ppid: number
  /** ps 的 stat 列；`Z` 开头是僵尸。 */
  status: string
  /** ps 的 lstart 列原文，作为启动时间指纹（固定 LC_ALL=C 格式）。 */
  startedAt: string
  command: string
}

export type ProcessSnapshot = ReadonlyMap<number, ProcessRow>

/** 身份键：PID 复用时启动时间一定不同，所以两者合起来才是身份。 */
export function processIdentityKey(row: { pid: number; startedAt: string }): string {
  return `${row.pid}:${row.startedAt}`
}

const PS_ROW = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\w+\s+\w+\s+\d+\s+[\d:]+\s+\d+)\s+(.*)$/

export function parseProcessSnapshot(output: string): ProcessSnapshot {
  const rows = new Map<number, ProcessRow>()
  for (const line of output.split('\n')) {
    const match = line.match(PS_ROW)
    if (!match) continue
    rows.set(Number(match[1]), {
      pid: Number(match[1]),
      ppid: Number(match[2]),
      status: match[3],
      startedAt: match[4],
      command: match[5]
    })
  }
  return rows
}

export type ProcessLister = () => string
export type ProcessIdentityLister = (pid: number) => Promise<string> | string

/**
 * lstart 的字段顺序随 locale 变化，身份采集与复核必须用同一种固定格式，
 * 否则复核会因为格式差异而「看起来变了」或「看起来没变」。
 */
export const defaultProcessLister: ProcessLister = () => execFileSync(
  '/bin/ps',
  ['-axo', 'pid=,ppid=,stat=,lstart=,command='],
  { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } }
)

const PROCESS_IDENTITY_TIMEOUT_MS = 1_000

/**
 * 身份采集只读取目标 PID，避免启动路径同步扫描整机进程表。
 * 输出仍使用与全表诊断和发信号前复核相同的 LC_ALL=C/lstart 格式。
 */
export const defaultProcessIdentityLister: ProcessIdentityLister = (pid) => new Promise<string>((resolve, reject) => {
  execFile(
    '/bin/ps',
    ['-o', 'pid=,ppid=,stat=,lstart=,command=', '-p', String(pid)],
    { encoding: 'utf8', maxBuffer: 64 * 1024, timeout: PROCESS_IDENTITY_TIMEOUT_MS, env: { ...process.env, LC_ALL: 'C' } },
    (error, stdout) => {
      if (error) reject(error)
      else resolve(stdout)
    }
  )
})

export function readProcessSnapshot(lister: ProcessLister = defaultProcessLister): ProcessSnapshot {
  return parseProcessSnapshot(lister())
}

export type ProcessCategory =
  | 'provider-root'
  | 'provider-child'
  | 'terminal-root'
  | 'electron-main'
  | 'electron-renderer'
  | 'electron-gpu'
  | 'electron-utility'
  | 'unknown'

/**
 * 允许发信号的类别。Electron 自身进程不在其中：Scry 停止一次 run 时不应该、也不需要
 * 对自己的 renderer/GPU/utility 动手。
 *
 * T3 还有一个 `resource-monitor` 类别，Scry 的资源采样在主进程内完成、没有独立进程，
 * 因此这里不造这个类别，避免出现永远为空的分组。
 */
const SIGNALABLE: ReadonlySet<ProcessCategory> = new Set<ProcessCategory>([
  'provider-root',
  'provider-child',
  'terminal-root'
])

export function canSignalCategory(category: ProcessCategory): boolean {
  return SIGNALABLE.has(category)
}

const ELECTRON_TYPE = /--type=(renderer|gpu-process|utility|zygote)\b/
const ELECTRON_MAIN = /(Electron\.app\/Contents\/MacOS\/Electron|\.app\/Contents\/MacOS\/[^/]*Scry)/

/**
 * 按命令行判定类别。只用于**拒绝**不该动的进程，不用于放宽权限：无法判定时返回
 * `unknown`，而 unknown 不在白名单里。
 */
export function classifyProcessRow(row: ProcessRow, options: { rootPid: number; rootCategory: 'provider-root' | 'terminal-root' }): ProcessCategory {
  const type = row.command.match(ELECTRON_TYPE)?.[1]
  if (type === 'renderer') return 'electron-renderer'
  if (type === 'gpu-process') return 'electron-gpu'
  if (type === 'utility' || type === 'zygote') return 'electron-utility'
  if (ELECTRON_MAIN.test(row.command)) return 'electron-main'
  if (row.pid === options.rootPid) return options.rootCategory
  return 'provider-child'
}

export interface ProcessTreeNode extends ProcessRow {
  depth: number
  childPids: number[]
  category: ProcessCategory
}

/**
 * 以 rootPid 为根的后代树，按广度优先排列（根在最前）。树是读操作，不要求身份校验；
 * 身份校验发生在发信号那一步。
 */
export function descendantTree(
  snapshot: ProcessSnapshot,
  options: { rootPid: number; rootCategory: 'provider-root' | 'terminal-root' }
): ProcessTreeNode[] {
  const root = snapshot.get(options.rootPid)
  if (!root) return []
  const childrenByParent = new Map<number, number[]>()
  for (const row of snapshot.values()) {
    if (row.pid === row.ppid) continue
    const siblings = childrenByParent.get(row.ppid)
    if (siblings) siblings.push(row.pid)
    else childrenByParent.set(row.ppid, [row.pid])
  }
  const nodes: ProcessTreeNode[] = []
  const seen = new Set<number>([root.pid])
  const queue: Array<{ row: ProcessRow; depth: number }> = [{ row: root, depth: 0 }]
  while (queue.length) {
    const { row, depth } = queue.shift()!
    const childPids = (childrenByParent.get(row.pid) ?? []).filter((pid) => !seen.has(pid)).sort((a, b) => a - b)
    nodes.push({ ...row, depth, childPids, category: classifyProcessRow(row, options) })
    for (const pid of childPids) {
      const child = snapshot.get(pid)
      if (!child) continue
      seen.add(pid)
      queue.push({ row: child, depth: depth + 1 })
    }
  }
  return nodes
}

export interface ProcessIdentity {
  pid: number
  /** 采集时的 ps lstart 原文。缺省表示没有采集到身份，此时拒绝发信号。 */
  startedAt?: string
  /** 采集时的命令行；用于在启动时间相同（秒级精度）时进一步排除误伤。 */
  command?: string
}

export type SignalRefusal =
  | 'identity_unknown'
  | 'identity_changed'
  | 'process_missing'
  | 'category_not_signalable'
  | 'self_or_init'

export type SignalTreeOutcome =
  | { status: 'signalled'; signal: NodeJS.Signals; identityKey: string; scope: 'group' | 'process'; nodes: ProcessTreeNode[] }
  | { status: 'already_gone'; reason: 'process_missing' | 'zombie' }
  | { status: 'refused'; reason: SignalRefusal; detail: string }

/**
 * 校验身份后向整棵进程树发信号。
 *
 * 优先对进程组（`-pid`）发信号，因为逃到子进程里的工作必须一起停；但只有在根进程
 * 身份复核通过时才这么做——组 ID 同样会随 PID 复用而落到别人身上。
 */
export function signalProcessTreeWithIdentity(args: {
  identity: ProcessIdentity
  signal: NodeJS.Signals
  rootCategory?: 'provider-root' | 'terminal-root'
  lister?: ProcessLister
  kill?: (pid: number, signal: NodeJS.Signals) => void
  selfPid?: number
}): SignalTreeOutcome {
  const { identity, signal } = args
  const kill = args.kill ?? ((pid, sig) => { process.kill(pid, sig) })
  const selfPid = args.selfPid ?? process.pid
  if (!Number.isInteger(identity.pid) || identity.pid <= 1) {
    return { status: 'refused', reason: 'self_or_init', detail: `非法 PID：${identity.pid}` }
  }
  if (identity.pid === selfPid) {
    return { status: 'refused', reason: 'self_or_init', detail: '拒绝对 Scry 主进程发信号' }
  }
  if (!identity.startedAt) {
    return { status: 'refused', reason: 'identity_unknown', detail: `PID ${identity.pid} 没有采集到启动时间，无法确认身份` }
  }
  const snapshot = readProcessSnapshot(args.lister ?? defaultProcessLister)
  const row = snapshot.get(identity.pid)
  if (!row) return { status: 'already_gone', reason: 'process_missing' }
  if (row.status.startsWith('Z')) return { status: 'already_gone', reason: 'zombie' }
  if (row.startedAt !== identity.startedAt) {
    return {
      status: 'refused',
      reason: 'identity_changed',
      detail: `PID ${identity.pid} 启动时间已变化（采集 ${identity.startedAt} / 当前 ${row.startedAt}），可能是 PID 复用`
    }
  }
  if (identity.command && identity.command !== row.command) {
    return {
      status: 'refused',
      reason: 'identity_changed',
      detail: `PID ${identity.pid} 命令行已变化，拒绝发信号`
    }
  }
  const rootCategory = args.rootCategory ?? 'provider-root'
  const nodes = descendantTree(snapshot, { rootPid: identity.pid, rootCategory })
  const blocked = nodes.filter((node) => !canSignalCategory(node.category))
  if (blocked.length) {
    return {
      status: 'refused',
      reason: 'category_not_signalable',
      detail: `进程树包含不允许发信号的类别：${blocked.map((node) => `${node.pid}=${node.category}`).join(',')}`
    }
  }
  const identityKey = processIdentityKey(row)
  try {
    // 进程组优先：逃到后代里的工作必须一起停。
    kill(-identity.pid, signal)
    return { status: 'signalled', signal, identityKey, scope: 'group', nodes }
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code === 'ESRCH') return { status: 'already_gone', reason: 'process_missing' }
    if (code !== 'EPERM' && code !== 'EINVAL') throw error
  }
  try {
    // 目标不是进程组组长时（例如没有 detached 启动），退回单进程信号。
    kill(identity.pid, signal)
    return { status: 'signalled', signal, identityKey, scope: 'process', nodes }
  } catch (error) {
    if ((error as { code?: string }).code === 'ESRCH') return { status: 'already_gone', reason: 'process_missing' }
    throw error
  }
}

/** 为一个刚启动的 PID 异步采集身份。采集不到、超时或失败时返回未知身份，发信号会被拒绝。 */
export async function captureProcessIdentity(
  pid: number | undefined,
  lister: ProcessIdentityLister = defaultProcessIdentityLister,
  timeoutMs = PROCESS_IDENTITY_TIMEOUT_MS
): Promise<ProcessIdentity | undefined> {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const output = await Promise.race([
      Promise.resolve().then(() => lister(pid)),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`采集 PID ${pid} 身份超时`)), timeoutMs)
      })
    ])
    const row = parseProcessSnapshot(output).get(pid)
    return row ? { pid, startedAt: row.startedAt, command: row.command } : { pid }
  } catch {
    // ps 不可用时身份未知；调用方据此拒绝发信号，而不是无校验地杀。
    return { pid }
  } finally {
    if (timer) clearTimeout(timer)
  }
}
