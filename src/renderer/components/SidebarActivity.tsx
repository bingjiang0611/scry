import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { activityGroups, type ActivityEntry } from '../sidebar-activity'
import './sidebar-activity.css'

// Bound layout reads and DOM size even when the local catalog contains years of history.
const GROUP_LIMIT = 40

export function SidebarActivity({ entries, renderEntry }: {
  entries: ActivityEntry[]
  renderEntry: (entry: ActivityEntry) => ReactNode
}) {
  const root = useRef<HTMLDivElement>(null)
  const positions = useRef(new Map<string, number>())
  const animations = useRef(new Map<string, Animation>())
  const [heldEntries, setHeldEntries] = useState<ActivityEntry[] | null>(null)
  const displayed = heldEntries ?? entries

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

  useLayoutEffect(() => {
    const nodes = Array.from(root.current!.querySelectorAll<HTMLElement>('[data-motion-key]'))
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    // Read the entire bounded list before any animation writes. offsetTop ignores the
    // previous transform; its current translation preserves continuity on interruption.
    const measurements = nodes.map((node) => {
      const key = node.dataset.motionKey!
      const previous = positions.current.get(key)
      const transform = animations.current.has(key) ? getComputedStyle(node).transform : 'none'
      const translation = transform === 'none' ? 0 : new DOMMatrixReadOnly(transform).m42
      return { node, key, top: node.offsetTop, delta: previous === undefined ? 0 : previous + translation - node.offsetTop }
    })
    for (const animation of animations.current.values()) animation.cancel()
    animations.current.clear()
    positions.current = new Map(measurements.map(({ key, top }) => [key, top]))
    if (reduceMotion) return
    for (const { node, key, delta } of measurements) {
      if (Math.abs(delta) < 1) continue
      const animation = node.animate([
        { transform: `translateY(${delta}px)` },
        { transform: 'translateY(0)' }
      ], { duration: 320, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' })
      animations.current.set(key, animation)
      animation.onfinish = () => animations.current.delete(key)
    }
  }, [displayed])

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const cancel = (): void => {
      for (const animation of animations.current.values()) animation.cancel()
      animations.current.clear()
    }
    const onChange = (): void => { if (media.matches) cancel() }
    media.addEventListener('change', onChange)
    return () => { media.removeEventListener('change', onChange); cancel() }
  }, [])

  const children: ReactNode[] = []
  for (const group of activityGroups) {
    const items = displayed.filter((entry) => entry.group === group.id)
    if (!items.length) continue
    const headingId = `sidebar-activity-${group.id}`
    children.push(<h3 key={group.id} id={headingId} className="sb-activity-heading" data-motion-key={group.id}>
      {group.label}<span>{items.length}</span>
    </h3>)
    // Flat keyed siblings preserve each row's DOM/focus as it migrates between groups.
    for (const entry of items.slice(0, GROUP_LIMIT)) {
      children.push(<div key={entry.key} className="sb-activity-item" data-motion-key={entry.key} data-activity-group={group.id} aria-describedby={headingId}>
        {renderEntry(entry)}
        <div className="sb-activity-project" title={entry.project.cwd}>{entry.project.name}</div>
      </div>)
    }
    if (items.length > GROUP_LIMIT) children.push(<p key={`${group.id}-limit`} className="sb-activity-limit">
      另有 {items.length - GROUP_LIMIT} 条，请搜索定位
    </p>)
  }
  return <div className="sb-activity" ref={root} onPointerDownCapture={() => setHeldEntries(entries)}>
    {children.length ? children : <div className="sb-empty">暂无匹配的本机会话</div>}
  </div>
}
