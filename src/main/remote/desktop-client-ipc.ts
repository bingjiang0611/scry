import type { DesktopRemoteAPI } from '../../shared/desktop-remote'

// Deliberately enumerate business operations. Neither the renderer nor a
// remote peer can choose a raw protocol op, URL, SSH option or shell command.
const METHODS = [
  'list', 'pair', 'finishPairing', 'updateSsh', 'connect', 'disconnect', 'forget',
  'catalog', 'providerControls', 'commands', 'sessionAction', 'forkSession', 'deleteSession', 'directories', 'selectDirectory', 'history', 'trace', 'traceDelta', 'intents', 'submit', 'intentStatus', 'resolveIntent',
  'runStatus', 'liveRun', 'stop', 'answer', 'files', 'file', 'workbench'
] as const satisfies readonly (keyof DesktopRemoteAPI)[]

export function registerDesktopClientIpc<Event>(
  registerTrusted: (channel: string, listener: (event: Event, ...args: unknown[]) => unknown) => void,
  client: () => DesktopRemoteAPI
): void {
  for (const method of METHODS) {
    registerTrusted(`desktopRemote:${method}`, (_event, ...args) => {
      if (args.length > 5) throw new Error('invalid_desktop_request')
      const service = client()
      // Public service methods validate runtime arguments before accessing a
      // saved connection or performing a network write. This registration is
      // always passed the production sender/frame/origin wrapper, not ipcMain.
      return Reflect.apply(service[method], service, args)
    })
  }
}
