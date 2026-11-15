// Renderer probes shared by the Claude history acceptance driver: bounded DOM waits, native CDP
// clicks and wheel input, turn fingerprinting, and the older-page walk. The live CDP connection and
// App controller come in as getters because both exist only after the App launches.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { sampleStages } from './claude-session-open-harness.mjs'

export function createProbes({ cdp: connection, app: controller, screenshots, expectValue }) {
  const evaluate = async expression => {
    const response = await connection().send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text)
    return response.result.value
  }
  // Bounded, not trimmed: the first open of a fresh fixture publishes every tool body it shows, and
  // on a loaded host that legitimately takes minutes. The assertion is still "no banner", not "fast".
  const wait = expression => evaluate(`(async () => {
    const deadline = performance.now() + 300000
    while (!(${expression})) {
      if (performance.now() > deadline) throw new Error('UI condition timed out: ' + ${JSON.stringify(expression)} + '\\n' + JSON.stringify({
        busy: document.querySelector('.chat-transcript')?.getAttribute('aria-busy'),
        source: document.querySelector('.chat-transcript')?.getAttribute('data-history-source'),
        turns: document.querySelectorAll('.transcript-turn').length,
        status: document.querySelector('#composer-status')?.textContent,
        body: document.body.innerText.slice(-1500)
      }))
      await new Promise(resolve => setTimeout(resolve, 16))
    }
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  })()`)
  const click = async selectorExpression => {
    const point = await evaluate(`(() => {
      const element = ${selectorExpression}
      if (!element) throw new Error('Native click target missing')
      element.scrollIntoView({ block: 'center', inline: 'center' })
      const rect = element.getBoundingClientRect()
      // Sidebar rows sit under sticky fades/list padding, so probe a few offsets before failing; the
      // click still lands on the element itself, never on whatever happens to be on top.
      const candidates = [[0.5, 0.5], [0.5, 0.35], [0.5, 0.65], [0.25, 0.5], [0.75, 0.5]]
      for (const [fx, fy] of candidates) {
        const point = { x: rect.x + rect.width * fx, y: rect.y + rect.height * fy }
        if (point.x < 1 || point.y < 1 || point.x > innerWidth - 1 || point.y > innerHeight - 1) continue
        const hit = document.elementFromPoint(point.x, point.y)
        if (hit && element.contains(hit)) return point
      }
      const center = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
      throw new Error('Native click target obscured by ' + (center ? (center.tagName + '.' + String(center.className)).slice(0, 120) : 'nothing (outside viewport)'))
    })()`)
    await connection().send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
    await connection().send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
  }
  const sessionSelector = sessionId => `Array.from(document.querySelectorAll('button.sb-sess')).find(element => element.textContent.includes(${JSON.stringify(sessionId)}))`
  const capture = async name => {
    const shot = await connection().send('Page.captureScreenshot', { format: 'png' })
    const path = join(screenshots, `${expectValue}-${name}.png`)
    writeFileSync(path, Buffer.from(shot.data, 'base64'))
    return path
  }
  const readyExpression = session => `document.querySelector('.chat-transcript[aria-busy="false"][data-history-source="authoritative"]')
    && document.querySelector('[data-run-id=${JSON.stringify(session.lastRunId)}]')
    && document.querySelector('textarea') && !document.querySelector('textarea').disabled`
  const openSession = async session => {
    const started = Date.now()
    await click(sessionSelector(session.sessionId))
    await wait(readyExpression(session))
    return Date.now() - started
  }
  const loadTraces = (name, mark) => controller().traces.slice(mark).filter(trace => trace.name === name)

  /** Scrolls the whole timeline so virtualized turns mount, then fingerprints their text. */
  const dumpTurns = () => evaluate(`(async () => {
    const scroller = document.querySelector('.chat-transcript')
    const order = Array.from(document.querySelectorAll('.transcript-turn')).map(node => node.dataset.runId)
    // A turn's text is large (tool output included), so compare length plus a stable checksum
    // instead of shipping the whole timeline back to the driver.
    const fingerprint = text => {
      let hash = 0x811c9dc5
      for (let index = 0; index < text.length; index++) {
        hash ^= text.charCodeAt(index)
        hash = Math.imul(hash, 0x01000193) >>> 0
      }
      return text.length + ':' + hash.toString(16).padStart(8, '0')
    }
    const seen = new Map()
    const collect = () => {
      for (const node of document.querySelectorAll('.transcript-turn')) {
        if (node.hasAttribute('data-virtualized')) continue
        if (!seen.has(node.dataset.runId)) seen.set(node.dataset.runId, { fingerprint: fingerprint(node.textContent), prefix: node.textContent.slice(0, 120) })
      }
    }
    const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    collect()
    for (let top = 0; top <= scroller.scrollHeight + 400; top += 240) {
      scroller.scrollTop = top
      await frame()
      collect()
      if (seen.size === order.length) break
    }
    await frame()
    collect()
    return { turns: order.map((runId, index) => ({ runId, index, ...(seen.get(runId) ?? { fingerprint: null, prefix: null }) })), mounted: seen.size, total: order.length }
  })()`)

  /** Wheel-scrolls the timeline to the top, letting the App's own autoload fetch each older page. */
  const loadOlderUntilStart = async () => {
    const pages = []
    const center = await evaluate(`(() => {
      const rect = document.querySelector('.chat-transcript').getBoundingClientRect()
      return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) }
    })()`)
    // Real wheel input: the autoload listens to scroll events on the transcript, and a synthetic
    // scrollTop assignment plus a dispatched event is not what a user does.
    const wheelUp = async turns => {
      for (let step = 0; step < 12; step++) {
        await connection().send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: center.x, y: center.y, deltaX: 0, deltaY: -800 })
        await new Promise(resolve => setTimeout(resolve, 60))
        const state = await evaluate(`(() => ({
          turns: document.querySelectorAll('.transcript-turn').length,
          busy: document.querySelector('.history-window-note')?.getAttribute('aria-busy') ?? null
        }))()`)
        if (state.turns > turns || state.busy === 'true') return state
      }
      return evaluate(`(() => ({
        turns: document.querySelectorAll('.transcript-turn').length,
        busy: document.querySelector('.history-window-note')?.getAttribute('aria-busy') ?? null
      }))()`)
    }
    const diagnostics = () => evaluate(`(() => {
      const scroller = document.querySelector('.chat-transcript')
      return {
        turns: document.querySelectorAll('.transcript-turn').length,
        scrollTop: Math.round(scroller.scrollTop), scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight,
        hasOlderNote: Boolean(document.querySelector('.history-window-note')),
        noteBusy: document.querySelector('.history-window-note')?.getAttribute('aria-busy') ?? null,
        moreDisabled: document.querySelector('.history-window-more')?.disabled ?? null,
        moreMissing: !document.querySelector('.history-window-more'),
        status: document.querySelector('#composer-status')?.textContent ?? null,
        loadSessionOlder: typeof window.scry.loadSessionOlder
      }
    })()`)
    for (let attempt = 0; attempt < 40; attempt++) {
      const before = await diagnostics()
      if (!before.hasOlderNote) return { pages, totalTurns: before.turns, diagnostics: before }
      const mark = controller().traceCount()
      const started = Date.now()
      let after = before.turns
      await wheelUp(before.turns)
      for (let waited = 0; waited < 6000; waited += 50) {
        after = await evaluate(`document.querySelectorAll('.transcript-turn').length`)
        if (after > before.turns) break
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      if (after === before.turns) {
        // The wheel did not request a page: use the explicit control and record why it may not act.
        if (before.moreDisabled !== false) {
          return { pages, totalTurns: after, stopped: `control unusable (disabled=${before.moreDisabled}, missing=${before.moreMissing})`, diagnostics: await diagnostics() }
        }
        await click(`document.querySelector('.history-window-more')`)
        await new Promise(resolve => setTimeout(resolve, 200))
        const afterClick = await diagnostics()
        // The note's aria-busy proves the request started even if the page never grows.
        // 20 turns x 30 tool bodies publish with durable writes on the first (cold) older page, which
        // is minutes on a loaded host; later pages hit the verified-content memo.
        if (afterClick.noteBusy === 'true' || afterClick.turns > before.turns) {
          for (let waited = 0; waited < 300000; waited += 100) {
            after = await evaluate(`document.querySelectorAll('.transcript-turn').length`)
            if (after > before.turns) break
            await new Promise(resolve => setTimeout(resolve, 50))
          }
        }
      }
      const older = loadTraces('session_history.load_older', mark).at(-1)
      pages.push({
        before: before.turns, after, added: after - before.turns, wallMs: Date.now() - started,
        loadOlderMs: older?.durationMs ?? null, stages: older ? sampleStages(older) : null
      })
      if (after === before.turns) {
        return { pages, totalTurns: after, stopped: 'no growth', diagnostics: await diagnostics(),
          tracesInWindow: controller().traces.slice(mark).map(trace => trace.name) }
      }
    }
    return { pages, totalTurns: await evaluate(`document.querySelectorAll('.transcript-turn').length`), stopped: 'attempt limit' }
  }
  /**
   * Watches the pending-authority state frame by frame while a session read is in flight. The
   * banner selector is observed through a MutationObserver so a single-frame insertion is caught.
   */
  const startHistoryPendingWatch = () => evaluate(`(() => {
    window.__bannerWatch = { bannerSeen: false, samples: [] }
    const insertions = new MutationObserver(records => {
      for (const entry of records) for (const node of entry.addedNodes) {
        if (node.nodeType !== 1) continue
        if (node.matches?.('.loading-status, .chat-history-banner') || node.querySelector?.('.loading-status, .chat-history-banner')) window.__bannerWatch.bannerSeen = true
      }
    })
    insertions.observe(document.querySelector('.chat-transcript').parentElement, { childList: true, subtree: true })
    window.__bannerWatchObserver = insertions
    window.__bannerWatchStart = performance.now()
    const sample = () => {
      const scroller = document.querySelector('.chat-transcript')
      const textarea = document.querySelector('textarea')
      if (window.__bannerWatch.samples.length < 600) {
        window.__bannerWatch.samples.push({
          ms: Math.round(performance.now() - window.__bannerWatchStart),
          busy: scroller?.getAttribute('aria-busy') ?? null,
          source: scroller?.getAttribute('data-history-source') ?? null,
          turns: document.querySelectorAll('.transcript-turn').length,
          draft: textarea?.value ?? null,
          // agentLocked = switchingAgent || submitting || session.busy || sessionLoading: it does not
          // depend on the draft, so it isolates the pending-authority lock.
          agentLocked: document.querySelector('.composer-action-controls button')?.disabled ?? null,
          banner: Boolean(document.querySelector('.chat-transcript .loading-status, .chat-history-banner'))
        })
      }
      if (window.__bannerWatch.samples.length < 600) requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
  })()`)

  /** Stops the watcher and reduces the frame samples to the values the assertions need. */
  const readHistoryPendingWatch = () => evaluate(`(() => {
    window.__bannerWatchObserver.disconnect()
    const data = window.__bannerWatch
    return {
      bannerSeen: data.bannerSeen || data.samples.some(sample => sample.banner),
      samples: data.samples.length,
      pending: data.samples.filter(sample => sample.busy === 'true' || sample.source === 'preview').length,
      agentLockedWhilePending: data.samples.filter(sample => (sample.busy === 'true' || sample.source === 'preview') && sample.agentLocked === false).length,
      agentLockSamples: data.samples.filter(sample => sample.agentLocked === true).length,
      firstSamples: data.samples.slice(0, 4),
      lastSamples: data.samples.slice(-3)
    }
  })()`)

  return { evaluate, wait, click, sessionSelector, readyExpression, capture, loadTraces, dumpTurns, loadOlderUntilStart,
    openSession, startHistoryPendingWatch, readHistoryPendingWatch }
}
