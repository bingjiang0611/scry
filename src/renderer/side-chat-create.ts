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
 * Whether one more command fits the ledger.
 *
 * The ledger is the only durable proof that a create might have been dispatched. Evicting
 * an unresolved row to make room would lose exactly that proof, so a full ledger refuses
 * the next creation before dispatch instead.
 */
export function canRecordCreateCommand(
  storage: Pick<Storage, 'getItem'> | undefined = defaultStorage()
): boolean {
  return readCreateCommands(storage).length < MAX_CREATE_COMMANDS
}

/** Returns whether the command is durable; dispatch must not start otherwise. */
export function writeCreateCommand(
  command: SideChatCreateCommand,
  storage: Pick<Storage, 'getItem' | 'setItem'> | undefined = defaultStorage()
): boolean {
  try {
    if (!storage) return false
    const existing = readCreateCommands(storage)
    const rows = existing.filter((row) => row.commandId !== command.commandId)
    if (rows.length >= MAX_CREATE_COMMANDS) return false
    rows.push(command)
    storage.setItem(STORAGE_KEY, JSON.stringify(rows))
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
  /** A reply was lost and the read-back did not find the child: still unknown. */
  | { kind: 'unknown' }
  | { kind: 'not-attempted' }

/** `not-found` is not proof of non-dispatch; only a found receipt may open a tab. */
export function resolveCreateReceipt(receipt: SideChatCommandReceipt): CreationResolution {
  return receipt.status === 'found'
    ? { kind: 'created', conversation: receipt.conversation }
    : { kind: 'unknown' }
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
 * What a lost create reply proves.
 *
 * A found receipt may open that child. A `not-found` answer proves nothing, so the
 * durable command stays and the next attempt is a read-only check, never a dispatch.
 */
export function lossOutcome(
  command: Pick<SideChatCreateCommand, 'scopeKey'>,
  resolution: CreationResolution,
  currentScopeKey: string,
  notice: { opened: string; elsewhere: string }
): { keepCommand: boolean; outcome?: CreateOutcome } {
  if (resolution.kind !== 'created') return { keepCommand: true }
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
