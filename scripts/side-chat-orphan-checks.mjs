import { json, sideChatDriver } from './side-chat-driving.mjs'

/**
 * The largest frozen prefix a readerless Provider can really deliver: 13 turns x 2 messages,
 * well inside the 16 kB handoff budget. A longer prefix needs a verified history reader, so
 * a multi-page body cannot be created by the App at all; the reader's paging is proven in
 * `scripts/side-chat-snapshot-ui-smoke.mjs` against real pages instead of faking a reader.
 */
const PARENT_TURNS = 13
/** More children than one orphan group renders by default. */
const ORPHAN_CHILDREN = 21
const ROW_BATCH = 20
/** The child's own draft, reused by the reader pass as its isolation probe. */
const DRAFT = '孤儿草稿草稿'

/** Short CJK+emoji turn, so the real handoff budget admits every message inline. */
const unicodePrompt = (ordinal) => `side chat note 第 ${ordinal} 轮🙂🀄️ 冻结正文`

/**
 * What survives deleting the source, in the isolated production App.
 *
 * The source parent is archived and deleted through the shipped fingerprint-preview dialog.
 * Afterwards the child must still be a real record with a readable frozen body, still be
 * discoverable under its captured parent title, and open as the main view with its own
 * runtime controls and its own snapshot reader instead of the host's global chat props.
 * The frozen prefix is long in message count and short in bytes, so it really spans two
 * viewer pages; the single-message body budget is proven separately at the body API.
 */
export async function exerciseSideChatOrphan({ cdp, evaluate, check, ipcCountsPath, inputsPath, callsPath, workspace, rendererFailures = [] }) {
  const {
    capture, click, clickAt, idle, wait, counts, since, conversation, seedTurns, openChildById
  } = sideChatDriver({ cdp, evaluate, check, ipcCountsPath, inputsPath, callsPath, rendererFailures, label: 'Side-chat orphan' })

  // The host's own runtime selection, so "the child has its own controls" is measured
  // against a real other value instead of the fixture's default agent.
  const hostAgent = await evaluate(`document.querySelector('#main-pane .runtime-composer .clibtn')?.dataset.agentId ?? null`)
  check(hostAgent != null, 'the host composer never showed its own agent selection')

  // A second parent whose completed transcript is long in messages, not in one huge body.
  const parentId = await evaluate(`window.scry.conversations.create(${json(workspace)}).then(created => created.id)`)
  const prompts = Array.from({ length: PARENT_TURNS }, (_, index) => unicodePrompt(index + 1))
  const seeded = await seedTurns(parentId, prompts)
  check(seeded === PARENT_TURNS, `the orphan source did not record its transcript: ${json({ seeded, expected: PARENT_TURNS })}`)

  // One preview, many children: the frozen prefix does not change while the source is quiet.
  const created = await evaluate(`(async () => {
    const source = { kind: 'conversation', conversationId: ${json(parentId)} }
    const preview = await window.scry.conversations.previewSideChat(source, {})
    const ids = []
    for (let index = 0; index < ${ORPHAN_CHILDREN}; index += 1) {
      const child = await window.scry.conversations.createSideChat({
        source, expectedThroughOrdinal: preview.throughOrdinal, expectedThroughRunId: preview.throughRunId,
        expectedPrefixFingerprint: preview.prefixFingerprint, expectedManifestFingerprint: preview.manifestFingerprint,
        commandId: crypto.randomUUID(), initialTarget: preview.target })
      ids.push(child.id)
    }
    return { ids, messageCount: preview.messageCount, inlineCount: preview.coverage.inlineCount,
      retrievableCount: preview.coverage.retrievableCount, budgetBytes: preview.coverage.handoffBudgetBytes }
  })()`)
  check(created.ids.length === ORPHAN_CHILDREN, `the parent could not own ${ORPHAN_CHILDREN} children: ${json({ created: created.ids.length })}`)
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
  check(parentRow >= 0, `the orphan source is not listed in the sidebar: ${json(rows.map(row => row.text))}`)
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
  await capture('orphan-delete-preview')
  await clickAt(`[...document.querySelectorAll('.unified-delete .unified-actions button')].find(node => node.textContent.includes('确认删除'))`)
  await wait(`document.querySelector('.unified-delete')?.textContent.includes('逻辑入口已删除') || document.querySelector('.unified-delete')?.textContent.includes('未完整删除')`, 30000)
  const receipt = await evaluate(`document.querySelector('.unified-delete')?.textContent ?? null`)
  check(receipt != null && receipt.includes('逻辑入口已删除'), `the delete did not report a committed result: ${json(receipt)}`)
  await capture('orphan-delete-result')
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
  const child = await conversation(created.ids[0])
  check(child.summary.id === created.ids[0], 'the child record did not survive its source')

  // It is discoverable under its captured parent title, grouped by that exact source. The
  // group is located by its own source key and never by the title it displays.
  const groupKey = `conversation:${parentId}`
  /** What one group really mounts: its rows, the page it is on and the whole list's bounds. */
  const readGroup = (key) => evaluate(`(() => {
    const groupNode = [...document.querySelectorAll('[data-orphan-group-key]')]
      .find(node => node.dataset.orphanGroupKey === ${json(key)})
    const rows = groupNode ? [...groupNode.querySelectorAll('[data-orphan-side-chat-id]')].map(row => row.dataset.orphanSideChatId) : []
    return { keys: [...document.querySelectorAll('[data-orphan-group-key]')].map(node => node.dataset.orphanGroupKey),
      rows, rowsInGroup: rows.length,
      page: groupNode?.querySelector('[data-orphan-rows-page]')?.dataset.orphanRowsPage ?? null,
      range: groupNode?.querySelector('[data-orphan-rows-range]')?.textContent?.trim() ?? null,
      title: groupNode?.querySelector('.sb-orphan-parent-title')?.textContent ?? null,
      renderedRows: document.querySelectorAll('[data-orphan-side-chat-id]').length,
      renderedGroups: document.querySelectorAll('[data-orphan-group-key]').length }
  })()`)
  await wait(`document.querySelector('[data-side-chat-orphans]') != null`, 30000)
  await wait(`document.querySelector('[data-orphan-rows-next="${groupKey}"]') != null`, 30000)
  const group = await readGroup(groupKey)
  check(group.keys.includes(groupKey),
    `the orphan group must be keyed by its captured source: ${json(group.keys)}`)
  check(group.title != null && group.title.length > 0, `the orphan group lost its captured title: ${json(group)}`)
  // Bounded by page replacement: one page of rows is mounted, the rest is one click away.
  const parentRows = group.rowsInGroup
  check(parentRows === ROW_BATCH, `one orphan group must mount exactly one bounded page: ${json({ parentRows, group })}`)
  check(group.page === '1/2', `the first row page must say where it sits: ${json({ group })}`)
  const hiddenTarget = created.ids.find(id => !group.rows.includes(id))
  check(hiddenTarget != null, `every orphan child of ${ORPHAN_CHILDREN} was rendered at once: ${json({ rendered: group.rows.length })}`)
  await capture('orphan-sidebar-row')

  // 行要读得下去：子会话标题自己占一行，长长的快照边界不能把它挤成一个字。
  // 用一个普通长度的真实名字命名其中一行，并分别量两行的实际排版。
  const RENAMED = '核对快照边界'
  const renamedChild = group.rows[0]
  await evaluate(`(async () => {
    const page = await window.scry.conversations.read(${json(renamedChild)})
    await window.scry.conversations.update(${json(renamedChild)}, page.summary.revision,
      { kind: 'rename', title: ${json(RENAMED)} })
    return true
  })()`)
  await wait(`[...document.querySelectorAll('[data-orphan-side-chat-id]')]
    .some(node => node.textContent.includes(${json(RENAMED)}))`, 20000).catch(async () => {
    throw new Error('the renamed orphan row never reached the sidebar: ' + json(await evaluate(`(() => ({
      rows: [...document.querySelectorAll('[data-orphan-side-chat-id]')].map(node => node.textContent) }))()`)))
  })
  /** How one orphan row really lays out: title box, metadata box, and any sideways overflow. */
  const readRowLayout = (id) => evaluate(`(() => {
    const row = [...document.querySelectorAll('[data-orphan-side-chat-id]')]
      .find(node => node.dataset.orphanSideChatId === ${json(id)})
    const title = row?.querySelector('.sb-sesstext')
    const meta = row?.querySelector('.sb-session-meta')
    const group = document.querySelector('[data-side-chat-orphans]')
    const titleRect = title?.getBoundingClientRect()
    const metaRect = meta?.getBoundingClientRect()
    return { title: title?.textContent ?? null, meta: meta?.textContent?.trim() ?? null,
      titleWidth: titleRect ? Math.round(titleRect.width) : null,
      titleTruncated: title ? title.scrollWidth > title.clientWidth + 1 : null,
      metaBelowTitle: titleRect && metaRect ? metaRect.top >= titleRect.bottom - 1 : null,
      rowHeight: row ? Math.round(row.getBoundingClientRect().height) : null,
      rowOverflow: row ? row.scrollWidth - row.clientWidth : null,
      groupOverflow: group ? group.scrollWidth - group.clientWidth : null }
  })()`)
  const editedRow = await readRowLayout(renamedChild)
  check(editedRow.title === RENAMED, `the renamed orphan row lost its title: ${json(editedRow)}`)
  check(editedRow.titleTruncated === false && editedRow.titleWidth >= 70,
    `a medium child name must be readable in its own row: ${json(editedRow)}`)
  check(editedRow.metaBelowTitle === true, `snapshot metadata must sit below the child title: ${json(editedRow)}`)
  // The default-name rows prove the same thing for the shortest honest title in the fixture.
  const plainRow = await readRowLayout(group.rows[1] ?? group.rows[0])
  check(plainRow.titleTruncated === false && plainRow.titleWidth >= 44,
    `a default child title must not be squeezed to one glyph: ${json(plainRow)}`)
  check(plainRow.metaBelowTitle === true, `snapshot metadata must sit below every child title: ${json(plainRow)}`)
  check(plainRow.rowOverflow <= 0 && plainRow.groupOverflow <= 0 && editedRow.rowOverflow <= 0 &&
    editedRow.groupOverflow <= 0, `the orphan rows must not overflow sideways: ${json({ plainRow, editedRow })}`)
  await capture('orphan-sidebar-row-title')
  const nextPage = `[...document.querySelectorAll('[data-orphan-rows-next]')].find(node => node.dataset.orphanRowsNext === ${json(groupKey)})`
  const previousPage = `[...document.querySelectorAll('[data-orphan-rows-previous]')].find(node => node.dataset.orphanRowsPrevious === ${json(groupKey)})`
  await clickAt(nextPage)
  await wait(`[...document.querySelectorAll('[data-orphan-rows-page]')].some(node => node.dataset.orphanRowsPage === '2/2')`, 15000)
  await idle()
  const second = await readGroup(groupKey)
  check(second.page === '2/2', `the next click must replace the row page: ${json(second)}`)
  check(second.rows.length <= ROW_BATCH, `the second row page mounted more than one page: ${json(second)}`)
  check(second.rows.includes(hiddenTarget),
    `the second row page must hold the child beyond the first page: ${json({ hiddenTarget, second })}`)
  // Replacement, not accumulation: the second page may not repeat the first page's rows.
  check(!second.rows.some(id => group.rows.includes(id)),
    `the row page must be replaced instead of appended: ${json({ first: group.rows, second: second.rows })}`)
  await capture('orphan-sidebar-row-page-two')
  // Page two to page one must stay reachable, with the same rows the first page had.
  await clickAt(previousPage)
  await wait(`[...document.querySelectorAll('[data-orphan-rows-page]')].some(node => node.dataset.orphanRowsPage === '1/2')`, 15000)
  await idle()
  const back = await readGroup(groupKey)
  check(back.rows.join() === group.rows.join(),
    `walking back must restore the first row page: ${json({ first: group.rows, back: back.rows })}`)
  check(!back.rows.includes(hiddenTarget), `the first page must not keep the second page's child: ${json(back)}`)
  await clickAt(nextPage)
  await wait(`[...document.querySelectorAll('[data-orphan-rows-page]')].some(node => node.dataset.orphanRowsPage === '2/2')`, 15000)
  await idle()
  const orphanChild = hiddenTarget

  // Open it as the MAIN view: its own snapshot reader and its own runtime controls.
  await clickAt(`[...document.querySelectorAll('[data-orphan-side-chat-id]')].find(node => node.dataset.orphanSideChatId === ${json(orphanChild)})`)
  await wait(`document.querySelector('#main-pane [data-side-chat-variant="main"]') != null`, 20000)
  await idle()
  const mainView = await evaluate(`(() => {
    const surface = document.querySelector('#main-pane [data-side-chat-variant="main"]')
    return {
      id: surface?.dataset.sideChatId ?? null,
      parent: surface?.querySelector('[data-side-chat-parent-title]')?.textContent ?? null,
      snapshotAction: [...surface.querySelectorAll('.side-chat-surface-actions button')].map(node => node.textContent.trim()),
      closeAction: surface?.querySelector('[aria-label="关闭侧聊"]') != null,
      provider: surface?.querySelector('.runtime-composer .clibtn')?.dataset.agentId ?? null,
      composer: surface?.querySelector('.runtime-composer textarea') != null,
      workspaceLabel: surface?.querySelector('.side-chat-workspace')?.textContent ?? null,
      workspacePicker: surface?.querySelector('.runtime-composer .location-picker, .runtime-composer [aria-label*="工作区"]') != null
    }
  })()`)
  check(mainView.id === orphanChild, `the orphan opened as another conversation: ${json(mainView)}`)
  check(mainView.parent != null && mainView.parent.length > 0, `the main view lost the captured parent title: ${json(mainView)}`)
  check(mainView.snapshotAction.includes('查看来源快照'), `the main view has no snapshot reader: ${json(mainView)}`)
  check(mainView.closeAction === false, `the main view offered a tab-close action: ${json(mainView)}`)
  check(mainView.provider != null && mainView.composer === true, `the main view lost its own runtime controls: ${json(mainView)}`)
  check(mainView.workspaceLabel != null && mainView.workspaceLabel.includes('共用工作区'),
    `the main view must keep the readonly shared workspace: ${json(mainView)}`)
  check(mainView.workspacePicker === false, `the main view offered a workspace picker: ${json(mainView)}`)
  await capture('orphan-main-view')

  // Its draft belongs to the child and stays in that composer.
  await click('#main-pane .runtime-composer textarea')
  await cdp.send('Input.insertText', { text: DRAFT })
  await wait(`document.querySelector('#main-pane .runtime-composer textarea')?.value === ${json(DRAFT)}`)
  await idle()

  return {
    parentId, childId: orphanChild, seeded, hostAgent, seededMessages: created.messageCount,
    created: { children: created.ids.length, messageCount: created.messageCount,
      inlineCount: created.inlineCount, retrievableCount: created.retrievableCount, budgetBytes: created.budgetBytes },
    deleted: deletions, sourceAfterDelete,
    orphan: { groupKeys: group.keys, rows: parentRows, page: group.page, range: group.range,
      second: { page: second.page, rows: second.rows.length }, title: group.title,
      rowLayout: { renamed: editedRow, plain: plainRow } },
    mainView, draft: DRAFT
  }
}
