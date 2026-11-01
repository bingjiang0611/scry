import assert from 'node:assert/strict'
import { measureNativeSessionOpen } from './session-open-timing.mjs'
import { nativeInitialPageTurns } from './performance-native.mjs'

export async function measureHistory({ evaluate, wait, click, cdp, beginCounters, endCounters, metricValues, lastMetrics, sessions, iterations, turnCount, sections, cwd, traces }) {
  const pageTurns = Math.min(nativeInitialPageTurns, turnCount)
  const latestIndex = turnCount - 1
  const samples = []
  const firstOpens = []
  for (let index = 0; index < iterations + 2; index++) {
    const sessionId = sessions[index % sessions.length]
    const counterStart = await beginCounters()
    await evaluate(`(() => {
      window.__sessionNativeTiming = (${measureNativeSessionOpen.toString()})(
        Array.from(document.querySelectorAll('button.sb-sess')).find(element => element.textContent.includes(${JSON.stringify(sessionId)})),
        () => {
          const scroller = document.querySelector('.chat-transcript[aria-busy="false"]')
          const last = document.querySelector('[data-run-id="${sessionId}-turn-${latestIndex}"]')
          const input = document.querySelector('textarea')
          if (!scroller || !last?.textContent.includes('END ${sessionId} ${latestIndex}') || !input || input.disabled || input.readOnly) return false
          const rect = last.getBoundingClientRect()
          const viewport = scroller.getBoundingClientRect()
          return rect.bottom >= viewport.top && rect.top <= viewport.bottom
        }
      )
    })()`)
    await evaluate(`(() => {
      window.__sessionOpenStarted = performance.now();
      window.__sessionFirstContent = null;
      window.__sessionCacheObserved = false;
      const inspect = () => {
        const last = document.querySelector('[data-run-id="${sessionId}-turn-${latestIndex}"]');
        if (!last?.textContent.includes('END ${sessionId} ${latestIndex}')) return;
        window.__sessionCacheObserved ||= document.querySelector('.chat-transcript')?.getAttribute('aria-busy') === 'true';
        requestAnimationFrame(() => {
          if (window.__sessionFirstContent != null || !last.isConnected) return;
          const rect = last.getBoundingClientRect();
          const viewport = document.querySelector('.chat-transcript').getBoundingClientRect();
          if (rect.bottom >= viewport.top && rect.top <= viewport.bottom) {
            window.__sessionFirstContent = performance.now() - window.__sessionOpenStarted;
          }
        });
      };
      window.__sessionOpenObserver = new MutationObserver(inspect);
      window.__sessionOpenObserver.observe(document.querySelector('.chat-transcript'), { childList: true, characterData: true, subtree: true });
    })()`)
    await click(`Array.from(document.querySelectorAll('button.sb-sess')).find(element => element.textContent.includes(${JSON.stringify(sessionId)}))`)
    await wait(`document.querySelector('.chat-transcript[aria-busy="false"]') &&
      document.querySelector('[data-run-id="${sessionId}-turn-${latestIndex}"]')?.textContent.includes('END ${sessionId} ${latestIndex}') &&
      document.querySelector('textarea') && !document.querySelector('textarea').disabled && !document.querySelector('textarea').readOnly`)
    const sample = await evaluate(`(() => {
      const scroller = document.querySelector('.chat-transcript')
      const last = document.querySelector('[data-run-id="${sessionId}-turn-${latestIndex}"]')
      const rect = last.getBoundingClientRect()
      const viewport = scroller.getBoundingClientRect()
      if (rect.bottom < viewport.top || rect.top > viewport.bottom) throw new Error('Latest turn not in viewport')
      window.__sessionOpenObserver.disconnect();
      if (window.__sessionFirstContent == null) throw new Error('First matching timeline layout was not observed');
      const legacyEndAt = performance.now()
      return { openMs: legacyEndAt - window.__sessionOpenStarted,
        legacyStartAt: window.__sessionOpenStarted, legacyEndAt,
        firstContentMs: window.__sessionFirstContent, cacheObserved: window.__sessionCacheObserved,
        mountedTurns: document.querySelectorAll('.transcript-turn:not([data-virtualized])').length,
        totalTurns: document.querySelectorAll('.transcript-turn').length,
        completeParagraphs: (document.querySelector('[data-run-id="${sessionId}-turn-${latestIndex}"]').textContent.match(/A measured history paragraph with a link\\./g) || []).length,
        domNodes: scroller.querySelectorAll('*').length }
    })()`)
    const native = await evaluate('window.__sessionNativeTiming')
    assert.equal(native.trustedClick, true, 'measurement must originate from a native browser click')
    assert.ok(native.nativeOpenMs >= 0 && native.handlerDelayMs >= 0, 'native timestamps must use the renderer clock')
    sample.nativeOpenMs = native.nativeOpenMs
    sample.handlerDelayMs = native.handlerDelayMs
    sample.driverBeforeClickMs = native.clickAt - sample.legacyStartAt
    // Signed: a negative value means the old readback preceded two stable visible frames.
    sample.legacyReadbackLagMs = sample.legacyEndAt - native.readyAt
    delete sample.legacyStartAt
    delete sample.legacyEndAt
    assert.equal(sample.totalTurns, pageTurns, 'history must retain every turn in the initial page')
    assert.equal(sample.completeParagraphs, sections, 'renderer must not trade away fixed paragraph content for speed')
    const workCounters = await endCounters(counterStart)
    sample.workCounters = workCounters
    const metricsBefore = metricValues(counterStart.metrics)
    sample.scriptMs = (lastMetrics().ScriptDuration - metricsBefore.ScriptDuration) * 1000
    if (index >= 2) samples.push(sample)
    else firstOpens.push(sample)
  }
  // Adjacent paths: native typing, offscreen history recovery and scroll-back.
  await click(`document.querySelector('textarea')`)
  await evaluate(`window.__nativeInputFrame = new Promise(resolve => {
    document.querySelector('textarea').addEventListener('input', event => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve({ trusted: event.isTrusted, frameReadyMs: performance.now() - event.timeStamp })))
    }, { once: true })
  }); true`)
  await cdp.send('Input.insertText', { text: 'draft stays editable' })
  const nativeInput = await evaluate('window.__nativeInputFrame')
  assert.equal(nativeInput.trusted, true)
  assert.ok(nativeInput.frameReadyMs >= 0)
  assert.equal(await evaluate(`document.querySelector('textarea').value`), 'draft stays editable')
  const currentSession = sessions[(iterations + 1) % 2]
  for (let loaded = pageTurns; loaded < turnCount; loaded += 40) {
    await evaluate(`document.querySelector('.chat-transcript').scrollTop = 0`)
    await wait(`document.querySelector('.history-window-more') && !document.querySelector('.history-window-more').disabled`)
    await click(`document.querySelector('.history-window-more')`)
    await wait(`document.querySelectorAll('.transcript-turn').length === ${Math.min(loaded + 40, turnCount)}`)
  }
  await evaluate(`document.querySelector('.chat-transcript').scrollTop = 0`)
  await wait(`document.querySelector('[data-run-id="${currentSession}-turn-0"]')?.textContent.includes('END ${currentSession} 0')`)
  await evaluate(`(() => { const scroller = document.querySelector('.chat-transcript'); scroller.scrollTop = scroller.scrollHeight })()`)
  await wait(`document.querySelector('[data-run-id="${currentSession}-turn-${latestIndex}"]')?.textContent.includes('END ${currentSession} ${latestIndex}')`)
  assert.equal(await evaluate(`document.querySelector('textarea').value`), 'draft stays editable')
  const loads = traces.filter(trace => trace.name === 'session_history.load')
  assert.equal(loads.length, iterations + 2, 'every measured open must have a main-process trace')
  assert.ok(loads.every(load => load.counters.returnedTurns === pageTurns), 'main must return the full initial page')
  const context = { providerId: 'codex', cwd, externalSessionId: currentSession }
  const history = await evaluate(`window.scry.loadSession(${JSON.stringify(context)})`)
  assert.equal(history.totalTurns, turnCount)
  assert.equal(history.turns.length, pageTurns)
  assert.equal(history.hasOlder, turnCount > pageTurns)
  // Dispatch two native selections without waiting between them. A superseded read
  // must never replace the second selection or mix another session into its page.
  for (const sessionId of sessions) {
    await click(`Array.from(document.querySelectorAll('button.sb-sess')).find(element => element.textContent.includes(${JSON.stringify(sessionId)}))`)
  }
  await wait(`document.querySelector('.chat-transcript[aria-busy="false"]') &&
    document.querySelector('[data-run-id="${currentSession}-turn-${latestIndex}"]')?.textContent.includes('END ${currentSession} ${latestIndex}')`)
  const displayedIds = await evaluate(`Array.from(document.querySelectorAll('.transcript-turn')).map(element => element.dataset.runId)`)
  assert.ok(displayedIds.every(id => id.startsWith(currentSession + '-turn-')), 'stale selection must not replace current history')
  assert.equal(await evaluate(`document.querySelector('textarea').value`), 'draft stays editable')
  const invalidHistory = await evaluate(`window.scry.loadSession(${JSON.stringify({ ...context, externalSessionId: 'missing-perf-fixture' })}).then(() => false, () => true)`)
  assert.equal(invalidHistory, true, 'fixture must exercise a real rejected history handler')
  return { samples, firstOpens, nativeInput, loads }
}
