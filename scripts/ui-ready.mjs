// Passive readiness only: never select a session, reopen a tab, or repair state.
// The caller supplies its existing bounded wait so deadlines/crash propagation
// stay owned by the harness. Loading-state tests intentionally omit `body`.
export function createUiReady(wait) {
  return ({ body, panel, target, documentEpoch, timeoutMs } = {}) => {
    const conditions = ["document.readyState !== 'loading'", 'document.body != null']
    if (documentEpoch !== undefined) conditions.push(`performance.timeOrigin !== ${JSON.stringify(documentEpoch)}`)
    if (body) conditions.push(body)
    if (panel) conditions.push(`document.querySelector(${JSON.stringify(panel)})?.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) === true`)
    if (target) conditions.push(target)
    // Keep all stages in one predicate: an old body, a hidden retained panel, or
    // a different selected session cannot satisfy separate observations in time.
    const expression = conditions.map(condition => `(${condition})`).join(' && ')
    return timeoutMs === undefined ? wait(expression) : wait(expression, timeoutMs)
  }
}

// Page.reload only acknowledges dispatch. Start renderer-side readiness after
// loadEventFired, not inside the execution context navigation is about to destroy.
export async function reloadUi(cdp, ready, options, reloadParams = {}) {
  const timeoutMs = options.timeoutMs ?? 20000
  const deadline = Date.now() + timeoutMs
  await cdp.send('Page.enable')
  let unsubscribe
  let timer
  const loaded = new Promise((resolve, reject) => {
    unsubscribe = cdp.on(event => {
      if (event.method === 'Page.loadEventFired') resolve()
      if (event.method === 'Inspector.targetCrashed') reject(new Error('Renderer crashed during reload (Inspector.targetCrashed)'))
    })
    timer = setTimeout(() => reject(new Error('Renderer reload did not finish before its readiness deadline')), timeoutMs)
  })
  try {
    await Promise.all([loaded, cdp.send('Page.reload', reloadParams)])
    await ready({ ...options, timeoutMs: Math.max(1, deadline - Date.now()) })
  } finally {
    clearTimeout(timer)
    unsubscribe()
  }
}
