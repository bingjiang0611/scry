// P6-V real-host L3 verification script (Codex + Qoder + SIGKILL restart recovery)
// Uses isolated temporary HOME/CODEX_HOME/userData and a Chinese workspace path.
// Never touches ~/.scry or daily com.scry.daemon.
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, platform, arch, tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { qodercliAuth, query } from '@qoder-ai/qoder-agent-sdk'
import { canonicalJson, sha256Hex } from '../src/host-runtime/orchestration/canonical-json'
import { EventSink } from '../src/host-runtime/orchestration/event-sink'
import { recoverOrchestrationOnStartup } from '../src/host-runtime/orchestration/recovery'
import { DaemonDelegationRuntime } from '../src/daemon/delegation-runtime'
import { createQoderOrchestratorMcpServer, ORCHESTRATOR_AUTO_ALLOW_TOOL_NAMES } from '../src/main/providers/orchestrator-mcp-sdk'

const PEER_LOCAL = `peer:${'b'.repeat(64)}`
const evidenceDir = process.env.SCRY_P6_V_EVIDENCE_DIR || join(homedir(), '.local/state/scry-handoff-evidence/W20-p6-v')
mkdirSync(evidenceDir, { recursive: true })

function submitActiveParentRun(sink: EventSink, runId: string, sessionKey: string, provider: string, cwd: string) {
  const payload = {
    runId,
    sessionKey,
    provider,
    profile: null,
    cwd,
    promptPreview: '请调用 scry_capabilities 和 scry_task_delegate 委派一个子任务',
    claimMode: 'immediate' as const,
    dispatchImmediately: true,
    leaseOwner: 'daemon:p6-v',
    origin: 'local' as const
  }
  const res = sink.execute({
    type: 'run.submit',
    commandId: `p6v-submit:${runId}`,
    actor: PEER_LOCAL,
    scope: 'local',
    at: Date.now(),
    payload,
    payloadSha256: sha256Hex(canonicalJson(payload))
  })
  if (res.kind !== 'accepted') throw new Error(`submit failed: ${JSON.stringify(res)}`)
}

async function runCodexRealHost(root: string, zhCwd: string) {
  const userDataDir = join(root, 'ud-codex')
  mkdirSync(userDataDir, { recursive: true })
  const sink = EventSink.open({ userDataDir, authorizedActors: [PEER_LOCAL], fullfsync: false, checkpointFullfsync: false })
  let runtime: DaemonDelegationRuntime | undefined
  let codexHome: string | undefined
  let child: ReturnType<typeof spawn> | undefined
  try {
    const version = execFileSync('codex', ['--version'], { encoding: 'utf8' }).trim()
    const runId = 'p6v-codex-parent-1'
    const sessionKey = 'p6v-codex-sess-1'
    submitActiveParentRun(sink, runId, sessionKey, 'codex', zhCwd)

    const dispatched: string[] = []
    runtime = new DaemonDelegationRuntime({
      sink,
      currentTrustFingerprint: () => 'p6v-codex-fp-1',
      hasLocalSubscriber: () => true,
      requestRunStop: () => true,
      dispatchChildRun: async (input) => {
        dispatched.push(input.prompt)
        return {
          status: 'completed',
          finalMessage: { status: 'available', quality: 'exact', source: ['p6v-child'], value: '中文子任务已完成检查' }
        }
      }
    })
    runtime.setProjectPolicy(PEER_LOCAL, { cwd: zhCwd, enabled: true })

    const prepared = await runtime.prepareRunOrchestration({
      runId,
      canonicalRunId: runId,
      providerId: 'codex',
      cwd: zhCwd,
      sessionKey,
      permissionMode: 'default',
      via: 'local'
    })
    if (prepared.orchestrationTools?.kind !== 'codex_http') {
      throw new Error('Expected codex_http orchestrationTools')
    }
    const { url, bearerToken } = prepared.orchestrationTools

    codexHome = join(root, 'codex-home')
    mkdirSync(codexHome, { recursive: true })
    const realAuth = join(homedir(), '.codex', 'auth.json')
    if (existsSync(realAuth)) symlinkSync(realAuth, join(codexHome, 'auth.json'))

    child = spawn('codex', ['app-server', '--strict-config'], {
      cwd: zhCwd,
      env: { ...process.env, CODEX_HOME: codexHome, NO_PROXY: '127.0.0.1,localhost', LC_ALL: 'zh_CN.UTF-8' },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    const rl = createInterface({ input: child.stdout! })
    let nextId = 1
    const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()
    let turnDoneResolve: (() => void) | undefined
    const turnDone = new Promise<void>((r) => { turnDoneResolve = r })
    const elicitations: string[] = []

    const sendRpc = (method: string, params: Record<string, unknown>) =>
      new Promise<any>((resolve, reject) => {
        const id = nextId++
        pending.set(id, { resolve, reject })
        child!.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
      })

    rl.on('line', (line) => {
      let msg: any
      try { msg = JSON.parse(line) } catch { return }
      if (typeof msg.id === 'number' && !msg.method && pending.has(msg.id)) {
        const p = pending.get(msg.id)!
        pending.delete(msg.id)
        if (msg.error) p.reject(new Error(JSON.stringify(msg.error)))
        else p.resolve(msg.result)
        return
      }
      if (msg.method === 'mcpServer/elicitation/request' && msg.id !== undefined) {
        const srv = msg.params?.serverName
        elicitations.push(String(srv))
        const action = srv === 'scry_orchestrator' ? 'accept' : 'decline'
        child!.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { action } }) + '\n')
        return
      }
      if (msg.method === 'turn/completed') {
        turnDoneResolve?.()
      }
    })

    await sendRpc('initialize', { clientInfo: { name: 'scry-p6v', version: '0.1.0' } })
    const started = await sendRpc('thread/start', {
      cwd: zhCwd,
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
      config: {
        mcp_servers: {
          scry_orchestrator: {
            url,
            http_headers: { Authorization: `Bearer ${bearerToken}` },
            tool_timeout_sec: 30
          }
        }
      }
    })
    const threadId = started.thread?.id
    if (!threadId) throw new Error('codex thread/start returned no thread.id')

    await sendRpc('turn/start', {
      threadId,
      input: [
        {
          type: 'text',
          text: '请先调用 scry_orchestrator 的 scry_capabilities 工具，然后调用 scry_task_delegate 工具委派一个异步子任务（task="检查中文路径工作区", title="中文检查", clientRequestId="p6v-codex-1", mode="async"）。调用完成后立即简短回复即可。'
        }
      ]
    })

    await Promise.race([
      turnDone,
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('codex turn timeout (90s)')), 90_000))
    ])

    const beforeConfirm = runtime.getState({ cwd: zhCwd, parentSessionKey: sessionKey })
    const task = beforeConfirm.tasks[0]
    let confirmed: unknown = null
    let afterStatus: string | null = null
    let afterSummary: string | null = null
    if (task && task.status === 'awaiting_confirmation' && task.confirmationQuestionId) {
      confirmed = await runtime.confirmTask(PEER_LOCAL, {
        taskId: task.taskId,
        questionId: task.confirmationQuestionId,
        approved: true
      })
      for (let i = 0; i < 40; i++) {
        const cur = runtime.getState({ cwd: zhCwd, parentSessionKey: sessionKey }).tasks[0]
        if (cur && cur.status === 'completed') {
          afterStatus = cur.status
          afterSummary = cur.summary?.value ?? null
          break
        }
        await new Promise((r) => setTimeout(r, 50))
      }
    }

    prepared.cleanup()
    const replay = sink.verifyReplayConsistency()
    return {
      ok: Boolean(task && afterStatus === 'completed' && replay.matches && sink.countNonTerminalAgentRuns() === 0),
      version,
      elicitations,
      taskCreated: Boolean(task),
      taskStatusBeforeConfirm: task?.status ?? null,
      confirmed,
      afterStatus,
      afterSummary,
      dispatchedCount: dispatched.length,
      nonTerminalAgentRuns: sink.countNonTerminalAgentRuns(),
      replayMatches: replay.matches,
      ...(replay.diff ? { replayDiff: replay.diff } : {})
    }
  } finally {
    if (child && child.exitCode === null) {
      const exited = new Promise<void>((r) => child!.once('exit', () => r()))
      child.kill('SIGTERM')
      await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))])
    }
    await runtime?.close()
    sink.close()
  }
}

async function runQoderRealHost(root: string, zhCwd: string) {
  const userDataDir = join(root, 'ud-qoder')
  mkdirSync(userDataDir, { recursive: true })
  const sink = EventSink.open({ userDataDir, authorizedActors: [PEER_LOCAL], fullfsync: false, checkpointFullfsync: false })
  let runtime: DaemonDelegationRuntime | undefined
  try {
    let version = 'unknown'
    try { version = execFileSync('qodercli', ['--version'], { encoding: 'utf8' }).trim() } catch { /* ignore */ }
    const runId = 'p6v-qoder-parent-1'
    const sessionKey = 'p6v-qoder-sess-1'
    submitActiveParentRun(sink, runId, sessionKey, 'qoder', zhCwd)

    let resolveChild!: (v: { status: 'cancelled' }) => void
    const childHold = new Promise<{ status: 'cancelled' }>((r) => { resolveChild = r })
    const stopCalls: string[] = []
    runtime = new DaemonDelegationRuntime({
      sink,
      currentTrustFingerprint: () => 'p6v-qoder-fp-1',
      hasLocalSubscriber: () => true,
      requestRunStop: (id) => { stopCalls.push(id); resolveChild({ status: 'cancelled' }); return true },
      dispatchChildRun: async () => await childHold
    })
    runtime.setProjectPolicy(PEER_LOCAL, { cwd: zhCwd, enabled: true })

    const prepared = await runtime.prepareRunOrchestration({
      runId,
      canonicalRunId: runId,
      providerId: 'qoder',
      cwd: zhCwd,
      sessionKey,
      permissionMode: 'default',
      via: 'local'
    })
    if (prepared.orchestrationTools?.kind !== 'in_process') {
      throw new Error('Expected in_process orchestrationTools for Qoder')
    }
    const sdkServer = createQoderOrchestratorMcpServer(prepared.orchestrationTools.callTool)
    const allowedToolsSeen: string[] = []

    const auth = qodercliAuth()
    const stream = query({
      prompt: '请先调用 scry_capabilities 工具，再调用 scry_task_delegate 工具委派一个异步子任务（task="检查中文路径构建", title="Qoder中文任务", clientRequestId="p6v-qoder-1", mode="async"）。完成后简短回复即可。',
      options: {
        cwd: zhCwd,
        strictMcpConfig: true,
        mcpServers: { scry_orchestrator: sdkServer as any },
        canUseTool: async (toolName, input) => {
          allowedToolsSeen.push(toolName)
          if (ORCHESTRATOR_AUTO_ALLOW_TOOL_NAMES.has(toolName)) {
            return { behavior: 'allow', updatedInput: input }
          }
          return { behavior: 'deny', message: 'p6v test only allows scry_orchestrator tools' }
        },
        ...(auth ? { auth } : {})
      } as any
    })
    for await (const _msg of stream) {
      // consume stream to completion
    }

    const state = runtime.getState({ cwd: zhCwd, parentSessionKey: sessionKey })
    const task = state.tasks[0]
    let confirmRes: unknown = null
    let stopAllRes: unknown = null
    if (task && task.status === 'awaiting_confirmation' && task.confirmationQuestionId) {
      confirmRes = await runtime.confirmTask(PEER_LOCAL, {
        taskId: task.taskId,
        questionId: task.confirmationQuestionId,
        approved: true
      })
      stopAllRes = runtime.stopSessionSubtasks(PEER_LOCAL, { parentSessionKey: sessionKey, reason: 'p6v stop all' })
      for (let i = 0; i < 40; i++) {
        if (sink.countNonTerminalAgentRuns() === 0) break
        await new Promise((r) => setTimeout(r, 50))
      }
    }

    prepared.cleanup()
    const replay = sink.verifyReplayConsistency()
    return {
      ok: Boolean(task && stopCalls.length === 1 && replay.matches && sink.countNonTerminalAgentRuns() === 0),
      version,
      allowedToolsSeen,
      taskCreated: Boolean(task),
      taskStatusBeforeConfirm: task?.status ?? null,
      confirmRes,
      stopAllRes,
      stopCallsCount: stopCalls.length,
      nonTerminalAgentRuns: sink.countNonTerminalAgentRuns(),
      replayMatches: replay.matches,
      ...(replay.diff ? { replayDiff: replay.diff } : {})
    }
  } finally {
    await runtime?.close()
    sink.close()
  }
}

async function runSigkillRecovery(root: string, zhCwd: string) {
  const userDataDir = join(root, 'ud-sigkill')
  mkdirSync(userDataDir, { recursive: true })
  const proc = spawn(process.execPath, [process.argv[1]!, '--sigkill-child', userDataDir, zhCwd], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, LC_ALL: 'zh_CN.UTF-8' }
  })
  const taskId = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('sigkill helper timeout')), 15_000)
    let buf = ''
    let errBuf = ''
    proc.stdout!.on('data', (d) => {
      buf += d.toString()
      const m = buf.match(/READY:([^\n]+)/)
      if (m) { clearTimeout(timer); resolve(m[1]!.trim()) }
    })
    proc.stderr!.on('data', (d) => { errBuf += d.toString() })
    proc.once('exit', (code) => { clearTimeout(timer); reject(new Error(`helper exited early: ${code} ${errBuf}`)) })
  })
  const killed = new Promise<void>((r) => proc.once('exit', () => r()))
  proc.kill('SIGKILL')
  await killed

  const sink2 = EventSink.open({ userDataDir, authorizedActors: [PEER_LOCAL], fullfsync: false, checkpointFullfsync: false })
  try {
    const summary = recoverOrchestrationOnStartup({
      sink: sink2,
      leaseOwner: 'daemon:p6v-recovered',
      now: Date.now(),
      pendingTtlMs: 30_000
    })
    const taskAfter = sink2.getTask(taskId)
    const replay = sink2.verifyReplayConsistency()
    return {
      ok: Boolean(taskAfter && ['interrupted', 'unavailable'].includes(taskAfter.status) && replay.matches && sink2.countNonTerminalAgentRuns() === 0),
      taskId,
      taskStatusAfterRecovery: taskAfter?.status ?? null,
      recoverySummary: summary,
      nonTerminalAgentRuns: sink2.countNonTerminalAgentRuns(),
      replayMatches: replay.matches,
      ...(replay.diff ? { replayDiff: replay.diff } : {})
    }
  } finally {
    sink2.close()
  }
}

async function runSigkillChildMode(userDataDir: string, zhCwd: string) {
  const sink = EventSink.open({ userDataDir, authorizedActors: [PEER_LOCAL], fullfsync: false, checkpointFullfsync: false })
  submitActiveParentRun(sink, 'p6v-kill-parent', 'p6v-kill-sess', 'qoder', zhCwd)
  const rt = new DaemonDelegationRuntime({
    sink,
    currentTrustFingerprint: () => 'fp-k',
    hasLocalSubscriber: () => true,
    requestRunStop: () => true,
    dispatchChildRun: () => new Promise(() => {})
  })
  rt.setProjectPolicy(PEER_LOCAL, { cwd: zhCwd, enabled: true })
  const prep = await rt.prepareRunOrchestration({
    runId: 'p6v-kill-parent',
    canonicalRunId: 'p6v-kill-parent',
    providerId: 'qoder',
    cwd: zhCwd,
    sessionKey: 'p6v-kill-sess',
    permissionMode: 'default',
    via: 'local'
  })
  if (prep.orchestrationTools?.kind !== 'in_process') process.exit(2)
  await prep.orchestrationTools.callTool('scry_task_delegate', { task: '崩溃测试子任务', clientRequestId: 'k-1' })
  const t = rt.getState({ cwd: zhCwd, parentSessionKey: 'p6v-kill-sess' }).tasks[0]!
  await rt.confirmTask(PEER_LOCAL, { taskId: t.taskId, questionId: t.confirmationQuestionId!, approved: true })
  process.stdout.write(`READY:${t.taskId}\n`)
  setInterval(() => {}, 1000)
}

async function main() {
  if (process.argv[2] === '--sigkill-child') {
    await runSigkillChildMode(process.argv[3]!, process.argv[4]!)
    return
  }
  const root = mkdtempSync(join(tmpdir(), 'scry-p6-v-'))
  const zhCwd = join(root, '中文项目验证')
  mkdirSync(zhCwd, { recursive: true })
  writeFileSync(join(zhCwd, 'README.md'), '# 中文工作区测试\n')

  try {
    const meta = {
      at: new Date().toISOString(),
      os: `${platform()}-${arch()}`,
      locale: process.env.LC_ALL || process.env.LANG || 'zh_CN.UTF-8',
      zhCwd,
      mode: 'dev-isolated'
    }
    const sigkill = await runSigkillRecovery(root, zhCwd)
    const codex = await runCodexRealHost(root, zhCwd)
    const qoder = await runQoderRealHost(root, zhCwd)

    const report = { meta, sigkill, codex, qoder, allPassed: Boolean(sigkill.ok && codex.ok && qoder.ok) }
    const outPath = join(evidenceDir, 'p6-v-results.json')
    writeFileSync(outPath, JSON.stringify(report, null, 2))
    console.log(JSON.stringify(report, null, 2))
    if (!report.allPassed) process.exit(1)
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
