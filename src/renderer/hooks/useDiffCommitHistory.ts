import { useCallback, useEffect, useRef, useState } from 'react'
import type { DiffCommit } from '@shared/diff-history'
import type { TurnDiffReview } from '../turn-diff'

interface Page {
  key: string
  commits: DiffCommit[]
  nextOffset: number | null
  truncated: boolean
  pending: boolean
  failed: boolean
}
interface Selection {
  key: string
  hash: string
  pending: boolean
  review: TurnDiffReview | null
}

export function useDiffCommitHistory(cwd: string | null, source: TurnDiffReview | null) {
  const head = source?.head
  const baseCommit = source?.comparison?.baseCommit
  const key = cwd && head && baseCommit ? JSON.stringify([cwd, head, baseCommit]) : ''
  const [tab, setTab] = useState<'files' | 'commits'>('files')
  const [page, setPage] = useState<Page>()
  const [selection, setSelection] = useState<Selection>()
  const pageRequest = useRef(0)
  const commitRequest = useRef(0)
  useEffect(() => {
    // Returning to the same range must not revive a cancelled pending request.
    setPage(undefined)
    setSelection(undefined)
    return () => { pageRequest.current++; commitRequest.current++ }
  }, [key])

  const load = useCallback(async (offset = 0): Promise<void> => {
    if (!key || !cwd || !head || !baseCommit) return
    const id = ++pageRequest.current
    setPage(previous => ({ key, commits: offset && previous?.key === key ? previous.commits : [], nextOffset: offset,
      truncated: false, pending: true, failed: false }))
    try {
      const result = typeof window.scry.gitDiffCommits === 'function'
        ? await window.scry.gitDiffCommits({ cwd, head, baseCommit, offset }) : null
      if (id !== pageRequest.current) return
      setPage(previous => result?.status === 'available'
        ? { key, commits: [...(offset && previous?.key === key ? previous.commits : []), ...result.commits],
          nextOffset: result.nextOffset, truncated: result.truncated, pending: false, failed: false }
        : { key, commits: previous?.key === key ? previous.commits : [], nextOffset: offset, truncated: false, pending: false, failed: true })
    } catch {
      if (id === pageRequest.current) setPage(previous => ({ key, commits: previous?.key === key ? previous.commits : [],
        nextOffset: offset, truncated: false, pending: false, failed: true }))
    }
  }, [key, cwd, head, baseCommit])
  useEffect(() => {
    if (tab === 'commits' && key && page?.key !== key) void load()
  }, [tab, key, page?.key, load])

  const select = useCallback(async (hash: string | null): Promise<void> => {
    const id = ++commitRequest.current
    if (!hash) { setSelection(undefined); return }
    if (!key || !cwd || !head || !baseCommit) return
    setSelection({ key, hash, pending: true, review: null })
    try {
      const result = typeof window.scry.gitCommitDiffSnapshot === 'function'
        ? await window.scry.gitCommitDiffSnapshot({ cwd, head, baseCommit, commit: hash }) : null
      if (id !== commitRequest.current) return
      setSelection({ key, hash, pending: false, review: result?.status === 'captured' ? {
        scope: 'branch', runId: result.revision, revision: result.revision, head: result.head,
        userText: '', turnDiff: result.snapshot, commit: result.commit
      } : null })
    } catch {
      if (id === commitRequest.current) setSelection({ key, hash, pending: false, review: null })
    }
  }, [key, cwd, head, baseCommit])
  const current = selection?.key === key ? selection : undefined
  return { tab, setTab, available: Boolean(key), page: page?.key === key ? page : undefined,
    load, select, selected: current?.hash, pending: current?.pending ?? false, review: current?.review ?? null }
}
export type DiffCommitHistory = ReturnType<typeof useDiffCommitHistory>
