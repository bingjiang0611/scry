import { spawn } from 'node:child_process'
import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import electron from 'electron'
import { stopOwnedApp } from './owned-app-processes.mjs'

// 真实 Provider 的会话级恢复验收：run after `npm run build`.
// 与 renderer-crash-recovery-smoke 的差别是这里跑一轮真实 Agent（默认 Provider + 默认模型），
// 证明重载后回到的是这轮对话本身，而不只是工作区。
// 它不在默认 smoke 门禁里：真实轮次会消耗 Provider 额度。
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const entry = join(root, 'out/main/index.js')
await access(entry)
const temp = await mkdtemp(join(tmpdir(), 'scry-session-restore-'))

async function exercise(window, workspace, agentPattern) {
  const assert = require('node:assert/strict')
  const contents = window.webContents
  const marker = 'RESTORE_MARKER_7F3A'
  const prompt = `Reply with exactly: ${marker}`
  const storedSelection = () => contents.executeJavaScript(
    `localStorage.getItem('scry.session-selection.v1')`)
  const withTimeout = (promise, label, ms) => {
    let timer
    return Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), ms)
      })
    ]).finally(() => clearTimeout(timer))
  }
  const composerState = () => contents.executeJavaScript(`JSON.stringify({
    status: document.getElementById('composer-status')?.innerText ?? null,
    send: document.querySelector('.composer .send')?.outerHTML.slice(0, 400) ?? null,
    controls: document.querySelector('.composer-controls')?.innerText ?? null,
    body: document.body.innerText.slice(0, 1200)
  })`)
  const waitFor = async (source, label, ms = 20_000) => {
    const ok = await withTimeout(contents.executeJavaScript(`new Promise(resolve => {
      const started = performance.now()
      const deadline = ${ms}
      const check = () => {
        let value = false
        try { value = (${source})() } catch { value = false }
        if (value) return resolve(true)
        if (performance.now() - started > deadline) return resolve(false)
        requestAnimationFrame(check)
      }
      check()
    })`), label, ms + 5_000)
    assert.ok(ok, `${label} did not become true`)
  }
  const bodyText = () => contents.executeJavaScript('document.body.innerText')

  await waitFor(() => Boolean(document.querySelector('textarea[aria-label="描述任务"]')), 'composer mount', 30_000)
  // 走真实的“在项目里新建会话”路径：它会绑定工作区并把选择落盘。
  await waitFor(`() => Boolean(document.querySelector('[data-project-path=' + JSON.stringify(${JSON.stringify(workspace)}) + ']'))`,
    'workspace project listed', 30_000)
  const opened = await withTimeout(contents.executeJavaScript(`(() => {
    const head = document.querySelector('[data-project-path=' + JSON.stringify(${JSON.stringify(workspace)}) + ']')
    const row = head?.closest('.sb-proj-row')
    if (!row) return 'no-project-row'
    const button = row.querySelector('.sb-proj-new')
    if (!button) return 'no-new-chat-button'
    button.click()
    return 'clicked'
  })()`), 'open project conversation', 20_000)
  assert.equal(opened, 'clicked', `workspace project row is not usable: ${opened}`)
  await waitFor(`() => JSON.parse(localStorage.getItem('scry.session-selection.v1') || 'null')?.cwd === ${JSON.stringify(workspace)}`,
    'workspace binding persisted')

  // 这台机器上 `claude --version` 被 SIGKILL，codex/pi/opencode 都高于已验证版本线，
  // 只有 qoder 1.1.79 在 supported 区间内；仍然走 Agent picker 的真实选择路径。
  const picked = await contents.executeJavaScript(`(async () => {
    const trigger = document.querySelector('.clipick .clibtn')
    if (!trigger || trigger.disabled) return 'agent picker disabled'
    trigger.click()
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const item = [...document.querySelectorAll('.climenu .mitem')].find(node => new RegExp(${JSON.stringify(agentPattern)}, 'i').test(node.innerText))
    if (!item) return 'agent option missing: ' + (document.querySelector('.climenu')?.innerText ?? 'no menu')
    item.click()
    return 'selected:' + item.innerText.trim()
  })()`)
  assert.ok(picked.startsWith('selected:'), `agent selection failed: ${picked}`)

  const typed = await contents.executeJavaScript(`(() => {
    const textarea = document.querySelector('textarea[aria-label="描述任务"]')
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    setter.call(textarea, ${JSON.stringify(prompt)})
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    return textarea.value
  })()`)
  assert.equal(typed, prompt)
  // 输入非空后发送键才可用；仍不可用说明是本轮的阻断原因，而不是时序。
  await waitFor(() => {
    const button = document.querySelector('.composer .send')
    return Boolean(button) && button.disabled === false
  }, 'composer send enabled', 60_000).catch(async (error) => {
    throw new Error(`${error.message}; composer state: ${await composerState()}`)
  })
  await contents.executeJavaScript(`document.querySelector('.composer .send').click()`)
  // 真实 Provider：提交后输入框应被消费，随后进入运行态。
  await waitFor(`() => document.querySelector('textarea[aria-label="描述任务"]').value === ''`, 'send consumed')
  await waitFor(() => document.body.innerText.includes('运行中'), 'run started', 120_000)
  // 一轮真实回合结束：运行态消失且转写里出现本轮提示词。
  await waitFor(`() => !document.body.innerText.includes('运行中')`, 'run finished', 300_000)
  const transcript = () => contents.executeJavaScript(
    `document.querySelector('.chat-transcript')?.innerText ?? ''`)
  const emptyState = '今天想在'
  const afterRun = await bodyText()
  assert.ok(afterRun.includes(marker), `finished turn is not visible in the transcript:\n${afterRun.slice(-2000)}`)
  const transcriptBefore = await transcript()
  // 空态文案只出现在“新建会话”页；它消失才说明停在对话里，而不是停在空转写。
  assert.ok(!transcriptBefore.includes(emptyState), `run did not leave the new-conversation page:\n${transcriptBefore}`)
  // 回合结束后必须先把这一轮记成恢复点，否则崩溃重载只能回到工作区。
  // 这里等的是被测行为本身（turn:done 落盘），不是渲染时序。
  await waitFor(`() => Boolean(JSON.parse(localStorage.getItem('scry.session-selection.v1') || 'null')?.sessionId)`,
    'restore point recorded after the turn', 180_000).catch(async (error) => {
    throw new Error(`${error.message}; stored selection: ${await storedSelection()}`)
  })
  const beforeCrash = await storedSelection()
  const activeRun = await contents.executeJavaScript('window.scry.activeRun()')

  const before = contents.getOSProcessId()
  const gone = new Promise(resolve => contents.once('render-process-gone', (_event, details) => resolve(details)))
  const loaded = new Promise(resolve => contents.once('did-finish-load', resolve))
  contents.forcefullyCrashRenderer()
  await withTimeout(gone, 'renderer crash', 20_000)
  await withTimeout(loaded, 'renderer reload', 30_000)
  assert.notEqual(contents.getOSProcessId(), before, 'renderer process was not replaced')

  // 重载后：工作区与“刚刚重启过”提示应回来，且同一轮对话的转写也要回来。
  await waitFor(`() => document.body.innerText.includes(${JSON.stringify('界面进程刚刚意外重启')})`,
    'restart notice after reload', 30_000)
  const restored = await withTimeout(contents.executeJavaScript(`new Promise(resolve => {
    const started = performance.now()
    const check = () => {
      const text = document.querySelector('.chat-transcript')?.innerText ?? ''
      if (text.includes(${JSON.stringify(marker)}) && !text.includes(${JSON.stringify(emptyState)})) return resolve(true)
      if (performance.now() - started > 30_000) return resolve(false)
      requestAnimationFrame(check)
    }
    check()
  })`), 'transcript restore', 35_000).then(async (restored) => {
    const detail = {
      restored,
      storedBeforeCrash: beforeCrash,
      transcriptBefore: transcriptBefore.slice(0, 400),
      transcriptAfterReload: (await transcript()).slice(0, 400),
      activeRun
    }
    if (!restored) {
      console.error(`SESSION_RESTORE_SMOKE=failed transcript-missing ${JSON.stringify(detail)}`)
      throw new Error(`After reload the conversation did not come back (stored selection: ${beforeCrash})`)
    }
    console.log(`SESSION_RESTORE_SMOKE=passed ${JSON.stringify(detail)}`)
  })
  console.log(`stored selection after reload: ${await storedSelection()}`)
}

try {
  const workspace = join(temp, 'session-restore-workspace')
  await mkdir(workspace)
  await mkdir(join(temp, 'userData'), { recursive: true })
  // 恢复要经过已有的工作目录授权：先登记成已知项目，测到的是恢复行为而不是授权边界。
  await writeFile(join(temp, 'userData', 'recent-folders.json'), JSON.stringify([workspace]))
  await writeFile(join(temp, 'userData', 'projects.json'), JSON.stringify([{ cwd: workspace, lastOpenedAt: Date.now() }]))
  await writeFile(join(temp, 'main.cjs'), `
    const { app } = require('electron')
    require(${JSON.stringify(join(root, 'scripts/hidden-electron-windows.cjs'))})(app)
    app.setPath('userData', ${JSON.stringify(join(temp, 'userData'))})
    app.once('browser-window-created', (_event, window) => {
      window.webContents.once('did-finish-load', async () => {
        try {
          await (${exercise.toString()})(window, ${JSON.stringify(workspace)}, ${JSON.stringify(process.env.SCRY_SMOKE_AGENT ?? 'qoder')})
          app.exit(0)
        } catch (error) { console.error(error); app.exit(1) }
      })
    })
    import(${JSON.stringify(pathToFileURL(entry).href)}).catch(error => { console.error(error); app.exit(1) })
  `)
  await new Promise((resolve, reject) => {
    // HOME 必须保留真实值：Provider CLI 的登录态在用户主目录里，换成临时目录就不是真实轮次了。
    const child = spawn(electron, [join(temp, 'main.cjs'), '--disable-gpu'], {
      env: { ...process.env, TMPDIR: tmpdir(), SCRY_TEST_APP: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let output = ''
    let cleanup
    const timer = setTimeout(() => {
      cleanup = stopOwnedApp(child).then(
        () => reject(new Error(`Session restore fixture timed out; retained at ${temp}:\n${output.slice(-8000)}`)),
        error => reject(new Error(`Session restore fixture cleanup unknown; retained at ${temp}`, { cause: error }))
      )
    }, 600_000)
    child.stdout.on('data', (chunk) => { output += chunk.toString() })
    child.stderr.on('data', (chunk) => { output += chunk.toString() })
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      if (cleanup) return
      if (code !== 0 || !output.includes('SESSION_RESTORE_SMOKE=passed')) {
        reject(new Error(`Session restore fixture failed (${code ?? signal}):\n${output.slice(-8000)}`))
      } else {
        const evidence = output.split('\n').filter(line => line.startsWith('SESSION_RESTORE_SMOKE=') || line.startsWith('stored selection')).join('\n')
        console.log(`Session-level provider restore: real turn restored after renderer crash\n${evidence}`)
        resolve()
      }
    })
  })
} catch (error) {
  console.error(`Session restore fixture retained: ${temp}`)
  throw error
}
await rm(temp, { recursive: true, force: true })
