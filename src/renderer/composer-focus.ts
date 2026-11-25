export function focusComposerUnlessFocusMoved(
  target: { current: HTMLTextAreaElement | null },
  before: Element | null
): void {
  window.setTimeout(() => {
    const active = document.activeElement
    if (active != null && active !== document.body && active !== before) return
    target.current?.focus()
  }, 0)
}

export function focusComposerWhenReady(
  target: { current: HTMLTextAreaElement | null },
  before: Element | null,
  waitMs = 5_000,
  intervalMs = 16
): () => void {
  const deadline = Date.now() + waitMs
  let timer: number | undefined
  let cancelled = false
  const attempt = (): void => {
    timer = undefined
    if (cancelled) return
    const active = document.activeElement
    if (active != null && active !== document.body && active !== before) return
    const textarea = target.current
    if (textarea && !textarea.disabled) {
      textarea.focus({ preventScroll: true })
      return
    }
    if (Date.now() < deadline) timer = window.setTimeout(attempt, intervalMs)
  }
  timer = window.setTimeout(attempt, 0)
  return () => {
    cancelled = true
    if (timer !== undefined) window.clearTimeout(timer)
  }
}
