import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import electron from 'electron'
import { fixtureSources } from './session-capability-sources.mjs'
import { specialFixtureSources } from './session-capability-special-fixtures.mjs'
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const specialSources = specialFixtureSources()
const cacheOnly = process.argv.includes('--cache-only')
const motionTokensOnly = process.argv.includes('--motion-tokens-only')
const paneBenchOnly = process.argv.includes('--structure-pane-bench')
const structureOnly = process.argv.includes('--structure-only')
const overlaysOnly = process.argv.includes('--overlays-only')
const turnRefsOnly = process.argv.includes('--turn-refs-only')
const listsOnly = turnRefsOnly || process.argv.includes('--lists-only')
const loadingOnly = process.argv.includes('--loading-only')
const sidebarActivityOnly = process.argv.includes('--sidebar-activity-only')
const offscreen = overlaysOnly || listsOnly || loadingOnly
const selectionOnly = process.argv.includes('--selection-only')
const piCommandsOnly = process.argv.includes('--pi-commands-only')
const piPermissionOnly = process.argv.includes('--pi-permission-only')
const modelsOnly = process.argv.includes('--models-only')
const terminalsOnly = process.argv.includes('--terminals-only')
const overviewOnly = process.argv.includes('--overview-only')
const summaryOnly = process.argv.includes('--summary-only')
const questionResultOnly = process.argv.includes('--question-result-only')
const workspaceDiffOnly = process.argv.includes('--workspace-diff-only')
const performanceOnly = process.argv.includes('--performance-only')
const nativeVisibility = process.argv.includes('--native-visibility')
if (nativeVisibility && !performanceOnly) throw new Error('--native-visibility requires --performance-only and user approval to display a window')
const metaPromptsOnly = process.argv.includes('--meta-prompts-only')
const fixtures = loadingOnly ? ['loading'] : listsOnly ? ['lists'] : overlaysOnly ? ['overlays'] : structureOnly ? ['session-cache'] : paneBenchOnly ? ['structure-pane-bench'] : motionTokensOnly ? ['motion-tokens'] : piPermissionOnly ? ['pi-permission'] : workspaceDiffOnly ? ['workspace-diff'] : sidebarActivityOnly ? ['sidebar-activity'] : cacheOnly ? ['session-cache'] : metaPromptsOnly ? ['meta-prompts'] : performanceOnly ? ['llm-performance'] : summaryOnly ? ['pinned-summary-performance', 'session-capability', 'workspace-diff']
  : questionResultOnly ? ['session-capability'] : overviewOnly ? ['session-capability'] : terminalsOnly ? ['session-terminal'] : modelsOnly ? ['session-model'] : piCommandsOnly ? ['session-capability'] : selectionOnly ? ['session-selection'] : ['session-capability', 'session-selection', 'pi-permission', 'session-model', 'session-terminal', 'pinned-summary-performance', 'llm-performance', 'meta-prompts', 'session-cache', 'sidebar-activity', 'workspace-diff', 'motion-tokens']

const temp = await mkdtemp(join(tmpdir(), 'scry-capability-ui-'))
try {
  await Promise.all(['home', 'userData', 'sessionData'].map((name) => mkdir(join(temp, name))))
  for (const fixture of fixtures) await build({
    configFile: false, root: temp, envDir: temp, logLevel: 'error',
    esbuild: { jsx: 'automatic' },
    resolve: { alias: { '@shared': join(root, 'src/shared') } },
    define: { 'process.env.NODE_ENV': '"production"' },
    build: {
      outDir: temp, emptyOutDir: false, copyPublicDir: false, minify: false,
      lib: {
        entry: join(root, `scripts/fixtures/${fixture}-smoke.tsx`),
        formats: ['iife'],
        name: 'ScryRegression',
        fileName: () => `${fixture}.js`,
        cssFileName: fixture
      }
    }
  })
  if (fixtures.includes('meta-prompts')) {
    for (const [entry, name] of [[join(root, 'src/preload/index.ts'), 'meta-prompts-preload'], [join(root, 'scripts/fixtures/meta-prompts-ipc.ts'), 'meta-prompts-ipc']]) {
      await build({
        configFile: false, root: temp, envDir: temp, logLevel: 'error',
        build: {
          outDir: temp, emptyOutDir: false, copyPublicDir: false, minify: false,
          lib: { entry, formats: ['cjs'], fileName: () => `${name}.cjs` },
          rollupOptions: { external: ['electron'] }
        }
      })
    }
  }
  for (const fixture of fixtures) await writeFile(join(temp, `${fixture}.html`), `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'${['sidebar-activity', 'motion-tokens', 'session-cache', 'overlays', 'lists', 'loading'].includes(fixture) ? '; img-src data:' : ''}"><link rel="stylesheet" href="${fixture}.css"><div id="root"></div><script src="${fixture}.js"></script>`)

  await writeFile(join(temp, 'main.cjs'), `
    const { app, BrowserWindow, clipboard, ipcMain } = require('electron')
    if (!${nativeVisibility}) require(${JSON.stringify(join(root, 'scripts/hidden-electron-windows.cjs'))})(app)
    const finish = (result) => process.stdout.write('SCRY_UI_SMOKE_RESULT=' + JSON.stringify(result) + '\\n', () => app.exit(0))
    if (process.platform === 'darwin') app.setActivationPolicy('prohibited')
    app.setPath('userData', ${JSON.stringify(join(temp, 'userData'))})
    app.setPath('sessionData', ${JSON.stringify(join(temp, 'sessionData'))})
    app.whenReady().then(async () => {
      app.dock?.hide()
      const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: ${nativeVisibility}, offscreen: ${offscreen} } })
      if (${offscreen}) win.webContents.on('paint', () => {})
      win.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('file:') }))
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      const logRendererError = (event) => { if (event.level === 'error') console.error('Renderer:', event.message) }
      win.webContents.on('console-message', logRendererError)
      let diagnosticContents = win.webContents
      try {
        let result = {}, piCommands = {}
        const special = await (${specialSources.runner})({
          flags: { loading: ${loadingOnly}, lists: ${listsOnly}, overlays: ${overlaysOnly}, paneBench: ${paneBenchOnly}, motion: ${fixtures.includes('motion-tokens')}, motionOnly: ${motionTokensOnly} },
          win, sources: ${JSON.stringify(specialSources)},
          paths: ${JSON.stringify({ loading: join(temp, 'loading.html'), lists: join(temp, 'lists.html'), overlays: join(temp, 'overlays.html'), paneBench: join(temp, 'structure-pane-bench.html'), motion: join(temp, 'motion-tokens.html') })},
          screenshots: ${JSON.stringify({ loading: process.env.SCRY_LOADING_UI_SCREENSHOT ?? '', lists: process.env.SCRY_LISTS_UI_SCREENSHOT ?? '' })},
          campaign: process.argv.find(argument => argument.startsWith('--scry-lists-campaign='))?.split('=')[1],
          logRendererError, setDiagnostic: contents => { diagnosticContents = contents }
        })
        Object.assign(result, special.result)
        if (special.done) { finish(result); return }
        if (${fixtures.includes('sidebar-activity')}) {
          win.setSize(1100, 760)
          await win.loadFile(${JSON.stringify(join(temp, 'sidebar-activity.html'))})
          const exerciseSidebarActivityContinuation = ${fixtureSources.exerciseSidebarActivityContinuation}
          result.sidebarActivity = await (${fixtureSources.exerciseSidebarActivity})(win.webContents, ${JSON.stringify(process.env.SCRY_SIDEBAR_ACTIVITY_SCREENSHOT ?? '')})
          await win.loadFile(${JSON.stringify(join(temp, 'sidebar-activity.html'))})
          result.sidebarUnreadResults = await (${fixtureSources.exerciseSidebarUnreadResults})(win.webContents)
          if (${sidebarActivityOnly}) { finish(result); return }
        }
        if (${fixtures.includes('session-cache')}) {
          win.setSize(1200, 900)
          await win.loadFile(${JSON.stringify(join(temp, 'session-cache.html'))})
          if (${structureOnly}) {
            result.structure = await (${specialSources.structure})(win.webContents)
            finish(result); return
          }
          result.sessionCache = await (${fixtureSources.exerciseSessionCache})(win.webContents)
          if (${cacheOnly}) { finish(result); return }
        }
        if (${fixtures.includes('meta-prompts')}) {
          const metaWin = new BrowserWindow({ show: false, width: 1200, height: 850, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, partition: 'persist:meta-prompts-test', preload: ${JSON.stringify(join(temp, 'meta-prompts-preload.cjs'))} } })
          metaWin.webContents.on('console-message', logRendererError)
          const metaUrl = require('node:url').pathToFileURL(${JSON.stringify(join(temp, 'meta-prompts.html'))}).href
          require(${JSON.stringify(join(temp, 'meta-prompts-ipc.cjs'))}).registerMetaPromptsFixtureIpc(metaWin, metaUrl)
          metaWin.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('file:') }))
          metaWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
          diagnosticContents = metaWin.webContents
          await metaWin.loadFile(${JSON.stringify(join(temp, 'meta-prompts.html'))})
          result.metaPrompts = await (${fixtureSources.exerciseMetaPrompts})(metaWin.webContents, metaWin, clipboard, ${JSON.stringify(process.env.SCRY_META_PROMPTS_SCREENSHOT ?? '')})
          metaWin.destroy()
          diagnosticContents = win.webContents
          ipcMain.removeHandler('app:copyText')
          ipcMain.removeHandler('desktopRemote:list')
          if (${metaPromptsOnly}) {
            finish(result)
            return
          }
        }
        if (${fixtures.includes('llm-performance')}) {
          win.setSize(1000, 800)
          await win.loadFile(${JSON.stringify(join(temp, 'llm-performance.html'))})
          const llmPerformanceState = await (${fixtureSources.exerciseLlmPerformanceSetup})(win.webContents, win, ${JSON.stringify(process.env.SCRY_LLM_UI_SCREENSHOT ?? '')}, ${nativeVisibility})
          result.llmPerformance = await (${fixtureSources.exerciseLlmPerformanceFinish})(win.webContents, win, ${JSON.stringify(process.env.SCRY_LLM_UI_SCREENSHOT ?? '')}, ${nativeVisibility}, llmPerformanceState.baselineListeners)
          if (${performanceOnly}) {
            finish(result)
            return
          }
        }
        if (${fixtures.includes('workspace-diff')}) {
          await win.loadFile(${JSON.stringify(join(temp, 'workspace-diff.html'))})
          result.workspaceDiff = await (${fixtureSources.exerciseWorkspaceDiff})(win.webContents)
          if (${workspaceDiffOnly}) { finish(result); return }
        }
        if (${fixtures.includes('pinned-summary-performance')}) {
          await win.loadFile(${JSON.stringify(join(temp, 'pinned-summary-performance.html'))})
          result.summarySampling = await win.webContents.executeJavaScript(${JSON.stringify(`(${fixtureSources.exerciseSummarySampling})()`)})
          const summaryScreenshot = ${JSON.stringify(process.env.SCRY_SUMMARY_UI_SCREENSHOT ?? '')}
          if (summaryScreenshot) {
            for (const theme of ['dark', 'light']) {
              const bounds = await win.webContents.executeJavaScript(\`document.documentElement.setAttribute('data-theme', '\${theme}'); new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => {
                const { x, y, width, height } = document.querySelector('.pinned-summary-card').getBoundingClientRect()
                resolve({ x: Math.round(x), y: Math.round(y), width: Math.ceil(width), height: Math.ceil(height) })
              })))\`)
              const image = await win.webContents.capturePage(bounds)
              require('node:fs').writeFileSync(summaryScreenshot + '-' + theme + '.png', image.toPNG())
            }
          }
        }
        if (${summaryOnly}) {
          await win.loadFile(${JSON.stringify(join(temp, 'session-capability.html'))})
          Object.assign(result, await win.webContents.executeJavaScript(${JSON.stringify(`(${fixtureSources.exerciseSessionCapabilityCore})()`)}), await win.webContents.executeJavaScript(${JSON.stringify(`(${fixtureSources.exerciseSessionCapabilitySummary})()`)}), await win.webContents.executeJavaScript(${JSON.stringify(`(${fixtureSources.exerciseSessionCapabilityQuestionResult})()`)}))
          finish(result)
          return
        }
        if (${questionResultOnly}) {
          // 已回答问答块的层级检查（真实 React + 真实 CSS），只跑这一个页面。
          win.setSize(1000, 760)
          await win.loadFile(${JSON.stringify(join(temp, 'session-capability.html'))})
          Object.assign(result, await win.webContents.executeJavaScript(${JSON.stringify(`(${fixtureSources.exerciseSessionCapabilityCore})()`)}), await win.webContents.executeJavaScript(${JSON.stringify(`(${fixtureSources.exerciseSessionCapabilitySummary})()`)}), await win.webContents.executeJavaScript(${JSON.stringify(`(${fixtureSources.exerciseSessionCapabilityQuestionResult})()`)}))
          const questionShot = ${JSON.stringify(process.env.SCRY_QUESTION_RESULT_SCREENSHOT ?? '')}
          if (questionShot) {
            // 只为截图：其它 fixture 区段会被隐藏，避免浮层盖住这块。
            await win.webContents.executeJavaScript("(() => { for (const section of document.querySelectorAll('#root > *')) section.style.display = section.id === 'question-result' ? '' : 'none'; const block = document.querySelector('#question-result'); block.style.width = '820px'; document.documentElement.scrollTop = 0 })()")
            for (const theme of ['dark', 'light']) {
              const bounds = await win.webContents.executeJavaScript(\`document.documentElement.setAttribute('data-theme', '\${theme}'); new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => {
                const { x, y, width, height } = document.querySelector('#question-result').getBoundingClientRect()
                resolve({ x: Math.max(0, Math.round(x)), y: Math.max(0, Math.round(y)), width: Math.ceil(width), height: Math.ceil(height + 40) })
              })))\`)
              const image = await win.webContents.capturePage(bounds)
              require('node:fs').writeFileSync(questionShot + '-' + theme + '.png', image.toPNG())
            }
          }
          finish(result)
          return
        }
        if (!${selectionOnly || modelsOnly || terminalsOnly || piPermissionOnly}) {
          await win.loadFile(${JSON.stringify(join(temp, 'session-capability.html'))})
          if (!${piCommandsOnly || overviewOnly}) Object.assign(result, await win.webContents.executeJavaScript(${JSON.stringify(`(${fixtureSources.exerciseSessionCapabilityCore})()`)}), await win.webContents.executeJavaScript(${JSON.stringify(`(${fixtureSources.exerciseSessionCapabilitySummary})()`)}), await win.webContents.executeJavaScript(${JSON.stringify(`(${fixtureSources.exerciseSessionCapabilityQuestionResult})()`)}))
          if (!${overviewOnly}) piCommands = await (${fixtureSources.exercisePiCommands})(win.webContents)
          if (!${piCommandsOnly}) {
            await win.loadFile(${JSON.stringify(join(temp, 'session-capability.html'))})
            win.setSize(1000, 700)
            result.overviewDensity = await (${fixtureSources.exerciseOverviewDensity})(win.webContents, ${JSON.stringify(process.env.SCRY_OVERVIEW_UI_SCREENSHOT ?? '')})
          }
        }
        const selection = []
        win.setSize(1200, 900)
        for (const scenario of ${JSON.stringify(overviewOnly || piCommandsOnly || modelsOnly || terminalsOnly || piPermissionOnly ? [] : ['repeat-pending', 'late-startup-loading', 'provider-switch', 'same-provider', 'late-startup', 'rapid-switch', 'focused-event', 'new-draft', 'stale-live', 'stale-run'])}) {
          await win.loadFile(${JSON.stringify(join(temp, 'session-selection.html'))}, { query: { scenario } })
          selection.push(await (${fixtureSources.exerciseSessionSelection})(win.webContents, scenario))
        }
        const piPermissions = []
        for (const scenario of ${JSON.stringify(overviewOnly || selectionOnly || piCommandsOnly || modelsOnly || terminalsOnly ? [] : ['fresh', 'saved'])}) {
          await win.loadFile(${JSON.stringify(join(temp, 'pi-permission.html'))}, { query: { scenario } })
          piPermissions.push(await (${fixtureSources.exercisePiPermission})(win.webContents, scenario))
        }
        let sessionModels = null
        if (${!overviewOnly && !selectionOnly && !piCommandsOnly && !terminalsOnly && !piPermissionOnly}) {
          await win.loadFile(${JSON.stringify(join(temp, 'session-model.html'))})
          sessionModels = await (${fixtureSources.exerciseSessionModels})(win.webContents, ${JSON.stringify(process.env.SCRY_CAPABILITIES_UI_SCREENSHOT ?? '')})
        }
        const sessionTerminals = []
        for (const scenario of ${JSON.stringify(overviewOnly || selectionOnly || piCommandsOnly || modelsOnly || piPermissionOnly ? [] : ['restored', 'pending'])}) {
          await win.loadFile(${JSON.stringify(join(temp, 'session-terminal.html'))}, { query: { scenario } })
          sessionTerminals.push(await (${fixtureSources.exerciseSessionTerminals})(win.webContents, scenario))
        }
        finish({ ...result, ...piCommands, selection, piPermissions, sessionModels, sessionTerminals })
      } catch (error) {
        console.error(error)
        console.error('Failed fixture:', diagnosticContents.getURL())
        console.error('Fixture DOM:', await diagnosticContents.executeJavaScript('document.body?.textContent.slice(-3000)').catch(error => error.message))
        app.exit(1)
      }
    }).catch(error => { console.error(error); app.exit(1) })
  `)
  const campaignResults = []
  for (const campaign of turnRefsOnly ? ['refs'] : listsOnly ? ['structure', 'history', 'live', 'refs'] : ['all']) await new Promise((resolve, reject) => {
    const child = spawn(electron, [join(temp, 'main.cjs'), '--disable-gpu', '--disable-backgrounding-occluded-windows', ...(listsOnly ? [`--scry-lists-campaign=${campaign}`] : [])], {
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
      else { if (listsOnly) campaignResults.push(JSON.parse(result).lists); else console.log(result); resolve() }
    })
  })
  if (listsOnly) console.log(JSON.stringify({ lists: Object.assign({}, ...campaignResults) }))
} finally {
  await rm(temp, { recursive: true, force: true })
}
