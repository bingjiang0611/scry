import assert from 'node:assert/strict'

export async function connectConcurrentApp(port, child) {
  const deadline = Date.now() + 30_000
  let page
  while (!page && Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`App exited ${child.exitCode}`)
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`)
      page = (await response.json()).find(target => target.type === 'page' && target.title === 'Scry')
    } catch (error) { if (!(error instanceof TypeError)) throw error }
    if (!page) await new Promise(resolveWait => setTimeout(resolveWait, 50))
  }
  assert.ok(page, 'No Scry debug page')
  const socket = new WebSocket(page.webSocketDebuggerUrl)
  const pending = new Map()
  const trace = { complete: false, Paint: { count: 0, durationUs: 0 }, Layout: { count: 0, durationUs: 0 } }
  let resolveTracing
  const tracingDone = new Promise(ready => { resolveTracing = ready })
  let id = 0
  await new Promise((ready, reject) => { socket.onopen = ready; socket.onerror = reject })
  socket.onmessage = ({ data }) => {
    const value = JSON.parse(String(data))
    if (value.method === 'Tracing.tracingComplete') { trace.complete = true; resolveTracing() }
    if (value.method === 'Tracing.dataCollected') {
      for (const event of value.params.value) {
        if (event.ph === 'X' && Object.hasOwn(trace, event.name)) {
          trace[event.name].count++; trace[event.name].durationUs += event.dur ?? 0
        }
      }
    }
    const request = pending.get(value.id)
    if (!request) return
    pending.delete(value.id)
    if (value.error) request.reject(new Error(value.error.message))
    else request.resolve(value.result)
  }
  socket.onclose = () => { for (const request of pending.values()) request.reject(new Error('CDP closed')); pending.clear() }
  return {
    trace, tracingDone,
    send(method, params = {}) {
      const requestId = ++id
      const result = new Promise((ready, reject) => pending.set(requestId, { resolve: ready, reject }))
      socket.send(JSON.stringify({ id: requestId, method, params }))
      return result
    },
    close() { socket.close() }
  }
}
