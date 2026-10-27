// Serialized into the benchmark renderer. Readiness must be a synchronous DOM
// check; cached content alone is not enough to declare the composer usable.
export function measureNativeSessionOpen(button, isReady, isSelected = isReady) {
  return new Promise((resolve, reject) => {
    let frame
    const cleanup = () => {
      clearTimeout(deadline)
      cancelAnimationFrame(frame)
      button.removeEventListener('click', onClick, { capture: true })
    }
    const onClick = event => {
      const clickAt = event.timeStamp
      const handlerDelayMs = performance.now() - clickAt
      let selectedAt
      let selectedFrames = 0
      let readyFrames = 0
      const inspect = () => {
        try {
          selectedFrames = isSelected() ? selectedFrames + 1 : 0
          if (selectedAt === undefined && selectedFrames === 2) selectedAt = performance.now()
          readyFrames = isReady() ? readyFrames + 1 : 0
        } catch (error) {
          cleanup()
          reject(error)
          return
        }
        if (readyFrames === 2) {
          const readyAt = performance.now()
          cleanup()
          resolve({
            clickAt,
            selectedAt: selectedAt ?? readyAt,
            readyAt,
            selectionMs: (selectedAt ?? readyAt) - clickAt,
            nativeOpenMs: readyAt - clickAt,
            handlerDelayMs,
            trustedClick: event.isTrusted
          })
          return
        }
        frame = requestAnimationFrame(inspect)
      }
      frame = requestAnimationFrame(inspect)
    }
    const deadline = setTimeout(() => {
      cleanup()
      reject(new Error('Native session readiness timed out'))
    }, 15000)
    button.addEventListener('click', onClick, { once: true, capture: true })
  })
}
