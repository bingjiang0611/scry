import { CHILD_COMPOSER, CHILD_PANEL, json } from './side-chat-driving.mjs'
import { PENDING_IMAGE_SIZE, readDurable } from './side-chat-draft-state.mjs'

/**
 * The receipt as a read-only view of what was submitted, not as a copy in the test.
 *
 * The user must be able to read the exact text and image back, open the product's own
 * lightbox from it, close it with focus returned, and do all of that inside a short window.
 * Reading the receipt must never rewrite its durable record, create a turn, or touch the
 * newer draft the user already typed. `prepared` carries the submitted identity and `newer`
 * the draft that stays untouched; both come from the same temporary userData.
 */
export async function verifySideChatPendingContent({ capture, check, clickAt, driver, evaluate, idle, newer,
  prepared, resize, settleModal, wait }) {
  // The inspect action has no stable selector of its own on older renders, so the read-only
  // view is opened through the same element the user sees — scoped to this child, because the
  // main pane can hold its own unresolved receipt and a bare query would take whichever
  // rendered first. The candidate list is recorded so a wrong-pane click is never a guess.
  const inspectAction = `document.querySelector('${CHILD_PANEL} [data-pending-inspect]')`
  const inspectCandidates = await evaluate(`[...document.querySelectorAll('[data-pending-inspect]')]
    .map(node => ({ pane: node.closest('#main-pane, #side-pane, [data-pane]')?.id ?? null,
      sideChat: node.closest('[data-side-chat-id]')?.dataset.sideChatId ?? null,
      state: node.dataset.pendingInspect ?? null, disabled: node.disabled,
      rect: (({ x, y, width, height }) => ({ x, y, width, height }))(node.getBoundingClientRect()) }))`)
  check(inspectCandidates.length >= 1, `no inspect action anywhere: ${json(inspectCandidates)}`)
  await wait(`document.querySelector('${CHILD_PANEL} [data-pending-inspect]') != null`)
  await clickAt(inspectAction)
  await wait(`document.querySelector('${CHILD_PANEL}') && document.querySelector('.pending-submission-modal') != null`)
  await settleModal('.pending-submission-modal')
  await idle()
  /** What the user can actually read in the receipt, as opposed to what is in localStorage. */
  const readContent = () => evaluate(`(() => {
    const image = document.querySelector('[data-pending-content-image] img')
    return { modal: document.querySelector('.pending-submission-modal') != null,
      identity: document.querySelector('[data-pending-content]')?.dataset.pendingContent ?? null,
      state: document.querySelector('[data-pending-content]')?.dataset.pendingContentState ?? null,
      text: document.querySelector('[data-pending-content-text]')?.textContent ?? null,
      imageName: document.querySelector('[data-pending-content-image]')?.dataset.pendingContentImage ?? null,
      imageReady: image ? image.complete && image.naturalWidth > 0 : null,
      buttons: [...document.querySelectorAll('.pending-submission-modal button')].map(node => node.textContent.trim()) }
  })()`)
  const content = await readContent()
  check(content.identity === prepared.pendingCommandId && content.state === 'unresolved',
    `the receipt must show the same unresolved command: ${json(content)}`)
  check(content.text === prepared.pendingText,
    `the receipt must show the exact submitted text, character for character: ${json({ shown: content.text, expected: prepared.pendingText })}`)
  check(content.imageName === prepared.pendingImage && content.imageReady === true,
    `the receipt must show the submitted image itself, not just its name: ${json(content)}`)
  check(!content.buttons.some(label => label.includes('重新发送')),
    `an unresolved receipt must not offer a resend while it is open: ${json(content.buttons)}`)
  await capture('drafts-pending-content')

  // The kept image opens the product's existing lightbox instead of a second viewer.
  await clickAt(`document.querySelector('[data-pending-content-image]')`)
  await wait(`document.querySelector('.image-lightbox') != null`)
  await settleModal('.image-lightbox')
  await idle()
  const lightbox = await evaluate(`(() => ({
    name: document.querySelector('.image-lightbox-name')?.textContent ?? null,
    width: document.querySelector('.image-lightbox-stage img')?.naturalWidth ?? null }))()`)
  check(lightbox.name === prepared.pendingImage && lightbox.width === PENDING_IMAGE_SIZE.width,
    `the receipt image must open its own preview: ${json(lightbox)}`)
  await capture('drafts-pending-image-preview')
  await driver.key('Escape')
  await wait(`document.querySelector('.image-lightbox') == null`)
  await wait(`document.querySelector('.pending-submission-modal') != null`)
  await driver.key('Escape')
  await wait(`document.querySelector('.pending-submission-modal') == null`)
  await idle()
  const afterClose = await evaluate(`(() => {
    const chips = [...document.querySelectorAll('${CHILD_PANEL} .draft-attachment')]
    return { focusReturned: document.activeElement === ${inspectAction},
      composer: document.querySelector('${CHILD_COMPOSER}')?.value ?? null,
      attachmentNames: chips.map(chip => chip.getAttribute('title') ?? chip.textContent ?? '') }
  })()`)
  check(afterClose.focusReturned === true,
    `closing the receipt must return focus to the control that opened it: ${json(afterClose)}`)
  check(afterClose.composer === newer.text && afterClose.attachmentNames.length === 1 &&
    afterClose.attachmentNames[0] === newer.image,
  `closing the receipt must leave the newer draft untouched: ${json(afterClose)}`)
  const durableAfterInspection = (await readDurable(evaluate))
    .find(entry => entry.pending?.commandId === prepared.pendingCommandId)
  check(durableAfterInspection?.pending?.prompt === prepared.pendingText &&
    durableAfterInspection.pending.phase === 'unknown',
  `reading the receipt must not rewrite its durable record: ${json(durableAfterInspection)}`)
  check((await evaluate(`window.scry.conversations.read(${json(prepared.pendingChild)})`)).turns.length === 0,
    'reading the receipt must not create a recorded turn')

  // A short window with a narrow side panel is the hardest real case: the receipt has to stay
  // inside the viewport with its close action reachable, and the text must not go sideways.
  const originalSize = await evaluate(`({ width: window.innerWidth, height: window.innerHeight })`)
  await resize(860, 600)
  await wait(`document.querySelector('${CHILD_PANEL} [data-pending-inspect]') != null`)
  await clickAt(inspectAction)
  await wait(`document.querySelector('.pending-submission-modal') != null`)
  await settleModal('.pending-submission-modal')
  await idle()
  const small = await evaluate(`(() => {
    const modal = document.querySelector('.pending-submission-modal')
    const text = modal?.querySelector('[data-pending-content-text]')
    const rect = modal?.getBoundingClientRect()
    const closeRect = modal?.querySelector('.pending-submission-header button')?.getBoundingClientRect()
    return { viewport: [window.innerWidth, window.innerHeight],
      inside: rect ? rect.top >= 0 && rect.left >= 0 && rect.bottom <= window.innerHeight + 0.5 &&
        rect.right <= window.innerWidth + 0.5 : null,
      height: rect ? Math.round(rect.height) : null,
      closeReachable: closeRect ? closeRect.top >= 0 && closeRect.bottom <= window.innerHeight : null,
      textOverflow: text ? text.scrollWidth - text.clientWidth : null }
  })()`)
  check(small.inside === true && small.closeReachable === true,
    `the receipt must stay inside a small window: ${json(small)}`)
  check(small.textOverflow <= 0, `the receipt text must not overflow sideways: ${json(small)}`)
  await capture('drafts-pending-content-narrow')
  await driver.key('Escape')
  await wait(`document.querySelector('.pending-submission-modal') == null`)
  await resize(originalSize.width, originalSize.height)
  await idle()
  check((await evaluate(`document.querySelector('${CHILD_COMPOSER}')?.value ?? null`)) === newer.text,
    'resizing and closing the receipt must not touch the newer draft')
  return { content, lightbox: lightbox.name, focusReturned: afterClose.focusReturned,
    inspectCandidates: inspectCandidates.length, inspectOwners: inspectCandidates.map(entry => entry.sideChat) }
}
