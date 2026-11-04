// Shared database row contracts. Kept apart from the modules that produce them so
import type { ToolContentPolicy } from '../core/turn-recorder/tool-content.js'
import type { BillingProvider } from '../shared/billing'
import type { ProviderId } from '../shared/provider'
import type { RuntimeProvider } from '../shared/runtime'
import type { TraceEvent } from '../shared/trace'
// the outbox and the turn writer do not have to import each other.
export interface RecordTurnArgs {
  toolContentPolicy?: ToolContentPolicy
  runId: string
  sessionId?: string
  cwd?: string
  userText: string
  items: TraceEvent[]
  runtimeProvider?: RuntimeProvider
  providerId?: ProviderId
  billingProvider?: BillingProvider
}
