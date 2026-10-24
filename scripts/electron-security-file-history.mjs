import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

export async function exerciseFileHistory(smokeContext) {
  const { sourceFileHistory, evaluate, cdp, workspace } = smokeContext
    const source = sourceFileHistory
    const candidates = [...new Set(source.turns[0].items.flatMap(event => event.filePath?.endsWith('/brief.md') ? [event.filePath] : []))]
    assert.equal(candidates.length, 1, 'archive must identify the requested file uniquely')
    const expected = readFileSync(candidates[0], 'utf8')
    const wait = expression => evaluate(`(async () => {
      const deadline = performance.now() + 10000;
      while (!(${expression})) {
        if (performance.now() > deadline) throw new Error('File history UI timed out: ' + ${JSON.stringify(expression)});
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    })()`)
    const click = async expression => {
      const point = await evaluate(`(() => {
        const button = ${expression};
        if (!button) throw new Error('Replay target not found');
        button.scrollIntoView({ block: 'center' });
        const rect = button.getBoundingClientRect();
        const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
        if (!button.contains(document.elementFromPoint(x, y))) throw new Error('Replay target obscured');
        return { x, y };
      })()`)
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
    }
    await wait(`Array.from(document.querySelectorAll('.sb-sess')).some(button => button.textContent.includes('Archived file-link replay'))`)
    await click(`Array.from(document.querySelectorAll('.sb-sess')).find(button => button.textContent.includes('Archived file-link replay'))`)
    await wait(`Array.from(document.querySelectorAll('.md-file-ref')).some(button => button.textContent === 'brief.md')`)
    const brief = `Array.from(document.querySelectorAll('.md-file-ref')).find(button => button.textContent === 'brief.md')`
    const title = await evaluate(`(${brief}).title`)
    assert.ok(title.includes('designs/scry-unified-remote/brief.md'), `wrong archived target: ${title}`)
    await click(brief)
    await wait(`document.querySelector('.workspace-title b')?.textContent.includes('brief.md')`)
    await click(`Array.from(document.querySelectorAll('.workspace-editorbar button')).find(button => button.textContent === '展开源码')`)
    await wait(`document.querySelector('.workspace-editor textarea')?.value === ${JSON.stringify(expected)}`)
    assert.ok(!await evaluate(`document.body.textContent.includes('文件不存在：brief.md')`))
    assert.deepEqual(await evaluate('window.scry.activeRuns()'), [])
    console.log(JSON.stringify({ archivedFileLink: { runId: source.turns[0].runId, path: candidates[0], exactBytes: true, nativeClick: true, noProviderRuns: true, isolatedUserData: true } }))
    cdp.close()
    return
}
