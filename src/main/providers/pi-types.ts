import type { AgentSteerInput, AgentSteerResult } from '../../shared/runtime'
import type { JsonRecord } from './pi-shared'
import type { PiRpcProcess } from './pi-rpc'
import type { PiRunDiagnostics } from './pi-run-diagnostics'

export interface PiProbe {
  state: JsonRecord
  models: JsonRecord[]
  levels: string[]
  commands: JsonRecord[]
}

export interface PiEntrySnapshot {
  entries: JsonRecord[]
  leafId: string | null
  appendCursor: string | null
}

export interface PiRunState {
  stopped: boolean
  diagnostics?: PiRunDiagnostics
  sessionId?: string
  sessionFile?: string
  persistedSessionId?: string
  providerTurnId?: string
  recordingFailure?: { message: string }
  rpc?: PiRpcProcess
  steerAdmissionUncertain?: boolean
  steerDispatched?: boolean
  steer?: (input: AgentSteerInput) => Promise<AgentSteerResult>
}
