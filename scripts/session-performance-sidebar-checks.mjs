export async function exerciseSidebarPerformance({ webContents, pointer, read, wait, click }) {
  const initialRenders = await read('Number(document.body.dataset.sidebarRenders)')
  for (let index = 1; index <= 20; index++) {
    await click('#stream')
    await wait(`document.querySelector('#stream').textContent === 'Stream ${index}'`)
  }
  const streamRenders = await read('Number(document.body.dataset.sidebarRenders)') - initialRenders
  if (streamRenders !== 0) throw new Error(`Streaming rerendered Sidebar ${streamRenders} times`)
  await click('.sb-sess')
  await wait(`document.body.dataset.pickedTick === '20'`)
  const rowRendersBeforePick = await read('Number(document.body.dataset.sessionRowRenders)')
  await click('.sb-sess-row:nth-child(2) .sb-sess')
  await wait(`document.querySelector('.sb-sess-row:nth-child(2) .sb-sess').getAttribute('aria-current') === 'true'`)
  const selectionRowRenders = await read('Number(document.body.dataset.sessionRowRenders)') - rowRendersBeforePick
  const rowRendersBeforeHover = await read('Number(document.body.dataset.sessionRowRenders)')
  const hoverPoint = await read(`(${pointer.toString()})('.sb-sess-row:nth-child(3) .sb-sess', { timeoutMs: 8000, scroll: false })`)
  webContents.sendInputEvent({ type: 'mouseMove', ...hoverPoint })
  await wait(`document.querySelector('.session-hover-heading strong')?.textContent === 'Question 2'`)
  const hoverRowRenders = await read('Number(document.body.dataset.sessionRowRenders)') - rowRendersBeforeHover
  console.log('SCRY_SIDEBAR_ROW_WORK=' + JSON.stringify({ selectionRowRenders, hoverRowRenders }))
  if (selectionRowRenders > 8 || hoverRowRenders > 8) throw new Error('Unrelated session rows rerendered: ' + JSON.stringify({ selectionRowRenders, hoverRowRenders }))
  if (await read(`document.querySelectorAll('.session-hover-card').length`) !== 1) throw new Error('Multiple session hover cards opened')
  webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
  webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
  await wait(`document.querySelector('.session-hover-card') == null`)
  // A focused card is open before ownership transfers to a different hovered row.
  await read(`document.querySelector('.sb-sess-row:nth-child(4) .sb-sess').focus()`)
  await wait(`document.querySelector('.session-hover-heading strong')?.textContent === 'Question 3'`)
  const transferPoint = await read(`(${pointer.toString()})('.sb-sess-row:nth-child(6) .sb-sess', { timeoutMs: 8000, scroll: false })`)
  webContents.sendInputEvent({ type: 'mouseMove', ...transferPoint })
  await wait(`document.querySelector('.session-hover-heading strong')?.textContent === 'Question 5'`)
  if (await read(`document.querySelectorAll('.session-hover-card').length`) !== 1) throw new Error('Ownership transfer retained a stale card')
  // Pending pointer-open must be cancelled when keyboard focus claims another row.
  webContents.sendInputEvent({ type: 'mouseMove', ...hoverPoint })
  await wait(`document.querySelector('.sb-sess-row:nth-child(3) .sb-sess').matches(':hover')`)
  await read(`document.querySelector('.sb-sess-row:nth-child(5) .sb-sess').focus()`)
  await wait(`document.querySelector('.session-hover-heading strong')?.textContent === 'Question 4'`)
  await read(`new Promise(resolve => {
    const until = performance.now() + 400;
    const check = () => performance.now() >= until ? resolve() : requestAnimationFrame(check);
    requestAnimationFrame(check);
  })`)
  if (!await read(`document.querySelectorAll('.session-hover-card').length === 1 && document.querySelector('.session-hover-heading strong')?.textContent === 'Question 4'`)) throw new Error('A cancelled pending hover reopened')
  await read(`(() => { globalThis.originalDateNow = Date.now; Date.now = () => globalThis.originalDateNow() + 31 * 24 * 60 * 60 * 1000; })()`)
  await read(`document.querySelector('.sb-sess-row:nth-child(6) .sb-sess').focus()`)
  await wait(`document.querySelector('.session-hover-heading strong')?.textContent === 'Question 5'`)
  if (!await read(`document.querySelector('.sb-sess-row:nth-child(6) .sb-sesstime').textContent === document.querySelector('.session-hover-age').textContent`)) throw new Error('Memoized row age disagrees with its tooltip after idle time')
  await read(`(() => { Date.now = globalThis.originalDateNow; delete globalThis.originalDateNow; })()`)
  // Collapsing the project unmounts the owner. Reopening must not resurrect its card.
  await click('.sb-proj-head')
  await wait(`document.querySelector('.sb-sess') == null && document.querySelector('.session-hover-card') == null`)
  await click('.sb-proj-head')
  await wait(`document.querySelectorAll('.sb-sess').length === 277`)
  await read(`document.querySelector('.sb-sess-row:nth-child(7) .sb-sess').focus()`)
  await wait(`document.querySelector('.session-hover-heading strong')?.textContent === 'Question 6' && document.querySelectorAll('.session-hover-card').length === 1`)
  // Exercise both motion modes explicitly rather than inheriting the runner's OS preference.
  await webContents.debugger.attach('1.3')
  await webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] })
  await wait(`!matchMedia('(prefers-reduced-motion: reduce)').matches`)
  await click('#running')
  await wait(`document.querySelectorAll('.sb-sess.running .sb-running').length === 8`)
  await wait(`document.getAnimations().filter(animation => animation.playState === 'running' && animation.effect.target.matches('.sb-running')).length === 8`)
  const activeSpinners = await read(`document.getAnimations().filter(animation => animation.playState === 'running' && animation.effect.target.matches('.sb-running')).length`)
  if (activeSpinners !== 8) throw new Error(`Expected 8 rotating running rings, got ${activeSpinners}`)
  const runningRingThemes = await read(`(() => {
    const root = document.documentElement;
    const rings = Array.from(document.querySelectorAll('.sb-sess.running .sb-running'));
    if (rings.filter(ring => ring.closest('.sb-sess.active')).length !== 1) throw new Error('Expected selected and background running sessions');
    const probe = document.createElement('span');
    probe.style.color = 'var(--dim2)';
    root.append(probe);
    const originalTheme = root.getAttribute('data-theme');
    try {
      return ['dark', 'light'].map(theme => {
        root.setAttribute('data-theme', theme);
        const neutral = getComputedStyle(probe).color;
        for (const ring of rings) {
          const style = getComputedStyle(ring);
          if (style.animationName !== 'sb-running-spin' || style.animationDuration !== '0.9s' ||
              style.animationTimingFunction !== 'linear' || style.animationIterationCount !== 'infinite' ||
              style.borderRadius !== '50%' || style.borderTopColor !== 'rgba(0, 0, 0, 0)' ||
              [style.borderRightColor, style.borderBottomColor, style.borderLeftColor].some(color => color !== neutral)) {
            throw new Error(theme + ': expected a neutral rotating running ring');
          }
        }
        const waitingRing = rings[0];
        waitingRing.setAttribute('data-background-waiting', 'true');
        try {
          const style = getComputedStyle(waitingRing);
          if (style.animationName !== 'none' || style.backgroundColor !== neutral || style.borderTopWidth !== '0px') {
            throw new Error(theme + ': expected a neutral static background-waiting dot');
          }
        } finally {
          waitingRing.removeAttribute('data-background-waiting');
        }
        return theme;
      });
    } finally {
      probe.remove();
      if (originalTheme === null) root.removeAttribute('data-theme');
      else root.setAttribute('data-theme', originalTheme);
    }
  })()`)
  await read(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
  const ringTransform = await read(`getComputedStyle(document.querySelector('.sb-running')).transform`)
  await wait(`getComputedStyle(document.querySelector('.sb-running')).transform !== ${JSON.stringify(ringTransform)}`)
  try {
    await webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
    await wait(`matchMedia('(prefers-reduced-motion: reduce)').matches && Array.from(document.querySelectorAll('.sb-running')).every(ring => getComputedStyle(ring).animationName === 'none')`)
  } finally {
    await webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] })
    webContents.debugger.detach()
  }
  await click('#running')
  await wait(`document.querySelectorAll('.sb-running').length === 0`)
  await click('#running')
  await wait(`document.querySelectorAll('.sb-running').length === 8`)

  return { historicalSessions: 277, streamCommits: 20, sidebarStreamRenders: streamRenders,
    selectionRowRenders, hoverRowRenders, singleHoverOwner: true, hoverEscapeDismissed: true,
    keyboardHoverOwnership: true, pendingHoverCancelled: true, hoverOwnerUnmounted: true, relativeAgeRefreshed: true,
    latestCallbackState: 20, runningIndicators: 8, animatedSpinners: activeSpinners, runningRingThemes,
    rotatingTransform: true, reducedMotion: true, completedIndicatorsRemoved: true, neutralBackgroundWaiting: true }
}
