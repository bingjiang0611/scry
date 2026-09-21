import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import electron from 'electron'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const temp = await mkdtemp(join(tmpdir(), 'scry-capability-ui-'))
const selectionOnly = process.argv.includes('--selection-only')
const piCommandsOnly = process.argv.includes('--pi-commands-only')
const fixtures = piCommandsOnly ? ['session-capability'] : selectionOnly ? ['session-selection'] : ['session-capability', 'session-selection', 'pi-permission']

// Real React DOM events in an invisible, sandboxed Electron fixture. This does not launch
// Scry's main process or preload, discover providers, touch user data, or start a CDP port.
async function exercise() {
  const text = (selector) => document.querySelector(selector)?.textContent ?? ''
  const check = (condition, message) => { if (!condition) throw new Error(message) }
  const waitFor = (predicate) => new Promise((resolve, reject) => {
    if (predicate()) return resolve()
    const observer = new MutationObserver(() => {
      if (predicate()) { clearTimeout(timer); observer.disconnect(); resolve() }
    })
    const timer = setTimeout(() => { observer.disconnect(); reject(new Error(`DOM condition timed out: ${predicate.toString()}`)) }, 5000)
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true })
  })
  const button = (scope, fragment) => {
    const node = [...document.querySelectorAll(`${scope} button`)].find((element) => element.textContent.includes(fragment))
    check(node, `Missing button ${fragment}`)
    return node
  }
  await waitFor(() => document.querySelector('#chrome [data-pinned-summary-toggle]') != null)
  const thinking = document.querySelector('#thinking details.thinking')
  const finalText = document.querySelector('#thinking .model-text')
  check(thinking?.open === true, 'Thinking disclosure must be expanded by default')
  check(text('#thinking').includes('思考过程'), 'Thinking disclosure label missing')
  check(parseFloat(getComputedStyle(thinking).fontSize) < parseFloat(getComputedStyle(finalText).fontSize), 'Thinking text is not visually subordinate to the final answer')
  thinking.querySelector('summary').click()
  await waitFor(() => thinking.open === false && thinking.querySelector('.think-text') == null)
  thinking.querySelector('summary').click()
  await waitFor(() => thinking.open === true && thinking.querySelector('.think-text')?.getBoundingClientRect().height > 0)

  const permissionTrigger = document.querySelector('#model-effort [aria-label="权限"]')
  const agentTrigger = document.querySelector('#model-effort .clibtn')
  const modelEffortTrigger = document.querySelector('#model-effort [aria-label="选择 Model 与 Effort"]')
  check(modelEffortTrigger.textContent.includes('Ultimate') && modelEffortTrigger.textContent.includes('默认'), 'Combined Model/Effort trigger lost current values')
  permissionTrigger.click()
  await waitFor(() => document.querySelector('#model-effort [aria-label="Agent 操作审批方式"]') != null)
  check(text('#model-effort').includes('如何批准 Agent 操作？'), 'Permission popover heading is missing')
  check(document.querySelectorAll('#model-effort [role="option"]').length === 3, 'Permission popover lost Provider options')
  check(document.querySelector('#model-effort [role="option"][aria-selected="true"]')?.textContent.includes('默认审批'), 'Permission popover lost current selection')
  const autoReviewOption = [...document.querySelectorAll('#model-effort [role="option"]')].find((option) => option.textContent.includes('自动审查'))
  autoReviewOption.click()
  await waitFor(() => permissionTrigger.textContent.includes('自动审查'))
  check(document.querySelector('#model-effort [aria-label="Agent 操作审批方式"]') == null, 'Permission selection did not close the popover')
  permissionTrigger.click()
  await waitFor(() => document.querySelector('#model-effort [aria-label="Agent 操作审批方式"]') != null)
  agentTrigger.click()
  await waitFor(() => document.querySelector('#model-effort .climenu') != null)
  check(document.querySelector('#model-effort [aria-label="Agent 操作审批方式"]') == null, 'Permission and Agent menus overlapped')
  modelEffortTrigger.click()
  await waitFor(() => document.querySelector('#model-effort [aria-label="Model 与 Effort"]') != null)
  check(document.querySelector('#model-effort .climenu') == null, 'Agent and Model/Effort menus overlapped')
  check(text('#model-effort').includes('Ultimate'), 'Initial Model row is missing')
  const effortPopover = document.querySelector('#model-effort .model-effort-popover')
  const currentModelButton = document.querySelector('#model-effort .model-effort-current')
  const effortLabel = effortPopover.querySelector('.model-effort-current-effort')
  const modelLabel = currentModelButton.querySelector('.model-effort-current-model')
  const drillChevron = currentModelButton.querySelector('.chev')
  const effortSlider = document.querySelector('#model-effort [aria-label="推理强度"]')
  const effortDots = [...document.querySelectorAll('#model-effort .model-effort-slider-dots i')]
  check(effortSlider?.type === 'range' && effortSlider.max === '5', 'Six-option Effort slider is incomplete')
  check(effortDots.length === 6, 'Effort slider dots do not match Provider options')
  const effortTop = effortDots[0].getBoundingClientRect().top
  check(effortDots.every((dot) => Math.abs(dot.getBoundingClientRect().top - effortTop) < 1), 'Effort slider dots wrapped onto multiple rows')
  check(document.querySelector('#model-effort .model-effort-summary-bolt') == null, 'Removed bolt icon is still rendered')
  check(document.querySelector('#model-effort [aria-label="重置 Effort"]') == null, 'Removed Effort reset is still rendered')
  check(effortPopover.getBoundingClientRect().width <= 260, 'Model/Effort popover is wider than the compact reference')
  check(document.querySelector('#model-effort .model-effort-slider').getBoundingClientRect().height <= 32, 'Effort slider is taller than the compact design')
  check(effortLabel.textContent.includes('默认'), 'Current Effort value is missing')
  check(modelLabel.textContent.includes('Ultimate'), 'Current Model value is missing')
  check(modelLabel.getBoundingClientRect().bottom <= effortLabel.getBoundingClientRect().top + 2, 'Model and Effort rows are out of order')
  check(text('#model-effort').includes('模型') && text('#model-effort').includes('推理强度'), 'Model/Effort field labels are missing')
  check(drillChevron.getBoundingClientRect().left > modelLabel.getBoundingClientRect().right, 'Model drill-in chevron is misplaced')

  const rangeValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  check(rangeValueSetter, 'Range input value setter unavailable')
  rangeValueSetter.call(effortSlider, '2')
  effortSlider.dispatchEvent(new Event('input', { bubbles: true }))
  effortSlider.dispatchEvent(new Event('change', { bubbles: true }))
  await waitFor(() => modelEffortTrigger.textContent.includes('Ultimate') && modelEffortTrigger.textContent.includes('高'))
  check(document.querySelector('#model-effort [aria-label="Model 与 Effort"]') != null, 'Effort slider unexpectedly closed the popover')

  currentModelButton.click()
  await waitFor(() => document.querySelector('#model-effort [aria-label="选择 Model"]') != null)
  const modelList = document.querySelector('#model-effort [aria-label="选择 Model"]')
  check(getComputedStyle(modelList).scrollbarWidth === 'none', 'Model list scrollbar is still visible')
  await new Promise((resolve) => setTimeout(resolve, 0))
  check(document.activeElement?.getAttribute('aria-selected') === 'true', 'Selected Model did not receive focus after drill-in')
  document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
  await new Promise((resolve) => requestAnimationFrame(() => resolve()))
  check(document.activeElement?.textContent.includes('Performance'), 'ArrowDown did not move focus to the next Model')
  document.activeElement.click()
  await waitFor(() => modelEffortTrigger.textContent.includes('Performance') && modelEffortTrigger.textContent.includes('默认'))
  document.querySelector('#model-effort .model-effort-current').click()
  await waitFor(() => document.querySelector('#model-effort [aria-label="选择 Model"]') != null)
  await new Promise((resolve) => setTimeout(resolve, 0))
  check(document.activeElement?.textContent.includes('Performance'), 'Current Model did not receive focus on repeated drill-in')
  document.activeElement.click()
  await waitFor(() => modelEffortTrigger.textContent.includes('Performance') && modelEffortTrigger.textContent.includes('默认'))
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await waitFor(() => document.querySelector('#model-effort [aria-label="Model 与 Effort"]') == null)

  check(document.querySelector('#pinned aside') == null, 'Summary should be hidden by default')
  const initialSummaryToggle = document.querySelector('#chrome [data-pinned-summary-toggle]')
  check(initialSummaryToggle.getAttribute('aria-pressed') === 'false', 'Summary toggle should start unpressed')
  initialSummaryToggle.click()
  await waitFor(() => document.querySelector('#pinned aside') != null)
  check(button('#pinned', 'hsf-invoke').textContent.includes('×1'), 'Pinned call count missing')
  check(!text('#pinned').includes('加载推断'), 'Pinned inference suffix should stay out of the compact row')
  check(document.querySelector('#overview [aria-label="Skill 1，展开明细"]') != null, 'Overview disagrees with pinned count')

  button('#pinned', 'hsf-invoke').click()
  await waitFor(() => document.querySelector('#selection').dataset.clicks === '1')
  const original = JSON.parse(text('#selection'))
  check(original.kind === 'tool' && original.tool === 'Read' && original.source === null, 'Pinned click must expose original Read, not a synthetic event')
  document.querySelector('#overview-session-tab').click()
  await waitFor(() => !document.querySelector('#overview-session-panel').hidden)
  button('#overview .panel-section', 'hsf-invoke（含加载推断）').click()
  await waitFor(() => document.querySelector('#selection').dataset.clicks === '2')
  check(text('#selection') === JSON.stringify(original), 'Overview must navigate to the same original Read')
  button('#pinned', 'browser / navigate').click()
  await waitFor(() => document.querySelector('#selection').dataset.clicks === '3')
  check(JSON.parse(text('#selection')).tool === 'mcp__browser__navigate', 'MCP navigation lost tool identity')

  const toggle = button('#pinned', 'Skills & MCP')
  const controlledDetail = () => document.getElementById(toggle.getAttribute('aria-controls'))
  toggle.click()
  await waitFor(() => toggle.getAttribute('aria-expanded') === 'false')
  check(controlledDetail()?.hidden === true, 'Collapsed detail remained exposed')
  check(getComputedStyle(controlledDetail()).display === 'none', 'Production CSS displayed a hidden detail')
  toggle.click()
  await waitFor(() => toggle.getAttribute('aria-expanded') === 'true' && controlledDetail()?.hidden === false)
  check(getComputedStyle(controlledDetail()).display === 'flex', 'Expanded detail remained visually hidden')
  toggle.click()
  await waitFor(() => toggle.getAttribute('aria-expanded') === 'false')
  const summaryToggle = document.querySelector('#chrome [data-pinned-summary-toggle]')
  const panelToggle = button('#chrome', '面板')
  summaryToggle.click()
  await waitFor(() => document.querySelector('#pinned aside') == null)
  check(summaryToggle.getAttribute('aria-pressed') === 'false', 'Persistent summary button stayed pressed after collapse')
  summaryToggle.click()
  await waitFor(() => document.querySelector('#pinned aside') != null)
  let remountedToggle = button('#pinned', 'Skills & MCP')
  check(remountedToggle.getAttribute('aria-expanded') === 'false', 'Restoring the persistent summary reset its disclosure')
  panelToggle.click()
  await waitFor(() => document.querySelector('#pinned aside') == null)
  summaryToggle.click()
  await waitFor(() => document.querySelector('#pinned aside') != null)
  remountedToggle = button('#pinned', 'Skills & MCP')
  const remountedDetail = document.getElementById(remountedToggle.getAttribute('aria-controls'))
  check(remountedToggle.getAttribute('aria-expanded') === 'false', 'Opening the summary overlay reset its disclosure')
  check(remountedDetail?.hidden === true, 'Remounted detail became visible')
  check(getComputedStyle(remountedDetail).display === 'none', 'Remounted collapsed detail is visually exposed')
  remountedToggle.click()
  await waitFor(() => remountedToggle.getAttribute('aria-expanded') === 'true')
  document.querySelector('#hooks').click()
  await waitFor(() => text('#overview').includes('检查 Hook 展开'))
  const hooksToggle = button('#overview .turn-call-groups', 'Hooks')
  hooksToggle.click()
  await waitFor(() => document.querySelector('#overview .turn-hook-item')?.open === true)
  const hookPhase = document.querySelector('#overview .turn-hook-phase')
  check(hookPhase.open === true, 'Opening Hooks should expand its phases')
  hookPhase.querySelector('summary').click()
  await waitFor(() => hookPhase.open === false)
  hooksToggle.click()
  await waitFor(() => document.querySelector('#overview .turn-hook-phase') == null)
  hooksToggle.click()
  await waitFor(() => document.querySelector('#overview .turn-hook-phase')?.open === true)
  check(document.querySelector('#overview .turn-hook-item').open === true, 'Reopening Hooks should expand handler details')

  document.querySelector('#empty').click()
  await waitFor(() => text('#pinned').includes('尚未观测到'))
  check(!text('#pinned').includes('hsf-invoke') && !text('#pinned').includes('browser / navigate'), 'New session retained old rows')
  check(!text('#pinned').includes('Web references'), 'Known-zero Web references row remained visible')
  check(document.querySelector('#pinned [data-evidence="unknown"]').textContent === '—', 'Missing evidence became fake zero')

  document.querySelector('#pending').click()
  await waitFor(() => text('#pinned').includes('browser / navigate'))
  check(!text('#pinned').includes('hsf-invoke'), 'Pending Read counted as successful loading')
  document.querySelector('#success').click()
  await waitFor(() => text('#pinned').includes('hsf-invoke') && document.querySelector('#overview [aria-label="Skill 1，展开明细"]') != null)
  check(document.querySelector('#overview [aria-label="Skill 1，展开明细"]') != null, 'Late result did not update Overview')
  document.querySelector('#failed').click()
  await waitFor(() => !text('#pinned').includes('hsf-invoke'))
  check(document.querySelector('#overview [aria-label="Skill 0，无明细"]') != null, `Failed session retained successful Skill count: ${text('#overview').slice(0, 700)}`)
  document.querySelector('#multi').click()
  await waitFor(() => text('#pinned').includes('×2'))
  check(button('#pinned', 'hsf-invoke').textContent.includes('×2'), 'Cross-turn Skill count lost')
  check(button('#pinned', 'browser / navigate').textContent.includes('×2'), 'Cross-turn MCP count lost')
  check(
    [...document.querySelectorAll('#overview .turn-call-group.skill .turn-call-count')]
      .reduce((sum, node) => sum + Number(node.textContent), 0) === 2,
    'Multi-turn consumers disagree'
  )
  const archiveButton = (name) => document.querySelector(`#archive-sidebar [aria-label="存档会话：${name}"]`)
  const sidebarRows = () => document.querySelectorAll('#archive-sidebar .sb-sess-row').length
  await waitFor(() => sidebarRows() === 2)
  // This runs in the same isolated Electron DOM fixture as the Sidebar archive flow. Use a
  // focused row to activate the real :focus-within cascade, then test viewport coordinates rather
  // than only reading CSS source text: the action overlay must expose buttons without creating a
  // pointer-events gap between the overlay and the session button.
  const sidebarRow = document.querySelector('#archive-sidebar .sb-sess-row')
  const sidebarSession = sidebarRow?.querySelector('.sb-sess')
  const sidebarActions = sidebarRow?.querySelector('.sb-sess-acts')
  const sidebarAction = sidebarActions?.querySelector('.sb-act')
  check(sidebarRow && sidebarSession && sidebarActions && sidebarAction, 'Sidebar hit-area fixture is incomplete')
  sidebarAction.focus()
  await new Promise((resolve) => setTimeout(resolve, 0))
  check(sidebarRow.matches(':focus-within'), 'Focused Sidebar row did not activate its focus cascade')
  check(getComputedStyle(sidebarActions).pointerEvents === 'none', 'Sidebar action overlay became a hit-test surface')
  check(getComputedStyle(sidebarAction).pointerEvents === 'auto', 'Focused Sidebar action did not receive pointer events')
  const actionsRect = sidebarActions.getBoundingClientRect()
  const sessionRect = sidebarSession.getBoundingClientRect()
  const actionRect = sidebarAction.getBoundingClientRect()
  const gapHit = document.elementFromPoint(actionsRect.left + Math.min(4, actionsRect.width / 3), sessionRect.top + sessionRect.height / 2)
  check(sidebarSession.contains(gapHit), 'Sidebar overlay padding created a coordinate hit-test gap')
  const actionHit = document.elementFromPoint(actionRect.left + actionRect.width / 2, actionRect.top + actionRect.height / 2)
  check(sidebarAction.contains(actionHit), 'Sidebar action coordinate did not hit the action button')
  archiveButton('归档目标').click()
  await waitFor(() => document.querySelector('#archive-sidebar .sb-proj-row.active') != null)
  await waitFor(() => archiveButton('归档目标') == null)
  check(text('#archive-status') === 'pending', 'Fixture must still be waiting on Provider catalog refresh')
  check(sidebarRows() === 1, 'Archive must remove only its target row')
  button('#archive-sidebar', '撤销').click()
  await waitFor(() => sidebarRows() === 2)
  document.querySelector('#release-catalog').click()
  await waitFor(() => text('#archive-status') === 'settled')
  check(sidebarRows() === 2, 'Late reset completion undid archive reversal')

  button('#archive-sidebar', '归档目标').click()
  await waitFor(() => document.querySelector('#archive-sidebar .sb-sess[aria-current="true"]')?.textContent.includes('归档目标'))
  archiveButton('归档目标').click()
  await waitFor(() => archiveButton('归档目标') == null)
  document.querySelector('#reject-catalog').click()
  await waitFor(() => text('#archive-status') === 'reset-failed')
  check(archiveButton('归档目标') == null, 'Provider catalog failure resurrected the archived row')
  button('#archive-sidebar', '撤销').click()
  await waitFor(() => sidebarRows() === 2)

  button('#archive-sidebar', '归档目标').click()
  await waitFor(() => document.querySelector('#archive-sidebar .sb-sess[aria-current="true"]')?.textContent.includes('归档目标'))
  archiveButton('保留会话').click()
  await waitFor(() => archiveButton('保留会话') == null)
  check(document.querySelector('#archive-sidebar .sb-sess[aria-current="true"]')?.textContent.includes('归档目标'), 'Archiving a background session changed the selected conversation')
  button('#archive-sidebar', '撤销').click()
  await waitFor(() => sidebarRows() === 2)
  document.querySelector('#context-start').click()
  await waitFor(() => text('#overview .ctx-copy .v').includes('100.0k / 272.0k'))
  check(text('#overview').includes('运行中'), 'Context fixture ended before live updates')
  check(text('#overview').includes('未观测到'), 'Missing compaction evidence was displayed as zero')
  document.querySelector('#context-update').click()
  await waitFor(() => text('#overview .ctx-copy .v').includes('201.6k / 272.0k'))
  check(document.querySelector('#overview .ring').getAttribute('aria-label') === '上下文占用 74%', 'Live context gauge did not update')
  check(text('#overview').includes('等待 result'), 'Context snapshots leaked into billing totals')
  document.querySelector('#context-compact').click()
  await waitFor(() => text('#overview .ctx-copy .v').includes('暂无上下文数据'))
  check(text('#overview').includes('Compact1 次'), 'Completed compaction was not counted once')
  document.querySelector('#context-after').click()
  await waitFor(() => text('#overview .ctx-copy .v').includes('20.0k / 272.0k'))
  document.querySelector('#empty').click()
  await waitFor(() => !text('#overview').includes('20.0k / 272.0k'))
  check(!text('#overview').includes('Compact1 次'), 'New session inherited the previous compaction count')
  return { liveContext: true, compactionInvalidation: true, contextSessionReset: true, normalizedWire: true, summaryHiddenByDefault: true, hooksAutoExpand: true, originalEvidenceClicks: 3, collapse: true, thinkingDisclosure: true, modelEffortPicker: true, newSession: true, lateSuccess: true, failedRead: true, multipleTurns: true, sidebarCoordinates: true, sidebarCascade: true, archiveWhileCatalogPending: true, archiveAfterCatalogFailure: true, archiveUndo: true, backgroundArchive: true }
}

async function exercisePiCommands(contents) {
  const wait = (condition) => contents.executeJavaScript(`new Promise((resolve, reject) => {
    const ready = () => (${condition});
    if (ready()) return resolve();
    const observer = new MutationObserver(() => { if (ready()) { clearTimeout(timer); observer.disconnect(); resolve() } });
    const timer = setTimeout(() => { observer.disconnect(); reject(new Error('Pi command UI condition failed')) }, 5000);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
  })`)
  const click = async (selector) => {
    const point = await contents.executeJavaScript(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!node) throw new Error('Missing Pi command control');
      node.scrollIntoView({ block: 'center' });
      const rect = node.getBoundingClientRect();
      const x = Math.round(rect.left + rect.width / 2), y = Math.round(rect.top + rect.height / 2);
      if (!node.contains(document.elementFromPoint(x, y))) throw new Error('Pi command control is obscured');
      return { x, y };
    })()`)
    contents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 })
    contents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 })
  }
  contents.focus()
  await click('#pi-command .question-option')
  await wait(`document.querySelector('#pi-command .question-option.selected') != null`)
  await click('#pi-command .question-submit')
  await wait(`document.querySelector('#pi-command textarea')?.value === 'Existing objective'`)
  await click('#pi-command textarea')
  if (!await contents.executeJavaScript(`document.activeElement === document.querySelector('#pi-command textarea')`)) throw new Error('Pi editor did not receive focus')
  contents.selectAll()
  await contents.insertText('Updated objective')
  await click('#pi-command .question-submit')
  await wait(`document.querySelector('#pi-command').textContent.includes('Save changes?')`)
  await click('#pi-command .question-option')
  await wait(`document.querySelector('#pi-command .question-option.selected') != null`)
  await click('#pi-command .question-submit')
  await wait(`document.querySelectorAll('#pi-command [aria-label="Pi 命令反馈"]').length === 3`)
  const answers = await contents.executeJavaScript(`JSON.parse(document.querySelector('#pi-command-answers').textContent)`)
  if (answers.length !== 3 || answers[1].answers['Edit objective'] !== 'Updated objective') throw new Error('Pi chained answers lost their identity or edited content')
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
    if (await contents.executeJavaScript(`document.querySelector('#pi-command .question-other') != null`)) throw new Error('Native select exposed an invalid free-text answer')
    await click('#pi-command .question-option:nth-child(2)')
    await wait(`document.querySelector('#pi-command .question-option:nth-child(2)').classList.contains('selected')`)
    await click('#pi-command .question-submit')
    await wait(`document.querySelector('#pi-command .question-free-text-input') != null`)
    if (cancelInput) {
      await click('#pi-command .question-cancel')
      await wait(`JSON.parse(document.querySelector('#pi-command-answers').textContent)[1]?.behavior === 'cancelled'`)
      continue
    }
    const customAnswer = '提交所有改动 保证工作区干净 然后构建并安装'
    await click('#pi-command .question-free-text-input')
    await contents.insertText(customAnswer)
    await wait(`document.querySelector('#pi-command .question-free-text-input').value === ${JSON.stringify(customAnswer)}`)
    await click('#pi-command .question-submit')
    await wait(`document.querySelector('#pi-command').textContent.includes('Save changes?')`)
    const customAnswers = await contents.executeJavaScript(`JSON.parse(document.querySelector('#pi-command-answers').textContent)`)
    if (customAnswers[0].answers['Choose an action'] !== '2. Type something.' || customAnswers[1].answers['Type your answer:'] !== customAnswer) throw new Error('Native custom-answer chain lost sentinel or text')
  }
  return { piMenuChain: true, piEditorPrefill: true, piNativeInput: true, piCancelAndReopen: true, piCommandFeedback: true, piCustomAnswerChain: true, piCustomInputCancel: true }
}

async function exerciseSessionSelection(contents, scenario) {
  const read = (expression) => contents.executeJavaScript(expression)
  const wait = async (expression) => {
    const deadline = Date.now() + 5000
    while (!await read(expression)) {
      if (Date.now() > deadline) throw new Error(`${scenario}: timed out: ${expression}; ${await read('document.body.innerText')}`)
      await read('new Promise(resolve => requestAnimationFrame(resolve))')
    }
  }
  const click = async (selector) => {
    const point = await read(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!node) throw new Error('Missing selection control');
      node.scrollIntoView({ block: 'center' });
      const rect = node.getBoundingClientRect();
      const x = Math.round(rect.left + rect.width / 2), y = Math.round(rect.top + rect.height / 2);
      if (!node.contains(document.elementFromPoint(x, y))) throw new Error('Selection control obscured');
      return { x, y };
    })()`)
    contents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 })
    contents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 })
  }
  const state = `JSON.parse(document.querySelector('#selection-state').textContent)`
  await wait(`${state}.snapshots === 2`)
  if (scenario !== 'late-startup' && scenario !== 'late-startup-loading') {
    await click('#resolve-snapshots')
    await wait(`document.querySelector('.sb-sess.active')?.textContent.includes('Old running conversation')`)
  }
  const baseline = await read(`${state}.activeReads`)
  if (scenario === 'focused-event') await click('#focus-pi')
  else await click('.sb-sess[data-provider="pi"]:not(.running)')
  await wait(`${state}.historyReads === 1`)
  if (scenario === 'repeat-pending') {
    await click('.sb-sess[data-provider="pi"]')
    await read('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    if (await read(`${state}.historyReads !== 1 || document.querySelector('.chat-transcript')?.getAttribute('aria-busy') !== 'true'`)) {
      throw new Error('Repeated pending selection restarted history or cleared its loading state')
    }
    await wait(`document.querySelector('[data-status="loading"]')?.textContent.includes('正在加载会话历史')`)
    if (await read(`document.body.innerText.includes('这条会话暂时没有可显示的轮次')`)) throw new Error('Pending history was reported as empty')
  }
  if (scenario !== 'late-startup') await click('#resolve-snapshots')
  if (scenario === 'late-startup-loading') {
    await wait(`${state}.snapshots === 0`)
    // Let both bootstrap promises and React effects settle while history is still pending.
    await read('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    if (await read(`${state}.cancelledLoads !== 0 || ${state}.cwd !== '/fixture/new'`)) {
      throw new Error(`${scenario}: late bootstrap cancelled the pending history: ${JSON.stringify(await read(state))}`)
    }
  }
  const expectedCancellations = scenario === 'rapid-switch' ? 2 : 0
  if (scenario === 'rapid-switch') {
    await click('.sb-sess[data-provider="claude"]')
    await wait(`${state}.historyReads === 2`)
    await click('.sb-sess[data-provider="pi"]')
    await wait(`${state}.historyReads === 3`)
  }
  await click('#resolve-history')
  await wait(`document.body.innerText.includes('History for new-session')`)
  if (scenario === 'late-startup') {
    await click('#resolve-snapshots')
    await wait(`${state}.snapshots === 0`)
  }
  const result = await read(state)
  // Explicit focus restores a live Pi run; history-only selection must not retain the old live run.
  if (scenario !== 'focused-event' && await read(`document.querySelector('.run-status') != null`)) {
    throw new Error(`${scenario}: stale startup run leaked into history`)
  }
  if (result.cancelledLoads !== expectedCancellations || result.cwd !== '/fixture/new' || result.activeReads !== baseline) {
    throw new Error(`${scenario}: stale startup recovery disturbed selection: ${JSON.stringify(result)}`)
  }
  if (await read(`document.body.innerText.includes('workspace changed')`)) throw new Error(`${scenario}: workspace error visible`)
  // Switch back to the running session, including within the same Provider/profile.
  await click('.sb-sess.running')
  await wait(`${state}.historyReads === ${expectedCancellations + 2}`)
  await click('#resolve-history')
  await wait(`document.body.innerText.includes('History for old-session')`)
  if (await read(`${state}.activeReads`) !== baseline) throw new Error(`${scenario}: reverse switch restarted bootstrap`)
  return { scenario, providerSwitch: scenario !== 'same-provider', reverseSwitch: true, startupReads: baseline, expectedCancellations }
}

async function exercisePiPermission(contents, scenario) {
  const read = (expression) => contents.executeJavaScript(expression)
  const wait = async (expression) => {
    const deadline = Date.now() + 5000
    while (!await read(expression)) {
      if (Date.now() > deadline) throw new Error(`Pi ${scenario}: timed out: ${expression}; ${await read('document.body.innerText')}`)
      await read('new Promise(resolve => requestAnimationFrame(resolve))')
    }
  }
  const click = async (selector) => {
    const point = await read(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!node) throw new Error('Missing permission control');
      node.scrollIntoView({ block: 'center' });
      const rect = node.getBoundingClientRect();
      const x = Math.round(rect.left + rect.width / 2), y = Math.round(rect.top + rect.height / 2);
      if (!node.contains(document.elementFromPoint(x, y))) throw new Error('Permission control obscured');
      return { x, y };
    })()`)
    contents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 })
    contents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 })
  }
  const enter = () => {
    contents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' })
    contents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
  }
  const state = `JSON.parse(document.querySelector('#permission-state').textContent)`
  await wait(`${state}.pending === 1 && document.querySelector('.clibtn')?.textContent.includes('Rotom')`)
  contents.focus()
  await click('textarea[aria-label="描述任务"]')
  // Native mouse dispatch is asynchronous; insertion must wait for observable editable focus.
  await wait(`document.activeElement === document.querySelector('textarea[aria-label="描述任务"]')`)
  await contents.insertText('Pi permission regression')
  await wait(`document.querySelector('textarea').value === 'Pi permission regression'`)
  if (!await read(`document.querySelector('.send').disabled`)) throw new Error(`Pi ${scenario}: loading catalog allowed send`)
  enter()
  await wait(`${state}.enterReceipts === 1`)
  if (await read(`${state}.requests.length`) !== 0) throw new Error('Pi default request escaped while loading')
  if (await read(`document.querySelector('textarea').value`) !== 'Pi permission regression') throw new Error('Blocked send lost draft')
  await click('#resolve-permissions')
  await wait(`${state}.pending === 0 && !document.querySelector('[aria-label="选择 Model 与 Effort"]').disabled`)
  if (scenario === 'fresh') {
    if (!await read(`document.querySelector('.send').disabled && document.querySelector('[aria-label="权限"]').textContent.includes('请选择权限')`)) throw new Error('Pi fresh catalog auto-granted full access')
    await click('[aria-label="权限"]')
    await wait(`document.querySelector('[role="option"]') != null`)
    await click('[role="option"]')
  }
  await wait(`!document.querySelector('.send').disabled && document.querySelector('[aria-label="权限"]').textContent.includes('本机完全访问')`)
  if (scenario === 'fresh') await click('.send')
  else { await click('textarea[aria-label="描述任务"]'); enter() }
  await wait(`${state}.requests.length === 1`)
  const [request] = await read(`${state}.requests`)
  if (request.providerId !== 'pi' || request.agentProfileId !== 'pi:rotom' || request.permissionMode !== 'full_access' || request.prompt !== 'Pi permission regression') {
    throw new Error(`Pi ${scenario}: wrong start payload: ${JSON.stringify(request)}`)
  }
  return { scenario, loadingBlocked: true, explicitPermission: request.permissionMode }
}

try {
  await Promise.all(['home', 'userData', 'sessionData'].map((name) => mkdir(join(temp, name))))
  for (const fixture of fixtures) await build({
    configFile: false, root: temp, envDir: temp, logLevel: 'error',
    esbuild: { jsx: 'automatic' },
    resolve: { alias: { '@shared': join(root, 'src/shared') } },
    define: { 'process.env.NODE_ENV': '"production"' },
    build: {
      outDir: temp, emptyOutDir: false, copyPublicDir: false, minify: false,
      lib: {
        entry: join(root, `scripts/fixtures/${fixture}-smoke.tsx`),
        formats: ['iife'],
        name: 'ScryRegression',
        fileName: () => `${fixture}.js`,
        cssFileName: fixture
      }
    }
  })
  for (const fixture of fixtures) await writeFile(join(temp, `${fixture}.html`), `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'"><link rel="stylesheet" href="${fixture}.css"><div id="root"></div><script src="${fixture}.js"></script>`)
  await writeFile(join(temp, 'main.cjs'), `
    const { app, BrowserWindow } = require('electron')
    if (process.platform === 'darwin') app.setActivationPolicy('prohibited')
    app.setPath('userData', ${JSON.stringify(join(temp, 'userData'))})
    app.setPath('sessionData', ${JSON.stringify(join(temp, 'sessionData'))})
    app.whenReady().then(async () => {
      app.dock?.hide()
      const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
      win.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('file:') }))
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      try {
        let result = {}, piCommands = {}
        if (!${selectionOnly}) {
          await win.loadFile(${JSON.stringify(join(temp, 'session-capability.html'))})
          if (!${piCommandsOnly}) result = await win.webContents.executeJavaScript(${JSON.stringify(`(${exercise.toString()})()` )})
          piCommands = await (${exercisePiCommands.toString()})(win.webContents)
        }
        const selection = []
        win.setSize(1200, 900)
        for (const scenario of ${JSON.stringify(piCommandsOnly ? [] : ['repeat-pending', 'late-startup-loading', 'provider-switch', 'same-provider', 'late-startup', 'rapid-switch', 'focused-event'])}) {
          await win.loadFile(${JSON.stringify(join(temp, 'session-selection.html'))}, { query: { scenario } })
          selection.push(await (${exerciseSessionSelection.toString()})(win.webContents, scenario))
        }
        const piPermissions = []
        for (const scenario of ${JSON.stringify(selectionOnly || piCommandsOnly ? [] : ['fresh', 'saved'])}) {
          await win.loadFile(${JSON.stringify(join(temp, 'pi-permission.html'))}, { query: { scenario } })
          piPermissions.push(await (${exercisePiPermission.toString()})(win.webContents, scenario))
        }
        console.log('SCRY_UI_SMOKE_RESULT=' + JSON.stringify({ ...result, ...piCommands, selection, piPermissions }))
        app.exit(0)
      } catch (error) { console.error(error); app.exit(1) }
    }).catch(error => { console.error(error); app.exit(1) })
  `)
  await new Promise((resolve, reject) => {
    const child = spawn(electron, [join(temp, 'main.cjs'), '--disable-gpu'], {
      env: { PATH: process.env.PATH, TMPDIR: tmpdir(), HOME: join(temp, 'home') }, stdio: ['ignore', 'pipe', 'pipe']
    })
    let output = ''
    const timer = setTimeout(() => { child.kill('SIGTERM') }, 30_000)
    child.stdout.on('data', (chunk) => { output += chunk.toString() })
    child.stderr.on('data', (chunk) => { output += chunk.toString() })
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      const result = output.match(/^SCRY_UI_SMOKE_RESULT=(.+)$/m)?.[1]
      if (code !== 0 || !result) reject(new Error(`Hidden UI fixture failed (${code ?? signal}):\n${output.slice(-8000)}`))
      else { console.log(result); resolve() }
    })
  })
} finally {
  await rm(temp, { recursive: true, force: true })
}
