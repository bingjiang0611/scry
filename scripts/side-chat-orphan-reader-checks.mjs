import { json, sideChatDriver } from './side-chat-driving.mjs'

/**
 * What a source-less child can still prove about its frozen body and its own controls.
 *
 * This runs after the source parent was really deleted, on the child opened as the main
 * view. The page comes from the child's sealed artifact, so a page that reads after the
 * delete is evidence the body is child-owned rather than a leftover source read. The
 * surface itself no longer offers a reader dialog (owner decision 2026-11-09), so this
 * reads the same sealed page through the typed API instead of a removed control.
 */
export async function exerciseSideChatOrphanReader({ cdp, evaluate, check, ipcCountsPath, inputsPath, callsPath,
  rendererFailures = [], orphanChild, hostAgent, draft, expectedMessages }) {
  const { driver, click, clickAt, idle, wait, counts, since } = sideChatDriver({ cdp, evaluate, check,
    ipcCountsPath, inputsPath, callsPath, rendererFailures, label: 'Side-chat orphan reader' })
  const readCounts = () => counts()

  // The frozen body is still read from the child's own sealed artifact after the source is gone.
  const beforeRead = readCounts()
  const page = await evaluate(`window.scry.conversations.readSideChatSnapshot(${json(orphanChild)}).then(page => ({
    rows: page.items.length, next: page.nextCursor ?? null,
    text: page.items.map(item => item.text).join(String.fromCharCode(10))
  }))`)
  const reads = since(beforeRead)
  // The whole frozen prefix is inline (a readerless Provider cannot freeze more), so one
  // read must return every frozen message and promise no page it cannot produce.
  check(page.rows === expectedMessages, `the frozen body must keep every message: ${json({ page, expectedMessages })}`)
  check(page.rows <= 40, `one read returned more than one bounded page: ${json({ page })}`)
  check(page.next === null, `a fully inline body must be one complete page: ${json({ page })}`)
  check(page.text.includes('冻结正文'), `the frozen page lost its text: ${json(page.text.slice(0, 200))}`)
  check(!page.text.includes('\uFFFD'), 'the frozen body lost a character')
  check(page.text.includes('🀄️'), 'the frozen body lost its astral-plane emoji')
  check((reads['conversation:readSideChatSnapshot'] ?? 0) === 1,
    `one page must cost one artifact read: ${json(reads)}`)
  check((reads['conversation:read'] ?? 0) === 0,
    `reading a frozen body must not read the source conversation: ${json(reads)}`)
  const afterRead = await evaluate(`document.querySelector('#main-pane .runtime-composer textarea')?.value ?? null`)
  check(afterRead === draft, `the child draft was lost after reading its source: ${json({ afterRead, draft })}`)

  // The child's own runtime control is a child-owned preference, not the host's selection:
  // changing it here must not leak into another conversation, and it comes back with the
  // child after the view is left and reopened.
  const menuOpen = `document.querySelector('.climenu [data-agent-id]') != null`
  const pickOwnAgent = async () => {
    // Opening the Agent picker starts a catalog refresh. The already-closed model
    // picker must not dismiss it when that refresh enters its loading state.
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved',
      ...await driver.pointFor('#main-pane .runtime-composer .clibtn') })
    await click('#main-pane .runtime-composer .clibtn')
    await wait(menuOpen, 10000)
    const options = await evaluate(`[...document.querySelectorAll('.climenu [data-agent-id]')]
      .map(node => node.dataset.agentId).filter(id => id != null && id !== ${json(hostAgent)})`)
    check(options.length > 0, 'Agent menu has no alternative provider')
    const target = options[0]
    await clickAt(`document.querySelector('.climenu [data-agent-id=' + ${json(JSON.stringify(target))} + ']')`)
    await wait(`document.querySelector('#main-pane .runtime-composer .clibtn')?.dataset.agentId === ${json(target)}`)
    return target
  }
  const ownAgent = await pickOwnAgent()
  const chipAgent = await evaluate(`document.querySelector('#main-pane .runtime-composer .clibtn')?.dataset.agentId ?? null`)
  check(ownAgent != null, `the child could not select an agent of its own: ${json({ hostAgent, chipAgent })}`)
  await idle()
  // The child really owns the main pane composer while it is shown as the main variant.
  const childComposer = await evaluate(
    `document.querySelector('#main-pane .runtime-composer textarea')?.value ?? null`)
  check(childComposer === draft, `the child draft is not in its own main composer: ${json({ childComposer, draft })}`)
  await clickAt(`[...document.querySelectorAll('[data-orphan-side-chat-id]')].find(node => node.dataset.orphanSideChatId === ${json(orphanChild)})`)
  await wait(`document.querySelector('#main-pane [data-side-chat-variant="main"]')?.dataset.sideChatId === ${json(orphanChild)}`, 20000)
  await idle()
  const reopenedChild = await evaluate(`(() => ({
    provider: document.querySelector('#main-pane .runtime-composer .clibtn')?.dataset.agentId ?? null,
    draft: document.querySelector('#main-pane .runtime-composer textarea')?.value ?? null
  }))()`)
  check(reopenedChild.provider === ownAgent, `the child lost its own saved provider: ${json({ reopenedChild, ownAgent })}`)
  check(reopenedChild.draft === draft, `the child lost its own draft: ${json(reopenedChild)}`)
  return {
    childId: orphanChild, frozenBody: { rows: page.rows, expectedMessages, next: page.next,
      reads: reads['conversation:readSideChatSnapshot'] ?? 0 },
    hostAgent, ownAgent, reopenedChild
  }
}
