// Serialized into isolated renderer fixtures. DOM presence is not layout readiness:
// virtualization and viewport changes can move a target before native input arrives.
export function nativeUiPointer(selector, { timeoutMs, scroll, captureReceipt }) {
  return new Promise((resolve, reject) => {
    let frame, previous, scrolled = false
    const timer = setTimeout(() => {
      cancelAnimationFrame(frame)
      reject(new Error('Pointer geometry did not settle: ' + selector))
    }, timeoutMs)
    const inspect = () => {
      const element = document.querySelector(selector)
      if (element) {
        if (scroll && !scrolled) {
          element.scrollIntoView({ block: 'center', inline: 'nearest' })
          scrolled = true
        }
        const box = element.getBoundingClientRect()
        const x = Math.round(box.left + box.width / 2), y = Math.round(box.top + box.height / 2)
        const geometry = JSON.stringify([box.x, box.y, box.width, box.height])
        const hit = box.width > 0 && box.height > 0 && element.contains(document.elementFromPoint(x, y))
        if (hit && previous === geometry) {
          clearTimeout(timer)
          if (captureReceipt) {
            window.__nativeUiPointerReceipt = null
            // Disabled controls suppress click events, but must still be hit by
            // the native pointer. Business effects remain the caller's assertions.
            document.addEventListener('pointerup', event => {
              window.__nativeUiPointerReceipt = {
                trusted: event.isTrusted, targetMatched: element.contains(event.target),
                target: event.target.outerHTML?.slice(0, 300)
              }
            }, { capture: true, once: true })
          }
          resolve({ x, y })
          return
        }
        previous = hit ? geometry : undefined
      } else previous = undefined
      frame = requestAnimationFrame(inspect)
    }
    frame = requestAnimationFrame(inspect)
  })
}
