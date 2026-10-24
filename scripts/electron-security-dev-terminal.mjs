import assert from 'node:assert/strict'

export async function exerciseDevTerminal(smokeContext) {
  const { evaluate, workspace, canonicalWorkspace, canonicalHome } = smokeContext
    const result = await evaluate(`(async () => {
      const outputs = new Map(), exited = new Set()
      const offData = window.scry.onTerminalData(event => {
        outputs.set(event.id, (outputs.get(event.id) || '') + event.data)
        void window.scry.terminalAck(event.id, event.ownershipEpoch, new TextEncoder().encode(event.data).byteLength)
      })
      const offExit = window.scry.onTerminalExit(event => exited.add(event.id))
      const waitForOutput = async (id, marker) => {
        const deadline = Date.now() + 5000
        while (!(outputs.get(id) || '').includes(marker)) {
          if (exited.has(id) || Date.now() > deadline) throw new Error('Shell did not survive selection: ' + id)
          await new Promise(resolve => setTimeout(resolve, 20))
        }
      }
      const sessions = []
      try {
        await window.scry.setCwd(null)
        const first = await window.scry.terminalStart({ cwd: null, scopeId: 'conversation-a', cols: 80, rows: 24 })
        sessions.push(first)
        await window.scry.terminalReady(first.id, first.ownershipEpoch)
        await window.scry.setCwd(${JSON.stringify(workspace)})
        const second = await window.scry.terminalStart({ cwd: ${JSON.stringify(workspace)}, scopeId: 'conversation-b', cols: 80, rows: 24 })
        sessions.push(second)
        await window.scry.terminalReady(second.id, second.ownershipEpoch)
        // Split the marker in shell syntax so input echo cannot satisfy the assertion.
        await window.scry.terminalWrite(first.id, first.ownershipEpoch, "printf '__ALIVE_%s__:%s\\\\n' A \\\"$PWD\\\"\\r")
        await waitForOutput(first.id, '__ALIVE_A__:' + ${JSON.stringify(canonicalHome)})
        await window.scry.setCwd(null)
        await window.scry.terminalWrite(second.id, second.ownershipEpoch, "printf '__ALIVE_%s__:%s\\\\n' B \\\"$PWD\\\"\\r")
        await waitForOutput(second.id, '__ALIVE_B__:' + ${JSON.stringify(canonicalWorkspace)})
        const active = await window.scry.terminalActive()
        return { alive: sessions.every(session => active.some(item => item.id === session.id && item.pid === session.pid)),
          scopes: active.map(item => item.scopeId), exited: [...exited], retainedCwd: true }
      } finally {
        for (const session of sessions) await window.scry.terminalClose(session.id, session.ownershipEpoch)
        offData(); offExit()
      }
    })()`)
    assert.equal(result.alive, true)
    assert.deepEqual(result.scopes, ['conversation-a', 'conversation-b'])
    assert.deepEqual(result.exited, [])
    console.log(JSON.stringify({ realAppTerminalSurvival: result }))

}
