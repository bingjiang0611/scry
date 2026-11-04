import type { DesktopRemoteAPI, DesktopRemoteContext } from '../../shared/desktop-remote'

// Deliberately enumerate business operations. Neither the renderer nor a
// remote peer can choose a raw protocol op, URL, SSH option or shell command.
const METHODS = [
  'list', 'pair', 'finishPairing', 'updateSsh', 'connect', 'disconnect', 'forget',
  'catalog', 'providerControls', 'commands', 'workspaceChoices', 'validateWorkspaceBranch', 'sessionAction', 'forkSession', 'deleteSession', 'directories', 'selectDirectory', 'history', 'trace', 'traceDelta', 'intents', 'submit', 'intentStatus', 'resolveIntent',
  'runStatus', 'liveRun', 'stop', 'answer', 'files', 'file', 'workbench'
] as const satisfies readonly (keyof DesktopRemoteAPI)[]

export function registerDesktopClientIpc<Event>(
  registerTrusted: (channel: string, listener: (event: Event, ...args: unknown[]) => unknown) => void,
  client: () => DesktopRemoteAPI,
  attention?: DesktopClientAttention
): void {
  // Catalog attention is projected inside the client from its connection-time
  // baseline. Opening evidence is the only renderer signal needed to clear it.
  const observed = new Set<string>(['history', 'trace', 'traceDelta'])
  for (const method of METHODS) {
    registerTrusted(`desktopRemote:${method}`, (_event, ...args) => {
      if (args.length > 5) throw new Error('invalid_desktop_request')
      const service = client()
      // Public service methods validate runtime arguments before accessing a
      // saved connection or performing a network write. This registration is
      // always passed the production sender/frame/origin wrapper, not ipcMain.
      const result = Reflect.apply(service[method], service, args)
      if (!attention || !observed.has(method) || typeof (result as Promise<unknown>)?.then !== 'function') return result
      return (result as Promise<unknown>).then((value) => {
        try {
          attention.viewed(String(args[0]), args[1] as Parameters<DesktopClientAttention['viewed']>[1])
        } catch {
          // A cosmetic badge must never fail the business call it observed.
        }
        return value
      })
    })
  }
}

export interface DesktopClientAttention {
  viewed(connectionId: string, context: DesktopRemoteContext): void
}
