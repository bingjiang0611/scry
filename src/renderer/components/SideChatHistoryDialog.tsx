import { useId, useRef } from 'react'
import type { ConversationSummary } from '@shared/conversation-api'
import { SIDE_CHAT_COPY } from '../constants/side-chat-copy'
import type { SideChatWorkspace } from '../hooks/useSideChatWorkspace'
import { ModalFrame } from './ModalFrame'

const capturedAt = (value: number): string => new Date(value).toLocaleString('zh-CN', {
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
})

/**
 * Bounded history of the children of one parent source.
 *
 * Pages come from the host's own cursor, so more than forty children stay reachable and
 * reopening a row opens exactly that record. A row is a real conversation summary; the
 * dialog never falls back to an arbitrary first child.
 */
export function SideChatHistoryDialog({ history, onClose }: {
  history: SideChatWorkspace['history']
  onClose: () => void
}) {
  const titleId = `side-chat-history-${useId().replaceAll(':', '')}`
  const closeRef = useRef<HTMLButtonElement>(null)
  const range = history.range
  return <ModalFrame labelledBy={titleId} initialFocusRef={closeRef} className="side-chat-history-modal" onClose={onClose}>
    <header className="side-chat-history-header">
      <div>
        <h3 id={titleId}>{SIDE_CHAT_COPY.historyTitle}</h3>
        {history.total !== undefined && <p data-side-chat-history-total>{SIDE_CHAT_COPY.historyTotal(history.total)}</p>}
      </div>
      <button ref={closeRef} type="button" className="btn" onClick={onClose}>{SIDE_CHAT_COPY.snapshotClose}</button>
    </header>
    {history.error && <p role="alert" className="side-chat-history-error">{history.error}</p>}
    <ol className="side-chat-history-items" data-side-chat-history>
      {history.items.map((item) => <li key={item.id}>
        <button type="button" className="side-chat-history-row" data-side-chat-history-id={item.id}
          onClick={() => history.select(item)}>
          <span className="side-chat-history-title">{item.title}</span>
          <span className="side-chat-history-meta">
            {item.sideChat
              ? `${SIDE_CHAT_COPY.snapshotLine(item.sideChat.throughOrdinal)} · ${capturedAt(item.sideChat.capturedAt)}`
              : capturedAt(item.revision)}
            {item.archivedAt ? ' · 已存档' : ''}
          </span>
        </button>
      </li>)}
      {!history.loading && history.items.length === 0 && !history.error
        ? <li className="side-chat-history-empty">{SIDE_CHAT_COPY.historyEmpty}</li> : null}
    </ol>
    <footer className="side-chat-history-footer">
      {history.canLoadPrevious
        ? <button type="button" className="btn" disabled={history.loading} onClick={history.loadPrevious}>
          {SIDE_CHAT_COPY.historyLoadNewer}
        </button>
        : null}
      {history.canLoadMore
        ? <button type="button" className="btn" disabled={history.loading} onClick={history.loadMore}>
          {SIDE_CHAT_COPY.historyLoadOlder}
        </button>
        : null}
      {/* The dialog holds one page at a time; the row range says where this page is. */}
      {range
        ? <p data-side-chat-history-range>{SIDE_CHAT_COPY.historyPageRange(range.first, range.last, history.total ?? range.last)}</p>
        : null}
      {history.loading ? <p role="status">…</p> : null}
    </footer>
  </ModalFrame>
}

export type { ConversationSummary }
