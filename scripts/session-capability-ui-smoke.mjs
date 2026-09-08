import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import electron from 'electron'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const temp = await mkdtemp(join(tmpdir(), 'scry-capability-ui-'))

// Real React DOM events in an invisible, sandboxed Electron fixture. This does not launch
// Scry's main process or preload, discover providers, touch user data, or start a CDP port.
async function exercise() {
  const text = (selector) => document.querySelector(selector)?.textContent ?? ''
  const check = (condition, message) => { if (!condition) throw new Error(message) }
  const waitFor = (predicate) => new Promise((resolve, reject) => {
    if (predicate()) return resolve()
    const observer = new MutationObserver(() => {
      if (predicate()) { clearTimeout(timer); observer.disconnect(); resolve() }
    })
    const timer = setTimeout(() => { observer.disconnect(); reject(new Error(`DOM condition timed out: ${predicate.toString()}`)) }, 5000)
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true })
  })
  const button = (scope, fragment) => {
    const node = [...document.querySelectorAll(`${scope} button`)].find((element) => element.textContent.includes(fragment))
    check(node, `Missing button ${fragment}`)
    return node
  }
  await waitFor(() => text('#pinned').includes('hsf-invoke'))
  const thinking = document.querySelector('#thinking details.thinking')
  const finalText = document.querySelector('#thinking .model-text')
  check(thinking?.open === true, 'Thinking disclosure must be expanded by default')
  check(text('#thinking').includes('思考过程'), 'Thinking disclosure label missing')
  check(parseFloat(getComputedStyle(thinking).fontSize) < parseFloat(getComputedStyle(finalText).fontSize), 'Thinking text is not visually subordinate to the final answer')
  thinking.querySelector('summary').click()
  await waitFor(() => thinking.open === false && thinking.querySelector('.think-text') == null)
  thinking.querySelector('summary').click()
  await waitFor(() => thinking.open === true && thinking.querySelector('.think-text')?.getBoundingClientRect().height > 0)

  const modelEffortTrigger = document.querySelector('#model-effort [aria-label="选择 Model 与 Effort"]')
  check(modelEffortTrigger.textContent.includes('Ultimate') && modelEffortTrigger.textContent.includes('默认'), 'Combined Model/Effort trigger lost current values')
  modelEffortTrigger.click()
  await waitFor(() => document.querySelector('#model-effort [aria-label="Model 与 Effort"]') != null)
  check(text('#model-effort').includes('Ultimate') && text('#model-effort').includes('极高'), 'Initial Model/Effort view is incomplete')
  check(document.querySelector('#model-effort [aria-label="选择 Model"]') == null, 'Model list opened before drill-in')
  document.querySelector('#model-effort .model-effort-current').click()
  await waitFor(() => document.querySelector('#model-effort [aria-label="选择 Model"]') != null)
  check(document.querySelector('#model-effort .model-effort-current') == null, 'Current Model/Effort row remained after drill-in')
  await new Promise((resolve) => setTimeout(resolve, 0))
  check(document.activeElement?.getAttribute('aria-selected') === 'true', 'Selected Model did not receive focus after drill-in')
  document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
  await new Promise((resolve) => requestAnimationFrame(() => resolve()))
  check(document.activeElement?.textContent.includes('Performance'), 'ArrowDown did not move focus to the next Model')
  document.activeElement.click()
  await waitFor(() => modelEffortTrigger.textContent.includes('Performance') && modelEffortTrigger.textContent.includes('默认'))
  button('#model-effort', '高').click()
  await waitFor(() => modelEffortTrigger.textContent.includes('Performance') && modelEffortTrigger.textContent.includes('高'))
  modelEffortTrigger.click()
  await waitFor(() => document.querySelector('#model-effort [aria-label="Model 与 Effort"]') != null)
  document.querySelector('#model-effort .model-effort-current').click()
  await waitFor(() => document.querySelector('#model-effort [aria-label="选择 Model"]') != null)
  await new Promise((resolve) => setTimeout(resolve, 0))
  check(document.activeElement?.textContent.includes('Performance'), 'Current Model did not receive focus on repeated drill-in')
  document.activeElement.click()
  await waitFor(() => modelEffortTrigger.textContent.includes('Performance') && modelEffortTrigger.textContent.includes('高'))
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await waitFor(() => document.querySelector('#model-effort [aria-label="Model 与 Effort"]') == null)

  check(button('#pinned', 'hsf-invoke').textContent.includes('×1'), 'Pinned call count missing')
  check(!text('#pinned').includes('加载推断'), 'Pinned inference suffix should stay out of the compact row')
  check(text('#overview').includes('Skill 1（含加载推断）'), 'Overview disagrees with pinned count')

  button('#pinned', 'hsf-invoke').click()
  await waitFor(() => document.querySelector('#selection').dataset.clicks === '1')
  const original = JSON.parse(text('#selection'))
  check(original.kind === 'tool' && original.tool === 'Read' && original.source === null, 'Pinned click must expose original Read, not a synthetic event')
  document.querySelector('#overview-session-tab').click()
  await waitFor(() => !document.querySelector('#overview-session-panel').hidden)
  button('#overview .panel-section', 'hsf-invoke（含加载推断）').click()
  await waitFor(() => document.querySelector('#selection').dataset.clicks === '2')
  check(text('#selection') === JSON.stringify(original), 'Overview must navigate to the same original Read')
  button('#pinned', 'browser / navigate').click()
  await waitFor(() => document.querySelector('#selection').dataset.clicks === '3')
  check(JSON.parse(text('#selection')).tool === 'mcp__browser__navigate', 'MCP navigation lost tool identity')

  const toggle = button('#pinned', 'Skills & MCP')
  const controlledDetail = () => document.getElementById(toggle.getAttribute('aria-controls'))
  toggle.click()
  await waitFor(() => toggle.getAttribute('aria-expanded') === 'false')
  check(controlledDetail()?.hidden === true, 'Collapsed detail remained exposed')
  check(getComputedStyle(controlledDetail()).display === 'none', 'Production CSS displayed a hidden detail')
  toggle.click()
  await waitFor(() => toggle.getAttribute('aria-expanded') === 'true' && controlledDetail()?.hidden === false)
  check(getComputedStyle(controlledDetail()).display === 'flex', 'Expanded detail remained visually hidden')
  toggle.click()
  await waitFor(() => toggle.getAttribute('aria-expanded') === 'false')
  const summaryToggle = document.querySelector('#chrome [data-pinned-summary-toggle]')
  const panelToggle = button('#chrome', '面板')
  summaryToggle.click()
  await waitFor(() => document.querySelector('#pinned aside') == null)
  check(summaryToggle.getAttribute('aria-pressed') === 'false', 'Persistent summary button stayed pressed after collapse')
  summaryToggle.click()
  await waitFor(() => document.querySelector('#pinned aside') != null)
  let remountedToggle = button('#pinned', 'Skills & MCP')
  check(remountedToggle.getAttribute('aria-expanded') === 'false', 'Restoring the persistent summary reset its disclosure')
  panelToggle.click()
  await waitFor(() => document.querySelector('#pinned aside') == null)
  summaryToggle.click()
  await waitFor(() => document.querySelector('#pinned aside') != null)
  remountedToggle = button('#pinned', 'Skills & MCP')
  const remountedDetail = document.getElementById(remountedToggle.getAttribute('aria-controls'))
  check(remountedToggle.getAttribute('aria-expanded') === 'false', 'Opening the summary overlay reset its disclosure')
  check(remountedDetail?.hidden === true, 'Remounted detail became visible')
  check(getComputedStyle(remountedDetail).display === 'none', 'Remounted collapsed detail is visually exposed')
  remountedToggle.click()
  await waitFor(() => remountedToggle.getAttribute('aria-expanded') === 'true')
  document.querySelector('#empty').click()
  await waitFor(() => text('#pinned').includes('尚未观测到'))
  check(!text('#pinned').includes('hsf-invoke') && !text('#pinned').includes('browser / navigate'), 'New session retained old rows')
  check(!text('#pinned').includes('Web references'), 'Known-zero Web references row remained visible')
  check(document.querySelector('#pinned [data-evidence="unknown"]').textContent === '—', 'Missing evidence became fake zero')

  document.querySelector('#pending').click()
  await waitFor(() => text('#pinned').includes('browser / navigate'))
  check(!text('#pinned').includes('hsf-invoke'), 'Pending Read counted as successful loading')
  document.querySelector('#success').click()
  await waitFor(() => text('#pinned').includes('hsf-invoke') && text('#overview').includes('Skill 1（含加载推断）'))
  check(text('#overview').includes('Skill 1（含加载推断）'), 'Late result did not update Overview')
  document.querySelector('#failed').click()
  await waitFor(() => !text('#pinned').includes('hsf-invoke'))
  check(document.querySelector('#overview [aria-label="Skill 0，无明细"]') != null, `Failed session retained successful Skill count: ${text('#overview').slice(0, 700)}`)
  document.querySelector('#multi').click()
  await waitFor(() => text('#pinned').includes('×2'))
  check(button('#pinned', 'hsf-invoke').textContent.includes('×2'), 'Cross-turn Skill count lost')
  check(button('#pinned', 'browser / navigate').textContent.includes('×2'), 'Cross-turn MCP count lost')
  check(text('#overview').includes('Skill 2（含加载推断）'), 'Multi-turn consumers disagree')
  const archiveButton = (name) => document.querySelector(`#archive-sidebar [aria-label="存档会话：${name}"]`)
  const sidebarRows = () => document.querySelectorAll('#archive-sidebar .sb-sess-row').length
  await waitFor(() => sidebarRows() === 2)
  archiveButton('归档目标').click()
  await waitFor(() => document.querySelector('#archive-sidebar .sb-proj-row.active') != null)
  await waitFor(() => archiveButton('归档目标') == null)
  check(text('#archive-status') === 'pending', 'Fixture must still be waiting on Provider catalog refresh')
  check(sidebarRows() === 1, 'Archive must remove only its target row')
  button('#archive-sidebar', '撤销').click()
  await waitFor(() => sidebarRows() === 2)
  document.querySelector('#release-catalog').click()
  await waitFor(() => text('#archive-status') === 'settled')
  check(sidebarRows() === 2, 'Late reset completion undid archive reversal')

  button('#archive-sidebar', '归档目标').click()
  await waitFor(() => document.querySelector('#archive-sidebar .sb-sess[aria-current="true"]')?.textContent.includes('归档目标'))
  archiveButton('归档目标').click()
  await waitFor(() => archiveButton('归档目标') == null)
  document.querySelector('#reject-catalog').click()
  await waitFor(() => text('#archive-status') === 'reset-failed')
  check(archiveButton('归档目标') == null, 'Provider catalog failure resurrected the archived row')
  button('#archive-sidebar', '撤销').click()
  await waitFor(() => sidebarRows() === 2)

  button('#archive-sidebar', '归档目标').click()
  await waitFor(() => document.querySelector('#archive-sidebar .sb-sess[aria-current="true"]')?.textContent.includes('归档目标'))
  archiveButton('保留会话').click()
  await waitFor(() => archiveButton('保留会话') == null)
  check(document.querySelector('#archive-sidebar .sb-sess[aria-current="true"]')?.textContent.includes('归档目标'), 'Archiving a background session changed the selected conversation')
  button('#archive-sidebar', '撤销').click()
  await waitFor(() => sidebarRows() === 2)
  return { normalizedWire: true, originalEvidenceClicks: 3, collapse: true, thinkingDisclosure: true, modelEffortPicker: true, newSession: true, lateSuccess: true, failedRead: true, multipleTurns: true, archiveWhileCatalogPending: true, archiveAfterCatalogFailure: true, archiveUndo: true, backgroundArchive: true }
}

try {
  await Promise.all(['home', 'userData', 'sessionData'].map((name) => mkdir(join(temp, name))))
  await build({
    configFile: false, root: temp, envDir: temp, logLevel: 'error',
    esbuild: { jsx: 'automatic' },
    resolve: { alias: { '@shared': join(root, 'src/shared') } },
    define: { 'process.env.NODE_ENV': '"production"' },
    build: {
      outDir: temp, emptyOutDir: false, copyPublicDir: false, minify: false,
      lib: {
        entry: join(root, 'scripts/fixtures/session-capability-smoke.tsx'),
        formats: ['iife'],
        name: 'ScryRegression',
        fileName: () => 'fixture.js',
        cssFileName: 'fixture'
      }
    }
  })
  await writeFile(join(temp, 'index.html'), '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'"><link rel="stylesheet" href="fixture.css"><div id="root"></div><script src="fixture.js"></script>')
  await writeFile(join(temp, 'main.cjs'), `
    const { app, BrowserWindow } = require('electron')
    if (process.platform === 'darwin') app.setActivationPolicy('prohibited')
    app.setPath('userData', ${JSON.stringify(join(temp, 'userData'))})
    app.setPath('sessionData', ${JSON.stringify(join(temp, 'sessionData'))})
    app.whenReady().then(async () => {
      app.dock?.hide()
      const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
      win.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('file:') }))
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      try {
        await win.loadFile(${JSON.stringify(join(temp, 'index.html'))})
        const result = await win.webContents.executeJavaScript(${JSON.stringify(`(${exercise.toString()})()` )})
        console.log('SCRY_UI_SMOKE_RESULT=' + JSON.stringify(result))
        app.exit(0)
      } catch (error) { console.error(error); app.exit(1) }
    }).catch(error => { console.error(error); app.exit(1) })
  `)
  await new Promise((resolve, reject) => {
    const child = spawn(electron, [join(temp, 'main.cjs'), '--disable-gpu'], {
      env: { PATH: process.env.PATH, TMPDIR: tmpdir(), HOME: join(temp, 'home') }, stdio: ['ignore', 'pipe', 'pipe']
    })
    let output = ''
    const timer = setTimeout(() => { child.kill('SIGTERM') }, 30_000)
    child.stdout.on('data', (chunk) => { output += chunk.toString() })
    child.stderr.on('data', (chunk) => { output += chunk.toString() })
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      const result = output.match(/^SCRY_UI_SMOKE_RESULT=(.+)$/m)?.[1]
      if (code !== 0 || !result) reject(new Error(`Hidden UI fixture failed (${code ?? signal}):\n${output.slice(-8000)}`))
      else { console.log(result); resolve() }
    })
  })
} finally {
  await rm(temp, { recursive: true, force: true })
}
