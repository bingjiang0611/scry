// Manual macOS compositor acceptance; never part of background CI.
import { build } from 'vite'
import { transform } from 'esbuild'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

if (process.platform !== 'darwin' || !process.argv.includes('--foreground')) throw new Error('Requires macOS and explicit --foreground approval')
const photo = process.argv[process.argv.indexOf('--photo') + 1]
if (!process.argv.includes('--photo') || !photo) throw new Error('Supply --photo <public test JPEG>')
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const temp = mkdtempSync(join(tmpdir(), 'scry-vibrancy-'))
for (const name of ['home', 'userData']) mkdirSync(join(temp, name))
const compile = spawnSync('xcrun', ['swiftc', '-parse-as-library', join(root, 'scripts/capture-test-window.swift'), '-o', join(temp, 'capture')], { encoding: 'utf8' })
if (compile.status !== 0) throw new Error(compile.stderr)
await build({ configFile: false, root: temp, envDir: temp, logLevel: 'error', esbuild: { jsx: 'automatic' },
  define: { 'process.env.NODE_ENV': '"production"' }, resolve: { alias: { '@shared': join(root, 'src/shared') } },
  build: { outDir: temp, emptyOutDir: false, copyPublicDir: false, minify: false,
    lib: { entry: join(root, 'scripts/fixtures/lists-smoke.tsx'), formats: ['iife'], name: 'ScryMaterial', fileName: () => 'lists.js', cssFileName: 'lists' } } })
const chrome = await transform(readFileSync(join(root, 'src/main/window-chrome.ts'), 'utf8'), { loader: 'ts', format: 'cjs' })
writeFileSync(join(temp, 'chrome.cjs'), chrome.code)
writeFileSync(join(temp, 'index.html'), `<!doctype html><html data-platform="macos" data-theme="dark"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'"><link rel="stylesheet" href="lists.css"></head><body><div id="root"></div><script src="lists.js"></script></body></html>`)
const photoUrl = `data:image/jpeg;base64,${readFileSync(resolve(photo)).toString('base64')}`
const systemReduceOnly = process.argv.includes('--system-reduce-only')
const exercise = async (app, BrowserWindow, nativeTheme, temp, photoUrl, chrome, systemReduceOnly) => {
  const fs = require('node:fs')
  const { join } = require('node:path')
  const { spawn } = require('node:child_process')
  const { createInterface } = require('node:readline')
  const { once } = require('node:events')
  const server = spawn(join(temp, 'capture'), [], { stdio: ['pipe', 'pipe', 'pipe'] })
  server.stderr.pipe(process.stderr)
  const replies = createInterface({ input: server.stdout })[Symbol.asyncIterator]()
  const ready = await replies.next()
  if (ready.done || !JSON.parse(ready.value).ready) throw new Error('Owned capture helper did not start')
  const background = new BrowserWindow({ width: 1480, height: 960, x: 0, y: 0, frame: false, show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
  const window = new BrowserWindow({ width: 1280, height: 800, x: 40, y: 70, show: false, title: 'Scry material acceptance', backgroundColor: chrome.windowBackgroundColor('dark'), ...chrome.windowTitleBarOptions(), webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  const focusSink = new BrowserWindow({ width: 80, height: 60, x: 1340, y: 30, show: false, title: 'Scry material focus control', webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
  const read = code => window.webContents.executeJavaScript(code)
  const frame = async () => {
    window.webContents.invalidate()
    await read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
    await window.webContents.capturePage()
  }
  const luminance = rgb => rgb.slice(0, 3).map(value => value / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0)
  const contrast = (a, b) => (Math.max(luminance(a), luminance(b)) + .05) / (Math.min(luminance(a), luminance(b)) + .05)
  const rows = []
  const capture = async (name, points) => {
    server.stdin.write(JSON.stringify({ id: window.getMediaSourceId().split(':')[1], backgroundID: background.getMediaSourceId().split(':')[1], output: join(temp, name + '.png'), points: points.map(({ x, y }) => ({ x, y })) }) + '\n')
    const reply = await replies.next()
    if (reply.done) throw new Error('Owned capture helper closed before returning pixels')
    return JSON.parse(reply.value)
  }
  try {
    if (nativeTheme.prefersReducedTransparency !== systemReduceOnly) throw new Error('System Reduce Transparency does not match this explicit test mode')
    await background.loadURL('data:text/html,<body style="margin:0;width:100vw;height:100vh;background:black">')
    await focusSink.loadURL('data:text/html,<title>Material focus control</title>')
    await window.loadFile(join(temp, 'index.html'))
    await read("new Promise(resolve=>{const ready=()=>document.querySelector('.sidebar .sb-sesstime')?resolve():requestAnimationFrame(ready);ready()})")
    await read("document.querySelector('#list-main').classList.add('main-area')")
    background.showInactive(); window.show(); window.focus()
    if (systemReduceOnly) {
      const states = []
      for (const theme of ['dark', 'light']) {
        nativeTheme.themeSource = theme
        window.setBackgroundColor(chrome.windowBackgroundColor(theme, true))
        await read(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`)
        await frame()
        const state = await read("({matches:matchMedia('(prefers-reduced-transparency: reduce)').matches,root:getComputedStyle(document.documentElement).backgroundColor,body:getComputedStyle(document.body).backgroundColor,sidebar:getComputedStyle(document.querySelector('.sidebar')).backgroundColor})")
        if (!state.matches || [state.root,state.body,state.sidebar].some(color=>color.includes('rgba'))) throw new Error('Real system setting did not produce opaque surfaces: '+JSON.stringify(state))
        await capture('system-reduce-'+theme, [])
        states.push({ theme, ...state })
      }
      console.log(JSON.stringify({ systemReducedTransparency: states, captures: temp }))
      return
    }
    for (const theme of ['dark', 'light']) {
      nativeTheme.themeSource = theme
      window.setBackgroundColor(chrome.windowBackgroundColor(theme, true))
      await read(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`)
      for (const [backdrop, value] of [['black', '#000'], ['white', '#fff'], ['photo', photoUrl]]) {
        await background.webContents.executeJavaScript(`document.body.style.background=${JSON.stringify(backdrop === 'photo' ? `center / cover no-repeat url("${value}")` : value)}; ${backdrop === 'photo' ? `new Promise((resolve,reject)=>{const image=new Image();image.onload=resolve;image.onerror=reject;image.src=${JSON.stringify(value)}})` : 'true'}`)
        for (const focused of [true, false]) {
          if (focused) window.focus(); else focusSink.show()
          await frame()
          if (window.isFocused() !== focused) throw new Error('Native test-window focus did not settle')
          const labels = await read(`Array.from(document.querySelectorAll('.sidebar .pname,.sidebar .sb-sesstext,.sidebar .sb-sesstime')).filter(node=>node.getBoundingClientRect().width>0).map(node=>{const r=node.getBoundingClientRect(),s=getComputedStyle(node);return {x:(r.left+r.width/2)/innerWidth,y:(r.top+r.height/2)/innerHeight,color:s.color.match(/[\\d.]+/g).slice(0,3).map(Number),dim2:getComputedStyle(document.documentElement).getPropertyValue('--dim2').trim().slice(1).match(/../g).map(hex=>parseInt(hex,16)),secondary:node.matches('.sb-sesstime')}})`)
          const name = theme + '-' + backdrop + '-' + (focused ? 'active' : 'inactive')
          await capture(name, [])
          await read("window.__materialMask=document.createElement('style');window.__materialMask.textContent='.sidebar .pname,.sidebar .sb-sesstext,.sidebar .sb-sesstime{color:transparent!important}';document.head.append(window.__materialMask)")
          await frame()
          const actual = await capture(name + '-background', labels)
          if (window.isFocused() !== focused) throw new Error('Capture changed the owned window focus')
          await read("document.querySelector('.sidebar').style.background='var(--sidebar-surface)'")
          await frame()
          const baseline = await capture(name + '-baseline', labels)
          await read("document.querySelector('.sidebar').style.removeProperty('background');window.__materialMask.remove()")
          const ratios = labels.map((label, index) => ({ secondary: label.secondary, actual: contrast(label.color, actual.samples[index]), baseline: contrast(label.color, baseline.samples[index]), dim2Actual: contrast(label.dim2, actual.samples[index]), dim2Baseline: contrast(label.dim2, baseline.samples[index]), background: actual.samples[index] }))
          const row = { theme, backdrop, focused, primary: Math.min(...ratios.filter(r => !r.secondary).map(r => r.actual)), secondary: Math.min(...ratios.filter(r => r.secondary).map(r => r.dim2Actual)), caption: Math.min(...ratios.filter(r => r.secondary).map(r => r.actual)), ratios }
          rows.push(row)
          console.log(JSON.stringify({ state: name, primary: row.primary, secondary: row.secondary }))
          fs.writeFileSync(join(temp, 'results.json'), JSON.stringify(rows, null, 2))
          if (ratios.some(r => !r.secondary && r.actual < 4.5 || r.secondary && (r.actual + .000001 < r.baseline || r.dim2Actual + .000001 < r.dim2Baseline))) throw new Error('Material contrast below contract: ' + JSON.stringify(row))
        }
      }
    }
    const active = rows.find(row=>row.theme==='dark' && row.backdrop==='black' && row.focused).ratios.find(ratio=>ratio.secondary).background
    const inactive = rows.find(row=>row.theme==='dark' && row.backdrop==='black' && !row.focused).ratios.find(ratio=>ratio.secondary).background
    if (active.every((channel,index)=>channel===inactive[index])) throw new Error('Native material did not follow focus')
    window.webContents.debugger.attach('1.3')
    await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }] })
    for (const theme of ['dark', 'light']) {
      await read(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`)
      const fallback = await read("({matches:matchMedia('(prefers-reduced-transparency: reduce)').matches, background:getComputedStyle(document.querySelector('.sidebar')).backgroundColor})")
      if (!fallback.matches || fallback.background.includes('rgba')) throw new Error('Reduce Transparency did not restore an opaque sidebar: ' + JSON.stringify(fallback))
    }
    console.log(JSON.stringify({ material: rows.map(({ ratios, ...row }) => row), reducedTransparencyCss: true, captures: temp }))
  } finally {
    for (const owned of [window, background, focusSink]) if (!owned.isDestroyed()) owned.destroy()
    if (server.exitCode === null) { const closed = once(server, 'close'); server.stdin.end(); await closed }
  }
}
writeFileSync(join(temp, 'main.cjs'), `const {app,BrowserWindow,nativeTheme}=require('electron');process.on('uncaughtException',error=>{console.error(error);app.exit(1)});app.on('window-all-closed',()=>{});app.setPath('userData',${JSON.stringify(join(temp, 'userData'))});const watchdog=setTimeout(()=>{console.error('Material test watchdog expired');app.exit(1)},120000);app.whenReady().then(()=>(${exercise.toString()})(app,BrowserWindow,nativeTheme,${JSON.stringify(temp)},${JSON.stringify(photoUrl)},require('./chrome.cjs'),${JSON.stringify(systemReduceOnly)})).then(()=>{clearTimeout(watchdog);app.exit(0)},error=>{console.error(error);app.exit(1)})`)
console.log('Owned native material test directory: ' + temp)
const result = spawnSync(join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), [join(temp, 'main.cjs')], { encoding: 'utf8', env: { HOME: join(temp, 'home'), PATH: process.env.PATH, TMPDIR: tmpdir(), LANG: 'en_US.UTF-8' } })
writeFileSync(join(temp, 'process.log'), result.stdout + result.stderr)
process.stdout.write(result.stdout)
process.stderr.write(result.stderr)
if (result.status !== 0 || !result.stdout.split('\n').some(line => systemReduceOnly ? line.startsWith('{"systemReducedTransparency":') && JSON.parse(line).systemReducedTransparency.length === 2 : line.startsWith('{"material":') && JSON.parse(line).material.length === 12)) process.exitCode = 1
