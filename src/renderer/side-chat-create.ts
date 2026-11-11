import type {
  ConversationSideChatRequest, ConversationSummary, SideChatCommandReceipt, SideChatList, SideChatListRequest,
  SideChatPreview
} from '@shared/conversation-api'
import { isCommandId } from '@shared/runtime'
import type { SideChatInitialTarget, SideChatSource } from '@shared/conversation'

/**
 * Durable record of one side-chat creation command.
 *
 * It is written before the create IPC starts, so a lost reply is resolved by reading the
 * same command id back instead of guessing or dispatching a second child. It contains
 * ids and fingerprints only: no prompt, no credentials, no transcript text.
 */
export interface SideChatCreateCommand {
  commandId: string
  scopeKey: string
  source: SideChatSource
  expectedThroughOrdinal: number
  expectedThroughRunId: string
  expectedPrefixFingerprint: string
  expectedManifestFingerprint: string
  initialTarget?: SideChatInitialTarget
  createdAt: number
}

const STORAGE_KEY = 'scry.side-chat-create-commands.v1'
/** Bounded command ledger: older attempts leave the window instead of growing forever. */
export const MAX_CREATE_COMMANDS = 8
const HASH = /^[a-f0-9]{64}$/

function defaultStorage(): Pick<Storage, 'getItem' | 'setItem'> | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage
  } catch {
    return undefined
  }
}

function validSource(value: unknown): value is SideChatSource {
  if (!value || typeof value !== 'object') return false
  const source = value as { kind?: unknown; conversationId?: unknown; providerId?: unknown; cwd?: unknown; nativeSessionId?: unknown }
  if (source.kind === 'conversation') return typeof source.conversationId === 'string' && source.conversationId.length > 0
  if (source.kind !== 'native-session') return false
  return typeof source.providerId === 'string' && typeof source.cwd === 'string' && source.cwd.startsWith('/') &&
    typeof source.nativeSessionId === 'string' && source.nativeSessionId.length > 0
}

function validTarget(value: unknown): SideChatInitialTarget | undefined {
  if (!value || typeof value !== 'object') return undefined
  const target = value as SideChatInitialTarget
  if (typeof target.providerId !== 'string' || !target.providerId) return undefined
  if (typeof target.permissionMode !== 'string' || !target.permissionMode) return undefined
  return target
}

function validCommand(value: unknown): SideChatCreateCommand | undefined {
  if (!value || typeof value !== 'object') return undefined
  const command = value as SideChatCreateCommand
  if (typeof command.commandId !== 'string' || !isCommandId(command.commandId)) return undefined
  if (typeof command.scopeKey !== 'string' || !command.scopeKey) return undefined
  if (!validSource(command.source)) return undefined
  if (!Number.isSafeInteger(command.expectedThroughOrdinal) || command.expectedThroughOrdinal <= 0) return undefined
  if (typeof command.expectedThroughRunId !== 'string' || !command.expectedThroughRunId) return undefined
  if (typeof command.expectedPrefixFingerprint !== 'string' || !HASH.test(command.expectedPrefixFingerprint)) return undefined
  if (typeof command.expectedManifestFingerprint !== 'string' || !HASH.test(command.expectedManifestFingerprint)) return undefined
  if (!Number.isSafeInteger(command.createdAt) || command.createdAt <= 0) return undefined
  const initialTarget = validTarget(command.initialTarget)
  return { commandId: command.commandId, scopeKey: command.scopeKey, source: command.source,
    expectedThroughOrdinal: command.expectedThroughOrdinal, expectedThroughRunId: command.expectedThroughRunId,
    expectedPrefixFingerprint: command.expectedPrefixFingerprint,
    expectedManifestFingerprint: command.expectedManifestFingerprint,
    ...(initialTarget ? { initialTarget } : {}), createdAt: command.createdAt }
}

export function readCreateCommands(
  storage: Pick<Storage, 'getItem'> | undefined = defaultStorage()
): SideChatCreateCommand[] {
  try {
    const parsed = JSON.parse(storage?.getItem(STORAGE_KEY) ?? '[]') as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.map(validCommand).filter((command) => command !== undefined).slice(-MAX_CREATE_COMMANDS)
  } catch {
    return []
  }
}

/**
 * Returns whether the command is durable; dispatch must not start otherwise.
 *
 * The ledger stays bounded. Callers first settle what a full ledger can prove with
 * `settleFullLedger`; only a row that is still unresolved after that is dropped, oldest
 * first. Refusing instead once blocked every later creation in every parent behind
 * commands nobody could reach any more. A dropped row loses only the "check this create"
 * shortcut: a child that was really created is still listed in its source's history.
 */
export function writeCreateCommand(
  command: SideChatCreateCommand,
  storage: Pick<Storage, 'getItem' | 'setItem'> | undefined = defaultStorage()
): boolean {
  try {
    if (!storage) return false
    const rows = readCreateCommands(storage).filter((row) => row.commandId !== command.commandId)
    rows.push(command)
    storage.setItem(STORAGE_KEY, JSON.stringify(rows.slice(-MAX_CREATE_COMMANDS)))
    return true
  } catch {
    return false
  }
}

export function clearCreateCommand(
  commandId: string,
  storage: Pick<Storage, 'getItem' | 'setItem'> | undefined = defaultStorage()
): void {
  try {
    if (!storage) return
    const rows = readCreateCommands(storage).filter((row) => row.commandId !== commandId)
    storage.setItem(STORAGE_KEY, JSON.stringify(rows))
  } catch {
    // A retained command only makes the next read-back look again; it never creates.
  }
}

/** The exact request one durable command may dispatch; identity is pinned, not recomputed. */
export function createRequestOf(command: SideChatCreateCommand): ConversationSideChatRequest {
  return {
    source: command.source,
    expectedThroughOrdinal: command.expectedThroughOrdinal,
    expectedThroughRunId: command.expectedThroughRunId,
    expectedPrefixFingerprint: command.expectedPrefixFingerprint,
    expectedManifestFingerprint: command.expectedManifestFingerprint,
    commandId: command.commandId,
    ...(command.initialTarget ? { initialTarget: command.initialTarget } : {})
  }
}

/**
 * The command a preview authorizes. Called once per explicit create, before any IPC, so
 * the source, boundary, fingerprints and target the user saw are the ones dispatched
 * even if the parent session keeps running or the visible scope changes.
 */
export function commandFromPreview({
  preview, scopeKey, commandId, initialTarget, createdAt = Date.now()
}: {
  preview: SideChatPreview
  scopeKey: string
  commandId: string
  initialTarget?: SideChatInitialTarget
  createdAt?: number
}): SideChatCreateCommand {
  return {
    commandId,
    scopeKey,
    source: preview.source,
    expectedThroughOrdinal: preview.throughOrdinal,
    expectedThroughRunId: preview.throughRunId,
    expectedPrefixFingerprint: preview.prefixFingerprint,
    expectedManifestFingerprint: preview.manifestFingerprint,
    ...(initialTarget ? { initialTarget } : {}),
    createdAt
  }
}

export type CreationResolution =
  | { kind: 'created'; conversation: ConversationSummary }
  /** The host answered and no child owns this command id. */
  | { kind: 'not-created' }
  /** The lookup itself could not be read; nothing is known about the command. */
  | { kind: 'unknown' }

/**
 * What a read-back receipt proves about one create command.
 *
 * Creation is a local host write keyed by the command id. The host reports a command it is
 * still executing as `in-flight` (a renderer reloaded mid-create), which stays unknown. A
 * `not-found` answer therefore means the command published nothing. It used to be kept as
 * "unknown" forever, which turned every ordinary host refusal into a parent that could
 * never create a side chat again.
 */
export function resolveCreateReceipt(receipt: SideChatCommandReceipt): CreationResolution {
  if (receipt.status === 'found') return { kind: 'created', conversation: receipt.conversation }
  // The host is still running that create: its result is not known, so the command stays.
  if (receipt.status === 'in-flight') return { kind: 'unknown' }
  return { kind: 'not-created' }
}

/**
 * Result of a create reply that arrived for a command pinned to a scope.
 *
 * The child's owning scope is compared with the scope that is visible *now*: a child
 * created while the user switched parents must never land in another parent's layout.
 * It is not deleted either — it stays discoverable from its own source history.
 */
export type CreateOutcome =
  | { kind: 'open'; conversation: ConversationSummary; notice: string }
  | { kind: 'elsewhere'; conversation: ConversationSummary; notice: string }

export function createdOutcome(
  command: Pick<SideChatCreateCommand, 'scopeKey'>,
  currentScopeKey: string,
  conversation: ConversationSummary,
  notice: { opened: string; elsewhere: string }
): CreateOutcome {
  return command.scopeKey === currentScopeKey
    ? { kind: 'open', conversation, notice: notice.opened }
    : { kind: 'elsewhere', conversation, notice: notice.elsewhere }
}

/**
 * What the read-back of a failed create proves.
 *
 * A found receipt may open that child. A conclusive `not-created` settles the command as
 * refused, so the next click is an ordinary create. Only an unreadable lookup keeps the
 * durable command for a later read-only check.
 */
export function lossOutcome(
  command: Pick<SideChatCreateCommand, 'scopeKey'>,
  resolution: CreationResolution,
  currentScopeKey: string,
  notice: { opened: string; elsewhere: string }
): { keepCommand: boolean; refused?: true; outcome?: CreateOutcome } {
  if (resolution.kind === 'unknown') return { keepCommand: true }
  if (resolution.kind === 'not-created') return { keepCommand: false, refused: true }
  return { keepCommand: false, outcome: createdOutcome(command, currentScopeKey, resolution.conversation, notice) }
}

/** Read-back lookup for one durable command; never creates and never re-dispatches. */
export async function findCreatedSideChat(
  api: { findSideChatCommand: (source: SideChatSource, commandId: string) => Promise<SideChatCommandReceipt> },
  command: SideChatCreateCommand
): Promise<CreationResolution> {
  try {
    return resolveCreateReceipt(await api.findSideChatCommand(command.source, command.commandId))
  } catch {
    // An unreadable lookup proves nothing about the command.
    return { kind: 'unknown' }
  }
}

/**
 * Frees ledger rows whose outcome the host can now prove, before a new command needs room.
 *
 * Only a full ledger is read back, one bounded lookup per row: a found child or a
 * conclusive not-created settles its row. An in-flight or unreadable row stays, so the
 * eviction that may follow can only ever drop a command nobody can resolve right now.
 */
export async function settleFullLedger(
  api: { findSideChatCommand: (source: SideChatSource, commandId: string) => Promise<SideChatCommandReceipt> },
  storage: Pick<Storage, 'getItem' | 'setItem'> | undefined = defaultStorage()
): Promise<number> {
  const rows = readCreateCommands(storage)
  if (rows.length < MAX_CREATE_COMMANDS) return 0
  let settled = 0
  for (const row of rows) {
    const resolution = await findCreatedSideChat(api, row)
    if (resolution.kind === 'unknown') continue
    clearCreateCommand(row.commandId, storage)
    settled += 1
  }
  return settled
}

/** One page of the child history of this source. */
export async function listSideChatPage(
  api: { listSideChats: (request: SideChatListRequest) => Promise<SideChatList> },
  source: SideChatSource,
  options: { cursor?: string; limit?: number } = {}
): Promise<SideChatList> {
  return api.listSideChats({ source, ...options })
}

export type SideChatRestoreAnswer = ReadonlyMap<string, ConversationSummary> | 'unreadable'

/**
 * Decision for a restored tab layout from bounded summary metadata only.
 *
 * A missing id inside a successful selected-id answer is conclusive for that id, because
 * the answer covered exactly the ids that were asked for. A read that threw proves
 * nothing, so every tab stays open with no records and no drop. No child transcript is
 * read to make this decision.
 */
export function restoreTabOutcome(
  openIds: readonly string[],
  answer: SideChatRestoreAnswer
): { restored: ReadonlyMap<string, ConversationSummary>; missing: readonly string[] } {
  if (answer === 'unreadable') return { restored: new Map(), missing: [] }
  return { restored: answer, missing: openIds.filter((id) => !answer.has(id)) }
}

/**
 * Bounded summary lookup for the ids a restored layout still wants to show.
 *
 * A child that is missing from the answer is not treated as deleted here: only a
 * conclusive `not-found` for a specific id is, and that decision stays with the caller.
 */
export async function lookupSideChatSummaries(
  api: { listSideChats: (request: SideChatListRequest & { ids?: readonly string[] }) => Promise<SideChatList> },
  source: SideChatSource,
  ids: readonly string[]
): Promise<ReadonlyMap<string, ConversationSummary>> {
  const bounded = [...new Set(ids)].slice(0, 8)
  if (bounded.length === 0) return new Map()
  const list = await api.listSideChats({ source, ids: bounded, limit: bounded.length })
  return new Map(list.items.map((item) => [item.id, item]))
}
