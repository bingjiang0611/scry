import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import electron from 'electron'
import { stopOwnedApp } from './owned-app-processes.mjs'

// Run after `npm run build`. Uses the real main/preload/renderer with isolated data.
// Checks effective macOS AX features, crash recovery and repeated-crash prompting.
// --native-accessibility also activates AX through macOS and reads the native tree;
// it requires Xcode command-line tools and Accessibility permission for the runner.
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const entry = join(root, 'out/main/index.js')
await access(entry)
const nativeAccessibility = process.argv.includes('--native-accessibility')
if (nativeAccessibility && process.platform !== 'darwin') throw new Error('Native AX check requires macOS')
const temp = await mkdtemp(join(tmpdir(), 'scry-renderer-crash-'))
const nativeHelper = nativeAccessibility ? join(temp, 'enable-macos-accessibility') : null

async function exercise(window, dialog, workspace, nativeHelper) {
  const assert = require('node:assert/strict')
  const { app } = require('electron')
  const contents = window.webContents
  const rendererUrl = contents.getURL()
  const workspaceName = workspace.split('/').pop()
  const withTimeout = (promise, label) => {
    let timer
    return Promise.race([
      promise,
      new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 15_000) })
    ]).finally(() => clearTimeout(timer))
  }
  // Native AX can leave this non-activating fixture occluded after renderer replacement.
  // Observe actual DOM changes: RAF may stop even when the restart notice is already rendered.
  const waitFor = async (source, label) => {
    const ok = await withTimeout(contents.executeJavaScript(`new Promise(resolve => {
      let timer
      const finish = value => { observer.disconnect(); clearTimeout(timer); resolve(value) }
      const check = () => {
        let value = false
        try { value = (${source})() } catch { value = false }
        if (value) finish(true)
      }
      const observer = new MutationObserver(check)
      observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true })
      timer = setTimeout(() => finish(false), 10_000)
      check()
    })`), label)
    assert.ok(ok, `${label} did not become true`)
  }
  const checkAccessibility = async () => {
    if (process.platform !== 'darwin') return
    if (nativeHelper) {
      await waitFor(`() => Boolean(document.querySelector('textarea'))`, 'composer before native AX read')
      window.showInactive()
      const { stdout } = await require('node:util').promisify(require('node:child_process').execFile)(nativeHelper, [String(process.pid), '描述任务'])
      console.log(stdout.trim())
      // ElectronApplication::enableScreenReaderCompleteModeAfterDelay schedules native AX
      // activation after a two-second debounce. Checking immediately only proves dispatch.
      await new Promise(resolve => setTimeout(resolve, 2100))
    }
    const features = app.getAccessibilitySupportFeatures()
    for (const feature of ['nativeAPIs', 'webContents', 'extendedProperties', 'html', 'screenReader']) {
      assert.ok(features.includes(feature), `Accessible text/controls must remain enabled: ${feature}`)
    }
    assert.equal(features.includes('inlineTextBoxes'), false,
      `Native AX activation must not restore the crashing inlineTextBoxes mode: ${features}`)
  }
  await checkAccessibility()

  const prompts = []
  dialog.showMessageBox = async (...args) => {
    prompts.push(args.at(-1).message)
    return { response: 0, checkboxChecked: false }
  }
  const crashAndAwaitReload = async (label) => {
    const before = contents.getOSProcessId()
    const gone = new Promise(resolve => contents.once('render-process-gone', (_event, details) => resolve(details)))
    const loaded = new Promise(resolve => contents.once('did-finish-load', resolve))
    contents.forcefullyCrashRenderer()
    const details = await withTimeout(gone, `${label} crash`)
    await withTimeout(loaded, `${label} reload`)
    assert.notEqual(contents.getOSProcessId(), before, `${label}: renderer process was not replaced`)
    assert.equal(contents.isCrashed(), false)
    assert.equal(contents.getURL(), rendererUrl)
    // A live React root, not just the window background colour.
    await waitFor(`() => document.getElementById('root')?.childElementCount > 0`, `${label} React mount`)
    return details
  }

  // 崩溃前先建立一个“上一棵树停在哪里”的事实：侧栏在动态 tab，工作区已绑定。
  // 这两项恰好是重载最容易丢的本地状态。
  await withTimeout(contents.executeJavaScript(`(() => {
    const tab = [...document.querySelectorAll('[role="tab"]')].find(node => node.id.endsWith('-activity'))
    if (!tab) throw new Error('sidebar activity tab not found')
    tab.click()
    return true
  })()`), 'click sidebar activity tab')
  const activityTabSelected = `() => [...document.querySelectorAll('[role="tab"]')].some(node => node.id.endsWith('-activity') && node.getAttribute('aria-selected') === 'true')`
  await waitFor(activityTabSelected, 'sidebar activity tab selected before crash')
  await withTimeout(contents.executeJavaScript(`localStorage.setItem('scry.session-selection.v1', ${JSON.stringify(JSON.stringify({ cwd: workspace, sessionId: null, providerId: 'claude' }))})`), 'seed stored selection')

  const first = await crashAndAwaitReload('first')
  assert.notEqual(first.reason, 'clean-exit')
  assert.deepEqual(prompts, [], 'First crash must reload without prompting')

  // 重载清空了整棵 React 树：tab、工作区和“刚刚重启过”都必须自己回来，
  // 否则用户看到的就是“突然跳到项目 tab + 新建会话”。
  await waitFor(activityTabSelected, 'sidebar tab restored after reload')
  await waitFor(`() => document.body.innerText.includes(${JSON.stringify('界面进程刚刚意外重启')})`,
    'restart notice after reload')
  await waitFor(`() => document.body.innerText.includes(${JSON.stringify(workspaceName)})`,
    'workspace restored after reload')
  await checkAccessibility()

  await crashAndAwaitReload('second')
  assert.deepEqual(prompts, ['界面进程反复崩溃'], 'Crash within cooldown must ask before reloading')
  console.log('SCRY_RENDERER_CRASH_RECOVERY_SMOKE=passed')
}

try {
  if (nativeHelper) {
    await promisify(execFile)('xcrun', ['swiftc', join(root, 'scripts/fixtures/enable-macos-accessibility.swift'), '-o', nativeHelper])
  }
  await mkdir(join(temp, 'home'))
  const workspace = join(temp, 'restore-probe-workspace')
  await mkdir(workspace)
  // 恢复必须经过已有的工作目录授权校验：先把这个临时目录登记成已知项目，
  // 否则 setCwd 会被 fail-closed 拒绝，测到的将是授权边界而不是恢复行为。
  await mkdir(join(temp, 'userData'), { recursive: true })
  await writeFile(join(temp, 'userData', 'recent-folders.json'), JSON.stringify([workspace]))
  await writeFile(join(temp, 'userData', 'projects.json'), JSON.stringify([{ cwd: workspace, lastOpenedAt: Date.now() }]))
  await writeFile(join(temp, 'main.cjs'), `
    const { app, dialog } = require('electron')
    if (!${nativeAccessibility}) require(${JSON.stringify(join(root, 'scripts/hidden-electron-windows.cjs'))})(app)
    app.setPath('userData', ${JSON.stringify(join(temp, 'userData'))})
    app.once('browser-window-created', (_event, window) => {
      window.webContents.once('did-finish-load', async () => {
        try {
          await (${exercise.toString()})(window, dialog, ${JSON.stringify(workspace)}, ${JSON.stringify(nativeHelper)})
          app.exit(0)
        } catch (error) {
          console.error(error)
          console.error(await window.webContents.executeJavaScript('JSON.stringify({ visibility: document.visibilityState, body: document.body.innerText.slice(-3000) })'))
          app.exit(1)
        }
      })
    })
    import(${JSON.stringify(pathToFileURL(entry).href)}).catch(error => { console.error(error); app.exit(1) })
  `)
  await new Promise((resolve, reject) => {
    const child = spawn(electron, [join(temp, 'main.cjs'), '--disable-gpu'], {
      env: { PATH: process.env.PATH, TMPDIR: tmpdir(), HOME: join(temp, 'home'), SCRY_TEST_APP: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let output = ''
    let cleanup
    const timer = setTimeout(() => {
      cleanup = stopOwnedApp(child).then(
        () => reject(new Error(`Renderer crash fixture timed out; retained at ${temp}:\n${output.slice(-8000)}`)),
        error => reject(new Error(`Renderer crash fixture cleanup unknown; retained at ${temp}`, { cause: error }))
      )
    }, 60_000)
    child.stdout.on('data', (chunk) => { output += chunk.toString() })
    child.stderr.on('data', (chunk) => { output += chunk.toString() })
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      if (cleanup) return
      if (code !== 0 || !output.includes('SCRY_RENDERER_CRASH_RECOVERY_SMOKE=passed')) {
        reject(new Error(`Renderer crash fixture failed (${code ?? signal}):\n${output.slice(-8000)}`))
      } else {
        console.log(`Renderer crash recovery: effective AX mode checked${nativeAccessibility ? ', native activation/tree checked before and after reload' : ''}; sidebar/workspace/restart notice restore; repeat crash prompts`)
        resolve()
      }
    })
  })
} catch (error) {
  console.error(`Renderer crash fixture retained: ${temp}`)
  throw error
}
await rm(temp, { recursive: true, force: true })
