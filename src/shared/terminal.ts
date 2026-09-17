export const TERMINAL_MAX_SESSIONS = 8
export const TERMINAL_MAX_INPUT_BYTES = 64 * 1024
export const TERMINAL_MAX_DIMENSION = 1_000

export interface TerminalStartRequest {
  cwd: string | null
  cols: number
  rows: number
}

export interface TerminalSessionInfo {
  id: string
  pid: number
  recording?: 'available' | 'unavailable'
  cwd: string
  cols: number
  rows: number
}

export interface TerminalRecordingRequest {
  id: string
  /** Byte offset in the UTF-16LE recording, not UTF-8 or a character index. */
  offset: number
  limit?: number
}

export interface TerminalRecordingPage {
  id: string
  encoding: 'utf16le'
  data: string
  offset: number
  nextOffset: number
  totalBytes: number
  hasMore: boolean
  state: 'recording' | 'complete' | 'interrupted' | 'failed'
  exit?: TerminalExitEvent
}

export interface TerminalRecordingListRequest {
  after?: string
  limit?: number
}

export interface TerminalRecordingSummary {
  id: string
  startedAt?: number
  bytes: number
  state: TerminalRecordingPage['state']
  active: boolean
}

export interface TerminalRecordingListPage {
  items: TerminalRecordingSummary[]
  nextCursor: string | null
  /** Some metadata could not be read; no foreign workspace identities are exposed. */
  partial: boolean
}

export interface TerminalRecordingErrorEvent {
  id: string
  message: string
}

export interface TerminalWriteRequest {
  id: string
  data: string
}

export interface TerminalResizeRequest {
  id: string
  cols: number
  rows: number
}

export interface TerminalCloseRequest {
  id: string
}

export interface TerminalDataEvent {
  id: string
  data: string
}

export interface TerminalExitEvent {
  id: string
  code: number | null
  signal: number | null
}
