export async function runConversationNavigation(ctx) {
  const { options, read, wait, click } = ctx
if (options.conversationNavigationOnly) {
    await wait('document.querySelector("[data-conversation-id=navigation-conversation]") != null', 'logical conversation catalog')
    await click('[data-conversation-id=navigation-conversation]')
    await wait('document.querySelectorAll(".transcript-turn").length === 40', 'production ConversationView history')
    await wait('document.querySelector(".chat-transcript").scrollHeight - document.querySelector(".chat-transcript").scrollTop - document.querySelector(".chat-transcript").clientHeight < 2', 'logical conversation opens at bottom')
    if (!await read('document.querySelector("#right-surface-pane .turn-call-open")?.getBoundingClientRect().width > 0')) {
      await click('button[aria-label="右侧工作区"]')
    }
    await wait('[...document.querySelectorAll("#right-surface-pane .turn-call-open")].some(button => button.textContent === "T05")', 'logical overview contains target turn')
    await click('#right-surface-pane .turn-call-open', 'T05')
    const aligned = `(() => { const prompt = document.querySelector('[data-run-id="conversation-run-4"] .turn-user'); return prompt && Math.abs(prompt.getBoundingClientRect().top - document.querySelector('.chat-transcript').getBoundingClientRect().top - 16) < 2; })()`
    await wait(aligned, 'logical conversation overview navigates to prompt, not bottom')
    await read('document.querySelector(".chat-transcript").scrollTop += 100')
    await click('#right-surface-pane .turn-call-open', 'T05')
    await wait(aligned, 'repeat logical conversation navigation')
    await read('document.querySelector("[data-run-id=conversation-run-3]").style.minHeight = "1800px"')
    await wait(aligned, 'logical conversation keeps target through layout changes')
    await wait('!document.querySelector(".turn-jump-target")', 'logical navigation highlight expires')
    await wait(aligned, 'logical conversation does not resume old bottom-follow intent')
    return { conversationNavigation: { productionApp: true, overviewTurnId: true, virtualRows: true, repeatActivation: true, layoutAnchor: true, bottomFollowReleased: true }, nativeCoordinateInput: true }
  }

}
export async function runUnknownReceipt(ctx) {
  const { capture, options, check, read, wait, send, click, insert, pasteImage, fixture, sendDisabled, composerValue } = ctx
if (options.unknownReceiptOnly) {
    await click('[data-remote-session="old-native"]')
    await wait('document.querySelector(".composer-notice")?.textContent.includes("/fixture/project-b")', 'cross-project unknown receipt notice')
    await click('[data-remote-session="other-native"]')
    await wait('document.querySelector(".composer-notice")?.textContent.includes("/fixture/project-b")', 'unknown receipt notice survives session switch')
    await click('textarea[aria-label="描述任务"]')
    await insert('draft held by unknown receipt')
    await pasteImage()
    await wait('document.querySelector(".draft-attachments img")?.naturalWidth === 2', 'blocked draft image preview')
    check(await read(sendDisabled), 'Unknown receipt enabled send')
    check(await read(`${composerValue} === "draft held by unknown receipt"`), 'Unknown receipt discarded the draft')
    await capture('unknown-receipt-blocked')
    await read('window.desktopRemoteFixture.resolveFailure = "generic"')
    await click('.composer-notice button', '核对并解除阻塞')
    await wait('document.querySelector(".composer-notice")?.textContent.includes("解除未知提交失败")', 'failed recovery remains actionable')
    check(await read(sendDisabled), 'Failed unknown recovery enabled send')
    await read('window.desktopRemoteFixture.resolveFailure = null')
    await click('.composer-notice button', '核对并解除阻塞')
    if (options.negativeUnknownReceiptControl) {
      await wait('document.querySelector(".composer-notice")?.textContent.includes("版本过旧")', 'old host recovery guidance')
      check(await read(sendDisabled), 'Old host unknown recovery enabled send')
      check(await read('window.desktopRemoteFixture.intent?.status === "unknown"'), 'Old host recovery discarded unknown evidence')
    } else {
      await wait('!document.querySelector(".composer-notice")?.textContent.includes("提交回执未知")', 'explicit recovery clears blocker')
    }
    const recovered = await fixture()
    check(recovered.resolveIntentCalls.length === 2 && recovered.resolveIntentCalls.every(call => call.intentId === 'unknown-original-id'), 'Recovery did not use the original receipt id')
    check(recovered.submitInputs.length === 0, 'Recovery replayed the prompt')
    check(recovered.stopCalls.length === 0, 'Recovery stopped a received active task')
    check(await read(`${composerValue} === "draft held by unknown receipt"`), 'Recovery discarded the draft')
    check(await read('document.querySelector(".draft-attachments img")?.naturalWidth === 2'), 'Recovery discarded the draft image')
    await capture(options.negativeUnknownReceiptControl ? 'unknown-receipt-old-host' : 'unknown-receipt-recovered')
    return { unknownReceipt: { crossProjectNotice: true, draftAndImagePreserved: true, explicitOriginalIdRecovery: true, noReplayOrStop: true, failedRecoveryActionable: true, outcome: options.negativeUnknownReceiptControl ? 'old-host-unavailable' : 'received-active' }, nativeCoordinateInput: true }
  }

}
export async function runStructure(ctx) {
  const { contents, capture, options, check, read, wait, send, click, insert, remoteShown } = ctx
if (options.structureOnly) {
    const remotePanel = '#remote-right-surface-pane'
    let accept = false
    const dialogs = []
    const dialogHandler = (_event, method, params) => {
      if (method !== 'Page.javascriptDialogOpening') return
      dialogs.push(params)
      void send('Page.handleJavaScriptDialog', { accept })
    }
    await send('Page.enable')
    contents.debugger.on('message', dialogHandler)
    try {
      await read('window.structureEntries = []; window.structureNativeCalls = 0; const animate = Element.prototype.animate; Element.prototype.animate = function(frames, options) { if (this.matches(".main-content")) window.structureEntries.push(options.duration); return animate.call(this, frames, options) }; document.startViewTransition = () => { window.structureNativeCalls++; throw new Error("Native capture forbidden") }; undefined')
      for (const theme of ['light', 'dark']) {
        await read('document.documentElement.dataset.theme = ' + JSON.stringify(theme))
        await click('[data-remote-session="old-native"]')
        await wait(remoteShown, 'remote context selected')
        await wait('document.querySelector(".chat")?.textContent.includes("Remote history paragraph 79")', 'remote history loaded')
        if (await read('document.querySelector(".panel-pill:not(.summary-pill)").getAttribute("aria-pressed") !== "true"')) await click('.panel-pill:not(.summary-pill)')
        await wait('document.querySelector("#remote-right-surface-pane").getBoundingClientRect().width > 0', 'remote pane visible')
        await click(remotePanel + ' button[aria-label="添加 Surface"]')
        await click(remotePanel + ' [role=menuitem]', '文件')
        await wait(`document.querySelector('${remotePanel} [data-workspace-path="notes.txt"]') != null`, 'editable host file tree')
        await click(remotePanel + ' [data-workspace-path="notes.txt"]')
        await wait('document.querySelector("#remote-right-surface-pane textarea")?.value === "original remote file"', 'host file content')
        await click(remotePanel + ' textarea'); await insert(' unsaved remote edit')
        await wait('document.querySelector("#remote-right-surface-pane .workspace-editorbar .primary")?.disabled === false', 'dirty remote file')
        await read('Promise.allSettled(document.getAnimations().filter(a => a.id === "scry-structure" || a.id === "scry-pane").map(a => a.finished)).then(() => true)')
        const before = await read('window.structureEntries.length')
        const count = dialogs.length
        accept = false
        await click('.sb-nav .sb-navitem:first-child')
        check(dialogs.length === count + 1 && dialogs.at(-1).message.includes('远程文件'), 'Native confirmation did not precede remote navigation')
        check(await read('window.structureEntries.length') === before, 'Cancelled remote navigation started an entrance')
        check(await read(remoteShown + ' && document.querySelector("#remote-right-surface-pane textarea").value.includes("unsaved remote edit")'), 'Cancel discarded remote selection or edit')
        await capture('structure-remote-' + theme + '-cancelled')
        accept = true
        await click('.sb-nav .sb-navitem:first-child')
        await wait('document.querySelector(".usage-page") != null', 'confirmed remote navigation')
        check(await read('window.structureEntries.length') > before, 'Confirmation positive control has no page entrance')
        await capture('structure-remote-' + theme)
      }
      check(await read('window.structureNativeCalls === 0 && window.desktopRemoteFixture.localWorkspaceCalls.length === 0 && window.desktopRemoteFixture.workbenchCalls.every(call => call.request.method !== "workspaceWrite")'), 'Remote structure used native capture, local fallback or a write')
      return { remoteStructure: { themes: ['light', 'dark'], realDialogConfirmBeforeEntry: true, cancelNoTransition: true, cancelKeepsEdit: true, acceptNavigates: true, hostScopedFileTransport: true, noWriteOrLocalFallback: true } }
    } finally { contents.debugger.removeListener('message', dialogHandler) }
  }

}
export async function runOpeningControls(ctx) {
  const { options, check, read, wait, send, click, key, insert, fixture, sendDisabled } = ctx
if (options.openingOnly || options.measureOpening) {
  // Selected controls are demand-loaded. A delayed response for a previous
  // session Provider must not publish after the user switches context.
  await read('window.desktopRemoteFixture.holdProviderControls = true')
  await click('[data-remote-session="other-native"]')
  await wait('window.desktopRemoteFixture.providerControlsCalls.some(call => call.context.providerId === "qoder")', 'selected Beta controls request')
  await click('[data-remote-session="old-native"]')
  await wait('window.desktopRemoteFixture.providerControlsCalls.some(call => call.context.providerId === "claude")', 'selected Alpha controls request after switch')
  await read('window.desktopRemoteFixture.providerControlWaiters.shift()()')
  await wait('window.desktopRemoteFixture.providerControlsCalls.at(-1)?.context.providerId === "claude"', 'selected Alpha context after switch')
  check(!await read('document.querySelector(".chat")?.textContent.includes("Beta Default")'), 'Stale Provider controls were published')
  await read('window.desktopRemoteFixture.holdProviderControls = false; window.desktopRemoteFixture.providerControlWaiters.splice(0).forEach(resolve => resolve())')
  await wait('document.querySelector(".model-effort-model")?.textContent === "claude / Alpha Default"', 'selected controls settle after stale switch')
  await read('window.desktopRemoteFixture.providerControlsFailure = "unavailable"')
  await click('[data-remote-session="other-native"]')
  await wait('document.querySelector(".composer-notice")?.textContent.includes("未能读取所选 Provider")', 'unavailable controls are visible')
  await click('textarea[aria-label="描述任务"]'); await insert('control-load-check')
  check(await read(sendDisabled), 'Unavailable controls enabled send')
  await read('window.desktopRemoteFixture.providerControlsFailure = null')
  await click('.composer-notice button')
  await wait('!document.querySelector(".runtime-composer button.send").disabled', 'explicit controls retry restores send')
  await read('document.querySelector(\'textarea[aria-label="描述任务"]\').select()'); await key('Backspace')
  const beforeLegacy = (await fixture()).providerControlsCalls.length
  await read('window.desktopRemoteFixture.legacyProviderHost = true')
  await wait('document.querySelector(".composer-notice")?.textContent.includes("旧版主机能力快照")', 'negotiated legacy snapshot is labelled')
  await click('textarea[aria-label="描述任务"]'); await insert('legacy-control-check')
  await wait('!document.querySelector(".runtime-composer button.send").disabled', 'legacy host preserves its existing send contract')
  check((await fixture()).providerControlsCalls.length === beforeLegacy, 'Legacy host received a selected-controls query')
  await read('document.querySelector(\'textarea[aria-label="描述任务"]\').select()'); await key('Backspace')
  await read('window.desktopRemoteFixture.legacyProviderHost = false')
  await wait('window.desktopRemoteFixture.providerControlsCalls.length > ' + beforeLegacy, 'new-host selected lookup resumes after negotiation')
  await wait('document.querySelector(".model-effort-model")?.textContent === "qoder / Beta Default"', 'new-host controls restored')
  if (options.openingOnly) {
  check(!await read('document.querySelector(".composer-notice")'), 'Successful controls still show the host-read banner')
  const beforeMetadataRefresh = (await fixture()).providerControlsCalls.length
  await read('window.desktopRemoteFixture.providerControlsObservedAt += 1000; window.desktopRemoteFixture.providerMetadataRevision += 1')
  await wait('window.desktopRemoteFixture.providerControlsCalls.length > ' + beforeMetadataRefresh, 'same-context metadata invalidates selected controls')
  await wait('document.querySelector(".model-effort-model")?.textContent === "qoder / Beta Default" && !document.querySelector(".composer-notice")', 'selected controls refresh without the removed banner')
  check(await read('document.querySelector(".model-effort-model")?.textContent === "qoder / Beta Default"'), 'Refresh silently changed selected model')
  await click('textarea[aria-label="描述任务"]'); await insert('same-context-observation')
  await wait('!document.querySelector(".runtime-composer button.send").disabled', 'known selected snapshot can send')
  await read('window.desktopRemoteFixture.providerControlsFailure = "throw"; window.dispatchEvent(new Event("focus"))')
  await wait('document.querySelector(".composer-notice")?.textContent.includes("未能读取所选 Provider")', 'failed reread discards old successful catalog')
  check(await read(sendDisabled), 'Failed reread silently reused old controls')
  await read('window.desktopRemoteFixture.providerControlsFailure = null')
  await click('.composer-notice button')
  await wait('!document.querySelector(".runtime-composer button.send").disabled', 'same-context retry restores valid choices')
  await read('document.querySelector(\'textarea[aria-label="描述任务"]\').select()'); await key('Backspace')
  const beforeFocus = (await fixture()).providerControlsCalls.length
  check(await read('document.visibilityState === "visible"'), 'Focus control requires unchanged visible state')
  await read('window.dispatchEvent(new Event("focus"))')
  await wait('window.desktopRemoteFixture.providerControlsCalls.length > ' + beforeFocus, 'visible window focus rereads selected controls')
  await wait('!document.querySelector(".composer-notice")', 'focused controls settle without the removed banner')
  const beforeHidden = (await fixture()).providerControlsCalls.length
  const catalogBeforeHidden = (await fixture()).catalogCalls
  await read('Object.defineProperty(document, "hidden", { configurable: true, get: () => true }); Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" }); document.dispatchEvent(new Event("visibilitychange")); window.desktopRemoteFixture.providerMetadataRevision += 1')
  await wait('document.hidden && document.visibilityState === "hidden"', 'consistent hidden document state')
  check((await fixture()).catalogCalls === catalogBeforeHidden, 'Hidden composer polled metadata')
  check((await fixture()).providerControlsCalls.length === beforeHidden, 'Hidden composer initialized a Provider')
  await read('delete document.hidden; delete document.visibilityState; document.dispatchEvent(new Event("visibilitychange"))')
  await wait('window.desktopRemoteFixture.catalogCalls > ' + catalogBeforeHidden, 'visible composer catches up metadata')
  await wait('window.desktopRemoteFixture.providerControlsCalls.length > ' + beforeHidden, 'visible composer reobserves its selected controls')
  }
  await click('.sb-new')
  await wait('document.querySelector(".location-button") != null', 'new remote draft after stale switch')
  }

}
