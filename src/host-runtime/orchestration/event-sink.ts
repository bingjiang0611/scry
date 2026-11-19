import { existsSync } from 'node:fs'
import type { RunRegistry, RunRegistryControl, RunRegistryState } from '../../main/run-registry'
import { BodyStore } from './body-store'
import { assertBoundedPayload, assertNoUsageNumbersInEvent, canonicalJson } from './canonical-json'
import { openOrchestrationDatabase, type OpenOrchestrationDbOptions, type OrchestrationDbHandle } from './db'
import { getEffectPolicy } from './effect-policy'
import {
  deleteSessionInDb,
  pruneEventsInDb,
  verifyReplayConsistencyInDb,
  type DeleteSessionInput,
  type DeleteSessionOutcome
} from './event-sink-maintenance'
import {
  mapEventRow,
  mapOutboxRow,
  prepareEventSinkStatements,
  type EventSinkStatements
} from './event-sink-statements'
import { decide, type DecisionResult, type OrchestrationCommand, type OrchestratorReadView } from './orchestrator'
import {
  applyEventToProjection,
  mapInteractionRow,
  mapReceiptRow,
  mapRunRow,
  mapSessionRow,
  mapTurnRow
} from './projection'
import {
  ORCHESTRATION_EVENT_TYPES,
  OrchestrationStoreError,
  type CommandReceiptRow,
  type InteractionProjectionRow,
  type OrchestrationEventRow,
  type OutboxEffectRow,
  type RunProjectionRow,
  type SessionProjectionRow,
  type TurnProjectionRow
} from './types'

export type { DeleteSessionInput, DeleteSessionOutcome } from './event-sink-maintenance'

export interface EventSinkOptions extends OpenOrchestrationDbOptions {
  authorizedActors?: Iterable<string>
  maxActiveRuns?: number
  isProviderAuthenticating?: (provider: string, profile: string | null) => boolean
  /** Test seam invoked inside the commit transaction immediately before SQLite commits. */
  beforeCommitHook?: () => void
}

/**
 * Single-writer atomic persistence sink for P4 orchestration (core §2.5, data §4).
 * Commits events, projection updates, sticky command receipts, and outbox rows in one
 * SQLite transaction; any write/fsync failure trips a fail-closed fence that can only be
 * cleared by reopening, while still permitting tightening-only run stops.
 */
export class EventSink {
  readonly handle: OrchestrationDbHandle
  readonly bodyStore: BodyStore
  #authorizedActors: Set<string>
  #maxActiveRuns: number
  #isProviderAuthenticating: (provider: string, profile: string | null) => boolean
  #beforeCommitHook?: () => void
  #writeIndeterminate = false
  #walModeEnforced = false
  #stmts: EventSinkStatements

  private constructor(handle: OrchestrationDbHandle, options: EventSinkOptions) {
    this.handle = handle
    this.bodyStore = new BodyStore(handle.orchestrationDir)
    this.#authorizedActors = new Set(['system', ...(options.authorizedActors ?? [])])
    this.#maxActiveRuns = options.maxActiveRuns ?? 8
    this.#isProviderAuthenticating = options.isProviderAuthenticating ?? (() => false)
    this.#beforeCommitHook = options.beforeCommitHook
    this.#stmts = prepareEventSinkStatements(handle.db)
    this.#walModeEnforced = existsSync(`${handle.dbPath}-wal`)
  }

  private enforceModesOnceForWal(): void {
    if (this.#walModeEnforced) return
    if (existsSync(`${this.handle.dbPath}-wal`)) {
      this.handle.enforceModes()
      this.#walModeEnforced = true
    }
  }

  static open(options: EventSinkOptions): EventSink {
    const handle = openOrchestrationDatabase(options)
    return new EventSink(handle, options)
  }

  isWriteIndeterminate(): boolean {
    return this.#writeIndeterminate
  }

  /** Registers a verified peer actor so shadow/live commands under that peer pass auth checks. */
  authorizeActor(actor: string): void {
    this.#authorizedActors.add(actor)
  }

  private assertDeterminate(): void {
    if (this.#writeIndeterminate) {
      throw new OrchestrationStoreError('orchestration_write_indeterminate')
    }
  }

  private tripFence(error: unknown): never {
    this.#writeIndeterminate = true
    const message = error instanceof Error ? error.message : String(error)
    throw new OrchestrationStoreError('orchestration_write_indeterminate', message)
  }

  private createReadView(): OrchestratorReadView {
    return {
      isActorAuthorized: (actor) => actor.startsWith('effect:') || this.#authorizedActors.has(actor),
      getReceipt: (commandId, actor) => this.readReceiptRaw(commandId, actor),
      getRun: (runId) => this.readRunRaw(runId),
      getSession: (sessionKey) => this.readSessionRaw(sessionKey),
      getTurnByRunId: (runId) => this.readTurnByRunIdRaw(runId),
      getNextTurnOrdinal: (sessionKey) => this.readNextTurnOrdinalRaw(sessionKey),
      getInteraction: (runId, questionId) => this.readInteractionRaw(runId, questionId),
      listNonTerminalChildRuns: (parentRunId) => this.listNonTerminalChildRunsRaw(parentRunId),
      listNonTerminalChildRunsBySession: (sessionKey) => this.listNonTerminalChildRunsBySessionRaw(sessionKey),
      hasActiveRunForSession: (sessionKey) => Boolean(this.#stmts.hasActiveSessionRun.get(sessionKey)),
      activeRunCount: () => (this.#stmts.activeRunCount.get() as { count: number }).count,
      maxActiveRuns: () => this.#maxActiveRuns,
      isProviderAuthenticating: (provider, profile) => this.#isProviderAuthenticating(provider, profile)
    }
  }

  execute(
    command: OrchestrationCommand,
    txExtras?: { legacyLedgerSeq?: number; legacyRunMapping?: { ledgerRunId: string; runId: string } }
  ): DecisionResult {
    if (this.#writeIndeterminate) {
      return {
        kind: 'rejected',
        reason: 'orchestration_write_indeterminate',
        sticky: false,
        writeReceipt: false
      }
    }
    const decision = decide(command, this.createReadView())
    if (decision.kind === 'duplicate') {
      if (txExtras?.legacyLedgerSeq !== undefined) {
        this.advanceLegacyLedgerSeq(txExtras.legacyLedgerSeq)
      }
      return decision
    }
    if (decision.kind === 'rejected' && !decision.writeReceipt) return decision
    return this.commitDecision(decision, txExtras)
  }

  private advanceLegacyLedgerSeq(seq: number): void {
    try {
      this.#stmts.advanceLegacySeq.run(String(seq))
    } catch (error) {
      this.tripFence(error)
    }
  }

  private commitDecision(
    decision: Extract<DecisionResult, { kind: 'accepted' | 'rejected' }>,
    txExtras?: { legacyLedgerSeq?: number; legacyRunMapping?: { ledgerRunId: string; runId: string } }
  ): DecisionResult {
    const db = this.handle.db
    try {
      const tx = db.transaction(() => {
        let lastSeq: number | null = null
        if (decision.kind === 'accepted') {
          for (const pending of decision.events) {
            if (!ORCHESTRATION_EVENT_TYPES.has(pending.type)) {
              throw new OrchestrationStoreError('orchestration_invalid_event', `Invalid event type: ${pending.type}`)
            }
            assertNoUsageNumbersInEvent(pending.type, pending.payload)
            const payloadJson = assertBoundedPayload(pending.payload)
            const evidenceJson = pending.evidence ? canonicalJson(pending.evidence) : null
            const info = this.#stmts.insertEvent.run(
              pending.eventId,
              pending.at,
              pending.type,
              pending.stream,
              pending.sessionKey,
              pending.runId,
              pending.cwd,
              pending.commandId,
              pending.actor,
              pending.scope,
              payloadJson,
              evidenceJson,
              pending.principal,
              pending.via,
              pending.actorRunId
            )
            const seq = Number(info.lastInsertRowid)
            lastSeq = seq
            applyEventToProjection(db, { ...pending, seq })
          }

          const causationSeq = lastSeq ?? 0
          for (const effect of decision.effects) {
            const spec = getEffectPolicy(effect.kind)
            const payloadJson = assertBoundedPayload(effect.payload)
            this.#stmts.insertOutbox.run(
              effect.effectId,
              effect.kind,
              spec.policy,
              effect.runId,
              causationSeq,
              payloadJson,
              effect.state,
              effect.expiresAt,
              effect.leaseOwner,
              effect.claimedAt,
              effect.state === 'done' ? decision.receipt.acceptedAt : null
            )
          }
        }

        const receipt = decision.kind === 'accepted' ? decision.receipt : decision.receipt
        if (receipt) {
          const finalSeq = decision.kind === 'accepted' ? lastSeq : null
          receipt.resultSeq = finalSeq
          this.#stmts.insertCommand.run(
            receipt.commandId,
            receipt.actor,
            receipt.type,
            receipt.payloadSha256,
            receipt.acceptedAt,
            receipt.status,
            receipt.reason,
            receipt.result ? canonicalJson(receipt.result) : null,
            finalSeq,
            receipt.principal,
            receipt.via,
            receipt.actorRunId
          )
        }

        if (txExtras?.legacyRunMapping) {
          this.#stmts.insertLegacyRun.run(txExtras.legacyRunMapping.ledgerRunId, txExtras.legacyRunMapping.runId)
        }
        if (txExtras?.legacyLedgerSeq !== undefined) {
          this.#stmts.advanceLegacySeq.run(String(txExtras.legacyLedgerSeq))
        }

        this.#beforeCommitHook?.()
      })
      tx()
      this.enforceModesOnceForWal()
      return decision
    } catch (error) {
      if (error instanceof OrchestrationStoreError && error.code !== 'orchestration_write_indeterminate') {
        throw error
      }
      this.tripFence(error)
    }
  }

  /**
   * core §2.5 + R5: tightening-only stop bypasses the storage fence without touching SQLite
   * and cascades along in-memory `RunRegistryState.parentRunId` edges.
   */
  stopRunBypassingFence<State extends RunRegistryState, Control extends RunRegistryControl>(
    runId: string,
    registry: RunRegistry<State, Control>,
    stopControl: (control: Control) => void
  ): string[] {
    const visited = new Set<string>()
    const queue = [runId]
    const stopped: string[] = []
    while (queue.length > 0) {
      const current = queue.shift()!
      if (visited.has(current)) continue
      visited.add(current)
      const entry = registry.get(current)
      if (entry && !entry.state.done) {
        stopControl(entry.control)
        stopped.push(current)
      }
      for (const active of registry.activeStates()) {
        if (active.parentRunId === current && !visited.has(active.runId)) {
          queue.push(active.runId)
        }
      }
    }
    return stopped
  }

  deleteSession(input: DeleteSessionInput): DeleteSessionOutcome {
    if (this.#writeIndeterminate) {
      return { status: 'unavailable', error: 'orchestration_write_indeterminate' }
    }
    try {
      const { existed, unreferencedShas, redactedEvents } = deleteSessionInDb(
        this.handle.db,
        input,
        this.#beforeCommitHook
      )
      if (!existed) return { status: 'not_present' }
      for (const sha of unreferencedShas) this.bodyStore.unlinkBody(sha)
      this.handle.enforceModes()
      return { status: 'deleted', deletedBodies: unreferencedShas.length, redactedEvents }
    } catch (error) {
      this.#writeIndeterminate = true
      return { status: 'unavailable', error: error instanceof Error ? error.message : String(error) }
    }
  }

  pruneEvents(options: { olderThanAt: number }): { deletedEvents: number; prunedThrough: number } {
    this.assertDeterminate()
    try {
      const current = Number(this.getMeta('pruned_through') ?? '0')
      return pruneEventsInDb(this.handle.db, options.olderThanAt, current)
    } catch (error) {
      this.tripFence(error)
    }
  }

  verifyReplayConsistency(): { matches: boolean; diff?: string } {
    this.assertDeterminate()
    return verifyReplayConsistencyInDb(this.handle.db, this.listEvents())
  }

  getMeta(key: string): string | undefined {
    this.assertDeterminate()
    const row = this.handle.db.prepare('SELECT value FROM orch_meta WHERE key = ?').get(key) as
      | { value: string }
      | undefined
    return row?.value
  }

  setMeta(key: string, value: string): void {
    this.assertDeterminate()
    try {
      this.handle.db
        .prepare('INSERT OR REPLACE INTO orch_meta (key, value) VALUES (?, ?)')
        .run(key, value)
    } catch (error) {
      this.tripFence(error)
    }
  }

  getReceipt(commandId: string, actor: string): CommandReceiptRow | undefined {
    this.assertDeterminate()
    return this.readReceiptRaw(commandId, actor)
  }

  getRun(runId: string): RunProjectionRow | undefined {
    this.assertDeterminate()
    return this.readRunRaw(runId)
  }

  getSession(sessionKey: string): SessionProjectionRow | undefined {
    this.assertDeterminate()
    return this.readSessionRaw(sessionKey)
  }

  getTurn(sessionKey: string, ordinal: number): TurnProjectionRow | undefined {
    this.assertDeterminate()
    const row = this.handle.db
      .prepare('SELECT * FROM orch_p_turn WHERE session_key = ? AND ordinal = ?')
      .get(sessionKey, ordinal) as Record<string, unknown> | undefined
    return row ? mapTurnRow(row) : undefined
  }

  getTurnByRunId(runId: string): TurnProjectionRow | undefined {
    this.assertDeterminate()
    return this.readTurnByRunIdRaw(runId)
  }

  getNextTurnOrdinal(sessionKey: string): number {
    this.assertDeterminate()
    return this.readNextTurnOrdinalRaw(sessionKey)
  }

  getInteraction(runId: string, questionId: string): InteractionProjectionRow | undefined {
    this.assertDeterminate()
    return this.readInteractionRaw(runId, questionId)
  }

  listEvents(): OrchestrationEventRow[] {
    this.assertDeterminate()
    const rows = this.handle.db.prepare('SELECT * FROM orch_event ORDER BY seq ASC').all() as Array<
      Record<string, unknown>
    >
    return rows.map(mapEventRow)
  }

  listOutbox(): OutboxEffectRow[] {
    this.assertDeterminate()
    const rows = this.handle.db
      .prepare('SELECT * FROM orch_outbox ORDER BY causation_seq ASC, effect_id ASC')
      .all() as Array<Record<string, unknown>>
    return rows.map(mapOutboxRow)
  }

  close(): void {
    this.handle.close()
  }

  private readReceiptRaw(commandId: string, actor: string): CommandReceiptRow | undefined {
    const row = this.#stmts.readReceipt.get(commandId, actor) as Record<string, unknown> | undefined
    return row ? mapReceiptRow(row) : undefined
  }

  private readRunRaw(runId: string): RunProjectionRow | undefined {
    const row = this.#stmts.readRun.get(runId) as Record<string, unknown> | undefined
    return row ? mapRunRow(row) : undefined
  }

  private readSessionRaw(sessionKey: string): SessionProjectionRow | undefined {
    const row = this.#stmts.readSession.get(sessionKey) as Record<string, unknown> | undefined
    return row ? mapSessionRow(row) : undefined
  }

  private readTurnByRunIdRaw(runId: string): TurnProjectionRow | undefined {
    const row = this.#stmts.readTurnByRunId.get(runId) as Record<string, unknown> | undefined
    return row ? mapTurnRow(row) : undefined
  }

  private readNextTurnOrdinalRaw(sessionKey: string): number {
    const row = this.#stmts.nextOrdinal.get(sessionKey) as { next_ordinal: number }
    return Number(row.next_ordinal)
  }

  private readInteractionRaw(runId: string, questionId: string): InteractionProjectionRow | undefined {
    const row = this.#stmts.readInteraction.get(runId, questionId) as Record<string, unknown> | undefined
    return row ? mapInteractionRow(row) : undefined
  }

  private listNonTerminalChildRunsRaw(parentRunId: string): RunProjectionRow[] {
    const rows = this.#stmts.listNonTerminalChildRuns.all(parentRunId) as Array<Record<string, unknown>>
    return rows.map(mapRunRow)
  }

  private listNonTerminalChildRunsBySessionRaw(sessionKey: string): RunProjectionRow[] {
    const rows = this.#stmts.listNonTerminalChildRunsBySession.all(sessionKey) as Array<Record<string, unknown>>
    return rows.map(mapRunRow)
  }
}
