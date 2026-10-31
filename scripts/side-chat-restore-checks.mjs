import { CHILD_PANEL, json, sideChatDriver } from './side-chat-driving.mjs'

/** The row a user selects to go back to the parent: the one that owns the side-chat count. */
const PARENT_ROW = `[...document.querySelectorAll('.sb-sess')].filter(node =>
  node.textContent.includes('side chat parent turn') && node.querySelector('[data-side-chat-count]') != null)`

/** Exact native provenance: provider, profile, workspace and native session together. */
const sameNativeSource = (left, right) => left != null && right != null &&
  left.providerId === right.providerId && (left.agentProfileId ?? null) === (right.agentProfileId ?? null) &&
  left.cwd === right.cwd && left.nativeSessionId === right.nativeSessionId

/**
 * Re-navigation after other parents and a deleted source were used.
 *
 * The parent can be shown as a Provider session row or as the managed conversation that
 * owns that native session; either way the user selects the row that owns the side-chat
 * count and expects the shipped history dialog to list the child. The scope the dialog
 * really asks for is read from the host's own IPC log, and the child is only accepted
 * under an identity that really owns its frozen source: the exact
 * provider/profile/workspace/native-session tuple, or the conversation that owns that
 * exact tuple through its own binding. No title, row order or warm retained tab decides it.
 */
export async function exerciseSideChatRestore({ cdp, evaluate, check, ipcCountsPath, inputsPath, callsPath,
  rendererFailures = [], childId }) {
  const driver = sideChatDriver({ cdp, evaluate, check, ipcCountsPath, inputsPath, callsPath, rendererFailures,
    label: 'Side-chat restore' })
  const { capture, clickAt, idle, wait } = driver
  const allRows = () => evaluate(
    `[...document.querySelectorAll('.sb-sess')].map(node => [node.dataset.conversationId ?? null, node.textContent.slice(0, 40)])`)
  const parentRows = await evaluate(`(() => ${PARENT_ROW}.map(node => ({
    conversationId: node.dataset.conversationId ?? null, provider: node.dataset.provider ?? null,
    count: node.querySelector('[data-side-chat-count]')?.dataset.sideChatCount ?? null,
    text: node.textContent.slice(0, 60) })))()`)
  // Two rows claiming the same source would make "the parent row" ambiguous; zero means the
  // user cannot get back to this parent at all. Both are findings, not something to skip.
  check(parentRows.length === 1,
    `exactly one sidebar row must own the parent side-chat count: ${json({ parentRows, rows: await allRows() })}`)
  await clickAt(`${PARENT_ROW}[0]`)
  await wait(`${PARENT_ROW}[0]?.classList.contains('active') === true`)
  await idle()
  await driver.showPanel()
  const requestsBefore = driver.sideChatRequests().length
  const tabsBefore = await evaluate(`[...document.querySelectorAll('[data-side-chat-tab-id]')].map(node => node.dataset.sideChatTabId)`)
  // The history dialog is the shipped way back; a retained tab is not allowed to short
  // circuit it, because a user who navigated away has only this path.
  await driver.openChildFromHistory(childId)
  // Opening the history dialog is not a cleanup: the tabs that were open must still be
  // open, or the layout a restart has to prove would be destroyed by reading it.
  const tabsAfter = await evaluate(`[...document.querySelectorAll('[data-side-chat-tab-id]')].map(node => node.dataset.sideChatTabId)`)
  check(tabsBefore.every(id => tabsAfter.includes(id)),
    `opening the shipped history action must not close a tab: ${json({ tabsBefore, tabsAfter })}`)
  const requests = driver.sideChatRequests().slice(requestsBefore)
  check(requests.length >= 1,
    `re-opening the parent must ask the host for its side-chat scope: ${json({ parentRows, rows: await allRows() })}`)
  // The log records each request and its answer; the scope is the request line.
  const requested = requests.filter(entry => 'source' in entry).at(-1)?.source ?? null
  const owner = await evaluate(`(async () => {
    const child = await window.scry.conversations.read(${json(childId)})
    const row = document.querySelector('.sb-sess.active')
    const conversationId = row?.dataset.conversationId ?? null
    const conversation = conversationId ? await window.scry.conversations.read(conversationId).then(page => ({
      id: page.summary.id, cwd: page.summary.cwd ?? null,
      bindings: page.bindings.map(binding => ({ providerId: binding.providerId,
        agentProfileId: binding.agentProfileId ?? null, nativeSessionId: binding.nativeSessionId ?? null })) }),
      error => ({ error: String(error) })) : null
    return { source: child.sideChat?.source ?? null, conversation }
  })()`)
  const source = owner.source
  // The conversation that names the source is only an owner when its own binding carries
  // that exact native tuple in that exact workspace; nothing is inferred from a title.
  const conversationOwnsFrozen = source?.kind === 'native-session' && owner.conversation?.cwd === source.cwd &&
    (owner.conversation?.bindings ?? []).some(binding => binding.nativeSessionId === source.nativeSessionId &&
      binding.providerId === source.providerId &&
      (binding.agentProfileId ?? null) === (source.agentProfileId ?? null))
  const owns = requested?.kind === 'native-session'
    ? sameNativeSource(requested, source)
    : requested?.kind === 'conversation' &&
      (requested.conversationId === source?.conversationId ||
        (requested.conversationId === owner.conversation?.id && conversationOwnsFrozen))
  check(owns, `the history request must name the parent that owns the child's frozen source: ${json({
    requested, source, conversation: owner.conversation, parentRows })}`)
  const shown = await evaluate(`(() => {
    const surface = document.querySelector('${CHILD_PANEL} .side-chat-surface')
    const tabs = [...document.querySelectorAll('[data-side-chat-tab-id]')].map(node => node.dataset.sideChatTabId)
    return { id: surface?.dataset.sideChatId ?? null, provider: surface?.querySelector('.runtime-composer .clibtn')?.dataset.agentId ?? null,
      composer: surface?.querySelector('.runtime-composer textarea') != null, tabs }
  })()`)
  check(shown.id === childId, `re-opening the parent showed another child: ${json({ shown, childId })}`)
  check(shown.composer === true, `the re-opened child lost its own composer: ${json(shown)}`)
  check(shown.tabs.includes(childId), `the re-opened child is not a tab of this parent: ${json(shown)}`)
  // The host's own answer for the exact identity the UI asked for, by the child's own id:
  // a parent may own hundreds of children, so the bounded id lookup is the deciding read.
  const listed = await evaluate(`(source => window.scry.conversations.listSideChats({ source, ids: [${json(childId)}] })
    .then(list => ({ total: list.total, ids: list.items.map(item => item.id) }), error => ({ error: String(error) })))(${json(requested)})`)
  check(listed.ids?.includes(childId) === true,
    `the scope the UI asked for does not own the child at the host: ${json({ requested, listed })}`)
  await capture('side-chat-restore-parent')
  return { tabsBefore, tabsAfter, parentRows, requested, parent: { conversationId: owner.conversation?.id ?? null,
    bindings: owner.conversation?.bindings ?? null }, frozenSource: source,
    conversationOwnsFrozen, shown, listed: { total: listed.total } }
}
