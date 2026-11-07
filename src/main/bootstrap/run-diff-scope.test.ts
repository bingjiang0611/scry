import { describe, expect, it } from 'vitest'
import type { ActiveRun } from '../../shared/trace'
import { SessionDiffBaselineRegistry, type RunDiffPreviewer } from '../session-diff'
import { createRunDiffLifecycle, type RunDiffDependencies } from './run-diff'

// A view-demand protocol is an App thing: the window can ask for previews and says
// when it stops looking. A device submitter has no such channel, so previews stay
// off. This is decided by the submitter (appSemantics), not by how the run arrived.

function lifecycle(appSemantics: boolean) {
  const demanded: boolean[] = []
  const previewer = {
    setDemanded: (value: boolean) => { demanded.push(value) },
    sealAll: () => undefined,
    idle: async () => undefined,
    notifyChange: async () => undefined
  } as unknown as RunDiffPreviewer
  const runState: ActiveRun = {
    runId: 'run-1', providerId: 'claude', cwd: '/w', userText: 'hi', items: [], done: false, providerSettled: false
  }
  const deps = {
    appSemantics,
    diffPreviewer: previewer,
    turnDiffCapture: Promise.resolve({ status: 'unavailable', reason: 'test' }),
    turnChangeJournal: null,
    patchExcludeBasenames: [],
    cwd: '/w',
    contextKey: 'context',
    runId: 'run-1',
    providerId: 'claude',
    runtimeProvider: 'claude_sdk',
    runState,
    sessionDiffBaselines: new SessionDiffBaselineRegistry(undefined, undefined),
    getDiffContextKey: () => 'context',
    getObservedSessionId: () => undefined,
    getResume: () => undefined,
    getContextRevision: () => 0,
    mainEventId: (prefix: string, id: string) => `${prefix}-${id}`,
    appendCoalescedTrace: () => undefined,
    publishTrace: () => undefined
  } as unknown as RunDiffDependencies
  return { demanded, created: createRunDiffLifecycle(deps) }
}

describe('diff preview demand follows the submitter', () => {
  it('gives the App its own view-demand channel and starts it hidden', () => {
    const { demanded, created } = lifecycle(true)
    expect(created.setDiffPreviewDemand).toBeTypeOf('function')
    expect(demanded).toEqual([false])
    created.setDiffPreviewDemand?.(true)
    expect(demanded).toEqual([false, true])
  })

  it('gives a device submitter no demand channel at all', () => {
    const { demanded, created } = lifecycle(false)
    expect(created.setDiffPreviewDemand).toBeUndefined()
    // Nothing was asked of the previewer: absence of a channel is not a hidden view.
    expect(demanded).toEqual([])
  })
})
