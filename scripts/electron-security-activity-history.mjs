import assert from 'node:assert/strict'
import { readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Real renderer/preload/main with a Pi JSONL and two temporary directories.
// projectCwd is presentation grouping; it must never replace the session's cwd.
export async function exerciseActivityHistory({ evaluate, cdp, userDataDir, home, canonicalWorkspace, nativeSessionId }) {
  const catalogPath = join(userDataDir, 'app-sessions.json')
  const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'))
  const session = catalog.find(entry => entry.externalSessionId === nativeSessionId)
  assert.equal(session.cwd, canonicalWorkspace)
  session.projectCwd = realpathSync(home)
  session.lastRunOutcome = 'completed'
  writeFileSync(catalogPath, JSON.stringify(catalog))
  await cdp.send('Page.reload')

  const wait = expression => evaluate(`(async () => {
    const deadline = performance.now() + 10000;
    while (!(${expression})) {
      if (performance.now() > deadline) throw new Error('Activity history UI timed out: ' + ${JSON.stringify(expression)});
      await new Promise(requestAnimationFrame);
    }
  })()`)
  const click = async selector => {
    await wait(`document.querySelector(${JSON.stringify(selector)}) != null`)
    const point = await evaluate(`(() => {
      const button = document.querySelector(${JSON.stringify(selector)});
      button.scrollIntoView({ block: 'center' });
      const rect = button.getBoundingClientRect();
      const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
      if (!button.contains(document.elementFromPoint(x, y))) throw new Error('Activity history target obscured');
      return { x, y };
    })()`)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
  }
  await wait(`document.querySelector('.sb-sess[data-provider="pi"]') != null`)
  await click('.sb-new')
  await wait(`!document.body.textContent.includes('主机重启前已有的原生回复')`)
  await click('[role="tab"][id$="-view-activity"]')
  const row = '.sb-activity .sb-sess[data-provider="pi"]'
  await click(row)
  await wait(`document.body.textContent.includes('主机重启前已有的原生回复')`)
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(row)}).getAttribute('aria-current')`), 'true')
  assert.equal(await evaluate(`document.body.textContent.includes('会话历史加载失败')`), false)
  assert.deepEqual(await evaluate('window.scry.activeRuns()'), [])

  const rejection = await evaluate(`(async () => {
    try {
      await window.scry.loadSession(${JSON.stringify({ providerId: 'pi', agentProfileId: 'pi:rotom', cwd: session.projectCwd, externalSessionId: nativeSessionId })});
      return null;
    } catch (error) { return error.message; }
  })()`)
  assert.match(rejection, /会话工作目录与 catalog 不一致/)
  console.log(JSON.stringify({ activityGroupedNativeHistory: true, catalogCwdGuardPreserved: true, noProviderRuns: true }))
}
