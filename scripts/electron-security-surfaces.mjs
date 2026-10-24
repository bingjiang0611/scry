import assert from 'node:assert/strict'
import { symlinkSync } from 'node:fs'
import { join } from 'node:path'

export async function exerciseSurfaces(smokeContext) {
  const { evaluate, canonicalWorkspace, workspace, temp } = smokeContext
  const csp = await evaluate(`new Promise((resolve) => {
    let violated = false
    const onViolation = () => { violated = true }
    document.addEventListener('securitypolicyviolation', onViolation, { once: true })
    const script = document.createElement('script')
    script.textContent = 'window.__scryInlineScriptRan = true'
    document.head.append(script)
    setTimeout(() => resolve({ violated, executed: window.__scryInlineScriptRan === true }), 50)
  })`)
  assert.deepEqual(csp, { violated: true, executed: false })

  const surfaceSmoke = await evaluate(`(async () => {
    const current = (selector) => document.querySelector('[data-session-surface-current="true"]')?.querySelector(selector)
    const waitFor = async (selector, timeout = 4_000) => {
      const deadline = Date.now() + timeout
      let node = null
      while (!node && Date.now() < deadline) {
        node = selector.startsWith('button') ? document.querySelector(selector) : current(selector)
        if (!node) await new Promise((resolve) => setTimeout(resolve, 50))
      }
      return node
    }
    const openSurface = async (label, selector) => {
      current('button[aria-label="添加 Surface"]')?.click()
      const deadline = Date.now() + 2_000
      let item = null
      while (!item && Date.now() < deadline) {
        item = [...document.querySelectorAll('[role="menuitem"]')]
          .find((node) => node.textContent?.trim().startsWith(label)) || null
        if (!item) await new Promise((resolve) => setTimeout(resolve, 50))
      }
      item?.click()
      return waitFor(selector)
    }

    const unboundButton = await waitFor('button[title="右侧工作区"]')
    const unboundInitiallyHidden = !document.querySelector('.right-surface-panel')
      && unboundButton?.getAttribute('aria-pressed') === 'false'
    unboundButton?.click()
    const unboundPanel = await waitFor('.right-surface-panel')
    const unboundOpened = !!unboundPanel
      && document.querySelector('button[title="右侧工作区"]')?.getAttribute('aria-pressed') === 'true'
    const unboundTerminal = unboundPanel ? await openSurface('终端', '.terminal-surface') : null
    const unboundTerminalRunning = unboundTerminal ? await waitFor('.terminal-state.running') : null
    document.querySelector('button[aria-label="隐藏右侧工作区"]')?.click()
    await new Promise((resolve) => setTimeout(resolve, 50))
    const unboundHidden = document.querySelector('.app')?.classList.contains('right-panel-hidden') === true
      && document.querySelector('button[title="右侧工作区"]')?.getAttribute('aria-pressed') === 'false'
    const unboundTerminalRetained = !!document.querySelector('.terminal-surface')

    const recent = await waitFor('button.sb-sess')
    recent?.click()
    await new Promise((resolve) => setTimeout(resolve, 100))
    const scopedSelection = !current('.terminal-surface') && unboundTerminal?.getBoundingClientRect().width === 0
    document.querySelector('button[title="右侧工作区"]')?.click()
    await new Promise((resolve) => setTimeout(resolve, 50))
    const panel = current('.right-surface-panel')
    const terminal = panel ? await openSurface('终端', '.terminal-surface') : null
    const agents = terminal ? await openSurface('Agents', '.agents-surface') : null
    const activeTab = current('[role="tab"][aria-selected="true"]')
    const terminalPanel = current('.surface-content-terminal')

    current('button[aria-label="最大化右侧工作区"]')?.click()
    await new Promise((resolve) => setTimeout(resolve, 50))
    const maximized = document.querySelector('.app')?.classList.contains('right-panel-maximized') === true
    current('button[aria-label="恢复右侧工作区"]')?.click()
    await new Promise((resolve) => setTimeout(resolve, 50))
    const restored = document.querySelector('.app')?.classList.contains('right-panel-maximized') === false

    current('button[aria-label="隐藏右侧工作区"]')?.click()
    await new Promise((resolve) => setTimeout(resolve, 50))
    const hidden = document.querySelector('.app')?.classList.contains('right-panel-hidden') === true
    const terminalRetained = !!document.querySelector('.terminal-surface')
    document.querySelector('button[title="右侧工作区"]')?.click()
    await new Promise((resolve) => setTimeout(resolve, 50))
    const reopened = document.querySelector('.app')?.classList.contains('right-panel-hidden') === false

    return {
      unboundButton: !!unboundButton,
      unboundInitiallyHidden,
      unboundOpened,
      unboundTerminal: !!unboundTerminal,
      unboundTerminalRunning: !!unboundTerminalRunning,
      unboundHidden,
      unboundTerminalRetained,
      scopedSelection,
      panel: !!panel,
      terminal: !!terminal,
      agents: !!agents,
      agentsActive: activeTab?.textContent?.includes('Agents') === true,
      terminalHiddenButMounted: terminalPanel?.hidden === true && terminalRetained,
      maximized,
      restored,
      hidden,
      reopened
    }
  })()`)
  assert.deepEqual(surfaceSmoke, {
    unboundButton: true,
    unboundInitiallyHidden: true,
    unboundOpened: true,
    unboundTerminal: true,
    unboundTerminalRunning: true,
    unboundHidden: true,
    unboundTerminalRetained: true,
    scopedSelection: true,
    panel: true,
    terminal: true,
    agents: true,
    agentsActive: true,
    terminalHiddenButMounted: true,
    maximized: true,
    restored: true,
    hidden: true,
    reopened: true
  })

  symlinkSync(temp, join(workspace, 'git-outside-link'))
  const gitBoundary = await evaluate(`(async () => {
    const cwd = ${JSON.stringify(canonicalWorkspace)}
    const result = await window.scry.gitDiff(cwd)
    const rejected = []
    for (const input of [null, {}, ${JSON.stringify(temp)}, ${JSON.stringify(join(workspace, 'git-outside-link'))}]) {
      try { await window.scry.gitDiff(input); rejected.push(false) }
      catch { rejected.push(true) }
    }
    return { result, rejected }
  })()`)
  assert.match(gitBoundary.result.collectedAt, /^\d{4}-\d{2}-\d{2}T/)
  const { collectedAt: _collectedAt, ...gitBoundaryResult } = gitBoundary.result
  assert.deepEqual({ ...gitBoundary, result: gitBoundaryResult }, {
    result: { status: 'unavailable', reason: 'not_git', files: [] },
    rejected: [true, true, true, true]
  })
  console.log('Workspace Git diff: production preload/main preserve unavailable evidence and reject invalid, unapproved and symlink-escape directories')
  return { surfaceSmoke }
}
