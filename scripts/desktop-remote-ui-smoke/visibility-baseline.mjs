export async function runVisibilityPollingBaseline({ contents }) {
    await new Promise(resolve => setTimeout(resolve, 1000))
    await contents.executeJavaScript('Object.defineProperty(document, "hidden", { configurable: true, get: () => true }); Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" }); document.dispatchEvent(new Event("visibilitychange"))')
    const hidden = await contents.executeJavaScript('document.hidden')
    const before = await contents.executeJavaScript('({ list: window.desktopRemoteFixture.listCalls, catalog: window.desktopRemoteFixture.catalogCalls, remoteStatus: window.desktopRemoteFixture.remoteStatusCalls, intents: window.desktopRemoteFixture.intentsCalls, runStatus: window.desktopRemoteFixture.runStatusCalls, trace: window.desktopRemoteFixture.traceCalls.length })')
    await new Promise(resolve => setTimeout(resolve, 60_000))
    const after = await contents.executeJavaScript('({ list: window.desktopRemoteFixture.listCalls, catalog: window.desktopRemoteFixture.catalogCalls, remoteStatus: window.desktopRemoteFixture.remoteStatusCalls, intents: window.desktopRemoteFixture.intentsCalls, runStatus: window.desktopRemoteFixture.runStatusCalls, trace: window.desktopRemoteFixture.traceCalls.length })')
    return { durationSeconds: 60, hidden, before, after, delta: Object.fromEntries(Object.keys(after).map(key => [key, after[key] - before[key]])) }
}
