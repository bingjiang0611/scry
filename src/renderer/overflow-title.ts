const AUTO_TITLE = 'overflowTitle'

function isOverflowingEllipsis(element: HTMLElement, view: Window): boolean {
  return view.getComputedStyle(element).textOverflow === 'ellipsis' && element.scrollWidth > element.clientWidth
}

function ellipsisTarget(start: EventTarget | null, doc: Document, view: Window): HTMLElement | null {
  const origin = start instanceof HTMLElement
    ? start
    : start instanceof Element
      ? start.parentElement
      : null
  let element = origin
  while (element && element !== doc.body) {
    if (isOverflowingEllipsis(element, view)) return element
    element = element.parentElement
  }
  if (origin) {
    for (const descendant of origin.querySelectorAll<HTMLElement>('*')) {
      if (isOverflowingEllipsis(descendant, view)) return descendant
    }
  }
  return null
}

export function installOverflowTitles(doc: Document): () => void {
  const update = (event: Event): void => {
    const element = ellipsisTarget(event.target, doc, doc.defaultView ?? window)
    if (!element) return
    const text = element.textContent?.trim()
    if (!text) return
    const eventElement = event.target instanceof HTMLElement ? event.target : null
    const titleHost = event.type === 'focusin' && eventElement?.contains(element) ? eventElement : element
    if (!titleHost.title) {
      titleHost.title = text
      titleHost.dataset[AUTO_TITLE] = 'true'
    } else if (titleHost.dataset[AUTO_TITLE] === 'true' && titleHost.title !== text) {
      titleHost.title = text
    }
  }
  const clearStale = (event: Event): void => {
    const element = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>('[data-overflow-title="true"]') : null
    if (!element || ellipsisTarget(element, doc, doc.defaultView ?? window)) return
    element.removeAttribute('title')
    delete element.dataset[AUTO_TITLE]
  }
  doc.addEventListener('mouseover', update)
  doc.addEventListener('focusin', update)
  doc.addEventListener('mouseover', clearStale, true)
  doc.addEventListener('focusin', clearStale, true)
  return () => {
    doc.removeEventListener('mouseover', update)
    doc.removeEventListener('focusin', update)
    doc.removeEventListener('mouseover', clearStale, true)
    doc.removeEventListener('focusin', clearStale, true)
  }
}
