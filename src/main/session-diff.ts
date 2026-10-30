// 会话/单轮 Diff 的权威链路只有一条：Git snapshot capture。
// 本文件是这条链路的生命周期与发布策略层，不引入第二套 diff 状态：
//   - SessionDiffBaselineRegistry：会话净 diff 基线的存活、复用、重锚与失效，保证不串会话也不静默丢失。
//   - RunDiffPreviewer：运行中用同一批 capture 做非消费式重算，落临时预览事件；终态一发布即封口。
import {
  type FileOp,
  type TurnDiffBaselineOrigin
} from '../shared/trace.js'
import {
  beginGitTurnDiff,
  cancelGitTurnDiff,
  type GitTurnDiffCapture
} from './git.js'
import { WorkspaceOverlapTracker } from './workspace-overlap.js'
import type { WorkspaceOverlapEvidence } from '../shared/turn-diff.js'

export interface SessionDiffBaseline {
  /** 创建时的 contextRevision；切换 / adopt 后不符即失效。 */
  revision: number
  /** 锚定的原生 session id；'' = 首轮还没拿到 id，等 bind 补齐。 */
  sessionId: string
  origin: TurnDiffBaselineOrigin
  capture: Promise<GitTurnDiffCapture>
  /** 净 diff 观测窗口起点。 */
  observedAt: number
}

export interface EnsureSessionBaselineInput {
  key: string
  revision: number
  cwd: string
  /** 本轮 resume 的原生 session id；缺省表示这是真正的新会话首轮。 */
  sessionId?: string
  /** 新建基线时复用调用方已经启动的同一时刻快照；命中既有基线时不会消费。 */
  initialCapture?: Promise<GitTurnDiffCapture>
}

export interface SessionLoadIdentity {
  providerId?: string
  agentProfileId?: string
  cwd?: string
  externalSessionId?: string
  sessionId?: string
}

/**
 * renderer 为恢复正在运行/收口的会话也会调用 loadSession。那只是读取历史，不能按“切换会话”
 * 清掉该 run 正在使用的 Git baseline；否则 turn_diff 仍有数据，但 session_diff 会落成 no_baseline。
 */
export function sessionLoadMatchesRun(run: SessionLoadIdentity, target: SessionLoadIdentity): boolean {
  const runSessionId = run.externalSessionId ?? run.sessionId
  return Boolean(
    runSessionId && target.externalSessionId &&
    runSessionId === target.externalSessionId &&
    run.providerId === target.providerId &&
    run.agentProfileId === target.agentProfileId &&
    (run.cwd ?? '') === (target.cwd ?? '')
  )
}

/**
 * App keys entries by provider/profile/cwd and native session, or provisional
 * run id until the Provider supplies that session. UI selection is not ownership.
 *
 * 关键语义：`ensure` 永远返回一个可用基线。命中同 revision + 同 session 的既有基线时复用
 * 「会话第一轮开始前」的原始快照；否则（新会话 / 恢复选择会话 / 应用重启后进程内无基线 /
 * revision 已变）当场重锚并标 `origin: 'resumed'`，让上层照实说明净 diff 只覆盖「自重锚以来」。
 * 旧实现只在 `!resume` 时建基线，于是 loadSession 之后所有轮次都拿不到基线并静默不落 session_diff。
 */
export class SessionDiffBaselineRegistry {
  private readonly entries = new Map<string, SessionDiffBaseline>()
  private readonly active = new Set<SessionDiffBaseline>()

  constructor(
    private readonly begin: (cwd: string) => Promise<GitTurnDiffCapture> = beginGitTurnDiff,
    private readonly cancel: (capture: GitTurnDiffCapture) => Promise<void> = cancelGitTurnDiff,
    /** 并行工作区观测，与基线同生命周期，不另建全局扫描。 */
    readonly workspace: WorkspaceOverlapTracker = new WorkspaceOverlapTracker()
  ) {}

  ensure(input: EnsureSessionBaselineInput): SessionDiffBaseline {
    const existing = this.entries.get(input.key)
    if (existing && this.usable(existing, input.revision, input.sessionId)) {
      if (input.sessionId && !existing.sessionId) existing.sessionId = input.sessionId
      this.entries.delete(input.key)
      this.entries.set(input.key, existing)
      return existing
    }
    if (existing) this.discard(input.key)
    const entry: SessionDiffBaseline = {
      revision: input.revision,
      sessionId: input.sessionId ?? '',
      // 带着 resume id 进来却没有可复用基线，说明会话首轮前的基线不在本进程里，只能重锚。
      origin: input.sessionId ? 'resumed' : 'session_start',
      capture: input.initialCapture ?? this.begin(input.cwd),
      observedAt: this.workspace.now()
    }
    this.entries.set(input.key, entry)
    return entry
  }

  get(key: string, revision: number, sessionId?: string): SessionDiffBaseline | undefined {
    const entry = this.entries.get(key)
    return entry && this.usable(entry, revision, sessionId) ? entry : undefined
  }

  /** 拿到原生 session id 后把基线锚死在它上面，之后别的会话再也认不走这份基线。 */
  bind(key: string, revision: number, sessionId: string): void {
    const entry = this.entries.get(key)
    if (!entry || entry.revision !== revision || !sessionId) return
    if (!entry.sessionId) entry.sessionId = sessionId
  }

  /** Promote the run's own provisional capture; never relabel another session. */
  promote(key: string, targetKey: string, sessionId: string): string {
    const entry = this.entries.get(key)
    if (!entry || (entry.sessionId && entry.sessionId !== sessionId)) return key
    if (key !== targetKey && this.entries.has(targetKey)) return key
    entry.sessionId = sessionId
    this.entries.delete(key)
    this.entries.set(targetKey, entry)
    return targetKey
  }

  /** One active run per session is enforced by App admission. Keep its capture
   * pinned while it runs, and retain at most 64 inactive session baselines.
   * Eviction or App restart re-anchors the next resume honestly as `resumed`. */
  retain(entry: SessionDiffBaseline): () => void {
    this.active.add(entry)
    return () => {
      this.active.delete(entry)
      let inactive = [...this.entries.values()].filter(value => !this.active.has(value)).length
      for (const [key, value] of this.entries) {
        if (inactive <= 64) break
        if (!this.active.has(value)) { this.discard(key); inactive-- }
      }
    }
  }

  /** 并行工作区观测：本轮窗口从本轮基线开始；会话净 diff 可回溯到 Entry.observedAt。 */
  observeRunWorkspace(runId: string, cwd: string): void { this.workspace.start(runId, cwd) }
  releaseRunWorkspace(runId: string): void { this.workspace.close(runId) }
  /** undefined = 本轮未被观测：调用方保持 unknown，不得当成独占归因。 */
  workspaceOverlap(runId: string, from?: number): WorkspaceOverlapEvidence | undefined {
    return this.workspace.evidence(runId, from)
  }

  discard(key: string): void {
    const entry = this.entries.get(key)
    if (!entry) return
    this.entries.delete(key)
    void entry.capture.then(this.cancel).catch(() => undefined)
  }

  disposeAll(): void {
    for (const key of [...this.entries.keys()]) this.discard(key)
    this.workspace.disposeAll()
  }

  private usable(entry: SessionDiffBaseline, revision: number, sessionId?: string): boolean {
    if (entry.revision !== revision) return false
    // 任一侧还不知道 session id 时只能靠 revision 判定；两边都知道就必须相等。
    if (!sessionId || !entry.sessionId) return true
    return entry.sessionId === sessionId
  }
}

export type DiffPreviewScope = 'turn' | 'session'

/** WriteCompletionTracker 只看 TraceEvent 的这几个字段，测试可以直接喂最小事件。 */
export interface WriteObservation {
  stage: string
  toolUseId?: string
  fileOp?: FileOp
  filePath?: string
}

/**
 * 「文件真的落盘了吗」的判定器，供运行中 Diff 预览定时序。
 *
 * 结构化 write/edit 的 tool start 只说明模型准备写：Provider 的实际顺序是
 * start → 真正写盘 → tool_result。在 start 上刷预览会读到写盘前的工作树，
 * 于是预览要么少一次改动，要么整体落后一拍。所以这里用 toolUseId 把 start 挂起，
 * 只在对应 tool_result 到达时才认为「这次写入已经结束」。
 *
 * 失败结果同样算触发：工具报错前完全可能已经写了一部分，那些字节必须进预览。
 * 反过来，普通 read 或与任何 write/edit start 无关的 tool_result 一律不算写入。
 */
export class WriteCompletionTracker {
  private readonly pendingWrites = new Set<string>()

  /** true = 这条事件证明有结构化写入已经结束，可以刷新预览。 */
  observe(event: WriteObservation): boolean {
    const write = event.fileOp === 'write' || event.fileOp === 'edit'
    if (event.stage !== 'tool_result') {
      if (write && event.filePath && event.toolUseId) this.pendingWrites.add(event.toolUseId)
      return false
    }
    if (event.toolUseId && this.pendingWrites.delete(event.toolUseId)) return true
    // Codex 的 fileChange 只在 completed 时到达一条：结果事件自带 write/edit 足迹，本身就是落盘证据。
    return write && Boolean(event.filePath)
  }
}

export { RunDiffPreviewer, DIFF_PREVIEW_MIN_INTERVAL_MS, type DiffPreviewEvent, type RunDiffPreviewerOptions } from './run-diff-previewer.js'
