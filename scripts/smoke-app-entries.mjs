import { writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

// Temporary main-process entries for the isolated smoke app. Each one surrounds the
// production main module instead of replacing it, so the shipped handlers stay in the
// measured path and the fixture only adds the observation or the injected fault.

function productionMain() {
  return JSON.stringify(pathToFileURL('out/main/index.js').href)
}

// Run production handlers without launching viewers or executing fixture programs.
// The receipt records the exact OS handoff after resolution and authorization.
export function writeFileOpenEntry(entryPath, receiptPath) {
  writeFileSync(entryPath, `
    import { shell } from 'electron'
    import { writeFileSync } from 'node:fs'
    const opened = []
    shell.openPath = async (path) => {
      opened.push(path)
      writeFileSync(${JSON.stringify(receiptPath)}, JSON.stringify(opened))
      return path.endsWith('/fail.custom') ? 'fixture: no application associated' : ''
    }
    await import(${productionMain()})
  `)
}

/** Lose one fork reply after the native effect and the durable commit. */
export function writeConversationFaultEntry(entryPath, markerPath) {
  writeFileSync(entryPath, `
    import { ipcMain } from 'electron'
    import { existsSync, writeFileSync } from 'node:fs'
    const marker = ${JSON.stringify(markerPath)}
    const handle = ipcMain.handle.bind(ipcMain)
    ipcMain.handle = (channel, listener) => handle(channel, async (...args) => {
      const result = await listener(...args)
      if (channel === 'conversation:fork' && result.fork?.status === 'accepted' && !existsSync(marker)) {
        writeFileSync(marker, 'native fork committed')
        throw new Error('fixture: native fork reply lost after commit')
      }
      return result
    })
    await import(${productionMain()})
  `)
}

/**
 * Count every trusted IPC invocation by channel into one JSON file.
 *
 * The counter is the App's own `ipcMain.handle` registration path, so a channel that is
 * registered twice or invoked in a loop shows up here. A rejected request is counted
 * too: the user-visible result of a refused read is still one round trip.
 *
 * With `windowControlPath`, the same entry also accepts fixture-only native window sizes:
 * the acceptance writes one JSON request and main applies the real `setContentSize` of the
 * isolated window. The shipped main module is imported unchanged and the renderer gains no
 * new privilege, so the measured layout is the real one.
 */
export function writeIpcCountEntry(entryPath, countsPath, windowControlPath, sideChatRequestsPath) {
  writeFileSync(entryPath, `
    import { ipcMain } from 'electron'
    import { appendFileSync, existsSync, readFileSync, renameSync, rmSync, watchFile, writeFileSync } from 'node:fs'
    const counts = {}
    const lostReply = ${JSON.stringify(lostReplyPath(countsPath))}
    const lostSendReply = ${JSON.stringify(lostSendReplyPath(countsPath))}
    const requestLog = ${JSON.stringify(sideChatRequestsPath ?? '')}
    // Publish through a rename: the acceptance reads this file while the App counts, and a
    // torn read must never look like "no channel was invoked".
    const flush = () => {
      writeFileSync(${JSON.stringify(`${countsPath}.writing`)}, JSON.stringify(counts))
      renameSync(${JSON.stringify(`${countsPath}.writing`)}, ${JSON.stringify(countsPath)})
    }
    const handle = ipcMain.handle.bind(ipcMain)
    ipcMain.handle = (channel, listener) => handle(channel, (...args) => {
      counts[channel] = (counts[channel] ?? 0) + 1
      flush()
      // The exact scope a side-chat history/paging request asked for: a navigation bug is
      // diagnosed from the identity the App really used, never from a dialog's text.
      if (requestLog && channel === 'conversation:listSideChats') {
        appendFileSync(requestLog, JSON.stringify({ channel, source: args[1]?.source ?? null,
          ids: args[1]?.ids ?? null }) + '\\n')
        // The host's own answer, so an empty dialog can be attributed to the record or to
        // the renderer instead of guessed.
        return Promise.resolve(listener(...args)).then((result) => {
          appendFileSync(requestLog, JSON.stringify({ channel, answered: { total: result?.total ?? null,
            items: result?.items?.length ?? null } }) + '\\n')
          return result
        }, (error) => {
          appendFileSync(requestLog, JSON.stringify({ channel, rejected: String(error?.message ?? error) }) + '\\n')
          throw error
        })
      }
      // The marker is written by the acceptance run. 'before-commit' models a reply lost
      // before the host created anything; 'after-commit' models one lost afterwards. Both
      // must leave the renderer in an honest state, and neither may dispatch twice.
      if (channel === 'conversation:createSideChat' && existsSync(lostReply)) {
        const mode = readFileSync(lostReply, 'utf8').trim()
        rmSync(lostReply)
        if (mode === 'before-commit') throw new Error('fixture: side-chat create reply lost before commit')
        return Promise.resolve(listener(...args)).then(() => { throw new Error('fixture: side-chat create reply lost after commit') })
      }
      // The same marker contract for one send: the host may have recorded the turn, but
      // only the reply is lost, so the durable receipt is the sole evidence afterwards.
      if (channel === 'conversation:send' && existsSync(lostSendReply)) {
        const mode = readFileSync(lostSendReply, 'utf8').trim()
        rmSync(lostSendReply)
        if (mode === 'before-commit') throw new Error('fixture: send reply lost before commit')
        return Promise.resolve(listener(...args)).then(() => { throw new Error('fixture: send reply lost after commit') })
      }
      return listener(...args)
    })
    flush()
    ${windowControlPath ? windowControlSource(windowControlPath) : ''}
    await import(${productionMain()})
  `)
}

/** Applied by the isolated main process only; the request file is written by the run. */
function windowControlSource(controlPath) {
  return `
    import { BrowserWindow } from 'electron'
    const controlPath = ${JSON.stringify(controlPath)}
    let appliedSeq = 0
    watchFile(controlPath, { interval: 40 }, () => {
      if (!existsSync(controlPath)) return
      let request
      try { request = JSON.parse(readFileSync(controlPath, 'utf8')) } catch { return }
      if (typeof request?.seq !== 'number' || request.seq === appliedSeq) return
      appliedSeq = request.seq
      const window = BrowserWindow.getAllWindows()[0]
      if (!window || window.isDestroyed()) return
      window.setContentSize(Math.round(request.width), Math.round(request.height))
      const receipt = { seq: request.seq, contentSize: window.getContentSize(), size: window.getSize(),
        minimized: window.isMinimized(), visible: window.isVisible() }
      writeFileSync(controlPath + '.receipt', JSON.stringify(receipt))
    })
  `
}

/** Marker file the acceptance run writes to lose exactly one create reply. */
export function lostReplyPath(countsPath) {
  return `${countsPath}.lost-create-reply`
}

/** Every side-chat list request the isolated main process observed, in dispatch order. */
export function sideChatRequestsPath(countsPath) {
  return `${countsPath}.side-chat-requests.jsonl`
}

/** Marker file the acceptance run writes to lose exactly one send reply. */
export function lostSendReplyPath(countsPath) {
  return `${countsPath}.lost-send-reply`
}
