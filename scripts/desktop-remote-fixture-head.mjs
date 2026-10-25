import { join } from 'node:path'

export function desktopRemoteFixtureHead(context) {
  const { root, unknownReceiptOnly, structureOnly, openingOnly, measureOpening, composerHistoryOnly, lifecycleOnly, conversationNavigationOnly, visibilityPollingCheck, visibilityPollingBaseline, negativeUnknownReceiptControl } = context
  return `
import { createRoot } from 'react-dom/client'
import { useRef, useState } from 'react'
import { RemoteHostPanel } from ${JSON.stringify(join(root, 'src/renderer/components/DesktopRemote.tsx'))}
import { RemotePairing } from ${JSON.stringify(join(root, 'src/renderer/components/RemotePairing.tsx'))}
import { RemoteChat, remoteDraftKey } from ${JSON.stringify(join(root, 'src/renderer/components/RemoteChat.tsx'))}
import { App } from ${JSON.stringify(join(root, 'src/renderer/App.tsx'))}
import { refreshRemoteCatalog, useConnectedCatalogLoader } from ${JSON.stringify(join(root, 'src/renderer/hooks/useRemoteCatalogs.ts'))}
import { SidebarRemoteProjects, useRemoteProjectGroups } from ${JSON.stringify(join(root, 'src/renderer/components/SidebarRemoteProjects.tsx'))}
import { refreshDesktopConnections } from ${JSON.stringify(join(root, 'src/renderer/hooks/useDesktopConnections.ts'))}
import { createComposerDraftStore } from ${JSON.stringify(join(root, 'src/renderer/composer-drafts.ts'))}
import { RemotePromptQueueStore } from ${JSON.stringify(join(root, 'src/renderer/remote-prompt-queue.ts'))}
import { createRightSurfaceState } from ${JSON.stringify(join(root, 'src/renderer/right-surface.ts'))}
import ${JSON.stringify(join(root, 'src/renderer/styles.css'))}
import ${JSON.stringify(join(root, 'src/renderer/motion.css'))}
import ${JSON.stringify(join(root, 'src/renderer/codex-alignment.css'))}

const firstLedger = '11111111-1111-4111-8111-111111111111'
const secondLedger = '22222222-2222-4222-8222-222222222222'
const firstScryRun = 'remote-run-fixture-1'
const secondScryRun = 'remote-run-fixture-2'
const state = {
  historyPrompts: ['older remote prompt', 'latest remote prompt'],
  historyCalls: [], traceCalls: [], submitInputs: [], stopCalls: [], answerCalls: [], commandCalls: [], sessionActions: [],
  listCalls: 0, catalogCalls: 0, remoteStatusCalls: 0, runStatusCalls: 0, holdHistory: false, providerControlsCalls: [], holdProviderControls: false, providerControlWaiters: [],
  providerControlsFailure: null, legacyProviderHost: false,
  fileLists: [], fileReads: [], localWorkspaceCalls: [], workbenchCalls: [],
  uiEvents: [], backgroundStopCalls: 0, intentsCalls: 0, firstIntentCleared: false, answerFailure: false,
  intent: ${unknownReceiptOnly ? `{ intentId: 'unknown-original-id', connectionId: 'fixture-connection', context: { cwd: '/fixture/project-b', providerId: 'qoder', externalSessionId: 'other-native' }, createdAt: 1, status: 'unknown', failure: 'transport receipt unavailable' }` : 'null'},
  resolveIntentCalls: [], resolveFailure: null, holdSubmit: false, runState: 'dispatched', exposeTrace: true, runStatusFailure: false, autoResetOnSubmit: false, holdRunStatus: false,
  connected: true, hostEnabled: false, hostInviteCalls: 0, hostDisableCalls: 0,
  localNewSessions: 0, localStarts: 0, listFailure: false, hideProvider: false, catalogRevision: 0,
  catalogFailure: false, sessionActive: false, sessionTs: 1700000000000, sessionLastRunId: null, sessionLastRunOutcome: null, hostRunArchived: false, liveRunCalls: 0,
  updateSshCalls: [], connectCalls: 0, updateFailure: false, holdAddressUpdate: false,
  directoryReads: [], directorySelectCalls: [], directoryGrants: [], oldDirectoryHost: false, selectDirectoryFailure: false, holdDirectorySelection: false,
  phoneEnabled: true, relayConfigured: true, phoneStatusFailure: false, phonePairingCalls: 0,
  clipboardImageCalls: 0, forks: [], deletions: [], deleteFailure: false,
  commandFailure: false, holdCommands: false,
  providerMetadataObservedAt: 1700000000000, providerControlsObservedAt: 1700000000000, providerMetadataRevision: 1
}
const connection = {
  id: 'fixture-connection', label: 'Fixture desktop', hostId: 'fixture-host', anchorSHA256: 'fixture-fingerprint',
  ssh: { hostname: 'fixture.invalid', username: 'fixture', port: 22 }, state: 'connected', expiresAt: 4102444800000
}
const alpha = {
  id: 'claude', label: 'Alpha', available: true, modelId: 'alpha-default', forkSession: true,
  models: [{ id: 'alpha-default', providerId: 'claude', label: 'Alpha Default', isDefault: true,
    efforts: [{ id: 'alpha-effort', label: 'Alpha effort', isDefault: true }] },
    { id: 'alpha-remembered', providerId: 'claude', label: 'Alpha Remembered', efforts: [{ id: 'alpha-effort', label: 'Alpha effort', isDefault: true }] }],
  permissions: [{ id: 'default', label: 'Default', isDefault: true }, { id: 'full_access', label: 'Full access' }]
}
const beta = {
  id: 'qoder', label: 'Beta', available: true,
  models: [{ id: 'beta-default', providerId: 'qoder', label: 'Beta Default', isDefault: true,
    efforts: [{ id: 'beta-effort', label: 'Beta effort', isDefault: true }] }],
  permissions: [{ id: 'default', label: 'Default', isDefault: true }]
}
const catalog = {
  projects: [{ path: '/fixture/project-a', label: 'Project A' }, { path: '/fixture/project-b', label: 'Project B' }],
  providers: [alpha, { ...alpha, agentProfileId: 'alternate', label: 'Profile Alternate', modelId: 'alpha-alternate',
    models: [{ id: 'alpha-alternate', label: 'Alternate model', isDefault: true }],
    permissions: [{ id: 'default', label: 'Default', isDefault: true }] }, beta],
  sessions: [
    { sessionId: 'old-session', externalSessionId: 'old-native', providerId: 'claude', cwd: '/fixture/project-a', label: 'Old session', ts: 1700000000000 },
    { sessionId: 'other-session', externalSessionId: 'other-native', providerId: 'qoder', cwd: '/fixture/project-b', label: 'Other history', ts: 1 }
  ],
  providerEvidence: 'host_snapshot', directorySelection: true, sessionActions: true, sessionFork: true, sessionDelete: true,
  workbench: ${structureOnly ? '1' : 'undefined'},
  attachments: { transport: 'chunked', maxBytes: 16 * 1024 * 1024, maxTotalBytes: 32 * 1024 * 1024, maxCount: 16, chunkBytes: 256 * 1024 }
}
const contextFor = (input) => ({ ...input.context })
const activeRun = (runId, externalSessionId, text, question, background = false) => ({
  runId, providerId: runId === firstScryRun ? 'claude' : 'qoder', cwd: '/fixture/project-a', externalSessionId,
  userText: text, done: false, pendingQuestions: question ? [question] : [], items: [
    { id: runId + '-text', runId, ts: '2026-10-08T12:00:00.000Z', kind: 'model', stage: 'text', text },
    ...(background ? [{ id: runId + '-work', runId, ts: '2026-10-08T12:00:01.000Z', kind: 'harness', stage: 'runtime:background_work', backgroundWork: {
      providerId: 'qoder', phase: 'waiting', quiet: false, coverage: 'partial', taskStop: 'available', lastEventAt: 1,
      tasks: [{ taskId: 'remote-task', toolUseId: 'remote-call', tool: 'Bash', description: 'remote background task', observedAt: 1 }]
    } }] : [])
  ]
})
const question = { runId: firstScryRun, questionId: 'fixture-question', providerId: 'claude', source: 'fixture', questions: [{
  question: '继续远程运行？', header: '确认', options: [{ label: '继续', description: '继续执行' }], multiSelect: false, allowCustomAnswer: false
}] }
const visibilityWaiters = []
state.holdVisibilityReads = false
const holdVisibilityRead = async (kind) => {
  if (state.holdVisibilityReads) await new Promise((resolve, reject) => visibilityWaiters.push({ kind, resolve, reject }))
}
window.visibilityWaiting = () => visibilityWaiters.map(waiter => waiter.kind)
window.releaseVisibilityReads = (fail = false) => {
  for (const waiter of visibilityWaiters.splice(0)) {
    if (fail) waiter.reject(new Error('fixture visibility read failed'))
    else waiter.resolve()
  }
}
`
}
