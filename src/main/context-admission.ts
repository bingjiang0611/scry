/**
 * 等待对端收口的上限。持有者永不释放时，后续每一轮都会停在 admission 里：App 看不到错误、
 * 也停不掉那一轮。有界等待把「永远等」变成带原因的失败（run_admission_timeout / 同一会话
 * 已有一轮正在运行），前提是该轮真的没有开始。
 */
export const ADMISSION_DEADLINE_MS = 20_000

export interface AdmissionOptions {
  /** 等待同身份持有者让位的最长时间；`Infinity` 表示不设上限。 */
  admitDeadlineMs?: number
}

/** `true` 表示 work 在 deadline 之前结束；`false` 表示先到了边界。 */
async function withinDeadline(work: Promise<unknown>, deadlineMs: number): Promise<boolean> {
  if (!Number.isFinite(deadlineMs)) {
    await work
    return true
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work.then(() => true),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), deadlineMs) })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export class ContextAdmission {
  private readonly tails = new Map<string, Promise<void>>()
  private readonly admitDeadlineMs: number

  constructor(options: AdmissionOptions = {}) {
    this.admitDeadlineMs = options.admitDeadlineMs ?? ADMISSION_DEADLINE_MS
  }

  run<T>(key: string, action: () => Promise<T>): Promise<T> {
    return this.runMany([key], action)
  }

  async runMany<T>(keys: readonly string[], action: () => Promise<T>, options: AdmissionOptions = {}): Promise<T> {
    const ownedKeys = [...new Set(keys)]
    if (ownedKeys.length === 0) throw new Error('Context admission requires at least one identity')
    const previous = ownedKeys.map((key) => this.tails.get(key) ?? Promise.resolve())
    let release!: () => void
    const current = new Promise<void>((resolve) => { release = resolve })
    // Reserve every tail before yielding. Nested per-key waits could deadlock A→B vs B→A.
    for (const key of ownedKeys) this.tails.set(key, current)
    if (!(await withinDeadline(Promise.all(previous), options.admitDeadlineMs ?? this.admitDeadlineMs))) {
      // 我们从未运行 action，所以只释放自己占的位；否则后续 run 会排在一个空占位后面。
      release()
      for (const key of ownedKeys) {
        if (this.tails.get(key) === current) this.tails.delete(key)
      }
      throw new Error(`run_admission_timeout: 等待同会话上一轮收尾超过 ${options.admitDeadlineMs ?? this.admitDeadlineMs}ms，本轮尚未启动`)
    }
    try {
      return await action()
    } finally {
      release()
      for (const key of ownedKeys) {
        if (this.tails.get(key) === current) this.tails.delete(key)
      }
    }
  }
}

export async function waitForCompletedRuns(
  runs: Array<{ done: boolean; settled: Promise<void> }>,
  options: AdmissionOptions = {}
): Promise<boolean> {
  if (runs.some((run) => !run.done)) return false
  const settled = Promise.all(runs.map((run) => run.settled))
  // 不传 deadline 时保持原来的无限等待；只有「等待已收口 run 的收尾」这一处需要上限。
  if (options.admitDeadlineMs === undefined) {
    await settled
    return true
  }
  return await withinDeadline(settled, options.admitDeadlineMs)
}

export function runConflictsWithSession(
  run: { runId: string; externalSessionId?: string; sessionId?: string },
  resume: string | undefined,
  expected: string | null | undefined
): boolean {
  const sessionId = run.externalSessionId ?? run.sessionId
  if (resume) return sessionId === resume
  // An explicit new session has its own identity even before the Provider assigns an ID.
  if (expected === null) return false
  if (typeof expected === 'string') return run.runId === expected
  return !sessionId
}

// 首轮失败/停止后 catalog 只剩一个以 runId 命名的本地会话壳（appSessionCanResume=false）：
// 它没有原生 session 边界，但 renderer 仍然把它当作当前会话展示。
export function localOnlySessionShell(
  candidate: { runId: string; externalSessionId?: string; sessionId?: string }
): boolean {
  return (candidate.externalSessionId ?? candidate.sessionId ?? candidate.runId) === candidate.runId
}

export function expectedSessionMatches(
  expected: string | null | undefined,
  actual: string | undefined,
  candidates: () => Array<{ runId: string; externalSessionId?: string; sessionId?: string }>
): boolean {
  if (expected === undefined) return true
  if (expected === null) return actual === undefined
  if (expected === actual) return true
  // Most sends already carry the native session id. Read the catalog only for alias resolution,
  // and obtain a fresh snapshot at each admission boundary rather than caching across waits.
  return candidates().some((run) => {
    if (run.runId !== expected) return false
    if ((run.externalSessionId ?? run.sessionId) === actual) return true
    // main 侧没有任何原生 session（actual === undefined）时，这一轮必然新建 session，
    // 不可能把提示词投递到别的会话；拒绝只会把用户永久卡在这条本地会话壳里。
    // expected 指向可 resume 的会话而 actual 为空仍然拒绝：那才是真的丢了续接边界。
    return actual === undefined && localOnlySessionShell(run)
  })
}

export function expectedRestartSourceMatches(
  expected: string | null | undefined,
  actual: string | undefined,
  replaceRunId: string
): boolean {
  return actual === undefined && expected === replaceRunId
}

export function canRestartInterruptedLocalOnlySession(
  archive: { turns: Array<{ runId: string; status?: string; providerTurnId?: string; forkTurnId?: string }> } | null,
  replaceRunId: string
): boolean {
  if (!archive || archive.turns.length === 0 || archive.turns.at(-1)?.runId !== replaceRunId) return false
  return archive.turns.every((turn) =>
    turn.status === 'interrupted' && turn.providerTurnId == null && turn.forkTurnId == null
  )
}
