// Serialized into isolated renderer fixtures. DOM presence is not layout readiness:
// virtualization and viewport changes can move a target before native input arrives.
export function nativeUiPointer(selector, { text = '', timeoutMs, scroll, captureReceipt, confirmPoint }) {
  return new Promise((resolve, reject) => {
    let frame, previous, scrolled = false, readiness = 'no animation frame'
    // Tree SVG labels are width-truncated; their row path remains authoritative.
    const matchesText = node => !text || node.textContent.includes(text) || node.getAttribute('data-item-path')?.includes(text)
    const timer = setTimeout(() => {
      cancelAnimationFrame(frame)
      // Failure-only DOM evidence: keep the original deadline and readiness checks.
      const element = queryAll(selector).find(matchesText)
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
    const shadowRoots = () => {
      const roots = [document]
      for (let index = 0; index < roots.length; index++) {
        for (const element of roots[index].querySelectorAll('*')) {
          if (element.shadowRoot) roots.push(element.shadowRoot)
        }
      }
      return roots
    }
    const queryAll = query => {
      let roots = shadowRoots()
      const selectors = query.split(' >>> ')
      for (let index = 0; index < selectors.length; index++) {
        const matches = roots.flatMap(root => [...root.querySelectorAll(selectors[index])])
        if (index === selectors.length - 1) return matches
        roots = matches.map(element => element.shadowRoot).filter(Boolean)
      }
    }
    const deepHit = (x, y) => {
      let hit = document.elementFromPoint(x, y)
      while (hit?.shadowRoot) {
        const inner = hit.shadowRoot.elementFromPoint(x, y)
        if (!inner || inner === hit) break
        hit = inner
      }
      return hit
    }
    const inspect = () => {
      // Optional text narrows repeated controls such as menu items to the labelled target.
      // Pierre controls render in open shadow roots, so query and hit-test the composed DOM.
      const element = queryAll(selector).find(matchesText)
      if (element) {
        if (scroll && !scrolled) {
          element.scrollIntoView({ block: 'center', inline: 'nearest' })
          scrolled = true
        }
        const box = element.getBoundingClientRect()
        const x = Math.round(box.left + box.width / 2), y = Math.round(box.top + box.height / 2)
        const geometry = JSON.stringify([box.x, box.y, box.width, box.height])
        const hit = box.width > 0 && box.height > 0 && element.contains(deepHit(x, y))
        // Two equal frames can precede a pending route/layout transition. Wait
        // for finite animations, not perpetual activity spinners, before input.
        let moving = false
        for (let node = element; node && !moving; node = node.parentElement ?? node.getRootNode().host) {
          moving = node.getAnimations().some(animation =>
            (animation.pending || animation.playState === 'running') &&
            Number.isFinite(animation.effect?.getComputedTiming().endTime))
        }
        readiness = !hit ? 'target not hit' : moving ? 'finite animation active' : previous !== geometry ? 'geometry changed' : 'ready'
        if (hit && !moving && previous === geometry) {
          clearTimeout(timer)
          if (confirmPoint && (x !== confirmPoint.x || y !== confirmPoint.y)) {
            resolve(null)
            return
          }
          if (captureReceipt) {
            window.__nativeUiPointerReceipt = null
            // Disabled controls suppress click events, but must still be hit by
            // the native pointer. Business effects remain the caller's assertions.
            document.addEventListener('pointerup', event => {
              window.__nativeUiPointerReceipt = {
                trusted: event.isTrusted, targetMatched: event.composedPath().includes(element),
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

/** Move over the target before pressing, then recheck the hit and arm the receipt. */
export async function aimNativeUiPointer(cdp, evaluate, selector, timeoutMs) {
  const deadline = performance.now() + timeoutMs
  const timeout = () => new Error(`Pointer target moved before press: ${selector}`)
  const probe = (options) => evaluate(`(${nativeUiPointer.toString()})(${JSON.stringify(selector)}, ${JSON.stringify({
    timeoutMs: Math.max(0, deadline - performance.now()), ...options
  })})`)
  const aim = async () => {
    while (performance.now() < deadline) {
      const point = await probe({ scroll: true, captureReceipt: false })
      if (performance.now() >= deadline) break
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
      if (performance.now() >= deadline) break
      const ready = await probe({ captureReceipt: true, confirmPoint: point })
      if (ready && performance.now() < deadline) return ready
    }
    throw timeout()
  }
  let timer
  try {
    return await Promise.race([aim(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(timeout()), timeoutMs)
    })])
  } finally {
    clearTimeout(timer)
  }
}
