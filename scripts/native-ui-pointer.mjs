// Serialized into isolated renderer fixtures. DOM presence is not layout readiness:
// virtualization and viewport changes can move a target before native input arrives.
export function nativeUiPointer(selector, { text = '', timeoutMs, scroll, captureReceipt }) {
  return new Promise((resolve, reject) => {
    let frame, previous, scrolled = false, readiness = 'no animation frame'
    const timer = setTimeout(() => {
      cancelAnimationFrame(frame)
      // Failure-only DOM evidence: keep the original deadline and readiness checks.
      const element = text ? [...document.querySelectorAll(selector)].find(node => node.textContent.includes(text)) : document.querySelector(selector)
      const describe = node => node ? { tag: node.tagName, id: node.id, class: node.getAttribute('class')?.slice(0, 160) } : null
      const box = element?.getBoundingClientRect()
      const snapshot = {
        readiness, target: describe(element), active: describe(document.activeElement),
        focused: document.hasFocus(), inert: describe(element?.closest('[inert]')),
        box: box ? [box.x, box.y, box.width, box.height] : null,
        hit: box ? describe(document.elementFromPoint(Math.round(box.left + box.width / 2), Math.round(box.top + box.height / 2))) : null
      }
      reject(new Error('Pointer geometry did not settle: ' + selector + (text ? ' [' + text + ']' : '') + '; snapshot=' + JSON.stringify(snapshot)))
    }, timeoutMs)
    const inspect = () => {
      // Optional text narrows repeated controls such as menu items to the labelled target.
      const element = text ? [...document.querySelectorAll(selector)].find(node => node.textContent.includes(text)) : document.querySelector(selector)
      if (element) {
        if (scroll && !scrolled) {
          element.scrollIntoView({ block: 'center', inline: 'nearest' })
          scrolled = true
        }
        const box = element.getBoundingClientRect()
        const x = Math.round(box.left + box.width / 2), y = Math.round(box.top + box.height / 2)
        const geometry = JSON.stringify([box.x, box.y, box.width, box.height])
        const hit = box.width > 0 && box.height > 0 && element.contains(document.elementFromPoint(x, y))
        // Two equal frames can precede a pending route/layout transition. Wait
        // for finite animations, not perpetual activity spinners, before input.
        let moving = false
        for (let node = element; node && !moving; node = node.parentElement) {
          moving = node.getAnimations().some(animation =>
            (animation.pending || animation.playState === 'running') &&
            Number.isFinite(animation.effect?.getComputedTiming().endTime))
        }
        readiness = !hit ? 'target not hit' : moving ? 'finite animation active' : previous !== geometry ? 'geometry changed' : 'ready'
        if (hit && !moving && previous === geometry) {
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
        previous = hit && !moving ? geometry : undefined
      } else {
        previous = undefined
        readiness = 'target missing'
      }
      frame = requestAnimationFrame(inspect)
    }
    frame = requestAnimationFrame(inspect)
  })
}
