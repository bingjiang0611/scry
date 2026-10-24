import assert from 'node:assert/strict'

export async function exerciseTerminalCore(smokeContext) {
  const { evaluate, cdp, canonicalWorkspace, canonicalHome, workspace, stderr } = smokeContext
  const terminalSmoke = await evaluate(`(async () => {
    const probe = (cwd, marker) => new Promise((resolve) => {
      let output = ''
      let session = null
      let settled = false
      let offData = () => {}
      let offExit = () => {}
      const finish = async (result, close = false) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        if (!result.ok || close) {
          offData()
          offExit()
        }
        if (close && session) await window.scry.terminalClose(session.id, session.ownershipEpoch).catch(() => {})
        resolve(result)
      }
      const timeout = setTimeout(() => void finish({ ok: false, error: 'timeout', output }, true), 12_000)
      void (async () => {
        try {
          offData = window.scry.onTerminalData((event) => {
            if (event.id !== session?.id) return
            void window.scry.terminalAck(event.id, event.ownershipEpoch, new TextEncoder().encode(event.data).byteLength)
            output += event.data
            const markerIndex = output.indexOf(marker + ':')
            if (markerIndex >= 0 && output.indexOf(String.fromCharCode(10), markerIndex) >= 0) {
              void finish({ ok: true, id: session.id, ownershipEpoch: session.ownershipEpoch, cwd: session.cwd, output })
            }
          })
          offExit = window.scry.onTerminalExit((event) => {
            if (event.id === session?.id && !output.includes(marker + ':')) {
              void finish({ ok: false, error: 'early-exit', event, output })
            }
          })
          session = await window.scry.terminalStart({ cwd, cols: 80, rows: 24 })
          await window.scry.terminalReady(session.id, session.ownershipEpoch)
          await window.scry.terminalResize(session.id, session.ownershipEpoch, 100, 30)
          const slash = String.fromCharCode(92)
          const encodedMarker = slash + '137' + slash + '137' + marker.slice(2)
          await window.scry.terminalWrite(
            session.id,
            session.ownershipEpoch,
            "printf '" + encodedMarker + ":'; pwd -P" + String.fromCharCode(13)
          )
        } catch (error) {
          await finish({ ok: false, error: String(error), output }, true)
        }
      })()
    })
    const waitForExit = (id) => new Promise((resolve) => {
      let settled = false
      let timer = 0
      let off = () => {}
      const finish = (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        off()
        resolve(value)
      }
      off = window.scry.onTerminalExit((event) => {
        if (event.id === id) finish(true)
      })
      timer = setTimeout(() => finish(false), 2_000)
    })

    await window.scry.setCwd(null)
    const unbound = await probe(null, '__SCRY_TERMINAL_HOME_OK__')
    const unboundExit = waitForExit(unbound.id)
    await window.scry.setCwd(${JSON.stringify(workspace)})
    const unboundAlive = (await window.scry.terminalActive()).some(session => session.id === unbound.id)
    await window.scry.terminalWrite(unbound.id, unbound.ownershipEpoch, 'exit' + String.fromCharCode(13))
    const unboundExited = await unboundExit
    const oldWriteRejected = await window.scry.terminalWrite(
      unbound.id, unbound.ownershipEpoch, 'pwd' + String.fromCharCode(13)
    ) === false
    const bound = await probe(${JSON.stringify(workspace)}, '__SCRY_TERMINAL_WORKSPACE_OK__')
    const activeBeforeAttach = (await window.scry.terminalActive()).some((session) => session.id === bound.id)
    const adopted = await window.scry.terminalAttach(bound.id)
    let replay = ''
    let offset = 0
    while (offset < adopted.catchUp.endOffset) {
      const page = await window.scry.terminalRecordingRead({
        id: bound.id,
        offset,
        limit: Math.max(4, Math.min(64 * 1024, adopted.catchUp.endOffset - offset))
      })
      replay += page.data
      if (page.nextOffset <= offset) throw new Error('terminal catch-up cursor stalled')
      offset = page.nextOffset
    }
    const staleWriteRejected = await window.scry.terminalWrite(
      bound.id, bound.ownershipEpoch, 'stale-owner'
    ) === false
    const adoptedReady = await window.scry.terminalReady(bound.id, adopted.ownershipEpoch)
    return { unbound, unboundAlive, unboundExited, oldWriteRejected, bound, activeBeforeAttach, adopted, adoptedReady, staleWriteRejected, replay }
  })()`)
  assert.equal(terminalSmoke.unbound.ok, true, `packaged unbound PTY smoke failed: ${JSON.stringify(terminalSmoke)}\n${stderr.slice(-4000)}`)
  assert.equal(terminalSmoke.unbound.cwd, canonicalHome)
  assert.ok(terminalSmoke.unbound.output.includes(`__SCRY_TERMINAL_HOME_OK__:${canonicalHome}`))
  assert.equal(terminalSmoke.unboundAlive, true, JSON.stringify(terminalSmoke))
  assert.equal(terminalSmoke.unboundExited, true, JSON.stringify(terminalSmoke))
  assert.equal(terminalSmoke.oldWriteRejected, true)
  assert.equal(terminalSmoke.bound.ok, true, `packaged bound PTY smoke failed: ${JSON.stringify(terminalSmoke)}\n${stderr.slice(-4000)}`)
  assert.equal(terminalSmoke.bound.cwd, canonicalWorkspace)
  assert.ok(terminalSmoke.bound.output.includes(`__SCRY_TERMINAL_WORKSPACE_OK__:${canonicalWorkspace}`))
  assert.equal(terminalSmoke.activeBeforeAttach, true)
  assert.ok(terminalSmoke.adopted.ownershipEpoch > terminalSmoke.bound.ownershipEpoch)
  assert.equal(terminalSmoke.adopted.catchUp.state, 'available')
  assert.equal(terminalSmoke.adoptedReady, true)
  assert.equal(terminalSmoke.staleWriteRejected, true)
  assert.ok(terminalSmoke.replay.includes(`__SCRY_TERMINAL_WORKSPACE_OK__:${canonicalWorkspace}`))

  await cdp.send('Page.enable')
  await cdp.send('Page.reload', { ignoreCache: true })
  const reloadDeadline = Date.now() + 15_000
  let activeAfterReload = false
  while (Date.now() < reloadDeadline && !activeAfterReload) {
    try {
      activeAfterReload = await evaluate(`(async () => {
        if (!window.scry?.terminalActive) return false
        return (await window.scry.terminalActive()).some((session) => session.id === ${JSON.stringify(terminalSmoke.bound.id)})
      })()`)
    } catch {
      // The old execution context is expected to disappear during reload.
    }
    if (!activeAfterReload) await new Promise((resolveWait) => setTimeout(resolveWait, 100))
  }
  assert.equal(activeAfterReload, true, 'renderer reload terminated the active PTY')
  const reloadAdoption = await evaluate(`(async () => {
    const id = ${JSON.stringify(terminalSmoke.bound.id)}
    const staleEpoch = ${JSON.stringify(terminalSmoke.adopted.ownershipEpoch)}
    const adopted = await window.scry.terminalAttach(id)
    let replay = ''
    let offset = 0
    while (offset < adopted.catchUp.endOffset) {
      const page = await window.scry.terminalRecordingRead({ id, offset, limit: Math.max(4, Math.min(64 * 1024, adopted.catchUp.endOffset - offset)) })
      replay += page.data
      if (page.nextOffset <= offset) throw new Error('renderer reload catch-up cursor stalled')
      offset = page.nextOffset
    }
    const staleWriteRejected = await window.scry.terminalWrite(id, staleEpoch, 'stale-after-reload') === false
    const ready = await window.scry.terminalReady(id, adopted.ownershipEpoch)
    const closed = await window.scry.terminalClose(id, adopted.ownershipEpoch)
    return { adopted, replay, staleWriteRejected, ready, closed }
  })()`)
  assert.ok(reloadAdoption.adopted.ownershipEpoch > terminalSmoke.adopted.ownershipEpoch)
  assert.equal(reloadAdoption.staleWriteRejected, true)
  assert.equal(reloadAdoption.ready, true)
  assert.equal(reloadAdoption.closed, true)
  assert.ok(reloadAdoption.replay.includes(`__SCRY_TERMINAL_WORKSPACE_OK__:${canonicalWorkspace}`))

  return { terminalSmoke, reloadAdoption, activeAfterReload }
}
