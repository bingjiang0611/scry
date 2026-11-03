const AUTO_TITLE = 'overflowTitle'
const FOCUS_DESCENDANT_HOST = 'button, a[href], [role="button"], summary'

function isOverflowingEllipsis(element: HTMLElement, view: Window): boolean {
  return view.getComputedStyle(element).textOverflow === 'ellipsis' && element.scrollWidth > element.clientWidth
}

function ellipsisTarget(start: EventTarget | null, doc: Document, view: Window, scanDescendants = false): HTMLElement | null {
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
  if (origin && scanDescendants) {
    for (const descendant of origin.querySelectorAll<HTMLElement>('*')) {
      if (isOverflowingEllipsis(descendant, view)) return descendant
    }
  }
  return null
}

export function installOverflowTitles(doc: Document): () => void {
  const update = (event: Event): void => {
    const eventElement = event.target instanceof HTMLElement ? event.target : null
    const scanDescendants = event.type === 'focusin' && eventElement?.matches(FOCUS_DESCENDANT_HOST) === true
    const element = ellipsisTarget(event.target, doc, doc.defaultView ?? window, scanDescendants)
    if (!element) return
    const text = element.textContent?.trim()
    if (!text) return
    const titleHost = scanDescendants && eventElement?.contains(element) ? eventElement : element
    if (!titleHost.title) {
      titleHost.title = text
      titleHost.dataset[AUTO_TITLE] = 'true'
    } else if (titleHost.dataset[AUTO_TITLE] === 'true' && titleHost.title !== text) {
      titleHost.title = text
    }
  }
  const clearStale = (event: Event): void => {
    const element = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>('[data-overflow-title="true"]') : null
    if (!element || ellipsisTarget(element, doc, doc.defaultView ?? window, element.matches(FOCUS_DESCENDANT_HOST))) return
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
