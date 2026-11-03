import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import electron from 'electron'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const temp = await mkdtemp(join(tmpdir(), 'scry-typography-ui-'))
const screenshotPath = process.env.SCRY_TYPOGRAPHY_SCREENSHOT
  ? resolve(process.env.SCRY_TYPOGRAPHY_SCREENSHOT)
  : ''
const baselineMode = process.env.SCRY_TYPOGRAPHY_BASELINE === '1'

async function exercise() {
  const check = (condition, message) => { if (!condition) throw new Error(message) }
  const waitFor = async (predicate) => {
    const deadline = performance.now() + 5000
    while (!predicate()) {
      if (performance.now() > deadline) throw new Error('Typography fixture timed out')
      await new Promise(resolve => requestAnimationFrame(resolve))
    }
  }
  await waitFor(() => document.querySelector('#typography-mixed'))

  const heading = document.querySelector('#typography-heading')
  const paragraph = document.querySelector('#typography-paragraph')
  const number = document.querySelector('#typography-number')
  const truncated = document.querySelector('#typography-truncated')
  const truncateContainer = document.querySelector('[data-truncate-container]')
  const button = document.querySelector('.typography-smoke-row button')
  const mixed = document.querySelector('#typography-mixed')
  const chat = document.querySelector('#typography-chat')
  const headingStyle = getComputedStyle(heading)
  const paragraphStyle = getComputedStyle(paragraph)
  const numberStyle = getComputedStyle(number)
  const truncatedStyle = getComputedStyle(truncated)
  const mixedStyle = getComputedStyle(mixed)
  const chatStyle = getComputedStyle(chat)

  check(headingStyle.textWrap === 'balance', 'Heading is not balanced')
  check(heading.querySelectorAll('wbr').length > 0, 'Chinese heading has no BudouX break points')
  check(headingStyle.wordBreak === 'keep-all', 'Chinese heading does not preserve BudouX phrases')
  check(paragraphStyle.textWrap === 'pretty', 'Paragraph does not use pretty wrapping')
  check(numberStyle.fontVariantNumeric.includes('tabular-nums'), 'Changing number is not tabular')
  const rangeWidth = (value) => {
    number.textContent = value
    const range = document.createRange()
    range.selectNodeContents(number)
    return range.getBoundingClientRect().width
  }
  const narrowDigits = rangeWidth('11111')
  const wideDigits = rangeWidth('88888')
  number.textContent = '11111'
  check(Math.abs(narrowDigits - wideDigits) < 0.1, `Tabular digit widths differ: ${narrowDigits} vs ${wideDigits}`)
  check(getComputedStyle(button).whiteSpace === 'nowrap', 'Button label can wrap')
  check(getComputedStyle(truncateContainer).minWidth === '0px', 'Flex truncation container has no min-width: 0')
  check(truncatedStyle.overflow === 'hidden' && truncatedStyle.whiteSpace === 'nowrap' && truncatedStyle.textOverflow === 'ellipsis', 'Truncation styles are incomplete')
  check(truncated.scrollWidth > truncated.clientWidth, 'Truncation fixture is not actually cut')
  truncated.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
  check(truncated.title === truncated.textContent, 'Cut text does not expose its full value as a tooltip')
  truncated.textContent = '短标签'
  truncated.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
  check(!truncated.title, 'Uncut text keeps a truncation tooltip')
  check(mixedStyle.textAlign === 'justify', 'Chinese body text is not justified')
  check(mixedStyle.maxWidth !== 'none', 'Chinese measure is not capped to whole characters')
  check(mixedStyle.textAutospace === 'normal', 'Chinese and Latin autospace is not enabled')
  check(mixedStyle.textSpacingTrim === 'trim-start', 'Chinese opening punctuation trim is not enabled')
  check(chatStyle.overflowX === 'hidden', 'Chat exposes horizontal overflow')
  check(chatStyle.overflowY === 'auto', 'Chat no longer scrolls vertically')
  check(chatStyle.scrollbarWidth === 'none', 'Chat vertical scrollbar is visible')
  check(getComputedStyle(chat, '::-webkit-scrollbar').display === 'none', 'Chromium chat scrollbar is visible')
  chat.scrollTop = chat.scrollHeight
  check(chat.scrollTop > 0, 'Hidden chat scrollbar also disabled scrolling')

  return {
    balancedHeading: true,
    prettyParagraph: true,
    tabularNumber: true,
    truncatedTooltip: true,
    chineseMixedText: true,
    hiddenChatScrollbars: true,
    viewport: [innerWidth, innerHeight]
  }
}

try {
  await symlink(join(root, 'node_modules'), join(temp, 'node_modules'), 'dir')
  await build({
    configFile: false,
    root: temp,
    envDir: temp,
    logLevel: 'error',
    esbuild: { jsx: 'automatic' },
    resolve: { alias: { '@shared': join(root, 'src/shared') } },
    define: { 'process.env.NODE_ENV': '"production"' },
    build: {
      outDir: temp,
      emptyOutDir: false,
      copyPublicDir: false,
      minify: false,
      lib: {
        entry: join(root, 'scripts/fixtures/typography-smoke.tsx'),
        formats: ['iife'],
        name: 'TypographyFixture',
        fileName: () => 'fixture.js',
        cssFileName: 'fixture'
      }
    }
  })
  await writeFile(join(temp, 'index.html'), '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'"><link rel="stylesheet" href="fixture.css"></head><body><div id="root"></div><script src="fixture.js"></script></body></html>')
  if (screenshotPath) await mkdir(dirname(screenshotPath), { recursive: true })
  await writeFile(join(temp, 'main.cjs'), `
    const { app, BrowserWindow } = require('electron')
    const { join } = require('node:path')
    const { writeFile } = require('node:fs/promises')
    const root = ${JSON.stringify(temp)}
    require(${JSON.stringify(join(root, 'scripts/hidden-electron-windows.cjs'))})(app)
    if (process.platform === 'darwin') app.setActivationPolicy('prohibited')
    app.setPath('userData', join(root, 'userData'))
    app.setPath('sessionData', join(root, 'sessionData'))
    app.whenReady().then(async () => {
      const win = new BrowserWindow({ width: 900, height: 720, show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
      win.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('file:') }))
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      await win.loadFile(join(root, 'index.html'))
      await win.webContents.executeJavaScript(${JSON.stringify(`new Promise((resolve, reject) => {
        const deadline = performance.now() + 5000
        const wait = () => {
          if (document.querySelector('#typography-mixed')) resolve()
          else if (performance.now() > deadline) reject(new Error('Typography fixture did not render'))
          else requestAnimationFrame(wait)
        }
        wait()
      })`)})
      if (${JSON.stringify(baselineMode)}) {
        await win.webContents.executeJavaScript(${JSON.stringify(`(() => {
          document.querySelectorAll('wbr').forEach(node => node.remove())
          const style = document.createElement('style')
          style.textContent = [
            'html { text-autospace: no-autospace !important; text-spacing-trim: space-all !important; }',
            '#typography-heading { text-wrap: wrap !important; word-break: normal !important; overflow-wrap: normal !important; }',
            '#typography-paragraph { text-wrap: wrap !important; }',
            '#typography-number { font-variant-numeric: proportional-nums !important; }',
            '.typography-smoke-row button { white-space: normal !important; }',
            '[data-truncate-container] { min-width: auto !important; }',
            '[data-truncate] { overflow: visible !important; white-space: normal !important; text-overflow: clip !important; }',
            '#typography-mixed { max-inline-size: none !important; text-align: start !important; }'
          ].join('\\n')
          document.head.append(style)
        })()`)})
      }
      await win.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
      if (${JSON.stringify(screenshotPath)}) {
        const image = await win.webContents.capturePage()
        await writeFile(${JSON.stringify(screenshotPath)}, image.toPNG())
      }
      const result = ${JSON.stringify(baselineMode)}
        ? { baseline: true, viewport: await win.webContents.executeJavaScript('[innerWidth, innerHeight]') }
        : await win.webContents.executeJavaScript(${JSON.stringify(`(${exercise.toString()})()` )})
      console.log('SCRY_TYPOGRAPHY_UI_RESULT=' + JSON.stringify(result))
      app.exit(0)
    }).catch(error => { console.error(error); app.exit(1) })
  `)
  await new Promise((resolvePromise, reject) => {
    const child = spawn(electron, [join(temp, 'main.cjs'), '--disable-gpu'], {
      env: { PATH: process.env.PATH, TMPDIR: tmpdir(), HOME: join(temp, 'home') },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let output = ''
    const timer = setTimeout(() => child.kill('SIGTERM'), 30_000)
    child.stdout.on('data', chunk => { output += chunk.toString() })
    child.stderr.on('data', chunk => { output += chunk.toString() })
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      const result = output.match(/^SCRY_TYPOGRAPHY_UI_RESULT=(.+)$/m)?.[1]
      if (code !== 0 || !result) reject(new Error(`Typography fixture failed (${code ?? signal}):\n${output.slice(-8000)}`))
      else { console.log(result); resolvePromise() }
    })
  })
} finally {
  await rm(temp, { recursive: true, force: true })
}
