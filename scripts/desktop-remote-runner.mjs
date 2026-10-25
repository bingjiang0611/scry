import { spawn } from 'node:child_process'
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { build } from 'vite'
import electron from 'electron'

export async function runDesktopRemoteSmoke({ root, temp, fixtureSource, exercise, scenarioSource, nativeUiPointer, stopOwnedApp, negativeControl, negativeMachineControl, negativeAddressControl, negativeHoverControl, negativeActivityControl, negativeWorkspaceControl, negativePromptControl, negativeSettingsControl, negativeSlashControl, negativeHistorySlashControl, negativeProviderRevisionControl, negativeVisibilityControl, negativeUnknownReceiptControl, unknownReceiptOnly, settingsOnly, parityOnly, composerHistoryOnly, lifecycleOnly, conversationNavigationOnly, openingOnly, structureOnly, measureOpening, visibilityPollingBaseline, visibilityPollingCheck, keepArtifacts }) {
  let cleanupUnknown = false
  let failed = false

try {
  await Promise.all(['home', 'userData', 'sessionData'].map((name) => mkdir(join(temp, name), { recursive: true })))
  await symlink(join(root, 'node_modules'), join(temp, 'node_modules'), 'dir')
  await writeFile(join(temp, 'fixture.tsx'), fixtureSource)
  await build({
    configFile: false, root: temp, envDir: temp, logLevel: 'error', esbuild: { jsx: 'automatic' },
    // Mutation control stays in this fixture's bundle; production files are untouched.
    plugins: negativeControl || negativeMachineControl || negativeAddressControl || negativeHoverControl || negativeActivityControl || negativeWorkspaceControl || negativePromptControl || negativeSettingsControl || negativeSlashControl || negativeHistorySlashControl || negativeProviderRevisionControl || negativeVisibilityControl ? [{ name: 'remote-negative-control', enforce: 'pre', transform(source, id) {
      if (negativeProviderRevisionControl && id.endsWith('/RemoteChatFoundation.tsx')) {
        const dependency = ', provider?.metadataRevision'
        if (!source.includes(dependency)) throw new Error('Provider metadata revision dependency not found')
        return source.replace(dependency, '')
      }
      if (negativeHistorySlashControl && id.endsWith('/ChatView.tsx')) {
        const guard = 'const slashOpen = slashRequested && !historyNavigation'
        if (!source.includes(guard)) throw new Error('history slash guard not found')
        return source.replace(guard, 'const slashOpen = slashRequested')
      }
      if (negativeSlashControl && id.endsWith('/ChatView.tsx')) {
        const heading = 'SLASH_COMMAND_COPY.heading(remoteHost, slashLoading)'
        if (!source.includes(heading)) throw new Error('slash source control not found')
        return source.replace(heading, 'SLASH_COMMAND_COPY.heading(undefined, slashLoading)')
      }
      if (negativeSettingsControl && id.endsWith('/App.tsx')) return source.replace("setSettingsTab('remote')", "setSettingsTab('appearance')")
      if (negativePromptControl && id.endsWith('/App.tsx')) {
        const target = 'const target = metaPromptTarget.current'
        if (!source.includes(target)) throw new Error('meta prompt routing control not found')
        return source.replace(target, 'const target = { view: "chat", draftKey }').replace('returnFromMetaPrompts()\n  }', 'changeView("chat")\n  }')
      }
      if (negativeWorkspaceControl && id.endsWith('/DesktopRemote.tsx')) {
        return source.replace('api.file(connectionId, context, path, offset, snapshot)', 'window.scry.workspaceReadPage({ cwd: context.cwd, path, offset, snapshot })')
      }
      if (negativeVisibilityControl && id.endsWith('/useVisibilityPolling.ts')) {
        const invalidate = '    invalidate()'
        if (!source.includes(invalidate)) throw new Error('Visibility negative control target missing')
        return source.replace(invalidate, '')
      }
      if (negativeActivityControl && id.endsWith('/useRemoteCatalogs.ts')) {
        const poll = 'then(() => {}), 3000, () => {'
        if (!source.includes(poll)) throw new Error('activity polling control not found')
        return source.replace(poll, poll.replace('3000', '86400000'))
      }
      if (negativeHoverControl && id.endsWith('/remote-location.css')) {
        const height = 'height: min(360px, 40vh);'
        if (!source.includes(height)) throw new Error('hover height control not found')
        return source.replace(height, 'height: auto;')
      }
      if (negativeAddressControl && id.endsWith('/HostsView.tsx')) {
        const save = 'await bridge().updateSsh(connection.id, ssh)'
        if (!source.includes(save)) throw new Error('address negative control not found')
        return source.replace(save, save + '; await bridge().connect(connection.id)')
      }
      if (negativeMachineControl && id.endsWith('/App.tsx')) {
        const route = 'onNewChat: useEventCallback(startNewConversation)'
        if (!source.includes(route)) throw new Error('machine routing negative control not found')
        return source.replace(route, 'onNewChat: useEventCallback(newConversation)')
      }
      if (!negativeControl || !id.endsWith('/ChatTurn.tsx')) return
      const guard = "work={remote ? { ...backgroundWork, taskStop: 'unavailable' } : backgroundWork}"
      if (!source.includes(guard)) throw new Error('negative control guard not found')
      return source.replace(guard, 'work={backgroundWork}')
    } }] : [],
    resolve: { alias: { '@shared': join(root, 'src/shared') } }, define: { 'process.env.NODE_ENV': '"production"' },
    build: { outDir: temp, emptyOutDir: false, copyPublicDir: false, minify: false,
      lib: { entry: join(temp, 'fixture.tsx'), formats: ['iife'], name: 'DesktopRemoteFixture', fileName: () => 'fixture.js', cssFileName: 'fixture' } }
  })
  await writeFile(join(temp, 'index.html'), '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; img-src data: blob:"><link rel="stylesheet" href="fixture.css"><div id="root"></div><script src="fixture.js"></script>')
  await writeFile(join(temp, 'main.cjs'), `
    const { app, BrowserWindow } = require('electron')
    const { join } = require('node:path')
    const root = ${JSON.stringify(temp)}
    if (process.platform === 'darwin') app.setActivationPolicy('prohibited')
    app.setPath('userData', join(root, 'userData'))
    app.setPath('sessionData', join(root, 'sessionData'))
    ${scenarioSource}
    app.whenReady().then(async () => {
      app.dock?.hide()
      const win = new BrowserWindow({ show: false, width: 1200, height: 900, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
      win.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('file:') }))
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      win.webContents.on('console-message', (event) => { if (event.level === 'error') console.error('Renderer:', event.message) })
      try {
        await win.loadFile(join(root, 'index.html'))
        win.webContents.debugger.attach('1.3')
        const result = await (${exercise.toString()})(win.webContents, ${nativeUiPointer.toString()}, async name => {
          await win.webContents.executeJavaScript('Promise.allSettled(document.getAnimations().filter(a => a.effect?.getComputedTiming().endTime < Infinity).map(a => a.finished)).then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))')
          require('node:fs').writeFileSync(join(root, name + '.png'), (await win.webContents.capturePage()).toPNG())
        }, { structureOnly: ${structureOnly}, parityOnly: ${parityOnly}, settingsOnly: ${settingsOnly}, lifecycleOnly: ${lifecycleOnly}, openingOnly: ${openingOnly}, measureOpening: ${measureOpening}, composerHistoryOnly: ${composerHistoryOnly}, conversationNavigationOnly: ${conversationNavigationOnly}, unknownReceiptOnly: ${unknownReceiptOnly}, negativeUnknownReceiptControl: ${negativeUnknownReceiptControl}, visibilityPollingBaseline: ${visibilityPollingBaseline}, visibilityPollingCheck: ${visibilityPollingCheck} })
        // Native input and capture have finished. Release their debugger/window
        // before exit instead of leaving the successful fixture alive on macOS.
        win.webContents.debugger.detach()
        win.destroy()
        process.stdout.write('SCRY_DESKTOP_REMOTE_UI_RESULT=' + JSON.stringify(result) + '\\n', () => { console.log('SCRY_DESKTOP_REMOTE_UI_EXIT_REQUEST'); app.exit(0) })
      } catch (error) { console.error(error); app.exit(1) }
    }).catch(error => { console.error(error); app.exit(1) })
  `)
  await new Promise((resolve, reject) => {
    const child = spawn(electron, [join(temp, 'main.cjs'), '--disable-gpu'], {
      env: { PATH: process.env.PATH, TMPDIR: tmpdir(), HOME: join(temp, 'home'), SCRY_TEST_APP: '1' }, stdio: ['ignore', 'pipe', 'pipe']
    })
    let output = ''
    const startedAt = performance.now()
    const lifecycle = { resultAtMs: null, exitRequestAtMs: null, exitAtMs: null, closeAtMs: null }
    let cleanupTimer
    const timer = setTimeout(() => {
      failed = true
      const failure = new Error(`DesktopRemote UI timed out (pid=${child.pid}, fixture=${temp}, lifecycle=${JSON.stringify(lifecycle)}):\\n${output.slice(-8000)}`)
      console.error(failure.message)
      cleanupTimer = stopOwnedApp(child).then(() => reject(failure), (error) => { cleanupUnknown = true; reject(new Error(`DesktopRemote cleanup unknown; fixture preserved: ${temp}`, { cause: error })) })
    // Includes three 3s background catalog transitions plus recorded/unknown/
    // dispatched run polls. Per-condition deadlines stay unchanged at 7s.
    }, visibilityPollingBaseline ? 75_000 : 55_000)
    child.stdout.on('data', (chunk) => {
      output += chunk.toString()
      if (lifecycle.resultAtMs === null && output.includes('SCRY_DESKTOP_REMOTE_UI_RESULT=')) lifecycle.resultAtMs = Math.round(performance.now() - startedAt)
      if (lifecycle.exitRequestAtMs === null && output.includes('SCRY_DESKTOP_REMOTE_UI_EXIT_REQUEST')) lifecycle.exitRequestAtMs = Math.round(performance.now() - startedAt)
    })
    child.stderr.on('data', (chunk) => { output += chunk.toString() })
    child.once('exit', () => { lifecycle.exitAtMs = Math.round(performance.now() - startedAt) })
    child.once('error', (error) => { clearTimeout(timer); failed = true; reject(error) })
    child.once('close', (code, signal) => {
      lifecycle.closeAtMs = Math.round(performance.now() - startedAt)
      clearTimeout(timer)
      if (cleanupTimer) return
      const result = output.match(/^SCRY_DESKTOP_REMOTE_UI_RESULT=(.+)$/m)?.[1]
      if (code !== 0 || !result) { failed = true; reject(new Error(`DesktopRemote UI smoke failed (${code ?? signal}); fixture=${temp}:\\n${output.slice(-8000)}`)) }
      else { console.log(result); if (keepArtifacts) console.log('UI artifacts: ' + temp); resolve() }
    })
  })
} catch (error) {
  failed = true
  throw error
} finally {
  if (!cleanupUnknown && !failed && !keepArtifacts) await rm(temp, { recursive: true, force: true })
}


}
