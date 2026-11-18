import type { DaemonLocalOpTable } from './types'

// Session catalog, project list, Provider catalog and context, session history.
export const CATALOG_LOCAL_OPS: DaemonLocalOpTable = {
  'agent:listSessions': { op: 'sessionStore', method: 'listSessions', read: true },
  'agent:catalogHealth': { op: 'sessionStore', method: 'catalogHealth', read: true },
  'agent:listProjects': { op: 'projectStore', method: 'listProjects', read: true },
  'agent:recentFolders': { op: 'projectStore', method: 'recentFolders', read: true },
  'agent:detect': { op: 'providerCatalog', method: 'detect', read: true },
  'agent:detectFast': { op: 'providerCatalog', method: 'detectFast', read: true },
  'agent:providerDescriptors': { op: 'providerCatalog', method: 'providerDescriptors', read: true },
  'agent:runControls': { op: 'providerCatalog', method: 'runControls', read: true },
  // The daemon forgets the context's session and warm Provider state; main keeps the
  // badge part (workspace.ts). Not replayed after a lost reply.
  'agent:newSession': { op: 'providerContext', method: 'newSession', read: false },
  // Session history pages (B4-L4-2a). Loading persists tool content and remembers the
  // project, so the two loads are not replayed after a lost reply.
  'agent:loadSession': { op: 'sessionHistory', method: 'loadSession', read: false },
  'agent:loadSessionOlder': { op: 'sessionHistory', method: 'loadSessionOlder', read: false },
  'agent:turnTerminalEvidence': { op: 'turnEvidence', method: 'turnTerminalEvidence', read: true }
}
