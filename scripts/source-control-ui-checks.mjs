import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Real production App/main/preload/renderer, isolated HOME/userData and local Git only.
// No Provider start, gh credential lookup, or GitHub request is made by this scenario.
export async function exerciseSourceControlApp(cdp, evaluate, { workspace, remote, home }) {
  const git = (...args) =>
    execFileSync('/usr/bin/git', args, {
      cwd: workspace,
      encoding: 'utf8',
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
  git('add', 'pre-staged.txt')
  writeFileSync(join(workspace, 'pre-staged.txt'), 'keep existing staged content\nnot staged yet\n')
  writeFileSync(join(workspace, 'selected.txt'), 'selected by actual UI\n')
  writeFileSync(join(workspace, 'untouched.txt'), 'must remain untracked\n')
  git('init', '--bare', remote)
  git('remote', 'add', 'origin', remote)

  const visible = (selector) =>
    `Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(element => element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0)`
  const button = (text, scope = '.sc-panel') =>
    `Array.from(document.querySelectorAll(${JSON.stringify(`${scope} button`)})).find(element => element.textContent.trim() === ${JSON.stringify(text)} && element.getBoundingClientRect().width > 0)`
  const wait = async (expression) =>
    evaluate(`(async () => {
    const deadline = Date.now() + 15000;
    while (!(${expression})) {
      if (Date.now() > deadline) throw new Error('Source control UI state timed out: ' + ${JSON.stringify(expression)} + '\\n' + document.querySelector('.sc-panel')?.innerText);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  })()`)
  const click = async (expression) => {
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
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      button: 'left',
      clickCount: 1,
      ...point
    })
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      button: 'left',
      clickCount: 1,
      ...point
    })
  }
  const input = async (expression, text) => {
    await click(expression)
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'a',
      code: 'KeyA',
      modifiers: 4,
      commands: ['selectAll']
    })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 4 })
    await cdp.send('Input.insertText', { text })
  }
  const open = async () => {
    const hidden = await evaluate(
      `(${visible('button[title="右侧工作区"]')})?.getAttribute('aria-pressed') === 'false'`
    )
    if (hidden) await click(visible('button[title="右侧工作区"]'))
    await wait(visible('[aria-label="添加 Surface"]'))
    await click(visible('[aria-label="添加 Surface"]'))
    await click(
      `Array.from(document.querySelectorAll('.surface-menu [role="menuitem"]')).find(element => element.textContent.includes('源代码管理'))`
    )
    await wait(`document.querySelector('.sc-identity')?.textContent.includes('feature')`)
  }
  await wait(`typeof window.scry?.sourceControl?.read === 'function'`)
  // The App starts unbound: selecting the seeded session establishes surface.cwd.
  await wait(visible('button.sb-sess'))
  await click(visible('button.sb-sess'))
  await open()
  assert.equal(await evaluate(`document.querySelector('.sc-identity small').title`), workspace)
  await click(visible('[aria-label="暂存 pre-staged.txt"]'))
  await wait(`document.querySelector('[role="dialog"]')?.textContent.includes('已有部分暂存')`)
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' })
  await wait(`!document.querySelector('[role="dialog"]')`)
  assert.equal(git('show', ':pre-staged.txt'), 'keep existing staged content')
  await click(visible('[aria-label="暂存 selected.txt"]'))
  await wait(
    `document.querySelector('.sc-panel')?.getAttribute('aria-busy') === 'false' && ${visible('[aria-label="取消暂存 selected.txt"]')}`
  )
  assert.equal(git('diff', '--cached', '--name-only'), 'pre-staged.txt\nselected.txt')
  assert.match(git('status', '--porcelain'), /\?\? untouched.txt/)

  // Reversible local action, then an actual commit, using native input and focus checks.
  await click(visible('[aria-label="取消暂存 selected.txt"]'))
  await wait(
    `document.querySelector('.sc-panel')?.getAttribute('aria-busy') === 'false' && ${visible('[aria-label="暂存 selected.txt"]')}`
  )
  assert.equal(git('diff', '--cached', '--name-only'), 'pre-staged.txt')
  assert.equal(readFileSync(join(workspace, 'selected.txt'), 'utf8'), 'selected by actual UI\n')
  await click(visible('[aria-label="暂存 selected.txt"]'))
  await wait(
    `document.querySelector('.sc-panel')?.getAttribute('aria-busy') === 'false' && ${visible('[aria-label="取消暂存 selected.txt"]')}`
  )
  await input(visible('.sc-panel textarea'), 'UI verified commit')
  await click(button('提交 2 个已暂存文件'))
  await wait(`document.querySelector('[role="dialog"]')?.textContent.includes('pre-staged.txt')`)
  assert.equal(
    await evaluate(`document.querySelector('[role="dialog"]').contains(document.activeElement)`),
    true
  )
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' })
  await wait(`!document.querySelector('[role="dialog"]')`)
  assert.equal(await evaluate(`document.activeElement?.textContent.trim()`), '提交 2 个已暂存文件')
  assert.equal(git('rev-list', '--count', 'HEAD'), '1')
  await click(button('提交 2 个已暂存文件'))
  await click(button('确认执行', '.modal'))
  await wait(
    `document.querySelector('.sc-panel')?.getAttribute('aria-busy') === 'false' && (${button('提交 0 个已暂存文件')})?.disabled === true`
  )
  assert.equal(git('rev-list', '--count', 'HEAD'), '2')
  assert.equal(git('show', 'HEAD:pre-staged.txt'), 'keep existing staged content')
  assert.equal(git('show', 'HEAD:selected.txt'), 'selected by actual UI')
  assert.match(git('status', '--porcelain'), /\?\? untouched.txt/)

  await click(button('Push'))
  await wait(`document.querySelector('[role="dialog"]')?.textContent.includes(${JSON.stringify(remote)})`)
  await click(button('确认执行', '.modal'))
  await wait(`document.querySelector('.sc-panel')?.getAttribute('aria-busy') === 'false'`)
  assert.match(git('ls-remote', remote, 'refs/heads/feature'), new RegExp(`^${git('rev-parse', 'HEAD')}`))

  await input(visible('.sc-panel textarea'), 'draft survives closing the surface')
  await wait(
    `(await window.scry.sourceControl.loadCommitDraft({ repositoryId: (await window.scry.sourceControl.read(${JSON.stringify(workspace)})).data.id }))?.message === 'draft survives closing the surface'`
  )
  await click(visible('[aria-label="关闭 源代码管理"]'))
  await open()
  await wait(`document.querySelector('.sc-panel textarea')?.value === 'draft survives closing the surface'`)

  const artifacts = mkdtempSync(join(tmpdir(), 'scry-source-control-ui-'))
  const captures = []
  for (const theme of ['dark', 'light']) {
    await evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`)
    const capture = await cdp.send('Page.captureScreenshot', { format: 'png' })
    const path = join(artifacts, `${theme}.png`)
    writeFileSync(path, Buffer.from(capture.data, 'base64'))
    captures.push(path)
  }
  await click(button('操作记录'))
  await wait(`document.querySelectorAll('.sc-operation').length >= 5`)
  assert.equal(
    await evaluate(
      `Array.from(document.querySelectorAll('.sc-operation')).some(element => element.textContent.includes('结果未知') || element.textContent.includes('失败'))`
    ),
    false
  )
  return {
    sourceControl: 'production App / real temporary Git',
    stageAndUnstage: true,
    partialStageConfirmation: true,
    fullIndexCommit: true,
    nativeFocusAndEscape: true,
    pushToLocalRemote: true,
    draftRestoredAfterSurfaceClose: true,
    externalGithubWrites: 0,
    captures
  }
}
