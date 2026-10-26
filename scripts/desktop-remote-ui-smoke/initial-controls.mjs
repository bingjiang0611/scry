export async function runInitialControls({ click, wait, check, fixture, read }, options) {
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
