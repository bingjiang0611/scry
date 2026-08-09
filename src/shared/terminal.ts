export const TERMINAL_MAX_SESSIONS = 8
export const TERMINAL_MAX_INPUT_BYTES = 64 * 1024
export const TERMINAL_MAX_DIMENSION = 1_000

export interface TerminalStartRequest {
  cwd: string
  cols: number
  rows: number
}

export interface TerminalSessionInfo {
  id: string
  pid: number
  cwd: string
  cols: number
  rows: number
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
