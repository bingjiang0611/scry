// Direct LAN/overlay route for paired phones: on by default whenever the remote
// host runs, SCRY_REMOTE_LAN=0 turns it off, SCRY_REMOTE_LAN_PORT pins a port.
// It serves the same inner mTLS as the relay; nothing is reachable without a
// granted device certificate.
export function remoteLanConfig(env: NodeJS.ProcessEnv): { lan?: { port?: number } } {
  if (env.SCRY_REMOTE_LAN === '0') return {}
  const raw = env.SCRY_REMOTE_LAN_PORT
  const port = raw === undefined ? undefined : Number(raw)
  if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65_535)) {
    console.warn('[scry] ignoring invalid SCRY_REMOTE_LAN_PORT')
    return { lan: {} }
  }
  return { lan: port === undefined ? {} : { port } }
}
