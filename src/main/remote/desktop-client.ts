import type { DesktopRemoteAPI } from '../../shared/desktop-remote'
import { DesktopRemoteClientWorkbench } from './desktop-client-workbench'
import type { DesktopRemoteClientTransportDeps } from './desktop-client-validation'

export { DesktopRemoteClientTransportDeps } from './desktop-client-validation'

export class DesktopRemoteClient extends DesktopRemoteClientWorkbench implements DesktopRemoteAPI {
  constructor(options: { directory: string; encrypt: (value: string) => Buffer; decrypt: (value: Buffer) => string } & DesktopRemoteClientTransportDeps, deps: DesktopRemoteClientTransportDeps = {}) {
    super(options, deps)
  }
}

export { parseInvitation as parseDesktopInvitation } from './desktop-client-validation'
