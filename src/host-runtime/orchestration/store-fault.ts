import { OrchestrationStoreError, type CommandReceiptRow, type StickyRejectionReason } from './types'

/**
 * A1: only these storage faults make the committed state unknowable, so only they fence the store.
 * Everything else (constraint violations, decision-time invariants) rolls back a single command.
 */
const FATAL_SQLITE_CODE =
  /^SQLITE_(IOERR|FULL|CORRUPT|NOTADB|CANTOPEN|PROTOCOL|INTERNAL|NOMEM|READONLY)/
const FATAL_MESSAGE = /SQLITE_(IOERR|FULL|CORRUPT|NOTADB)|fsync|disk i.o|input.output error/i

/**
 * R8: contention is not a decision. `SQLITE_BUSY`/`SQLITE_LOCKED` say another writer held the lock, so
 * the command was never decided — writing a rejection receipt for it refused a deterministic command id
 * forever. The caller retries instead.
 */
const RETRYABLE_SQLITE_CODE = /^SQLITE_(BUSY|LOCKED)/
const RETRYABLE_MESSAGE = /database is locked|database table is locked|SQLITE_BUSY|SQLITE_LOCKED/i

export function isRetryableOrchestrationStoreError(error: unknown): boolean {
  if (error instanceof OrchestrationStoreError) return error.code === 'orchestration_db_locked'
  const code = (error as { code?: unknown } | null)?.code
  if (typeof code === 'string' && RETRYABLE_SQLITE_CODE.test(code)) return true
  return RETRYABLE_MESSAGE.test(error instanceof Error ? error.message : String(error))
}

export function isFatalOrchestrationStoreError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  if (typeof code === 'string' && FATAL_SQLITE_CODE.test(code)) return true
  if (typeof code === 'string' && code.startsWith('SQLITE_')) return false
  return FATAL_MESSAGE.test(error instanceof Error ? error.message : String(error))
}

export interface RollbackRejection {
  base: CommandReceiptRow | undefined
  error: unknown
  /** Writes the rejection receipt in its own transaction. */
  writeReceipt: (receipt: CommandReceiptRow) => void
}

/**
 * A1: a non-fatal commit failure rolls back exactly one command. The caller gets a sticky
 * rejection, and the receipt is written on its own so a retry of the same command id is a
 * deterministic duplicate instead of a repeat rollback.
 */
export function buildRollbackRejection(
  input: RollbackRejection,
  reason: StickyRejectionReason = 'illegal_transition'
): { receipt?: CommandReceiptRow; reason: StickyRejectionReason } {
  const { base, error } = input
  const detail = error instanceof Error ? error.message : String(error)
  if (!base) {
    console.warn(`[scry] orchestration command rejected and rolled back: ${detail}`)
    return { reason }
  }
  const receipt: CommandReceiptRow = {
    ...base,
    status: 'rejected',
    reason,
    result: null,
    resultSeq: null
  }
  try {
    input.writeReceipt(receipt)
  } catch (writeError) {
    if (isFatalOrchestrationStoreError(writeError)) throw writeError
  }
  console.warn(`[scry] orchestration command rejected and rolled back: ${receipt.type}: ${detail}`)
  return { receipt, reason }
}
