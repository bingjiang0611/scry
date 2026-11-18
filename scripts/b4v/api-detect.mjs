// What the renderer can reach through `window.scry`, and whether the S0-1 actions that
// another lane is building (restart the background service, quit Scry and the service)
// exist yet. Detection is by name over the preload surface; an explicit `--restart-api` /
// `--quit-api` path overrides it. Nothing is called just because its name looked right
// unless exactly one candidate matches.

/** Evaluated in the renderer: the preload surface as a tree of names, two levels deep. */
export const API_TREE_EXPRESSION = `(() => {
  const walk = (value, depth) => {
    const out = {}
    for (const key of Object.keys(value || {})) {
      const item = value[key]
      if (typeof item === 'function') out[key] = 'function'
      else if (item && typeof item === 'object' && depth < 2) out[key] = walk(item, depth + 1)
      else out[key] = typeof item
    }
    return out
  }
  return walk(window.scry, 0)
})()`

export function functionPaths(tree, prefix = '') {
  const paths = []
  for (const [key, value] of Object.entries(tree ?? {})) {
    const path = prefix ? `${prefix}.${key}` : key
    if (value === 'function') paths.push(path)
    else if (value && typeof value === 'object') paths.push(...functionPaths(value, path))
  }
  return paths.sort()
}

const SERVICE = /daemon|background|service|host/i
const ACTIONS = {
  // `rendererRestart` restarts the window, not the service: it has no service word.
  'restart-daemon': (path) => /restart|relaunch/i.test(path) && SERVICE.test(path),
  'quit-all': (path) => /quit|exit|shutdown/i.test(path) && (SERVICE.test(path) || /all|everything/i.test(path)),
  'daemon-status': (path) => /status|info/i.test(path) && /daemon|background|service/i.test(path),
  reconnect: (path) => /reconnect/i.test(path) && SERVICE.test(path)
}

export function findAction(paths, kind, override) {
  if (!ACTIONS[kind]) throw new Error(`unknown action kind: ${kind}`)
  if (override) return paths.includes(override) ? { status: 'found', path: override, by: 'override' } : { status: 'absent', override }
  const candidates = paths.filter(ACTIONS[kind])
  if (candidates.length === 1) return { status: 'found', path: candidates[0], by: 'name' }
  if (candidates.length === 0) return { status: 'absent' }
  return { status: 'ambiguous', candidates }
}

/** Expression that calls a detected path with no arguments and reports how it settled. */
export function callExpression(path) {
  if (!/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/.test(path)) throw new Error(`refusing to call a non-identifier path: ${path}`)
  return `Promise.resolve().then(() => window.scry.${path}()).then(
    (value) => ({ state: 'resolved', value: value === undefined ? null : value }),
    (error) => ({ state: 'rejected', error: String(error && error.message || error) }))`
}

// Leaves that would mean the renderer can name its own channel, process, or socket. Some
// short verbs are legitimate typed methods inside a namespace (`conversations.send`,
// `conversations.fork`, `desktopRemote.connect` take typed requests), so those are only
// suspicious at the top level, where a bare `send(channel, ...)` would live.
const NEVER = /^(invoke|sendSync|sendTo|sendToHost|ipc|ipcRenderer|postMessage|require|exec|execFile|spawn|createConnection|socket|localOp|forward|rawRequest)$/i
const TOP_LEVEL = /^(send|emit|fork|connect|request|on|once)$/i

export function genericChannelLeaks(paths) {
  return paths.filter((path) => {
    const parts = path.split('.')
    const leaf = parts[parts.length - 1]
    return NEVER.test(leaf) || (parts.length === 1 && TOP_LEVEL.test(leaf))
  })
}

/** The preload surface must be the same with the switch on and off. */
export function surfaceDifference(daemonPaths, controlPaths) {
  const control = new Set(controlPaths)
  const daemon = new Set(daemonPaths)
  return {
    onlyInDaemon: daemonPaths.filter((path) => !control.has(path)),
    onlyInControl: controlPaths.filter((path) => !daemon.has(path))
  }
}
