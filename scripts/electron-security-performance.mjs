import assert from 'node:assert/strict'

export async function exerciseProductionPerformance(smokeContext) {
  const { evaluate, cdp, workspace, secondWorkspace } = smokeContext

    const measurement = await evaluate(`(async () => {
      const waitFor = async (read, label) => {
        const deadline = Date.now() + 10_000
        while (Date.now() < deadline) {
          const result = await read()
          if (result) return result
          await new Promise(resolve => setTimeout(resolve, 50))
        }
        throw new Error('Performance IPC timed out: ' + label)
      }
      const initial = await window.scry.llmPerformanceSummary()
      if (initial.sessions.length !== 0) throw new Error('Fresh instance invented running sessions')
      const first = await window.scry.start({ providerId: 'codex', cwd: ${JSON.stringify(workspace)}, prompt: 'llm performance smoke' })
      const second = await window.scry.start({ providerId: 'codex', cwd: ${JSON.stringify(secondWorkspace)}, prompt: 'llm performance smoke' })
      const active = await waitFor(async () => {
        const runs = await window.scry.activeRuns()
        return runs.length === 2 && runs.every(run => run.llmPerformance?.firstOutputWaitMs != null) ? runs : null
      }, 'main observer snapshots')
      const sampled = await window.scry.llmPerformanceSummary()
      if (sampled.sessions.length !== 2 || !sampled.sessions.every(session => session.outputStarted && session.providerId === 'codex'))
        throw new Error('Main registry/observer session mismatch: ' + JSON.stringify(sampled))
      // Speed comes only from the run's own per-call observation, never from the summary itself.
      const speeds = active.map(run => run.llmPerformance.apiTokensPerSecond ?? null).sort()
      if (JSON.stringify(sampled.sessions.map(session => session.tokensPerSecond ?? null).sort()) !== JSON.stringify(speeds))
        throw new Error('Main synthesized session speed: ' + JSON.stringify(sampled))
      await window.scry.focusRun(null)
      if ((await window.scry.llmPerformanceSummary()).sessions.length !== 2) throw new Error('Focus removed background runs')
      return { runIds: [first.runId, second.runId], running: sampled.sessions.length }
    })()`)
    const point = await evaluate(`(() => {
      const node = document.querySelector('.sb-navitem[title="LLM 性能"]')
      if (!node) throw new Error('Production performance entry missing')
      node.focus()
      const box = node.getBoundingClientRect()
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    })()`)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
    const modal = await evaluate(`(async () => {
      const deadline = Date.now() + 5000
      while (Date.now() < deadline) {
        const dialog = document.querySelector('.llm-perf-modal[role="dialog"]')
        if (dialog?.contains(document.activeElement) && dialog.querySelector('.llm-perf-comparison h3')?.textContent === '模型对比' && !dialog.querySelector('.llm-perf-running, .llm-perf-run') && dialog.querySelector('.llm-perf-empty')?.textContent === '还没有数据')
          return { focused: true, labelled: !!dialog.getAttribute('aria-labelledby') }
        await new Promise(requestAnimationFrame)
      }
      throw new Error('Production modal did not load real IPC history or focus')
    })()`)
    assert.deepEqual(modal, { focused: true, labelled: true })
    const terminal = await evaluate(`(async () => {
      for (const runId of ${JSON.stringify(measurement.runIds)}) await window.scry.stop(runId)
      const deadline = Date.now() + 10_000
      while (Date.now() < deadline) {
        const summary = await window.scry.llmPerformanceSummary()
        const history = await window.scry.llmPerformanceHistory()
        const dialog = document.querySelector('.llm-perf-modal')
        if (summary.sessions.length === 0 && history.rows.length === 2 && dialog?.querySelector('.llm-perf-empty')?.textContent === '还没有数据') {
          if (!history.rows.every(row => row.failed && row.performance.firstOutputWaitMs != null && row.performance.networkConfiguration && row.performance.tokenTimingSource !== 'provider_api'))
            throw new Error('Failed rounds lost evidence or fabricated API timing')
          if (dialog.querySelector('.llm-perf-mrow, .llm-perf-interval')) throw new Error('Stopped rounds were drawn as speed')
          return { historyRounds: history.rows.length, networkSources: history.rows.map(row => row.performance.networkConfiguration.source) }
        }
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      throw new Error('Live production modal did not clear stopped runs or refresh owned history: ' + JSON.stringify({
        summary: await window.scry.llmPerformanceSummary(), history: await window.scry.llmPerformanceHistory(),
        dialog: document.querySelector('.llm-perf-modal')?.textContent
      }))
    })()`)

    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    assert.equal(await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(!document.querySelector('.llm-perf-modal') && document.activeElement?.title === 'LLM 性能'))))`), true)
    console.log(JSON.stringify({ productionPerformance: { ...measurement, ...terminal }, modal }))
    cdp.close()
    return
}
