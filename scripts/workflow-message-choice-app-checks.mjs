import assert from 'node:assert/strict'

/** Production composer → preload → Main, with the explicitly offline adapter. */
export async function checkWorkflowMessageChoiceApp({ evaluate, click, wait, input, submit, conversationOf, waitIdle, readInputs, conversationId }) {
  const entry = `.sidebar [data-conversation-id=${JSON.stringify(conversationId)}]`
  await wait(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(entry)}))`), 'stored conversation sidebar entry')
  await click(entry)
  await wait(() => evaluate(`document.querySelector('.conversation-chat')?.dataset.conversationId === ${JSON.stringify(conversationId)}`), 'current composer')
  const prior = await conversationOf(conversationId)
  const enabled = await submit(conversationId, prior.revision, '/scry-workflow mode auto')
  assert.equal(enabled.action, 'mode_updated')
  await click('.conversation-toolbar > button')
  await wait(() => evaluate(`document.querySelector('[data-workflow-mode=conversation]')?.value === 'auto'`), 'composer refreshed after mode change')
  const calls = (await readInputs()).length
  const choice = value => `.conversation-message-choice input[value="${value}"]`
  const checked = value => evaluate(`document.querySelector(${JSON.stringify(choice(value))}).checked`)
  assert.equal(await checked('default'), true)
  await click(choice('direct'))
  assert.equal(await checked('direct'), true)
  await click('textarea[aria-label="描述任务"]')
  await input('Input.insertText', { text: 'actual composer one-message direct' })
  await click('button.send')
  await wait(async () => (await readInputs()).length === calls + 1, 'one direct call, no routing')
  await waitIdle(conversationId, 'composer direct turn settled')
  await wait(() => checked('default'), 'direct override consumed')
  const recorded = (await readInputs()).at(-1)
  assert.equal(recorded.prompt, 'actual composer one-message direct')
  assert.notEqual(recorded.purpose, 'workflow_authoring')
  assert.equal((await conversationOf(conversationId)).workflowMode, 'auto')

  const beforeTasks = await evaluate(`window.scry.workflow.capturedTasks(${JSON.stringify(conversationId)})`)
  await wait(() => evaluate('!document.querySelector(".conversation-message-choice").disabled'), 'renderer observes settled direct turn')
  await click(choice('workflow'))
  assert.equal(await checked('workflow'), true)
  await click('textarea[aria-label="描述任务"]')
  await input('Input.insertText', { text: 'actual composer workflow capture only' })
  await wait(() => evaluate('!document.querySelector("button.send").disabled'), 'workflow draft ready to send')
  await click('button.send')
  await wait(() => evaluate('Boolean(document.querySelector(".workflow-goal textarea"))'), 'workflow configuration, not execution')
  assert.equal(await checked('default'), true)
  assert.equal((await readInputs()).length, calls + 1, 'workflow override captures without a planner or worker call')
  assert.equal((await conversationOf(conversationId)).workflowMode, 'auto', 'neither choice mutates conversation mode')
  const tasks = await evaluate(`window.scry.workflow.capturedTasks(${JSON.stringify(conversationId)})`)
  const newTasks = tasks.items.filter(task => !beforeTasks.items.some(previous => previous.submissionId === task.submissionId))
  assert.equal(newTasks.length, 1)
  assert.equal(newTasks[0].phase, 'captured')
  const captured = await evaluate(`window.scry.workflow.inspectTask(${JSON.stringify(newTasks[0].reference)})`)
  assert.equal(captured.command, '/scry-workflow run actual composer workflow capture only')
  await click('.workflow-modal .workflow-actions > button:first-child')
  await wait(() => evaluate('!document.querySelector(".workflow-modal")'), 'close unapproved configuration')
  const beforeRestore = await conversationOf(conversationId)
  const restored = await submit(conversationId, beforeRestore.revision, '/scry-workflow mode manual')
  assert.equal(restored.mode, 'manual')
  return { trustedComposerDirect: true, noRoutingForDirect: true, workflowCaptureOnly: true,
    choicesConsumed: true, conversationModeUnchanged: true, providerCalls: calls + 1 }
}
