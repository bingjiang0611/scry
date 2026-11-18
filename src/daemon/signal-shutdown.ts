export function createDaemonSignalShutdown(exit: (code: number) => void = process.exit): {
  stop(): void
  ready(dispose: () => Promise<void>): void
} {
  let dispose: (() => Promise<void>) | undefined
  let requested = false
  let stopping = false
  const run = (): void => {
    if (!requested || !dispose || stopping) return
    stopping = true
    void (async () => {
      try { await dispose() } finally { exit(0) }
    })()
  }
  return {
    stop() { requested = true; run() },
    ready(next) { dispose = next; run() }
  }
}
