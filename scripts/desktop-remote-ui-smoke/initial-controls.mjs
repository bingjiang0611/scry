export async function runInitialControls({ contents, click, wait, check, fixture, read }, options) {
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
  check(await read('window.scry.workspaceSelection.read({ cwd: "/fixture/pinned", kind: "branches" }).then(result => result.status === "unavailable")'),
    'Offline Full App must expose workspace selection as unavailable, not a missing bridge')
  if (options.conversationNavigationOnly) {
    contents.getOwnerBrowserWindow().setContentSize(1200, 900)
    await wait('innerWidth === 1200 && innerHeight === 900 && !document.querySelector(".app.narrow-single-column")', 'wide conversation layout')
    await wait('document.querySelector("[data-conversation-id=navigation-conversation]") != null', 'logical conversation catalog')
    await click('[data-conversation-id=navigation-conversation]')
    await wait('document.querySelectorAll(".transcript-turn").length === 40', 'production ConversationView history')
    await wait('document.querySelector(".chat-transcript").scrollHeight - document.querySelector(".chat-transcript").scrollTop - document.querySelector(".chat-transcript").clientHeight < 2', 'logical conversation opens at bottom')
    const activateTurn = async () => {
      // In single-column layout, returning to the timeline hides the overview.
      if (!await read('document.querySelector(".app.has-right-panel:not(.right-panel-hidden)") != null')) {
        await click('button[aria-label="右侧工作区"]')
      }
      await wait('document.querySelector(".app.has-right-panel:not(.right-panel-hidden)") != null', 'logical overview revealed')
      await wait('[...document.querySelectorAll("#right-surface-pane .turn-call-open")].some(button => button.textContent === "T05")', 'logical overview contains target turn')
      await click('#right-surface-pane .turn-call-open', 'T05')
    }
    await activateTurn()
    const aligned = `(() => {
      const prompt = document.querySelector('[data-run-id="conversation-run-4"] .turn-user')
      const chat = document.querySelector('.chat-transcript')
      const promptTop = prompt?.getBoundingClientRect().top
      const chatTop = chat?.getBoundingClientRect().top
      window.desktopRemoteFixture.navigationGeometry = {
        targetFound: !!prompt, targetInChat: !!chat?.contains(prompt),
        scrollers: document.querySelectorAll('.chat-transcript').length,
        promptTop, chatTop, scrollTop: chat?.scrollTop,
        scrollHeight: chat?.scrollHeight, clientHeight: chat?.clientHeight,
        highlightedRun: document.querySelector('.turn-jump-target')?.dataset.runId,
        viewport: [innerWidth, innerHeight, devicePixelRatio]
      }
      return !!prompt && !!chat && Math.abs(promptTop - chatTop - 16) < 2
    })()`
    await wait(aligned, 'logical conversation overview navigates to prompt, not bottom')
    check(await read('!document.querySelector(".app").classList.contains("right-panel-hidden")'), 'Wide navigation must keep the overview beside the timeline')
    await read('document.querySelector(".chat-transcript").scrollTop += 100')
    await activateTurn()
    await wait(aligned, 'repeat logical conversation navigation')
    await read('document.querySelector("[data-run-id=conversation-run-3]").style.minHeight = "1800px"')
    await wait(aligned, 'logical conversation keeps target through layout changes')
    await wait('!document.querySelector(".turn-jump-target")', 'logical navigation highlight expires')
    await wait(aligned, 'logical conversation does not resume old bottom-follow intent')
    await activateTurn()
    await wait('document.querySelector(".turn-jump-target") != null', 'navigation anchor active before delayed frame')
    await wait(aligned, 'navigation aligned before delayed frame')
    await read(`(() => {
      const request = window.requestAnimationFrame.bind(window)
      const cancel = window.cancelAnimationFrame.bind(window)
      const pending = new Map()
      window.requestAnimationFrame = callback => {
        const id = request(time => pending.set(id, () => callback(time)))
        return id
      }
      window.cancelAnimationFrame = id => { pending.delete(id); cancel(id) }
      window.__navigationFrames = {
        pending,
        restore: () => {
          window.requestAnimationFrame = request
          window.cancelAnimationFrame = cancel
          for (const callback of pending.values()) request(callback)
          delete window.__navigationFrames
        }
      }
      document.querySelector('[data-run-id="conversation-run-3"]').style.minHeight = '2100px'
    })()`)
    try {
      await wait('window.__navigationFrames.pending.size > 0', 'layout alignment frame queued')
      await wait('!document.querySelector(".turn-jump-target")', 'highlight expires with an alignment frame pending')
      await wait(aligned, 'pending layout alignment settles before navigation expires')
    } finally {
      await read('window.__navigationFrames.restore()')
    }
    contents.getOwnerBrowserWindow().setContentSize(1024, 653)
    await wait('document.querySelector(".app.narrow-single-column") != null', 'narrow desktop layout')
    await activateTurn()
    await wait(aligned, 'narrow overview reveals and aligns the conversation prompt')
    check(await read('document.querySelector(".chat-transcript").clientHeight > 0 && document.querySelector(".app").dataset.narrowPane === "main" && document.activeElement === document.querySelector(".chat-transcript")'), 'Narrow navigation must reveal the timeline')
    contents.getOwnerBrowserWindow().setContentSize(1200, 900)
    await wait('innerWidth === 1200 && !document.querySelector(".app.narrow-single-column")', 'wide conversation restored')
    await activateTurn()
    await click('#right-surface-pane button[aria-label="最大化右侧工作区"]')
    await wait('document.querySelector(".app.right-panel-maximized") != null', 'overview maximized')
    await activateTurn()
    await wait(aligned, 'maximized overview reveals the conversation prompt')
    check(await read('document.querySelector(".chat-transcript").clientHeight > 0 && document.activeElement === document.querySelector(".chat-transcript")'), 'Maximized navigation must reveal and focus the timeline')
    return { conversationNavigation: { productionApp: true, overviewTurnId: true, virtualRows: true, repeatActivation: true, layoutAnchor: true, bottomFollowReleased: true, pendingFrameAtExpiry: true, narrowLayout: true, maximizedPanel: true }, nativeCoordinateInput: true }
  }
}
