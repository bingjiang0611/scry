// Selected Provider capability reads share only work that is currently in flight.
// No result is retained after completion because Provider freshness/reload policy
// is adapter-owned and an unbounded remote cache would turn stale controls into
// apparent authorization.
export function createInFlightDeduper<T>(): {
  load(key: string, operation: () => Promise<T>): Promise<T>
  size(): number
} {
  const pending = new Map<string, Promise<T>>()
  return {
    load(key, operation) {
      const existing = pending.get(key)
      if (existing) return existing
      const next = operation()
      pending.set(key, next)
      void next.finally(() => { if (pending.get(key) === next) pending.delete(key) }).catch(() => {})
      return next
    },
    size: () => pending.size
  }
}
