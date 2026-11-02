import type { WorkspaceOverlapEvidence } from '../shared/turn-diff.js'

/**
 * 共享工作区里 before/after diff 只能证明「工作区变了」，不能证明是哪个 run 写的。
 * 这里按 canonical cwd 记录每个被观测 run 的写入窗口，让一次采集能如实带出
 * 「这段时间里同一个工作区上还有哪些 run 在跑」，而不是伪造独占归因。
 *
 * 边界：
 * - 只记录 Scry run。用户或外部编辑器直接改文件不在 registry 里，这里不声称能发现。
 * - 不比较文件内容，也不做 per-file 归属；同一文件由两个 run 都改过时仍然只能说「重叠」。
 * - 窗口起点是 diff 基线观测，终点是 run 收口，不是模型文字停止，也不是最后一次证据采集：
 *   中途采集过一次 diff 的 run 仍在写工作区，它的窗口必须继续张开。
 * - 观测记录有上限；被淘汰的记录会把该 cwd 的覆盖起点抬高，起点更早的窗口只能报 partial，
 *   绝不当作「没有重叠」。
 */
export interface WorkspaceObservation {
  runId: string
  cwd: string
  from: number
  /** 最近一次证据采集结束时间；缺省表示还没采集过。它**不是**窗口末端。 */
  evidenceEnd?: number
}

const MAX_COMPLETED_PER_CWD = 32
const MAX_RETAINED_TOTAL = 128
const MAX_REPORTED_RUNS = 16

interface Observation extends WorkspaceObservation {
  /** 有窗口外/已淘汰的观测记录可能与本窗口重叠：coverage 只能报 partial。 */
  lost: boolean
  /** 收口顺序，用于全局上限淘汰最早收口的记录。 */
  sequence: number
}

interface CwdObservations {
  completed: Observation[]
  /**
   * 该 cwd 从何时起的观测是完整的。被淘汰记录的窗口末端会把这里抬高；
   * 更早开始的窗口（例如回溯到会话基线的净 diff）因此只能报 partial。
   */
  floor: number
}

export class WorkspaceOverlapTracker {
  private readonly active = new Map<string, Observation>()
  private readonly cwds = new Map<string, CwdObservations>()
  private retained = 0
  private sequence = 0

  constructor(readonly now: () => number = Date.now) {}

  /** diff 基线观测开始。重复调用保留最初的起点；新 cwd 的覆盖起点从这里算起。 */
  start(runId: string, cwd: string): void {
    if (this.active.has(runId)) return
    const at = this.now()
    if (!this.cwds.has(cwd)) this.cwds.set(cwd, { completed: [], floor: at })
    this.active.set(runId, { runId, cwd, from: at, lost: false, sequence: 0 })
  }

  /**
   * run 收口：把观测窗口移入有界历史，让更晚结束的同一工作区 run 仍能判断重叠。
   * 窗口末端是收口时刻；最后一次证据采集早于收口时也不能提前结束窗口。
   */
  close(runId: string): void {
    const record = this.active.get(runId)
    if (!record) return
    this.active.delete(runId)
    const history = this.cwds.get(record.cwd) ?? { completed: [], floor: record.from }
    this.cwds.set(record.cwd, history)
    history.completed.push({ ...record, evidenceEnd: record.evidenceEnd ?? this.now(), sequence: this.sequence++ })
    this.retained += 1
    this.enforceBound(history)
    // 没有活动观测、也没有保留记录的 cwd 不留空壳：下次观测从那时起重新完整。
    if (history.completed.length === 0 && !this.hasActive(record.cwd)) this.cwds.delete(record.cwd)
  }

  /**
   * 为刚结束的证据采集计算重叠。`from` 缺省用本 run 的基线起点；会话净 diff 可以传入
   * 更早的基线起点，让跨越前几轮与空闲时间的净 diff 也能带上完整窗口。
   * 没有本 run 的观测记录时返回 undefined：未观测不等于没有重叠。
   */
  evidence(runId: string, from?: number): WorkspaceOverlapEvidence | undefined {
    const own = this.active.get(runId)
    if (!own) return undefined
    const to = own.evidenceEnd = Math.max(own.evidenceEnd ?? 0, this.now())
    const start = from === undefined ? own.from : Math.min(from, own.from)
    const history = this.cwds.get(own.cwd)
    const overlapping = [
      // 仍在运行的 run 窗口末端未知：只要它的起点在本次采集之前，就可能写了这次 diff 里的文件。
      ...[...this.active.values()].filter((record) =>
        record.runId !== runId && record.cwd === own.cwd && record.from < to && to > start),
      ...(history?.completed ?? []).filter((record) =>
        record.from < to && (record.evidenceEnd ?? to) > start)
    ].sort((left, right) => left.from - right.from)
    const runIds = [...new Set(overlapping.map((record) => record.runId))]
    // 起点早于该 cwd 的完整覆盖起点 = 已经丢掉了可能相交的观测，只能 partial。
    const lost = own.lost || (history !== undefined && start < history.floor)
    return {
      coverage: lost ? 'partial' : 'observed',
      runIds: runIds.slice(0, MAX_REPORTED_RUNS),
      observedFrom: new Date(start).toISOString(),
      observedTo: new Date(to).toISOString(),
      ...(runIds.length > MAX_REPORTED_RUNS ? { truncated: true as const } : {})
    }
  }

  /** 进程退出或测试重置：不保留任何跨会话的观测声明。 */
  disposeAll(): void {
    this.active.clear()
    this.cwds.clear()
    this.retained = 0
  }

  /** 保留的有界状态规模（诊断与回归用；不代表已观测的 run 总数）。 */
  retainedState(): { runs: number; cwds: number } {
    return { runs: this.retained, cwds: this.cwds.size }
  }

  private hasActive(cwd: string): boolean {
    for (const record of this.active.values()) if (record.cwd === cwd) return true
    return false
  }

  private enforceBound(history: CwdObservations): void {
    while (history.completed.length > MAX_COMPLETED_PER_CWD) this.drop(history, history.completed[0])
    while (this.retained > MAX_RETAINED_TOTAL) {
      // 全局上限按收口顺序淘汰最早的窗口：跨 cwd 的总量必须有界，否则切换项目就会无界增长。
      let victimCwd: CwdObservations | undefined
      let victim: Observation | undefined
      for (const candidate of this.cwds.values()) {
        const oldest = candidate.completed[0]
        if (oldest && (!victim || oldest.sequence < victim.sequence)) {
          victim = oldest
          victimCwd = candidate
        }
      }
      if (!victim || !victimCwd) break
      this.drop(victimCwd, victim)
    }
    // 被淘汰一空的 cwd 不留空壳：没有活动观测时它的覆盖起点会在下一次观测时重建，
    // 留着只会让 cwd 条目数随项目切换无界增长。
    for (const [cwd, candidate] of this.cwds) {
      if (candidate.completed.length === 0 && !this.hasActive(cwd)) this.cwds.delete(cwd)
    }
  }

  private drop(history: CwdObservations, record: Observation): void {
    const index = history.completed.indexOf(record)
    if (index < 0) return
    history.completed.splice(index, 1)
    this.retained -= 1
    const evictedEnd = record.evidenceEnd ?? this.now()
    // 被淘汰窗口的末端就是该 cwd 仍能保证完整的最后时刻；更早的窗口从此只能 partial。
    history.floor = Math.max(history.floor, evictedEnd)
    // 仍张开的活动窗口可能与被淘汰的窗口相交：它们只能降级成 partial，不能凭空消失。
    for (const active of this.active.values()) {
      if (active.cwd === record.cwd && evictedEnd > active.from) active.lost = true
    }
  }
}
