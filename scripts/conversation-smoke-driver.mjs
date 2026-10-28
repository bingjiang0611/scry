import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { nativeUiPointer } from './native-ui-pointer.mjs'

export const json = JSON.stringify
export const inputs = (fixture) => existsSync(fixture.inputsFile) ? readFileSync(fixture.inputsFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []
export const ledger = (fixture, id) => JSON.parse(readFileSync(join(fixture.userData, 'conversations', `${id}.json`), 'utf8'))
export const wait = async (probe, label) => {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const result = await probe()
    if (result) return result
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`Timed out: ${label}`)
}
export const read = (evaluate, id) => evaluate(`window.scry.conversations.read(${json(id)})`)
export const preview = (evaluate, id, providerId) => evaluate(`window.scry.conversations.preview(${json(id)}, {providerId:${json(providerId)}})`)
export const settled = (evaluate, id, count, status = 'accepted') => wait(async () => {
  const page = await read(evaluate, id)
  return page.turns.length === count && !page.summary.activeRunId && page.turns.at(-1).delivery.status === status ? page : false
}, `conversation ${id}: ${count} turns / ${status}`)
export const sendRequest = (view, commandId, prompt, selectedItems = view.missingItems.map((item) => item.ref)) => ({
  conversationId: view.conversationId, providerId: view.target.providerId, expectedRevision: view.revision,
  expectedContinuationKey: view.target.continuationKey, commandId, prompt, selectedItems,
  confirmFresh: view.continuation.kind === 'fresh'
})

export function createConversationDriver(cdp, evaluate) {
  const click = async (selector) => {
    // Workflow, command and management menus share the toolbar class. Open
    // the target's enclosing menu, not the first summary in the toolbar.
    if (await evaluate(`Boolean(document.querySelector(${json(selector)})?.closest('.conversation-options:not([open]) .unified-management'))`)) {
      await click(`.conversation-options:not([open]):has(${selector}) > summary`)
    }
    await wait(() => evaluate(`Boolean(document.querySelector(${json(selector)}) && !document.querySelector(${json(selector)}).disabled)`), `enabled UI target: ${selector}`)
    const point = await evaluate(`(${nativeUiPointer.toString()})(${json(selector)}, { timeoutMs: 20000, scroll: true, captureReceipt: true })`)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
    await wait(() => evaluate('window.__nativeUiPointerReceipt'), 'native pointer receipt')
    const receipt = await evaluate('window.__nativeUiPointerReceipt')
    assert.equal(receipt.trusted && receipt.targetMatched, true, `Native click missed ${selector}: ${json(receipt)}`)
  }
  const button = async (label) => {
    const selector = await evaluate(`(() => {
      const nodes=[...document.querySelectorAll('button')];
      const node=nodes.find(node=>node.textContent.trim()===${json(label)});
      if(!node) throw new Error('Button not found: '+${json(label)});
      node.dataset.unifiedTestTarget='button'; return 'button[data-unified-test-target="button"]';
    })()`)
    await click(selector)
    await evaluate(`document.querySelector('button[data-unified-test-target]')?.removeAttribute('data-unified-test-target')`)
  }
  const key = async (key, code, windowsVirtualKeyCode) => {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode,
      ...(key === 'Enter' ? { text: '\r', unmodifiedText: '\r' } : {}) })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode })
  }
  const selectAgent = async agentId => {
    await wait(() => evaluate("document.querySelector('.unified-conversation .clibtn')?.disabled === false"), 'Agent picker available')
    await click('.unified-conversation .clibtn')
    await click(`.climenu .mitem[data-agent-id="${agentId}"]`)
    await wait(() => evaluate(`document.querySelector('.unified-conversation .clibtn')?.dataset.agentId === ${json(agentId)}`), 'next Agent selected')
  }
  const compose = async (prompt, direction) => {
    await click('textarea[aria-label="描述任务"]')
    await cdp.send('Input.insertText', { text: prompt })
    if (direction) await selectAgent(direction === 'ArrowDown' ? 'codex' : 'claude')
  }
  const confirm = async () => {
    await wait(() => evaluate("document.querySelector('.unified-conversation .send')?.disabled === false"), 'send ready')
    await button('发送')
    await wait(() => evaluate(`document.querySelector('textarea[aria-label="描述任务"]').value === ''`), 'send registered by production IPC')
    assert.equal(await evaluate("Boolean(document.querySelector('.unified-preview:not(.unified-delete):not(.unified-adoption)'))"), false, 'normal sends never open a history confirmation dialog')
  }
  return { click, button, key, selectAgent, compose, confirm }
}
