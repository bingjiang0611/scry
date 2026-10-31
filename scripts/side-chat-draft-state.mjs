import { CHILD_COMPOSER, CHILD_PANEL, json } from './side-chat-driving.mjs'

// 草稿面本身：往子会话 composer 里贴一张真图的 fixture，以及这款 App 真正会读回的
// composer 状态与持久化草稿记录。断言必须读这两处，而不是读测试自己的内存。
/** A real 96x64 PNG, pasted as a file: no OS clipboard is read or written. */
export const PENDING_IMAGE_SIZE = { width: 96, height: 64 }
const IMAGE_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAGAAAABACAIAAABqVuVZAAAAeElEQVR42u3WMQ0AIAwAwcqpJpQgESXowEEX0qW55BXc9HEyVRQIAAECBAgQIECABAgQIECAAAECJECAAAECBAgQIAEC9Al091IRIECAAAECBGgukBV00oAAAQIECBAgAQIECBAgQIAACRAgQIAAAQIESIAAAWrtAZjSIaUutgj/AAAAAElFTkSuQmCC'
export const DRAFT_IMAGE = 'side-chat-draft.png'
export const PENDING_IMAGE = 'side-chat-pending.png'
export const NEWER_IMAGE = 'side-chat-newer.png'

/** Paste one image into the visible child composer with a real clipboard event. */
export const pasteImage = (evaluate, check, name) => evaluate(`(async () => {
  const area = document.querySelector('${CHILD_COMPOSER}')
  if (!area) throw new Error('no child composer to paste into')
  const binary = atob(${json(IMAGE_BASE64)})
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0))
  const data = new DataTransfer()
  data.items.add(new File([bytes], ${json(name)}, { type: 'image/png' }))
  area.focus()
  const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })
  area.dispatchEvent(event)
  return { prevented: event.defaultPrevented }
})()`).then((result) => {
  check(result.prevented === true, `pasting an image must be handled by the composer: ${json(result)}`)
})

/** The child composer's own editable state, one surface at a time. */
export const readComposer = (evaluate) => evaluate(`(() => {
  const surface = document.querySelector('${CHILD_PANEL} .side-chat-surface')
  const chips = [...document.querySelectorAll('${CHILD_PANEL} .draft-attachment')]
  return { id: surface?.dataset.sideChatId ?? null,
    value: document.querySelector('${CHILD_COMPOSER}')?.value ?? null,
    attachments: chips.length, names: chips.map(chip => chip.getAttribute('title') ?? chip.textContent ?? '') }
})()`)

/** The durable entries this App would read again after a restart. */
export const readDurable = (evaluate) => evaluate(`(() => JSON.parse(localStorage.getItem('scry.composer-drafts.v1') ?? '[]')
  .map(([key, draft]) => ({ key, input: draft.input ?? null, attachments: (draft.attachments ?? []).map(item => item.name),
    pending: draft.pending ? { prompt: draft.pending.prompt, phase: draft.pending.phase,
      commandId: draft.pending.commandId, target: draft.pending.target?.providerId ?? null,
      attachments: (draft.pending.attachments ?? []).map(item => ({ name: item.name, bytes: item.dataBase64?.length ?? 0 })) } : null })))()`)
