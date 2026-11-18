import { CHILD_COMPOSER, json } from './side-chat-driving.mjs'
import { exerciseSideChatUntrustedText } from './side-chat-untrusted-text-checks.mjs'

/** Native composition and untrusted Provider text acceptance for the selected child. */
export async function exerciseSideChatInput({ cdp, evaluate, check, childId, controls, showChild, ipcCountsPath }) {
  const { capture, click, clearDraft, keyStroke, wait, conversation, inputs } = controls
  // 6. Real IME composition must not send, and committing it must not lose the text.
  // End activates the last tab, which need not be the conversation under test.
  await showChild()
  await click(CHILD_COMPOSER)
  const beforeComposition = inputs().length
  const turnsBefore = (await conversation(childId)).turns.length
  await cdp.send('Input.imeSetComposition', { text: '侧边会话', selectionStart: 4, selectionEnd: 4 })
  await new Promise(resolve => setTimeout(resolve, 200))
  await keyStroke({ key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await new Promise(resolve => setTimeout(resolve, 400))
  const composing = await evaluate(`(() => ({ value: document.querySelector('${CHILD_COMPOSER}')?.value ?? null,
    composing: document.querySelector('${CHILD_COMPOSER}')?.matches(':focus') ?? false }))()`)
  check(composing.value === '侧边会话', `an IME composition was not kept in the composer: ${json(composing)}`)
  const imeDispatched = inputs().length !== beforeComposition
  check(!imeDispatched, 'Enter during IME composition dispatched a Provider run')
  check((await conversation(childId)).turns.length === turnsBefore, 'Enter during IME composition created a turn')
  await cdp.send('Input.insertText', { text: '侧边会话' })
  await wait(`document.querySelector('${CHILD_COMPOSER}')?.value === '侧边会话'`)
  await clearDraft(CHILD_COMPOSER)
  await capture('layout-ime')

  // 7. Snapshot and Provider text is untrusted: it renders as text, never as markup.
  const { injected, lateRecordedRunId } = await exerciseSideChatUntrustedText({
    cdp, evaluate, check, childId, click, wait, capture, conversation, ipcCountsPath })

  return { ime: { value: composing.value, dispatchedDuringComposition: imeDispatched },
    lateRecordedRunId, untrustedText: injected }
}
