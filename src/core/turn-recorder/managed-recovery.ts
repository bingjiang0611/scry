import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { readJson, listFiles, writeJsonAtomic } from './io.js'
import { type RecorderOpenTurnState, type RecorderSessionState, recorderStatePath, recorderOpenPath, recorderTurnRoot, recorderQuarantinedOpenTurns, withRecorderSessionLock, SESSION_LOCK_WAIT_MS } from './runtime-state.js'
import { listRecords, stableHash, clearRuntimeTurn } from './store.js'
import { canonicalPath, type CommitNotificationDelivery, managedRecorderMode, handoffs, commitHandoff, deliverCommitNotifications } from './managed.js'
import { type PrepareManagedTurnInput, rawTextHash, type ManagedTurnHandoff, type ManagedRecorderProviderId } from './managed-evidence.js'


export async function reserveCanonicalJournalRecovery(
  dataRoot: string,
  root: string,
  input: PrepareManagedTurnInput
): Promise<RecorderOpenTurnState | undefined> {
  const end = input.termination
  if (
    !input.allowCanonicalJournalRecovery || !input.providerTurnId || !input.runId ||
    (end?.status !== 'available' && end?.status !== 'partial') ||
    !end.value || end.value.observedAt !== input.timing.completedAt ||
    (end.value.completedAtSource !== 'provider_terminal_event' &&
      end.value.completedAtSource !== 'recorder_observed_terminal')
  ) return undefined

  // The canonical journal is written only after the Provider has terminated and contains the
  // authoritative provider turn id plus exact evidence. If a previous recovery removed the
  // provisional open before preparing its handoff, reserve a fresh durable generation instead of
  // leaving the journal in a permanent front-door deadlock.
  const state = await readJson<RecorderSessionState>(recorderStatePath(root))
  const records = (await listRecords(dataRoot)).filter((record) =>
    record.provider.id === input.provider && record.sessionId === input.sessionId)
  const reserved = (await listFiles(join(root, 'turns')))
    .filter((name) => /^\d+$/.test(name)).map(Number)
  const generation = Math.max(state?.lastGeneration ?? 0, ...records.map((record) => record.generation), ...reserved) + 1
  const turnIndex = Math.max(state?.lastTurnIndex ?? 0, ...records.map((record) => record.turnIndex)) + 1
  if (!Number.isSafeInteger(generation) || !Number.isSafeInteger(turnIndex)) {
    throw new Error('managed recorder canonical journal recovery sequence is invalid')
  }
  const open: RecorderOpenTurnState = {
    schemaVersion: 1,
    provider: input.provider,
    sessionId: input.sessionId,
    generation,
    turnIndex,
    status: 'closing',
    startedAt: input.timing.startedAt,
    terminalAt: input.timing.completedAt,
    terminalAtSource: end.value.completedAtSource,
    terminalFallbackStatus: input.status,
    endReason: end.value.reason,
    prompt: input.userText,
    promptHash: rawTextHash(input.userText),
    providerTurnId: input.providerTurnId,
    managedByScry: true,
    managedRunId: input.runId,
    managedPromptHash: rawTextHash(input.userText),
    startFingerprint: stableHash({ source: 'canonical_journal_recovery', runId: input.runId, timing: input.timing }),
    captures: []
  }
  // Publish the recoverable open before advancing the cache. A crash between these writes leaves
  // an identity that the next replay can still finish; commitHandoff repairs both high-water marks.
  await writeJsonAtomic(recorderOpenPath(root), open)
  await writeJsonAtomic(recorderStatePath(root), {
    ...state,
    schemaVersion: 1,
    lastGeneration: generation,
    lastTurnIndex: turnIndex
  })
  return open
}

// 已开的轮次只有在“还有人能把它收口”时才值得阻断下一轮。没有 providerTurnId、没有 canonical handoff，
// 并且它的 managedRunId 已不是本进程里活的 run（进程早没了），这种 provisional 状态永远不会自己
// 收口，留着只会把该工作区+Provider 永久卡在“仍有 N 轮待恢复”。这里按与
// cancelManagedRecorderTurn 相同的证据标准弃掉它；一旦出现真的 Provider 证据（providerTurnId
// 或已备好的 canonical handoff），仍然 fail closed。
async function abandonProvisionalOpenTurn(
  root: string,
  dataRoot: string,
  state: RecorderOpenTurnState,
  statePath: string,
  isLiveManagedRun: (runId: string | undefined) => boolean
): Promise<boolean> {
  if (state.providerTurnId) return false
  if (isLiveManagedRun(state.managedRunId)) return false
  if (await readJson<ManagedTurnHandoff>(canonicalPath(root, state.generation))) return false
  await rm(statePath, { force: true })
  await clearRuntimeTurn(dataRoot, recorderTurnRoot(root, state.generation))
  return true
}

export async function recoverManagedRecorderTurns(
  workspace: string,
  env: NodeJS.ProcessEnv = process.env,
  options: {
    sessionId?: string
    provider?: ManagedRecorderProviderId
    // 默认保守：不知道哪些 run 还活着时，不弃掉任何 open 状态（否则可能删掉正在跑的轮次）。
    // 调用方（main）知道 run 存活情况时传入 abandonProvisional，才会清理不可恢复的 provisional 轮次。
    abandonProvisional?: boolean
    // App 拥有的活跃轮次由原执行链收口；恢复不得重放它们，也不把它们计为 pending。
    isLiveManagedRun?: (runId: string | undefined, nativeIdentity?: Pick<RecorderOpenTurnState, 'provider' | 'sessionId' | 'providerTurnId'>) => boolean
    // 常驻 App 走 'detach'：恢复检查在“发送前”跑，不能被仓库回调积压拖住发送。
    commitNotifications?: CommitNotificationDelivery
  } = {}
): Promise<{ recovered: number; pending: number }> {
  const mode = await managedRecorderMode(workspace, env)
  if (mode.status === 'disabled') return { recovered: 0, pending: 0 }
  const { enablement } = mode
  let recovered = 0
  let pending = 0
  const providers: ManagedRecorderProviderId[] = options.provider
    ? [options.provider]
    : ['claude', 'codex', 'qoder', 'opencode', 'pi']
  for (const provider of providers) {
    const providerRoot = join(enablement.dataRoot, 'runtime', provider)
    for (const sessionDir of await listFiles(providerRoot)) {
      const root = join(providerRoot, sessionDir)
      const open = await readJson<RecorderOpenTurnState>(recorderOpenPath(root))
      const quarantined = await recorderQuarantinedOpenTurns(root)
      const items = (await handoffs(root)).filter(
        (item) => !options.sessionId || item.handoff.record.sessionId === options.sessionId
      )
      if (
        options.sessionId &&
        open?.sessionId !== options.sessionId &&
        items.length === 0 &&
        !quarantined.some((item) => item.sessionId === options.sessionId)
      ) continue
      for (const item of items) {
        if (options.isLiveManagedRun?.(item.handoff.runId)) continue
        if (item.handoff.phase !== 'archive_committed') {
          pending++
          continue
        }
        const result = await withRecorderSessionLock(
          enablement.dataRoot, provider, item.handoff.record.sessionId,
          () => commitHandoff(enablement, root, item.handoff),
          { waitMs: SESSION_LOCK_WAIT_MS }
        )
        if (result.status === 'committed' || result.status === 'duplicate') recovered++
      }
      const isLiveManagedRun = options.abandonProvisional
        ? options.isLiveManagedRun ?? ((): boolean => false)
        : ((): boolean => true)
      if (
        open &&
        (open.managedByScry || open.status === 'closing') &&
        !options.isLiveManagedRun?.(open.managedRunId, open) &&
        (!options.sessionId || open.sessionId === options.sessionId) &&
        !items.some((item) => item.handoff.record.generation === open.generation)
      ) {
        const abandoned = await withRecorderSessionLock(
          enablement.dataRoot, provider, open.sessionId,
          () => abandonProvisionalOpenTurn(root, enablement.dataRoot, open, recorderOpenPath(root), isLiveManagedRun),
          { waitMs: SESSION_LOCK_WAIT_MS }
        ).catch(() => false)
        if (abandoned) recovered++
        else pending++
      }
      for (const pendingOpen of quarantined) {
        if (
          (!options.sessionId || pendingOpen.sessionId === options.sessionId) &&
          !options.isLiveManagedRun?.(pendingOpen.managedRunId, pendingOpen) &&
          !items.some((item) => item.handoff.record.generation === pendingOpen.generation)
        ) {
          const abandoned = await withRecorderSessionLock(
            enablement.dataRoot, provider, pendingOpen.sessionId,
            () => abandonProvisionalOpenTurn(
              root,
              enablement.dataRoot,
              pendingOpen,
              join(recorderTurnRoot(root, pendingOpen.generation), 'pending-open.json'),
              isLiveManagedRun
            ),
            { waitMs: SESSION_LOCK_WAIT_MS }
          ).catch(() => false)
          if (abandoned) recovered++
          else pending++
        }
      }
    }
  }
  // agent:start 每一轮都会跑到这里；同步投递会把发送卡在“正在启动”。
  await deliverCommitNotifications(enablement.dataRoot, env, options.commitNotifications ?? 'await')
  return { recovered, pending }
}
