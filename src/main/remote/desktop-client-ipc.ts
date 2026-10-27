import type { DesktopRemoteAPI, DesktopRemoteCatalog, DesktopRemoteContext } from '../../shared/desktop-remote'

// Deliberately enumerate business operations. Neither the renderer nor a
// remote peer can choose a raw protocol op, URL, SSH option or shell command.
const METHODS = [
  'list', 'pair', 'finishPairing', 'updateSsh', 'connect', 'disconnect', 'forget',
  'catalog', 'providerControls', 'commands', 'sessionAction', 'forkSession', 'deleteSession', 'directories', 'selectDirectory', 'history', 'trace', 'traceDelta', 'intents', 'submit', 'intentStatus', 'resolveIntent',
  'runStatus', 'liveRun', 'stop', 'answer', 'files', 'file', 'workbench'
] as const satisfies readonly (keyof DesktopRemoteAPI)[]

export function registerDesktopClientIpc<Event>(
  registerTrusted: (channel: string, listener: (event: Event, ...args: unknown[]) => unknown) => void,
  client: () => DesktopRemoteAPI,
  attention?: DesktopClientAttention
): void {
  // A catalog answer and an opened session are the only remote signals the Dock
  // badge needs; both already cross this authorized boundary.
  const observed = new Set<string>(['catalog', 'history', 'trace', 'traceDelta'])
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
          if (method === 'catalog') attention.catalog(String(args[0]), value as Parameters<DesktopClientAttention['catalog']>[1])
          else attention.viewed(String(args[0]), args[1] as Parameters<DesktopClientAttention['viewed']>[1])
        } catch {
          // A cosmetic badge must never fail the business call it observed.
        }
        return value
      })
    })
  }
}

export interface DesktopClientAttention {
  catalog(connectionId: string, catalog: DesktopRemoteCatalog): void
  viewed(connectionId: string, context: DesktopRemoteContext): void
}
