export const TERMINAL_MAX_INPUT_BYTES = 64 * 1024
export const TERMINAL_MAX_DIMENSION = 1_000

export interface TerminalStartRequest {
  cwd: string | null
  cols: number
  rows: number
}

export interface TerminalSessionDescriptor {
  id: string
  pid: number
  recording?: 'available' | 'unavailable'
  cwd: string
  cols: number
  rows: number
}

export interface TerminalSessionInfo extends TerminalSessionDescriptor {
  ownershipEpoch: number
}

export interface TerminalAttachInfo extends TerminalSessionInfo {
  catchUp: {
    endOffset: number
    state: 'available' | 'partial' | 'unavailable'
  }
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

export interface TerminalOwnershipRequest {
  id: string
  ownershipEpoch: number
}

export interface TerminalWriteRequest extends TerminalOwnershipRequest {
  data: string
}

export interface TerminalResizeRequest extends TerminalOwnershipRequest {
  cols: number
  rows: number
}

export interface TerminalCloseRequest {
  id: string
  ownershipEpoch?: number
}

export interface TerminalDataEvent {
  id: string
  ownershipEpoch: number
  data: string
}

export interface TerminalExitEvent {
  id: string
  code: number | null
  signal: number | null
  ownershipEpoch?: number
}
