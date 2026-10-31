import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { CHILD_COMPOSER, CHILD_PANEL, SIDE_CHAT_SURFACE, json, sideChatDriver } from './side-chat-driving.mjs'
import { DRAFT_IMAGE, NEWER_IMAGE, PENDING_IMAGE, pasteImage, readComposer, readDurable } from './side-chat-draft-state.mjs'
import { verifySideChatPendingContent } from './side-chat-pending-content-checks.mjs'
import { readWorkbench } from './side-chat-workbench-checks.mjs'
import { createWindowResize } from './side-chat-window-control.mjs'

export const UNSENT_TEXT = 'side chat unsent 草稿文字'
// 带表情和 Markdown 记号：回执必须逐字显示提交内容，而不是渲染后的正文。
export const PENDING_TEXT = 'side chat pending 待核对原文🙂🀄️ *原样显示*'
export const NEWER_TEXT = 'side chat newer 之后写的草稿'

/**
 * Leave two different unsent states in two children of the same parent before the quit.
 *
 * One child keeps text and an image that were never sent; the other keeps a receipt whose
 * send reply was lost before the host recorded anything, so only the durable record can
 * answer it afterwards. The failure is injected through the existing fixture marker file;
 * nothing is read from or written to the operating-system clipboard.
 */
export async function prepareSideChatDrafts({ cdp, evaluate, check, ipcCountsPath, inputsPath, callsPath,
  childId, source, lostSendReplyPath, rendererFailures = [] }) {
  const { capture, click, clickAt, idle, wait, inputs, createChildOf, openChildFromHistory, openChildById, showPanel,
    type } = sideChatDriver({
    cdp, evaluate, check, ipcCountsPath, inputsPath, callsPath, rendererFailures, label: 'Side-chat drafts' })
  // A second child of the same parent: the shipped history dialog is the way in, so this
  // also re-proves that the parent scope lists its own children.
  const pendingChild = await createChildOf(source, randomUUID())
  check(pendingChild !== childId, `the pending probe reused the draft child: ${json({ pendingChild, childId })}`)
  await openChildById(pendingChild)
  await type(CHILD_COMPOSER, PENDING_TEXT)
  await pasteImage(evaluate, check, PENDING_IMAGE)
  await wait(`document.querySelectorAll('${CHILD_PANEL} .draft-attachment').length === 1`)
  const composed = await readComposer(evaluate)
  check(composed.value === PENDING_TEXT && composed.names[0] === PENDING_IMAGE,
    `the pending probe was not composed as a user would: ${json(composed)}`)
  const runsBefore = inputs().filter(entry => entry.prompt === PENDING_TEXT).length
  const turnsBefore = (await evaluate(`window.scry.conversations.read(${json(pendingChild)})`)).turns.length
  // The reply is lost before the host records anything: the receipt is the only evidence.
  writeFileSync(lostSendReplyPath, 'before-commit')
  await click(`${CHILD_PANEL} .send`)
  await wait(`document.querySelector('[data-pending-state="unresolved"]') != null`, 25000).catch(async () => {
    throw new Error(`a lost send reply must leave a durable receipt: ${json(await evaluate(`(() => ({
      state: document.querySelector('[data-pending-state]')?.dataset.pendingState ?? null,
      recovery: document.querySelector('.conversation-recovery')?.textContent ?? null,
      chips: document.querySelectorAll('${CHILD_PANEL} .draft-attachment').length,
      composer: document.querySelector('${CHILD_COMPOSER}')?.value ?? null }))()`))}`)
  })
  await idle()
  const receipt = await evaluate(`(() => {
    const recovery = document.querySelector('[data-pending-state]')
    return { state: recovery?.dataset.pendingState ?? null, text: recovery?.textContent ?? null,
      canResend: [...(recovery?.querySelectorAll('button') ?? [])].some(node => node.textContent.includes('重新发送')),
      buttons: [...(recovery?.querySelectorAll('button') ?? [])].map(node => node.textContent.trim()) }
  })()`)
  check(receipt.state === 'unresolved', `a lost send reply must stay unresolved: ${json(receipt)}`)
  check(receipt.canResend === false, `an unresolved receipt must not offer a resend: ${json(receipt)}`)
  check(receipt.text.includes('原文与图片已保留'), `the receipt must say what it keeps: ${json(receipt)}`)
  // The kept content is only “kept” if the user can really read it back from the receipt.
  check(receipt.buttons.includes('查看原文与图片'),
    `the receipt must offer a read-only way to see what it kept: ${json(receipt.buttons)}`)
  const composedAfter = await readComposer(evaluate)
  check(composedAfter.value === '' && composedAfter.attachments === 0,
    `the submitted text and image must leave the composer: ${json(composedAfter)}`)
  const pendingEntry = (await readDurable(evaluate)).find(entry => entry.pending?.commandId != null &&
    entry.pending.prompt === PENDING_TEXT)
  check(pendingEntry?.pending?.phase === 'unknown', `the receipt must be durable as unknown: ${json(pendingEntry)}`)
  check(pendingEntry.pending.attachments.length === 1 && pendingEntry.pending.attachments[0].name === PENDING_IMAGE &&
    pendingEntry.pending.attachments[0].bytes > 0,
  `the receipt must keep the submitted image: ${json(pendingEntry)}`)
  const runsAfter = inputs().filter(entry => entry.prompt === PENDING_TEXT).length
  check(runsAfter === runsBefore, `a reply lost before commit must not reach the Provider: ${json({ runsBefore, runsAfter })}`)
  check((await evaluate(`window.scry.conversations.read(${json(pendingChild)})`)).turns.length === turnsBefore,
    'a reply lost before commit must not create a recorded turn')
  await capture('drafts-pending-receipt')

  // The other child keeps an unsent draft: text and image stay editable, nothing is sent.
  await openChildById(childId)
  await type(CHILD_COMPOSER, UNSENT_TEXT)
  await pasteImage(evaluate, check, DRAFT_IMAGE)
  await wait(`document.querySelectorAll('${CHILD_PANEL} .draft-attachment').length === 1`)
  const unsent = await readComposer(evaluate)
  check(unsent.id === childId && unsent.value === UNSENT_TEXT && unsent.names[0] === DRAFT_IMAGE,
    `the unsent draft was not composed as a user would: ${json(unsent)}`)
  check(inputs().every(entry => entry.prompt !== UNSENT_TEXT), 'typing an unsent draft dispatched a run')
  await wait(`document.querySelector('${CHILD_PANEL} .send')?.disabled === false`)
  // The shipped draft store persists after a quiet period, so the durable record is awaited
  // instead of assumed to exist on the first read.
  await wait(`JSON.parse(localStorage.getItem('scry.composer-drafts.v1') ?? '[]')
    .some(([, draft]) => draft.input === ${json(UNSENT_TEXT)})`, 15000)
  const unsentEntry = (await readDurable(evaluate)).find(entry => entry.input === UNSENT_TEXT)
  check(unsentEntry?.attachments?.[0] === DRAFT_IMAGE,
    `the unsent draft must be durable with its image: ${json(unsentEntry)}`)
  await capture('drafts-unsent')

  // The workbench a restart has to restore: one tool tab and three child tabs of this
  // parent — the unsent draft child, the unresolved receipt child and an ordinary child.
  // Closing the other tabs is a user view action (proven not to delete or stop anything by
  // the runtime step); every child below is then opened through the shipped history
  // action, which must never close a tab to get there. The order and the active child are
  // asserted before the quit, so the restart assertion has an independent expectation.
  const ordinaryChild = await createChildOf(source, randomUUID())
  check(ordinaryChild !== childId && ordinaryChild !== pendingChild,
    `the ordinary child reused another child: ${json({ ordinaryChild, childId, pendingChild })}`)
  await showPanel()
  while (await evaluate(`document.querySelector('${SIDE_CHAT_SURFACE} .surface-tab-close') != null`)) {
    await click(`${SIDE_CHAT_SURFACE} .surface-tab-close`)
    await idle()
  }
  // The tool tab first: this is the chooser card, the same shipped surface entry a user
  // clicks when nothing is open.
  await wait(`[...document.querySelectorAll('${SIDE_CHAT_SURFACE} .surface-card')]
    .some(node => node.querySelector('strong')?.textContent.trim() === '纵览')`, 10000)
  await clickAt(`[...document.querySelectorAll('${SIDE_CHAT_SURFACE} .surface-card')]
    .find(node => node.querySelector('strong')?.textContent.trim() === '纵览')`)
  await wait(`document.querySelector('${SIDE_CHAT_SURFACE} [data-surface-tab="tool"]') != null`)
  for (const child of [pendingChild, childId, ordinaryChild]) await openChildFromHistory(child)
  await click(`[data-side-chat-tab-id="${childId}"] [role="tab"]`)
  await wait(`document.querySelector('${CHILD_PANEL} .side-chat-surface')?.dataset.sideChatId === ${json(childId)}`)
  await idle()
  const layout = { tool: '纵览', children: [pendingChild, childId, ordinaryChild], active: childId }
  let workbench = await readWorkbench(evaluate, layout.children)
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const settled = workbench.saved != null &&
      json(workbench.saved.sideChats) === json(layout.children) &&
      workbench.saved.activeSideChatId === layout.active &&
      json(workbench.childTabs) === json(layout.children) && workbench.selectedChild === layout.active &&
      workbench.toolTabs.includes(layout.tool)
    if (settled) break
    await new Promise(resolve => setTimeout(resolve, 100))
    workbench = await readWorkbench(evaluate, layout.children)
  }
  check(json(workbench.childTabs) === json(layout.children),
    `the workbench must show exactly the three child tabs in opening order: ${json({ workbench, layout })}`)
  check(workbench.toolTabs.includes(layout.tool), `the workbench lost its tool tab: ${json({ workbench, layout })}`)
  check(workbench.selectedChild === layout.active,
    `the draft child must be the active tab before the quit: ${json({ workbench, layout })}`)
  check(workbench.saved != null && json(workbench.saved.sideChats) === json(layout.children) &&
    workbench.saved.activeSideChatId === layout.active && workbench.saved.openIds.includes('overview'),
  `the saved layout must already hold the three tabs and the active child: ${json({ saved: workbench.saved, layout })}`)
  await capture('drafts-workbench-before-quit')
  return { pendingChild, pendingCommandId: pendingEntry.pending.commandId,
    pendingText: PENDING_TEXT, pendingImage: PENDING_IMAGE,
    draftText: UNSENT_TEXT, draftImage: DRAFT_IMAGE, workbench: { ...layout, scope: workbench.saved.scope,
      openIds: workbench.saved.openIds, savedVisible: workbench.saved.visible },
    receipt: { state: receipt.state, buttons: receipt.buttons } }
}

/**
 * What both children still own after the App really quit and came back.
 *
 * The unsent draft returns exactly as written, with its image. The unresolved receipt
 * returns as a receipt: the same command id, its text and its image, still unresolved, and
 * no Provider run either way. A newer draft typed into that child stays its own text when
 * the older command is checked.
 */
export async function verifySideChatDrafts({ cdp, evaluate, check, ipcCountsPath, inputsPath, callsPath,
  childId, prepared, windowControlPath, rendererFailures = [] }) {
  const { driver, capture, click, clickAt, idle, wait, counts, inputs, type, openChildById } = sideChatDriver({
    cdp, evaluate, check, ipcCountsPath, inputsPath, callsPath, rendererFailures, label: 'Side-chat drafts restart' })
  // A dialog captured mid-entrance is not evidence of what the user reads.
  const settleModal = (selector) => wait(`(() => { const node = document.querySelector(${json(selector)})
    return node != null && Number(getComputedStyle(node).opacity) >= 0.99 })()`)
  const { resize } = createWindowResize({ wait, idle, check, windowControlPath, json })
  /**
   * The shipped way back to either child after the restart: its restored tab when the App
   * kept one, or the history dialog when it did not. Neither path may be skipped, and the
   * draft assertions below never depend on which of the two the window happened to keep.
   */
  const openChild = async (id) => {
    const current = await evaluate(`document.querySelector('${CHILD_PANEL} .side-chat-surface')?.dataset.sideChatId ?? null`)
    if (current === id) return
    await openChildById(id)
  }
  await openChild(childId)
  const draft = await readComposer(evaluate)
  check(draft.value === prepared.draftText,
    `the unsent draft must come back exactly: ${json({ draft, expected: prepared.draftText })}`)
  check(draft.attachments === 1 && draft.names[0] === prepared.draftImage,
    `the unsent draft must keep its image: ${json(draft)}`)
  check(inputs().every(entry => entry.prompt !== prepared.draftText),
    'a restart must never dispatch an unsent draft')
  await capture('drafts-restored-unsent')

  await openChild(prepared.pendingChild)
  const receipt = await evaluate(`(() => {
    const recovery = document.querySelector('[data-pending-state]')
    return { state: recovery?.dataset.pendingState ?? null, text: recovery?.textContent ?? null,
      buttons: [...(recovery?.querySelectorAll('button') ?? [])].map(node => node.textContent.trim()),
      sendDisabled: document.querySelector('${CHILD_PANEL} .send')?.disabled ?? null,
      composer: document.querySelector('${CHILD_COMPOSER}')?.value ?? null }
  })()`)
  check(receipt.state === 'unresolved',
    `the unresolved receipt must survive the restart: ${json(receipt)}`)
  check(receipt.sendDisabled === true, `an unresolved receipt must keep the send blocked: ${json(receipt)}`)
  check(receipt.buttons.includes('核对状态'),
    `the restored receipt must offer its read-only check: ${json(receipt)}`)
  const durable = (await readDurable(evaluate)).find(entry => entry.pending?.commandId === prepared.pendingCommandId)
  check(durable?.pending?.prompt === prepared.pendingText,
    `the receipt must keep its original text after the restart: ${json(durable)}`)
  check(durable.pending.attachments.length === 1 && durable.pending.attachments[0].name === prepared.pendingImage &&
    durable.pending.attachments[0].bytes > 0,
  `the receipt must keep its image after the restart: ${json(durable)}`)
  check(inputs().every(entry => entry.prompt !== prepared.pendingText),
    'a restart must never resend an unresolved receipt')
  const emptyState = await evaluate(`(() => ({
    unresolvedFirstSend: document.querySelector('${CHILD_PANEL} [data-status="pending-first-send"]')?.textContent ?? null,
    freshSideChat: document.querySelector('${CHILD_PANEL} [data-status="new-side-chat"]')?.textContent ?? null }))()`)
  check(emptyState.unresolvedFirstSend != null && emptyState.freshSideChat == null,
    `an unresolved first send must not be shown as a never-sent side chat: ${json(emptyState)}`)
  await capture('drafts-restored-receipt')

  // A newer draft and a newer attachment belong to the user; the receipt stays separate.
  await type(CHILD_COMPOSER, NEWER_TEXT)
  await pasteImage(evaluate, check, NEWER_IMAGE)
  await wait(`document.querySelectorAll('${CHILD_PANEL} .draft-attachment').length === 1`)
  // The receipt is the only copy of what was submitted: the user has to be able to read it.
  // That is a real read-only view of the content, its own lightbox, focus back to the control
  // that opened it and a short window — and reading it must not rewrite the durable record,
  // create a turn or touch the newer draft.
  const inspection = await verifySideChatPendingContent({ capture, check, clickAt, driver, evaluate, idle,
    newer: { text: NEWER_TEXT, image: NEWER_IMAGE }, prepared, resize, settleModal, wait })

  // A newer draft belongs to the user. Reading the older command back must not clear,
  // overwrite or resend it, and an absent record is still not "known not sent".
  // The check is a read of the record; its own IPC call is the signal that it finished.
  const readsBefore = counts()['conversation:read'] ?? 0
  // The recovery action has no selector of its own, so the pointer is aimed at the node the
  // user sees and the same pressed/released pair is dispatched at that point.
  const checkPoint = await driver.pointerAt(`[...document.querySelectorAll('[data-pending-state] button')]
    .find(node => node.textContent.includes('核对状态'))`)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...checkPoint })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...checkPoint })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...checkPoint })
  for (let attempt = 0; attempt < 120 && (counts()['conversation:read'] ?? 0) === readsBefore; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  check((counts()['conversation:read'] ?? 0) > readsBefore,
    'checking the receipt must read its record')
  await idle()
  const afterCheck = await evaluate(`(() => ({ composer: document.querySelector('${CHILD_COMPOSER}')?.value ?? null,
    state: document.querySelector('[data-pending-state]')?.dataset.pendingState ?? null,
    resend: [...document.querySelectorAll('[data-pending-state] button')].some(node => node.textContent.includes('重新发送')) }))()`)
  check(afterCheck.composer === NEWER_TEXT,
    `reading the older command back must not touch the newer draft: ${json(afterCheck)}`)
  check(afterCheck.state === 'unresolved' && afterCheck.resend === false,
    `an absent record must stay unresolved, never resendable: ${json(afterCheck)}`)
  check(inputs().every(entry => entry.prompt !== prepared.pendingText && entry.prompt !== NEWER_TEXT),
    'checking a receipt must never dispatch a run')
  await capture('drafts-newer-kept')
  return { draft: { value: draft.value, images: draft.attachments },
    receipt: { state: receipt.state, buttons: receipt.buttons, sendDisabled: receipt.sendDisabled },
    content: { text: inspection.content.text, image: inspection.content.imageName,
      imageReady: inspection.content.imageReady, lightbox: inspection.lightbox,
      focusReturned: inspection.focusReturned, emptyState,
      inspectOwners: inspection.inspectOwners, inspectCandidates: inspection.inspectCandidates },
    newerDraft: afterCheck, pendingCommandId: durable.pending.commandId }
}
