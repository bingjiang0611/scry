import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build as bundle } from 'esbuild'
import { build } from 'vite'
import electron from 'electron'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const temp = await mkdtemp(join(tmpdir(), 'scry-credits-ui-'))

// Invisible sandboxed fixture; real SQLite/archives only in temp, no Provider or network.
async function exercise() {
  const check = (condition, message) => { if (!condition) throw new Error(message) }
  const waitFor = (predicate) => new Promise((resolve, reject) => {
    if (predicate()) return resolve()
    const observer = new MutationObserver(() => {
      if (predicate()) { clearTimeout(timer); observer.disconnect(); resolve() }
    })
    const timer = setTimeout(() => { observer.disconnect(); reject(new Error('DOM condition timed out')) }, 5000)
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true })
  })
  await waitFor(() => document.querySelector('.usage-provider-main')?.textContent.includes('12.5 Credits'))
  check(document.querySelector('.usage-cost-card > strong').textContent === '$1.25', 'Credits polluted USD total')
  check(document.body.textContent.includes('Credits 已知下界'), 'Missing partial evidence')
  const groupButton = (label, value) => [...document.querySelectorAll(`[aria-label="${label}"] button`)].find((button) => button.textContent === value)
  groupButton('明细维度', '日期').click()
  await waitFor(() => document.querySelector('.usage-table-wrap thead').textContent.includes('日期'))
  check(document.querySelector('.usage-table-wrap').textContent.includes('$1.25 + 12.5 Credits'), 'Day breakdown mixed or lost units')
  groupButton('明细维度', '模型').click()
  await waitFor(() => document.querySelector('.usage-table-wrap thead').textContent.includes('模型'))
  check(document.querySelector('.usage-table-wrap').textContent.includes('12.5 Credits'), 'Model breakdown lost Qoder credits')
  groupButton('趋势指标', 'TOKEN').click()
  await waitFor(() => document.querySelector('.usage-chart').getAttribute('aria-label').includes('Token'))
  groupButton('趋势指标', '成本').click()
  await waitFor(() => document.querySelector('.usage-chart').getAttribute('aria-label').includes('成本'))
  check(!document.querySelector('.usage-chart .is-qoder'), 'Qoder credits plotted on USD axis')
  groupButton('分析时间范围', '30 天').click()
  await waitFor(() => document.querySelector('#fixture-status').dataset.range === '30')
  document.querySelector('[aria-label="刷新分析数据"]').click()
  await waitFor(() => document.querySelector('#fixture-status').dataset.refreshes === '1')
  for (const node of document.querySelectorAll('.usage-provider-main')) {
    check(node.scrollWidth <= node.clientWidth + 1, 'Provider amount overflows')
  }
  return { sqliteAndArchiveProjection: true, separateUnits: true, dayAndModel: true, chartSwitch: true, refresh: true, range: true }
}

try {
  await Promise.all(['home', 'userData', 'sessionData', 'workspace', 'qoder/projects/project'].map((name) => mkdir(join(temp, name), { recursive: true })))
  await symlink(join(root, 'node_modules'), join(temp, 'node_modules'), 'dir')
  await bundle({ entryPoints: [join(root, 'src/main/db.ts'), join(root, 'src/main/transcript-archive.ts')], outdir: temp, outExtension: { '.js': '.mjs' }, bundle: true, platform: 'node', format: 'esm', packages: 'external' })
  await build({
    configFile: false, root: temp, envDir: temp, logLevel: 'error', esbuild: { jsx: 'automatic' },
    resolve: { alias: { '@shared': join(root, 'src/shared') } }, define: { 'process.env.NODE_ENV': '"production"' },
    build: { outDir: temp, emptyOutDir: false, copyPublicDir: false, minify: false,
      lib: { entry: join(root, 'scripts/fixtures/analytics-credits-smoke.tsx'), formats: ['iife'], name: 'CreditsFixture', fileName: () => 'fixture.js', cssFileName: 'fixture' } }
  })
  await writeFile(join(temp, 'index.html'), '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'"><link rel="stylesheet" href="fixture.css"><div id="root"></div><script src="fixture.js"></script>')
  await writeFile(join(temp, 'main.cjs'), `
    const { app, BrowserWindow } = require('electron')
    const { writeFileSync } = require('node:fs')
    const { join } = require('node:path')
    const root = ${JSON.stringify(temp)}
    if (process.platform === 'darwin') app.setActivationPolicy('prohibited')
    app.setPath('userData', join(root, 'userData'))
    app.setPath('sessionData', join(root, 'sessionData'))
    process.env.QODER_CONFIG_DIR = join(root, 'qoder')
    app.whenReady().then(async () => {
      app.dock?.hide()
      const { initDb, recordTurn, usageAnalyticsWithCreditsQuery } = await import('./db.mjs')
      const { upsertTraceArchiveTurn } = await import('./transcript-archive.mjs')
      const cwd = join(root, 'workspace')
      const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
      initDb()
      for (const provider of ['qoder', 'claude']) {
        if (!recordTurn({ runId: provider, sessionId, cwd, userText: 'fixture', providerId: provider,
          runtimeProvider: provider === 'qoder' ? 'qoder_cli' : 'claude_sdk', billingProvider: provider === 'qoder' ? 'qoder' : 'anthropic',
          items: [{ id: provider + '-result', runId: provider, kind: 'harness', stage: 'result', ts: new Date().toISOString(), tokensIn: 1000, tokensOut: 200, costUsd: provider === 'qoder' ? undefined : 1.25 }] })) throw new Error('Temporary DB write failed')
      }
      if (!upsertTraceArchiveTurn({ cwd, sessionId, userDataDir: app.getPath('userData'), providerId: 'qoder',
        turn: { runId: 'qoder', forkTurnId: 'user-1', userText: 'fixture', items: [], done: true } })) throw new Error('Temporary archive failed')
      const file = join(root, 'qoder/projects/project', sessionId + '.jsonl')
      const native = (credits) => [
        { type: 'user', uuid: 'user-1', sessionId, cwd, message: { content: 'fixture' } },
        { type: 'assistant', uuid: 'assistant-1', parentUuid: 'user-1', sessionId, cwd, message: { id: 'message-1', usage: { credits, billable: true, request_id: 'request-1' } } }
      ].map(row => JSON.stringify(row)).join('\\n')
      writeFileSync(file, native(12.5))
      const analytics = await usageAnalyticsWithCreditsQuery(7)
      if (analytics.totals.qoderCredits?.credits !== 12.5) throw new Error('DB scope/native integration failed')
      writeFileSync(file, native(13.5))
      if ((await usageAnalyticsWithCreditsQuery(7)).totals.qoderCredits?.credits !== 13.5) throw new Error('Refresh reused stale native credits')
      const win = new BrowserWindow({ width: 1100, height: 850, show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
      win.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('file:') }))
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      await win.loadFile(join(root, 'index.html'))
      await win.webContents.executeJavaScript('window.setCreditsFixture(' + JSON.stringify(analytics) + ')')
      const result = await win.webContents.executeJavaScript(${JSON.stringify(`(${exercise.toString()})()`)})
      console.log('SCRY_CREDITS_UI_RESULT=' + JSON.stringify(result))
      app.exit(0)
    }).catch(error => { console.error(error); app.exit(1) })
  `)
  await new Promise((resolve, reject) => {
    const child = spawn(electron, [join(temp, 'main.cjs'), '--disable-gpu'], { env: { PATH: process.env.PATH, TMPDIR: tmpdir(), HOME: join(temp, 'home') }, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    const timer = setTimeout(() => child.kill('SIGTERM'), 30_000)
    child.stdout.on('data', (chunk) => { output += chunk.toString() })
    child.stderr.on('data', (chunk) => { output += chunk.toString() })
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      const result = output.match(/^SCRY_CREDITS_UI_RESULT=(.+)$/m)?.[1]
      if (code !== 0 || !result) reject(new Error(`Credits fixture failed (${code ?? signal}):\n${output.slice(-8000)}`))
      else { console.log(result); resolve() }
    })
  })
} finally {
  await rm(temp, { recursive: true, force: true })
}
