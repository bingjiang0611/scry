import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build as bundle } from 'esbuild'
import { build } from 'vite'
import electron from 'electron'
import { exerciseNative } from './analytics-credits-ui-checks.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const temp = await mkdtemp(join(tmpdir(), 'scry-credits-ui-'))
const screenshotDir = process.env.SCRY_ANALYTICS_SCREENSHOTS ?? ''

// Invisible sandboxed fixture; real SQLite/archives only in temp, no Provider or network.
async function exercise() {
  const check = (condition, message) => { if (!condition) throw new Error(message) }
  const waitFor = (predicate) => new Promise((resolve, reject) => {
    if (predicate()) return resolve()
    const observer = new MutationObserver(() => {
      if (predicate()) { clearTimeout(timer); observer.disconnect(); resolve() }
    })
    const timer = setTimeout(() => { observer.disconnect(); reject(new Error('DOM condition timed out: ' + document.body.innerText.slice(0, 800))) }, 5000)
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true })
  })
  const tab = (label) => [...document.querySelectorAll('.analytics-tabs [role="tab"]')].find((node) => node.textContent === label)
  const group = (label, value) => [...document.querySelectorAll(`[aria-label="${label}"] button`)].find((button) => button.textContent === value)
  const rowOf = (name) => [...document.querySelectorAll('.analytics-table.is-agents tbody tr')]
    .find((row) => row.querySelector('.analytics-name')?.textContent === name)
  await waitFor(() => document.querySelector('.analytics-page') != null)
  check(!document.querySelector('.llm-perf-modal'), 'The removed performance modal is still reachable')
  check(tab('LLM 性能')?.getAttribute('aria-selected') === 'true', 'Performance is not the default tab')
  tab('成本与用量').click()
  await waitFor(() => document.querySelector('.analytics-tile.is-hero .analytics-tile-value')?.textContent === '$1.41')
  check(document.querySelector('.analytics-tile.is-hero .analytics-tile-value').textContent === '$1.41', 'Qoder and official API equivalents missing from total')
  check(document.querySelector('.analytics-note.is-basis').textContent === '金额按 API 价格折算。', 'Cost basis sentence is missing')
  const qoderRow = rowOf('Qoder')
  check(qoderRow?.className.includes('is-agent'), 'Qoder is not an Agent row')
  check(qoderRow.querySelector('.is-strong').textContent === '$0.15', 'Pi/native Qoder Credits not converted to USD: ' + qoderRow.textContent)
  check(document.querySelector('.analytics-table.is-agents').textContent.includes('claude-opus-5'), 'Managed custom-provider Claude usage missing')
  // 网关是模型行的副标题，不再单独成一个 Provider 行。
  const customRow = [...document.querySelectorAll('.analytics-table.is-agents tbody tr')]
    .find((row) => row.querySelector('.analytics-sub')?.textContent === 'cc-switch')
  check(customRow?.className.includes('is-model'), 'Gateway is not a model subtitle')
  check(customRow.querySelector('.is-strong').textContent === '<$0.01', 'Missing official Claude API estimate')
  // 没有价格证据的模型仍列出：成本格留空并注明未定价，不写「—」也不写 $0.00。
  const unpricedRow = [...document.querySelectorAll('.analytics-table.is-agents tbody tr')].find((row) => row.textContent.includes('unpriced-model'))
  check(unpricedRow && unpricedRow.querySelectorAll('td')[2].textContent === '查不到这个模型的价格', 'Unpriced model row lost its blank cost cell: ' + (unpricedRow?.textContent ?? ''))
  check(unpricedRow.textContent.includes('查不到这个模型的价格'), 'Unpriced model row lost its explanation')
  check(document.querySelector('.analytics-table.is-agents [title*="官方 API 标准价换算"]'), 'Estimate provenance is missing')
  check(qoderRow.querySelector('.is-strong').title.includes('15.41 Credits') && qoderRow.querySelector('.is-strong').title.includes('已知下界'), 'Missing partial credit evidence')
  check(!document.querySelector('.analytics-page').textContent.includes('—'), 'A placeholder dash is still visible')
  check(!document.querySelector('.analytics-page').textContent.includes('所选：'), 'The removed model selection label is still visible')
  group('度量', 'Token').click()
  await waitFor(() => document.querySelector('.analytics-chart svg')?.getAttribute('aria-label') === '每日 Token')
  check([...document.querySelectorAll('.analytics-axis-unit')].some((node) => node.textContent === 'Token'), 'Token chart lost its axis unit')
  group('度量', '成本').click()
  await waitFor(() => document.querySelector('.analytics-chart svg')?.getAttribute('aria-label') === '每日成本')
  group('时间范围', '90 天').click()
  await waitFor(() => document.querySelector('#fixture-status').dataset.range === '90')
  check(group('时间范围', '90 天').getAttribute('aria-pressed') === 'true', 'Range did not follow the click')
  tab('LLM 性能').click()
  await waitFor(() => tab('LLM 性能').getAttribute('aria-selected') === 'true')
  check(tab('成本与用量').getAttribute('aria-selected') === 'false', 'Tabs are not mutually exclusive')
  for (const node of document.querySelectorAll('.analytics-row .is-strong, .analytics-tile-value')) {
    check(node.scrollWidth <= node.clientWidth + 1, 'Amount overflows its cell')
  }
  return { sqliteAndArchiveProjection: true, piQoderMetering: true, customClaude: true, gatewaySubtitle: true,
    usdEquivalent: true, agentAndModel: true, chartSwitch: true, tabs: true, range: true, noDashes: true }
}

try {
  if (screenshotDir) await mkdir(screenshotDir, { recursive: true })
  await Promise.all(['home', 'userData', 'sessionData', 'workspace', 'qoder/projects/project'].map((name) => mkdir(join(temp, name), { recursive: true })))
  await symlink(join(root, 'node_modules'), join(temp, 'node_modules'), 'dir')
  await bundle({ entryPoints: [join(root, 'src/main/db.ts'), join(root, 'src/main/transcript-archive.ts'), join(root, 'src/core/turn-recorder/aggregate.ts'), join(root, 'src/shared/credit-usage.ts')], outdir: temp, entryNames: '[name]', outExtension: { '.js': '.mjs' }, bundle: true, platform: 'node', format: 'esm', packages: 'external' })
  await build({
    configFile: false, root: temp, envDir: temp, logLevel: 'error', esbuild: { jsx: 'automatic' },
    worker: { format: 'es' },
    resolve: { alias: { '@shared': join(root, 'src/shared') } }, define: { 'process.env.NODE_ENV': '"production"' },
    build: { outDir: temp, emptyOutDir: false, copyPublicDir: false, minify: false,
      lib: { entry: join(root, 'scripts/fixtures/analytics-credits-smoke.tsx'), formats: ['iife'], name: 'CreditsFixture', fileName: () => 'fixture.js', cssFileName: 'fixture' } }
  })
  await writeFile(join(temp, 'index.html'), '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'; worker-src \'self\'; style-src \'self\' \'unsafe-inline\'; img-src \'self\' data:"><link rel="stylesheet" href="fixture.css"><div id="root"></div><script src="fixture.js"></script>')
  await writeFile(join(temp, 'main.cjs'), `
    const { app, BrowserWindow } = require('electron')
    const { writeFileSync } = require('node:fs')
    const { join } = require('node:path')
    const root = ${JSON.stringify(temp)}
    require(${JSON.stringify(join(root, 'scripts/hidden-electron-windows.cjs'))})(app)
    if (process.platform === 'darwin') app.setActivationPolicy('prohibited')
    app.setPath('userData', join(root, 'userData'))
    app.setPath('sessionData', join(root, 'sessionData'))
    process.env.QODER_CONFIG_DIR = join(root, 'qoder')
    app.whenReady().then(async () => {
      app.dock?.hide()
      const { configureStorage, initDb, recordTurn, usageAnalyticsQuery, usageAnalyticsWithCreditsQuery } = await import('./db.mjs')
      const { upsertTraceArchiveTurn } = await import('./transcript-archive.mjs')
      const { aggregateTurnEvidence } = await import('./aggregate.mjs')
      const { creditUsageEvidence } = await import('./credit-usage.mjs')
      const cwd = join(root, 'workspace')
      const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
      // The database no longer asks Electron for userData: inject the temporary root.
      configureStorage({ userDataDir: app.getPath('userData'), appPath: app.getAppPath() })
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
      let analytics = await usageAnalyticsWithCreditsQuery(7)
      if (analytics.totals.qoderCredits?.credits !== 12.5) throw new Error('DB scope/native integration failed')
      writeFileSync(file, native(13.5))
      if ((await usageAnalyticsWithCreditsQuery(7)).totals.qoderCredits?.credits !== 13.5) throw new Error('Refresh reused stale native credits')
      // Recorded evidence supersedes the native shadow, including a credits-only interrupted turn.
      for (const runId of ['qoder', 'interrupted']) {
        const items = [{ id: 'credits:' + runId, runId, ts: new Date().toISOString(), kind: 'harness', stage: 'credit_usage',
          creditUsage: creditUsageEvidence([{ id: runId, runId, credits: runId === 'qoder' ? 12.5 : 0 }], 'qoder_sdk') }]
        if (!recordTurn({ runId, sessionId, cwd, userText: 'fixture', providerId: 'qoder', runtimeProvider: 'qoder_cli', billingProvider: 'qoder', items })) throw new Error('Credits ledger write failed')
        if (!upsertTraceArchiveTurn({ cwd, sessionId, userDataDir: app.getPath('userData'), providerId: 'qoder',
          turn: { runId, forkTurnId: runId === 'qoder' ? 'user-1' : 'user-2', userText: 'fixture', items, done: true, turnEvidence: aggregateTurnEvidence({ events: items }) } })) throw new Error('Recorded credits archive failed')
      }
      analytics = await usageAnalyticsWithCreditsQuery(7)
      if (analytics.totals.qoderCredits?.credits !== 12.5 || analytics.totals.qoderCredits?.source !== 'qoder_recorded_usage') throw new Error('Recorded/native evidence was double counted')
      if (analytics.totals.usageRows !== 3 || analytics.totals.inputTokens !== 2000) throw new Error('Credits rows duplicated token counters or lost the result-less turn')
      // Managed Pi sessions use custom-provider identities and separate metering,
      // not the native Qoder archive layout or its zero-dollar placeholder.
      const piSession = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff'
      const piTurns = []
      for (const [runId, provider, model] of [['pi-qoder', 'qoder', 'ultimate'], ['pi-claude', 'cc-switch', 'claude-opus-5'], ['pi-unknown', 'cc-switch', 'unpriced-model']]) {
        const turn = { runId, sessionId: piSession, cwd, userText: 'fixture', providerId: 'pi', runtimeProvider: 'pi_rpc',
          items: [{ id: runId + '-result', runId, kind: 'harness', stage: 'result', ts: new Date().toISOString(),
            runtimeProvider: 'pi_rpc', modelUsage: [{ model, upstreamProvider: provider, inputTokens: 100, outputTokens: 20 }] }] }
        piTurns.push(turn)
        if (!recordTurn(turn)) throw new Error('Pi usage write failed')
      }
      const sqlite = new (require('better-sqlite3'))(join(app.getPath('userData'), 'scry.db'))
      sqlite.prepare("UPDATE usage_ledger SET source='scry_persisted_usage' WHERE span_id='pi-claude-result'").run()
      sqlite.prepare("INSERT INTO usage_ledger (id,provider,source,source_kind,span_id,usage_kind,input_tokens,cost_unit,cost_source,confidence,attribution_method,created_ts) VALUES ('old-unknown','unknown','scry_persisted_usage','analytics_report','pi-claude-result','result',999,'usd','sdk_estimate','inferred','direct',1)").run()
      if (!recordTurn(piTurns[1]) || sqlite.prepare("SELECT COUNT(*) n FROM usage_ledger WHERE span_id='pi-claude-result'").get().n !== 1) throw new Error('Canonical replay doubled reconstructed usage')
      sqlite.close()
      if (!upsertTraceArchiveTurn({ cwd, sessionId: piSession, userDataDir: app.getPath('userData'), providerId: 'pi', runtimeProvider: 'pi_rpc',
        turn: { runId: 'pi-qoder', providerTurnId: 'pi-user', userText: 'fixture', items: [], done: true } })) throw new Error('Pi archive failed')
      const piDirectory = join(root, 'home/.pi/agent/sessions', '--' + cwd.slice(1).replaceAll('/', '-') + '--')
      require('node:fs').mkdirSync(piDirectory, { recursive: true })
      writeFileSync(join(piDirectory, '2026-09-09_' + piSession + '.jsonl'), [
        { type: 'session', version: 3, id: piSession, cwd },
        { type: 'message', id: 'pi-user', parentId: null, message: { role: 'user' } },
        { type: 'custom', id: 'pi-metering', parentId: 'pi-user', customType: 'qoder-credit-observation-v1',
          data: { version: 1, sessionId: piSession, requestId: 'pi-request', modelId: 'ultimate', status: 'reported',
            outcome: 'complete', credits: 2.909718812000001, billable: true } },
        { type: 'message', id: 'pi-assistant', parentId: 'pi-metering', message: { role: 'assistant', provider: 'qoder' } }
      ].map(row => JSON.stringify(row)).join('\\n'))
      analytics = await usageAnalyticsWithCreditsQuery(7)
      if (Math.abs(analytics.totals.qoderCredits?.credits - 15.409718812000001) > 1e-10 ||
        !analytics.byModel.some(row => row.provider === 'cc-switch' && row.model === 'claude-opus-5')) throw new Error('Pi Qoder/Claude projection missing')
      const again = await usageAnalyticsWithCreditsQuery(7)
      if (JSON.stringify(again.totals) !== JSON.stringify(analytics.totals)) throw new Error('Pi refresh doubled usage')
      // Persist Pi Credits, then remove their native shadow: both the first SQLite
      // snapshot and subsequent refresh must retain the exact amount, once only.
      const piRecorded = { ...piTurns[0], items: [...piTurns[0].items, {
        id: 'pi-credits', runId: 'pi-qoder', ts: new Date().toISOString(), kind: 'harness', stage: 'credit_usage',
        creditUsage: creditUsageEvidence([{ id: 'pi-request', runId: 'pi-qoder', credits: 2.909718812000001 }], 'pi_qoder_credit_observation')
      }] }
      if (!recordTurn(piRecorded)) throw new Error('Pi credits ledger write failed')
      require('node:fs').unlinkSync(join(piDirectory, '2026-09-09_' + piSession + '.jsonl'))
      for (const snapshot of [usageAnalyticsQuery(7), await usageAnalyticsWithCreditsQuery(7)]) {
        const amount = snapshot.totals.qoderCredits?.credits
        const cost = snapshot.byProvider.find(row => row.provider === 'qoder')?.costUsd
        if (!Number.isFinite(amount) || Math.abs(amount - 15.409718812000001) > 1e-10 ||
          !Number.isFinite(cost) || Math.abs(cost - 0.15409718812000001) > 1e-10) throw new Error('Ledger-first Pi Credits missing or doubled')
      }
      // Add a real measured-zero day only after the original deduplication/count contracts.
      const zeroDate = new Date()
      zeroDate.setDate(zeroDate.getDate() - 2)
      if (!recordTurn({ runId: 'measured-zero', sessionId, cwd, userText: 'zero fixture', providerId: 'claude',
        runtimeProvider: 'claude_sdk', billingProvider: 'anthropic',
        items: [{ id: 'zero-result', runId: 'measured-zero', kind: 'harness', stage: 'result', ts: zeroDate.toISOString(), tokensIn: 0, tokensOut: 0, costUsd: 0 }] })) throw new Error('Zero fixture write failed')
      analytics = await usageAnalyticsWithCreditsQuery(7)
      const win = new BrowserWindow({ enableLargerThanScreen: true, width: 1100, height: 850, show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
      win.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('file:') }))
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      win.webContents.on('console-message', (event) => { if (event.level === 'error') console.error('Renderer:', event.message) })
      await win.loadFile(join(root, 'index.html'))
      await win.webContents.executeJavaScript('window.setCreditsFixture(' + JSON.stringify(analytics) + ')')
      const result = await win.webContents.executeJavaScript(${JSON.stringify(`(${exercise.toString()})()`)})
      const nativeResult = await (${exerciseNative.toString()})(win.webContents, win, usageAnalyticsWithCreditsQuery, ${JSON.stringify(screenshotDir)})
      console.log('SCRY_CREDITS_UI_RESULT=' + JSON.stringify({ ...result, ...nativeResult }))
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
