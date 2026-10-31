import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ConversationApi, ConversationSummary, SideChatPreview } from '@shared/conversation-api'
import type { SideChatInitialTarget, SideChatSource } from '@shared/conversation'
import { SIDE_CHAT_COPY } from '../constants/side-chat-copy'
import type { SideChatEntry, SideChatTabView } from '../components/RightSurfacePanel'
import {
  canRecordCreateCommand, clearCreateCommand, commandFromPreview, createRequestOf, createdOutcome, findCreatedSideChat,
  lookupSideChatSummaries, lossOutcome, readCreateCommands, restoreTabOutcome, writeCreateCommand,
  type SideChatCreateCommand, type SideChatRestoreAnswer
} from '../side-chat-create'
import { useSideChatHistory } from './useSideChatHistory'

const CREATE_NOTICE = { opened: SIDE_CHAT_COPY.created, elsewhere: SIDE_CHAT_COPY.creationScopeChanged }

export type SideChatApi = Pick<ConversationApi,
  'previewSideChat' | 'createSideChat' | 'listSideChats' | 'findSideChatCommand'>

const message = SIDE_CHAT_COPY.reasonOf
/** The host accepts one bounded selected-id answer for eight tabs and not more. */
const MAX_VALIDATED_TABS = 8

export interface SideChatHistory {
  open: boolean
  loading: boolean
  error?: string
  total?: number
  /** Rows of exactly one page; the dialog never grows past `HISTORY_PAGE` rows. */
  items: readonly ConversationSummary[]
  /** An older page exists. */
  canLoadMore: boolean
  /** Where this page's rows sit inside the whole history; absent for an empty page. */
  range?: { first: number; last: number }
  /** A newer page was walked past and can be restored from the cursor stack. */
  canLoadPrevious: boolean
  show: () => void
  close: () => void
  loadMore: () => void
  loadPrevious: () => void
  select: (conversation: ConversationSummary) => void
}

export interface SideChatWorkspace {
  records: ReadonlyMap<string, ConversationSummary>
  tabs: SideChatTabView[]
  entry: SideChatEntry
  history: SideChatHistory
  /** Re-validates the open tabs; coalesced, so a burst of changes reads once. */
  refresh: () => void
  closeChild: (conversationId: string) => void
  /** The child this workspace just created; its first mount may take composer focus. */
  createdId?: string
  clearCreated: () => void
}

/** Stable identity of a source, so an equal source object is not a new dependency. */
export function sideChatSourceKey(source: SideChatSource | undefined): string {
  if (!source) return ''
  return source.kind === 'conversation'
    ? `conversation:${source.conversationId}`
    : `native:${JSON.stringify([source.providerId, source.agentProfileId ?? null, source.cwd, source.nativeSessionId])}`
}

/** Metadata equality: a summary that says the same thing must not cause a rerender. */
function sameSummary(left: ConversationSummary, right: ConversationSummary): boolean {
  return left.id === right.id && left.revision === right.revision && left.title === right.title &&
    left.activeRunId === right.activeRunId && left.archivedAt === right.archivedAt &&
    left.lastRunOutcome === right.lastRunOutcome && left.sideChat?.throughOrdinal === right.sideChat?.throughOrdinal
}

/**
 * Owner of the side-chat instances of one parent scope.
 *
 * Creation composes a fixed order: read the frozen prefix (preview), persist the exact
 * command ledger entry, then dispatch. The tab view state is display-only throughout:
 * closing a tab, switching tabs or restoring a layout never stops a run and never
 * deletes a child record. Restored tabs are validated through one bounded summary
 * lookup, not by reading each hidden transcript.
 *
 * Every effect runs on semantic keys (scope, source identity, open-tab ids) and reads
 * the current callbacks from a ref. A rerender caused by a notice or a status token
 * therefore cannot start another metadata read, and two clicks cannot start two
 * creations.
 *
 * Every continuation that resumes after an `await` compares the scope and source it
 * started with against the live ones. A preview, history page or read-back that answers
 * after the user switched parents may still persist a child in the scope it was created
 * for, but it can never write a notice, dialog page or focus request into another parent.
 */
export function useSideChatWorkspace({
  api, scopeKey, source, target, openIds, hasCompletedTurn, unavailableReason, onOpen, onDrop, onClose, statusOf
}: {
  api?: SideChatApi
  scopeKey: string
  source?: SideChatSource
  /** Runtime intent of the parent controls at click time; revalidated by main on send. */
  target?: SideChatInitialTarget
  openIds: readonly string[]
  hasCompletedTurn: boolean
  unavailableReason?: string
  /** Opens the child in the scope it was created for; never in whatever is visible now. */
  onOpen: (conversationId: string, scopeKey: string) => void
  onDrop: (conversationIds: readonly string[]) => void
  onClose: (conversationId: string) => void
  statusOf?: (conversation: ConversationSummary) => string | undefined
}): SideChatWorkspace {
  const [records, setRecords] = useState<ReadonlyMap<string, ConversationSummary>>(() => new Map())
  const [creating, setCreating] = useState(false)
  const [notice, setNotice] = useState<string>()
  const [unknownCommand, setUnknownCommand] = useState<SideChatCreateCommand>()
  const [createdId, setCreatedId] = useState<string>()

  const sourceKey = sideChatSourceKey(source)
  const openKey = openIds.join(',')
  // One ref holds the inputs whose identity legitimately changes every render. Effects
  // and the create path read it, so they never depend on a fresh object or callback.
  const latest = useRef({ api, source, target, openIds, hasCompletedTurn, onOpen, onDrop, onClose, statusOf, scopeKey })
  latest.current = { api, source, target, openIds, hasCompletedTurn, onOpen, onDrop, onClose, statusOf, scopeKey }
  const busy = useRef(false)
  const inFlight = useRef<string>()

  /** Whether the parent this continuation started in is still the one on screen. */
  const fenceHolds = useCallback((pinnedScope: string, pinnedSource: string): boolean =>
    latest.current.scopeKey === pinnedScope && sideChatSourceKey(latest.current.source) === pinnedSource, [])

  const mergeRecords = useCallback((incoming: ReadonlyMap<string, ConversationSummary>): void => {
    if (incoming.size === 0) return
    setRecords((previous) => {
      let next: Map<string, ConversationSummary> | undefined
      for (const [id, summary] of incoming) {
        const existing = previous.get(id)
        if (existing && sameSummary(existing, summary)) continue
        next ??= new Map(previous)
        next.set(id, summary)
      }
      return next ?? previous
    })
  }, [])

  const validateTabs = useCallback(async (): Promise<void> => {
    const current = latest.current
    const ids = [...new Set(current.openIds)].slice(-MAX_VALIDATED_TABS)
    if (!current.api || !current.source || ids.length === 0) return
    const pinnedScope = current.scopeKey
    const pinnedSource = sideChatSourceKey(current.source)
    const key = `${pinnedScope}\0${pinnedSource}\0${ids.join(',')}`
    // A second read for the same tabs proves nothing new; the answer is already coming.
    if (inFlight.current === key) return
    inFlight.current = key
    const apply = (answer: SideChatRestoreAnswer): void => {
      if (!fenceHolds(pinnedScope, pinnedSource)) return
      const outcome = restoreTabOutcome(ids, answer)
      mergeRecords(outcome.restored)
      if (outcome.missing.length > 0) latest.current.onDrop(outcome.missing)
    }
    try {
      apply(await lookupSideChatSummaries(current.api, current.source, ids))
    } catch {
      // An unreadable lookup proves nothing; every tab stays open.
      apply('unreadable')
    } finally {
      if (inFlight.current === key) inFlight.current = undefined
    }
  }, [fenceHolds, mergeRecords])

  useEffect(() => {
    // Only a semantic change revalidates: another scope, another source, other tab ids.
    void validateTabs()
  }, [scopeKey, sourceKey, openKey, api, validateTabs])

  useEffect(() => {
    // A create command left behind by an earlier session is offered as a read-only
    // check. It is never dispatched again from here, and only the exact source that
    // recorded it may present it.
    setUnknownCommand(readCreateCommands().filter((command) =>
      command.scopeKey === scopeKey && sideChatSourceKey(command.source) === sourceKey).at(-1))
    setNotice(undefined)
  }, [scopeKey, sourceKey])

  useEffect(() => {
    // Only the open tabs need a summary. A closed child's metadata is not retained, so
    // this map stays bounded by the number of tabs instead of by the whole history.
    const open = new Set(openIds)
    setRecords((previous) => {
      let next: Map<string, ConversationSummary> | undefined
      for (const id of previous.keys()) {
        if (open.has(id)) continue
        next ??= new Map(previous)
        next.delete(id)
      }
      return next ?? previous
    })
  }, [openKey, openIds])

  const runCreate = useCallback(async (boundary?: number): Promise<void> => {
    const current = latest.current
    if (!current.api || !current.source || busy.current || !current.hasCompletedTurn) return
    busy.current = true
    setCreating(true)
    setNotice(SIDE_CHAT_COPY.creating)
    // Pin identity before the first await: scope, source, target and the command id the
    // preview authorizes. A parent switch during preview cannot redirect the child.
    const pinned = { scopeKey: current.scopeKey, source: current.source,
      sourceKey: sideChatSourceKey(current.source), target: current.target, api: current.api }
    const mine = (): boolean => fenceHolds(pinned.scopeKey, pinned.sourceKey)
    const commandId = globalThis.crypto.randomUUID()
    let preview: SideChatPreview
    try {
      preview = await pinned.api.previewSideChat(pinned.source, {
        ...(pinned.target ? { initialTarget: pinned.target } : {}),
        ...(boundary === undefined ? {} : { completedThroughOrdinal: boundary })
      })
    } catch (error) {
      if (mine()) setNotice(SIDE_CHAT_COPY.createRefused(message(error)))
      setCreating(false)
      busy.current = false
      return
    }
    if (!mine()) {
      // Nothing was written and nothing was created: the preview is read-only.
      setCreating(false)
      busy.current = false
      return
    }
    const command = commandFromPreview({
      preview, scopeKey: pinned.scopeKey, commandId,
      ...(pinned.target ?? preview.target ? { initialTarget: pinned.target ?? preview.target } : {})
    })
    if (!canRecordCreateCommand()) {
      // An unresolved command would be lost if the ledger evicted it. Refuse before
      // dispatch instead of creating a child nobody can prove afterwards.
      setNotice(SIDE_CHAT_COPY.createRefused(SIDE_CHAT_COPY.createLedgerFull))
      setCreating(false)
      busy.current = false
      return
    }
    if (!writeCreateCommand(command)) {
      setNotice(SIDE_CHAT_COPY.createRefused(SIDE_CHAT_COPY.createDurableUnavailable))
      setCreating(false)
      busy.current = false
      return
    }
    try {
      const child = await pinned.api.createSideChat(createRequestOf(command))
      clearCreateCommand(command.commandId)
      const outcome = createdOutcome(command, latest.current.scopeKey, child, CREATE_NOTICE)
      if (outcome.kind === 'elsewhere') {
        // The child exists and belongs to the scope it was created from. Persist the tab
        // there without selecting or showing it in the parent the user switched to, and
        // leave this parent's notice, focus and records untouched.
        latest.current.onOpen(outcome.conversation.id, command.scopeKey)
        return
      }
      setUnknownCommand(undefined)
      setCreatedId(outcome.conversation.id)
      latest.current.onOpen(outcome.conversation.id, command.scopeKey)
      mergeRecords(new Map([[outcome.conversation.id, outcome.conversation]]))
      setNotice(preview.firstSendBlockedReason
        ? `${outcome.notice} ${SIDE_CHAT_COPY.previewBlocked(preview.firstSendBlockedReason)}`
        : outcome.notice)
    } catch {
      // The reply was lost or the host refused after the ledger entry existed. Read the
      // same command id back; a not-found answer stays unknown and never re-dispatches.
      const resolution = await findCreatedSideChat(pinned.api, command)
      const loss = lossOutcome(command, resolution, latest.current.scopeKey, CREATE_NOTICE)
      if (loss.keepCommand) {
        // The unresolved command stays durable for the scope that issued it. Another
        // parent's entry keeps its own notice and is never blocked by this one.
        if (mine()) {
          setUnknownCommand(command)
          setNotice(SIDE_CHAT_COPY.createUnknown)
        }
        return
      }
      clearCreateCommand(command.commandId)
      if (loss.outcome?.kind === 'open') {
        setCreatedId(loss.outcome.conversation.id)
        latest.current.onOpen(loss.outcome.conversation.id, command.scopeKey)
        mergeRecords(new Map([[loss.outcome.conversation.id, loss.outcome.conversation]]))
        setNotice(SIDE_CHAT_COPY.createRecovered)
      } else if (loss.outcome?.kind === 'elsewhere') {
        latest.current.onOpen(loss.outcome.conversation.id, command.scopeKey)
      } else if (mine()) setNotice(SIDE_CHAT_COPY.creationScopeChanged)
      if (mine()) setUnknownCommand(undefined)
    } finally {
      setCreating(false)
      busy.current = false
    }
  }, [fenceHolds, mergeRecords])

  const checkUnknown = useCallback(async (): Promise<void> => {
    const current = latest.current
    const command = unknownCommand
    if (!current.api || !command || busy.current) return
    const pinned = { scopeKey: current.scopeKey, sourceKey: sideChatSourceKey(current.source) }
    const mine = (): boolean => fenceHolds(pinned.scopeKey, pinned.sourceKey)
    busy.current = true
    setCreating(true)
    const resolution = await findCreatedSideChat(current.api, command)
    busy.current = false
    setCreating(false)
    if (resolution.kind === 'created') {
      clearCreateCommand(command.commandId)
      // The child belongs to the command's own scope, which may no longer be visible.
      latest.current.onOpen(resolution.conversation.id, command.scopeKey)
      if (!mine()) return
      setUnknownCommand(undefined)
      mergeRecords(new Map([[resolution.conversation.id, resolution.conversation]]))
      setNotice(SIDE_CHAT_COPY.createRecovered)
      return
    }
    if (mine()) setNotice(SIDE_CHAT_COPY.createNotFoundUnknown)
  }, [fenceHolds, mergeRecords, unknownCommand])

  const history = useSideChatHistory({
    ...(api ? { api } : {}), ...(source ? { source } : {}), scopeKey, fenceHolds,
    select: (conversation: ConversationSummary) => {
      // Opening an existing child is a tab action; it reads no transcript here.
      mergeRecords(new Map([[conversation.id, conversation]]))
      latest.current.onOpen(conversation.id, latest.current.scopeKey)
    }
  })

  const entry = useMemo<SideChatEntry>(() => {
    const reason = unavailableReason ?? (!source ? SIDE_CHAT_COPY.entryUnavailableNoSource
      : !hasCompletedTurn ? SIDE_CHAT_COPY.entryUnavailableNoTurn : undefined)
    return {
      label: SIDE_CHAT_COPY.surfaceLabel,
      description: SIDE_CHAT_COPY.entryDescription,
      ...(reason ? { unavailableReason: reason } : {}),
      onSelect: () => { void (unknownCommand ? checkUnknown() : runCreate()) },
      historyLabel: SIDE_CHAT_COPY.historyLabel,
      onOpenHistory: () => history.show(),
      ...(notice ? { notice } : {}),
      ...(creating ? { creating: true } : {})
    }
  }, [checkUnknown, creating, hasCompletedTurn, history, notice, runCreate, source, unknownCommand, unavailableReason])

  const tabs = useMemo<SideChatTabView[]>(() => openIds.map((id) => {
    const record = records.get(id)
    const status = record ? statusOf?.(record) : undefined
    return { conversationId: id, title: record?.title ?? id, ...(status ? { status } : {}) }
  }), [openIds, records, statusOf])

  const refresh = useCallback((): void => { void validateTabs() }, [validateTabs])
  const clearCreated = useCallback((): void => setCreatedId(undefined), [])
  return { records, tabs, entry, history, refresh, closeChild: onClose, createdId, clearCreated }
}
