import type { HostQueueItem } from '../../hooks/host-queue-model'
import { HOST_QUEUE_COPY } from '../../constants/host-queue-copy'

/**
 * D1: what the host is actually holding for this session. It reuses the composer queue's own
 * classes on purpose — same block, same tokens, so the two never look like different features.
 */
export function HostQueuePanel({ items }: { items: readonly HostQueueItem[] }) {
  if (items.length === 0) return null
  return (
    <div className="prompt-queue" aria-label={HOST_QUEUE_COPY.listLabel(items.length)}>
      <div className="queue-title">
        <span className="queue-title-main">{HOST_QUEUE_COPY.title}</span>
        <span className="queue-count">{items.length}</span>
        <span className="queue-hint">{HOST_QUEUE_COPY.hint}</span>
      </div>
      <div className="queue-list" role="list">
        {items.map((item) => (
          <div className="queue-row" role="listitem" key={item.runId} aria-label={HOST_QUEUE_COPY.rowLabel(item.position, item.note === HOST_QUEUE_COPY.held)}>
            <span className="queue-index" aria-hidden="true">{item.position}</span>
            <span className="queue-text" title={item.text}>{item.text}</span>
            {item.note !== null && <small className="queue-steer-reason">{item.note}</small>}
          </div>
        ))}
      </div>
    </div>
  )
}
