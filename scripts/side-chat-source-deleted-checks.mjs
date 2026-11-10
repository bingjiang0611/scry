import { json, sideChatDriver } from './side-chat-driving.mjs'

/** Enough completed turns for a real frozen prefix, well inside the readerless budget. */
const PARENT_TURNS = 3
/** More than one child, so "no row" is not an accident of a single record. */
const CHILDREN = 3

/** Short CJK+emoji turn, so the real handoff budget admits every message inline. */
const unicodePrompt = (ordinal) => `side chat note 第 ${ordinal} 轮🙂🀄️ 冻结正文`

/**
 * What deleting the source does to its side chats, in the isolated production App.
 *
 * A side chat lives in its parent's right panel and is never a sidebar row of its own. The
 * source parent is archived and deleted through the shipped fingerprint-preview dialog;
 * afterwards its children must still be real, readable records (deleting a parent is not a
 * silent cascade), and the sidebar must show none of them: no group, no row, no counter,
 * in either sidebar tab.
 */
export async function exerciseSideChatSourceDeleted({ cdp, evaluate, check, ipcCountsPath, inputsPath, callsPath, workspace, rendererFailures = [] }) {
  const {
    capture, click, clickAt, idle, wait, counts, since, conversation, seedTurns
  } = sideChatDriver({ cdp, evaluate, check, ipcCountsPath, inputsPath, callsPath, rendererFailures, label: 'Side-chat source deleted' })

  // A second parent with a short completed transcript of its own.
  const parentId = await evaluate(`window.scry.conversations.create(${json(workspace)}).then(created => created.id)`)
  const prompts = Array.from({ length: PARENT_TURNS }, (_, index) => unicodePrompt(index + 1))
  const seeded = await seedTurns(parentId, prompts)
  check(seeded === PARENT_TURNS, `the source did not record its transcript: ${json({ seeded, expected: PARENT_TURNS })}`)

  // One preview, many children: the frozen prefix does not change while the source is quiet.
  const created = await evaluate(`(async () => {
    const source = { kind: 'conversation', conversationId: ${json(parentId)} }
    const preview = await window.scry.conversations.previewSideChat(source, {})
    const ids = []
    for (let index = 0; index < ${CHILDREN}; index += 1) {
      const child = await window.scry.conversations.createSideChat({
        source, expectedThroughOrdinal: preview.throughOrdinal, expectedThroughRunId: preview.throughRunId,
        expectedPrefixFingerprint: preview.prefixFingerprint, expectedManifestFingerprint: preview.manifestFingerprint,
        commandId: crypto.randomUUID(), initialTarget: preview.target })
      ids.push(child.id)
    }
    return { ids, messageCount: preview.messageCount, inlineCount: preview.coverage.inlineCount,
      retrievableCount: preview.coverage.retrievableCount, budgetBytes: preview.coverage.handoffBudgetBytes }
  })()`)
  check(created.ids.length === CHILDREN, `the parent could not own ${CHILDREN} children: ${json({ created: created.ids.length })}`)
  check(created.messageCount === PARENT_TURNS * 2,
    `the frozen prefix lost messages: ${json({ created, expected: PARENT_TURNS * 2 })}`)
  // Inside the real handoff budget: every frozen message is carried inline, so no reader is
  // pretended to exist and no budget was weakened to reach the second page.
  check(created.retrievableCount === 0 && created.inlineCount === created.messageCount,
    `the fixture must stay inside the real handoff budget: ${json(created)}`)
  await idle()

  // Archive and delete the parent through the real dialog: the preview carries the
  // fingerprint that main re-verifies, so this is the shipped delete path, not an API call.
  const rows = await evaluate(`[...document.querySelectorAll('.sb-sess')].map(row => ({ id: row.dataset.conversationId ?? null, text: row.textContent }))`)
  // The row is selected by its own conversation id: a conversation created through the shipped
  // IPC gets a generic title until the host refreshes its list, so the title is not identity.
  const parentRow = rows.findIndex(row => row.id === parentId)
  check(parentRow >= 0, `the source is not listed in the sidebar: ${json(rows.map(row => row.text))}`)
  await clickAt(`[...document.querySelectorAll('.sb-sess')][${parentRow}]`)
  await wait(`document.querySelector('#main-pane .chat-body') != null`)
  // The management actions are disabled until this conversation's own page is loaded; a
  // click on a disabled button would silently do nothing, so wait for the real enable.
  await wait(`(() => { const button = document.querySelector('#main-pane [aria-label="存档统一对话"]'); return button != null && button.disabled === false })()`, 30000)
  await idle()
  await click('#main-pane .conversation-options > summary')
  await wait(`document.querySelector('#main-pane [aria-label="存档统一对话"]') != null`)
  const beforeDelete = counts()
  await click('#main-pane [aria-label="存档统一对话"]')
  await wait(`document.querySelector('#main-pane [aria-label="删除统一对话"]') != null`, 15000)
  await click('#main-pane [aria-label="删除统一对话"]')
  await wait(`document.querySelector('.unified-delete') != null`, 15000)
  await wait(`document.querySelector('.unified-delete li') != null`, 15000)
  const preview = await evaluate(`(() => ({
    title: document.querySelector('.unified-delete h2')?.textContent ?? null,
    targets: [...document.querySelectorAll('.unified-delete li')].map(node => node.textContent.trim()),
    confirm: [...document.querySelectorAll('.unified-delete .unified-actions button')].map(node => node.textContent.trim())
  }))()`)
  check(preview.targets.length > 0, `the delete preview showed no fingerprint scope: ${json(preview)}`)
  check(preview.targets.every(target => target.length > 0), `the delete preview lost its provider scope: ${json(preview)}`)
  check(preview.confirm.some(label => label.includes('确认删除')), `the preview never offered a confirmed delete: ${json(preview)}`)
  await capture('source-delete-preview')
  await clickAt(`[...document.querySelectorAll('.unified-delete .unified-actions button')].find(node => node.textContent.includes('确认删除'))`)
  await wait(`document.querySelector('.unified-delete')?.textContent.includes('逻辑入口已删除') || document.querySelector('.unified-delete')?.textContent.includes('未完整删除')`, 30000)
  const receipt = await evaluate(`document.querySelector('.unified-delete')?.textContent ?? null`)
  check(receipt != null && receipt.includes('逻辑入口已删除'), `the delete did not report a committed result: ${json(receipt)}`)
  await capture('source-delete-result')
  await clickAt(`[...document.querySelectorAll('.unified-delete .unified-actions button')].find(node => node.textContent.trim() === '关闭')`)
  await idle()
  const deletions = since(beforeDelete)
  check((deletions['conversation:delete'] ?? 0) === 1, `one confirmed delete must dispatch once: ${json(deletions)}`)
  check((deletions['conversation:previewDeletion'] ?? 0) >= 1, `the delete ran without its fingerprint preview: ${json(deletions)}`)

  // The source keeps only its minimal ownership record: the logical entry is deleted, so the
  // page has no turns and reports the deletion instead of pretending to be readable.
  const sourceAfterDelete = await evaluate(`window.scry.conversations.read(${json(parentId)}).then(
    page => ({ status: page.summary.deletion?.status ?? null, turns: page.turns.length }),
    error => ({ status: 'unreadable', error: String(error) }))`)
  check(sourceAfterDelete.status === 'complete' && sourceAfterDelete.turns === 0,
    `the deleted source must be a deleted record with no body: ${json(sourceAfterDelete)}`)
  const sourceListed = await evaluate(`[...document.querySelectorAll('.sb-sess')].some(row => row.dataset.conversationId === ${json(parentId)})`)
  check(sourceListed === false, 'the deleted source is still listed as a conversation')
  // Deleting the parent is not a silent cascade: every child is still its own record.
  for (const id of created.ids) {
    const child = await conversation(id)
    check(child.summary.id === id && child.summary.deletion === undefined,
      `a child record did not survive its source: ${json({ id, deletion: child.summary.deletion ?? null })}`)
  }

  // None of them is a sidebar row, in either tab: a side chat belongs to its parent's panel.
  const sidebarEvidence = () => evaluate(`(() => {
    const sidebar = document.querySelector('#sidebar-pane')
    const ids = ${json(created.ids)}
    return {
      tab: sidebar.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.trim() ?? null,
      group: sidebar.querySelector('[data-side-chat-orphans], [data-orphan-group-key], [data-orphan-side-chat-id]') != null,
      childRows: [...sidebar.querySelectorAll('[data-conversation-id]')]
        .filter(node => ids.includes(node.dataset.conversationId)).length,
      mentions: ids.filter(id => sidebar.innerHTML.includes(id)).length,
      counters: [...sidebar.querySelectorAll('[data-side-chat-count]')].map(node => node.dataset.sideChatCount)
    }
  })()`)
  await idle()
  const projectsTab = await sidebarEvidence()
  check(projectsTab.group === false && projectsTab.childRows === 0 && projectsTab.mentions === 0,
    `a side chat of a deleted source was listed in the sidebar: ${json(projectsTab)}`)
  await capture('source-deleted-sidebar')
  await clickAt(`[...document.querySelectorAll('#sidebar-pane [role="tab"]')].find(node => node.getAttribute('aria-selected') !== 'true')`)
  await idle()
  const activityTab = await sidebarEvidence()
  check(activityTab.tab !== projectsTab.tab, `the sidebar never switched tabs: ${json({ projectsTab, activityTab })}`)
  check(activityTab.group === false && activityTab.childRows === 0 && activityTab.mentions === 0,
    `a side chat of a deleted source was listed in the activity tab: ${json(activityTab)}`)
  await clickAt(`[...document.querySelectorAll('#sidebar-pane [role="tab"]')].find(node => node.getAttribute('aria-selected') !== 'true')`)
  await idle()

  return {
    parentId, children: created.ids.length, seeded,
    created: { messageCount: created.messageCount, inlineCount: created.inlineCount,
      retrievableCount: created.retrievableCount, budgetBytes: created.budgetBytes },
    deleted: deletions, sourceAfterDelete, sidebar: { projectsTab, activityTab }
  }
}
