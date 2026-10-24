import { createServer } from 'node:net'

export async function freePort() {
  const server = createServer()
  await new Promise((resolveReady, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolveReady))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise((resolveClose) => server.close(resolveClose))
  return port
}

export async function waitForTarget(port, getChild = () => undefined, timeoutMs = 30_000, getStderr = () => '') {
  let lastTargets = []
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json())
      lastTargets = targets.map(({ type, title, url }) => ({ type, title, url }))
      // A file: target is published before Electron finishes creating its sandbox/preload
      // context. Do not enable Runtime/evaluate in that startup window. The static document
      // title is parsed after preload initialization; missing/broken preload still fails the
      // unchanged window.scry assertions below (both initial launch and cold restart).
      const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl && target.title === 'Scry')
      if (page) return { page, targets }
    } catch {
      // Electron may still be initializing.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100))
  }
  throw new Error(`等待 Electron CDP target 超时；targets=${JSON.stringify(lastTargets)}；child=${JSON.stringify({ pid: getChild()?.pid, exitCode: getChild()?.exitCode, signalCode: getChild()?.signalCode })}\n${getStderr().slice(-4000)}`)
}

export function connectCdp(url) {
  const socket = new WebSocket(url)
  const pending = new Map()
  let nextId = 1
  const rejectPending = (message) => {
    for (const request of pending.values()) request.reject(new Error(message))
    pending.clear()
  }
  socket.onmessage = (message) => {
    const payload = JSON.parse(String(message.data))
    if (!payload.id) return
    const request = pending.get(payload.id)
    if (!request) return
    pending.delete(payload.id)
    if (payload.error) request.reject(new Error(payload.error.message))
    else request.resolve(payload.result)
  }
  const ready = new Promise((resolveReady, reject) => {
    socket.onopen = resolveReady
    socket.onerror = () => reject(new Error('CDP WebSocket 连接失败'))
  })
  socket.onclose = () => rejectPending('CDP WebSocket 已关闭')
  return {
    async send(method, params = {}) {
      await ready
      const id = nextId++
      const result = new Promise((resolveResult, reject) => pending.set(id, { resolve: resolveResult, reject }))
      socket.send(JSON.stringify({ id, method, params }))
      return result
    },
    close() { socket.close() }
  }
}
