import type { DesktopRemoteAPI } from '../../shared/desktop-remote'
import { DesktopRemoteClientWorkbench } from './desktop-client-workbench'

export type { DesktopRemoteClientTransportDeps } from './desktop-client-validation'

export class DesktopRemoteClient extends DesktopRemoteClientWorkbench implements DesktopRemoteAPI {}

export { parseInvitation as parseDesktopInvitation } from './desktop-client-validation'
