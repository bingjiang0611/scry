export async function runStructure({ driver }) {
  const { contents, read, wait, check, send, click, insert, capture, remoteShown } = driver
    const remotePanel = '#remote-right-surface-pane'
    let accept = false
    const dialogs = []
    const dialogHandler = (_event, method, params) => {
      if (method !== 'Page.javascriptDialogOpening') return
      dialogs.push(params)
      void send('Page.handleJavaScriptDialog', { accept })
    }
    await send('Page.enable')
    contents.debugger.on('message', dialogHandler)
    try {
      await read('window.structureEntries = []; window.structureNativeCalls = 0; const animate = Element.prototype.animate; Element.prototype.animate = function(frames, options) { if (this.matches(".main-content")) window.structureEntries.push(options.duration); return animate.call(this, frames, options) }; document.startViewTransition = () => { window.structureNativeCalls++; throw new Error("Native capture forbidden") }; undefined')
      for (const theme of ['light', 'dark']) {
        await read('document.documentElement.dataset.theme = ' + JSON.stringify(theme))
        await click('[data-remote-session="old-native"]')
        await wait(remoteShown, 'remote context selected')
        await wait('document.querySelector(".chat")?.textContent.includes("Remote history paragraph 79")', 'remote history loaded')
        if (await read('document.querySelector(".panel-pill:not(.summary-pill)").getAttribute("aria-pressed") !== "true"')) await click('.panel-pill:not(.summary-pill)')
        await wait('document.querySelector("#remote-right-surface-pane").getBoundingClientRect().width > 0', 'remote pane visible')
        await click(remotePanel + ' button[aria-label="添加 Surface"]')
        await click(remotePanel + ' [role=menuitem]', '文件')
        await wait(`document.querySelector('${remotePanel} [data-workspace-path="notes.txt"]') != null`, 'editable host file tree')
        await click(remotePanel + ' [data-workspace-path="notes.txt"]')
        await wait('document.querySelector("#remote-right-surface-pane textarea")?.value === "original remote file"', 'host file content')
        await click(remotePanel + ' textarea'); await insert(' unsaved remote edit')
        await wait('document.querySelector("#remote-right-surface-pane .workspace-editorbar .primary")?.disabled === false', 'dirty remote file')
        await read('Promise.allSettled(document.getAnimations().filter(a => a.id === "scry-structure" || a.id === "scry-pane").map(a => a.finished)).then(() => true)')
        const before = await read('window.structureEntries.length')
        const count = dialogs.length
        accept = false
        await click('.sb-nav .sb-navitem:first-child')
        check(dialogs.length === count + 1 && dialogs.at(-1).message.includes('远程文件'), 'Native confirmation did not precede remote navigation')
        check(await read('window.structureEntries.length') === before, 'Cancelled remote navigation started an entrance')
        check(await read(remoteShown + ' && document.querySelector("#remote-right-surface-pane textarea").value.includes("unsaved remote edit")'), 'Cancel discarded remote selection or edit')
        await capture('structure-remote-' + theme + '-cancelled')
        accept = true
        await click('.sb-nav .sb-navitem:first-child')
        await wait('document.querySelector(".usage-page") != null', 'confirmed remote navigation')
        check(await read('window.structureEntries.length') > before, 'Confirmation positive control has no page entrance')
        await capture('structure-remote-' + theme)
      }
      check(await read('window.structureNativeCalls === 0 && window.desktopRemoteFixture.localWorkspaceCalls.length === 0 && window.desktopRemoteFixture.workbenchCalls.every(call => call.request.method !== "workspaceWrite")'), 'Remote structure used native capture, local fallback or a write')
      return { remoteStructure: { themes: ['light', 'dark'], realDialogConfirmBeforeEntry: true, cancelNoTransition: true, cancelKeepsEdit: true, acceptNavigates: true, hostScopedFileTransport: true, noWriteOrLocalFallback: true } }
    } finally { contents.debugger.removeListener('message', dialogHandler) }
}
