// Runs inside the sandboxed fixture page. Production WorkflowSurface fed by synthetic wire
// messages through the production normalizer; no Provider, account or real workflow run.
export async function exerciseWorkflowSurface(mode) {
  const check = (ok, message) => { if (!ok) throw new Error(`[${mode} @${innerWidth}px] ${message}`) }
  const deadline = performance.now() + 5000
  while (!document.querySelector('.workflow-surface')) {
    if (performance.now() > deadline) throw new Error('Workflow surface did not render')
    await new Promise((resolve) => requestAnimationFrame(resolve))
  }
  const surface = document.querySelector('.workflow-surface')
  const text = surface.innerText
  const phases = [...surface.querySelectorAll('.workflow-phase')]
  const rect = (element) => element.getBoundingClientRect()
  // Nothing may be clipped sideways at any pane width; long script lines scroll in their own box.
  check(surface.scrollWidth <= surface.clientWidth + 1, `surface overflows horizontally: ${surface.scrollWidth} > ${surface.clientWidth}`)
  const body = surface.querySelector('.workflow-body')
  if (body) check(body.scrollWidth <= body.clientWidth + 1, 'body overflows horizontally')

  if (mode === 'empty') {
    check(text.includes('本会话尚未观测到 Workflow'), 'empty state copy missing')
    check(phases.length === 0 && !text.includes('agents 0'), 'empty state must not show zero-count phases')
    return { mode, phases: 0 }
  }
  if (mode === 'unavailable') {
    check(phases.length === 0, 'unavailable progress must not render phases')
    check(text.includes('workflow_progress'), 'unavailable note missing')
    check(text.includes('deep-research') && !surface.querySelector('.workflow-script-lines'), 'script must be reported as not provided')
    check(text.includes('4.2k tokens'), 'task-level usage missing')
    return { mode, phases: 0 }
  }

  check(phases.length === 3, `expected 3 phases, got ${phases.length}`)
  const wide = rect(surface).width >= 760
  const tops = phases.map((phase) => Math.round(rect(phase).top))
  if (wide) {
    check(new Set(tops).size === 1, `phases must sit side by side when wide: ${tops}`)
    check(rect(surface.querySelector('.workflow-script')).right <= rect(surface.querySelector('.workflow-flow')).left + 1, 'script pane must be left of the flow')
  } else {
    check(new Set(tops).size === 3, `phases must stack when narrow: ${tops}`)
  }
  const statuses = phases.map((phase) => phase.dataset.status)
  const chip = (status) => surface.querySelector(`.workflow-agent-chip[data-status="${status}"]`)
  if (mode === 'complete') {
    check(text.includes('agents 6/6') && text.includes('已完成'), 'completed header missing')
    check(statuses.join() === 'done,failed,done', `phase statuses: ${statuses}`)
    check(Boolean(chip('failed')), 'failed agent chip missing')
    check(!surface.querySelector('[data-active]'), 'a finished run must not highlight a running script line')
  }
  if (mode === 'running') {
    check(text.includes('agents 3/5') && text.includes('运行中'), 'running header missing')
    check(statuses.join() === 'done,running,pending', `phase statuses: ${statuses}`)
    const active = [...surface.querySelectorAll('.workflow-script-lines [data-active]')]
    check(active.length === 1 && active[0].innerText.includes("phase('edit')"), 'running phase line must be highlighted')
    check(phases[2].innerText.includes('尚未观测到 agent'), 'pending phase must say no agent observed')
  }
  if (mode === 'unknown') {
    check(text.includes('状态未知') && !text.includes('已完成 ·'), 'missing terminal must stay unknown')
    check(surface.querySelectorAll('.workflow-agent-chip[data-status="unsettled"]').length === 2, 'unsettled agents missing')
    check(statuses.join() === 'done,unsettled,pending', `an unreported outcome must not be drawn as failed or done: ${statuses}`)
  }
  const target = chip(mode === 'complete' ? 'failed' : mode === 'running' ? 'running' : 'unsettled')
  target.scrollIntoView({ block: 'center' })
  const box = rect(target)
  return { mode, phases: phases.length, wide, statuses, click: { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) } }
}

/** After a native click on an agent chip: the detail opens, states its evidence, and closes. */
export async function exerciseWorkflowDetail(mode) {
  const check = (ok, message) => { if (!ok) throw new Error(`[${mode} detail] ${message}`) }
  const deadline = performance.now() + 3000
  while (!document.querySelector('.workflow-agent-detail')) {
    if (performance.now() > deadline) throw new Error(`[${mode}] native click did not open the agent detail`)
    await new Promise((resolve) => requestAnimationFrame(resolve))
  }
  const detail = document.querySelector('.workflow-agent-detail')
  check(document.querySelectorAll('.workflow-agent-chip[aria-pressed="true"]').length === 1, 'exactly one chip must be selected')
  if (mode === 'complete') check(detail.innerText.includes('stalled') && detail.innerText.includes('第 2 次尝试'), 'failed agent error/attempt missing')
  if (mode === 'unknown') check(detail.innerText.includes('终态未上报'), 'unsettled label missing')
  const surface = document.querySelector('.workflow-surface')
  check(surface.scrollWidth <= surface.clientWidth + 1, 'detail overflows horizontally')
  detail.querySelector('header button').click()
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  check(!document.querySelector('.workflow-agent-detail'), 'detail did not close')
  return true
}

/**
 * The chat card asked for the first run. The user then picks the second one, and the next
 * streaming snapshot of the first must not drag the surface back.
 *
 * The option list of a `<select>` is an OS-level popup that cannot be driven headlessly, so the
 * pick dispatches the same `change` a real selection produces. What this check owns is the state
 * after the pick; the pointer path into the surface is covered by the archive replay smoke.
 */
export async function exerciseWorkflowFocus() {
  const deadline = performance.now() + 5000
  while (!document.querySelector('.workflow-run-picker')) {
    if (performance.now() > deadline) throw new Error('[focus] run picker did not render')
    await new Promise((resolve) => requestAnimationFrame(resolve))
  }
  const select = document.querySelector('.workflow-run-picker')
  const values = [...select.options].map((option) => option.value)
  if (values.length !== 2) throw new Error(`[focus] expected two runs, got ${values.length}`)
  if (select.value !== values[0]) throw new Error(`[focus] the requested run must be selected first, got ${select.value}`)
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
  setter.call(select, values[1])
  select.dispatchEvent(new Event('change', { bubbles: true }))
  for (let frame = 0; frame < 3; frame += 1) await new Promise((resolve) => requestAnimationFrame(resolve))
  if (select.value !== values[1]) throw new Error(`[focus] picking the second run did not take: ${select.value}`)
  const streamNext = window.streamNext
  if (typeof streamNext !== 'function') throw new Error('[focus] the fixture cannot emit a stream update')
  streamNext()
  for (let frame = 0; frame < 3; frame += 1) await new Promise((resolve) => requestAnimationFrame(resolve))
  if (select.value !== values[1]) throw new Error(`[focus] a stream update dragged the selection back to ${select.value}`)
  const surface = document.querySelector('.workflow-surface')
  if (!surface.innerText.includes('agents 6/6')) throw new Error('[focus] the picked run is not the one rendered')
  return { runs: values.length, selected: select.value }
}
