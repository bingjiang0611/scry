import { expect, it } from 'vitest'
import { normalizeAgentStartRequest } from './runtime'
import { parseWorkspaceStartSelection } from './workspace-selection-input'

const selection = {
  operationId: 'F4826A0A-EF56-4309-8D70-E3CD76F0181C',
  intent: { kind: 'current' as const, repositoryId: 'a'.repeat(64), expectedRevision: 'b'.repeat(64) }
}
it('normalizes operation identity and strips privileged-looking payload fields', () => {
  expect(parseWorkspaceStartSelection({ ...selection, cwd: '/outside', admit: true, intent: {
    ...selection.intent, targetPath: '/outside'
  } })).toEqual({ ...selection, operationId: selection.operationId.toLowerCase() })
})
it('rejects malformed references rather than forwarding commands or paths', () => {
  for (const value of [null, [], {}, { ...selection, operationId: '../escape' },
    { ...selection, intent: { ...selection.intent, repositoryId: '../escape' } },
    { ...selection, intent: { ...selection.intent, kind: 'existingWorktree', worktreeId: '/outside' } },
    { ...selection, intent: { ...selection.intent, branch: { name: '--upload-pack=evil', head: 'a'.repeat(40), kind: 'local' } } }])
    expect(() => parseWorkspaceStartSelection(value)).toThrow()
})
it('only admits explicit first-send workspace selection, never resume, fork or an unspecified cwd', () => {
  const request = { prompt: 'task', commandId: 'command-id', cwd: '/project', expectedExternalSessionId: null, workspace: selection }
  expect(normalizeAgentStartRequest(request).workspace?.operationId).toBe(selection.operationId.toLowerCase())
  expect(() => normalizeAgentStartRequest({ ...request, expectedExternalSessionId: 'old-session' })).toThrow()
  expect(() => normalizeAgentStartRequest({ ...request, expectedExternalSessionId: undefined })).toThrow()
  expect(() => normalizeAgentStartRequest({ ...request, commandId: undefined })).toThrow()
  expect(() => normalizeAgentStartRequest({ ...request, cwd: undefined })).toThrow()
})
