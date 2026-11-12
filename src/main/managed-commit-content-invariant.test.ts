import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { commitHandoff, handoffs, managedRecorderMode, prepareManagedRecorderTurn } from '../core/turn-recorder/managed'
import { CONTENT_MISSING_REASON } from '../core/turn-recorder/managed-evidence'
import { recorderSessionRoot } from '../core/turn-recorder/runtime-state'
import { listRecords } from '../core/turn-recorder/store'
import { fixture, input, startManaged } from './managed-turn-tests/fixture.test'

const fullCapture = JSON.stringify({
  schemaVersion: 1, enabled: true, workspaceId: 'managed-main-fixture', dataDir: '.scry',
  repositories: { mode: 'workspace-only' },
  capture: { prompt: true, assistant: true, toolOutput: 'full', diff: true, hooks: true }
})

/**
 * 提交边界的不变式在旧数据上才真正起作用：升级前准备好的 handoff 里可能带着只存在于 App trace 库的
 * 引用。恢复路径直接 commit 这份 handoff，因此降级必须发生在 `commitHandoff` 内部，而且重复提交要
 * 与本次真正提交的表示比较。
 */
describe('managed commit content invariant', () => {
  it('degrades a handoff prepared by an older writer instead of committing a dangling reference', async () => {
    const { workspace, userDataDir } = await fixture()
    await writeFile(join(workspace, 'scry.config.json'), fullCapture)
    await startManaged(workspace)
    const base = input(workspace, userDataDir)
    const dataRoot = join(workspace, '.scry')
    await prepareManagedRecorderTurn({
      workspace,
      provider: 'codex',
      sessionId: base.sessionId,
      providerTurnId: base.providerTurnId,
      runId: base.turn.runId,
      userText: base.turn.userText,
      evidence: base.turn.turnEvidence!,
      timing: base.timing,
      status: base.status,
      archiveFingerprint: 'fingerprint-commit-invariant',
      toolContentPolicy: { toolOutput: 'full', toolContentFieldBytes: 8 * 1024, toolContentTurnBytes: 128 * 1024 }
    })
    const mode = await managedRecorderMode(workspace, {})
    if (mode.status !== 'enabled') throw new Error('fixture recorder must be enabled')
    const root = recorderSessionRoot(dataRoot, 'codex', base.sessionId)
    const [onDisk] = await handoffs(root)
    // 旧写入方的形态：handoff 已准备好，工具输出引用只在 App 库、本库没有字节。
    const ghost = { storage: 'recorder-content-v1' as const, sha256: 'c'.repeat(64), bytes: 7, encoding: 'utf8' as const }
    const mangled = {
      ...onDisk.handoff,
      phase: 'archive_committed' as const,
      record: {
        ...onDisk.handoff.record,
        tools: {
          ...onDisk.handoff.record.tools,
          value: [{
            id: 'call-ghost',
            name: 'Bash',
            status: 'success' as const,
            outputContent: {
              content: 'preview',
              contentRef: ghost,
              encoding: 'utf8' as const,
              savedBytes: 7,
              source: 'scry_app_trace',
              sourceCompleteness: 'complete' as const,
              redaction: 'disabled' as const,
              storage: 'truncated' as const,
              reasons: []
            }
          }]
        }
      }
    }
    await writeFile(onDisk.path, JSON.stringify(mangled))

    const committed = await commitHandoff(mode.enablement, root, mangled)

    expect(committed.status).toBe('committed')
    const [record] = await listRecords(dataRoot)
    expect(record.recordId).toBe(mangled.record.recordId)
    const output = record.tools.value![0].outputContent!
    expect(output).toMatchObject({ storage: 'omitted', sourceCompleteness: 'unavailable', savedBytes: 0 })
    expect(output.contentRef).toBeUndefined()
    expect(record.tools.omissionReason).toContain(CONTENT_MISSING_REASON)

    // 同一份旧 handoff 再走一次恢复：命中 duplicate，而不是因为“表示不同”抛错。
    const retry = await commitHandoff(mode.enablement, root, mangled)
    expect(retry).toMatchObject({ status: 'duplicate', recordId: committed.recordId })
  })
})
