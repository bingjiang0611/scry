import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'

// Production App/composer/IPC/trace persistence with only the Provider replaced.
// Never uses real credentials or dispatches a real Provider request.
export async function exerciseTerminalSteer({ cdp, evaluate, workspace, conversationInputs, userDataDir }) {
  const wait = expression => evaluate(`new Promise((resolve, reject) => {
    const check = () => { if (${expression}) { clearTimeout(timer); observer.disconnect(); resolve(true) } }
    const observer = new MutationObserver(check)
    const timer = setTimeout(() => { observer.disconnect(); reject(new Error(${JSON.stringify(`Steer App condition timed out: ${expression}`)})) }, 10000)
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true })
    check()
  })`)
  const click = async selector => {
    const point = await evaluate(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)})
      if (!node || node.disabled) throw new Error('Missing or disabled control: ' + ${JSON.stringify(selector)})
      const box = node.getBoundingClientRect()
      const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
      if (!node.contains(document.elementFromPoint(point.x, point.y))) throw new Error('Control occluded')
      return point
    })()`)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
  }
  const send = async text => {
    await click('textarea')
    await cdp.send('Input.insertText', { text })
    await wait("document.querySelector('button.send:not(:disabled)')")
    await click('button.send')
    await wait("document.querySelector('textarea')?.value === ''")
  }
  await wait('window.scry && document.querySelector("textarea")')
  const { runId } = await evaluate(`(async () => {
    const run = await window.scry.start({ providerId: 'codex', cwd: ${JSON.stringify(workspace)}, prompt: 'native composer stop-visible terminal-steer' })
    await window.scry.focusRun(run.runId)
    return run
  })()`)
  await wait("document.querySelector('button.run-status-stop:not(:disabled)')")
  await send('steer-unknown')
  await wait("document.querySelector('.queue-steer:not(:disabled)')")
  await click('.queue-steer')
  await wait("document.querySelector('.queue-item.is-steer-unknown')")
  assert.equal(await evaluate("document.querySelector('.queue-remove').disabled"), true, 'an active unknown dispatch cannot be dismissed')
  const messageId = await evaluate("document.querySelector('.queue-item').dataset.motionKey")
  assert.ok(messageId)
  await click('button.run-status-stop')
  await wait("!document.querySelector('button.run-status-stop') && document.querySelector('.queue-remove:not(:disabled)')")
  assert.match(await evaluate("document.querySelector('.queue-remove').title"), /不会撤回或重发/)
  await send('after-terminal-steer')
  await wait("document.querySelectorAll('.queue-item').length === 2")
  const inputs = () => readFileSync(conversationInputs, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
  assert.equal(inputs().filter(item => item.prompt === 'after-terminal-steer').length, 0, 'unknown head still blocks automatic dispatch')
  await click('.queue-remove')
  await wait("document.querySelectorAll('.queue-item').length === 0 && !document.querySelector('button.run-status-stop')")
  const receiptSelector = `.steer-evidence[data-steer-message-id="${messageId}"]`
  await wait(`document.querySelector(${JSON.stringify(receiptSelector)})?.textContent.includes('结果未知')`)
  const recordedInputs = inputs()
  assert.equal(recordedInputs.filter(item => item.operation === 'steer' && item.prompt === 'steer-unknown').length, 1)
  assert.equal(recordedInputs.filter(item => !item.operation && item.prompt === 'steer-unknown').length, 0, 'dismissal must not replay the unknown message')
  assert.equal(recordedInputs.filter(item => !item.operation && item.prompt === 'after-terminal-steer').length, 1, 'the next queued message must really reach the Provider once')
  const archiveRoot = join(userDataDir, 'trace-archive-turns-v1')
  const turns = readdirSync(archiveRoot, { recursive: true }).filter(name => /^turn-.*\.json$/.test(basename(name)))
    .flatMap(name => JSON.parse(readFileSync(join(archiveRoot, name), 'utf8')).turns)
  const turn = turns.find(item => item.runId === runId)
  assert.equal(turn?.done, true)
  const receipts = turn.items.filter(item => item.steer?.messageId === messageId)
  assert.equal(receipts.at(-1)?.steer.status, 'unknown', 'dismissal must preserve the durable unknown receipt')
  cdp.close()
  console.log(JSON.stringify({ productionApp: true, activeUnknownProtected: true, terminalDismissal: true,
    unknownNotReplayed: true, subsequentPromptDispatchedOnce: true, unknownReceiptPersisted: true }))
}
