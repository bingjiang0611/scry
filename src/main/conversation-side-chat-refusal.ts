/**
 * A snapshot budget refusal.
 *
 * The range is real and was read, but it does not fit the snapshot budget. It is kept as
 * its own error type so the preview can offer the smallest freezable prefix as an explicit
 * choice, and the renderer can tell "too much history" apart from "no source" or "no
 * completed turn".
 */
export class SideChatBudgetRefusal extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SideChatBudgetRefusal'
  }
}

export function isSideChatBudgetRefusal(error: unknown): error is SideChatBudgetRefusal {
  return error instanceof SideChatBudgetRefusal
}
