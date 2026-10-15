import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import electron from 'electron'
import { exerciseMetaPrompts } from './meta-prompts-ui-checks.mjs'
import { exerciseSessionCache } from './session-cache-ui-checks.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const cacheOnly = process.argv.includes('--cache-only')
const selectionOnly = process.argv.includes('--selection-only')
const piCommandsOnly = process.argv.includes('--pi-commands-only')
const modelsOnly = process.argv.includes('--models-only')
const terminalsOnly = process.argv.includes('--terminals-only')
const overviewOnly = process.argv.includes('--overview-only')
const summaryOnly = process.argv.includes('--summary-only')
const performanceOnly = process.argv.includes('--performance-only')
// Opt-in only: this native hide/show check necessarily displays a window.
const nativeVisibility = process.argv.includes('--native-visibility')
if (nativeVisibility && !performanceOnly) throw new Error('--native-visibility requires --performance-only and user approval to display a window')
const metaPromptsOnly = process.argv.includes('--meta-prompts-only')
const fixtures = cacheOnly ? ['session-cache'] : metaPromptsOnly ? ['meta-prompts'] : performanceOnly ? ['llm-performance'] : summaryOnly ? ['pinned-summary-performance', 'session-capability'] : overviewOnly ? ['session-capability'] : terminalsOnly ? ['session-terminal'] : modelsOnly ? ['session-model'] : piCommandsOnly ? ['session-capability'] : selectionOnly ? ['session-selection'] : ['session-capability', 'session-selection', 'pi-permission', 'session-model', 'session-terminal', 'pinned-summary-performance', 'llm-performance', 'meta-prompts', 'session-cache']

const temp = await mkdtemp(join(tmpdir(), 'scry-capability-ui-'))

// Real React DOM events in isolated, sandboxed Electron fixtures. Meta Prompts uses the
// production preload and a scoped clipboard handler. No Scry main process, Provider
// discovery, real userData, or CDP port is used by this runner.
async function exerciseSummarySampling() {
  const check = (condition, message) => { if (!condition) throw new Error(message) }
  // Hidden Electron windows suspend rAF; the source cadence is an explicit timer.
  const frame = () => new Promise((resolve) => setTimeout(resolve, 16))
  const link = () => document.querySelector('#summary-performance span[title^="https://example.test/"]')?.getAttribute('title')
  const text = () => document.querySelector('#summary-performance')?.textContent ?? ''
  const readyDeadline = Date.now() + 5000
  while ((!window.summaryFixture || !link()) && Date.now() < readyDeadline) await frame()
  check(window.summaryFixture && link(), 'Summary fixture did not render its initial reference')
  const seen = new Set([link()])
  const started = performance.now()
  for (let step = 1; step <= 36; step++) {
    window.summaryFixture.push(step)
    await frame()
    seen.add(link())
  }
  const elapsed = performance.now() - started
  // This fails on the old per-token summary. Use elapsed time instead of assuming
  // 60 Hz, while requiring a real reduction rather than passing under severe load.
  check(seen.size <= Math.ceil(elapsed / 200) + 2, `Summary updated ${seen.size} times in ${elapsed}ms`)
  check(seen.size < 18, `Summary sampling not demonstrated under current load: ${seen.size} updates`)
  window.summaryFixture.push(37, 'first', true)
  check(link() === 'https://example.test/first/37' && text().includes('skill-37'), 'Terminal evidence was delayed or dropped')
  window.summaryFixture.push(0, 'second')
  check(link() === 'https://example.test/second/0' && text().includes('skill-0'), 'Session switch showed stale evidence')
  window.summaryFixture.push(1, 'second')
  // Allow the trailing sample to fire without another incoming event.
  await new Promise((resolve) => setTimeout(resolve, 240))
  check(link() === 'https://example.test/second/1', 'Trailing text evidence was lost')
  window.summaryFixture.push(2, 'second')
  window.summaryFixture.unmount()
  await new Promise((resolve) => setTimeout(resolve, 240))
  check(!document.querySelector('#summary-performance aside'), 'Unmount left the summary mounted')
  window.summaryFixture.push(0, 'third')
  check(link() === 'https://example.test/third/0', 'Remount retained an old sample')
  return { batches: 36, displayedSnapshots: seen.size, elapsedMs: Math.round(elapsed), terminalImmediate: true, switchImmediate: true, trailingText: true, remount: true }
}

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
  const rowSize = parseFloat(getComputedStyle(document.querySelector('#pinned .pinned-summary-row-main')).fontSize)
  for (const title of document.querySelectorAll('#pinned .pinned-summary-section-title')) {
    const style = getComputedStyle(title)
    check(parseFloat(style.fontSize) <= 12 && parseFloat(style.fontSize) < rowSize, 'Summary heading overpowers row content')
  }
  check(!text('#pinned').includes('Changes') && !text('#pinned').includes('Subagents'), 'Empty summary rows remained visible')

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
  await waitFor(() => document.querySelector('#pinned .pinned-summary-expandable') == null)
  check(!text('#pinned').includes('hsf-invoke') && !text('#pinned').includes('browser / navigate'), 'New session retained old rows')
  check(!text('#pinned').includes('Context') && document.querySelector('#pinned .pinned-summary-divider') == null, 'Empty Context left a heading or divider')
  check(document.querySelectorAll('#pinned button').length === 0, 'Empty session retained summary actions')
  check(document.querySelector('#pinned [data-evidence]') == null, 'Missing summary evidence became a fabricated count')

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
  await waitFor(() => text('#overview .ctx-copy').trim() === '100.0k / 272.0k')
  check(document.querySelector('#overview .ctx-gauge').title.includes('精确：最近一次 Provider 请求用量'), 'Compact context lost its evidence-quality tooltip')
  check(text('#overview').includes('运行中'), 'Context fixture ended before live updates')
  check(text('#overview').includes('未观测到'), 'Missing compaction evidence was displayed as zero')
  document.querySelector('#context-update').click()
  await waitFor(() => text('#overview .ctx-copy').trim() === '201.6k / 272.0k')
  check(document.querySelector('#overview .ring').getAttribute('aria-label') === '上下文占用 74%', 'Live context gauge did not update')
  check(text('#overview').includes('等待 result'), 'Context snapshots leaked into billing totals')
  document.querySelector('#context-compact').click()
  await waitFor(() => text('#overview .ctx-copy').trim() === '暂无上下文数据')
  check(text('#overview').includes('Compact1 次'), 'Completed compaction was not counted once')
  document.querySelector('#context-after').click()
  await waitFor(() => text('#overview .ctx-copy').trim() === '20.0k / 272.0k')
  document.querySelector('#empty').click()
  await waitFor(() => !text('#overview').includes('20.0k / 272.0k'))
  check(!text('#overview').includes('Compact1 次'), 'New session inherited the previous compaction count')
  return { compactContextCopy: true, contextEvidenceTooltip: true, liveContext: true, compactionInvalidation: true, contextSessionReset: true, normalizedWire: true, summaryHiddenByDefault: true, hooksAutoExpand: true, originalEvidenceClicks: 3, collapse: true, thinkingDisclosure: true, modelEffortPicker: true, newSession: true, lateSuccess: true, failedRead: true, multipleTurns: true, sidebarCoordinates: true, sidebarCascade: true, archiveWhileCatalogPending: true, archiveAfterCatalogFailure: true, archiveUndo: true, backgroundArchive: true }
}

async function exercisePiCommands(contents) {
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
  const enter = async (modifiers = []) => {
    contents.sendInputEvent({ type: 'keyDown', keyCode: 'Return', modifiers })
    contents.sendInputEvent({ type: 'char', keyCode: '\r', modifiers })
    contents.sendInputEvent({ type: 'keyUp', keyCode: 'Return', modifiers })
    await contents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  }
  contents.focus()
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
  return { piMenuChain: true, piEditorPrefill: true, piInlineCustomInput: true, piCancelAndReopen: true, piCommandFeedback: true, piCustomAnswerChain: true, piCustomInputCancel: true, piCustomChoiceReversible: true, customAnswerEnter: true, emptyEnterIgnored: true, compositionEnterIgnored: true, multilineEnterPreserved: true, controlEnterSubmit: true }
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
      if (!node) throw new Error('Missing selection control: ' + ${JSON.stringify(selector)});
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
  if (scenario === 'stale-live' || scenario === 'stale-run') {
    await click('#start-hidden-pi')
    const initialListReads = await read(`${state}.activeListReads`)
    if (await read(`document.querySelector('.sb-sess[data-provider="pi"]').classList.contains('running')`) !== (scenario === 'stale-run')) throw new Error('Fixture sidebar must retain its stale running state')
    await click('.sb-sess[data-provider="pi"]')
    await wait(`${state}.historyReads === 1`)
    await click('#resolve-history')
    await wait(`document.querySelector('.chat-transcript').textContent.includes('Actual live response before archival') && !document.querySelector('.chat-session-evidence-gap')`)
    const result = await read(state)
    if (result.activeListReads !== initialListReads + 1 || result.historyReads !== 1 || result.adoptedRuns.join(',') !== 'hidden-pi-run' || result.activeReads !== baseline || result.starts !== 0) throw new Error(`Stale sidebar selection did not restore a single authoritative read: ${JSON.stringify(result)}`)
    return { scenario, firstClickLiveContent: true, missingArchiveNotEmpty: true, authoritativeRunLookup: true, noRetryOrStart: true }
  }
  if (scenario === 'new-draft') {
    const input = 'textarea[aria-label="描述任务"]'
    const newButton = '.sb-new'
    const newDraft = '未发送的新会话草稿\n第二行继续保留'
    const existingDraft = '已有会话自己的草稿'
    const projectDraft = '另一个项目的新会话草稿'
    const type = async (value) => {
      contents.focus()
      await click(input)
      await wait(`document.activeElement === document.querySelector(${JSON.stringify(input)})`)
      await contents.insertText(value)
      await wait(`document.querySelector(${JSON.stringify(input)}).value === ${JSON.stringify(value)}`)
    }
    await click(newButton)
    await wait(`document.querySelector(${JSON.stringify(input)})?.value === '' && ${state}.newSessions === 1`)
    await type(newDraft)
    await click('.sb-sess.running')
    await wait(`${state}.historyReads === 1`)
    await click('#resolve-history')
    await wait(`document.querySelector(${JSON.stringify(input)}).value === ''`)
    await type(existingDraft)
    await click(newButton)
    await wait(`document.querySelector(${JSON.stringify(input)}).value === ${JSON.stringify(newDraft)}`)
    await click(newButton)
    await wait(`${state}.newSessions === 3 && document.querySelector(${JSON.stringify(input)}).value === ${JSON.stringify(newDraft)}`)
    await click('.sb-sess[data-provider="pi"]')
    await wait(`${state}.historyReads === 2`)
    await click('#resolve-history')
    await wait(`document.querySelector(${JSON.stringify(input)}).value === ''`)
    await click(newButton)
    await wait(`${state}.newSessions === 4 && document.querySelector(${JSON.stringify(input)}).value === ''`)
    await type(projectDraft)
    await click('.sb-sess.running')
    await wait(`${state}.historyReads === 3`)
    await click('#resolve-history')
    await wait(`document.querySelector(${JSON.stringify(input)}).value === ${JSON.stringify(existingDraft)}`)
    await click(newButton)
    await wait(`${state}.newSessions === 5 && document.querySelector(${JSON.stringify(input)}).value === ${JSON.stringify(newDraft)}`)
    await click('.sb-sess[data-provider="pi"]')
    await wait(`${state}.historyReads === 4`)
    await click('#resolve-history')
    await click(newButton)
    await wait(`${state}.newSessions === 6 && document.querySelector(${JSON.stringify(input)}).value === ${JSON.stringify(projectDraft)}`)
    if (await read(`${state}.starts`) !== 0) throw new Error('Restoring a draft started a Provider')
    return { scenario, newDraftRestored: true, existingDraftPreserved: true, projectDraftIsolated: true, repeatedNewPreserved: true, noImplicitSend: true }
  }
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

async function exerciseSessionTerminals(contents, scenario) {
  const read = (expression) => contents.executeJavaScript(expression)
  const wait = async (expression) => {
    const deadline = Date.now() + 5000
    while (!await read(expression)) {
      if (Date.now() > deadline) throw new Error(`Terminal ${scenario}: timed out: ${expression}; ${await read('document.body.innerText')}`)
      await read('new Promise(resolve => requestAnimationFrame(resolve))')
    }
  }
  const click = async (selector) => {
    await wait(`[...document.querySelectorAll(${JSON.stringify(selector)})].some(node => node.getBoundingClientRect().width > 0)`)
    const point = await read(`(() => {
      const node = [...document.querySelectorAll(${JSON.stringify(selector)})].find(node => node.getBoundingClientRect().width > 0);
      if (!node) throw new Error('Missing terminal control ' + ${JSON.stringify(selector)});
      node.scrollIntoView({ block: 'center' });
      const rect = node.getBoundingClientRect();
      const x = Math.round(rect.left + rect.width / 2), y = Math.round(rect.top + rect.height / 2);
      if (!node.contains(document.elementFromPoint(x, y))) throw new Error('Terminal control obscured: ' + ${JSON.stringify(selector)} + ' by ' + document.elementFromPoint(x, y)?.outerHTML);
      return { x, y };
    })()`)
    contents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 })
    contents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 })
  }
  const clickTerminalSurface = async () => {
    await wait(`document.querySelector('.surface-menu') != null`)
    // New surfaces can change menu positions. Keep the terminal contract name-bound,
    // while still using native coordinate input and the existing hit-test assertions.
    const index = await read(`[...document.querySelectorAll('.surface-menu [role="menuitem"]')].findIndex(node => node.textContent.trim().startsWith('终端'))`)
    if (index < 0) throw new Error('Terminal surface is missing from the menu')
    await click(`.surface-menu [role="menuitem"]:nth-child(${index + 1})`)
  }
  const state = `JSON.parse(document.querySelector('#terminal-state').textContent)`
  const originalStarts = scenario === 'restored' ? 0 : 1
  const select = async (selector, id) => {
    await click(selector)
    await wait(`document.querySelector('.chat').textContent.includes('History for ${id}')`)
  }
  // Use data-project-path so Sidebar grouping/header layout cannot flatten identity.
  const session = (project, index) => `.sb-proj:has([data-project-path="/fixture/${project}"]) .sb-sess-row:nth-child(${index}) .sb-sess`
  await wait(`document.querySelectorAll('.sb-sess').length === 3`)
  await select(session('old', 1), 'one')
  await click('[aria-label="右侧工作区"]')
  await wait(`document.querySelector('[aria-label="添加 Surface"]') != null`)
  await click('[aria-label="添加 Surface"]')
  await clickTerminalSurface()
  await wait(`document.querySelector('.terminal-xterm .xterm') != null`)
  await read(`globalThis.originalXterm = document.querySelector('.terminal-xterm .xterm')`)
  if (scenario === 'pending') await wait(`${state}.pending`)
  else {
    await wait(`document.querySelector('.terminal-state.running') != null && document.querySelector('.terminal-xterm').textContent.includes('original-screen-marker')`)
    contents.focus()
    await click('.terminal-xterm')
    await wait(`document.activeElement.classList.contains('xterm-helper-textarea')`)
    await contents.insertText('preserved-input')
    await wait(`${state}.writes.join('').includes('preserved-input') && document.querySelector('.terminal-xterm').textContent.includes('preserved-input')`)
  }
  await select(session('old', 2), 'two')
  if (!await read(`globalThis.originalXterm.getBoundingClientRect().width === 0 && document.querySelector('.right-panel-hidden') != null`)) throw new Error('Same-workspace conversation inherited previous right tabs')
  await select(session('new', 1), 'three')
  if (!await read(`globalThis.originalXterm.getBoundingClientRect().width === 0 && document.querySelector('.right-panel-hidden') != null`)) throw new Error('Cross-workspace conversation inherited previous right tabs')
  if (scenario === 'pending') {
    await click('#resolve-terminal')
    await wait(`document.querySelector('.terminal-state.running') != null`)
  }
  if (!await read(`document.querySelector('.terminal-xterm .xterm') === globalThis.originalXterm && ${state}.starts.length === ${originalStarts} && ${state}.attaches.length === ${scenario === 'restored' ? 1 : 0} && ${state}.closes.length === 0`)) {
    throw new Error(`Terminal ${scenario}: session switch reloaded the terminal: ${JSON.stringify(await read(state))}`)
  }
  if (!await read(`document.querySelector('.terminal-xterm').getAttribute('aria-label').includes('/fixture/old')`)) throw new Error('Terminal mislabeled its startup directory after navigation')
  await select(session('old', 1), 'one')
  await click('[aria-label="右侧工作区"]')
  await wait(`document.querySelector('.right-panel-hidden') != null`)
  await click('[aria-label="右侧工作区"]')
  await wait(`document.querySelector('.right-panel-hidden') == null && document.querySelector('.terminal-xterm .xterm') === globalThis.originalXterm`)
  await select(session('old', 1), 'one')
  await wait(`document.querySelector('.terminal-xterm .xterm') === globalThis.originalXterm && document.querySelector('.terminal-xterm').textContent.includes('original-screen-marker')`)
  if (scenario !== 'pending' && !await read(`document.querySelector('.terminal-xterm').textContent.includes('preserved-input')`)) throw new Error('Terminal lost screen contents')
  await click('.terminal-xterm')
  await wait(`document.activeElement.classList.contains('xterm-helper-textarea')`)
  await contents.insertText('continued-input')
  await wait(`${state}.writes.join('').includes('continued-input') && document.querySelector('.terminal-xterm').textContent.includes('continued-input')`)
  await click('[aria-label="终端录制历史"]')
  await wait(`document.querySelector('[aria-label="只读打开 terminal-recorded"]') != null`)
  await click('[aria-label="只读打开 terminal-recorded"]')
  await wait(`document.querySelector('.terminal-state.readonly') != null && document.querySelectorAll('.terminal-xterm')[1].textContent.includes('recorded-marker')`)
  await read(`globalThis.recordedXterm = document.querySelectorAll('.terminal-xterm .xterm')[1]`)
  await select(session('new', 1), 'three')
  if (!await read(`document.querySelectorAll('.terminal-xterm .xterm')[1] === globalThis.recordedXterm && document.querySelector('.terminal-state.readonly') != null && document.querySelectorAll('.terminal-xterm')[1].textContent.includes('recorded-marker')`)) throw new Error('Session switch discarded the read-only recording')
  if (!await read(`globalThis.recordedXterm.getBoundingClientRect().width === 0`)) throw new Error('Previous conversation recording remained visible')
  await select(session('old', 1), 'one')
  await click('.terminal-tab:nth-child(2) .terminal-tab-close')
  await wait(`document.querySelectorAll('.terminal-tab').length === 1`)
  await click('#terminal-exit')
  await wait(`document.querySelector('.terminal-state.exited') != null && document.querySelector('.terminal-xterm').textContent.includes('code 1')`)
  await select(session('new', 1), 'three')
  await select(session('old', 1), 'one')
  if (!await read(`document.querySelector('.terminal-state.exited') != null && ${state}.starts.length === ${originalStarts}`)) throw new Error('Session switch restarted an exited Shell')
  await click('[aria-label="重新启动终端"]')
  await wait(`${state}.starts.length === ${originalStarts + 1} && document.querySelector('.terminal-state.running') != null`)
  await click('[aria-label="新建终端"]')
  await wait(`${state}.starts.length === ${originalStarts + 2} && document.querySelectorAll('.terminal-state.running').length === 2`)
  if (!await read(`${state}.starts.slice(-2).every(request => request.cwd === '/fixture/old')`)) throw new Error('Explicit terminal start did not use its owning workspace')
  await click('.terminal-tab:first-child .terminal-tab-close')
  await wait(`${state}.closes.length === 1 && document.querySelectorAll('.terminal-tab').length === 1`)
  await select(session('old', 2), 'two')
  await click('[aria-label="右侧工作区"]')
  await click('[aria-label="添加 Surface"]')
  await clickTerminalSurface()
  await wait(`${state}.starts.length === ${originalStarts + 3}`)
  if (!await read(`${state}.attaches.length === ${scenario === 'restored' ? 1 : 0} && ${state}.starts.at(-1).scopeId !== ${state}.starts.at(-2).scopeId`)) throw new Error('Same-workspace terminal adopted another conversation shell')
  await select(session('new', 1), 'three')
  await click('[aria-label="右侧工作区"]')
  await click('[aria-label="添加 Surface"]')
  await clickTerminalSurface()
  await wait(`${state}.starts.length === ${originalStarts + 4}`)
  if (!await read(`${state}.starts.at(-1).cwd === '/fixture/new' && ${state}.closes.length === 1`)) throw new Error('New conversation terminal changed old shells')
  await select(session('old', 1), 'one')
  await click('.chat .md-file-ref')
  await wait(`document.querySelector('[data-session-surface-current="true"] .workspace-textarea')?.value === '/fixture/new/same.ts'`)
  await read(`globalThis.foreignEditor = document.querySelector('[data-session-surface-current="true"] .workspace-textarea')`)
  if (!await read(`globalThis.foreignEditor.readOnly`)) throw new Error('Cross-workspace reference became writable')
  await select(session('old', 2), 'two')
  await click('.chat .md-file-ref')
  await wait(`document.querySelector('[data-session-surface-current="true"] .workspace-textarea')?.value === '/fixture/old/same.ts'`)
  if (!await read(`globalThis.foreignEditor.isConnected && globalThis.foreignEditor.readOnly && globalThis.foreignEditor.value === '/fixture/new/same.ts'`)) throw new Error('Opening another conversation file changed the retained editor root')
  await click('[data-session-surface-current="true"] .workspace-textarea')
  contents.focus()
  await wait(`document.activeElement === document.querySelector('[data-session-surface-current="true"] .workspace-textarea')`)
  await contents.insertText('unsaved-marker')
  await wait(`document.querySelector('[data-session-surface-current="true"] .workspace-textarea').value.includes('unsaved-marker')`)
  await read(`globalThis.localEditor = document.querySelector('[data-session-surface-current="true"] .workspace-textarea'); globalThis.discardPrompts = 0; globalThis.originalConfirm = window.confirm; window.confirm = () => { globalThis.discardPrompts++; return false }; true`)
  await select(session('new', 1), 'three')
  if (!await read(`globalThis.discardPrompts === 0 && globalThis.localEditor.isConnected && globalThis.localEditor.value.includes('unsaved-marker')`)) throw new Error('Workspace navigation discarded or asked to discard a retained editor')
  await select(session('old', 1), 'one')
  await wait(`globalThis.foreignEditor.getBoundingClientRect().width > 0 && globalThis.foreignEditor.readOnly`)
  await click('[data-session-surface-current="true"] .surface-tab-activate[aria-controls$="-terminal-panel"]')
  await wait(`document.querySelector('[data-session-surface-current="true"] .terminal-xterm .xterm')?.getBoundingClientRect().width > 0`)
  await read(`globalThis.promotedXterm = [...document.querySelectorAll('.terminal-xterm .xterm')].find(node => node.getBoundingClientRect().width > 0)`)
  await click('#promote-session')
  await wait(`JSON.parse(sessionStorage.getItem('scry.session-right-surfaces.v1')).some(([key]) => JSON.parse(key).at(-1) === 'native-one')`)
  if (!await read(`globalThis.promotedXterm.isConnected && globalThis.promotedXterm.getBoundingClientRect().width > 0 && ${state}.starts.length === ${originalStarts + 4}`)) throw new Error('Native session capture remounted its workbench')
  await select(session('new', 1), 'three')
  await select(session('old', 1), 'native-one')
  if (!await read(`globalThis.promotedXterm.isConnected && globalThis.promotedXterm.getBoundingClientRect().width > 0`)) throw new Error('Captured conversation lost its terminal identity')
  await click('#merge-session')
  await wait(`document.querySelector('[aria-label="切换此会话的保留工作区"]')?.textContent.includes('1/2')`)
  const mergedScope = await read(`JSON.parse(sessionStorage.getItem('scry.session-right-surfaces.v1')).find(([key]) => { try { return JSON.parse(key).at(-1) === 'two' } catch { return false } })[1]`)
  if (!mergedScope.relatedIds?.length) throw new Error('Promotion collision orphaned the existing native workbench')
  await click('[aria-label="切换此会话的保留工作区"]')
  await wait(`globalThis.promotedXterm.getBoundingClientRect().width === 0 && document.querySelector('[data-session-surface-current="true"] .workspace-textarea')?.getBoundingClientRect().width > 0`)
  if (!await read(`globalThis.localEditor.value.includes('unsaved-marker')`)) throw new Error('Promotion discarded unsaved editor text')
  // Explicitly discard only after proving preservation, so beforeunload does not block the next fixture.
  await read(`window.confirm = () => true; true`)
  await click('[data-session-surface-current="true"] .workspace-editorbar button:first-of-type')
  await wait(`globalThis.localEditor.value === '/fixture/old/same.ts' && !document.querySelector('[data-session-surface-current="true"] .workspace-editorbar').textContent.includes('未保存')`)
  await read(`window.confirm = globalThis.originalConfirm; true`)
  await click('[data-session-surface-current="true"] .surface-tab-activate[aria-controls$="-terminal-panel"]')
  await wait(`[...document.querySelectorAll('.terminal-xterm .xterm')].some(node => node !== globalThis.promotedXterm && node.getBoundingClientRect().width > 0)`)
  await click('[aria-label="切换此会话的保留工作区"]')
  await wait(`globalThis.promotedXterm.getBoundingClientRect().width > 0`)
  if (!await read(`${state}.closes.length === 1 && ${state}.starts.length === ${originalStarts + 4}`)) throw new Error('Merged workbench switching restarted shells')
  // The dirty indicator updates before React removes its beforeunload protection.
  // Wait for that protection to clear before navigating to the next fixture.
  await wait('window.dispatchEvent(new Event("beforeunload", { cancelable: true }))')
  return { scenario, scopedTabs: true, sameWorkspace: true, crossWorkspace: true, screenPreserved: true, recordingPreserved: true, fileRootAndReadOnlyPreserved: true, hideShowPreserved: true, nativePromotion: true, collisionReachable: true, noImplicitRestart: true, explicitRestartAndNewUseOwnedCwd: true, explicitClose: true }
}

async function exerciseSessionModels(contents, screenshotPath) {
  const read = async (expression) => {
    const result = await contents.executeJavaScript(`(async () => {
      try { return { ok: true, value: await (${expression}) }; }
      catch (error) { return { ok: false, error: String(error) }; }
    })()`)
    if (!result.ok) throw new Error(`Session model expression failed: ${expression.slice(0, 500)}; ${result.error}`)
    return result.value
  }
  const wait = async (expression) => {
    const deadline = Date.now() + 5000
    while (!await read(expression)) {
      if (Date.now() > deadline) throw new Error(`Session models: timed out: ${expression}; ${await read('document.body.innerText')}`)
      await read('new Promise(resolve => requestAnimationFrame(resolve))')
    }
  }
  const click = async (selector) => {
    const point = await read(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!node) throw new Error('Missing model control: ' + ${JSON.stringify(selector)});
      node.scrollIntoView({ block: 'center' });
      const rect = node.getBoundingClientRect();
      const x = Math.round(rect.left + rect.width / 2), y = Math.round(rect.top + rect.height / 2);
      return { x, y };
    })()`)
    contents.sendInputEvent({ type: 'mouseMove', ...point })
    try {
      await wait(`document.querySelector(${JSON.stringify(selector)}).contains(document.elementFromPoint(${point.x}, ${point.y}))`)
    } catch (error) {
      throw new Error(`${error.message}; hit=${await read(`document.elementFromPoint(${point.x}, ${point.y})?.outerHTML`)}`)
    }
    contents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 })
    contents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 })
  }
  const pickSession = async (text) => {
    const index = await read(`[...document.querySelectorAll('.sb-sess')].findIndex(node => node.textContent.includes(${JSON.stringify(text)}))`)
    if (index < 0) throw new Error(`Missing session ${text}`)
    await click(`.sb-sess-row:nth-child(${index + 1}) .sb-sess`)
  }
  const modelIs = (id) => `document.querySelector('.model-effort-model')?.textContent === ${JSON.stringify(id)}`
  const chooseModel = async (id) => {
    await click('[aria-label="选择 Model 与 Effort"]')
    await wait(`document.querySelector('.model-effort-current-model') != null`)
    await click('[aria-label^="选择 Model，"]')
    await wait(`document.querySelectorAll('.model-effort-list [role="option"]').length === 3`)
    await click(`.model-effort-list [role="option"]:nth-child(${id === 'model-1' ? 2 : 3})`)
    await wait(modelIs(id))
    await click('[aria-label="选择 Model 与 Effort"]')
    await wait(`document.querySelector('.model-effort-popover') == null`)
  }
  const send = async (text) => {
    await click('textarea[aria-label="描述任务"]')
    await wait(`document.activeElement === document.querySelector('textarea[aria-label="描述任务"]')`)
    await contents.insertText(text)
    await wait(`document.querySelector('textarea').value === ${JSON.stringify(text)} && !document.querySelector('.send').disabled`)
    await click('.send')
  }
  const requests = `JSON.parse(document.querySelector('#model-state').textContent).requests`
  contents.focus()
  await wait(`document.querySelector('.sb-proj-new') != null`)
  await click('.sb-proj-new')
  await wait(`document.querySelector('[aria-label="选择 Model 与 Effort"]')?.disabled === false`)
  await chooseModel('model-1')
  await click('[aria-label="选择 Model 与 Effort"]')
  await wait(`document.querySelector('[aria-label="推理强度"]') != null`)
  await click('[aria-label="推理强度"]')
  contents.sendInputEvent({ type: 'keyDown', keyCode: 'Right' })
  contents.sendInputEvent({ type: 'keyUp', keyCode: 'Right' })
  await wait(`document.querySelector('.model-effort-effort')?.textContent === 'High'`)
  await click('[aria-label="选择 Model 与 Effort"]')
  await send('Conversation one')
  await wait(`${requests}.length === 1 && document.querySelector('.run-status') != null`)
  await click('#capture-first')
  await wait(`document.querySelector('.sb-sess') != null && ${modelIs('model-1')}`)
  await click('.sb-new')
  await wait(`document.querySelector('.run-status') == null && ${modelIs('model-1')}`)
  await chooseModel('model-2')
  await send('Conversation two')
  await wait(`${requests}.length === 2 && document.querySelectorAll('.sb-sess').length === 2`)
  await click('.sb-new')
  await wait(`document.querySelector('.run-status') == null && ${modelIs('model-2')}`)
  await pickSession('Conversation one')
  await wait(`document.querySelector('.run-status') != null && ${modelIs('model-1')}`)
  await click('#finish-second')
  await wait(`document.querySelectorAll('.sb-sess.running').length === 1 && ${modelIs('model-1')}`)
  await send('Queued continuation one')
  await wait(`document.querySelector('textarea').value === ''`)
  if (await read(`${requests}.length`) !== 2) throw new Error('Busy session did not queue its continuation')
  await click('#finish-first')
  await wait(`${requests}.length === 3`)
  const actual = await read(requests)
  if (actual.map((request) => request.model?.id).join(',') !== 'model-1,model-2,model-1' || actual[2].expectedExternalSessionId !== 'native-1' || actual[0].effort !== 'high' || actual[1].effort != null || actual[2].effort !== 'high') {
    throw new Error('Wrong per-session request models: ' + JSON.stringify(actual))
  }
  await click('.sb-new')
  await wait(`document.querySelector('.run-status') == null && ${modelIs('model-2')}`)
  await click('#remount')
  await wait(modelIs('model-2'))
  await pickSession('Conversation two')
  await wait(modelIs('model-2'))
  await pickSession('Conversation one')
  await wait(modelIs('model-1'))
  await click('#legacy')
  await wait(`document.querySelectorAll('.sb-sess').length === 3`)
  await pickSession('Legacy conversation')
  await wait(`${modelIs('model-1')} && document.querySelector('.model-effort-effort')?.textContent === 'High'`)
  await click('.sb-new')
  await wait(`document.querySelector('.run-status') == null && ${modelIs('model-2')}`)
  const capabilities = `JSON.parse(document.querySelector('#model-state').textContent).capabilityRequests`
  if (!await read(`${capabilities}.skills.length === 0 && ${capabilities}.mcp.length === 0`)) {
    throw new Error('Skills/MCP inventory loaded before opening its page')
  }
  if (!await read(`document.querySelector('.sb-nav .sb-navmeta') == null && document.querySelector('.sb-nav .sb-navdot') == null`)) {
    throw new Error('Skills/MCP navigation still displays background inventory metadata')
  }
  await click('.sb-new')
  await wait(modelIs('model-2'))
  await click('.sb-nav [title="Skills"]')
  await wait(`${capabilities}.skills.length === 1 && document.querySelector('.capabilities-modal--skills')?.textContent.includes('fixture Skill unavailable')`)
  if (!await read(`${capabilities}.mcp.length === 0`)) throw new Error('Opening Skills also loaded MCP')
  await click('.capability-kind-tabs [role="tab"]:nth-child(2)')
  await wait(`${capabilities}.mcp.length === 1 && document.querySelector('.capabilities-modal--mcp')?.textContent.includes('fixture MCP unavailable')`)
  await click('[aria-label="刷新 MCP 运行状态"]')
  await wait(`${capabilities}.mcp.length === 2`)
  await click('[aria-label="关闭能力面板"]')

  const selectAgent = async (id) => {
    await click('.clibtn')
    await wait(`document.querySelector('.climenu [data-agent-id="${id}"]') != null`)
    await click(`.climenu [data-agent-id="${id}"]`)
    await wait(`document.querySelector('.clibtn').dataset.agentId === '${id}'`)
  }
  await selectAgent('codex')
  if (!await read(`${capabilities}.skills.length === 1 && ${capabilities}.mcp.length === 2`)) throw new Error('Hidden inventory refreshed on Provider switch')
  await click('.sb-nav [title="Skills"]')
  await wait(`${capabilities}.skills.length === 2`)
  if (!await read(`${capabilities}.skills.at(-1).providerId === 'codex'`)) throw new Error('Skills loaded the previous Provider context')
  await click('[aria-label="关闭能力面板"]')
  await selectAgent('pi:first')
  await click('.sb-nav [title="MCP"]')
  await wait(`${capabilities}.mcp.length === 3`)
  if (!await read(`${capabilities}.mcp.at(-1).agentProfileId === 'pi:first'`)) throw new Error('MCP lost its Pi Profile context')
  await click('[aria-label="关闭能力面板"]')
  await selectAgent('pi:second')
  if (!await read(`${capabilities}.skills.length === 2 && ${capabilities}.mcp.length === 3`)) throw new Error('Hidden inventory refreshed on Pi Profile switch')
  await click('.sb-nav [title="Skills"]')
  await wait(`${capabilities}.skills.length === 3`)
  if (!await read(`${capabilities}.skills.at(-1).agentProfileId === 'pi:second'`)) throw new Error('Skills loaded the previous Pi Profile')
  await click('[aria-label="关闭能力面板"]')
  await click('#remount')
  await wait(`document.querySelector('.clibtn')?.dataset.agentId === 'pi:second'`)
  if (!await read(`${capabilities}.skills.length === 3 && ${capabilities}.mcp.length === 3`)) throw new Error('Remount restarted hidden inventory discovery')
  // Recovery must work inside the production App with an existing, locked session.
  await pickSession('Conversation one')
  await wait(`document.querySelector('.run-status') != null && ${modelIs('model-1')}`)
  await click('textarea[aria-label="描述任务"]')
  await contents.insertText('Draft survives detection timeout')
  await wait(`document.querySelector('textarea').value === 'Draft survives detection timeout'`)
  await click('#fail-detection')
  const state = `JSON.parse(document.querySelector('#model-state').textContent)`
  await wait(`document.querySelector('.composer-retry-detection')?.disabled === false && document.querySelector('.send').disabled`)
  if (!await read(`document.querySelector('.clibtn').disabled && document.querySelector('.clibtn').dataset.agentId === 'claude'`)) throw new Error('Existing session runtime was not locked')
  await click('#hold-detection')
  const controlReads = await read(`${state}.controlRequests.length`)
  await click('.composer-retry-detection')
  await wait(`document.querySelector('.composer-retry-detection').disabled && ${state}.controlRequests.length === ${controlReads + 1}`)
  await click('#release-detection')
  await wait(`document.querySelector('.composer-retry-detection')?.disabled === false && document.querySelector('.send').disabled`)
  if (!await read(`document.querySelector('.composer-status').textContent.includes('fixture detection timeout')`)) throw new Error('Failed retry hid the detection error')
  await click('#recover-detection')
  await click('.composer-retry-detection')
  await wait(`document.querySelector('.composer-retry-detection') == null && !document.querySelector('.send').disabled && ${modelIs('model-1')}`)
  if (!await read(`document.querySelector('textarea').value === 'Draft survives detection timeout' && ${requests}.length === 3 && ${state}.controlRequests.at(-1).providerId === 'claude' && ${state}.controlRequests.at(-1).cwd === '/fixture'`)) throw new Error('Retry lost the draft/runtime/context or sent it automatically')
  // Queue the retained draft, then archive before it can drain after terminal.
  await click('.send')
  await wait(`document.querySelector('textarea').value === ''`)
  await click('[aria-label="存档会话：Conversation one"]')
  await wait(`document.querySelector('.run-status') == null && !document.querySelector('[aria-label="存档会话：Conversation one"]') && ${state}.stoppedRuns.includes('run-3')`)
  if (await read(`${requests}.length`) !== 3) throw new Error('Archiving current session drained its queue')
  await click('.sb-undo button')
  await wait(`document.querySelector('[aria-label="存档会话：Conversation one"]') != null`)
  await pickSession('Conversation one')
  await wait(`document.querySelector('.run-status') == null`)
  if (await read(`${requests}.length`) !== 3) throw new Error('Undo resumed archived execution')
  await send('Run for background archive')
  await wait(`${requests}.length === 4 && document.querySelector('.run-status') != null`)
  await send('Queued background message must not run')
  await wait(`document.querySelector('textarea').value === ''`)
  await pickSession('Conversation two')
  await wait(`document.querySelector('.run-status') == null`)
  await click('[aria-label="存档会话：Conversation one"]')
  await wait(`!document.querySelector('[aria-label="存档会话：Conversation one"]') && ${state}.stoppedRuns.includes('run-4')`)
  if (!await read(`${requests}.length === 4 && document.querySelector('.sb-sess[aria-current="true"]').textContent.includes('Conversation two')`)) throw new Error('Background archive changed selection or sent its queue')
  await click('.sb-undo button')
  await wait(`document.querySelector('[aria-label="存档会话：Conversation one"]') != null`)
  await pickSession('Conversation one')
  await wait(`document.querySelector('.run-status') == null && document.querySelector('.prompt-queue') == null`)
  if (await read(`${requests}.length`) !== 4) throw new Error('Background archive queue resumed after undo')
  await click('.sb-new')
  await wait(`document.querySelector('.clibtn').disabled === false`)
  await send('Provisional archive')
  await wait(`${requests}.length === 5 && document.querySelector('.run-status') != null`)
  await send('Queued provisional message must not run')
  await wait(`document.querySelector('textarea').value === ''`)
  await click('#hold-archive')
  await click('[aria-label="存档会话：Provisional archive"]')
  await wait(`${state}.stoppedRuns.includes('run-5')`)
  await pickSession('Conversation two')
  await wait(`document.querySelector('.sb-sess[aria-current="true"]')?.textContent.includes('Conversation two')`)
  await click('#release-archive')
  await wait(`document.querySelector('.sb-undo')?.textContent.includes('Provisional archive')`)
  if (!await read(`${requests}.length === 5 && document.querySelector('.sb-sess[aria-current="true"]').textContent.includes('Conversation two')`)) throw new Error('Late archive acknowledgment reset the newer selection or drained a provisional queue')
  if (screenshotPath) for (const theme of ['dark', 'light']) {
    await read(`document.documentElement.dataset.theme = '${theme}'; new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
    const bounds = await read(`(() => {
      const { x, y, width, height } = document.querySelector('.sb-nav').getBoundingClientRect()
      return { x: Math.round(x), y: Math.round(y), width: Math.ceil(width), height: Math.ceil(height) }
    })()`)
    const image = await contents.capturePage(bounds)
    require('node:fs').writeFileSync(screenshotPath + '-' + theme + '.png', image.toPNG())
  }
  return { retryDetection: { lockedSession: true, failedRetry: true, pendingDisabled: true, draftAndModelPreserved: true, originalContext: true, noAutoSend: true }, archive: { currentRunning: true, backgroundRunning: true, provisionalRun: true, selectionRace: true, queuesCancelled: true, undoDoesNotResume: true }, models: actual.map((request) => request.model.id), newDefault: 'model-2', effortIsolated: true, nativeCapture: true, backgroundTerminalCapture: true, queuedContinuation: true, persisted: true, legacyArchiveRestored: true, lazyInventory: { backgroundRequests: 0, skillsRequests: 3, mcpRequests: 3, providerAndProfileContext: true } }
}

async function exerciseOverviewDensity(contents, screenshotPath) {
  const css = await contents.insertCSS(`
    body > #root > :not(#overview) { display: none !important; }
    #overview { position: fixed; inset: 0; width: 380px; }
    #overview > .overview-dossier { width: 100%; height: 100%; }
  `)
  const results = []
  try {
    for (const theme of ['dark', 'light']) for (const width of [380, 340, 535]) {
      await contents.executeJavaScript(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}; document.querySelector('#overview').style.width = '${width}px'`)
      const geometry = await contents.executeJavaScript(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => {
        const rect = selector => document.querySelector(selector).getBoundingClientRect();
        const header = rect('.ov-topbar'), context = rect('.ctx-gauge'), metrics = rect('.overview-metric-grid');
        const session = rect('.overview-scroll-content > .panel-section'), tabs = rect('.overview-data-tabs');
        const firstTurn = rect('.turn-call-row');
        resolve({ headerHeight: header.height, contextGap: context.top - header.bottom,
          sessionGap: session.top - metrics.bottom, tabsGap: tabs.top - session.bottom,
          firstTurnTop: firstTurn.top, overflow: document.querySelector('.ov-scroll').scrollWidth > ${width},
          columns: getComputedStyle(document.querySelector('.overview-metric-grid')).gridTemplateColumns.split(' ').length });
      })))`)
      if (screenshotPath && theme === 'dark' && width === 380) {
        const image = await contents.capturePage({ x: 0, y: 0, width, height: 650 })
        require('node:fs').writeFileSync(screenshotPath, image.toPNG())
      }
      if (geometry.headerHeight > 48 || geometry.contextGap > 16 || geometry.sessionGap > 16 || geometry.tabsGap > 12 || geometry.firstTurnTop > 460 || geometry.overflow || geometry.columns !== 2) {
        throw new Error('Overview density ' + theme + '/' + width + ': ' + JSON.stringify(geometry))
      }
      results.push({ theme, width, ...geometry })
    }
    contents.focus()
    const point = await contents.executeJavaScript(`(() => {
      const node = document.querySelector('#overview-session-tab'), r = node.getBoundingClientRect();
      const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
      if (!node.contains(document.elementFromPoint(x, y))) throw new Error('Overview tab obscured');
      return { x, y };
    })()`)
    contents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 })
    contents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 })
    await contents.executeJavaScript(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
    if (!await contents.executeJavaScript(`document.querySelector('#overview-session-tab').getAttribute('aria-selected') === 'true' && !document.querySelector('#overview-session-panel').hidden && document.querySelector('#overview-turns-panel').hidden`)) {
      throw new Error('Overview native tab click did not select session data')
    }
    if (!await contents.executeJavaScript(`!document.querySelector('#overview-session-panel').textContent.includes('本会话 Token 用量') && !document.querySelector('#overview-session-panel .pstats') && document.querySelector('#overview-file-footprint') != null && document.querySelector('#overview .overview-metric-grid') != null`)) {
      throw new Error('Overview retained the redundant token section or removed adjacent evidence')
    }
    contents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab', modifiers: ['shift'] })
    contents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab', modifiers: ['shift'] })
    await contents.executeJavaScript(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
    if (!await contents.executeJavaScript(`document.activeElement.id === 'overview-turns-tab'`)) throw new Error('Overview keyboard focus did not reach turns tab')
    contents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' })
    contents.sendInputEvent({ type: 'char', keyCode: '\r' })
    contents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
    await contents.executeJavaScript(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
    if (!await contents.executeJavaScript(`document.activeElement.id === 'overview-turns-tab' && !document.querySelector('#overview-turns-panel').hidden`)) throw new Error('Overview keyboard tab return failed')
    return results
  } finally { await contents.removeInsertedCSS(css) }
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

async function exerciseLlmPerformance(contents, win, screenshot, nativeVisibility) {
  const read = expression => contents.executeJavaScript(expression)
  const wait = async expression => {
    const deadline = Date.now() + 5000
    while (!await read(expression)) {
      if (Date.now() > deadline) throw new Error('LLM performance timed out: ' + expression + '; ' + await read('document.body.innerText'))
      // Not requestAnimationFrame: it never fires while the window is hidden, which would hang the hidden-window check.
      await new Promise(resolve => setTimeout(resolve, 16))
    }
  }
  const pointOf = async (selector, fraction = 0.5) => read(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!node) throw new Error('Missing performance control: ' + ${JSON.stringify(selector)});
    node.scrollIntoView({ block: 'center' });
    const rect = node.getBoundingClientRect();
    const x = Math.round(rect.left + rect.width * ${fraction}), y = Math.round(rect.top + rect.height / 2);
    if (!node.contains(document.elementFromPoint(x, y))) throw new Error('Performance control obscured: ' + ${JSON.stringify(selector)});
    return { x, y };
  })()`)
  const click = async selector => {
    const point = await pointOf(selector)
    contents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 })
    contents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 })
  }
  const hover = async (selector, fraction) => contents.sendInputEvent({ type: 'mouseMove', ...await pointOf(selector, fraction) })
  if (nativeVisibility) win.showInactive()
  contents.focus()
  await wait(`document.querySelector('.sb-navitem[title="LLM 性能"]') != null`)
  const nav = await read(`Array.from(document.querySelectorAll('.sb-navitem')).map(node => node.textContent.trim())`)
  if (nav.indexOf('LLM 性能') !== 1 || nav.indexOf('技能') !== 2) throw new Error('LLM 性能 entry is not directly above Skills')
  const baselineListeners = await read(`JSON.parse(document.querySelector('#performance-fixture-state').textContent).dataListeners`)
  await click('.sb-navitem[title="LLM 性能"]')
  await wait(`document.querySelector('.llm-perf-modal') != null`)
  const modal = `document.querySelector('.llm-perf-modal')`
  const runs = `Array.from(${modal}.querySelectorAll('.llm-perf-run')).map(node => node.textContent)`
  await wait(`${modal}.textContent.includes('3 个会话运行中') && ${runs}.length === 3`)
  if (!await read(`${runs}.every(text => text.includes('等待首次输出') && !text.includes('token/s'))`)) throw new Error('Waiting sessions fabricated speed or output')
  // History: failed and unmeasured rounds never become a model, a curve or a 0 token/s value.
  await wait(`${modal}.querySelectorAll('.llm-perf-line').length === 2 && ${modal}.querySelectorAll('.llm-perf-mrow').length === 2`)
  const models = await read(`Array.from(${modal}.querySelectorAll('.llm-perf-mrow')).map(node => node.textContent)`)
  if (!models[0].includes('fast-model') || !models[0].includes('62.0') || !models[0].includes('5') || !models[1].includes('slow-model') || !models[1].includes('21.0'))
    throw new Error('Model medians wrong: ' + JSON.stringify(models))
  // First-token column: fast-model median 2.0 s (failed 99 s round excluded); slow-model has no evidence, not 0.
  if (!models[0].includes('2.0秒') || !models[1].includes('—') || models[1].includes('0.0秒')) throw new Error('First-token column wrong: ' + JSON.stringify(models))
  if (await read(`${modal}.textContent.includes('999') || ${modal}.textContent.includes('unmeasured-model')`)) throw new Error('Failed or unmeasured history leaked into speed')
  if (await read(`${modal}.textContent.includes('字符/s') || ${modal}.textContent.includes('数据口径')`)) throw new Error('Legacy character/definition UI leaked into the modal')
  // Real pointer hover: the busy region names measured speed, the idle region says 空闲 instead of 0.
  await hover('.llm-perf-chart svg', 0.94)
  await wait(`${modal}.querySelector('.llm-perf-tip')?.textContent.includes('fast-model') && ${modal}.querySelector('.llm-perf-cross') != null`)
  await hover('.llm-perf-chart svg', 0.1)
  await wait(`${modal}.querySelector('.llm-perf-tip')?.textContent.includes('空闲') && !${modal}.querySelector('.llm-perf-tip').textContent.includes('token')`)
  contents.sendInputEvent({ type: 'mouseMove', x: 2, y: 2 })
  await wait(`${modal}.querySelector('.llm-perf-tip') == null`)
  await click('.llm-perf-mrow:nth-of-type(1)')
  await wait(`${modal}.querySelectorAll('.llm-perf-line.dim').length === 1 && ${modal}.querySelector('.llm-perf-mrow[aria-pressed="true"]')?.textContent.includes('fast-model')`)
  await click('.llm-perf-mrow[aria-pressed="true"]')
  await wait(`${modal}.querySelectorAll('.llm-perf-line.dim').length === 0`)
  await click('.llm-perf-range button:nth-child(1)')
  await wait(`${modal}.querySelector('.llm-perf-range button[aria-pressed="true"]').textContent === '1 小时' && ${modal}.querySelectorAll('.llm-perf-mrow').length === 2`)
  await click('.llm-perf-range button:nth-child(2)')
  // Metric switch: the same chart draws first-token wait in seconds, only for models with that evidence.
  await click('.llm-perf-metric button:nth-child(2)')
  await wait(`${modal}.querySelector('.llm-perf-metric button[aria-pressed="true"]')?.textContent === '首 token' && ${modal}.querySelector('.llm-perf-chart svg')?.getAttribute('aria-label').includes('首 token') && ${modal}.querySelectorAll('.llm-perf-line').length === 1`)
  if (await read(`${modal}.querySelector('section h3').textContent.includes('token/s') || !${modal}.querySelector('section h3').textContent.includes('秒')`)) throw new Error('First-token chart kept the speed unit')
  await hover('.llm-perf-chart svg', 0.94)
  await wait(`${modal}.querySelector('.llm-perf-tip')?.textContent.includes('fast-model') && !${modal}.querySelector('.llm-perf-tip')?.textContent.includes('slow-model')`)
  const waitTip = await read(`Number(${modal}.querySelector('.llm-perf-tip b').textContent)`)
  if (!(waitTip >= 1 && waitTip <= 3)) throw new Error('First-token tooltip is not the measured seconds: ' + waitTip)
  contents.sendInputEvent({ type: 'mouseMove', x: 2, y: 2 })
  await wait(`${modal}.querySelector('.llm-perf-tip') == null`)
  await click('.llm-perf-metric button:nth-child(1)')
  await wait(`${modal}.querySelectorAll('.llm-perf-line').length === 2 && ${modal}.querySelector('section h3').textContent.includes('token/s')`)
  // Live sessions: per-call evidence gives token/s; Claude's final-only usage does not while running.
  await click('#performance-stream')
  await wait(`${runs}.some(text => text.includes('pi-live-model') && text.includes('生成中') && text.includes('40.0token/s') && text.includes('首 token1.5秒'))`)
  await wait(`${modal}.querySelectorAll('.llm-perf-line').length === 3 && Array.from(${modal}.querySelectorAll('.llm-perf-mrow')).some(node => node.textContent.includes('pi-live-model') && node.textContent.includes('40.0token/s') && node.textContent.includes('1.5秒') && node.textContent.includes('0 + 1 运行中'))`)
  await click('.llm-perf-metric button:nth-child(2)')
  await wait(`${modal}.querySelectorAll('.llm-perf-line').length === 2`)
  await click('.llm-perf-metric button:nth-child(1)')
  win.setSize(700, 700)
  await wait(`innerWidth === 700`)
  await read('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  if (!await read(`${modal}.querySelector('.llm-perf-body').scrollWidth <= ${modal}.querySelector('.llm-perf-body').clientWidth`)) throw new Error('Running performance samples overflow the narrow modal')
  win.setSize(1000, 800)
  await wait(`innerWidth === 1000`)
  if (await read(`${runs}.some(text => text.includes('project-a') && text.includes('token/s'))`)) throw new Error('Session without per-call evidence showed speed')
  await click('#performance-focus')
  await read('new Promise(resolve => setTimeout(resolve, 1100))')
  if (!await read(`${modal}.textContent.includes('3 个会话运行中')`)) throw new Error('Focus changed the global source')
  await click('#performance-complete')
  await wait(`${modal}.textContent.includes('2 个会话运行中')`)
  await wait(`Array.from(${modal}.querySelectorAll('.llm-perf-mrow')).some(node => node.textContent.includes('fixture-model') && node.textContent.includes('20.0'))`)
  await click('#performance-stop')
  await wait(`${modal}.textContent.includes('1 个会话运行中') && !Array.from(${modal}.querySelectorAll('.llm-perf-mrow')).some(node => node.textContent.includes('pi-live-model'))`)
  const fixtureState = `JSON.parse(document.querySelector('#performance-fixture-state').textContent)`
  if (nativeVisibility) {
    win.hide()
    await wait(`document.hidden`)
    const hiddenReads = await read(`${fixtureState}.summaryReads`)
    await read('new Promise(resolve => setTimeout(resolve, 1300))')
    if (await read(`${fixtureState}.summaryReads`) !== hiddenReads) throw new Error('Hidden modal kept refreshing')
    win.showInactive()
    await wait(`!document.hidden && ${fixtureState}.summaryReads > ${hiddenReads}`)
  }
  await click('#performance-empty')
  await wait(`${modal}.textContent.includes('无运行中的会话') && ${modal}.querySelector('.llm-perf-running') == null`)
  for (const theme of ['dark', 'light']) {
    win.setSize(1000, 800)
    await wait(`innerWidth === 1000`)
    await read(`document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)}); new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
    const bounds = await read(`(() => { const node = ${modal}, r = node.getBoundingClientRect(); if (node.scrollWidth > node.clientWidth) throw new Error('Performance modal overflows'); return { x: Math.round(r.x), y: Math.round(r.y), width: Math.ceil(r.width), height: Math.ceil(r.height) }; })()`)
    if (screenshot) require('node:fs').writeFileSync(screenshot + '-' + theme + '.png', (await contents.capturePage(bounds)).toPNG())
  }
  // setSize is asynchronous: measure and click only after the renderer reports the new viewport.
  win.setSize(700, 700)
  await wait(`innerWidth === 700`)
  await read('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  if (!await read(`${modal}.scrollWidth <= ${modal}.clientWidth && ${modal}.querySelector('.llm-perf-body').scrollWidth <= ${modal}.querySelector('.llm-perf-body').clientWidth`)) throw new Error('Narrow performance modal overflows')
  win.setSize(1000, 800)
  await wait(`innerWidth === 1000`)
  await click('#performance-summary-error')
  await wait(`${modal}.textContent.includes('运行中会话读取失败：fixture summary unavailable')`)
  if (await read(`${modal}.textContent.includes('无运行中的会话')`)) throw new Error('Summary error retained a stale idle headline')
  await click('.modal-x')
  await wait(`document.querySelector('.llm-perf-modal') == null`)
  const closedReads = await read(`${fixtureState}.summaryReads`)
  await read('new Promise(resolve => setTimeout(resolve, 1300))')
  if (await read(`${fixtureState}.summaryReads`) !== closedReads || await read(`${fixtureState}.dataListeners`) !== baselineListeners) throw new Error('Closed modal retained timer or subscription')
  await click('#performance-history-error')
  await click('.sb-navitem[title="LLM 性能"]')
  await wait(`document.querySelector('.llm-perf-modal') != null`)
  await wait(`Array.from(document.querySelectorAll('.llm-perf-modal [role="alert"]')).some(node => node.textContent.includes('fixture history unavailable'))`)
  if (await read(`document.querySelector('.llm-perf-modal .llm-perf-mrow, .llm-perf-modal .llm-perf-line') != null`)) throw new Error('History error retained apparently successful speed')
  await click('.modal-x')
  return { assertions: ['registry sessions across projects/providers', 'waiting sessions show no speed', 'failed/unmeasured history excluded', 'model medians', 'first-token column + metric switch', 'pointer hover busy + idle', 'model select dims curves', 'range toggle', 'live per-call speed + curves + provisional comparison', 'running samples fit narrow window', 'focus independent', 'done/stopped/idle excluded', 'closed refresh stopped', 'read errors clear stale evidence'], nativeVisibility: nativeVisibility ? 'passed' : 'not-run (requires --native-visibility and user approval)', themes: ['dark', 'light'] }
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
  if (fixtures.includes('meta-prompts')) {
    for (const [entry, name] of [[join(root, 'src/preload/index.ts'), 'meta-prompts-preload'], [join(root, 'scripts/fixtures/meta-prompts-ipc.ts'), 'meta-prompts-ipc']]) {
      await build({
        configFile: false, root: temp, envDir: temp, logLevel: 'error',
        build: {
          outDir: temp, emptyOutDir: false, copyPublicDir: false, minify: false,
          lib: { entry, formats: ['cjs'], fileName: () => `${name}.cjs` },
          rollupOptions: { external: ['electron'] }
        }
      })
    }
  }
  for (const fixture of fixtures) await writeFile(join(temp, `${fixture}.html`), `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'"><link rel="stylesheet" href="${fixture}.css"><div id="root"></div><script src="${fixture}.js"></script>`)
  await writeFile(join(temp, 'main.cjs'), `
    const { app, BrowserWindow, clipboard, ipcMain } = require('electron')
    if (!${nativeVisibility}) require(${JSON.stringify(join(root, 'scripts/hidden-electron-windows.cjs'))})(app)
    // macOS pipes are asynchronous: exit only after the result line is flushed, or the parent sees no result.
    const finish = (result) => process.stdout.write('SCRY_UI_SMOKE_RESULT=' + JSON.stringify(result) + '\\n', () => app.exit(0))
    if (process.platform === 'darwin') app.setActivationPolicy('prohibited')
    app.setPath('userData', ${JSON.stringify(join(temp, 'userData'))})
    app.setPath('sessionData', ${JSON.stringify(join(temp, 'sessionData'))})
    app.whenReady().then(async () => {
      app.dock?.hide()
      const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: ${nativeVisibility} } })
      win.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('file:') }))
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      const logRendererError = (event) => { if (event.level === 'error') console.error('Renderer:', event.message) }
      win.webContents.on('console-message', logRendererError)
      let fixtureContents = win.webContents
      try {
        let result = {}, piCommands = {}
        if (${fixtures.includes('session-cache')}) {
          win.setSize(1200, 900)
          await win.loadFile(${JSON.stringify(join(temp, 'session-cache.html'))})
          result.sessionCache = await (${exerciseSessionCache.toString()})(win.webContents)
          if (${cacheOnly}) { finish(result); return }
        }
        if (${fixtures.includes('meta-prompts')}) {
          const metaWin = new BrowserWindow({ show: false, width: 1200, height: 850, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, partition: 'persist:meta-prompts-test', preload: ${JSON.stringify(join(temp, 'meta-prompts-preload.cjs'))} } })
          fixtureContents = metaWin.webContents
          metaWin.webContents.on('console-message', logRendererError)
          const metaUrl = require('node:url').pathToFileURL(${JSON.stringify(join(temp, 'meta-prompts.html'))}).href
          require(${JSON.stringify(join(temp, 'meta-prompts-ipc.cjs'))}).registerMetaPromptsFixtureIpc(metaWin, metaUrl)
          metaWin.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('file:') }))
          metaWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
          await metaWin.loadFile(${JSON.stringify(join(temp, 'meta-prompts.html'))})
          result.metaPrompts = await (${exerciseMetaPrompts.toString()})(metaWin.webContents, metaWin, clipboard, ${JSON.stringify(process.env.SCRY_META_PROMPTS_SCREENSHOT ?? '')})
          metaWin.destroy()
          fixtureContents = win.webContents
          ipcMain.removeHandler('app:copyText')
          if (${metaPromptsOnly}) {
            finish(result)
            return
          }
        }
        if (${fixtures.includes('llm-performance')}) {
          win.setSize(1000, 800)
          await win.loadFile(${JSON.stringify(join(temp, 'llm-performance.html'))})
          result.llmPerformance = await (${exerciseLlmPerformance.toString()})(win.webContents, win, ${JSON.stringify(process.env.SCRY_LLM_UI_SCREENSHOT ?? '')}, ${nativeVisibility})
          if (${performanceOnly}) {
            finish(result)
            return
          }
        }
        if (${fixtures.includes('pinned-summary-performance')}) {
          await win.loadFile(${JSON.stringify(join(temp, 'pinned-summary-performance.html'))})
          result.summarySampling = await win.webContents.executeJavaScript(${JSON.stringify(`(${exerciseSummarySampling.toString()})()`)})
          const summaryScreenshot = ${JSON.stringify(process.env.SCRY_SUMMARY_UI_SCREENSHOT ?? '')}
          if (summaryScreenshot) {
            for (const theme of ['dark', 'light']) {
              const bounds = await win.webContents.executeJavaScript(\`document.documentElement.setAttribute('data-theme', '\${theme}'); new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => {
                const { x, y, width, height } = document.querySelector('.pinned-summary-card').getBoundingClientRect()
                resolve({ x: Math.round(x), y: Math.round(y), width: Math.ceil(width), height: Math.ceil(height) })
              })))\`)
              const image = await win.webContents.capturePage(bounds)
              require('node:fs').writeFileSync(summaryScreenshot + '-' + theme + '.png', image.toPNG())
            }
          }
        }
        if (${summaryOnly}) {
          await win.loadFile(${JSON.stringify(join(temp, 'session-capability.html'))})
          Object.assign(result, await win.webContents.executeJavaScript(${JSON.stringify(`(${exercise.toString()})()`)}))
          finish(result)
          return
        }
        if (!${selectionOnly || modelsOnly || terminalsOnly}) {
          await win.loadFile(${JSON.stringify(join(temp, 'session-capability.html'))})
          if (!${piCommandsOnly || overviewOnly}) Object.assign(result, await win.webContents.executeJavaScript(${JSON.stringify(`(${exercise.toString()})()` )}))
          if (!${overviewOnly}) piCommands = await (${exercisePiCommands.toString()})(win.webContents)
          if (!${piCommandsOnly}) {
            await win.loadFile(${JSON.stringify(join(temp, 'session-capability.html'))})
            win.setSize(1000, 700)
            result.overviewDensity = await (${exerciseOverviewDensity.toString()})(win.webContents, ${JSON.stringify(process.env.SCRY_OVERVIEW_UI_SCREENSHOT ?? '')})
          }
        }
        const selection = []
        win.setSize(1200, 900)
        for (const scenario of ${JSON.stringify(overviewOnly || piCommandsOnly || modelsOnly || terminalsOnly ? [] : ['repeat-pending', 'late-startup-loading', 'provider-switch', 'same-provider', 'late-startup', 'rapid-switch', 'focused-event', 'new-draft', 'stale-live', 'stale-run'])}) {
          await win.loadFile(${JSON.stringify(join(temp, 'session-selection.html'))}, { query: { scenario } })
          selection.push(await (${exerciseSessionSelection.toString()})(win.webContents, scenario))
        }
        const piPermissions = []
        for (const scenario of ${JSON.stringify(overviewOnly || selectionOnly || piCommandsOnly || modelsOnly || terminalsOnly ? [] : ['fresh', 'saved'])}) {
          await win.loadFile(${JSON.stringify(join(temp, 'pi-permission.html'))}, { query: { scenario } })
          piPermissions.push(await (${exercisePiPermission.toString()})(win.webContents, scenario))
        }
        let sessionModels = null
        if (${!overviewOnly && !selectionOnly && !piCommandsOnly && !terminalsOnly}) {
          await win.loadFile(${JSON.stringify(join(temp, 'session-model.html'))})
          sessionModels = await (${exerciseSessionModels.toString()})(win.webContents, ${JSON.stringify(process.env.SCRY_CAPABILITIES_UI_SCREENSHOT ?? '')})
        }
        const sessionTerminals = []
        for (const scenario of ${JSON.stringify(overviewOnly || selectionOnly || piCommandsOnly || modelsOnly ? [] : ['restored', 'pending'])}) {
          await win.loadFile(${JSON.stringify(join(temp, 'session-terminal.html'))}, { query: { scenario } })
          sessionTerminals.push(await (${exerciseSessionTerminals.toString()})(win.webContents, scenario))
        }
        finish({ ...result, ...piCommands, selection, piPermissions, sessionModels, sessionTerminals })
      } catch (error) {
        console.error(error)
        console.error('Failed fixture:', fixtureContents.getURL())
        console.error('Fixture DOM:', await fixtureContents.executeJavaScript('document.body?.textContent.slice(-3000)').catch(error => error.message))
        app.exit(1)
      }
    }).catch(error => { console.error(error); app.exit(1) })
  `)
  await new Promise((resolve, reject) => {
    // The fixture window is shown inactive and may sit behind the user's windows. Occluded windows stop
    // producing frames, which stalls requestAnimationFrame and frame-aligned mousemove; hide() still hides.
    const child = spawn(electron, [join(temp, 'main.cjs'), '--disable-gpu', '--disable-backgrounding-occluded-windows'], {
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
