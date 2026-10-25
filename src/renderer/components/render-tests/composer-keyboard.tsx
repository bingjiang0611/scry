import * as shared from './shared'
const { describe, it, expect, composerEnterConfirmsIme } = shared

describe('composer Enter safety', () => {
  it('does not turn an IME confirmation into a prompt submission', () => {
    expect(composerEnterConfirmsIme({
      nativeIsComposing: true,
      keyCode: 13,
      compositionActive: false,
      compositionEndedAt: Number.NEGATIVE_INFINITY,
      now: 1_000
    })).toBe(true)
    expect(composerEnterConfirmsIme({
      nativeIsComposing: false,
      keyCode: 13,
      compositionActive: false,
      compositionEndedAt: 950,
      now: 1_000
    })).toBe(true)
    expect(composerEnterConfirmsIme({
      nativeIsComposing: false,
      keyCode: 13,
      compositionActive: false,
      compositionEndedAt: 800,
      now: 1_000
    })).toBe(false)
  })
})