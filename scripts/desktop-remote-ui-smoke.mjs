import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { desktopRemoteFixtureHead } from './desktop-remote-fixture-head.mjs'
import { desktopRemoteFixtureApi } from './desktop-remote-fixture-api.mjs'
import { desktopRemoteFixtureComponents } from './desktop-remote-fixture-components.mjs'
import { stopOwnedApp } from './owned-app-processes.mjs'
import { nativeUiPointer } from './native-ui-pointer.mjs'
import { runDesktopRemoteSmoke } from './desktop-remote-runner.mjs'
import { runConversationNavigation, runUnknownReceipt, runStructure, runOpeningControls } from './desktop-remote-scenarios-a.mjs'
import { runOpeningBench, runSettings, runPostSettings } from './desktop-remote-scenarios-b.mjs'
import { runComposerHistory, runPostComposer } from './desktop-remote-scenarios-c.mjs'
import { runLifecycle, runParity } from './desktop-remote-scenarios-d.mjs'
import { runDefaultStageA } from './desktop-remote-scenarios-default-A.mjs'
import { runDefaultStageB } from './desktop-remote-scenarios-default-B.mjs'
import { runDefaultStageC } from './desktop-remote-scenarios-default-C.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const temp = await mkdtemp(join(tmpdir(), 'scry-desktop-remote-ui-'))
const negativeControl = process.argv.includes('--negative-control')
const negativeMachineControl = process.argv.includes('--negative-machine-control')
const negativeAddressControl = process.argv.includes('--negative-address-control')
const negativeHoverControl = process.argv.includes('--negative-hover-control')
const negativeActivityControl = process.argv.includes('--negative-activity-control')
const negativeWorkspaceControl = process.argv.includes('--negative-workspace-control')
const negativePromptControl = process.argv.includes('--negative-prompt-control')
const negativeSettingsControl = process.argv.includes('--negative-settings-control')
const negativeSlashControl = process.argv.includes('--negative-slash-control')
const negativeHistorySlashControl = process.argv.includes('--negative-history-slash-control')
const negativeProviderRevisionControl = process.argv.includes('--negative-provider-revision-control')
const unknownReceiptOnly = process.argv.includes('--unknown-receipt-only')
const negativeUnknownReceiptControl = process.argv.includes('--negative-unknown-receipt-control')
const settingsOnly = process.argv.includes('--remote-settings-only')
const parityOnly = process.argv.includes('--session-parity-only')
const composerHistoryOnly = process.argv.includes('--composer-history-only')
const lifecycleOnly = process.argv.includes('--session-lifecycle-only')
const conversationNavigationOnly = process.argv.includes('--conversation-navigation-only')
const openingOnly = process.argv.includes('--session-opening-only')
const structureOnly = process.argv.includes('--structure-only')
const measureOpening = process.argv.includes('--measure-session-opening')
const visibilityPollingBaseline = process.argv.includes('--visibility-polling-baseline')
const visibilityPollingCheck = process.argv.includes('--visibility-polling-check')
const negativeVisibilityControl = process.argv.includes('--negative-visibility-control')
const keepArtifacts = process.argv.includes('--keep')

// This is a renderer-only contract fixture. The bridge records calls but never starts a
// Provider, opens a socket, reads credentials, or calls the local run-control API.
const fixtureContext = { root, unknownReceiptOnly, structureOnly, openingOnly, measureOpening, composerHistoryOnly, lifecycleOnly, conversationNavigationOnly, visibilityPollingCheck, visibilityPollingBaseline, negativeUnknownReceiptControl }
const fixtureSource = desktopRemoteFixtureHead(fixtureContext) + desktopRemoteFixtureApi(fixtureContext) + desktopRemoteFixtureComponents(fixtureContext)

async function exercise(contents, pointer, capture, options) {
  const check = (condition, message) => { if (!condition) throw new Error(message) }
  if (options.visibilityPollingBaseline) {
    await new Promise(resolve => setTimeout(resolve, 1000))
    await contents.executeJavaScript('Object.defineProperty(document, "hidden", { configurable: true, get: () => true }); Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" }); document.dispatchEvent(new Event("visibilitychange"))')
    const hidden = await contents.executeJavaScript('document.hidden')
    const before = await contents.executeJavaScript('({ list: window.desktopRemoteFixture.listCalls, catalog: window.desktopRemoteFixture.catalogCalls, remoteStatus: window.desktopRemoteFixture.remoteStatusCalls, intents: window.desktopRemoteFixture.intentsCalls, runStatus: window.desktopRemoteFixture.runStatusCalls, trace: window.desktopRemoteFixture.traceCalls.length })')
    await new Promise(resolve => setTimeout(resolve, 60_000))
    const after = await contents.executeJavaScript('({ list: window.desktopRemoteFixture.listCalls, catalog: window.desktopRemoteFixture.catalogCalls, remoteStatus: window.desktopRemoteFixture.remoteStatusCalls, intents: window.desktopRemoteFixture.intentsCalls, runStatus: window.desktopRemoteFixture.runStatusCalls, trace: window.desktopRemoteFixture.traceCalls.length })')
    return { durationSeconds: 60, hidden, before, after, delta: Object.fromEntries(Object.keys(after).map(key => [key, after[key] - before[key]])) }
  }
  const read = (expression) => contents.executeJavaScript(expression)
  const wait = async (expression, label = expression) => {
    const deadline = Date.now() + 7000
    while (!await read(expression)) {
      if (Date.now() > deadline) throw new Error(`Timed out: ${label}; DOM=${await read('JSON.stringify({ focus: document.activeElement?.tagName, selects: [...document.querySelectorAll("select")].map(node => ({value:node.value, options:[...node.options].map(option => ({text:option.text, value:option.value}))})), text: document.body.innerText.slice(-2000), events: window.desktopRemoteFixture.uiEvents })')}`)
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }
  if (options.visibilityPollingCheck) {
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
  const pointFor = (selector, text, captureReceipt = false) => read(`(${pointer.toString()})(${JSON.stringify(selector)}, { text: ${JSON.stringify(text ?? '')}, timeoutMs: 7000, scroll: true, captureReceipt: ${captureReceipt} })`)
  const send = (method, params) => contents.debugger.sendCommand(method, params)
  const click = async (selector, text) => {
    const point = await pointFor(selector, text, true)
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y })
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 })
    await wait('window.__nativeUiPointerReceipt != null', 'native pointer receipt')
    const receipt = await read('window.__nativeUiPointerReceipt')
    check(receipt.trusted && receipt.targetMatched, `Native pointer missed ${selector}: ${JSON.stringify(receipt)}`)
  }
  const key = async (key, code = key, modifiers = 0) => {
    const virtualKey = key === 'Enter' ? 13 : key === 'Escape' ? 27 : key === 'Backspace' ? 8 : key === 'ArrowDown' ? 40 : key === 'ArrowUp' ? 38 : key.length === 1 ? (key.charCodeAt(0) < 128 ? key.toUpperCase().charCodeAt(0) : 0) : undefined
    const nativeVirtualKeyCode = process.platform === 'darwin'
      ? { Enter: 36, Escape: 53, Backspace: 51, ArrowDown: 125, ArrowUp: 126, b: 11, f: 3 }[key]
      : virtualKey
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: virtualKey, nativeVirtualKeyCode, modifiers })
    if (key.length === 1) await send('Input.dispatchKeyEvent', { type: 'char', key, text: key, unmodifiedText: key, windowsVirtualKeyCode: virtualKey, nativeVirtualKeyCode, modifiers })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: virtualKey, nativeVirtualKeyCode, modifiers })
  }
  const insert = (text) => send('Input.insertText', { text })
  const pasteImage = async () => read(`(async () => { const input = document.querySelector('textarea[aria-label="描述任务"]'); const canvas = document.createElement('canvas'); canvas.width = 2; canvas.height = 2; const png = await new Promise(resolve => canvas.toBlob(resolve, 'image/png')); const transfer = new DataTransfer(); transfer.items.add(new File([png], 'pasted.png', { type: 'image/png' })); input.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer })); return true })()`)
  // Native forms submit on Enter's keypress/default action, not keydown alone.
  const formEnter = async () => {
    const event = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: process.platform === 'darwin' ? 36 : 13 }
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...event })
    await send('Input.dispatchKeyEvent', { type: 'char', text: '\r', unmodifiedText: '\r', ...event })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...event })
  }

  const fixture = () => read('window.desktopRemoteFixture')
  const bodyText = () => read('document.body.textContent')

  await wait('document.querySelector(".desktop-remote__host button")?.textContent.includes("启用")', 'disabled host enable action')
  await click('.desktop-remote__host button')
  await wait('document.querySelector(".desktop-remote__invite")?.textContent.includes("scry-desktop1:fixture")', 'enabled host invitation')
  check((await fixture()).hostInviteCalls === 1, 'Host enable dispatched more than one invitation')
  check(await read('document.querySelector(".hosts-add-modal").textContent.includes("新邀请会使旧的未完成邀请失效")'), 'Invitation lost invalidation consequence')
  await click('button[aria-label="关闭 SSH 邀请"]')
  await click('.desktop-remote__host button:last-child')
  await wait('window.desktopRemoteFixture.hostDisableCalls === 1 && !document.querySelector(".desktop-remote__invite")', 'disable clears invitation')

  // Full production App: the remote session uses the same ChatView as local sessions.
  await click('[data-app-fixture]')
  const remoteShown = 'document.querySelector(".execution-location.is-remote") != null'
const sendDisabled = 'document.querySelector(".runtime-composer button.send").disabled'
const composerValue = 'document.querySelector(\'textarea[aria-label="描述任务"]\').value'
await wait('document.querySelector(".sb-remote-proj") != null', 'connected remote project')
check(!(await read('document.querySelector(".sb-hosts")')), 'Legacy hosts navigation remains')

  const scenarioContext = { contents, pointer, capture, options, check, read, wait, pointFor, send, click, key, insert, pasteImage, formEnter, fixture, bodyText, remoteShown, sendDisabled, composerValue }
  let result = await runConversationNavigation(scenarioContext); if (result) return result
  result = await runUnknownReceipt(scenarioContext); if (result) return result
  result = await runStructure(scenarioContext); if (result) return result
  result = await runOpeningControls(scenarioContext); if (result) return result
  result = await runOpeningBench(scenarioContext); if (result) return result
  result = await runSettings(scenarioContext); if (result) return result
  Object.assign(scenarioContext, await runPostSettings(scenarioContext))
  result = await runComposerHistory(scenarioContext); if (result) return result
  result = await runPostComposer(scenarioContext); if (result) return result
  result = await runLifecycle(scenarioContext); if (result) return result
  result = await runParity(scenarioContext); if (result) return result
  Object.assign(scenarioContext, await runDefaultStageA(scenarioContext))
  Object.assign(scenarioContext, await runDefaultStageB(scenarioContext))
  return runDefaultStageC(scenarioContext)
}
const scenarioSource = [
  runConversationNavigation, runUnknownReceipt, runStructure, runOpeningControls,
  runOpeningBench, runSettings, runPostSettings, runComposerHistory, runPostComposer,
  runLifecycle, runParity, runDefaultStageA, runDefaultStageB, runDefaultStageC
].map(fn => fn.toString()).join('\n')
await runDesktopRemoteSmoke({ root, temp, fixtureSource, exercise, scenarioSource, nativeUiPointer, stopOwnedApp, negativeControl, negativeMachineControl, negativeAddressControl, negativeHoverControl, negativeActivityControl, negativeWorkspaceControl, negativePromptControl, negativeSettingsControl, negativeSlashControl, negativeHistorySlashControl, negativeProviderRevisionControl, negativeVisibilityControl, negativeUnknownReceiptControl, unknownReceiptOnly, settingsOnly, parityOnly, composerHistoryOnly, lifecycleOnly, conversationNavigationOnly, openingOnly, structureOnly, measureOpening, visibilityPollingBaseline, visibilityPollingCheck, keepArtifacts })
