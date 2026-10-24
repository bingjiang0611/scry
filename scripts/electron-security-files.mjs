import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export async function exerciseFiles(smokeContext) {
  const { evaluate, cdp, workspace, canonicalHome, home, temp, openReceipt, devFilesOnly } = smokeContext
    const cwd = join(canonicalHome, 'projects', 'dev-agent')
    const docs = join(canonicalHome, 'projects', 'rotom-team', 'docs')
    mkdirSync(docs, { recursive: true })
    writeFileSync(join(docs, 'NATIVE-DELIVERY.md'), '# Actual sibling delivery\n')
    const sourcePath = 'packages/coding-agent/src/modes/interactive/interactive-mode.ts'
    mkdirSync(dirname(join(cwd, sourcePath)), { recursive: true })
    writeFileSync(join(cwd, sourcePath), 'export const source = true\n')
    const reportPath = 'generated/2026-10-18 AI 学习资源推荐清单回检.md'
    mkdirSync(dirname(join(cwd, reportPath)), { recursive: true })
    writeFileSync(join(cwd, reportPath), '# Actual encoded report\n')
    writeFileSync(join(canonicalHome, 'projects', 'LICENSE'), 'Actual license without an extension')
    writeFileSync(join(canonicalHome, 'projects', 'asset.custom'), Buffer.from([0, 1, 2, 3]))
    writeFileSync(join(canonicalHome, 'projects', 'report.docx'), Buffer.from([0x50, 0x4b, 0, 1]))
    writeFileSync(join(cwd, 'run.command'), '#!/bin/sh\necho never-run')
    const screens = join(temp, 'screens')
    mkdirSync(screens)
    symlinkSync(screens, join(cwd, 'screens'))
    for (const name of ['remote-workspace.png', 'remote-hosts.png', 'remote-settings.png', 'asset.custom', 'fail.custom']) {
      writeFileSync(join(screens, name), Buffer.from([0, 1, 2, 3]))
    }
    writeFileSync(join(temp, 'outside.md'), '# Actual outside-home delivery\n')
    symlinkSync(join(temp, 'outside.md'), join(cwd, 'escaped.md'))
    const resolved = await evaluate(`(async () => {
      const cwd = ${JSON.stringify(cwd)};
      await window.scry.setCwd(cwd);
      const text = await window.scry.workspaceResolveFile({ cwd, path: 'rotom-team/docs/NATIVE-DELIVERY.md' });
      const snapshot = await window.scry.workspaceReadKnown(text);
      const binary = await window.scry.workspaceResolveFile({ cwd, path: '../asset.custom' });
      const office = await window.scry.workspaceResolveFile({ cwd, path: '../report.docx' });
      const outside = [];
      for (const path of ['escaped.md', ${JSON.stringify(join(temp, 'outside.md'))}]) {
        const target = await window.scry.workspaceResolveFile({ cwd, path });
        const file = await window.scry.workspaceReadKnown(target);
        const page = await window.scry.workspaceReadPageKnown({ ...target, limit: 10 });
        outside.push({ mode: target.mode, content: file.content, page: page.content });
      }
      const target = await window.scry.workspaceResolveFile({ cwd, path: 'escaped.md' });
      const denied = [];
      for (const operation of [
        () => window.scry.workspaceResolveFile({ cwd: ${JSON.stringify(temp)}, path: 'outside.md' }),
        () => window.scry.workspaceReadKnown({ ...target, path: 'other.md' }),
        () => window.scry.workspaceReadKnown({ cwd: 'scry-file:forged', path: 'outside.md' }),
        () => window.scry.workspaceWrite({ ...target, content: 'must not write', expectedRevision: 'x' })
      ]) {
        try { await operation(); denied.push(false); }
        catch { denied.push(true); }
      }
      const script = await window.scry.workspaceResolveFile({ cwd, path: 'run.command' });
      ${devFilesOnly ? "await window.scry.workspaceOpenExternal({ cwd, path: 'run.command' });" : ''}
      return { text, content: snapshot.content, binary: binary.mode, office: office.mode, outside, denied, script: script.mode };
    })()`)
    assert.deepEqual(resolved.text, { cwd: '~', path: 'projects/rotom-team/docs/NATIVE-DELIVERY.md', mode: 'text' })
    assert.equal(resolved.content, '# Actual sibling delivery\n')
    assert.equal(resolved.binary, 'external')
    assert.equal(resolved.office, 'external')
    assert.deepEqual(resolved.outside, [0, 1].map(() => ({
      mode: 'text', content: '# Actual outside-home delivery\n', page: '# Actual outs'
    })))
    assert.deepEqual(resolved.denied, [true, true, true, true])
    assert.equal(resolved.script, 'text')
    if (devFilesOnly) assert.deepEqual(JSON.parse(readFileSync(openReceipt, 'utf8')), [join(cwd, 'run.command')])
    await evaluate(`(async () => {
      let offDone, offError;
      const terminal = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('file-link fixture timed out')), 10000);
        const cleanup = () => { clearTimeout(timer); offDone(); offError(); };
        offDone = window.scry.onTurnDone(() => { cleanup(); resolve(); });
        offError = window.scry.onError(event => { cleanup(); reject(new Error(event.message)); });
      });
      await window.scry.start({ providerId: 'codex', cwd: ${JSON.stringify(cwd)}, prompt: 'file links smoke' });
      await terminal;
    })()`)
    const wait = expression => evaluate(`(async () => {
      const deadline = performance.now() + 8000;
      while (!(${expression})) {
        if (performance.now() > deadline) throw new Error('File-link condition timed out: ' + ${JSON.stringify(expression)});
        // Hidden windows can suspend animation frames; keep the failure deadline live.
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    })()`)
    const clickFile = async title => {
      await wait(`Array.from(document.querySelectorAll('.md-file-ref')).some(button => button.title === ${JSON.stringify(title)})`)
      await evaluate(`Array.from(document.querySelectorAll('.md-file-ref')).find(button => button.title === ${JSON.stringify(title)}).scrollIntoView({ block: 'center' })`)
      // DOM presence can precede the frame used by native input hit testing.
      // Paint the scrolled result, then measure and hit-test that rendered frame.
      await cdp.send('Page.captureScreenshot', { format: 'png' })
      const point = await evaluate(`(() => {
        const button = Array.from(document.querySelectorAll('.md-file-ref')).find(button => button.title === ${JSON.stringify(title)});
        const box = button.getBoundingClientRect();
        const x = box.left + box.width / 2, y = box.top + box.height / 2;
        if (!button.contains(document.elementFromPoint(x, y))) throw new Error('File link obscured');
        return { x, y };
      })()`)
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
    }
    await clickFile(`${reportPath} · 打开文件`)
    await wait(`document.querySelector('.workspace-preview h1')?.textContent === 'Actual encoded report'`)
    await clickFile('rotom-team/docs/NATIVE-DELIVERY.md · 在右侧文件面板打开')
    // Markdown opens as a read-only preview first (7d4b6bd); expanding the
    // source must show the actual file bytes in a read-only textarea.
    await wait(`document.querySelector('.workspace-preview h1')?.textContent === 'Actual sibling delivery' && document.querySelector('.workspace-editorbar')?.textContent.includes('只读预览')`)
    await evaluate(`Array.from(document.querySelectorAll('.workspace-editorbar button')).find(button => button.textContent === '展开源码').click()`)
    await wait(`document.querySelector('textarea[aria-label="查看 NATIVE-DELIVERY.md"]')?.value === '# Actual sibling delivery\\n'`)
    assert.equal(await evaluate(`document.querySelector('textarea[aria-label="查看 NATIVE-DELIVERY.md"]').readOnly`), true)
    await clickFile('../LICENSE · 打开文件')
    await wait(`document.querySelector('textarea[aria-label="查看 LICENSE"]')?.value === 'Actual license without an extension'`)
    for (const action of ['打开文件', '在右侧文件面板打开']) {
      await clickFile(`${sourcePath} · ${action}`)
      await wait(`document.querySelector('textarea[aria-label="编辑 interactive-mode.ts"]')?.value === 'export const source = true\\n'`)
      assert.equal(await evaluate(`!!document.querySelector('.composer-status.is-error')`), false)
      await clickFile('../LICENSE · 打开文件')
      await wait(`document.querySelector('textarea[aria-label="查看 LICENSE"]')?.value === 'Actual license without an extension'`)
    }
    await clickFile('escaped.md · 打开文件')
    await wait(`document.querySelector('.workspace-preview h1')?.textContent === 'Actual outside-home delivery' && document.querySelector('.workspace-editorbar')?.textContent.includes('只读预览')`)
    assert.equal(readFileSync(join(temp, 'outside.md'), 'utf8'), '# Actual outside-home delivery\n')
    await clickFile('missing.md · 在右侧文件面板打开')
    await wait(`document.body.textContent.includes('文件不存在：missing.md')`)
    if (devFilesOnly) {
      const waitForOpen = async path => {
        const deadline = Date.now() + 8000
        while (JSON.parse(readFileSync(openReceipt, 'utf8')).at(-1) !== path) {
          if (Date.now() > deadline) throw new Error(`No system handoff for ${path}`)
          await new Promise(resolve => setTimeout(resolve, 50))
        }
      }
      await clickFile('screens · 在外部应用打开')
      await waitForOpen(realpathSync(screens))
      for (const name of ['remote-workspace.png', 'remote-hosts.png', 'remote-settings.png', 'asset.custom']) {
        await clickFile(`screens/${name} · ${name.endsWith('.png') ? '在外部应用打开' : '在右侧文件面板打开'}`)
        await waitForOpen(join(realpathSync(screens), name))
        await wait(`!document.querySelector('.composer-status.is-error')`)
      }
      assert.deepEqual(JSON.parse(readFileSync(openReceipt, 'utf8')), [
        join(cwd, 'run.command'), realpathSync(screens),
        ...['remote-workspace.png', 'remote-hosts.png', 'remote-settings.png', 'asset.custom'].map(name => join(realpathSync(screens), name))
      ])
      await clickFile('screens/fail.custom · 在右侧文件面板打开')
      await wait(`document.body.textContent.includes('fixture: no application associated')`)
      assert.equal(JSON.parse(readFileSync(openReceipt, 'utf8')).filter(path => path.endsWith('/fail.custom')).length, 1)
    }
    console.log(JSON.stringify({ fileLinks: { siblingProject: true, actualContent: true, readOnlyOutsideWorkspace: true,
      encodedMarkdownLink: true, sourceLocationLinks: true, extensionlessLink: true, officeAndUnknownBinary: true, outsideHomeSymlink: true, fileScopedReads: true,
      missingFileReported: true, outsideWorkspaceWriteDenied: true,
      contextualScreenshotsAndDirectory: devFilesOnly, executableHandoff: devFilesOnly, systemErrorReportedWithoutRetry: devFilesOnly } }))
    cdp.close()
    return
}
