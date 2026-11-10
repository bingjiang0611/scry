import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { seedArchivedTurn, seedNativeTranscript } from './archived-turn-smoke.mjs'
import { join } from 'node:path'

/**
 * Replay an archived workflow turn in the real App: open the session, open the Workflow
 * surface, and require the rendered phases and agents to match the archived evidence.
 *
 * Nothing here talks to a Provider. The archive was produced by the production normalizer
 * from wire messages, so this is the regression for history recovery, the projection and
 * the surface together.
 */
// Second launch of the same temporary userData/HOME: nothing is seeded again, so a session
// that appears proves the App read it back from disk after a real quit and restart.
export const workflowArchiveReuse = process.argv[5] === '--reuse'

/** Preview text of the second replayed session: same archive, no workflow rows. */
export const PLAIN_SESSION_PREVIEW = 'Plain replay'

/** Seed the archived turn and its Provider transcript for the first launch of the replay. */
export function prepareWorkflowArchive({ userDataDir, home, source, nativePath }) {
  seedArchivedTurn({ userDataDir, source, preview: 'Archived workflow replay', rewrite: !workflowArchiveReuse })
  // A second session without workflow rows: switching to it must not keep showing the first
  // session's run, and switching back must restore it.
  seedArchivedTurn({
    userDataDir,
    source: {
      ...source,
      sessionId: 'plain-replay',
      externalSessionId: 'plain-replay',
      turns: [{
        ...source.turns[0],
        runId: 'plain-replay',
        items: source.turns[0].items.filter((item) => item.stage !== 'workflow_activity')
      }]
    },
    preview: PLAIN_SESSION_PREVIEW,
    rewrite: !workflowArchiveReuse
  })
  // On a relaunch the transcript must already be on disk from the previous process.
  if (workflowArchiveReuse) return
  const rows = readFileSync(nativePath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
  seedNativeTranscript({ home, cwd: source.cwd, sessionId: 'workflow-archive-replay', messages: rows })
}

export async function exerciseWorkflowArchive(context) {
  const { evaluate, cdp } = context
  const source = context.sourceFileHistory
  const turn = source.turns[0]
  const screenshotDir = process.env.SCRY_WORKFLOW_ARCHIVE_SCREENSHOT?.trim()
  const workflowItems = turn.items.filter((event) => event.stage === 'workflow_activity')
  // Set by the wrapper's second launch: same userData/HOME, nothing re-seeded (see --reuse).
  const relaunch = workflowArchiveReuse
  assert.ok(workflowItems.length > 0, 'the archived turn must contain workflow_activity events')

  const wait = (expression, timeoutMs = 20000) => evaluate(`(async () => {
    const deadline = performance.now() + ${timeoutMs};
    while (!(${expression})) {
      if (performance.now() > deadline) throw new Error('Workflow archive UI timed out: ' + ${JSON.stringify(expression)});
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  })()`)
  /** Wait until the element is painted where a pointer would land, not just in the DOM. */
  const waitClickable = (expression, timeoutMs = 20000) => wait(`(() => {
    const target = ${expression};
    if (!target) return false;
    const rect = target.getBoundingClientRect();
    return rect.width > 0 && target.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2));
  })()`, timeoutMs)
  const click = async (expression) => {
    const point = await evaluate(`(() => {
      const target = ${expression};
      if (!target) throw new Error('Workflow archive target not found: ' + ${JSON.stringify(expression)});
      target.scrollIntoView({ block: 'center' });
      const rect = target.getBoundingClientRect();
      const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
      const at = document.elementFromPoint(x, y);
      if (!target.contains(at)) throw new Error('Workflow archive target obscured: ' + JSON.stringify({
        rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
        hit: at ? at.tagName + '.' + at.className : null,
        matches: [...document.querySelectorAll('.tool-card .tool-workflow-open')].length
      }));
      return { x, y };
    })()`)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
  }
  const capture = async (name) => {
    if (!screenshotDir) return
    await evaluate(`(async () => { await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))) })()`)
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(screenshotDir, `${name}.png`), Buffer.from(shot.data, 'base64'))
  }
  const openSession = async (preview = 'Archived workflow replay') => {
    await wait(`Array.from(document.querySelectorAll('.sb-sess')).some(button => button.textContent.includes(${JSON.stringify(preview)}))`)
    await click(`Array.from(document.querySelectorAll('.sb-sess')).find(button => button.textContent.includes(${JSON.stringify(preview)}))`)
    // Completed turns fold consecutive tool calls into one disclosure; open it to reach the card.
    await wait(`document.querySelector('#main-pane .tool-group-row, #main-pane .tool-card') != null`)
    if (await evaluate(`document.querySelector('#main-pane .tool-card') == null`)) {
      await click(`document.querySelector('#main-pane .tool-group-row')`)
    }
    await wait(`document.querySelector('#main-pane .tool-card') != null`)
  }
  /** Open the Workflow surface the way a user does: the panel pill, then the chooser card. */
  const openWorkflowSurface = async () => {
    if (await evaluate(`document.querySelector('#right-surface-pane [data-session-surface-current="true"] .workflow-surface') != null`)) return
    if (await evaluate(`document.querySelector('.app.right-panel-hidden') != null`)) {
      await click(`document.querySelector('.panel-pill:not(.summary-pill)')`)
      await wait(`document.querySelector('.app.right-panel-hidden') == null`)
    }
    if (await evaluate(`document.querySelector('[data-surface-tab="workflow"] [role="tab"]') != null`)) {
      await click(`document.querySelector('[data-surface-tab="workflow"] [role="tab"]')`)
    } else if (await evaluate(`document.querySelector('[data-surface-chooser]') != null`)) {
      await click(`Array.from(document.querySelectorAll('[data-surface-chooser] .surface-card')).find(card => card.textContent.includes('Workflow'))`)
    } else {
      // A session that already shows another surface adds one from the tab-strip menu.
      // The remote panel keeps its own hidden tab strip, so scope to the visible panel.
      // An inert copy of the panel exists for the remote view; only the painted strip is real.
      const painted = `Array.from(document.querySelectorAll('[aria-label="添加 Surface"]')).find(node => node.getBoundingClientRect().width > 0)`
      await click(painted)
      await wait(`Array.from(document.querySelectorAll('[role="menu"] [role="menuitem"]')).some(item => item.getBoundingClientRect().width > 0)`)
      await click(`Array.from(document.querySelectorAll('[role="menu"] [role="menuitem"]'))
        .find(item => item.getBoundingClientRect().width > 0 && item.textContent.includes('Workflow'))`)
    }
    await wait(`document.querySelector('#right-surface-pane [data-session-surface-current="true"] .workflow-surface') != null`)
  }
  const renderedState = () => evaluate(`(() => {
    const surface = document.querySelector('#right-surface-pane [data-session-surface-current="true"] .workflow-surface')
    if (!surface) return null
    return {
      status: surface.querySelector('.workflow-header .workflow-chip')?.textContent ?? null,
      statusTitle: surface.querySelector('.workflow-header .workflow-chip')?.getAttribute('title') ?? null,
      scriptLines: surface.querySelectorAll('.workflow-script-lines li').length,
      phases: [...surface.querySelectorAll('.workflow-phase')].map((card) => ({
        title: card.querySelector('.workflow-phase-head strong')?.textContent ?? null,
        status: card.dataset.status,
        count: card.querySelector('.workflow-phase-count span')?.textContent ?? null,
        agents: [...card.querySelectorAll('.workflow-agent-chip')].map((chip) => ({
          label: chip.textContent.trim(), status: chip.dataset.status
        }))
      })),
      log: surface.querySelectorAll('.workflow-log li').length,
      // The chat card proves the tool call exists, so the surface must not claim it is missing.
      callObserved: surface.querySelector('.workflow-node.main')?.dataset.observed ?? null,
      // A clipped surface is a layout bug the user sees, so the replay checks it too.
      overflow: {
        pane: surface.scrollWidth - surface.clientWidth,
        document: document.documentElement.scrollWidth - window.innerWidth
      },
      notices: [...surface.querySelectorAll('.workflow-notices li')].map((node) => node.textContent)
    }
  })()`)

  const { deriveWorkflowRuns } = await import('./workflow-wire-modules.mjs').then((module) => module.loadWorkflowModules())
  const [run] = deriveWorkflowRuns([{ runId: turn.runId, userText: turn.userText, items: turn.items, done: turn.done }], { busy: false })
  assert.ok(run, 'the archived turn must fold into one workflow run')
  const RUN_STATUS_LABEL = {
    launching: '启动中', running: '运行中', paused: '已暂停',
    completed: '已完成', failed: '失败', stopped: '已停止', unknown: '状态未知'
  }

  const verify = (rendered, { label }) => {
    assert.equal(rendered.phases.length, run.phases.length, `${label}: phase count must match the archive`)
    assert.equal(rendered.status, RUN_STATUS_LABEL[run.status], `${label}: run status must match the archive`)
    for (const phase of run.phases) {
      const card = rendered.phases.find((candidate) => candidate.title === phase.title)
      assert.ok(card, `${label}: missing phase ${phase.title}`)
      assert.equal(card.agents.length, Math.min(phase.agents.length, 48), `${label}: agent chips for ${phase.title}`)
      for (const agent of phase.agents.slice(0, 48)) {
        const name = agent.row.label ?? `#${agent.row.index}`
        const chip = card.agents.find((candidate) => candidate.label === name)
        assert.ok(chip, `${label}: missing agent ${name}`)
        assert.equal(chip.status, agent.status, `${label}: agent ${name} status`)
      }
    }
    assert.equal(rendered.scriptLines, Math.min(run.script?.text.split('\n').length ?? 0, 800), `${label}: script lines`)
    assert.equal(rendered.callObserved, 'true', `${label}: the observed Workflow tool call must be shown as observed`)
    assert.ok(rendered.overflow.pane <= 0, `${label}: the workflow surface must not scroll horizontally (${rendered.overflow.pane}px)`)
    assert.ok(rendered.overflow.document <= 0, `${label}: the window must not scroll horizontally (${rendered.overflow.document}px)`)
  }

  try {
    await openSession()
  } catch (error) {
    await capture('workflow-archive-failure')
    const pane = await evaluate(`(() => ({ text: document.querySelector('#main-pane')?.innerText.slice(0, 1200) ?? null,
      html: document.querySelector('#main-pane .chat-transcript-content')?.innerHTML.slice(0, 4000) ?? null,
      sessions: [...document.querySelectorAll('.sb-sess')].map(node => node.textContent.trim().slice(0, 40)) }))()`)
    console.error('Workflow archive session did not open:', JSON.stringify(pane))
    throw error
  }
  assert.deepEqual(await evaluate('window.scry.activeRuns()'), [], 'replaying an archive must not start a Provider run')
  // Transcript and archive describe the same turn; pairing them is what keeps stages, agents and
  // terminal state in one place instead of two competing turns.
  assert.equal(await evaluate(`document.querySelectorAll('#main-pane .turn').length`), 1,
    'the transcript turn and the archived turn must merge into one')
  await capture('workflow-archive-chat')

  // The chat tool card is the entry point the user has.
  await waitClickable(`document.querySelector('.tool-card .tool-workflow-open')`)
  await click(`document.querySelector('.tool-card .tool-workflow-open')`)
  await wait(`document.querySelector('#right-surface-pane [data-session-surface-current="true"] .workflow-surface') != null`)
  try {
    await wait(`document.querySelectorAll('#right-surface-pane .workflow-phase').length > 0`)
  } catch (error) {
    await capture('workflow-archive-empty-surface')
    console.error('Workflow surface after opening from the chat card:',
      JSON.stringify(await evaluate(`document.querySelector('#right-surface-pane')?.innerText.slice(0, 600) ?? null`)))
    throw error
  }
  const first = await renderedState()
  verify(first, { label: 'after opening from the chat card' })
  await capture('workflow-archive-surface')
  if (relaunch) await capture('workflow-archive-relaunch')

  // A full renderer reload re-reads the turn from the archive, which is the restart path
  // without touching the archive on disk.
  await cdp.send('Page.reload', { ignoreCache: true })
  await new Promise((resolve) => setTimeout(resolve, 1500))
  await openSession()
  await openWorkflowSurface()
  try {
    await wait(`document.querySelectorAll('#right-surface-pane .workflow-phase').length > 0`)
  } catch (error) {
    await capture('workflow-archive-reload-empty')
    console.error('Workflow surface after reload:', JSON.stringify(await evaluate(`({
      surface: document.querySelector('#right-surface-pane')?.innerText.slice(0, 600) ?? null,
      cards: document.querySelectorAll('#main-pane .tool-card').length,
      turns: document.querySelectorAll('#main-pane .turn').length
    })`)))
    throw error
  }
  const reloaded = await renderedState()
  verify(reloaded, { label: 'after reloading the session from the archive' })
  await capture('workflow-archive-reloaded')

  // Layout: the pane is user-resizable and the window is user-sizable. Drive the real splitter
  // to its minimum, then emulate the window widths a user gets by resizing the window, and read
  // the layout the user would see at each size.
  const splitter = `document.querySelector('.panel-resizer')`
  const layout = []
  if (await evaluate(`${splitter} != null`)) {
    await waitClickable(splitter)
    await click(splitter)
    for (let step = 0; step < 30; step += 1) {
      await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 })
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 })
    }
    const state = await renderedState()
    verify(state, { label: 'pane at its minimum width' })
    layout.push({ name: 'pane-min', width: await evaluate(`document.querySelector('#right-surface-pane').clientWidth`), phases: state.phases.length, overflow: state.overflow.pane })
    await capture('workflow-archive-layout-pane-min')
    for (let step = 0; step < 30; step += 1) {
      await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 })
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 })
    }
  }
  for (const [name, width, height] of [['narrow', 900, 700], ['wide', 1600, 1000]]) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
    await evaluate(`(async () => { await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))) })()`)
    const state = await renderedState()
    verify(state, { label: `window ${name} (${width}px)` })
    layout.push({ name, width: await evaluate('window.innerWidth'), phases: state.phases.length, overflow: state.overflow })
    await capture(`workflow-archive-layout-${name}`)
  }
  await cdp.send('Emulation.clearDeviceMetricsOverride')
  await wait(`document.querySelectorAll('#right-surface-pane .workflow-phase').length > 0`)

  // Adjacent paths: another tab and another session must not inherit this run.
  const agentsTab = `document.querySelector('[data-surface-tab="agents"] [role="tab"]')`
  if (await evaluate(`${agentsTab} != null`)) {
    await click(agentsTab)
    await wait(`document.querySelector('[data-surface-tab="agents"] [role="tab"]').getAttribute('aria-selected') === 'true'`)
    const agentsText = await evaluate(`document.querySelector('#right-surface-pane')?.innerText ?? ''`)
    for (const agent of run.phases.flatMap((phase) => phase.agents)) {
      const label = agent.row.label
      if (!label || label.length < 5) continue
      assert.ok(!agentsText.includes(label), `the Agents tab must not list the workflow agent ${label}`)
    }
    await click(`document.querySelector('[data-surface-tab="workflow"] [role="tab"]')`)
    await wait(`document.querySelector('[data-surface-tab="workflow"] [role="tab"]').getAttribute('aria-selected') === 'true'`)
    verify(await renderedState(), { label: 'after returning from the Agents tab' })
  }

  await openSession(PLAIN_SESSION_PREVIEW)
  try {
    await openWorkflowSurface()
  } catch (error) {
    await capture('workflow-archive-plain-failure')
    console.error('Plain session surface:', JSON.stringify(await evaluate(`({
      pane: document.querySelector('#right-surface-pane')?.innerText.slice(0, 800) ?? null,
      tabs: [...document.querySelectorAll('[data-surface-tab]')].map(node => node.dataset.surfaceTab + ':' + node.getAttribute('aria-selected')),
      chooser: document.querySelectorAll('[data-surface-chooser]').length,
      hidden: document.querySelector('.app.right-panel-hidden') != null,
      active: document.querySelector('.sb-sess.active, .sb-sess[aria-current]')?.textContent ?? null
    })`)))
    throw error
  }
  const plainSurface = await renderedState()
  const plainAgents = plainSurface?.phases.reduce((total, phase) => total + phase.agents.length, 0) ?? 0
  assert.equal(plainAgents, 0, 'a session without workflow rows must not show the other run\'s agents')
  for (const phase of run.phases) {
    const leaked = await evaluate(`Array.from(document.querySelectorAll('#right-surface-pane .workflow-phase-head strong')).some(node => node.textContent === ${JSON.stringify(phase.title)})`)
    assert.ok(!leaked, `a session without workflow rows must not show phase ${phase.title}`)
  }
  await capture('workflow-archive-plain-session')
  await openSession()
  await openWorkflowSurface()
  await wait(`document.querySelectorAll('#right-surface-pane .workflow-phase').length > 0`)
  verify(await renderedState(), { label: 'after switching back from a session without workflow rows' })

  return {
    relaunch,
    archivedWorkflow: {
      runId: turn.runId,
      events: workflowItems.length,
      archivedPhases: run.phases.length,
      archivedAgents: run.agentCount,
      status: first.status,
      statusTitle: first.statusTitle,
      phases: first.phases.map((phase) => [phase.title, phase.status, phase.count]),
      agents: first.phases.reduce((total, phase) => total + phase.agents.length, 0),
      logEntries: first.log,
      scriptLines: first.scriptLines,
      notices: first.notices,
      reloaded: { status: reloaded.status, phases: reloaded.phases.length, logEntries: reloaded.log },
      layout: layout.map((row) => [row.name, row.width, row.phases, row.overflow]),
      plainSession: { status: plainSurface?.status ?? null, phases: plainSurface?.phases.length ?? 0, agents: plainAgents },
      noProviderRuns: true,
      isolatedUserData: true
    }
  }
}
