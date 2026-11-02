const AUTO_TITLE = 'overflowTitle'

function ellipsisTarget(start: EventTarget | null, doc: Document, view: Window): HTMLElement | null {
  let element = start instanceof Element ? start : null
  while (element instanceof HTMLElement && element !== doc.body) {
    const style = view.getComputedStyle(element)
    if (style.textOverflow === 'ellipsis' && element.scrollWidth > element.clientWidth) return element
    element = element.parentElement
  }
  return null
}

export function installOverflowTitles(doc: Document): () => void {
  const update = (event: Event): void => {
    const element = ellipsisTarget(event.target, doc, doc.defaultView ?? window)
    if (!element) return
    const text = element.textContent?.trim()
    if (!text) return
    if (!element.title) {
      element.title = text
      element.dataset[AUTO_TITLE] = 'true'
    } else if (element.dataset[AUTO_TITLE] === 'true' && element.title !== text) {
      element.title = text
    }
  }
  const clearStale = (event: Event): void => {
    const element = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>('[data-overflow-title="true"]') : null
    if (!element || element.scrollWidth > element.clientWidth) return
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
