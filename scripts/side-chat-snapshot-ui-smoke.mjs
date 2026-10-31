import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'vite'
import electron from 'electron'

/**
 * Component-fixture proof for the snapshot reader's paging.
 *
 * The pages are produced by the shipped reader over a real sealed artifact (see
 * `fixtures/side-chat-snapshot-pages.ts`), then the real `SideChatSnapshotViewer` is mounted
 * in an isolated sandboxed Electron window and driven with native pointer and key events.
 *
 * Scope: this is component-fixture UI evidence. The full App cannot freeze a prefix longer
 * than the handoff budget, so its own multi-page proof stays at the body API layer; a real
 * Provider run is never part of this fixture.
 */
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const temp = await mkdtemp(join(tmpdir(), 'scry-snapshot-ui-'))

async function realPages(turns) {
  const out = await mkdtemp(join(temp, 'pages-'))
  await build({
    configFile: false, root, logLevel: 'error', resolve: { alias: { '@shared': join(root, 'src/shared') } },
    define: { 'process.env.NODE_ENV': '"production"' },
    // The shipped archive projection parses with `stream-json`; the fixture module runs
    // from a temporary directory, so the parser has to be bundled, not externalized.
    ssr: { noExternal: true },
    build: { outDir: out, emptyOutDir: false, minify: false, ssr: true, target: 'node22',
      lib: { entry: join(root, 'scripts/fixtures/side-chat-snapshot-pages.ts'), formats: ['es'],
        fileName: () => 'pages.mjs' } }
  })
  const module = await import(pathToFileURL(join(out, 'side-chat-snapshot-pages.js')).href)
  return module.snapshotPages(turns)
}

/**
 * Two pages that a text fingerprint cannot tell apart.
 *
 * The page after the first is replaced by a copy of the first page's rows (same ordinals,
 * same lengths, same head and tail) while keeping its own cursor. A body of one repeated
 * character legitimately produces exactly that, so "the text did not change" is not a
 * statement about paging at all; the loaded cursor is.
 */
function identicalTextPages(pages) {
  if (pages.length < 4) throw new Error(`the identical-text control needs four pages, got ${pages.length}`)
  const source = pages[1].items
  return pages.map((page, index) => index !== 2 ? page
    : { ...page, items: page.items.map((item, row) => ({ ...item,
      text: source[row]?.text ?? item.text, sourceOrdinal: source[row]?.sourceOrdinal ?? item.sourceOrdinal })) })
}

async function run() {
  const identical = process.argv.includes('--identical-text-only')
  await Promise.all(['home', 'userData', 'sessionData'].map((name) => mkdir(join(temp, name))))
  const generated = await realPages(identical ? 80 : 21)
  if (generated.pages.length < 2) throw new Error(`fixture needs two real pages, got ${generated.pages.length}`)
  const served = identical ? identicalTextPages(generated.pages) : generated.pages
  const firstPageRows = served[0].items.length
  const lastPageRows = served[served.length - 1].items.length
  await build({
    configFile: false, root: temp, envDir: temp, logLevel: 'error',
    esbuild: { jsx: 'automatic' },
    resolve: { alias: { '@shared': join(root, 'src/shared') } },
    define: { 'process.env.NODE_ENV': '"production"' },
    build: { outDir: temp, emptyOutDir: false, copyPublicDir: false, minify: false,
      lib: { entry: join(root, 'scripts/fixtures/side-chat-snapshot-smoke.tsx'), formats: ['iife'],
        name: 'ScrySnapshotFixture', fileName: () => 'fixture.js', cssFileName: 'fixture' } }
  })
  await writeFile(join(temp, 'index.html'), '<!doctype html><meta charset="utf-8">' +
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; img-src data:">' +
    '<link rel="stylesheet" href="fixture.css"><div id="root"></div><script src="fixture.js"></script>')
  await writeFile(join(temp, 'main.cjs'), `
    const { app, BrowserWindow } = require('electron')
    if (process.platform === 'darwin') app.setActivationPolicy('prohibited')
    app.setPath('userData', ${JSON.stringify(join(temp, 'userData'))})
    app.setPath('sessionData', ${JSON.stringify(join(temp, 'sessionData'))})
    const pages = ${JSON.stringify(served)}
    const childId = ${JSON.stringify(generated.childId)}
    app.whenReady().then(async () => {
      app.dock?.hide()
      const win = new BrowserWindow({ show: false, width: 900, height: 700,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
      win.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('file:') }))
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      try {
        await win.loadFile(${JSON.stringify(join(temp, 'index.html'))})
        await win.webContents.executeJavaScript('window.__scrySnapshotPages = ' + JSON.stringify(pages) +
          '; window.ScrySnapshotFixture.mountSideChatSnapshotFixture(' + JSON.stringify(childId) + '); true')
        const result = ${identical ? 'true' : 'false'}
          ? await (${exerciseCursorOnly.toString()})(win.webContents, { pages: pages.length })
          : await (${exerciseNative.toString()})(win.webContents, { firstPageRows: ${firstPageRows}, lastPageRows: ${lastPageRows}, pages: pages.length })
        console.log('SCRY_SNAPSHOT_UI_RESULT=' + JSON.stringify(result))
        app.exit(0)
      } catch (error) {
        console.error('SCRY_SNAPSHOT_UI_FAILURE=' + String(error && error.stack || error))
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
  const line = out.split('\n').find((value) => value.startsWith('SCRY_SNAPSHOT_UI_RESULT='))
  if (code !== 0 || !line) throw new Error(`fixture exited ${code}: ${err.slice(-2000)} ${out.slice(-2000)}`)
  const result = JSON.parse(line.slice('SCRY_SNAPSHOT_UI_RESULT='.length))
  console.log(JSON.stringify({ test: identical ? 'side-chat snapshot viewer cursor oracle control' : 'side-chat snapshot viewer component fixture', ...result }))
  return { ...result, evidence: 'component-fixture UI proof, not full-App multi-page or real Provider proof' }
}

/**
 * Whole-chain walk that identifies a page by the cursor the dialog loaded.
 *
 * The fixture serves one page pair with identical ordinals and identical text, which is what
 * a page boundary inside one repeated body legitimately looks like. A text fingerprint calls
 * the second page of that pair "not advanced" although the dialog did page; the loaded cursor
 * is the only statement about which body is on screen. Both facts are asserted here, so the
 * control fails if the fixture stops being indistinguishable or if the walk stops advancing.
 */
async function exerciseCursorOnly(contents, expect) {
  const read = (expression) => contents.executeJavaScript(expression)
  const wait = async (expression, label) => {
    const deadline = Date.now() + 20000
    while (!await read(expression)) {
      if (Date.now() > deadline) throw new Error(`Timed out (${label}): ${expression}`)
      await read('new Promise(resolve => requestAnimationFrame(resolve))')
    }
  }
  const click = async (selector) => {
    const point = await read(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      element.scrollIntoView({ block: 'nearest' });
      const rect = element.getBoundingClientRect();
      const x = Math.round(rect.left + rect.width / 2), y = Math.round(rect.top + rect.height / 2);
      if (!element.contains(document.elementFromPoint(x, y))) throw new Error('Occluded: ' + ${JSON.stringify(selector)});
      return { x, y };
    })()`)
    contents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 })
    contents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 })
  }
  const at = (cursor) => `document.querySelector('[data-side-chat-snapshot]')?.dataset.sideChatSnapshotLoadedCursor === ${JSON.stringify(cursor)}`
  const page = () => read(`(() => {
    const viewer = document.querySelector('[data-side-chat-snapshot]')
    const rows = [...document.querySelectorAll('[data-side-chat-snapshot] li[data-snapshot-role]')]
    const button = (label) => [...document.querySelectorAll('[data-side-chat-snapshot] button')].find(node => node.textContent.trim() === label)
    return { loaded: viewer?.dataset.sideChatSnapshotLoadedCursor ?? null,
      next: viewer?.dataset.sideChatSnapshotNextCursor || null,
      state: viewer?.querySelector('[data-snapshot-state]')?.dataset.snapshotState ?? null,
      ordinals: rows.map(row => Number(row.dataset.snapshotSourceOrdinal)),
      fingerprint: rows.map(row => (row.dataset.snapshotSourceOrdinal ?? '') + ':' + (row.textContent ?? '').length +
        ':' + (row.textContent ?? '').slice(0, 24) + ':' + (row.textContent ?? '').slice(-24)).join('|'),
      older: button('上一页')?.disabled, newer: button('下一页')?.disabled,
      reads: (window.__scrySnapshotReads ?? []).length } })()`)

  await read(`document.querySelector('#open-snapshot').focus(); true`)
  await click('#open-snapshot')
  await wait(at('0:0'), 'first page')
  const walked = [await page()]
  let fingerprintStuck = 0
  while (walked.at(-1).next !== null) {
    const previous = walked.at(-1)
    await click('[data-side-chat-snapshot] .side-chat-snapshot-footer button:nth-of-type(2)')
    await wait(at(previous.next), `page after ${previous.loaded}`)
    const current = await page()
    if (current.loaded !== previous.next) throw new Error(`loaded ${current.loaded}, announced ${previous.next}`)
    if (current.fingerprint === previous.fingerprint) fingerprintStuck += 1
    walked.push(current)
    if (walked.length > expect.pages) throw new Error(`walked past the served chain: ${walked.length} > ${expect.pages}`)
  }
  if (walked.length !== expect.pages) throw new Error(`walked ${walked.length} pages, served ${expect.pages}`)
  if (fingerprintStuck !== 1) throw new Error(`the identical pair must defeat the text fingerprint exactly once, got ${fingerprintStuck}`)
  const last = walked.at(-1)
  if (last.state !== 'complete' || last.newer !== true || last.older !== false) {
    throw new Error(`last page was not the end of the chain: ${JSON.stringify(last)}`)
  }
  if (last.reads !== walked.length) throw new Error(`the walk cost ${last.reads} reads for ${walked.length} pages`)
  // Back and forward are cursor-identified too, so a repeated body cannot fake them either.
  await click('[data-side-chat-snapshot] .side-chat-snapshot-footer button:nth-of-type(1)')
  await wait(at(walked.at(-2).loaded), 'older page')
  const back = await page()
  if (back.loaded !== walked.at(-2).loaded) throw new Error(`older page loaded ${back.loaded}`)
  await click('[data-side-chat-snapshot] .side-chat-snapshot-footer button:nth-of-type(2)')
  await wait(at(last.loaded), 'last page again')
  contents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
  contents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
  await wait(`document.querySelector('[data-side-chat-snapshot]') == null`, 'escape close')
  await wait(`document.activeElement === document.querySelector('#open-snapshot')`, 'focus restore')
  return { pages: walked.length, fingerprintStuckPages: fingerprintStuck, lastLoaded: last.loaded,
    lastOrdinal: last.ordinals.at(-1) ?? null, reads: last.reads, backForwardRestored: true,
    escapeRestoredFocus: true }
}

/** Native pointer and key input against the mounted component. */
async function exerciseNative(contents, expect) {
  const read = (expression) => contents.executeJavaScript(expression)
  const wait = async (expression, label) => {
    const deadline = Date.now() + 5000
    while (!await read(expression)) {
      if (Date.now() > deadline) throw new Error(`Timed out (${label}): ${expression}`)
      await read('new Promise(resolve => requestAnimationFrame(resolve))')
    }
  }
  const click = async (selector) => {
    const point = await read(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      element.scrollIntoView({ block: 'nearest' });
      const rect = element.getBoundingClientRect();
      const x = Math.round(rect.left + rect.width / 2), y = Math.round(rect.top + rect.height / 2);
      if (!element.contains(document.elementFromPoint(x, y))) throw new Error('Occluded: ' + ${JSON.stringify(selector)});
      return { x, y };
    })()`)
    contents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 })
    contents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 })
  }
  await read(`document.querySelector('#open-snapshot').focus(); true`)
  await click('#open-snapshot')
  await wait(`document.querySelector('[data-side-chat-snapshot] li[data-snapshot-role]') != null`, 'first page')
  await wait(`document.activeElement === document.querySelector('.side-chat-snapshot [aria-label="关闭快照"]')`, 'initial focus')
  const page = () => read(`(() => {
    const rows = [...document.querySelectorAll('[data-side-chat-snapshot] li[data-snapshot-role]')]
    const button = (label) => [...document.querySelectorAll('[data-side-chat-snapshot] button')].find(node => node.textContent.trim() === label)
    return { rows: rows.length, state: document.querySelector('[data-side-chat-snapshot] [data-snapshot-state]')?.dataset.snapshotState ?? null,
      cursor: document.querySelector('[data-side-chat-snapshot]')?.dataset.sideChatSnapshotCursor ?? null,
      loaded: document.querySelector('[data-side-chat-snapshot]')?.dataset.sideChatSnapshotLoadedCursor ?? null,
      next: document.querySelector('[data-side-chat-snapshot]')?.dataset.sideChatSnapshotNextCursor || null,
      older: button('上一页')?.disabled, newer: button('下一页')?.disabled,
      first: rows[0]?.textContent ?? null, last: rows.at(-1)?.textContent ?? null,
      text: rows.map(node => node.textContent).join('\\n'), reads: (window.__scrySnapshotReads ?? []).length,
      focused: document.activeElement?.getAttribute('aria-label') ?? null }
  })()`)
  const first = await page()
  if (first.rows !== expect.firstPageRows) throw new Error(`first page rendered ${first.rows} rows, artifact has ${expect.firstPageRows}`)
  if (first.rows > 40) throw new Error(`first page rendered ${first.rows} rows, over the 40-row bound`)
  if (first.state !== 'partial') throw new Error(`first page state was ${first.state}`)
  if (first.older !== true) throw new Error('first page offered a previous page')
  if (first.newer !== false) throw new Error('first page did not offer its next page')
  if (first.reads !== 1) throw new Error(`first page cost ${first.reads} reads`)
  if (!first.text.includes('冻结第 1 轮🙂🀄️ 正文')) throw new Error('first page lost its frozen text')
  if (first.text.includes('\uFFFD')) throw new Error('first page split a character')
  await click('[data-side-chat-snapshot] .side-chat-snapshot-footer button:nth-of-type(2)')
  await wait(`document.querySelector('[data-side-chat-snapshot]')?.dataset.sideChatSnapshotLoadedCursor === ${JSON.stringify(first.next)}`, 'second page')
  await wait(`document.querySelector('[data-side-chat-snapshot] [data-snapshot-state]')?.dataset.snapshotState === 'complete'`, 'last page')
  const second = await page()
  if (second.rows !== expect.lastPageRows) throw new Error(`last page rendered ${second.rows} rows, artifact has ${expect.lastPageRows}`)
  if (second.newer !== true) throw new Error('last page offered another page')
  if (second.older !== false) throw new Error('last page did not offer its previous page')
  if (second.reads !== 2) throw new Error(`paging cost ${second.reads} reads`)
  if (!second.text.includes('冻结第 21 轮🙂🀄️ 正文')) throw new Error('last page lost the final frozen message')
  if (second.text.includes('\uFFFD')) throw new Error('a page boundary split a character')
  await click('[data-side-chat-snapshot] .side-chat-snapshot-footer button:nth-of-type(1)')
  await wait(`document.querySelector('[data-side-chat-snapshot]')?.dataset.sideChatSnapshotLoadedCursor === ${JSON.stringify(first.loaded)}`, 'back page')
  const back = await page()
  if (back.rows !== first.rows || back.first !== first.first || back.last !== first.last) throw new Error('paging back returned another page')
  contents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
  contents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
  await wait(`document.querySelector('[data-side-chat-snapshot]') == null`, 'escape close')
  await wait(`document.activeElement === document.querySelector('#open-snapshot')`, 'focus restore')
  return { pages: expect.pages, firstRows: first.rows, lastRows: second.rows, firstState: first.state,
    lastState: second.state, readsPerPage: 2, backRestored: true, unicodeIntact: true, escapeRestoredFocus: true }
}

try {
  const result = await run()
  await rm(temp, { recursive: true, force: true })
  if (process.env.SCRY_SNAPSHOT_UI_ONLY !== '1') console.log(`[scry] snapshot viewer fixture ok: ${JSON.stringify(result)}`)
} catch (error) {
  console.error(`[scry] snapshot viewer fixture failed: ${String(error && error.message || error)}`)
  process.exitCode = 1
}
