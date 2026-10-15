export class ContextAdmission {
  private readonly tails = new Map<string, Promise<void>>()

  run<T>(key: string, action: () => Promise<T>): Promise<T> {
    return this.runMany([key], action)
  }

  async runMany<T>(keys: readonly string[], action: () => Promise<T>): Promise<T> {
    const ownedKeys = [...new Set(keys)]
    if (ownedKeys.length === 0) throw new Error('Context admission requires at least one identity')
    const previous = ownedKeys.map((key) => this.tails.get(key) ?? Promise.resolve())
    let release!: () => void
    const current = new Promise<void>((resolve) => { release = resolve })
    // Reserve every tail before yielding. Nested per-key waits could deadlock A→B vs B→A.
    for (const key of ownedKeys) this.tails.set(key, current)
    await Promise.all(previous)
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
  runs: Array<{ done: boolean; settled: Promise<void> }>
): Promise<boolean> {
  if (runs.some((run) => !run.done)) return false
  await Promise.all(runs.map((run) => run.settled))
  return true
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
