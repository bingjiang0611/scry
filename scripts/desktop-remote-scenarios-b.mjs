export async function runOpeningBench(ctx) {
  const { options, check, read, wait, pointFor, send, click, insert, fixture } = ctx
if (options.openingOnly || options.measureOpening) {
    const bottom = '(() => { const el = document.querySelector(".chat"); return el && el.scrollHeight - el.scrollTop - el.clientHeight <= 2 })()'
    const samples = []
    const wheelUp = async () => {
      const point = await pointFor('.chat')
      await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: point.x, y: point.y, deltaX: 0, deltaY: -10000 })
      await wait('document.querySelector(".chat").scrollTop < document.querySelector(".chat").scrollHeight - document.querySelector(".chat").clientHeight - 64', 'native upward scroll leaves latest')
    }
    for (let index = 0; index < 5; index++) {
      if (index > 0) await wheelUp()
      const before = await fixture()
      await read('window.openingPreviousChat = document.querySelector(".chat"); window.openingStartedAt = performance.now()')
      const session = index % 2 ? 'other-native' : 'old-native'
      await click(`[data-remote-session="${session}"]`)
      await wait('document.querySelector(".chat") !== window.openingPreviousChat && document.querySelector(".chat")?.textContent.includes("Remote history paragraph 79")', 'bounded remote history renders')
      await read('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
      const elapsedMs = await read('performance.now() - window.openingStartedAt')
      const after = await fixture()
      samples.push({ elapsedMs, historyRequests: after.historyCalls.length - before.historyCalls.length,
        commandRequests: after.commandCalls.length - before.commandCalls.length, catalogRequests: after.catalogCalls - before.catalogCalls })
      if (options.openingOnly) {
        await wait(bottom, 'each selected remote session opens at the latest message')
      }
    }
    if (options.openingOnly) {
      check(samples.every(sample => sample.commandRequests === 0), 'Opening history eagerly queried Provider commands')
      await read('window.desktopRemoteFixture.holdHistory = true')
      await click('[data-remote-session="other-native"]')
      await wait('typeof window.releaseHistory === "function"', 'history request held in flight')
      check(!await read('document.querySelector(".chat").textContent.includes("Remote history paragraph 79")'), 'Previous history leaked into the loading context')
      await read('window.desktopRemoteFixture.holdHistory = false; window.releaseHistory(); delete window.releaseHistory')
      await wait('document.querySelector(".chat").textContent.includes("Remote history paragraph 79")', 'delayed history resolves')
      await wait(bottom, 'delayed history opens at bottom')
      await read('const extra = document.createElement("div"); extra.dataset.openingResize = "true"; extra.style.height = "900px"; document.querySelector(".chat").append(extra)')
      await wait(bottom, 'late history layout remains at bottom')
      await wheelUp()
      const position = await read('document.querySelector(".chat").scrollTop')
      await read('document.querySelector("[data-opening-resize]").style.height = "1200px"')
      await read('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
      check(await read(`Math.abs(document.querySelector(".chat").scrollTop - ${position}) < 2`), 'Remote layout pulled the reader away from older messages')
      await click('textarea[aria-label="描述任务"]'); await insert('/skill')
      await wait('document.querySelector(".slash-item")?.textContent.includes("skill:host-only")', 'slash commands still load on demand')
      check((await fixture()).commandCalls.length === 1, 'Slash query was duplicated across remote opens')
    }
    return { remoteSessionOpening: { samples, nativeSelection: true, nativeScroll: true, bottomChecked: options.openingOnly,
      noLocalExecution: (await fixture()).localStarts === 0, onDemandCommands: options.openingOnly } }
  }

}
export async function runSettings(ctx) {
  const { capture, options, check, read, wait, click, key, insert, fixture, composerValue } = ctx
await click('textarea[aria-label="描述任务"]');
await insert('settings keeps this draft')
await click('.location-button');
await click('.location-menu .mitem', '管理远程访问')
await wait('document.querySelector(".settings-tab.active")?.textContent.includes("远程访问") && document.querySelector(".remote-connections-settings") != null', 'manage hosts opens remote settings directly')
check(await read(`${composerValue} === 'settings keeps this draft'`), 'Opening settings replaced the current draft')
check(await read('document.activeElement === document.querySelector(".settings-tab.active")'), 'Direct settings entry did not focus the remote tab')
if (options.settingsOnly) {
    await wait('document.querySelector(".remote-access-inbound").textContent.includes("Fixture iPhone")', 'phone grant in focused settings')
    await capture('remote-settings-focused')
    await click('.remote-access-header button')
    await wait('document.querySelector(".hosts-add-modal") != null', 'nested add-host dialog')
    await key('Tab')
    check(await read('document.querySelector(".hosts-add-modal").contains(document.activeElement)'), 'Nested dialog lost keyboard focus')
    await key('Escape')
    await wait('!document.querySelector(".hosts-add-modal") && document.querySelector(".settings-modal") != null', 'Escape closes only the nested dialog')
    check(await read('document.activeElement === document.querySelector(".remote-access-header button")'), 'Nested dialog did not restore action focus')
    await click('.remote-access-card:not(.desktop-remote__host) button')
    await wait('document.querySelector(".remote-pairing__qr canvas") != null', 'phone code opens a nested dialog')
    check(await read('document.querySelector(".hosts-add-modal").textContent.includes("2 分钟内有效") && document.querySelector(".hosts-add-modal").textContent.includes("核对连接设备上的公钥指纹")'), 'Phone pairing lost expiry or fingerprint guidance')
    await key('Escape')
    check(await read('document.querySelector(".settings-modal") != null && document.querySelector(".hosts-add-modal")?.closest(".modal-overlay").dataset.state === "exit"'), 'Closing phone code retired the parent or skipped its exit')
    await wait('document.querySelector(".settings-modal") != null && !document.querySelector(".hosts-add-modal")', 'Closing phone code removes only the nested dialog after exit')
    await read('window.desktopRemoteFixture.phoneStatusFailure = true')
    await wait('document.querySelector(".remote-access-inbound").textContent.includes("状态未知") && document.querySelector(".remote-access-inbound").textContent.includes("fixture phone status unavailable")', 'unread phone status stays unknown')
    check(!(await read('document.querySelector(".remote-device-section")')), 'Failed phone read claimed no devices or kept current grants')
    await read('window.desktopRemoteFixture.phoneStatusFailure = false; window.desktopRemoteFixture.relayConfigured = false')
    await wait('document.querySelector(".remote-access-inbound").textContent.includes("中继休眠") && document.querySelector(".remote-device-section") != null', 'dormant phone relay with preserved grants')
    await read('window.desktopRemoteFixture.phoneEnabled = false')
    await wait('document.querySelector(".remote-access-card:not(.desktop-remote__host)").textContent.includes("未启用") && !document.querySelector(".remote-access-card:not(.desktop-remote__host) button")', 'disabled phone access has no pairing action')
    await read('window.desktopRemoteFixture.phoneEnabled = true; window.desktopRemoteFixture.relayConfigured = true')
    await wait('document.querySelector(".remote-access-card:not(.desktop-remote__host)").textContent.includes("中继已配置")', 'phone status recovers')
    return { remoteSettingsInteractions: { directEntryKeepsDraft: true, nestedDialogKeyboard: true, phoneExpiryAndFingerprint: true, phoneUnknownDormantDisabled: true }, nativeCoordinateInput: true }
  }

}
export async function runPostSettings(ctx) {
  const { capture, options, check, read, wait, click, key, insert, fixture, remoteShown } = ctx
await click('.settings-modal .modal-x')
check(await read('document.activeElement === document.querySelector(".location-button")'), 'Closing settings did not return focus to the location picker')
await click('textarea[aria-label="描述任务"]');
await read('document.querySelector(\'textarea[aria-label="描述任务"]\').select()');
await key('Backspace')
const projectOrder = () => read('Array.from(document.querySelectorAll(".sb-proj .pname"), node => node.textContent)')
check(JSON.stringify(await projectOrder()) === JSON.stringify(['Pinned local', 'Recent local', 'Project A', 'Older local', 'Project B']), 'Remote project was appended instead of sorted by recent activity')
check(!(await read('document.querySelector(".sb-remote-proj .sb-running")')), 'Idle remote session appeared active')
if (!options.parityOnly && !options.lifecycleOnly && !options.composerHistoryOnly) {
    // Host-side activity changes while the user stays in the local composer.
    // No explicit refresh: the shared loader must observe starts and stops itself.
    await read('window.desktopRemoteFixture.sessionActive = true; window.desktopRemoteFixture.sessionTs = 1700000002000')
    await wait('document.querySelector(".sb-remote-proj .sb-sess.running .sb-running") != null', 'background remote session shows a running spinner')
    check(JSON.stringify(await projectOrder()) === JSON.stringify(['Pinned local', 'Project A', 'Recent local', 'Older local', 'Project B']), 'Remote activity did not move its project up while preserving local pins')
    check(await read('getComputedStyle(document.querySelector(".sb-remote-proj .sb-running")).animationName === "sb-running-spin"'), 'Remote activity did not reuse the local spinner animation')
    await capture('remote-sidebar-running')
    await click('.sb-view-tabs [role=tab]', '动态')
    await wait('document.querySelector(".sb-activity [data-remote-session=old-native]") != null', 'live remote session appears in activity tab')
    check(await read('document.querySelectorAll(".sb-activity [data-remote-session=old-native]").length === 1'), 'Activity duplicated a remote session')
    check(await read('document.querySelector(".sb-activity [data-activity-group=working] .sb-host-tag")?.textContent === "Fixture desktop"'), 'Activity lost the owning host')
    check(!await read('document.querySelector(".sb-activity .sb-proj-head")'), 'Activity inserted project headers into the flat session list')
    await click('.sb-search input'); await insert('Fixture desktop')
    await wait('document.querySelector(".sb-activity [data-remote-session=old-native]") != null', 'activity searches remote host labels')
    await read('document.querySelector(".sb-search input").select()'); await key('Backspace')
    await click('.sb-activity [data-remote-session="old-native"]')
    await wait(remoteShown, 'activity selection opens the owning remote session')
    check((await fixture()).localStarts === 0 && (await fixture()).submitInputs.length === 0, 'Activity selection executed a turn')
    // The run was started on the host UI: no receipt here, yet the open session follows it.
    await wait('document.querySelector(".chat-transcript")?.textContent.includes("host ui continue")', 'host-started run streams into the opened remote session')
    check((await fixture()).intentsCalls > 0 && (await fixture()).liveRunCalls > 0, 'Foreign run was not discovered through the host live set')
    await capture('remote-activity-tab')
    await read('window.desktopRemoteFixture.catalogFailure = true')
    await wait('!document.querySelector(".sb-activity [data-remote-session=old-native]")', 'failed catalog removes cached live activity')
    await click('.sb-view-tabs [role=tab]', '项目')
    await wait('document.querySelector(".sb-remote-proj .sb-host-tag")?.dataset.state === "unknown"', 'failed catalog read invalidates live activity')
    check(!(await read('document.querySelector(".sb-remote-proj .sb-running")')), 'Stale catalog still claimed a running remote session')
    check(await read('document.querySelector(".sb-remote-proj [data-remote-session=old-native]") != null'), 'Catalog failure discarded remote history')
    const historyReads = (await fixture()).historyCalls.length
    await read('window.desktopRemoteFixture.catalogFailure = false; window.desktopRemoteFixture.sessionActive = false; window.desktopRemoteFixture.hostRunArchived = true')
    await wait('document.querySelector(".sb-remote-proj .sb-host-tag")?.dataset.state === "connected"', 'catalog polling recovers')
    await wait(`window.desktopRemoteFixture.historyCalls.length > ${historyReads} && document.querySelector(".chat-transcript")?.textContent.includes("host ui continue")`, 'ended host run is re-read as history')
    check(!(await read('document.querySelector(".sb-remote-proj .sb-running")')), 'Settled background session retained its spinner')
    await click('.sb-view-tabs [role=tab]', '动态')
    check(!await read('document.querySelector(".sb-activity [data-remote-session]")'), 'Idle remote history was guessed to be completed')
    await click('.sb-navitem', '分析')
    await read('window.desktopRemoteFixture.connected = false; window.refreshFixtureConnections()')
    await wait('!document.querySelector(".sb-activity [data-remote-session]")', 'disconnected activity is not live')
    await read('window.desktopRemoteFixture.sessionLastRunId = "finished-offline"; window.desktopRemoteFixture.sessionLastRunOutcome = "completed"; window.desktopRemoteFixture.connected = true; window.refreshFixtureConnections()')
    await wait('document.querySelector("[data-activity-group=completed] [data-remote-session=old-native] .sb-unread") != null', 'reconnect restores completed remote session with unread result')
    await click('[data-activity-group=completed] [data-remote-session=old-native]')
    await wait(remoteShown, 'completed Activity opens remote session')
    await wait('!document.querySelector("[data-remote-session=old-native] .sb-unread")', 'viewed focused remote result clears unread')
    await read('window.refreshFixtureCatalog()')
    check(!await read('document.querySelector("[data-remote-session=old-native] .sb-unread")'), 'Repeated catalog marked an already-read result')
    await click('.sb-view-tabs [role=tab]', '项目')
  }
const projectAHead = '.sb-proj-head[aria-label="Project A · Fixture desktop · /fixture/project-a"]'
await click(projectAHead)
await wait(`document.querySelector(${JSON.stringify(projectAHead)}).getAttribute('aria-expanded') === 'false'`, 'remote project collapsed')
await click('.sb-search input');
await insert('Project B')
await wait('document.querySelectorAll(".sb-remote-proj").length === 1 && document.querySelector(".sb-remote-proj .pname")?.textContent === "Project B"', 'remote project filtered out')
await read('document.querySelector(".sb-search input").select()');
await key('Backspace')
await wait(`document.querySelector(${JSON.stringify(projectAHead)}) != null`, 'remote project restored after search')
check(await read(`document.querySelector(${JSON.stringify(projectAHead)}).getAttribute('aria-expanded') === 'false'`), 'Search reset remote project collapse state')
await click(projectAHead)
await click('[data-remote-session="old-native"]')
await wait(remoteShown, 'remote history selected for workspace checks')

}
