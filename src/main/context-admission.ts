export class ContextAdmission {
  private readonly tails = new Map<string, Promise<void>>()

  async run<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => { release = resolve })
    this.tails.set(key, current)
    await previous
    try {
      return await action()
    } finally {
      release()
      if (this.tails.get(key) === current) this.tails.delete(key)
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

export function expectedSessionMatches(
  expected: string | null | undefined,
  actual: string | undefined,
  candidates: Array<{ runId: string; externalSessionId?: string; sessionId?: string }>
): boolean {
  if (expected === undefined) return true
  if (expected === null) return actual === undefined
  if (expected === actual) return true
  return candidates.some((run) =>
    run.runId === expected && (run.externalSessionId ?? run.sessionId) === actual
  )
}
