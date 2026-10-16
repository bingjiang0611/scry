// Serialized into the isolated Electron runner. All clicks and keyboard input
// go through Chromium's native event path, not HTMLElement.click().
export async function exerciseSessionCache(contents) {
  const read = async expression => {
    try { return await contents.executeJavaScript(expression) }
    catch (error) { throw new Error('Cache UI expression failed: ' + expression + '\n' + String(error)) }
  }
  const check = (condition, message) => { if (!condition) throw new Error(message) }
  const wait = expression => read(`(async () => {
    const deadline = Date.now() + 5000;
    while (!(${expression})) {
      if (Date.now() > deadline) throw new Error('Cache UI timeout: ' + ${JSON.stringify(expression)} + '\\n' + document.body.innerText.slice(-1800));
      await new Promise(resolve => setTimeout(resolve, 16));
    }
  })().catch(error => { console.error('Cache UI wait rejected:', error.stack); throw error; })`)
  const click = async expression => {
    const point = await read(`(() => {
      const element = ${expression};
      if (!element) throw new Error('Cache native target missing');
      const rect = element.getBoundingClientRect();
      const point = { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
      if (!element.contains(document.elementFromPoint(point.x, point.y))) throw new Error('Cache native target obscured');
      return point;
    })()`)
    contents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 })
    contents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 })
  }
  const select = id => click(`Array.from(document.querySelectorAll('button.sb-sess')).find(element => element.textContent.includes(${JSON.stringify(id)}))`)
  const control = id => click(`document.getElementById(${JSON.stringify(id)})`)
  const pending = id => wait(`JSON.parse(document.getElementById('cache-state').textContent).pending.includes(${JSON.stringify(id)})`)
  const ready = (id, version = 1) => wait(`document.querySelector('.chat-transcript[aria-busy="false"]') && document.querySelector('.chat-transcript').textContent.includes(${JSON.stringify(`Authoritative ${id} v${version}`)})`)
  const cached = id => read(`document.querySelector('.chat-transcript[aria-busy="true"]') != null &&
    document.querySelector('.chat-transcript').textContent.includes(${JSON.stringify(`Authoritative ${id}`)}) &&
    document.querySelector('.chat-evidence-source').textContent.includes('待核对')`)
  const stateOf = () => read(`JSON.parse(document.getElementById('cache-state').textContent)`)
  const noTurns = () => read(`document.querySelectorAll('.transcript-turn').length === 0`)
  await wait(`document.querySelectorAll('button.sb-sess').length === 2`)

  await select('cache-a'); await pending('cache-a')
  check(await noTurns(), 'Cold selection displayed another history')
  await control('resolve-a'); await ready('cache-a')
  await select('cache-b'); await pending('cache-b')
  check(await noTurns(), 'Cold B reused A')
  await control('resolve-b'); await ready('cache-b')

  await control('emit-degraded-health')
  await wait(`JSON.parse(document.getElementById('cache-state').textContent).recoveryReads > 0`)
  const beforeCache = await stateOf()
  await control('arm-buffer-on-selection')
  await select('cache-a'); await pending('cache-a')
  check(await cached('cache-a'), 'Warm page was not rendered before authority response')
  check((await stateOf()).traceRecoveries === beforeCache.traceRecoveries, 'Display-only cache acknowledged authoritative trace recovery')
  await wait(`JSON.parse(document.getElementById('cache-state').textContent).traceAcknowledgements === ${beforeCache.traceAcknowledgements + 1}`)
  check(await read(`!document.querySelector('.chat-transcript').textContent.includes('BUFFERED BEFORE SELECTION')`), 'Buffered previous-run trace survived cache installation')
  await control('emit-old-trace'); await control('emit-degraded-health')
  await wait(`JSON.parse(document.getElementById('cache-state').textContent).traceAcknowledgements === ${beforeCache.traceAcknowledgements + 2}`)
  const pendingCache = await stateOf()
  check(pendingCache.traceAcknowledgements === beforeCache.traceAcknowledgements + 2, 'Ignored stale batch was not consumed')
  check(pendingCache.traceRecoveries === beforeCache.traceRecoveries && pendingCache.recoveryReads === beforeCache.recoveryReads, 'Cache recovered an old focused run before authority')
  check(await read(`!document.querySelector('.chat-transcript').textContent.includes('STALE OTHER SESSION')`), 'Late previous-focused traces entered cached history')
  check(await read(`document.querySelector('button.send').disabled && !document.querySelector('button[title="从此轮创建分支会话"]')`), 'Cache enabled send or fork before refresh')
  await click(`document.querySelector('textarea')`)
  await wait(`document.activeElement === document.querySelector('textarea')`)
  await contents.insertText('draft while refreshing')
  await wait(`document.querySelector('textarea').value === 'draft while refreshing'`)
  contents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' })
  contents.sendInputEvent({ type: 'char', keyCode: '\r' })
  contents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
  check(await read(`JSON.parse(document.getElementById('cache-state').textContent).starts === 0`), 'Enter launched a provider while cache was pending')
  await control('update-a'); await control('resolve-a'); await ready('cache-a', 2)
  check((await stateOf()).traceRecoveries === beforeCache.traceRecoveries + 1, 'Changed authority page did not acknowledge recovery once')
  const refreshed = await read(`({ source: document.querySelector('.chat-evidence-source')?.textContent,
    fork: document.querySelector('button[title="从此轮创建分支会话"]') != null,
    disabled: document.querySelector('button.send').disabled, input: document.querySelector('textarea').value,
    composer: document.querySelector('.composer')?.textContent })`)
  check(!refreshed.source.includes('待核对') && refreshed.fork && !refreshed.disabled,
    'Authority refresh did not replace cached state or restore controls: ' + JSON.stringify(refreshed))

  await select('cache-b'); await pending('cache-b')
  check(await cached('cache-b'), 'Warm B snapshot missing')
  await select('cache-a'); await pending('cache-a')
  await control('resolve-b')
  check(await cached('cache-a'), 'A superseded B response replaced current A cache')
  const beforeConfirmation = await stateOf()
  await control('emit-old-trace')
  await control('resolve-a'); await ready('cache-a', 2)
  check((await stateOf()).traceRecoveries === beforeConfirmation.traceRecoveries + 1, 'Exact authority confirmation did not acknowledge recovery once')
  check(await read(`!document.querySelector('.chat-transcript').textContent.includes('STALE OTHER SESSION')`), 'Exact confirmation retained contaminated cached history')
  check(await read(`document.querySelector('textarea').value === 'draft while refreshing'`), 'Warm selection lost its scoped draft')

  await select('cache-b'); await pending('cache-b')
  await control('resolve-b'); await ready('cache-b')
  await select('cache-a'); await pending('cache-a')
  check(await cached('cache-a'), 'Failure control requires a real cache hit')
  await control('reject-a')
  await wait(`document.querySelector('.chat-session-evidence-gap[data-status="error"]') != null`)
  check(await noTurns(), 'Failed authority response kept cached history as current evidence')
  check(await read(`document.querySelector('.chat-transcript').textContent.includes('fixture source unavailable')`), 'Authority failure was hidden')
  await select('cache-a'); await pending('cache-a')
  check(await noTurns(), 'Rejected cache resurrected on retry')
  await control('resolve-a'); await ready('cache-a', 2)

  await select('cache-b'); await pending('cache-b')
  check(await cached('cache-b'), 'Invalidation control requires a real B cache hit')
  await control('invalidate-cache')
  // Native dispatch can return before React commits the invalidation. Keep the
  // authority request pending and require the visible cache to clear before resolving it.
  await wait(`document.querySelectorAll('.transcript-turn').length === 0`)
  await control('resolve-b'); await ready('cache-b')
  await select('cache-a'); await pending('cache-a')
  check(await noTurns(), 'Data invalidation did not clear A cache')
  await control('resolve-a'); await ready('cache-a', 2)
  await select('cache-b'); await pending('cache-b')
  check(await noTurns(), 'An old pending read reinserted B after invalidation')
  await control('resolve-b'); await ready('cache-b')
  await select('cache-a'); await pending('cache-a')
  check(await cached('cache-a'), 'Focus supersession requires a real warm cache')
  await control('focus-live-b'); await pending('cache-b')
  check(await read(`!document.querySelector('.chat-evidence-source')?.textContent.includes('待核对')`), 'Authoritative live focus retained the cache source label')
  await control('resolve-a')
  await wait(`!JSON.parse(document.getElementById('cache-state').textContent).pending.includes('cache-a')`)
  check(await read(`document.querySelector('.chat-transcript[aria-busy="true"]') != null && !document.querySelector('.chat-transcript').textContent.includes('Authoritative cache-a')`), 'Late cache authority replaced the newer live focus')
  await control('resolve-b')
  await wait(`document.querySelector('.chat-transcript[aria-busy="false"]') && document.querySelector('.chat-transcript').textContent.includes('AUTHORITATIVE LIVE B')`)
  check(await read(`document.querySelector('.transcript-turn[data-run-id="live-b"]') != null`), 'Focused live run was lost during its own history restoration')
  const state = await read(`JSON.parse(document.getElementById('cache-state').textContent)`)
  check(state.starts === 0 && state.forks === 0 && state.pending.length === 0, 'Fixture left work or invoked a provider')
  return { cachedBeforeAuthority: true, controlsRemainLocked: true, refreshedAuthority: true,
    supersededResponseIgnored: true, failureHonest: true, retryNoResurrection: true,
    deletionAndPendingReadFenced: true, draftPreserved: true, nativeInput: true,
    staleTraceIsolation: true, bufferedTraceCleared: true, cacheCannotAcknowledgeRecovery: true,
    exactAuthorityConfirmation: true, liveFocusSupersedesCache: true, ...state }
}
