import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { SideChatSnapshotBodyPage, SideChatSummary } from '@shared/conversation-api'
import { SIDE_CHAT_COPY } from '../constants/side-chat-copy'
import { ModalFrame } from './ModalFrame'

const message = (error: unknown): string => error instanceof Error ? error.message : String(error)

const capturedAtText = (value: number): string => new Date(value).toLocaleString('zh-CN', {
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
})

/**
 * Paginated reader for the frozen source bodies of one side chat.
 *
 * The child's own sealed artifact is the only authority: this viewer never reads the
 * source conversation or its archive, so it keeps working after the source is deleted.
 * Each page costs one main-process read of at most 40 messages / 256 KiB; rows outside
 * the current page are dropped so the DOM stays bounded however long the prefix is.
 * It is a real modal: `ModalFrame` owns the focus trap, Escape and focus restore, which
 * an inline `role="dialog"` alone does not provide.
 */
export function SideChatSnapshotViewer({ conversationId, summary, onClose }: {
  conversationId: string
  summary: SideChatSummary
  onClose: () => void
}) {
  const titleId = `side-chat-snapshot-title-${useId().replaceAll(':', '')}`
  const closeRef = useRef<HTMLButtonElement>(null)
  const [page, setPage] = useState<SideChatSnapshotBodyPage>()
  const [cursors, setCursors] = useState<Array<string | undefined>>([undefined])
  const [position, setPosition] = useState(0)
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(true)
  /**
   * The page that really loaded, as opposed to the one being requested.
   *
   * `cursor` moves the moment a control is pressed, so it cannot say what the DOM is
   * showing. This is set from the resolved read, which is the only authority for
   * "this body is on screen".
   */
  const [loaded, setLoaded] = useState<{ at: string; next?: string }>()
  const request = useRef(0)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; request.current++ }
  }, [])

  const cursor = cursors[position]
  const load = useCallback(async (at: string | undefined): Promise<void> => {
    const generation = ++request.current
    setLoading(true)
    setError(undefined)
    try {
      const read = window.scry.conversations?.readSideChatSnapshot
      if (typeof read !== 'function') throw new Error(SIDE_CHAT_COPY.snapshotApiUnavailable)
      const next = await read(conversationId, at)
      if (!mounted.current || generation !== request.current) return
      setPage(next)
      setLoaded({ at: at ?? '0:0', ...(next.nextCursor === undefined ? {} : { next: next.nextCursor }) })
    } catch (failure) {
      if (mounted.current && generation === request.current) { setPage(undefined); setError(message(failure)) }
    } finally {
      if (mounted.current && generation === request.current) setLoading(false)
    }
  }, [conversationId])
  useEffect(() => { void load(cursor) }, [load, cursor])

  const items = page?.items ?? []
  return <ModalFrame labelledBy={titleId} initialFocusRef={closeRef} className="side-chat-snapshot-modal"
    onClose={onClose}>
    <section className="side-chat-snapshot" data-side-chat-snapshot={conversationId}
      data-side-chat-snapshot-cursor={cursor ?? '0:0'}
      data-side-chat-snapshot-loaded-cursor={loaded?.at}
      data-side-chat-snapshot-next-cursor={loaded?.next}
      aria-busy={loading}>
    <header className="side-chat-snapshot-header">
      <div>
        <h3 id={titleId}>{SIDE_CHAT_COPY.snapshotDetail} · {summary.parentTitleAtCapture}</h3>
        <p data-snapshot-provenance>
          {SIDE_CHAT_COPY.snapshotLine(summary.throughOrdinal)} · {SIDE_CHAT_COPY.snapshotCapturedAt(capturedAtText(summary.capturedAt))} ·{' '}
          {SIDE_CHAT_COPY.snapshotMessageCount(summary.messageCount)}
        </p>
      </div>
      <button ref={closeRef} type="button" className="btn" onClick={onClose} aria-label={SIDE_CHAT_COPY.snapshotClose}>{SIDE_CHAT_COPY.snapshotClose}</button>
    </header>
    {error
      ? <p className="side-chat-snapshot-error" role="alert" data-snapshot-state="unavailable">{SIDE_CHAT_COPY.snapshotLoadError}：{error}</p>
      : !page
        ? <p className="side-chat-snapshot-loading" role="status">…</p>
        : <ol className="side-chat-snapshot-items" data-snapshot-state={page.nextCursor ? 'partial' : 'complete'}>
          {items.map(item => <li key={`${item.ref.runId}:${item.ref.itemId}`} className="side-chat-snapshot-item"
            data-snapshot-role={item.role} data-snapshot-source-ordinal={item.sourceOrdinal}>
            <p className="side-chat-snapshot-meta">
              {item.role === 'user' ? SIDE_CHAT_COPY.snapshotRoleUser : SIDE_CHAT_COPY.snapshotRoleAssistant}
              {' · '}{SIDE_CHAT_COPY.snapshotSourceTurn(item.sourceOrdinal)}
              {item.continuation ? ` · ${SIDE_CHAT_COPY.snapshotContinued}` : ''}
            </p>
            <pre className="side-chat-snapshot-text">{item.text}</pre>
          </li>)}
          {items.length === 0 && <li className="side-chat-snapshot-empty">{SIDE_CHAT_COPY.snapshotEmpty}</li>}
        </ol>}
    <footer className="side-chat-snapshot-footer">
      <button type="button" className="btn" disabled={position === 0 || loading}
        onClick={() => setPosition(value => Math.max(0, value - 1))}>{SIDE_CHAT_COPY.snapshotOlderPage}</button>
      <button type="button" className="btn" disabled={!page?.nextCursor || loading} onClick={() => {
        const next = page?.nextCursor
        if (!next) return
        setCursors(value => [...value.slice(0, position + 1), next])
        setPosition(value => value + 1)
      }}>{SIDE_CHAT_COPY.snapshotNewerPage}</button>
      <p>{SIDE_CHAT_COPY.snapshotInlineNotice}</p>
    </footer>
    </section>
  </ModalFrame>
}
