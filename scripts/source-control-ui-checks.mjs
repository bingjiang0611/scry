import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Production App/main/preload/renderer, isolated HOME/userData and real local Git.
// No Provider start, gh credential lookup, or GitHub request is made here.
export async function exerciseSourceControlApp(cdp, evaluate, { workspace, remote, home }) {
  const git = (...args) => execFileSync('/usr/bin/git', args, {
    cwd: workspace, encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
  }).trim()
  git('init', '-b', 'feature')
  git('config', 'user.name', 'Scry UI Fixture')
  git('config', 'user.email', 'fixture@example.invalid')
  git('config', 'commit.gpgsign', 'false')
  writeFileSync(join(workspace, 'pre-staged.txt'), 'baseline\n')
  git('add', 'pre-staged.txt')
  git('commit', '-m', 'initial')
  writeFileSync(join(workspace, 'pre-staged.txt'), 'keep existing staged content\n')
  writeFileSync(join(workspace, 'selected.txt'), 'selected by actual UI\n')
  writeFileSync(join(workspace, 'untouched.txt'), 'must remain untracked\n')
  git('init', '--bare', remote)
  git('remote', 'add', 'origin', remote)
  const hook = join(workspace, '.git/hooks/pre-push')
  const hookMarker = join(home, 'untrusted-hook-ran')
  writeFileSync(hook, `#!/bin/sh\ntouch '${hookMarker}'\n`)
  chmodSync(hook, 0o755)

  const visible = selector => `Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(element => element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0)`
  const button = (text, scope = '.sc-panel') => `Array.from(document.querySelectorAll(${JSON.stringify(`${scope} button`)})).find(element => element.textContent.trim() === ${JSON.stringify(text)} && element.getBoundingClientRect().width > 0)`
  const wait = async expression => evaluate(`(async () => {
    const deadline = Date.now() + 15000;
    while (!(${expression})) {
      if (Date.now() > deadline) throw new Error('Source control UI state timed out: ' + ${JSON.stringify(expression)} + '\\n' + document.querySelector('.sc-panel')?.innerText);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  })()`)
  const click = async expression => {
    const point = await evaluate(`(() => {
      const element = ${expression};
      if (!element || element.disabled) throw new Error('Missing/disabled click target: ' + ${JSON.stringify(expression)});
      element.scrollIntoView({ block: 'center', inline: 'nearest' });
      const rect = element.getBoundingClientRect();
      const point = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      const hit = document.elementFromPoint(point.x, point.y);
      if (!hit || !(element === hit || element.contains(hit))) throw new Error('Source control target is occluded');
      return point;
    })()`)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
  }
  const escape = async () => {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' })
    await wait(`!document.querySelector('[role="dialog"]')`)
  }
  const input = async (expression, text) => {
    await click(expression)
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 4, commands: ['selectAll'] })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 4 })
    await cdp.send('Input.insertText', { text })
  }
  const artifacts = mkdtempSync(join(tmpdir(), 'scry-source-control-ui-'))
  const captures = []
  const capture = async name => {
    const result = await cdp.send('Page.captureScreenshot', { format: 'png' })
    const path = join(artifacts, `${name}.png`)
    writeFileSync(path, Buffer.from(result.data, 'base64'))
    captures.push(path)
  }
  const settled = `document.querySelector('.sc-panel')?.getAttribute('aria-busy') === 'false'`
  const open = async () => {
    const hidden = await evaluate(`(${visible('button[title="右侧工作区"]')})?.getAttribute('aria-pressed') === 'false'`)
    if (hidden) await click(visible('button[title="右侧工作区"]'))
    await wait(visible('[aria-label="添加 Surface"]'))
    await click(visible('[aria-label="添加 Surface"]'))
    await click(`Array.from(document.querySelectorAll('.surface-menu [role="menuitem"]')).find(element => element.textContent.includes('源代码管理'))`)
    await wait(`document.querySelector('.sc-branch')?.textContent.includes('feature')`)
  }
  await wait(`typeof window.scry?.sourceControl?.read === 'function'`)
  await wait(visible('button.sb-sess'))
  await click(visible('button.sb-sess'))
  await open()

  // Reproduce the original dead end: no index entries and an unrelated pre-push hook.
  assert.equal(git('diff', '--cached', '--name-only'), '')
  await click(button('提交改动…'))
  await wait(`document.querySelector('[role="dialog"]')?.textContent.includes('确认本次提交')`)
  assert.equal(await evaluate(`document.querySelector('.sc-commit-dialog').contains(document.activeElement)`), true)
  assert.equal(await evaluate(`(${button('确认提交 0 个文件', '.modal')})?.disabled`), true)
  await escape()
  assert.equal(await evaluate('document.activeElement?.textContent.trim()'), '提交改动…')

  // Seed an existing partial index after the zero-index path, then read it through production main.
  git('add', 'pre-staged.txt')
  writeFileSync(join(workspace, 'pre-staged.txt'), 'keep existing staged content\nnot staged yet\n')
  writeFileSync(join(workspace, 'reversible.txt'), 'keep working file\n')
  git('add', 'reversible.txt')
  await click(button('刷新'))
  await wait(visible('[aria-label="取消暂存 reversible.txt"]'))
  assert.equal(await evaluate(`document.querySelector('[aria-label="纳入本次提交 pre-staged.txt"]').disabled`), true)

  await click(visible('button.sc-file-name[title="pre-staged.txt"]'))
  await wait(visible('.sc-diff-switch'))
  await wait(visible('.sc-diff-scroll .sc-code-line'))
  for (const label of ['提交改动…', '详情', '刷新']) {
    assert.equal(await evaluate(`(() => {
      const element = ${button(label)};
      const rect = element.getBoundingClientRect();
      return rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight
        && element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
    })()`), true, `${label} must stay fully visible and unobstructed in the narrow diff view`)
  }
  await capture('partial-index-narrow')
  await click(visible('[aria-label="最大化右侧工作区"]'))
  await wait(`document.querySelector('.sc-workspace').getBoundingClientRect().width >= 680`)
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.sc-file-pane')).display !== 'none' && getComputedStyle(document.querySelector('.sc-diff-pane')).display !== 'none'`), true)
  await capture('partial-index-wide')
  await click(visible('[aria-label="恢复右侧工作区"]'))
  await wait(visible('.sc-back-files'))
  await click(button('暂存整个文件…'))
  await wait(`document.querySelector('[role="dialog"]')?.textContent.includes('已有部分暂存')`)
  await escape()
  assert.equal(git('show', ':pre-staged.txt'), 'keep existing staged content')
  const narrow = await evaluate(`getComputedStyle(document.querySelector('.sc-back-files')).display !== 'none'`)
  if (narrow) {
    await click(button('← 文件'))
    await wait(`document.activeElement?.getAttribute('title') === 'pre-staged.txt'`)
  }

  // Explicit unstage is still available and preserves the file.
  await click(visible('[aria-label="取消暂存 reversible.txt"]'))
  await click(button('确认执行', '.modal'))
  await wait(`${settled} && !document.querySelector('[aria-label="取消暂存 reversible.txt"]')`)
  assert.equal(readFileSync(join(workspace, 'reversible.txt'), 'utf8'), 'keep working file\n')
  assert.equal(git('diff', '--cached', '--name-only'), 'pre-staged.txt')

  await click(visible('[aria-label="纳入本次提交 selected.txt"]'))
  assert.equal(git('diff', '--cached', '--name-only'), 'pre-staged.txt', 'candidate selection must not run git add')
  await click(visible('[aria-label="纳入本次提交 selected.txt"]'))
  assert.equal(git('diff', '--cached', '--name-only'), 'pre-staged.txt')
  await click(visible('[aria-label="纳入本次提交 selected.txt"]'))
  await click(button('提交改动…'))
  await input(visible('.sc-commit-dialog textarea'), 'UI verified commit')
  await capture('commit-range-confirmation')
  await escape()
  assert.equal(git('rev-list', '--count', 'HEAD'), '1')
  await click(button('提交改动…'))
  await wait(`document.querySelector('.sc-commit-dialog textarea')?.value === 'UI verified commit'`)
  await click(button('确认提交 2 个文件', '.modal'))
  await wait(`${settled} && ${button('推送分支…')}`)
  assert.equal(git('rev-list', '--count', 'HEAD'), '2')
  assert.equal(git('show', 'HEAD:pre-staged.txt'), 'keep existing staged content')
  assert.equal(git('show', 'HEAD:selected.txt'), 'selected by actual UI')
  assert.match(git('diff', '--', 'pre-staged.txt'), /\+not staged yet/)
  assert.match(git('status', '--porcelain'), /\?\? untouched.txt/)
  assert.match(git('status', '--porcelain'), /\?\? reversible.txt/)
  assert.equal(existsSync(hookMarker), false)

  await click(button('推送分支…'))
  await wait(`document.querySelector('[role="dialog"]')?.textContent.includes('pre-push')`)
  assert.equal(await evaluate(`(${button('确认推送到 feature', '.modal')})?.disabled`), true)
  await escape()
  // Removing the fixture hook is not product authorization or a bypass feature.
  unlinkSync(hook)
  await click(button('刷新'))
  await wait(`${settled} && !document.querySelector('.sc-inline-notice')`)
  await click(button('推送分支…'))
  await wait(`document.querySelector('[role="dialog"]')?.textContent.includes(${JSON.stringify(remote)})`)
  await click(button('确认推送到 feature', '.modal'))
  await wait(`${settled} && ${button('查看 / 创建 Pull Request')}`)
  assert.match(git('ls-remote', remote, 'refs/heads/feature'), new RegExp(`^${git('rev-parse', 'HEAD')}`))
  assert.equal(existsSync(hookMarker), false)

  await click(button('其他操作'))
  await click(button('提交改动…', '.modal'))
  await input(visible('.sc-commit-dialog textarea'), 'draft survives closing the surface')
  await wait(`(await window.scry.sourceControl.loadCommitDraft({ repositoryId: (await window.scry.sourceControl.read(${JSON.stringify(workspace)})).data.id }))?.message === 'draft survives closing the surface'`)
  await escape()
  await click(visible('[aria-label="关闭 源代码管理"]'))
  await open()
  await click(button('提交改动…'))
  await wait(`document.querySelector('.sc-commit-dialog textarea')?.value === 'draft survives closing the surface'`)
  await escape()

  for (const theme of ['dark', 'light']) {
    // Match applyTheme: the root also has an inline native-control color scheme.
    await evaluate(`document.documentElement.dataset.theme = document.documentElement.style.colorScheme = ${JSON.stringify(theme)}`)
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('.sc-file-row > input')).colorScheme`), theme)
    await capture(theme)
  }
  await click(button('操作记录'))
  await wait(`document.querySelectorAll('.sc-operation').length === 3`)
  assert.equal(await evaluate(`Array.from(document.querySelectorAll('.sc-operation')).some(element => element.textContent.includes('结果未知') || element.textContent.includes('失败'))`), false)
  return {
    sourceControl: 'production App / real temporary Git',
    zeroIndexEntry: true, prospectiveSelection: true, explicitUnstage: true,
    partialIndexPreserved: true, fullIndexAndSelectedCommit: true, nativeFocusAndEscape: true,
    prePushOnlyBlocksPush: true, hookExecuted: false, pushToLocalRemote: true,
    draftRestoredAfterSurfaceClose: true, externalGithubWrites: 0, captures
  }
}
