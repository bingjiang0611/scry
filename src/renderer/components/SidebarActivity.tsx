import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { activityGroups, type ActivityEntry } from '../sidebar-activity'
import { SIDEBAR_ACTIVITY_COPY as copy } from '../constants/copy'
import { useFlipList } from '../hooks/useFlipList'
import { Icon } from './primitives/Icon'
import './sidebar-activity.css'

const GROUP_LIMIT = 40

export function SidebarActivity({ entries, renderEntry }: {
  entries: ActivityEntry[]
  renderEntry: (entry: ActivityEntry) => ReactNode
}) {
  const root = useRef<HTMLDivElement>(null)
  const [heldEntries, setHeldEntries] = useState<ActivityEntry[] | null>(null)
  const [arrivals, setArrivals] = useState({ source: entries, keys: [] as string[] })
  // Promote observed state changes, not guessed timestamps or conversation revisions.
  // Adjust derived state before commit so the list moves once, without an intermediate layout.
  if (arrivals.source !== entries) {
    const previous = new Map(arrivals.source.map(entry => [entry.key, entry.group]))
    const moved = entries.filter(entry => previous.has(entry.key) && previous.get(entry.key) !== entry.group).map(entry => entry.key)
    const live = new Set(entries.map(entry => entry.key))
    const movedKeys = new Set(moved)
    setArrivals({ source: entries, keys: [...moved, ...arrivals.keys.filter(key => live.has(key) && !movedKeys.has(key))].slice(0, GROUP_LIMIT * activityGroups.length) })
  }
  const ordered = useMemo(() => {
    const rank = new Map(arrivals.keys.map((key, index) => [key, index]))
    const promoted = entries.filter(entry => rank.has(entry.key)).sort((a, b) => rank.get(a.key)! - rank.get(b.key)!)
    return [...promoted, ...entries.filter(entry => !rank.has(entry.key))]
  }, [entries, arrivals.keys])
  const displayed = heldEntries ?? ordered

  useEffect(() => {
    if (!heldEntries) return
    let releaseTimer: ReturnType<typeof setTimeout>
    // Keep the target under the pointer from pointerdown through click, including updates
    // arriving between those events. Release outside the list and cancellation work too.
    const release = (): void => { releaseTimer = setTimeout(() => setHeldEntries(null), 0) }
    window.addEventListener('pointerup', release, { once: true })
    window.addEventListener('pointercancel', release, { once: true })
    window.addEventListener('blur', release, { once: true })
    return () => {
      clearTimeout(releaseTimer)
      window.removeEventListener('pointerup', release)
      window.removeEventListener('pointercancel', release)
      window.removeEventListener('blur', release)
    }
  }, [heldEntries])

  useFlipList(root, displayed, GROUP_LIMIT * activityGroups.length + activityGroups.length)

  const children: ReactNode[] = []
  for (const group of activityGroups) {
    const items = displayed.filter((entry) => entry.group === group.id)
    if (!items.length) continue
    const headingId = `sidebar-activity-${group.id}`
    children.push(<h3 key={group.id} id={headingId} className="sb-activity-heading" data-motion-key={group.id} data-activity-group={group.id}>
      {group.label}
    </h3>)
    // Flat keyed siblings preserve each row's DOM/focus as it migrates between groups.
    for (const entry of items.slice(0, GROUP_LIMIT)) {
      children.push(<div key={entry.key} className="sb-activity-item" data-motion-key={entry.key} data-activity-group={group.id} role="group" aria-labelledby={headingId}>
        {renderEntry(entry)}
        {group.id !== 'working' && <span className="sb-activity-status" aria-hidden="true">
          <Icon name={group.id === 'attention' ? 'alert' : 'laptop'} />
        </span>}
      </div>)
    }
    if (items.length > GROUP_LIMIT) children.push(<p key={`${group.id}-limit`} className="sb-activity-limit">
      {copy.overflow(items.length - GROUP_LIMIT)}
    </p>)
  }
  return <div className="sb-activity" ref={root} onPointerDownCapture={() => setHeldEntries(displayed)}>
    {children.length ? children : <div className="sb-empty">{copy.empty}</div>}
  </div>
}
