import { useCallback, useEffect, useRef, useState } from 'react'
import type { ActiveRun } from '@shared/trace'
import type { ConversationPage } from '@shared/conversation-api'

/** Own paged readback, active-run observation and initial native selection.
 * This hook only observes; it never sends, resumes or retries a conversation. */
export function useConversationReadback({ conversationId, initialAgentId, onChanged, onSelectAgent, onError }: {
  conversationId: string
  initialAgentId?: string
  onChanged: () => void
  onSelectAgent: (agentId: string) => void
  onError: (message: string) => void
}) {
  const [page, setPage] = useState<ConversationPage>()
  const [before, setBefore] = useState<number>()
  const [reload, setReload] = useState(0)
  const [live, setLive] = useState<ActiveRun>()
  const initialized = useRef(false)
  const refreshGeneration = useRef(0)
  const lastRevision = useRef<number>()
  const mounted = useRef(true)
  const changedRef = useRef(onChanged)
  changedRef.current = onChanged
  const selectAgentRef = useRef(onSelectAgent)
  selectAgentRef.current = onSelectAgent
  const errorRef = useRef(onError)
  errorRef.current = onError
  const notifyChanged = useCallback(() => changedRef.current(), [])

  const refresh = useCallback(async (): Promise<ConversationPage | undefined> => {
    const generation = ++refreshGeneration.current
    const next = await window.scry.conversations.read(conversationId, before)
    const run = next.summary.activeRunId
      ? (await window.scry.activeRuns()).find(candidate => candidate.runId === next.summary.activeRunId)
      : undefined
    if (!mounted.current || generation !== refreshGeneration.current) return
    setPage(next)
    setLive(run)
    if (lastRevision.current !== next.summary.revision) {
      lastRevision.current = next.summary.revision
      notifyChanged()
    }
    if (!initialized.current) {
      initialized.current = true
      const binding = next.bindings.find(binding => binding.id === next.turns.at(-1)?.bindingId)
      const agentId = initialAgentId ?? (binding && (binding.agentProfileId ?? binding.providerId))
      if (agentId) selectAgentRef.current(agentId)
    }
    return next
  }, [conversationId, before, initialAgentId, notifyChanged])

  const activeRunId = page?.summary.activeRunId
  useEffect(() => {
    mounted.current = true
    let timer: ReturnType<typeof setTimeout> | undefined
    let disposed = false
    const update = async (): Promise<void> => {
      try {
        if (activeRunId) {
          const active = (await window.scry.activeRuns()).find(run => run.runId === activeRunId)
          if (disposed) return
          setLive(active)
          if (!active) await refresh()
        } else await refresh()
      } catch (error) {
        if (!disposed) errorRef.current(error instanceof Error ? error.message : String(error))
        return
      }
      if (!disposed && activeRunId && !document.hidden) timer = setTimeout(() => { void update() }, 1000)
    }
    const resume = (): void => { if (!document.hidden) { clearTimeout(timer); void update() } }
    void update()
    const off = window.scry.onDataUpdated?.(event => {
      if (event?.kind === 'conversation_changed' && event.conversationId === conversationId) {
        void refresh().catch(error => {
          if (!disposed) errorRef.current(error instanceof Error ? error.message : String(error))
        })
      }
    })
    document.addEventListener('visibilitychange', resume)
    return () => {
      disposed = true; mounted.current = false; ++refreshGeneration.current
      clearTimeout(timer); off?.(); document.removeEventListener('visibilitychange', resume)
    }
  }, [refresh, activeRunId, reload, conversationId])

  return { page, setPage, before, setBefore, live, mounted, refresh, setReload, notifyChanged }
}
