import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { WorkspaceDiffSnapshotResult } from '@shared/workspace-diff'
import type { WorkspaceDiffResult } from '@shared/trace'
import type { Turn } from '../format'
import { sessionDiffViewFromTurns, turnDiffViewOf, type DiffScope, type TurnDiffReview } from '../turn-diff'
import type { DiffReviewSelection } from './useDiffReviewSelection'
import { useWorkspaceDiff } from './useWorkspaceDiff'

/** Select exactly one scope. Missing/empty/failed evidence never falls back to another scope. */
export function scopedDiffReview(turns: readonly Turn[], selection: DiffReviewSelection | null): TurnDiffReview | null {
  const scope = selection?.scope ?? 'session'
  if (scope === 'workspace') return null
  if (scope === 'session') {
    const found = sessionDiffViewFromTurns(turns)
    return found ? {
      scope, runId: found.turn.runId, userText: found.turn.userText,
      turnDiff: found.view.turnDiff, preview: found.view.preview, initialPath: selection?.initialPath
    } : null
  }
  const turn = selection?.runId ? turns.find(item => item.runId === selection.runId) : turns.at(-1)
  const view = turn && turnDiffViewOf(turn.items)
  return turn && view ? {
    scope, runId: turn.runId, userText: turn.userText, turnDiff: view.turnDiff,
    preview: view.preview, initialPath: selection?.initialPath
  } : null
}

export function useNarrowDiffLayout(): boolean {
  // The existing static-render smoke has no viewport; only the client can replace the conversation.
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 1100px)').matches)
  useEffect(() => {
    const media = window.matchMedia('(max-width: 1100px)')
    const update = (): void => setNarrow(media.matches)
    media.addEventListener('change', update)
    update()
    return () => media.removeEventListener('change', update)
  }, [])
  return narrow
}

export function diffTurnOptions(turns: readonly Turn[], offset = 0) {
  return turns.map((turn, index) => ({ runId: turn.runId, index: offset + index, prompt: turn.userText }))
}

export function useDiffInspector(input: {
  cwd: string | null
  summaryCwd: string | null
  summary: WorkspaceDiffResult | null | undefined
  summaryRefreshing: boolean
  turns: readonly Turn[]
  turnOffset?: number
  selection: DiffReviewSelection | null
  select: (selection: DiffReviewSelection) => void
  enabled: boolean
  refreshKey: number
}) {
  const { cwd, turns, selection, select, enabled, refreshKey } = input
  const scope = selection?.scope ?? 'session'
  const snapshotEnabled = enabled && scope === 'workspace' && cwd !== null
  const [refreshSequence, setRefreshSequence] = useState(0)
  const request = useRef(0)
  const [capture, setCapture] = useState<{ cwd: string; result?: WorkspaceDiffSnapshotResult; refreshing: boolean }>()
  const refresh = useCallback(() => setRefreshSequence(value => value + 1), [])

  // A unified conversation may display a different cwd from the retained native draft.
  const secondaryCwd = cwd !== input.summaryCwd ? cwd : null
  const secondaryRef = useRef(secondaryCwd)
  secondaryRef.current = secondaryCwd
  const secondary = useWorkspaceDiff(secondaryCwd, secondaryRef)
  useEffect(() => secondary.loadGitDiff(secondaryCwd), [secondaryCwd, refreshKey, refreshSequence])

  useEffect(() => {
    const id = ++request.current
    if (!snapshotEnabled || !cwd) return
    setCapture(previous => ({ cwd, result: previous?.cwd === cwd ? previous.result : undefined, refreshing: true }))
    const load = async (): Promise<void> => {
      let result: WorkspaceDiffSnapshotResult
      try {
        result = typeof window.scry.gitDiffSnapshot === 'function'
          ? await window.scry.gitDiffSnapshot(cwd)
          : { status: 'unavailable', reason: 'request_failed', files: [] }
      } catch {
        result = { status: 'failed', reason: 'request_failed', files: [] }
      }
      if (request.current === id) setCapture({ cwd, result, refreshing: false })
    }
    void load()
    return () => { request.current++ }
  }, [cwd, snapshotEnabled, refreshKey, refreshSequence])

  useEffect(() => {
    if (!snapshotEnabled && !secondaryCwd) return
    let timer: number | undefined
    const schedule = (): void => {
      if (document.hidden || timer !== undefined) return
      timer = window.setTimeout(() => { timer = undefined; refresh() }, 100)
    }
    const unsubscribe = window.scry.onDataUpdated?.(schedule)
    window.addEventListener('focus', schedule)
    document.addEventListener('visibilitychange', schedule)
    return () => {
      if (timer !== undefined) window.clearTimeout(timer)
      unsubscribe?.()
      window.removeEventListener('focus', schedule)
      document.removeEventListener('visibilitychange', schedule)
    }
  }, [snapshotEnabled, secondaryCwd, refresh])

  const result = capture?.cwd === cwd ? capture.result : undefined
  const refreshing = snapshotEnabled && (capture?.cwd !== cwd || capture.refreshing)
  const review = useMemo<TurnDiffReview | null>(() => {
    if (scope !== 'workspace') return scopedDiffReview(turns, selection)
    return result?.status === 'captured' ? {
      scope, runId: result.revision, revision: result.revision, head: result.head,
      userText: '', turnDiff: result.snapshot, initialPath: selection?.initialPath
    } : null
  }, [scope, turns, selection, result])
  const baseSummary = secondaryCwd ? secondary.gitDiff : cwd ? input.summary : undefined
  const baseRefreshing = secondaryCwd ? secondary.gitDiffRefreshing : input.summaryRefreshing
  const summary: WorkspaceDiffResult | null | undefined = snapshotEnabled && result
    ? result.status === 'captured'
      ? { status: 'captured', files: result.snapshot.files, collectedAt: result.collectedAt }
      : result
    : baseSummary
  const turnOptions = useMemo(() => diffTurnOptions(turns, input.turnOffset), [turns, input.turnOffset])
  return {
    cwd, scope, review, refreshing, summary,
    summaryRefreshing: snapshotEnabled ? refreshing : baseRefreshing,
    pending: snapshotEnabled && !result,
    failure: scope === 'workspace' && result && result.status !== 'captured' ? result : undefined,
    emptySession: turns.length === 0,
    selectedRunId: selection?.runId ?? turns.at(-1)?.runId ?? '', turnOptions,
    latestTurn: scope === 'turn' && !selection?.runId,
    refresh,
    selectScope: (next: DiffScope): void => select({ scope: next }),
    selectTurn: (runId: string): void => select({ scope: 'turn', runId })
  }
}
