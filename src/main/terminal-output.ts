import { Buffer } from 'node:buffer'
import type { TerminalDataEvent, TerminalExitEvent } from '../shared/terminal'

export interface TerminalOutputBridgeOptions {
  canSend(): boolean
  sendData(events: TerminalDataEvent[]): void
  sendExit(event: TerminalExitEvent): void
  pauseTerminal(id: string): void
  resumeTerminal(id: string): void
  flushBytes?: number
  highWaterBytes?: number
  maxBufferBytes?: number
  flushMs?: number
  warn?: (message: string, id: string) => void
}

interface TerminalOutputState {
  ready: boolean
  buffer: string
  bufferedBytes: number
  inFlightBytes: number
  trailingHighSurrogate: boolean
  paused: boolean
  pendingExit?: TerminalExitEvent
  timer?: ReturnType<typeof setTimeout>
}

function isHighSurrogate(unit: number): boolean {
  return unit >= 0xD800 && unit <= 0xDBFF
}

function isLowSurrogate(unit: number): boolean {
  return unit >= 0xDC00 && unit <= 0xDFFF
}

function appendedUtf8Bytes(trailingHighSurrogate: boolean, appended: string): number {
  let bytes = Buffer.byteLength(appended, 'utf8')
  // Buffer counts an isolated surrogate as the three-byte replacement character. When PTY
  // chunks split one Unicode scalar, joining them turns those six provisional bytes into four.
  if (trailingHighSurrogate && isLowSurrogate(appended.charCodeAt(0))) bytes -= 2
  return bytes
}

function utf8Prefix(value: string, totalBytes: number, maxBytes: number): { prefix: string; rest: string; bytes: number } {
  if (totalBytes <= maxBytes) return { prefix: value, rest: '', bytes: totalBytes }
  let units = 0
  let bytes = 0
  for (const character of value) {
    const next = Buffer.byteLength(character, 'utf8')
    if (bytes + next > maxBytes) break
    units += character.length
    bytes += next
  }
  return { prefix: value.slice(0, units), rest: value.slice(units), bytes }
}

export class TerminalOutputBridge {
  private readonly states = new Map<string, TerminalOutputState>()
  private readonly flushBytes: number
  private readonly highWaterBytes: number
  private readonly maxBufferBytes: number
  private readonly flushMs: number

  constructor(private readonly options: TerminalOutputBridgeOptions) {
    this.flushBytes = options.flushBytes ?? 256 * 1024
    this.highWaterBytes = options.highWaterBytes ?? 4 * 1024 * 1024
    this.maxBufferBytes = options.maxBufferBytes ?? 16 * 1024 * 1024
    this.flushMs = options.flushMs ?? 16
  }

  started(id: string): void {
    this.state(id)
  }

  ready(id: string): void {
    const state = this.state(id)
    state.ready = true
    this.flush(id)
    this.finishIfDrained(id, state)
  }

  data(event: TerminalDataEvent): void {
    const state = this.state(event.id)
    state.bufferedBytes += appendedUtf8Bytes(state.trailingHighSurrogate, event.data)
    state.buffer += event.data
    if (event.data.length > 0) state.trailingHighSurrogate = isHighSurrogate(event.data.charCodeAt(event.data.length - 1))
    if (!state.paused && state.bufferedBytes + state.inFlightBytes >= this.maxBufferBytes) {
      // Pause PTY reads, not the process. The current native chunk is retained intact; the
      // high-water threshold may be exceeded by that chunk. Kernel pipe backpressure bounds
      // further output until the renderer catches up, without discarding output or killing work.
      state.paused = true
      this.options.pauseTerminal(event.id)
      this.options.warn?.('terminal output paused pending renderer acknowledgement', event.id)
    }
    if (state.bufferedBytes >= this.flushBytes) this.flush(event.id)
    else if (!state.timer) state.timer = setTimeout(() => this.flush(event.id), this.flushMs)
  }

  exit(event: TerminalExitEvent): void {
    const state = this.states.get(event.id)
    if (!state) return
    state.pendingExit = event
    this.flush(event.id)
    this.finishIfDrained(event.id, state)
  }

  ack(id: string, bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.maxBufferBytes) {
      throw new Error('终端输出确认无效')
    }
    const state = this.states.get(id)
    if (!state) return
    state.inFlightBytes = Math.max(0, state.inFlightBytes - bytes)
    this.flush(id)
    if (state.paused && state.bufferedBytes + state.inFlightBytes <= this.maxBufferBytes / 2) {
      state.paused = false
      this.options.resumeTerminal(id)
    }
    this.finishIfDrained(id, state)
  }

  terminalClosed(id: string): void {
    this.closeState(id)
  }

  close(): void {
    for (const id of [...this.states.keys()]) this.closeState(id)
  }

  snapshot(id: string): { bufferedBytes: number; inFlightBytes: number; ready: boolean; pendingExit: boolean; paused: boolean } {
    const state = this.states.get(id)
    return {
      bufferedBytes: state?.bufferedBytes ?? 0,
      inFlightBytes: state?.inFlightBytes ?? 0,
      ready: state?.ready ?? false,
      pendingExit: state?.pendingExit != null,
      paused: state?.paused ?? false
    }
  }

  private state(id: string): TerminalOutputState {
    let state = this.states.get(id)
    if (!state) {
      state = {
        ready: false,
        buffer: '',
        bufferedBytes: 0,
        inFlightBytes: 0,
        trailingHighSurrogate: false,
        paused: false
      }
      this.states.set(id, state)
    }
    return state
  }

  private flush(id: string): void {
    const state = this.states.get(id)
    if (!state) return
    if (state.timer) clearTimeout(state.timer)
    state.timer = undefined
    if (!state.ready || !this.options.canSend() || !state.buffer || state.inFlightBytes >= this.highWaterBytes) return
    const available = Math.min(this.flushBytes, this.highWaterBytes - state.inFlightBytes)
    if (available <= 0) return
    const chunk = utf8Prefix(state.buffer, state.bufferedBytes, available)
    if (chunk.bytes === 0) return
    state.buffer = chunk.rest
    state.bufferedBytes = Math.max(0, state.bufferedBytes - chunk.bytes)
    if (!chunk.rest) state.trailingHighSurrogate = false
    state.inFlightBytes += chunk.bytes
    this.options.sendData([{ id, data: chunk.prefix }])
  }

  private finishIfDrained(id: string, state: TerminalOutputState): void {
    if (
      !state.pendingExit || state.bufferedBytes > 0 ||
      state.inFlightBytes > 0 ||
      !state.ready || !this.options.canSend()
    ) return
    const event = state.pendingExit
    this.closeState(id)
    this.options.sendExit(event)
  }

  private closeState(id: string): void {
    const state = this.states.get(id)
    if (state?.timer) clearTimeout(state.timer)
    this.states.delete(id)
  }
}
