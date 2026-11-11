import { installDaemonChannelGuard } from '../daemon-channel-gate'
import { isSafeOAuthAuthorizationUrl } from '../oauth-loopback'

// Daemon mode, App side of MCP re-auth. The daemon runs the Provider's OAuth flow and
// cannot open a browser, so it hands the page to its App on the event feed. This App
// opens it only while a re-auth it sent is still running, and only a URL that passes the
// same safety check main applies in process: a feed item alone never opens a browser.

let openExternal: ((url: string) => Promise<void>) | undefined
let pending = 0

export function installMcpDaemonWindow(window: { openExternal(url: string): Promise<void> }): () => void {
  openExternal = (url) => window.openExternal(url)
  const removeGuard = installDaemonChannelGuard('agent:reauthenticateMcp', async (args) => {
    pending += 1
    let settled = false
    return { args, settled: () => { if (!settled) { settled = true; pending -= 1 } } }
  })
  return () => {
    removeGuard()
    openExternal = undefined
    pending = 0
  }
}

export function deliverDaemonOAuthUrl(url: string): void {
  if (!openExternal || pending === 0) {
    console.warn('[scry] ignored an MCP OAuth page this window did not ask for')
    return
  }
  if (!isSafeOAuthAuthorizationUrl(url)) {
    console.warn('[scry] refused an unsafe MCP OAuth page from the daemon')
    return
  }
  void openExternal(url).catch((error) => console.warn('[scry] MCP OAuth page did not open:', (error as Error)?.message ?? String(error)))
}
