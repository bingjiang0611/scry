import { useState } from 'react'
import type { ConversationSummary } from '@shared/conversation-api'
import { SIDE_CHAT_COPY } from '../constants/side-chat-copy'
import type { SideChatOrphanGroup as OrphanGroup } from '../side-chat-index'
import { boundedPage, pruneRowPages } from '../side-chat-orphan-page'
import { Icon } from './primitives/Icon'

/**
 * How many groups and rows one page holds. A page is replaced, not appended to: the
 * sidebar mounts at most one page of groups and one page of rows per group, so a source
 * with hundreds of children cannot grow the DOM past these two bounds.
 */
const GROUP_PAGE = 6
const ROW_PAGE = 20

/** Current group page and the row page of each group on it; bounded by GROUP_PAGE. */
interface OrphanPages {
  group: number
  rows: Readonly<Record<string, number>>
}

/**
 * Side chats whose source is not in the currently loaded project list.
 *
 * Absence from a bounded catalog read is not proof of deletion, so these rows stay
 * discoverable under their captured parent title and say only that the source is not in
 * the current list. One group is one captured source, never one title, so unrelated
 * children are never merged. Both levels page with previous/next and are keyed by the
 * group's own source key; nothing here reads a child transcript.
 */
export function SideChatOrphanGroup({ groups, onPick }: {
  groups: readonly OrphanGroup[]
  onPick?: (conversation: ConversationSummary) => void
}) {
  const [pages, setPages] = useState<OrphanPages>({ group: 0, rows: {} })
  if (groups.length === 0) return null
  // A catalog change can shrink the list under the current page; the window clamps
  // instead of showing an empty page with no way back.
  const groupWindow = boundedPage(pages.group, groups.length, GROUP_PAGE)
  const shownGroups = groups.slice(groupWindow.first, groupWindow.last)
  const rowPageOf = (group: OrphanGroup): ReturnType<typeof boundedPage> =>
    boundedPage(pages.rows[group.key] ?? 0, group.items.length, ROW_PAGE)
  const setRowsPage = (group: OrphanGroup, page: number): void => setPages(current => {
    // Group navigation clears the map, but a changed catalog can replace the shown groups
    // under the same group page. Keeping only the current keys stops the map from holding
    // entries for groups that are no longer on screen.
    const rows = pruneRowPages(current.rows, shownGroups.map(shown => shown.key))
    rows[group.key] = page
    return { ...current, rows }
  })
  return <div className="sb-orphan-group" data-side-chat-orphans>
    <p className="sb-orphan-title">{SIDE_CHAT_COPY.orphanGroup}</p>
    {shownGroups.map((group) => {
      const rowWindow = rowPageOf(group)
      const rows = group.items.slice(rowWindow.first, rowWindow.last)
      const first = rowWindow.first + 1
      return <div className="sb-orphan-parent" key={group.key} data-orphan-group-key={group.key}>
        <p className="sb-orphan-parent-title" title={SIDE_CHAT_COPY.orphanGroupHint(group.parentTitleAtCapture)}>
          {group.parentTitleAtCapture}
        </p>
        {rows.map((child) => <div className="sb-sess-row" key={child.id}>
          <button type="button" className="sb-sess" onClick={() => onPick?.(child)} data-orphan-side-chat-id={child.id}>
            <span className="sb-session-main">
              <Icon name="message" />
              <span className="sb-sesstext" title={child.title}>{child.title}</span>
            </span>
            <span className="sb-session-meta">
              {child.sideChat ? SIDE_CHAT_COPY.snapshotLine(child.sideChat.throughOrdinal) : null}
            </span>
          </button>
        </div>)}
        {rowWindow.lastPage > 0 && <div className="sb-orphan-pager">
          <button type="button" className="btn sb-orphan-page" data-orphan-rows-previous={group.key}
            disabled={rowWindow.page === 0} onClick={() => setRowsPage(group, rowWindow.page - 1)}>
            {SIDE_CHAT_COPY.orphanPagePrevious}
          </button>
          <span className="sb-orphan-range" data-orphan-rows-range={group.key}
            data-orphan-rows-page={`${rowWindow.page + 1}/${rowWindow.lastPage + 1}`}>
            {SIDE_CHAT_COPY.orphanRowRange({ first, last: first + rows.length - 1, total: group.items.length })}
          </span>
          <button type="button" className="btn sb-orphan-page" data-orphan-rows-next={group.key}
            disabled={rowWindow.page >= rowWindow.lastPage} onClick={() => setRowsPage(group, rowWindow.page + 1)}>
            {SIDE_CHAT_COPY.orphanPageNext}
          </button>
        </div>}
      </div>
    })}
    {groupWindow.lastPage > 0 && <div className="sb-orphan-pager sb-orphan-group-pager">
      <button type="button" className="btn sb-orphan-page" data-orphan-groups-previous=""
        disabled={groupWindow.page === 0} onClick={() => setPages({ group: groupWindow.page - 1, rows: {} })}>
        {SIDE_CHAT_COPY.orphanPagePrevious}
      </button>
      <span className="sb-orphan-range" data-orphan-groups-page={`${groupWindow.page + 1}/${groupWindow.lastPage + 1}`}
        data-orphan-groups-range={`${groupWindow.first + 1}-${groupWindow.last}/${groups.length}`}>
        {SIDE_CHAT_COPY.orphanGroupRange({ first: groupWindow.first + 1, last: groupWindow.last, total: groups.length })}
      </span>
      <button type="button" className="btn sb-orphan-page" data-orphan-groups-next=""
        disabled={groupWindow.page >= groupWindow.lastPage} onClick={() => setPages({ group: groupWindow.page + 1, rows: {} })}>
        {SIDE_CHAT_COPY.orphanPageNext}
      </button>
    </div>}
  </div>
}
