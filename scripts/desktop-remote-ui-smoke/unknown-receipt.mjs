export async function runUnknownReceipt({ driver, options }) {
  const { click, wait, read, check, insert, pasteImage, capture, fixture, sendDisabled, composerValue } = driver
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
