import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nativeUiPointer } from './native-ui-pointer.mjs'
import { exerciseWorkspaceDiffBounds } from './workspace-session-ui-stress.mjs'
import { assertPickerAnchored, assertNewWorktreeDefaults, assertCompactMenus } from './workspace-session-ui-picker.mjs'
import { wait, sendWorkspacePrompt } from './workspace-session-ui-run.mjs'
import { selectDiffScope, exerciseTurnMenu } from './diff-inspector-ui.mjs'

const json = JSON.stringify
/** Production App + preload + native Git, with the existing isolated, non-network Provider fixture. */
export async function exerciseWorkspaceSessions(context) {
  const { cdp, evaluate, workspace, canonicalWorkspace, conversationInputs, userDataDir, temp, secondWorkspace } = context
  const evidence = mkdtempSync(join(tmpdir(), 'scry-workspace-session-ui-'))
  const git = (cwd, ...args) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null',
    '-c', 'user.name=bingjiang0611', '-c', 'user.email=307659028+bingjiang0611@users.noreply.github.com', ...args],
  { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).trim()
  const inputs = () => existsSync(conversationInputs)
    ? readFileSync(conversationInputs, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter(item => item.operation !== 'steer') : []
  const click = async (selector, text = '') => {
    const point = await evaluate(`(${nativeUiPointer.toString()})(${json(selector)}, ${json({ text, timeoutMs: 5000, scroll: true, captureReceipt: true })})`)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
    assert.deepEqual(await evaluate('({ trusted: window.__nativeUiPointerReceipt?.trusted, targetMatched: window.__nativeUiPointerReceipt?.targetMatched })'),
      { trusted: true, targetMatched: true }, `native pointer must hit ${selector}`)
  }
  const key = async (key, code, windowsVirtualKeyCode, modifiers = 0) => {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode, modifiers,
      ...(key === 'a' && modifiers ? { commands: ['selectAll'] } : {}) })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode, modifiers })
  }
  const type = async (selector, value) => {
    await click(selector)
    await key('a', 'KeyA', 65, process.platform === 'darwin' ? 4 : 2)
    await cdp.send('Input.insertText', { text: value })
  }
  const screenshot = async name => {
    const result = await cdp.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(evidence, `${name}.png`), Buffer.from(result.data, 'base64'))
  }
  const newDraft = async cwd => {
    const selector = `.sb-proj-new[aria-label$=${json(cwd)}]`
    await wait(() => evaluate(`Boolean(document.querySelector(${json(selector)}))`), `project ${cwd}`)
    const point = await evaluate(`(() => { const element = document.querySelector(${json(selector)}).closest('.sb-proj');
      const box = element.querySelector('.sb-proj-head').getBoundingClientRect(); return { x: box.x + 20, y: box.y + box.height / 2 } })()`)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
    await click(selector)
    await wait(() => evaluate(`document.querySelector('.workspace-context-strip button')?.disabled === false &&
      document.querySelector('textarea') && !document.querySelector('.workspace-picker')`), 'fresh native draft')
  }
  const openPicker = async () => {
    await click('[data-workspace-menu="refs"]')
    await wait(() => evaluate(`Boolean(document.querySelector('.workspace-picker .workspace-choice'))`), 'bounded branch inventory')
    await assertPickerAnchored(evaluate)
  }
  const selectBranch = async name => {
    await type('.workspace-ref-search input', name)
    await wait(() => evaluate(`[...document.querySelectorAll('.workspace-choice strong')].some(node => node.textContent === ${json(name)})`), `branch ${name}`)
    await click('.workspace-choice', name)
  }
  const apply = async () => {
    await wait(() => evaluate(`!document.querySelector('.workspace-picker') &&
      !document.querySelector('[data-workspace-menu="workspace"]').disabled`), 'click immediately saves draft selection')
  }
  const send = (prompt, pause = false, expectedReply) =>
    sendWorkspacePrompt({ inputs, type, click, cdp, evaluate, record }, prompt, pause, expectedReply)
  const record = async (cwd, runId) => wait(() => {
    const dir = join(cwd, '.scry', 'records')
    if (!existsSync(dir)) return null
    for (const name of readdirSync(dir).filter(name => name.endsWith('.json'))) {
      const value = JSON.parse(readFileSync(join(dir, name), 'utf8'))
      if (json(value).includes(runId)) return value
    }
    return null
  }, 'canonical recorder record in the prepared target')

  try {
    await cdp.send('Debugger.enable')
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
    if (!existsSync(join(workspace, '.git'))) git(workspace, 'init', '-b', 'main')
    writeFileSync(join(workspace, '.gitignore'), '.scry/\n')
    writeFileSync(join(workspace, 'scry.config.json'), json({ schemaVersion: 1, workspaceId: 'workspace-ui-fixture' }))
    writeFileSync(join(workspace, 'workspace-baseline.txt'), 'baseline\n')
    git(workspace, 'add', '--all')
    git(workspace, 'commit', '--allow-empty', '-m', 'workspace selection fixture')
    git(workspace, 'branch', '-M', 'main')
    git(workspace, 'branch', 'workspace-feature')
    const head = git(workspace, 'rev-parse', 'HEAD')
    execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'update-ref', '--stdin'], {
      cwd: workspace, input: Array.from({ length: 150 }, (_, i) => `create refs/heads/fixture/ref-${String(i).padStart(3, '0')} ${head}\n`).join('')
    })
    const existing = join(temp, 'existing worktree with spaces')
    git(workspace, 'worktree', 'add', '-b', 'existing-feature', existing, 'main')
    const existingCanonical = realpathSync(existing)
    await newDraft(workspace)

    // Saving/cancelling a choice is read-only, including the real index's mtime.
    const initialIndex = readFileSync(join(workspace, '.git/index'))
    const initialMtime = statSync(join(workspace, '.git/index')).mtimeMs
    await openPicker()
    await assertCompactMenus({ cdp, evaluate, click, key, wait, screenshot, newDraft, cwd: canonicalWorkspace, openPicker })
    await wait(() => evaluate(`document.querySelector('.workspace-choice')?.getAttribute('aria-setsize') === '100'`), '100-ref page')
    assert.ok(await evaluate(`document.querySelectorAll('.workspace-choice').length < 60`), 'branch DOM stays bounded')
    await key('ArrowDown', 'ArrowDown', 40)
    await key('End', 'End', 35)
    await wait(() => evaluate(`document.getElementById(document.querySelector('.workspace-choice-list')?.getAttribute('aria-activedescendant'))?.getAttribute('aria-posinset') === '100'`), 'keyboard reveals last virtual branch without committing')
    await click('.workspace-picker-footer button', '下一页')
    await wait(() => evaluate(`document.querySelector('.workspace-choice')?.getAttribute('aria-posinset') === '1' &&
      document.querySelector('.workspace-choice strong')?.textContent === 'fixture/ref-099'`), 'next page resets virtual scroll')
    await type('.workspace-ref-search input', 'workspace-feature')
    await key('Escape', 'Escape', 27)
    assert.equal(await evaluate(`Boolean(document.querySelector('.workspace-picker'))`), false)
    assert.equal(await evaluate(`document.activeElement === document.querySelector('[data-workspace-menu="refs"]')`), true)
    assert.equal(git(workspace, 'branch', '--show-current'), 'main')
    assert.equal(inputs().length, 0)
    await openPicker()
    await type('.workspace-ref-search input', 'workspace-feature')
    await wait(() => evaluate(`document.querySelector('.workspace-choice strong')?.textContent === 'workspace-feature'`), 'keyboard candidate')
    await key('ArrowDown', 'ArrowDown', 40)
    await key('Enter', 'Enter', 13)
    await apply()
    const stored = () => evaluate(`JSON.parse(localStorage.getItem('scry.composer-drafts.v1') || '[]').find(([, draft]) => draft.workspace?.intent?.kind === 'current')?.[1].workspace.operationId`)
    const savedId = await wait(stored, 'workspace-only draft persisted')
    const previousDocument = await evaluate('performance.timeOrigin')
    await cdp.send('Page.reload')
    await wait(() => evaluate(`performance.timeOrigin !== ${previousDocument} && Boolean(document.querySelector('.workspace-context-strip'))`), 'fresh renderer document')
    await newDraft(canonicalWorkspace)
    await wait(() => evaluate(`document.querySelector('.workspace-context-strip')?.textContent.includes('workspace-feature')`), 'saved workspace intent restored')
    assert.equal(await stored(), savedId)
    assert.equal(git(workspace, 'branch', '--show-current'), 'main')
    assert.deepEqual(readFileSync(join(workspace, '.git/index')), initialIndex)
    assert.equal(statSync(join(workspace, '.git/index')).mtimeMs, initialMtime)
    writeFileSync(join(workspace, 'stale-after-selection.txt'), 'external edit\n')
    await type('textarea', 'desktop remote write one')
    await click('.send')
    await wait(() => evaluate(`document.querySelector('.composer-status[role="alert"]')?.textContent.includes('仓库已变化') &&
      document.querySelector('textarea')?.value === 'desktop remote write one'`), 'stale source rejects start and preserves prompt')
    assert.equal(inputs().length, 0)
    assert.equal(git(workspace, 'branch', '--show-current'), 'main')
    rmSync(join(workspace, 'stale-after-selection.txt'))
    await openPicker()
    await selectBranch('workspace-feature')
    await apply()
    const current = await send('desktop remote write one')
    assert.equal(current.run.cwd, canonicalWorkspace)
    assert.equal(git(workspace, 'branch', '--show-current'), 'workspace-feature')

    await newDraft(canonicalWorkspace)
    const sourceDirt = readFileSync(join(workspace, 'remote-first.txt'))
    const sourceIndex = readFileSync(join(workspace, '.git/index'))
    const sourceMtime = statSync(join(workspace, '.git/index')).mtimeMs
    await openPicker()
    await key('Escape', 'Escape', 27)
    await click('[data-workspace-menu="workspace"]')
    await wait(() => evaluate(`document.querySelectorAll('.workspace-mode-choice')[1]?.disabled === false`), 'new worktree available')
    await screenshot('workspace-menu-dark')
    await click('.workspace-mode-choice', '新建 worktree')
    await apply()
    const generatedBranch = await assertNewWorktreeDefaults(evaluate)
    await openPicker()
    await screenshot('picker-dark')
    await selectBranch('main')
    await apply()
    assert.equal(git(workspace, 'branch', '--list', generatedBranch), '', 'selection must not create a branch')
    assert.equal(await evaluate(`document.querySelector('.send')?.getAttribute('aria-label')`), '创建 worktree 并发送')
    const created = await send('desktop remote write one', true)
    const target = created.run.cwd
    assert.ok(target.startsWith(join(realpathSync(userDataDir), 'worktrees') + '/'), target)
    assert.equal(git(target, 'branch', '--show-current'), generatedBranch)
    assert.deepEqual(readFileSync(join(workspace, 'remote-first.txt')), sourceDirt)
    assert.deepEqual(readFileSync(join(workspace, '.git/index')), sourceIndex)
    assert.equal(statSync(join(workspace, '.git/index')).mtimeMs, sourceMtime)
    const firstRecord = await record(target, created.run.runId)
    git(target, 'add', '--', 'remote-first.txt')
    git(target, 'commit', '-m', 'separate workspace from session baseline')
    const second = await send('desktop remote write two')
    assert.equal(second.input.cwd, target)
    const secondRecord = await record(target, second.run.runId)

    // Uncommitted excludes the first committed file; Changes includes branch commits and working files.
    await click('[data-pinned-summary-toggle]')
    await wait(() => evaluate(`[...document.querySelectorAll('button.pinned-summary-row')].some(node => node.textContent.includes('Changes'))`), 'workspace summary')
    await click('button.pinned-summary-row', 'Changes')
    await wait(() => evaluate(`document.querySelector('.diff-inspector')?.dataset.diffScope === 'workspace' &&
      document.querySelector('.diff-virtual-files')?.textContent.includes('remote-second.txt')`), 'workspace inspector snapshot')
    assert.equal(await evaluate(`document.querySelector('.diff-virtual-files').textContent.includes('remote-first.txt')`), false)
    await selectDiffScope({ click, wait, evaluate }, 'branch')
    await wait(() => evaluate(`document.querySelector('.diff-inspector')?.dataset.diffScope === 'branch' &&
      document.querySelector('.diff-virtual-files')?.textContent.includes('remote-first.txt') &&
      document.querySelector('.diff-virtual-files')?.textContent.includes('remote-second.txt')`), 'branch Changes includes committed and uncommitted files')
    await selectDiffScope({ click, wait, evaluate }, 'latest')
    await wait(() => evaluate(`document.querySelector('.diff-virtual-files')?.textContent.includes('remote-second.txt')`), 'latest turn snapshot')
    assert.equal(await evaluate(`document.querySelector('.diff-virtual-files').textContent.includes('remote-first.txt')`), false)
    git(target, 'add', '--', 'remote-second.txt')
    git(target, 'commit', '-m', 'clean workspace keeps session evidence')
    await selectDiffScope({ click, wait, evaluate }, 'workspace')
    await wait(() => evaluate(`document.querySelector('.diff-review-empty')?.textContent.includes('工作区没有未提交净改动')`), 'captured zero never falls back to session')
    assert.equal(await evaluate(`document.querySelector('.diff-review-totals .add')?.textContent`), '+0')
    await selectDiffScope({ click, wait, evaluate }, 'branch')
    await wait(() => evaluate(`document.querySelector('.diff-virtual-files')?.textContent.includes('remote-first.txt') &&
      document.querySelector('.diff-virtual-files')?.textContent.includes('remote-second.txt')`), 'branch Changes persists after both files are committed')
    await exerciseTurnMenu({ click, key, wait, evaluate, screenshot, target, firstRunId: created.run.runId, latestRunId: second.run.runId })
    await screenshot('inspector-wide')
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 960, height: 900, deviceScaleFactor: 1, mobile: false })
    await wait(() => evaluate(`document.querySelector('.main-area')?.inert === true`), 'narrow inspector replaces and inerts conversation')
    await screenshot('inspector-narrow')
    await click('.diff-scope-trigger')
    await screenshot('diff-scope-narrow')
    await key('Escape', 'Escape', 27)
    await click('.diff-inspector-actions button[aria-label="关闭改动面板"]')
    await wait(() => evaluate(`document.querySelector('.main-area')?.inert === false`), 'closing inspector restores conversation')
    await cdp.send('Emulation.clearDeviceMetricsOverride')

    await newDraft(canonicalWorkspace)
    await click('[data-workspace-menu="workspace"]')
    await wait(() => evaluate(`[...document.querySelectorAll('.workspace-choice small')].some(node => node.textContent === 'existing-feature')`), 'previous worktree option')
    await click('.workspace-choice', 'existing-feature')
    await apply()
    const reused = await send('desktop remote write three')
    assert.equal(reused.run.cwd, existingCanonical)
    assert.equal(git(workspace, 'worktree', 'list', '--porcelain').split('\n').filter(line => line.startsWith('worktree ')).length, 3)
    const reusedRecord = await record(existingCanonical, reused.run.runId)
    await newDraft(realpathSync(secondWorkspace))
    if (!await evaluate(`Boolean(document.querySelector('button.pinned-summary-row'))`)) await click('[data-pinned-summary-toggle]')
    await click('button.pinned-summary-row', 'Changes')
    await wait(() => evaluate(`document.querySelector('.diff-inspector')?.dataset.diffScope === 'workspace' &&
      document.querySelector('.diff-review-empty')?.textContent.includes('不是 Git')`), 'non-Git evidence is unavailable')
    assert.equal(await evaluate(`Boolean(document.querySelector('.diff-review-totals'))`), false, 'missing evidence is never zero')
    assert.equal(inputs().length, 4, 'read-only scope changes never start a Provider')
    await screenshot('inspector-unavailable')
    await newDraft(canonicalWorkspace)
    await click('[data-workspace-menu="workspace"]')
    await wait(() => evaluate(`document.querySelectorAll('.workspace-mode-choice')[1]?.disabled === false`), 'failure fixture worktree available')
    await click('.workspace-mode-choice', '新建 worktree')
    await apply()
    const failedBranch = await assertNewWorktreeDefaults(evaluate)
    await openPicker()
    await selectBranch('main')
    await apply()
    const failed = await send('remote provider failure smoke', false, 'fixture_provider_failure')
    const failedRecord = await record(failed.run.cwd, failed.run.runId)
    assert.equal(failedRecord.status, 'failed')
    assert.equal(git(failed.run.cwd, 'branch', '--show-current'), failedBranch)
    assert.ok(existsSync(failed.run.cwd), 'Provider failure must not delete the prepared worktree')
    await exerciseWorkspaceDiffBounds({ target, newDraft, click, evaluate, key, wait, screenshot, cdp })
    assert.equal(inputs().length, 5, 'three workspace paths, one follow-up and one explicit failure; pressure and reload never launch a Provider')
    writeFileSync(join(evidence, 'result.json'), json({ current, created, second, reused, failed, firstRecord, secondRecord, reusedRecord, failedRecord }))
    console.log(json({ test: 'production workspace first-send and scoped diff UI', current: current.run.cwd,
      created: target, reused: existingCanonical, providerInvocations: inputs().length, records: 4, providerFailureRetainedWorktree: true,
      sourceIndexUnchanged: true, readonlySelection: true, scopes: ['branch', 'workspace', 'latest', 'turn'], narrowInert: true, evidence }))
  } catch (error) {
    writeFileSync(join(evidence, 'failure.json'), json({ error: String(error), inputs: inputs(),
      focused: await evaluate('window.scry.focusedRunSnapshot()').catch(() => null),
      terminal: await evaluate('window.__workspaceTerminalProbe').catch(() => null),
      body: await evaluate('document.body.innerText.slice(0, 24000)').catch(() => null) }))
    await screenshot('failure').catch(() => {})
    console.error('workspace UI evidence:', evidence)
    throw error
  }
}
