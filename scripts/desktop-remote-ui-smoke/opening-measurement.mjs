export async function runOpeningMeasurement({ driver, options }) {
  const { read, wait, check, click, key, pointFor, send, fixture, insert } = driver
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
      check(samples.every(sample => sample.historyRequests === 1), 'Opening history issued duplicate reads')
      await read('window.openingPreviousChat = document.querySelector(".chat"); window.openingPreviousSelection = document.querySelector("[data-remote-session][aria-current=true]"); window.desktopRemoteFixture.holdHistory = true')
      await click('[data-remote-session="other-native"]')
      await wait('typeof window.releaseHistory === "function"', 'history request held in flight')
      check(await read('document.querySelector(".chat") === window.openingPreviousChat && document.querySelector("[data-remote-session][aria-current=true]") === window.openingPreviousSelection && document.querySelector(".chat").textContent.includes("Remote history paragraph 79")'), 'Selection or content changed before the target history was ready')
      const pendingReads = (await fixture()).historyCalls.length
      await click('[data-remote-session="other-native"]')
      check((await fixture()).historyCalls.length === pendingReads, 'Repeated selection restarted its pending history read')
      await read('window.desktopRemoteFixture.holdHistory = false; window.releaseHistory(); delete window.releaseHistory')
      await wait('document.querySelector(".chat") !== window.openingPreviousChat && document.querySelector(".chat").textContent.includes("Remote history paragraph 79") && document.querySelector("[data-remote-session=other-native]")?.getAttribute("aria-current") === "true"', 'delayed history and selection publish together')
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
      await read(`window.openingHistory = window.scry.desktopRemote.history;
        window.scry.desktopRemote.history = (...args) => args[1].externalSessionId === 'old-native'
          ? new Promise(resolve => { window.releaseOldOpening = () => window.openingHistory(...args).then(resolve) })
          : window.openingHistory(...args); true`)
      await click('[data-remote-session="old-native"]')
      await wait('typeof window.releaseOldOpening === "function"', 'old selection read pending')
      await click('[data-remote-session="other-native"]')
      await wait('document.querySelector("[data-remote-session=other-native]")?.getAttribute("aria-current") === "true"', 'newer selection wins')
      await read('window.releaseOldOpening()')
      check(await read('document.querySelector("[data-remote-session=other-native]")?.getAttribute("aria-current") === "true" && document.querySelector(".chat").textContent.includes("Remote history paragraph 79")'), 'Late history replaced a newer selection')
      await read(`window.scry.desktopRemote.history = async () => { throw new Error('fixture opening read failed') }; true`)
      await click('[data-remote-session="old-native"]')
      await wait('document.querySelector(".composer-notice.is-error")?.textContent.includes("fixture opening read failed")', 'prepared history error remains visible')
      check(await read('document.querySelector("[data-remote-session=old-native]")?.getAttribute("aria-current") === "true" && document.querySelectorAll(".transcript-turn").length === 0'), 'Failed target displayed previous session content')
      await read('window.scry.desktopRemote.history = window.openingHistory; true')
      await click('[data-remote-session="old-native"]')
      await wait('document.querySelector(".chat").textContent.includes("Remote history paragraph 79") && !document.querySelector(".composer-notice.is-error")', 'explicit selection retries failed history')
    }
    return { remoteSessionOpening: { samples, nativeSelection: true, nativeScroll: true, bottomChecked: options.openingOnly, atomicSelection: options.openingOnly, pendingSupersession: options.openingOnly, preparedFailureVisible: options.openingOnly,
      noLocalExecution: (await fixture()).localStarts === 0, onDemandCommands: options.openingOnly } }
  }
