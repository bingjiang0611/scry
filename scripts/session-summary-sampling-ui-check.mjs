export async function exerciseSummarySampling() {
  const check = (condition, message) => { if (!condition) throw new Error(message) }
  // Hidden Electron windows suspend rAF; the source cadence is an explicit timer.
  const frame = () => new Promise((resolve) => setTimeout(resolve, 16))
  const link = () => document.querySelector('#summary-performance span[title^="https://example.test/"]')?.getAttribute('title')
  const text = () => document.querySelector('#summary-performance')?.textContent ?? ''
  const readyDeadline = Date.now() + 5000
  while ((!window.summaryFixture || !link()) && Date.now() < readyDeadline) await frame()
  check(window.summaryFixture && link(), 'Summary fixture did not render its initial reference')
  const seen = new Set([link()])
  const started = performance.now()
  for (let step = 1; step <= 36; step++) {
    window.summaryFixture.push(step)
    await frame()
    seen.add(link())
  }
  const elapsed = performance.now() - started
  // This fails on the old per-token summary. Use elapsed time instead of assuming
  // 60 Hz, while requiring a real reduction rather than passing under severe load.
  check(seen.size <= Math.ceil(elapsed / 200) + 2, `Summary updated ${seen.size} times in ${elapsed}ms`)
  check(seen.size < 18, `Summary sampling not demonstrated under current load: ${seen.size} updates`)
  window.summaryFixture.push(37, 'first', true)
  check(link() === 'https://example.test/first/37' && text().includes('skill-37'), 'Terminal evidence was delayed or dropped')
  window.summaryFixture.push(0, 'second')
  check(link() === 'https://example.test/second/0' && text().includes('skill-0'), 'Session switch showed stale evidence')
  window.summaryFixture.push(1, 'second')
  // Allow the trailing sample to fire without another incoming event.
  await new Promise((resolve) => setTimeout(resolve, 240))
  check(link() === 'https://example.test/second/1', 'Trailing text evidence was lost')
  window.summaryFixture.push(2, 'second')
  window.summaryFixture.unmount()
  await new Promise((resolve) => setTimeout(resolve, 240))
  check(!document.querySelector('#summary-performance aside'), 'Unmount left the summary mounted')
  window.summaryFixture.push(0, 'third')
  check(link() === 'https://example.test/third/0', 'Remount retained an old sample')
  return { batches: 36, displayedSnapshots: seen.size, elapsedMs: Math.round(elapsed), terminalImmediate: true, switchImmediate: true, trailingText: true, remount: true }
}
