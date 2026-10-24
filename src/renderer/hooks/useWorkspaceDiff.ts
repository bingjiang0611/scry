import { useCallback, useRef, useState, type MutableRefObject } from 'react'
import type { WorkspaceDiffResult } from '@shared/trace'

export function useWorkspaceDiff(cwd: string | null, cwdRef: MutableRefObject<string | null>) {
  // Keep same-workspace evidence visible during refresh; never reuse it across cwd.
  const [gitDiff, setGitDiff] = useState<WorkspaceDiffResult | null>()
  const [gitDiffRefreshing, setGitDiffRefreshing] = useState(false)
  const gitDiffCwdRef = useRef<string | null>(null)
  const gitDiffRequestSeq = useRef(0)
  const loadGitDiff = useCallback((dir = cwdRef.current): void => {
    const seq = ++gitDiffRequestSeq.current
    const sameWorkspace = gitDiffCwdRef.current === dir
    gitDiffCwdRef.current = dir
    if (dir && typeof window.scry.gitDiff === 'function') {
      if (!sameWorkspace) setGitDiff(null)
      setGitDiffRefreshing(true)
      window.scry
        .gitDiff(dir)
        .then((diff) => {
          if (seq === gitDiffRequestSeq.current && cwdRef.current === dir) {
            setGitDiff(diff)
            setGitDiffRefreshing(false)
          }
        })
        .catch(() => {
          if (seq === gitDiffRequestSeq.current && cwdRef.current === dir) {
            setGitDiff({ status: 'failed', reason: 'request_failed', files: [] })
            setGitDiffRefreshing(false)
          }
        })
    } else {
      setGitDiff(dir ? { status: 'unavailable', reason: 'request_failed', files: [] } : undefined)
      setGitDiffRefreshing(false)
    }
  }, [])


  return {
    gitDiff: gitDiffCwdRef.current === cwd ? gitDiff : undefined,
    gitDiffRefreshing: gitDiffCwdRef.current === cwd && gitDiffRefreshing,
    loadGitDiff
  }
}
