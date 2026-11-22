/**
 * Deferred composer focus: the intent is recorded when the user acts, but the DOM work
 * that needs it (a new conversation, a view change, a queue edit) finishes in a later task.
 * Anything focused after that point — the user, a menu that restored focus to its trigger —
 * is newer intent and must win.
 *
 * `before` is the element that held focus when the intent started, captured synchronously
 * before the await that defers the focus. It cannot be captured at schedule time: on a
 * loaded machine the newer focus already happened by then.
 *
 * Evidence: `newConversation` focuses the composer from two timers that run after the
 * `newSession` round trip. On packaged macOS CI those timers ran after the surface menu
 * restored focus to its trigger, so Escape left the caret in the composer instead of on
 * the "+" button (`--overlays-only`).
 */
export function focusComposerUnlessFocusMoved(
  target: { current: HTMLTextAreaElement | null },
  before: Element | null
): void {
  window.setTimeout(() => {
    const active = document.activeElement
    // `null`/body means nothing holds focus (the control went away); the composer is a
    // legitimate destination then. Any real element focused later owns the caret.
    if (active != null && active !== document.body && active !== before) return
    target.current?.focus()
  }, 0)
}

/**
 * Focus a composer that may not exist yet. A freshly created side chat mounts its body
 * before its conversation page arrives, and the composer only renders with the page; with
 * the daemon as the only runtime that read crosses a socket and routinely lands after the
 * first frame, so a single-frame focus found no textarea and the caret stayed where it was.
 * This keeps trying on each frame until the composer is there (or `waitMs` passes), and
 * gives up as soon as anything else takes focus: that is newer intent and must win.
 * Returns a cancel for the owner's cleanup.
 */
export function focusComposerWhenReady(
  target: { current: HTMLTextAreaElement | null },
  before: Element | null,
  waitMs = 5_000
): () => void {
  const deadline = Date.now() + waitMs
  let frame = 0
  let cancelled = false
  const attempt = (): void => {
    if (cancelled) return
    const active = document.activeElement
    if (active != null && active !== document.body && active !== before) return
    const textarea = target.current
    if (textarea && !textarea.disabled) {
      textarea.focus({ preventScroll: true })
      return
    }
    if (Date.now() < deadline) frame = window.requestAnimationFrame(attempt)
  }
  frame = window.requestAnimationFrame(attempt)
  return () => {
    cancelled = true
    window.cancelAnimationFrame(frame)
  }
}
