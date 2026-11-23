interface ScanWork {
  scanCatalog(): Promise<void>
  scanDetail(sessionKey: string, opening: boolean): Promise<void>
  onError(error: unknown): void
}

interface ScanPoll {
  readers: number
  nextAt: number
  running: boolean
  timer?: ReturnType<typeof setTimeout>
  retire?: ReturnType<typeof setTimeout>
}

const CATALOG_INTERVAL_MS = 30_000
const DETAIL_INTERVAL_MS = 2_000

/** Timers are owned by in-flight subscription reads. Keep the catalog deadline
 * across long polls so each 25-second request does not reset the 30-second scan. */
export class CatalogSubscriptionScans {
  readonly #work: ScanWork
  readonly #catalog: ScanPoll = { readers: 0, nextAt: 0, running: false }
  readonly #details = new Map<string, ScanPoll>()

  constructor(work: ScanWork) {
    this.#work = work
  }

  sessions(opening: boolean): () => void {
    return this.#attach(this.#catalog, CATALOG_INTERVAL_MS, opening, () => this.#work.scanCatalog())
  }

  detail(sessionKey: string, opening: boolean): () => void {
    let poll = this.#details.get(sessionKey)
    if (!poll) {
      poll = { readers: 0, nextAt: Date.now() + DETAIL_INTERVAL_MS, running: false }
      this.#details.set(sessionKey, poll)
    }
    clearTimeout(poll.retire)
    const state = poll
    return this.#attach(
      poll, DETAIL_INTERVAL_MS, opening,
      (first) => this.#work.scanDetail(sessionKey, first),
      // Preserve the deadline across adjacent long polls, without scanning a closed view.
      () => {
        state.retire = setTimeout(() => this.#details.delete(sessionKey), DETAIL_INTERVAL_MS)
        state.retire.unref()
      }
    )
  }

  #attach(
    poll: ScanPoll,
    interval: number,
    opening: boolean,
    work: (first: boolean) => Promise<void>,
    onIdle?: () => void
  ): () => void {
    const schedule = (): void => {
      if (poll.readers === 0 || poll.running || poll.timer) return
      poll.timer = setTimeout(() => {
        poll.timer = undefined
        run(false)
      }, Math.max(0, poll.nextAt - Date.now()))
      poll.timer.unref()
    }
    const run = (first: boolean): void => {
      if (poll.running) return
      clearTimeout(poll.timer)
      poll.timer = undefined
      poll.running = true
      poll.nextAt = Date.now() + interval
      void work(first).catch((error) => this.#work.onError(error)).finally(() => {
        poll.running = false
        if (poll.readers === 0) onIdle?.()
        schedule()
      })
    }

    poll.readers += 1
    if (opening) run(true)
    else schedule()
    return () => {
      poll.readers -= 1
      if (poll.readers === 0) {
        clearTimeout(poll.timer)
        poll.timer = undefined
        if (!poll.running) onIdle?.()
      }
    }
  }
}
