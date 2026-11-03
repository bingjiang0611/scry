// Public entry point of the device-facing host controller. The device operations
// live in host-controller-surface.ts (one method per operation the paired device
// may call); this module keeps the historical import path and the exported types.
export { HostController } from './host-controller-surface'
export { HOST_RESTARTED_DETAIL } from './host-controller-routing'
export type { RemoteIntentAttachment, RemoteIntentRouting, MacRunView, MacRunSource, LiveRunRef, ToolPanelSources, HostControllerDependencies } from './host-controller-types'
export type { RemoteProjectRef, RemoteDirectoryListing, RemoteDirectoryPage, RemoteDirectoryPageQuery, RemoteProviderRef, RemoteCommandRef, RemoteCommandCatalog, RemoteCommandQuery, RemoteSessionRef, RemoteSessionPage, RemoteSessionPageQuery, RemoteHistoryTurn, RemoteHistoryQuery, RemoteHistoryPreview, RemoteHistoryVersion, RemoteHistoryTurnsPage, RemoteHistoryTurnsPageQuery } from './remote-gateway'
export type { RunOutputPage, OutputChunk } from './run-output-log'
