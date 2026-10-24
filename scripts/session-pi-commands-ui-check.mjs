export async function exercisePiCommands(contents) {
  // Selection, focus and input values can change without a DOM mutation.
  const wait = async (condition) => {
    const deadline = Date.now() + 5000
    while (!await contents.executeJavaScript(condition)) {
      if (Date.now() > deadline) throw new Error(`Pi command UI condition failed: ${condition}; answers=${await contents.executeJavaScript(`document.querySelector('#pi-command-answers').textContent`)}`)
      await contents.executeJavaScript('new Promise(resolve => requestAnimationFrame(resolve))')
    }
  }
  const click = async (selector) => {
    const point = await contents.executeJavaScript(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!node) throw new Error('Missing Pi command control: ' + ${JSON.stringify(selector)});
      node.scrollIntoView({ block: 'center' });
      const rect = node.getBoundingClientRect();
      const x = Math.round(rect.left + rect.width / 2), y = Math.round(rect.top + rect.height / 2);
      if (!node.contains(document.elementFromPoint(x, y))) throw new Error('Pi command control is obscured');
      return { x, y };
    })()`)
    contents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 })
    contents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 })
  }
  const enter = async (modifiers = []) => {
    contents.sendInputEvent({ type: 'keyDown', keyCode: 'Return', modifiers })
    contents.sendInputEvent({ type: 'char', keyCode: '\r', modifiers })
    contents.sendInputEvent({ type: 'keyUp', keyCode: 'Return', modifiers })
    await contents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  }
  contents.focus()
  const agentTrigger = '#model-effort .clibtn'
  const piChoice = (id) => `#model-effort .agent-option-pick[data-agent-id="${id}"]`
  await click(agentTrigger)
  await wait(`document.querySelectorAll('#model-effort .agent-option-pick').length === 2`)
  if (!await contents.executeJavaScript(`document.querySelector(${JSON.stringify(piChoice('pi:rotom'))})?.textContent.includes('系统检测') && !document.querySelector(${JSON.stringify(piChoice('pi:564f7a994e4e34da'))})`)) throw new Error('Duplicate Rotom picker entry or incorrect detection label')
  await click(piChoice('pi:rotom'))
  await wait(`document.querySelector('${agentTrigger}').dataset.agentId === 'pi:rotom' && !document.querySelector('#model-effort .climenu')`)
  await click('#restore-pi-profile')
  await wait(`document.querySelector('${agentTrigger}').dataset.agentId === 'pi:564f7a994e4e34da' && !document.querySelector('#model-effort .climenu')`)
  await click(agentTrigger)
  await wait(`document.querySelectorAll('#model-effort .agent-option-pick').length === 2`)
  if (!await contents.executeJavaScript(`document.querySelector(${JSON.stringify(piChoice('pi:564f7a994e4e34da'))})?.textContent.includes('当前') && !document.querySelector(${JSON.stringify(piChoice('pi:rotom'))})`)) throw new Error('Historical Profile identity was silently switched')
  await click(piChoice('pi:1234567890abcdef'))
  await wait(`document.querySelector('${agentTrigger}').dataset.agentId === 'pi:1234567890abcdef' && !document.querySelector('#model-effort .climenu')`)
  await click(agentTrigger)
  await wait(`document.querySelectorAll('#model-effort .agent-option-pick').length === 2 && document.querySelector(${JSON.stringify(piChoice('pi:rotom'))}) != null`)
  await click(piChoice('pi:rotom'))
  await wait(`document.querySelector('${agentTrigger}').dataset.agentId === 'pi:rotom' && !document.querySelector('#model-effort .climenu')`)
  const single = '#pi-single-questionnaire'
  const selectedCount = `document.querySelectorAll('${single} input[type="checkbox"]:checked').length`
  await wait(`document.querySelectorAll('${single} input[type="checkbox"]').length === 3 && document.querySelector('${single} .question-submit').disabled`)
  await click(`${single} .question-option:nth-child(1)`)
  await wait(`document.querySelector('${single} .question-option:nth-child(1) input').checked`)
  await click(`${single} .question-option:nth-child(2)`)
  await wait(`${selectedCount} === 2`)
  // Toggling one choice must preserve the other; Space must work on the focused checkbox.
  await click(`${single} .question-option:nth-child(1)`)
  await wait(`${selectedCount} === 1 && document.querySelector('${single} .question-option:nth-child(2) input').checked`)
  contents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' })
  contents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' })
  await wait(`${selectedCount} === 2 && document.querySelector('#pi-single-reply').textContent === 'null'`)
  await click(`${single} .question-submit`)
  await wait(`JSON.parse(document.querySelector('#pi-single-reply').textContent)?.value === '1,2'`)
  const singleReply = await contents.executeJavaScript(`JSON.parse(document.querySelector('#pi-single-reply').textContent)`)
  if (singleReply.type !== 'extension_ui_response' || singleReply.id !== 'single-input') throw new Error('Single multi-select reply did not use the native Pi protocol')

  const field = (index) => `#pi-questionnaire .question-field:nth-child(${index})`
  const batchAnswers = `JSON.parse(document.querySelector('#pi-questionnaire-answers').textContent)`
  await wait(`document.querySelectorAll('#pi-questionnaire .question-field').length === 3 && document.querySelector('#pi-questionnaire .question-submit').textContent.includes('提交全部答案') && document.querySelector('#pi-questionnaire .question-status').textContent.includes('还有 3 题待回答')`)
  await click(`${field(1)} .question-option:nth-child(1)`)
  await wait(`document.querySelector('${field(1)} .question-option:nth-child(1) input').checked`)
  await click(`${field(2)} .question-option:nth-child(1)`)
  await wait(`document.querySelector('${field(2)} .question-option:nth-child(1) input').checked`)
  await click(`${field(2)} .question-option:nth-child(2)`)
  await wait(`document.querySelectorAll('${field(2)} .question-option.selected').length === 2`)
  await click(`${field(3)} .question-other`)
  await wait(`document.activeElement === document.querySelector('${field(3)} .question-other-input')`)
  await contents.insertText('1')
  await wait(`document.querySelector('${field(3)} .question-other-input').value === '1'`)
  // Revisit the first answer after completing the later questions, using real pointer input.
  await click(`${field(1)} .question-option:nth-child(2)`)
  await wait(`document.querySelector('${field(1)} .question-option:nth-child(2) input').checked`)
  if (!await contents.executeJavaScript(`${batchAnswers}.length === 0 && document.querySelectorAll('${field(2)} .question-option.selected').length === 2 && document.querySelector('${field(3)} .question-other-input').value === '1'`)) throw new Error('Review submitted early or lost later questionnaire drafts')
  // Native Pi multi-select accepts indices OR custom text, never a mixed response.
  await click(`${field(2)} .question-other`)
  await wait(`document.activeElement === document.querySelector('${field(2)} .question-other-input')`)
  await contents.insertText('Custom scope')
  await wait(`document.querySelector('${field(2)} .question-other-input').value === 'Custom scope'`)
  if (!await contents.executeJavaScript(`document.querySelectorAll('${field(2)} .question-option.selected:not(.question-other)').length === 0`)) throw new Error('Native multi-select retained incompatible custom and indexed answers')
  await click(`${field(2)} .question-option:nth-child(1)`)
  await wait(`document.querySelector('${field(2)} .question-other-input') == null && document.querySelector('${field(2)} .question-option:nth-child(1) input').checked`)
  await click(`${field(2)} .question-option:nth-child(2)`)
  await wait(`document.querySelectorAll('${field(2)} .question-option.selected').length === 2 && !document.querySelector('#pi-questionnaire .question-submit').disabled`)
  await click('#pi-questionnaire .question-submit')
  await wait(`${batchAnswers}.length === 1`)
  const batch = await contents.executeJavaScript(`${batchAnswers}[0]`)
  if (JSON.stringify(batch.answers) !== JSON.stringify({ 'What matters?': '2', 'Which parts?': '1,2', 'When to review?': '1' }) || JSON.stringify(batch.nativeCustomAnswers) !== JSON.stringify(['When to review?'])) throw new Error('Grouped questionnaire did not submit the reviewed answers with custom intent')
  await click('#pi-questionnaire-restart')
  await wait(`${batchAnswers}.length === 0 && document.querySelectorAll('#pi-questionnaire .question-option.selected').length === 0`)
  await click(`${field(1)} .question-option:nth-child(1)`)
  await click('#pi-questionnaire .question-cancel')
  await wait(`${batchAnswers}.length === 1 && ${batchAnswers}[0].behavior === 'cancelled'`)

  await click('#pi-command .question-option')
  await wait(`document.querySelector('#pi-command .question-option.selected') != null`)
  await click('#pi-command .question-submit')
  await wait(`document.querySelector('#pi-command textarea')?.value === 'Existing objective'`)
  await click('#pi-command textarea')
  if (!await contents.executeJavaScript(`document.activeElement === document.querySelector('#pi-command textarea')`)) throw new Error('Pi editor did not receive focus')
  contents.selectAll()
  await wait(`(() => { const input = document.querySelector('#pi-command textarea'); return input.selectionStart === 0 && input.selectionEnd === input.value.length })()`)
  await contents.insertText('Updated objective')
  await wait(`document.querySelector('#pi-command textarea')?.value === 'Updated objective'`)
  await enter()
  await wait(`document.querySelector('#pi-command textarea')?.value === 'Updated objective\\n'`)
  if (!await contents.executeJavaScript(`JSON.parse(document.querySelector('#pi-command-answers').textContent).length === 1`)) throw new Error('Multiline Enter submitted instead of inserting a newline')
  await contents.insertText('Second line')
  await wait(`document.querySelector('#pi-command textarea')?.value === 'Updated objective\\nSecond line'`)
  await enter(['control'])
  await wait(`document.querySelector('#pi-command').textContent.includes('Save changes?')`)
  await click('#pi-command .question-option')
  await wait(`document.querySelector('#pi-command .question-option.selected') != null`)
  await click('#pi-command .question-submit')
  // Command results and extension messages/notifications have distinct evidence
  // roles since 3caef80; require all three, not three mislabeled command results.
  for (const [label, text] of [
    ['Pi 命令反馈', 'Command interaction ended; model turn unobserved'],
    ['Pi 扩展消息', 'Custom command status'],
    ['Pi 扩展通知', 'Pi extension notification']
  ]) {
    const selector = `#pi-command [aria-label="${label}"]`
    await wait(`document.querySelectorAll(${JSON.stringify(selector)}).length === 1 && document.querySelector(${JSON.stringify(selector)}).textContent.includes(${JSON.stringify(text)})`)
  }
  const answers = await contents.executeJavaScript(`JSON.parse(document.querySelector('#pi-command-answers').textContent)`)
  if (answers.length !== 3 || answers[1].answers['Edit objective'] !== 'Updated objective\nSecond line') throw new Error(`Pi chained answers lost their identity or edited content: ${JSON.stringify(answers)}`)
  await click('#pi-command-restart')
  await wait(`document.querySelector('#pi-command .question-cancel') != null`)
  await click('#pi-command .question-cancel')
  await wait(`JSON.parse(document.querySelector('#pi-command-answers').textContent)[0]?.behavior === 'cancelled'`)
  await click('#pi-command-restart')
  await wait(`document.querySelector('#pi-command .question-option') != null`)
  await click('#pi-command .question-option')
  await wait(`document.querySelector('#pi-command .question-option.selected') != null`)
  await click('#pi-command .question-submit')
  await wait(`document.querySelector('#pi-command textarea')?.value === 'Existing objective'`)
  for (const cancelInput of [false, true]) {
    await click('#pi-command-restart')
    await wait(`document.querySelectorAll('#pi-command .question-option').length === 2`)
    await click('#pi-command .question-other')
    await wait(`document.querySelector('#pi-command .question-other-input') != null`)
    if (!await contents.executeJavaScript(`document.activeElement === document.querySelector('#pi-command .question-other-input')`)) throw new Error('Native custom-answer input did not receive focus')
    if (!await contents.executeJavaScript(`document.querySelectorAll('#pi-command .question-option').length === 2 && document.querySelector('#pi-command').textContent.includes('Choose an action') && document.querySelector('#pi-command .question-submit').disabled && JSON.parse(document.querySelector('#pi-command-answers').textContent).length === 0`)) throw new Error('Selecting custom answer replaced or submitted the native question')
    await enter()
    if (!await contents.executeJavaScript(`document.querySelector('#pi-command .question-submit').disabled && JSON.parse(document.querySelector('#pi-command-answers').textContent).length === 0`)) throw new Error('Empty custom answer submitted on Enter')
    const customAnswer = cancelInput ? '提交所有改动 保证工作区干净 然后构建并安装' : 'Edit'
    await contents.insertText(customAnswer)
    await wait(`document.querySelector('#pi-command .question-other-input').value === ${JSON.stringify(customAnswer)}`)
    for (const composition of [{ isComposing: true }, { keyCode: 229 }]) {
      await contents.executeJavaScript(`document.querySelector('#pi-command .question-other-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...${JSON.stringify(composition)} })); new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
      if (!await contents.executeJavaScript(`JSON.parse(document.querySelector('#pi-command-answers').textContent).length === 0`)) throw new Error('IME confirmation submitted the custom answer')
    }
    await click('#pi-command .question-option:first-child')
    await wait(`document.querySelector('#pi-command .question-other-input') == null && document.querySelector('#pi-command .question-option:first-child').classList.contains('selected') && !document.querySelector('#pi-command .question-submit').disabled`)
    await click('#pi-command .question-other')
    await wait(`document.querySelector('#pi-command .question-other-input')?.value === ${JSON.stringify(customAnswer)}`)
    if (!await contents.executeJavaScript(`document.activeElement === document.querySelector('#pi-command .question-other-input') && JSON.parse(document.querySelector('#pi-command-answers').textContent).length === 0`)) throw new Error('Switching choices lost focus or submitted a draft')
    if (cancelInput) {
      await click('#pi-command .question-cancel')
      await wait(`JSON.parse(document.querySelector('#pi-command-answers').textContent)[0]?.behavior === 'cancelled'`)
      continue
    }
    await enter()
    await wait(`document.querySelector('#pi-command').textContent.includes('Save changes?')`)
    const customAnswers = await contents.executeJavaScript(`JSON.parse(document.querySelector('#pi-command-answers').textContent)`)
    if (customAnswers.length !== 1 || customAnswers[0].answers['Choose an action'] !== customAnswer || customAnswers[0].nativeCustomAnswer !== true) throw new Error('Native custom-answer submission lost text')
  }
  return { piPickerAliases: true, piPickerHistoryIdentity: true, piPickerDistinctLauncher: true, piSingleMultiSelect: true, piSingleToggleAndKeyboard: true, piSingleNativeReply: true, piGroupedReview: true, piGroupedDraftRetention: true, piGroupedSubmitOnce: true, piGroupedCancel: true, piMenuChain: true, piEditorPrefill: true, piInlineCustomInput: true, piCancelAndReopen: true, piCommandFeedback: true, piCustomAnswerChain: true, piCustomInputCancel: true, piCustomChoiceReversible: true, customAnswerEnter: true, emptyEnterIgnored: true, compositionEnterIgnored: true, multilineEnterPreserved: true, controlEnterSubmit: true }
}
