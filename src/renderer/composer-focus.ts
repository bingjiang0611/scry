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
