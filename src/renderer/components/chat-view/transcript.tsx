import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Turn } from '../../format'
import { transcriptGrowthAboveEdge } from '../../chat-scroll'
import { AssistantTurn, UserMessage } from '../ChatTurn'
import type { ChatViewProps } from './types'

type TranscriptProps = Pick<ChatViewProps, 'turns' | 'selectedId' | 'focusedTurnRunId' | 'onTurnRef' | 'onSelect' |
  'onOpenDiff' | 'onForkTurn' | 'forkableRunIds' | 'pendingQuestions' | 'onAnswerQuestion'> & {
  remote?: boolean
  liveRunId?: string | null
  completedLiveRunId?: string | null
  liveArrivalResetKey?: unknown
}

const TRANSCRIPT_WINDOW_THRESHOLD = 20
const TRANSCRIPT_INITIAL_VISIBLE_TURNS = 4
const TRANSCRIPT_WINDOW_TEXT_BUDGET = 32 * 1024
const useBrowserLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

function shouldWindowTranscript(turns: readonly Turn[]): boolean {
  if (turns.length > TRANSCRIPT_WINDOW_THRESHOLD) return true
  if (turns.length <= TRANSCRIPT_INITIAL_VISIBLE_TURNS) return false
  let characters = 0
  for (const turn of turns) {
    for (const event of turn.items) {
      if (event.kind !== 'model' || (event.stage !== 'text' && event.stage !== 'text_delta')) continue
      characters += event.text?.length ?? 0
      if (characters > TRANSCRIPT_WINDOW_TEXT_BUDGET) return true
    }
  }
  return false
}

export const ChatTranscriptTurns = memo(function ChatTranscriptTurns({ turns, focusedTurnRunId, ...props }: TranscriptProps) {
  const windowed = shouldWindowTranscript(turns)
  const intersection = useRef<IntersectionObserver | null>(null)
  const visibilityCallbacks = useRef(new Map<Element, (intersecting: boolean) => void>())
  const selectionChecks = useRef(new Set<() => void>())
  const observeVisibility = useCallback((element: HTMLElement, callback: (intersecting: boolean) => void) => {
    if (!intersection.current) {
      intersection.current = new IntersectionObserver(entries => {
        const latest = new Map(entries.map(entry => [entry.target, entry.isIntersecting]))
        for (const [target, intersecting] of latest) visibilityCallbacks.current.get(target)?.(intersecting)
      }, { root: element.closest('.chat-transcript'), rootMargin: '1200px 0px' })
    }
    visibilityCallbacks.current.set(element, callback)
    intersection.current.observe(element)
    return () => {
      visibilityCallbacks.current.delete(element)
      intersection.current?.unobserve(element)
      if (visibilityCallbacks.current.size === 0) {
        intersection.current?.disconnect()
        intersection.current = null
      }
    }
  }, [])
  const observeSelection = useCallback((recheck: () => void) => {
    selectionChecks.current.add(recheck)
    return () => { selectionChecks.current.delete(recheck) }
  }, [])
  useEffect(() => {
    if (!windowed) return
    const recheck = () => { for (const check of selectionChecks.current) check() }
    document.addEventListener('selectionchange', recheck)
    return () => document.removeEventListener('selectionchange', recheck)
  }, [windowed])
  return <>{turns.map((turn, index) => <TranscriptTurn
    key={turn.runId} {...props} turn={turn} index={index} total={turns.length}
    windowed={windowed} initiallyVisible={!windowed || index >= turns.length - TRANSCRIPT_INITIAL_VISIBLE_TURNS}
    focused={focusedTurnRunId === turn.runId} observeVisibility={observeVisibility} observeSelection={observeSelection}
  />)}</>
})

const TranscriptTurn = memo(function TranscriptTurn({
  turn, index, total, windowed, initiallyVisible, focused, observeVisibility, observeSelection,
  selectedId, onTurnRef, onSelect, onOpenDiff, onForkTurn, forkableRunIds, pendingQuestions = [], onAnswerQuestion, remote = false,
  liveRunId, completedLiveRunId, liveArrivalResetKey
}: Omit<TranscriptProps, 'turns' | 'focusedTurnRunId'> & {
  turn: Turn; index: number; total: number; windowed: boolean; initiallyVisible: boolean; focused: boolean
  observeVisibility: (element: HTMLElement, callback: (intersecting: boolean) => void) => () => void
  observeSelection: (recheck: () => void) => () => void
}) {
  const selected = useMemo(() => selectedId != null && turn.items.some(event => event.id === selectedId), [turn.items, selectedId])
  const shell = useRef<HTMLDivElement | null>(null)
  const releaseOffscreen = useRef<() => void>()
  const height = useRef(240)
  const [visible, setVisible] = useState(initiallyVisible)
  const pinned = focused || selected || !turn.done || pendingQuestions.some(question => question.runId === turn.runId)
  const mounted = !windowed || visible || pinned
  const labelPreview = turn.userText.length > 80 ? `${turn.userText.slice(0, 80)}…` : turn.userText
  const setShell = useCallback((element: HTMLDivElement | null) => {
    shell.current = element
    onTurnRef?.(turn.runId, element)
  }, [onTurnRef, turn.runId])

  useBrowserLayoutEffect(() => {
    const element = shell.current
    if (!mounted || !element) return
    let firstMeasurement = true
    const measure = () => {
      const rect = element.getBoundingClientRect()
      const scroller = element.closest<HTMLElement>('.chat-transcript')
      // `applyViewRestore` marks the turn it positioned. The row may materialize a frame
      // later, so the marker survives the restore call and is consumed here.
      const restoreAnchor = element.dataset.restoreAnchor === 'true'
      if (restoreAnchor) delete element.dataset.restoreAnchor
      if (windowed && scroller) {
        const growth = transcriptGrowthAboveEdge({ top: rect.top, height: rect.height, previousHeight: height.current,
          firstMeasurement, restoreAnchor, edge: scroller.getBoundingClientRect().top })
        if (growth !== 0) scroller.scrollTop += growth
      }
      height.current = rect.height
      firstMeasurement = false
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [mounted, windowed])

  useEffect(() => {
    if (!windowed) return
    const element = shell.current!
    let intersecting = initiallyVisible
    const release = (focusTarget: Node | null) => {
      if (intersecting) return
      if (element.dataset.virtualized === 'true') {
        setVisible(element.contains(focusTarget))
        return
      }
      const selection = window.getSelection()
      const selectedRange = selection != null && !selection.isCollapsed &&
        selection.rangeCount > 0 && selection.getRangeAt(0).intersectsNode(element)
      const engaged = element.contains(focusTarget) || selectedRange ||
        element.querySelector('[aria-expanded="true"], details[open]') != null
      if (!engaged) {
        height.current = element.getBoundingClientRect().height
        setVisible(false)
      }
    }
    const recheck = () => release(document.activeElement)
    const blur = (event: FocusEvent) => {
      const target = event.relatedTarget instanceof Node ? event.relatedTarget : null
      if (!element.contains(target)) release(target)
    }
    releaseOffscreen.current = recheck
    const stopObserving = observeVisibility(element, value => {
      intersecting = value
      if (intersecting) setVisible(true)
      else recheck()
    })
    element.addEventListener('focusout', blur)
    return () => {
      stopObserving()
      element.removeEventListener('focusout', blur)
    }
  }, [windowed, observeVisibility])

  useEffect(() => {
    if (!windowed || !mounted) return
    const recheck = releaseOffscreen.current!
    const stopObserving = observeSelection(recheck)
    const disclosureObserver = new MutationObserver(recheck)
    disclosureObserver.observe(shell.current!, { attributes: true, subtree: true, attributeFilter: ['aria-expanded', 'open'] })
    return () => {
      stopObserving()
      disclosureObserver.disconnect()
    }
  }, [windowed, mounted, observeSelection])

  return <div
    className={`turn transcript-turn ${selected ? 'is-selected' : ''} ${focused ? 'turn-jump-target' : ''}`}
    data-run-id={turn.runId} data-turn-ordinal={turn.ordinal} data-selected={selected || undefined} data-virtualized={!mounted || undefined}
    ref={setShell} role="article"
    aria-label={!mounted ? `第 ${index + 1} / ${total} 轮：${labelPreview}` : undefined}
    tabIndex={windowed ? 0 : undefined} onFocusCapture={() => setVisible(true)}
    style={windowed ? { contentVisibility: 'visible', ...(!mounted ? { height: height.current } : {}) } : undefined}
  >
    {mounted && <>
      <UserMessage text={turn.userText} attachments={turn.attachments} />
      <AssistantTurn turn={turn} selectedId={selectedId} onSelect={onSelect} onOpenDiff={onOpenDiff}
        onForkTurn={!forkableRunIds || forkableRunIds.has(turn.runId) ? onForkTurn : undefined} pendingQuestions={pendingQuestions} onAnswerQuestion={onAnswerQuestion} remote={remote}
        liveArrivalEligible={turn.runId === liveRunId}
        footerArrivalEligible={turn.runId === liveRunId || turn.runId === completedLiveRunId} liveArrivalResetKey={liveArrivalResetKey} />
    </>}
  </div>
})
