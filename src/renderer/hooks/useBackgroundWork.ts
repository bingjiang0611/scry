import { useEffect, useState } from 'react'
import { latestBackgroundWork, type BackgroundWork } from '@shared/background-work'

/** Sidebar projection of the same snapshots archived in each run's trace. */
export function useBackgroundWork(): Readonly<Record<string, BackgroundWork>> {
  const [workByRun, setWorkByRun] = useState<Record<string, BackgroundWork>>({})
  useEffect(() => {
    let disposed = false
    const changed = new Set<string>()
    const terminal = new Set<string>()
    const revisions = new Map<string, number>()
    const update = (runId: string, work?: BackgroundWork): void => {
      const revision = revisions.get(runId)
      if (work?.revision !== undefined) {
        if (revision !== undefined && work.revision < revision) return
        revisions.set(runId, work.revision)
      }
      changed.add(runId)
      setWorkByRun((previous) => {
        const next = { ...previous }
        if (!work || work.phase === 'inactive') delete next[runId]
        else next[runId] = work
        return next
      })
    }
    const finish = ({ runId }: { runId: string }): void => { terminal.add(runId); update(runId) }
    const off = window.scry.onBackgroundWork?.(({ runId, work }) => { if (!terminal.has(runId)) update(runId, work) })
    const offDone = window.scry.onTurnDone(finish)
    const offError = window.scry.onError(finish)
    void window.scry.activeRuns().then((runs) => {
      if (disposed) return
      for (const run of runs) {
        const work = latestBackgroundWork(run.items)
        if (!run.done && !terminal.has(run.runId) && (!changed.has(run.runId) || work?.revision !== undefined)) update(run.runId, work)
      }
    }).catch(() => { /* Missing snapshots remain unknown, never a guessed waiting state. */ })
    return () => { disposed = true; off?.(); offDone(); offError() }
  }, [])
  return workByRun
}
