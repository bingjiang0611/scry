export async function runVisibilityPollingCheck({ read, wait, check }) {
    const ready = 'document.querySelector(".hosts-state[data-state=connected]") && document.querySelector(".remote-pairing .remote-access-status.is-ready") && document.querySelector(".sb-running")'
    const stale = '!document.querySelector(".hosts-state[data-state=connected]") && !document.querySelector(".remote-pairing .remote-access-status.is-ready") && !document.querySelector(".sb-running")'
    const counters = () => read('({ list: window.desktopRemoteFixture.listCalls, catalog: window.desktopRemoteFixture.catalogCalls, status: window.desktopRemoteFixture.remoteStatusCalls })')
    await wait(ready, 'initial confirmed live state')
    await wait('document.querySelector(".runtime-composer button.send")?.disabled === false', 'initial send ready')
    await read('window.setPollingVisibility = hidden => { Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden }); Object.defineProperty(document, "visibilityState", { configurable: true, get: () => hidden ? "hidden" : "visible" }); document.dispatchEvent(new Event("visibilitychange")) }; window.desktopRemoteFixture.holdVisibilityReads = true; window.setPollingVisibility(true); window.setPollingVisibility(false)')
    await wait('window.visibilityWaiting().length === 3', 'resume status/catalog/connection reads held')
    check(await read(stale), 'Resume must withdraw stale online/activity confirmation')
    check(await read('document.body.innerText.includes("Old session")'), 'Retained catalog history must remain visible')
    check(await read('document.querySelector(".runtime-composer button.send").disabled'), 'Send must wait for fresh live evidence')
    const pending = await counters()
    await read('void window.refreshFixtureConnections(); void window.refreshFixtureConnections(); void window.refreshFixtureCatalog(); void window.refreshFixtureCatalog()')
    check(JSON.stringify(await counters()) === JSON.stringify(pending), 'Direct reads must join pending requests')
    await read('window.desktopRemoteFixture.holdVisibilityReads = false; window.releaseVisibilityReads()')
    await wait(ready, 'fresh successful state after resume')
    await wait('document.querySelector(".runtime-composer button.send").disabled === false', 'send reenabled only after fresh poll')

    // An older read may finish after show; it cannot re-confirm online state.
    await read('window.desktopRemoteFixture.holdVisibilityReads = true; void window.refreshFixtureConnections(); void window.refreshFixtureCatalog()')
    await wait('window.visibilityWaiting().length === 3', 'older reads held including pairing interval')
    const older = await counters()
    await read('window.setPollingVisibility(true); window.setPollingVisibility(false)')
    check(await read(stale), 'Pending pre-hide reads must be marked stale')
    check(JSON.stringify(await counters()) === JSON.stringify(older), 'Resume must not overlap an older request')
    await read('window.releaseVisibilityReads()')
    await wait('window.visibilityWaiting().length === 3', 'one queued post-show read per path')
    const freshPending = await counters()
    check(Object.keys(older).every(key => freshPending[key] === older[key] + 1), 'Resume must queue exactly one fresh follow-up')
    check(await read(stale), 'Old completions must not re-confirm online/activity')
    await read('window.desktopRemoteFixture.holdVisibilityReads = false; window.releaseVisibilityReads(true)')
    await wait('document.body.innerText.includes("fixture visibility read failed")', 'refresh rejection surfaced')
    check(await read(stale), 'Failed refresh must not claim online/activity')
    check(await read('document.body.innerText.includes("Old session")'), 'Read rejection must preserve catalog history')
    check(await read('window.desktopRemoteFixture.submitInputs.length === 0'), 'Visibility changes must not submit a prompt')
    return { visibilityPolling: true, staleAuthority: true, deferredSingleFlight: true, rejectionRetainsHistory: true, counters: await counters() }
}
