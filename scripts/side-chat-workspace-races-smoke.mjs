import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import electron from 'electron'

/**
 * Mounted-race acceptance for the side-chat workspace.
 *
 * The production `useSideChatWorkspace` hook is mounted in an isolated sandboxed window with
 * an API whose answers are released on demand, so each read or create is answered *after*
 * the user switched parents. The driver proves the answer is filed under the parent it was
 * requested for: the visible parent's layout, notice, history page and selection
 * never change, and a durable create command is never dispatched twice.
 *
 * Scope: component-fixture UI evidence of the hook's wiring. Real IPC and the App shell are
 * proven by the App acceptance, so this file never claims an App-level or Provider-level run.
 */
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const temp = await mkdtemp(join(tmpdir(), 'scry-workspace-races-'))

async function run() {
  await Promise.all(['home', 'userData', 'sessionData'].map((name) => mkdir(join(temp, name))))
  await build({
    configFile: false, root: temp, envDir: temp, logLevel: 'error', esbuild: { jsx: 'automatic' },
    resolve: { alias: { '@shared': join(root, 'src/shared') } },
    define: { 'process.env.NODE_ENV': '"production"' },
    build: { outDir: temp, emptyOutDir: false, copyPublicDir: false, minify: false,
      lib: { entry: join(root, 'scripts/fixtures/side-chat-workspace-races.tsx'), formats: ['iife'],
        name: 'ScryRacesFixture', fileName: () => 'fixture.js' } }
  })
  await writeFile(join(temp, 'index.html'), '<!doctype html><meta charset="utf-8">' +
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'">' +
    '<div id="root"></div><script src="fixture.js"></script>')
  await writeFile(join(temp, 'main.cjs'), `
    const { app, BrowserWindow } = require('electron')
    if (process.platform === 'darwin') app.setActivationPolicy('prohibited')
    app.setPath('userData', ${JSON.stringify(join(temp, 'userData'))})
    app.setPath('sessionData', ${JSON.stringify(join(temp, 'sessionData'))})
    app.whenReady().then(async () => {
      app.dock?.hide()
      const win = new BrowserWindow({ show: false, width: 720, height: 520,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
      win.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('file:') }))
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      try {
        await win.loadFile(${JSON.stringify(join(temp, 'index.html'))})
        await win.webContents.executeJavaScript('window.ScryRacesFixture.mountSideChatWorkspaceRaces(); true')
        const result = await (${exercise.toString()})(win.webContents)
        console.log('SCRY_WORKSPACE_RACES_RESULT=' + JSON.stringify(result))
        app.exit(0)
      } catch (error) {
        console.error('SCRY_WORKSPACE_RACES_FAILURE=' + String(error && error.stack || error))
        app.exit(1)
      }
    })
  `)
  const child = spawn(electron, [join(temp, 'main.cjs')], { stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HOME: join(temp, 'home'), ELECTRON_ENABLE_LOGGING: '' } })
  let out = ''
  let err = ''
  child.stdout.on('data', (chunk) => { out += chunk })
  child.stderr.on('data', (chunk) => { err += chunk })
  const code = await new Promise((resolve) => child.on('exit', resolve))
  const line = out.split('\n').find((value) => value.startsWith('SCRY_WORKSPACE_RACES_RESULT='))
  if (code !== 0 || !line) throw new Error(`fixture exited ${code}: ${err.slice(-2000)} ${out.slice(-2000)}`)
  const result = JSON.parse(line.slice('SCRY_WORKSPACE_RACES_RESULT='.length))
  console.log(JSON.stringify({ test: 'side-chat workspace mounted races', ...result }))
  return { ...result, evidence: 'component-fixture UI proof of the mounted hook, not App or Provider evidence' }
}

/** Native pointer clicks and on-demand answers against the mounted hook. */
async function exercise(contents) {
  const read = (expression) => contents.executeJavaScript(expression)
  const frames = () => read('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))')
  const wait = async (expression, label) => {
    const deadline = Date.now() + 5000
    while (!await read(expression)) {
      if (Date.now() > deadline) throw new Error(`Timed out (${label}): ${expression}`)
      await frames()
    }
  }
  const must = (condition, message) => { if (!condition) throw new Error(message) }
  const click = async (selector) => {
    const point = await read(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) throw new Error('Missing: ' + ${JSON.stringify(selector)});
      const rect = element.getBoundingClientRect();
      const x = Math.round(rect.left + rect.width / 2), y = Math.round(rect.top + rect.height / 2);
      if (!element.contains(document.elementFromPoint(x, y))) throw new Error('Occluded: ' + ${JSON.stringify(selector)});
      return { x, y };
    })()`)
    contents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 })
    contents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 })
    await frames()
  }
  const state = () => read(`(() => ({
    scope: document.querySelector('[data-races-scope]')?.textContent ?? null,
    tabs: document.querySelector('[data-races-tabs]')?.textContent ?? null,
    notice: document.querySelector('[data-races-notice]')?.textContent ?? null,
    created: document.querySelector('[data-races-created]')?.textContent ?? null,
    history: document.querySelector('[data-races-history]')?.textContent ?? null }))()`)
  const pending = () => read(`window.__scryRaces.pending.map(entry => ({ kind: entry.kind, scope: entry.scope, ids: entry.ids ?? null, source: entry.source }))`)
  const requests = () => read('window.__scryRaces.requests')
  const calls = () => read('window.__scryRaces.calls')
  const switchTo = async (scope, ids) => {
    await read(`window.__scryRaces.switch(${JSON.stringify(scope)}, ${JSON.stringify(ids)}); true`)
    await wait(`document.querySelector('[data-races-scope]').textContent === ${JSON.stringify(scope)}`, `switch to ${scope}`)
    await frames()
  }
  /** Answer the oldest live request of one kind, exactly as the host eventually would. */
  const answer = async (kind, expression, options = {}) => {
    const resolved = await read(`window.__scryRaces.resolve(${JSON.stringify(kind)}, ${expression}, ${JSON.stringify(options)})`)
    must(resolved === true, `no live ${kind} request to answer: ${JSON.stringify(await pending())}`)
    await frames()
  }
  const summary = (id) => `window.ScryRacesFixture.summaryOf(${JSON.stringify(id)})`
  const settleList = async (ids, summaries) => answer('list',
    `({ total: ${summaries.length}, items: [${summaries.map((id) => summary(id)).join(', ')}] })`,
    ids === undefined ? { ids: 'none' } : { ids })
  const preview = (scope, extra = {}) => `window.ScryRacesFixture.previewOf(${JSON.stringify(scope)}, ${JSON.stringify(extra)})`

  await wait(`document.querySelector('[data-races-scope]')?.textContent === 'scope-A'`, 'mount')
  const evidence = {}

  // 1. A preview answered after the switch: nothing is created and the parent on screen is
  //    untouched — no notice, no layout change, no open call.
  await click('[data-races-create]')
  await wait(`window.__scryRaces.pending.some(entry => entry.kind === 'preview')`, 'preview requested')
  const previewPending = await pending()
  must(previewPending.length === 1 && previewPending[0].scope === 'scope-A' && previewPending[0].source.includes('native-A'),
    `the preview must be requested for the parent that clicked: ${JSON.stringify(previewPending)}`)
  await switchTo('scope-B', ['tab-B'])
  await answer('preview', preview('scope-A'))
  // The lookup the new parent always needs is answered as the host would answer it.
  await settleList(['tab-B'], ['tab-B'])
  await wait(`document.querySelector('[data-races-tabs]').textContent === 'tab-B'`, 'B layout')
  const afterPreview = await state()
  must(afterPreview.notice === '' && afterPreview.created === '',
    `a preview answered after the switch wrote into the visible parent: ${JSON.stringify(afterPreview)}`)
  must(afterPreview.history === 'closed', `a preview answered after the switch opened a dialog: ${JSON.stringify(afterPreview)}`)
  const noCreate = (await requests()).filter((entry) => entry.kind === 'create')
  must(noCreate.length === 0 && (await calls()).open.length === 0,
    `a preview answered after the switch still created or opened a child: ${JSON.stringify({ noCreate, calls: await calls() })}`)
  evidence.previewAfterSwitch = { scope: afterPreview.scope, tabs: afterPreview.tabs, notice: afterPreview.notice,
    createRequests: noCreate.length }

  // 2. A create reply answered after the switch: the child is filed under its own parent,
  //    exactly once, with the source that parent previewed — and never in the visible one.
  await switchTo('scope-A', ['tab-A'])
  await settleList(['tab-A'], ['tab-A'])
  await click('[data-races-create]')
  await wait(`window.__scryRaces.pending.some(entry => entry.kind === 'preview')`, 'second preview')
  await answer('preview', preview('scope-A'))
  await wait(`window.__scryRaces.pending.some(entry => entry.kind === 'create')`, 'create dispatched')
  const createRequests = (await requests()).filter((entry) => entry.kind === 'create')
  must(createRequests.length === 1 && JSON.parse(createRequests[0].source).nativeSessionId === 'native-A' &&
    createRequests[0].scope === 'scope-A', `the create must carry its own parent and source: ${JSON.stringify(createRequests)}`)
  await switchTo('scope-B', ['tab-B'])
  await answer('create', summary('child-A'))
  await settleList(['tab-B'], ['tab-B'])
  const afterCreate = await state()
  const createdCalls = (await calls()).open
  must(createdCalls.length === 1 && createdCalls[0][0] === 'child-A' && createdCalls[0][1] === 'scope-A',
    `a late create must open its child for the parent that issued it: ${JSON.stringify(createdCalls)}`)
  must(afterCreate.tabs === 'tab-B' && afterCreate.notice === '' && afterCreate.created === '',
    `a late create changed the visible parent: ${JSON.stringify(afterCreate)}`)
  evidence.createAfterSwitch = { open: createdCalls, visibleTabs: afterCreate.tabs, createSource: createRequests[0].source }

  // 3. A tab-validation lookup answered after the switch must not drop the visible parent's
  //    tabs, even when its own answer says the old id is gone.
  await switchTo('scope-A', ['tab-A3'])
  await switchTo('scope-B', ['tab-B'])
  await answer('list', '({ total: 0, items: [] })')
  await settleList(['tab-B'], ['tab-B'])
  const afterLookup = await state()
  must((await calls()).drop.length === 0 && afterLookup.tabs === 'tab-B',
    `a late tab lookup dropped tabs of another parent: ${JSON.stringify({ afterLookup, calls: await calls() })}`)
  evidence.lookupAfterSwitch = { drops: 0, visibleTabs: afterLookup.tabs }

  // 4. A history page answered after the switch stays out of the visible parent's dialog.
  await switchTo('scope-A', ['tab-A'])
  await settleList(['tab-A'], ['tab-A'])
  await click('[data-races-history-open]')
  await wait(`window.__scryRaces.pending.some(entry => entry.kind === 'list' && entry.ids == null)`, 'history requested')
  const historyRequest = (await pending()).find((entry) => entry.kind === 'list' && entry.ids == null)
  must(historyRequest.scope === 'scope-A' && historyRequest.source.includes('native-A'),
    `the history page must be requested for its own parent: ${JSON.stringify(historyRequest)}`)
  await switchTo('scope-B', ['tab-B'])
  await answer('list', `({ total: 1, items: [${summary('child-A')}] })`, { ids: 'none' })
  await settleList(['tab-B'], ['tab-B'])
  const afterHistory = await state()
  must(afterHistory.history === 'closed', `a late history page opened the visible parent's dialog: ${JSON.stringify(afterHistory)}`)
  evidence.historyAfterSwitch = { visibleHistory: afterHistory.history, requestedScope: historyRequest.scope }

  // 5. A refused preview belongs to the parent that asked; the next parent starts clean.
  //    There is no smaller-prefix offer: a refused range stays refused.
  await switchTo('scope-A', ['tab-A'])
  await settleList(['tab-A'], ['tab-A'])
  await click('[data-races-create]')
  await wait(`window.__scryRaces.pending.some(entry => entry.kind === 'preview')`, 'refused preview')
  await answer('preview', "'来源前缀包含无法验证的轮次，不能创建侧聊'", { failed: true })
  await wait(`document.querySelector('[data-races-notice]').textContent !== ''`, 'refusal notice')
  const refused = await state()
  await switchTo('scope-B', ['tab-B'])
  await settleList(['tab-B'], ['tab-B'])
  const afterRefusal = await state()
  must(refused.notice.includes('不能创建侧聊'), `the refusal must be reported to its own parent: ${JSON.stringify(refused)}`)
  must(refused.created === '', `a refused preview created a child: ${JSON.stringify(refused)}`)
  must(afterRefusal.notice === '' && afterRefusal.created === '',
    `another parent inherited a refusal notice: ${JSON.stringify(afterRefusal)}`)
  evidence.refusalAfterSwitch = { refusedIn: refused.notice, noticeInOther: afterRefusal.notice }

  // 6. A lost create reply answered after the switch keeps its durable command for its own
  //    parent: no notice here, and the later read-only check never dispatches a second create.
  await switchTo('scope-A', ['tab-A'])
  await settleList(['tab-A'], ['tab-A'])
  await click('[data-races-create]')
  await wait(`window.__scryRaces.pending.some(entry => entry.kind === 'preview')`, 'lost-reply preview')
  await answer('preview', preview('scope-A'))
  await wait(`window.__scryRaces.pending.some(entry => entry.kind === 'create')`, 'lost-reply create')
  await switchTo('scope-B', ['tab-B'])
  await answer('create', JSON.stringify('send reply lost'), { failed: true })
  await wait(`window.__scryRaces.pending.some(entry => entry.kind === 'find')`, 'receipt lookup')
  await answer('find', "({ commandId: 'fixture', status: 'not-found' })")
  await settleList(['tab-B'], ['tab-B'])
  const afterLost = await state()
  must(afterLost.notice === '' && afterLost.tabs === 'tab-B',
    `a lost create reply wrote its unknown notice into another parent: ${JSON.stringify(afterLost)}`)
  const createsBefore = (await requests()).filter((entry) => entry.kind === 'create').length
  await switchTo('scope-A', ['tab-A'])
  await settleList(['tab-A'], ['tab-A'])
  await click('[data-races-create]')
  // The durable command of this parent turns the click into a read-only check: a preview
  // would mean a second creation was starting.
  await wait(`window.__scryRaces.pending.some(entry => entry.kind === 'find')`, 'read-only receipt check')
  must(!(await pending()).some((entry) => entry.kind === 'preview'), 'checking an unknown command restarted a create')
  await answer('find', "({ commandId: 'fixture', status: 'not-found' })")
  await wait(`document.querySelector('[data-races-notice]').textContent.includes('没有查到')`, 'unknown receipt notice')
  const createsAfter = (await requests()).filter((entry) => entry.kind === 'create').length
  must(createsAfter === createsBefore,
    `checking an unknown command replayed the create: ${JSON.stringify({ createsBefore, createsAfter })}`)
  const sources = (await requests()).filter((entry) => entry.kind === 'create').map((entry) => JSON.parse(entry.source))
  must(sources.every((source) => source.nativeSessionId === 'native-A' && source.providerId === 'codex'),
    `every create must keep its own parent's exact source tuple: ${JSON.stringify(sources)}`)
  evidence.unknownReceipt = { createsBefore, createsAfter, notice: (await state()).notice, sources }
  return { ...evidence, answeredRequests: (await requests()).length, openCalls: (await calls()).open.length }
}

try {
  const result = await run()
  await rm(temp, { recursive: true, force: true })
  console.log(`[scry] workspace races fixture ok: ${JSON.stringify(result)}`)
} catch (error) {
  console.error(`[scry] workspace races fixture failed: ${String(error && error.message || error)}`)
  process.exitCode = 1
}
