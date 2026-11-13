import type { DesktopTerminalEvent, DesktopTerminalEvents } from '../shared/desktop-workbench'

// Daemon mode (P3-terminal.md): terminal output waits in the daemon's queue; a feed
// notice says so. This reads the queue by cursor until it is empty and hands each event
// to the window on the channel main used in process. One read at a time; a notice that
// arrives during a read makes it read once more instead of starting a second reader.
// Flow control stays in the daemon's output bridge (ready/ack), so nothing is buffered here.

export interface DaemonTerminalReaderDeps {
  read(cursor: string | undefined): Promise<DesktopTerminalEvents>
  send(channel: string, payload: unknown): void
  canSend(): boolean
  onWarn?(message: string, detail?: unknown): void
}

export class DaemonTerminalReader {
  readonly #deps: DaemonTerminalReaderDeps
  #cursor: string | undefined
  #reading = false
  #again = false
  #disposed = false

  constructor(deps: DaemonTerminalReaderDeps) {
    this.#deps = deps
  }

  notice(): void {
    if (this.#disposed) return
    if (this.#reading) { this.#again = true; return }
    void this.#drain()
  }

  dispose(): void {
    this.#disposed = true
  }

  async #drain(): Promise<void> {
    this.#reading = true
    try {
      do {
        this.#again = false
        for (;;) {
          const page = await this.#deps.read(this.#cursor)
          if (this.#disposed) return
          this.#cursor = page.cursor
          if (page.events.length === 0) break
          for (const event of page.events) this.#deliver(event)
        }
      } while (this.#again && !this.#disposed)
    } catch (error) {
      // The next notice reads again from the same cursor; nothing was skipped.
      this.#deps.onWarn?.('daemon terminal output read failed', error)
    } finally {
      this.#reading = false
    }
  }

  // A window that cannot receive drops the output, as main's bridge does: the daemon is
  // told the renderer detached, and the next attach replays from the recording.
  #deliver(event: DesktopTerminalEvent): void {
    if (!this.#deps.canSend()) return
    if (event.kind === 'data' && Array.isArray(event.events)) this.#deps.send('terminal:data', event.events)
    else if (event.kind === 'exit' && event.event) this.#deps.send('terminal:exit', event.event)
    else if (event.kind === 'recordingError' && event.event) this.#deps.send('terminal:recordingError', event.event)
  }
}
