import { Buffer } from 'node:buffer'
import type { TerminalDataEvent, TerminalExitEvent } from '../shared/terminal'

export interface TerminalOutputBridgeOptions {
  canSend(): boolean
  sendData(events: TerminalDataEvent[]): void
  sendExit(event: TerminalExitEvent): void
  closeTerminal(id: string): void
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
  pendingExit?: TerminalExitEvent
  timer?: ReturnType<typeof setTimeout>
}

function utf8Prefix(value: string, maxBytes: number): { prefix: string; rest: string; bytes: number } {
  const total = Buffer.byteLength(value, 'utf8')
  if (total <= maxBytes) return { prefix: value, rest: '', bytes: total }
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
    state.buffer += event.data
    state.bufferedBytes = Buffer.byteLength(state.buffer, 'utf8')
    if (state.bufferedBytes + state.inFlightBytes > this.maxBufferBytes) {
      this.closeState(event.id)
      this.options.closeTerminal(event.id)
      this.options.warn?.('terminal closed after output backlog exceeded safety limit', event.id)
      return
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
    this.finishIfDrained(id, state)
  }

  terminalClosed(id: string): void {
    this.closeState(id)
  }

  close(): void {
    for (const id of [...this.states.keys()]) this.closeState(id)
  }

  snapshot(id: string): { bufferedBytes: number; inFlightBytes: number; ready: boolean; pendingExit: boolean } {
    const state = this.states.get(id)
    return {
      bufferedBytes: state?.bufferedBytes ?? 0,
      inFlightBytes: state?.inFlightBytes ?? 0,
      ready: state?.ready ?? false,
      pendingExit: state?.pendingExit != null
    }
  }

  private state(id: string): TerminalOutputState {
    let state = this.states.get(id)
    if (!state) {
      state = { ready: false, buffer: '', bufferedBytes: 0, inFlightBytes: 0 }
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
    const chunk = utf8Prefix(state.buffer, available)
    if (chunk.bytes === 0) return
    state.buffer = chunk.rest
    state.bufferedBytes = Buffer.byteLength(state.buffer, 'utf8')
    state.inFlightBytes += chunk.bytes
    this.options.sendData([{ id, data: chunk.prefix }])
  }

  private finishIfDrained(id: string, state: TerminalOutputState): void {
    if (!state.pendingExit || state.bufferedBytes > 0 || state.inFlightBytes > 0 || !state.ready || !this.options.canSend()) return
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
