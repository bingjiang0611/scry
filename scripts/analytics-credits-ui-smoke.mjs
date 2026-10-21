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
const screenshotDir = process.env.SCRY_ANALYTICS_SCREENSHOTS ?? ''

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
  await waitFor(() => document.querySelector('.usage-cost-card > strong')?.textContent === '$1.41')
  check(document.querySelector('.usage-cost-card > strong').textContent === '$1.41', 'Qoder and official API equivalents missing from total')
  const qoderRow = [...document.querySelectorAll('.usage-provider-row')].find((row) => row.querySelector('b').textContent === 'Qoder')
  check(qoderRow.querySelector('.usage-provider-main > strong').textContent === '$0.15', 'Pi/native Qoder Credits not converted to USD')
  check(document.querySelector('.usage-table-wrap').textContent.includes('claude-opus-5'), 'Managed custom-provider Claude usage missing')
  const customRow = [...document.querySelectorAll('.usage-provider-row')].find((row) => row.querySelector('b').textContent === 'cc-switch')
  check(customRow?.querySelector('.usage-provider-main > strong').textContent === '<$0.01', 'Missing official Claude API estimate')
  check(!document.querySelector('.usage-table-wrap').textContent.includes('—'), 'Unknown detail placeholder is visible')
  check(document.querySelector('.usage-table-wrap [title*="官方 API 标准价换算"]'), 'Estimate provenance is missing')
  check(!document.querySelector('.usage-table-wrap').textContent.includes('unpriced-model'), 'Unknown model cost row is visible')
  check(qoderRow.querySelector('strong').title.includes('15.41 Credits') && qoderRow.querySelector('strong').title.includes('已知下界'), 'Missing partial credit evidence')
  check(!document.querySelector('.usage-overview').textContent.includes('Credits'), 'Removed Credits line is visible')
  check(!document.querySelector('.usage-footnote'), 'Removed explanation entry is visible')
  check(document.querySelectorAll('.usage-metrics dt').length === 5 && !document.querySelector('.usage-metrics small'), 'Metric hierarchy differs from approved design')
  check(![...document.querySelectorAll('.usage-provider-main b')].some(node => node.textContent === 'unknown'), 'Unknown provider row is visible')
  const groupButton = (label, value) => [...document.querySelectorAll(`[aria-label="${label}"] button`)].find((button) => button.textContent === value)
  groupButton('明细维度', '日期').click()
  await waitFor(() => document.querySelector('.usage-table-wrap thead').textContent.includes('日期'))
  check(document.querySelector('.usage-table-wrap').textContent.includes('$1.41'), 'Day breakdown lost API/Qoder equivalents')
  check(!document.querySelector('.usage-table-wrap').textContent.includes('—'), 'Unknown day placeholder is visible')
  groupButton('明细维度', '模型').click()
  await waitFor(() => document.querySelector('.usage-table-wrap thead').textContent.includes('模型'))
  check(document.querySelector('.usage-table-wrap').textContent.includes('$0.15'), 'Model breakdown lost Qoder USD equivalent')
  groupButton('趋势指标', 'TOKEN').click()
  await waitFor(() => document.querySelector('.usage-chart').getAttribute('aria-label').includes('Token'))
  const customPath = document.querySelector('.usage-chart-line.is-cc-switch')
  check(customPath && getComputedStyle(customPath).stroke !== 'none', 'Custom provider token series invisible')
  groupButton('趋势指标', '成本').click()
  await waitFor(() => document.querySelector('.usage-chart').getAttribute('aria-label').includes('成本'))
  check(document.querySelector('.usage-chart .is-qoder'), 'Qoder USD equivalent missing from cost chart')
  groupButton('分析时间范围', '30 天').click()
  await waitFor(() => document.querySelector('#fixture-status').dataset.range === '30')
  document.querySelector('[aria-label="刷新分析数据"]').click()
  await waitFor(() => document.querySelector('#fixture-status').dataset.refreshes === '1')
  for (const node of document.querySelectorAll('.usage-provider-main')) {
    check(node.scrollWidth <= node.clientWidth + 1, 'Provider amount overflows')
  }
  return { sqliteAndArchiveProjection: true, piQoderMetering: true, customClaude: true, customSeriesVisible: true, replaySupersedesRepair: true,
    usdEquivalent: true, dayAndModel: true, chartSwitch: true, refresh: true, range: true }
}

async function exerciseNative(contents, win, query, screenshotDir) {
  const check = (condition, message) => { if (!condition) throw new Error(message) }
  const read = (fn, argument) => contents.executeJavaScript(`(${fn.toString()})(${JSON.stringify(argument)})`)
  const frame = () => read(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const click = async (selector, label) => {
    const point = await read(({ selector, label }) => {
      const node = [...document.querySelectorAll(selector)].find(node => !label || node.textContent === label)
      node.scrollIntoView({ block: 'center' })
      const rect = node.getBoundingClientRect()
      return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) }
    }, { selector, label })
    contents.sendInputEvent({ type: 'mouseMove', ...point })
    contents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 })
    contents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 })
    await frame()
  }
  const key = async (keyCode) => {
    contents.sendInputEvent({ type: 'keyDown', keyCode })
    contents.sendInputEvent({ type: 'keyUp', keyCode })
    await frame()
  }
  const hover = async (index, count, focus = false) => {
    const point = await read(({ index, count }) => {
      const node = document.querySelector('.usage-chart')
      node.scrollIntoView({ block: 'center' })
      const rect = node.getBoundingClientRect()
      const grid = node.querySelector('line')
      const x = grid.x1.baseVal.value + index / (count - 1) * (grid.x2.baseVal.value - grid.x1.baseVal.value)
      return { x: Math.round(rect.x + x / node.viewBox.baseVal.width * rect.width), y: Math.round(rect.y + rect.height * 0.4) }
    }, { index, count })
    contents.sendInputEvent({ type: 'mouseMove', ...point })
    if (focus) {
      contents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 })
      contents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 })
    }
    await frame()
  }
  const tooltip = () => read(() => {
    const node = document.querySelector('.usage-chart-tooltip')
    if (!node) return null
    const rect = node.getBoundingClientRect()
    const plot = document.querySelector('.usage-chart').getBoundingClientRect()
    return { day: node.querySelector('b').textContent, text: node.textContent,
      circles: document.querySelectorAll('.usage-chart-hover circle').length,
      contained: rect.left >= plot.left && rect.right <= plot.right }
  })
  const date = day => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(new Date(`${day}T12:00:00`))
  const data = await query(7)
  await contents.executeJavaScript('window.setCreditsFixture(' + JSON.stringify(data) + ')')
  await frame()
  await hover(data.days.length - 3, data.days.length, true)
  let detail = await tooltip()
  check(detail.day === date(data.days.at(-3)), 'Pointer focus replaced hovered day with last day')
  check(detail.text.includes('$0.00') && detail.text.includes('当日无记录') && detail.circles === 1, 'Measured zero and missing day are conflated')
  check(detail.contained, 'Hover tooltip overflows plot')
  await key('Right')
  detail = await tooltip()
  check(detail.day === date(data.days.at(-2)) && detail.circles === 0 && detail.text.includes('当日无记录'), 'Arrow key lost missing-day semantics')
  await key('Home')
  detail = await tooltip()
  check(detail.day === date(data.days[0]) && detail.contained, 'Home/left-edge tooltip failed')
  await key('End')
  detail = await tooltip()
  check(detail.day === date(data.days.at(-1)) && detail.contained && detail.text.includes('已知下界'), 'End/right-edge evidence tooltip failed')
  await key('Escape')
  check(await tooltip() === null, 'Escape did not dismiss chart details')
  await hover(data.days.length - 1, data.days.length)
  contents.sendInputEvent({ type: 'mouseMove', x: 5, y: 5 })
  await frame()
  check(await tooltip() === null, 'Pointer leave did not dismiss chart details')
  await click('[aria-label="趋势指标"] button', 'TOKEN')
  check(await read(() => document.querySelector('.usage-chart').getAttribute('aria-label')) === '每日 Token 趋势', 'Native metric switch missed')
  await click('[aria-label="明细维度"] button', '日期')
  check(await read(() => document.querySelector('.usage-table-wrap thead th').textContent) === '日期', 'Native day switch missed')
  await click('[aria-label="明细维度"] button', '模型')
  await click('[aria-label="趋势指标"] button', '成本')
  await click('[aria-label="分析时间范围"] button', '90 天')
  const long = await query(90)
  await contents.executeJavaScript('window.setCreditsFixture(' + JSON.stringify(long) + ')')
  await frame()
  await hover(long.days.length - 1, long.days.length, true)
  await click('[aria-label="分析时间范围"] button', '7 天')
  await contents.executeJavaScript('window.setCreditsFixture(' + JSON.stringify(data) + ')')
  await frame()
  check(await read(() => document.querySelector('.usage-cost-card > strong').textContent) === '$1.41' && await tooltip() === null, 'Shorter range retained stale hover index')
  await click('[aria-label="刷新分析数据"]')
  check(await read(() => document.querySelector('#fixture-status').dataset.refreshes) === '2', 'Native refresh missed')
  const layouts = []
  for (const [width, theme] of [[1512, 'dark'], [1100, 'dark'], [620, 'dark'], [1512, 'light']]) {
    win.setContentSize(width, 1000)
    await read(theme => { document.documentElement.dataset.theme = theme; document.querySelector('.usage-page').scrollTop = 0 }, theme)
    contents.invalidate()
    await frame()
    const layout = await read(() => {
      const chart = document.querySelector('.usage-chart-card').getBoundingClientRect()
      const providers = document.querySelector('.usage-provider-panel').getBoundingClientRect()
      const background = getComputedStyle(document.querySelector('.usage-page')).backgroundColor
      const luminance = color => {
        const channels = color.match(/\d+/g).slice(0, 3).map(value => {
          const channel = Number(value) / 255
          return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
        })
        return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
      }
      const textLuminance = luminance(getComputedStyle(document.querySelector('.usage-metrics dt')).color)
      const backgroundLuminance = luminance(background)
      const labelContrast = (Math.max(textLuminance, backgroundLuminance) + 0.05) / (Math.min(textLuminance, backgroundLuminance) + 0.05)
      return { width: innerWidth, background, labelContrast,
        noOverflow: document.querySelector('.usage-page').scrollWidth <= innerWidth,
        chartLeft: chart.right <= providers.left, stacked: chart.bottom <= providers.top,
        smooth: [...document.querySelectorAll('.usage-chart-line')].every(path => path.getAttribute('d').includes(' C ')),
        visibleSeries: [...document.querySelectorAll('.usage-chart-line')].every(path => getComputedStyle(path).stroke !== 'none') }
    })
    check(layout.background === (theme === 'light' ? 'rgb(255, 255, 255)' : 'rgb(13, 13, 12)'), 'Theme was not applied: ' + JSON.stringify(layout))
    check(layout.labelContrast >= 4.5, 'Secondary labels fail normal-text contrast: ' + JSON.stringify(layout))
    check(layout.noOverflow && layout.smooth && layout.visibleSeries, 'Layout/curve regression: ' + JSON.stringify(layout))
    check(width > 920 ? layout.chartLeft : layout.stacked, 'Chart/provider order differs from design')
    if (screenshotDir) {
      const image = await contents.capturePage({ x: 0, y: 0, width, height: 1000 }, { stayHidden: true, stayAwake: true })
      require('node:fs').writeFileSync(require('node:path').join(screenshotDir, `usage-${width}-${theme}.png`), image.toPNG())
    }
    layouts.push({ width, theme, ...layout })
  }
  return { nativePointer: true, nativeKeyboard: true, nativeControls: true, zeroVsMissing: true, shorterRange: true, layouts }
}

try {
  if (screenshotDir) await mkdir(screenshotDir, { recursive: true })
  await Promise.all(['home', 'userData', 'sessionData', 'workspace', 'qoder/projects/project'].map((name) => mkdir(join(temp, name), { recursive: true })))
  await symlink(join(root, 'node_modules'), join(temp, 'node_modules'), 'dir')
  await bundle({ entryPoints: [join(root, 'src/main/db.ts'), join(root, 'src/main/transcript-archive.ts'), join(root, 'src/core/turn-recorder/aggregate.ts'), join(root, 'src/shared/credit-usage.ts')], outdir: temp, entryNames: '[name]', outExtension: { '.js': '.mjs' }, bundle: true, platform: 'node', format: 'esm', packages: 'external' })
  await build({
    configFile: false, root: temp, envDir: temp, logLevel: 'error', esbuild: { jsx: 'automatic' },
    resolve: { alias: { '@shared': join(root, 'src/shared') } }, define: { 'process.env.NODE_ENV': '"production"' },
    build: { outDir: temp, emptyOutDir: false, copyPublicDir: false, minify: false,
      lib: { entry: join(root, 'scripts/fixtures/analytics-credits-smoke.tsx'), formats: ['iife'], name: 'CreditsFixture', fileName: () => 'fixture.js', cssFileName: 'fixture' } }
  })
  await writeFile(join(temp, 'index.html'), '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; img-src \'self\' data:"><link rel="stylesheet" href="fixture.css"><div id="root"></div><script src="fixture.js"></script>')
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
      const { initDb, recordTurn, usageAnalyticsWithCreditsQuery } = await import('./db.mjs')
      const { upsertTraceArchiveTurn } = await import('./transcript-archive.mjs')
      const { aggregateTurnEvidence } = await import('./aggregate.mjs')
      const { creditUsageEvidence } = await import('./credit-usage.mjs')
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
      // Add a real measured-zero day only after the original deduplication/count contracts.
      const zeroDate = new Date()
      zeroDate.setDate(zeroDate.getDate() - 2)
      if (!recordTurn({ runId: 'measured-zero', sessionId, cwd, userText: 'zero fixture', providerId: 'claude',
        runtimeProvider: 'claude_sdk', billingProvider: 'anthropic',
        items: [{ id: 'zero-result', runId: 'measured-zero', kind: 'harness', stage: 'result', ts: zeroDate.toISOString(), tokensIn: 0, tokensOut: 0, costUsd: 0 }] })) throw new Error('Zero fixture write failed')
      analytics = await usageAnalyticsWithCreditsQuery(7)
      const win = new BrowserWindow({ width: 1100, height: 850, show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
      win.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('file:') }))
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
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
