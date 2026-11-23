import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { canonicalJson, sha256Hex } from './canonical-json'
import { EventSink } from './event-sink'
import { SubscribeEngine } from './subscribe-engine'
import { SubscribeHub } from './subscribe-hub'

const LOCAL_PEER = `peer:${'a'.repeat(64)}`
const REMOTE_PEER = `peer:${'b'.repeat(64)}`

describe('P6-5 remote subscribe lineage and read-only delegated child sessions', () => {
  it('exposes parentSessionKey and lineageKind on subscribe sessions snapshot for both local and remote peers', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'scry-p6-5-sub-'))
    const sink = EventSink.open({ userDataDir: dir, authorizedActors: [LOCAL_PEER, REMOTE_PEER], fullfsync: false })
    const hub = new SubscribeHub()
    try {
      const cwd = '/repo/p6-5'
      const subPayload = {
        runId: 'run-p1',
        sessionKey: 'sess-p1',
        provider: 'qoder',
        profile: null,
        cwd,
        promptPreview: 'parent',
        claimMode: 'immediate' as const,
        dispatchImmediately: true,
        leaseOwner: 'daemon:test',
        origin: 'local' as const
      }
      expect(sink.execute({
        type: 'run.submit',
        commandId: 'sub-p1',
        actor: LOCAL_PEER,
        scope: 'local',
        at: 1000,
        payload: subPayload,
        payloadSha256: sha256Hex(canonicalJson(subPayload))
      }).kind).toBe('accepted')

      // Enable project delegation as local peer; remote peer is rejected
      const polPayload = { cwd, enabled: true }
      expect(sink.execute({
        type: 'delegation.set_project_policy',
        commandId: 'pol-remote',
        actor: REMOTE_PEER,
        scope: 'remote',
        at: 1001,
        payload: polPayload,
        payloadSha256: sha256Hex(canonicalJson(polPayload))
      })).toMatchObject({ kind: 'rejected', reason: 'device_not_authorized' })

      expect(sink.execute({
        type: 'delegation.set_project_policy',
        commandId: 'pol-local',
        actor: LOCAL_PEER,
        scope: 'local',
        at: 1002,
        payload: polPayload,
        payloadSha256: sha256Hex(canonicalJson(polPayload))
      }).kind).toBe('accepted')

      const reqPayload = {
        taskId: 'task-1',
        parentSessionKey: 'sess-p1',
        parentRunId: 'run-p1',
        provider: 'qoder',
        profile: null,
        cwd,
        title: '子任务标题',
        role: null,
        targetModel: null,
        targetEffort: null,
        permissionMode: 'default' as const,
        permissionModeSource: 'inherited' as const,
        isolation: 'shared' as const,
        body: sink.bodyStore.prepareBody('do subtask'),
        promptPreview: 'do subtask',
        confirmationQuestionId: 'confirm:task-1'
      }
      expect(sink.execute({
        type: 'task.request',
        commandId: 'req-1',
        actor: 'agent:sess-p1#b1',
        principal: LOCAL_PEER,
        via: 'v1',
        actorRunId: 'run-p1',
        scope: 'local',
        at: 1003,
        payload: reqPayload,
        payloadSha256: sha256Hex(canonicalJson(reqPayload))
      }).kind).toBe('accepted')

      const confirmPayload = {
        taskId: 'task-1',
        questionId: 'confirm:task-1',
        approved: true,
        answerId: 'ans-1',
        answerSha256: sha256Hex('yes'),
        childSessionKey: 'delegated:task-1',
        childRunId: 'child-run-1'
      }
      expect(sink.execute({
        type: 'task.confirm',
        commandId: 'conf-1',
        actor: LOCAL_PEER,
        scope: 'local',
        at: 1004,
        payload: confirmPayload,
        payloadSha256: sha256Hex(canonicalJson(confirmPayload))
      }).kind).toBe('accepted')

      const engine = new SubscribeEngine({
        sink,
        hub,
        hostId: 'host-1',
        authorizePeer: () => undefined,
        grantScope: (peer) => (peer === LOCAL_PEER ? 'local' : 'remote'),
        remoteCwdAuthorizer: () => (candidate) => candidate === cwd
      })

      const remoteReply = await engine.subscribe(REMOTE_PEER, { views: ['sessions'], waitMs: 0 })
      expect(remoteReply.mode).toBe('snapshot')
      if (remoteReply.mode === 'snapshot') {
        const child = remoteReply.snapshot.sessions?.rows.find((r) => r.sessionKey === 'delegated:task-1')
        expect(child).toMatchObject({
          sessionKey: 'delegated:task-1',
          parentSessionKey: 'sess-p1',
          lineageKind: 'delegated'
        })
      }
    } finally {
      hub.close()
      sink.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
