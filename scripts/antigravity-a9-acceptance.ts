import 'reflect-metadata'
import { execFileSync } from 'node:child_process'
import { randomUUID, webcrypto } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { cryptoProvider } from '@peculiar/x509'
import { createAntigravityAdapter } from '../src/main/providers/antigravity'
import type { AgentQuestionRequest, AgentQuestionResponse } from '../src/shared/runtime'
import type { TraceEvent } from '../src/shared/trace'
import { enrollAndCallLaunchdDaemon } from './antigravity-a9-launchd'

cryptoProvider.set(webcrypto as unknown as Parameters<typeof cryptoProvider.set>[0])

const EVIDENCE_DIR = join(homedir(), '.local/state/scry-handoff-evidence/W8')
mkdirSync(EVIDENCE_DIR, { recursive: true })

function saveEvidence(name: string, data: unknown): void {
  writeFileSync(join(EVIDENCE_DIR, name), `${JSON.stringify(data, null, 2)}\n`, 'utf8')
}

function psCommandLines(matchSubstr: string): string[] {
  try {
    const out = execFileSync('ps', ['-axo', 'pid,ppid,pgid,command'], { encoding: 'utf8' })
    return out.split('\n').filter((line) => line.includes(matchSubstr))
  } catch {
    return []
  }
}

function answerQuestion(
  req: AgentQuestionRequest,
  pick: (options: AgentQuestionRequest['questions'][number]['options']) => string | undefined
): AgentQuestionResponse {
  const q = req.questions[0]
  if (!q) return { behavior: 'cancelled' }
  const chosen = pick(q.options) ?? q.options[0]?.answerValue ?? q.options[0]?.label
  if (!chosen) return { behavior: 'cancelled' }
  return { behavior: 'answered', answers: { [q.question]: chosen } }
}

async function runOne(
  adapter: ReturnType<typeof createAntigravityAdapter>,
  opts: {
    cwd: string
    prompt: string
    permissionMode?: 'default' | 'auto_accept_edits' | 'full_access'
    resume?: string
    model?: { id: string }
    effort?: string
    historyReader?: { url: string; token: string; serverName: string }
    onEvent?: (event: TraceEvent, handle: ReturnType<ReturnType<typeof createAntigravityAdapter>['run']>) => void
    onQuestion?: (req: AgentQuestionRequest) => AgentQuestionResponse
  }
) {
  const events: TraceEvent[] = []
  const nativeEvents: Array<{ type: string; payload: unknown }> = []
  const questions: AgentQuestionRequest[] = []
  let externalSessionId: string | undefined
  const handle = adapter.run({
    runId: `a9-${randomUUID().slice(0, 8)}`,
    prompt: opts.prompt,
    cwd: opts.cwd,
    attachments: [],
    permissionMode: opts.permissionMode ?? 'default',
    resume: opts.resume,
    model: opts.model,
    effort: opts.effort,
    historyReader: opts.historyReader,
    emit: (event) => {
      events.push(event)
      opts.onEvent?.(event, handle)
    },
    recordNative: (type, payload) => {
      nativeEvents.push({ type, payload })
    },
    onExternalSessionId: (sid) => {
      externalSessionId = sid
    },
    requestUserInput: async (req) => {
      questions.push(req)
      if (opts.onQuestion) return opts.onQuestion(req)
      return answerQuestion(req, (options) =>
        options.find((o) => /reject|deny|拒绝/i.test(o.answerValue ?? '') || /reject|deny|拒绝/i.test(o.label))?.answerValue
      )
    }
  })
  const result = await handle.promise
  const text = events.filter((e) => e.kind === 'model' && e.stage === 'text_delta').map((e) => e.text ?? '').join('')
  const thinking = events.filter((e) => e.kind === 'model' && e.stage === 'thinking').map((e) => e.text ?? '').join('')
  const tools = events.filter((e) => e.kind === 'tool' && e.stage === 'tool_use').map((e) => ({ id: e.toolUseId, name: e.tool ?? e.name }))
  const resultEvent = [...events].reverse().find((e) => e.kind === 'harness' && e.stage === 'result')
  return {
    result,
    externalSessionId: externalSessionId ?? handle.getExternalSessionId(),
    text,
    thinkingLen: thinking.length,
    tools,
    questions,
    usage: resultEvent?.usage,
    costUsd: resultEvent?.costUsd ?? null,
    modelStatus: resultEvent?.modelStatus,
    usageCoverage: resultEvent?.usageCoverage,
    nativeCount: nativeEvents.length,
    eventsCount: events.length
  }
}

async function main() {
  const repoRoot = resolve(process.cwd())
  process.env.SCRY_EXPERIMENTAL_PROVIDERS = 'antigravity'
  const agyVersion = execFileSync('agy', ['--version'], { encoding: 'utf8' }).trim()
  const tmpRoot = mkdtempSync(join(tmpdir(), 'scry-a9-'))
  const userDataDir = join(tmpRoot, 'userData')
  const ws = join(tmpRoot, 'ws')
  const cleanGemini = join(tmpRoot, 'clean-gemini')
  mkdirSync(userDataDir, { recursive: true, mode: 0o700 })
  mkdirSync(ws, { recursive: true, mode: 0o700 })
  mkdirSync(cleanGemini, { recursive: true, mode: 0o700 })
  writeFileSync(join(ws, 'hello.txt'), 'SCRY_A9_FILE_CONTENT_7741\n', 'utf8')

  const summary: Record<string, unknown> = { agyVersion, startedAt: new Date().toISOString() }

  try {
    // 1. Catalog: real models + dynamic thought_level + permissions + commands
    const realAdapter = createAntigravityAdapter(homedir(), { userDataDir })
    const desc = realAdapter.describe()
    const controls = await realAdapter.runControls!.read({ providerId: 'antigravity', cwd: ws })
    const commands = await realAdapter.commands!.list({ providerId: 'antigravity', cwd: ws })
    const models = controls.data?.models ?? []
    const effortSets = new Set(models.map((m) => m.efforts.map((e) => e.id).join(',')))
    saveEvidence('a9-01-catalog.json', {
      describe: desc,
      state: controls.state,
      modelCount: models.length,
      sampleModels: models.map((m) => ({ id: m.model.id, label: m.label, description: m.description, efforts: m.efforts.map((e) => e.id) })),
      distinctEffortSetsCount: effortSets.size,
      permissions: controls.data?.permissions.map((p) => p.id),
      commandsState: commands.state,
      commandsCount: commands.data?.length ?? 0
    })
    summary.catalog = { state: controls.state, modelCount: models.length, distinctEffortSetsCount: effortSets.size }
    console.log('[A9 1/11] catalog:', JSON.stringify(summary.catalog))

    // 2. D3 user-level settings.json refusal (real ~/.gemini + isolated elevated settings.json)
    let realDefaultErr: string | null = null
    try {
      await runOne(realAdapter, { cwd: ws, prompt: 'say ok', permissionMode: 'default' })
    } catch (err) {
      realDefaultErr = err instanceof Error ? err.message : String(err)
    }
    const elevatedGemini = join(tmpRoot, 'elevated-gemini')
    mkdirSync(join(elevatedGemini, 'antigravity-cli'), { recursive: true, mode: 0o700 })
    writeFileSync(join(elevatedGemini, 'antigravity-cli', 'settings.json'), JSON.stringify({ toolPermission: 'auto' }), 'utf8')
    process.env.GEMINI_HOME = elevatedGemini
    process.env.SCRY_PROVIDER_ENV_ALLOW = 'antigravity:GEMINI_HOME'
    let elevatedErr: string | null = null
    try {
      await runOne(realAdapter, { cwd: ws, prompt: 'say ok', permissionMode: 'auto_accept_edits' })
    } catch (err) {
      elevatedErr = err instanceof Error ? err.message : String(err)
    }
    saveEvidence('a9-02-d3-refusal.json', { realDefaultErr, elevatedErr })
    summary.d3Refusal = {
      realDefaultRefused: Boolean(realDefaultErr?.includes('已拒绝启动 Antigravity')),
      elevatedRefused: Boolean(elevatedErr?.includes('已拒绝启动 Antigravity'))
    }
    console.log('[A9 2/11] d3Refusal:', JSON.stringify(summary.d3Refusal))

    // Switch to clean isolated GEMINI_HOME (real ~/.gemini untouched; Keychain auth still active)
    process.env.GEMINI_HOME = cleanGemini
    process.env.SCRY_PROVIDER_ENV_ALLOW = 'antigravity:GEMINI_HOME'
    const cleanAdapter = createAntigravityAdapter(homedir(), { userDataDir })
    const fastModel = models.find((m) => /flash/i.test(m.model.id))?.model ?? models[0]?.model

    // 3. Send + streaming + tools + usage
    const pickAllow = (req: AgentQuestionRequest) => answerQuestion(req, (opts) =>
      opts.find((o) => /allow|允许/i.test(o.answerValue ?? '') || /allow|允许/i.test(o.label))?.answerValue
    )
    const pickReject = (req: AgentQuestionRequest) => answerQuestion(req, (opts) =>
      opts.find((o) => /reject|deny|拒绝/i.test(o.answerValue ?? '') || /reject|deny|拒绝/i.test(o.label))?.answerValue
    )

    const run3 = await runOne(cleanAdapter, {
      cwd: ws,
      model: fastModel,
      permissionMode: 'default',
      prompt: 'Read the file hello.txt in the current directory and reply with ONLY its exact content.',
      onQuestion: pickAllow
    })
    saveEvidence('a9-03-run-stream-tools-usage.json', run3)
    summary.streamToolsUsage = {
      status: run3.result.status,
      containsFileContent: run3.text.includes('SCRY_A9_FILE_CONTENT_7741'),
      thinkingLen: run3.thinkingLen,
      toolsCount: run3.tools.length,
      usage: run3.usage,
      costUsd: run3.costUsd,
      modelStatus: run3.modelStatus,
      nativeCount: run3.nativeCount
    }
    console.log('[A9 3/11] streamToolsUsage:', JSON.stringify(summary.streamToolsUsage))

    // 4. Approvals: allow_once & reject_once
    const run4Allow = await runOne(cleanAdapter, {
      cwd: ws,
      model: fastModel,
      permissionMode: 'default',
      prompt: 'Run the shell command `echo A9_ALLOW_VERIFIED` using your shell/command tool and tell me its stdout.',
      onQuestion: pickAllow
    })
    const deniedFile = join(ws, 'must-not-exist.txt')
    const run4Deny = await runOne(cleanAdapter, {
      cwd: ws,
      model: fastModel,
      permissionMode: 'default',
      prompt: 'Run the shell command `echo BAD > must-not-exist.txt` using your shell/command tool.',
      onQuestion: pickReject
    })
    saveEvidence('a9-04-approvals.json', {
      allow: { status: run4Allow.result.status, questionsCount: run4Allow.questions.length, options: run4Allow.questions[0]?.questions[0]?.options, text: run4Allow.text.slice(0, 200) },
      deny: { status: run4Deny.result.status, questionsCount: run4Deny.questions.length, deniedFileExists: existsSync(deniedFile), text: run4Deny.text.slice(0, 200) }
    })
    summary.approvals = {
      allowAsked: run4Allow.questions.length > 0,
      allowOk: run4Allow.text.includes('A9_ALLOW_VERIFIED'),
      denyAsked: run4Deny.questions.length > 0,
      deniedFileExists: existsSync(deniedFile)
    }
    console.log('[A9 4/11] approvals:', JSON.stringify(summary.approvals))

    // 5. Question handling
    const run5Question = await runOne(cleanAdapter, {
      cwd: ws,
      model: fastModel,
      permissionMode: 'full_access',
      prompt: 'Do not run any commands or edit files. Use your ask_question tool right now to ask me one multiple-choice question with options "ALPHA" and "BETA", then repeat the option I picked.',
      onQuestion: (req) => answerQuestion(req, (opts) =>
        opts.find((o) => /alpha/i.test(o.label) || /alpha/i.test(o.answerValue ?? ''))?.answerValue
      )
    })
    saveEvidence('a9-05-question.json', {
      status: run5Question.result.status,
      questionsCount: run5Question.questions.length,
      questions: run5Question.questions,
      tools: run5Question.tools,
      text: run5Question.text.slice(0, 300)
    })
    summary.question = {
      questionsCount: run5Question.questions.length,
      tools: run5Question.tools.map((t) => t.name),
      replySample: run5Question.text.slice(0, 120)
    }
    console.log('[A9 5/11] question:', JSON.stringify(summary.question))

    // 6. Three permission modes real effect
    const run6DefaultWrite = await runOne(cleanAdapter, {
      cwd: ws,
      model: fastModel,
      permissionMode: 'default',
      prompt: 'Write the text "default-ok" to a new file named mode-default.txt in the current directory.',
      onQuestion: pickAllow
    })
    const run6AcceptEditsWrite = await runOne(cleanAdapter, {
      cwd: ws,
      model: fastModel,
      permissionMode: 'auto_accept_edits',
      prompt: 'Write the text "edits-ok" to a new file named mode-edits.txt in the current directory. Do not run shell commands.',
      onQuestion: pickAllow
    })
    const run6AcceptEditsCmd = await runOne(cleanAdapter, {
      cwd: ws,
      model: fastModel,
      permissionMode: 'auto_accept_edits',
      prompt: 'Run the shell command `echo EDITS_CMD_CHECK` using your shell/command tool.',
      onQuestion: pickReject
    })
    const run6FullAccess = await runOne(cleanAdapter, {
      cwd: ws,
      model: fastModel,
      permissionMode: 'full_access',
      prompt: 'Run the shell command `echo FULL_OK > mode-full.txt` using your shell/command tool and reply DONE.',
      onQuestion: pickReject
    })
    const modesEvidence = {
      defaultWrite: { permCount: run6DefaultWrite.questions.length, created: existsSync(join(ws, 'mode-default.txt')) },
      acceptEditsWrite: { permCount: run6AcceptEditsWrite.questions.length, created: existsSync(join(ws, 'mode-edits.txt')) },
      acceptEditsCmd: { permCount: run6AcceptEditsCmd.questions.length },
      fullAccessCmd: { permCount: run6FullAccess.questions.length, created: existsSync(join(ws, 'mode-full.txt')) }
    }
    saveEvidence('a9-06-modes.json', modesEvidence)
    summary.modes = modesEvidence
    console.log('[A9 6/11] modes:', JSON.stringify(modesEvidence))

    // 7. Stop with real child shell command (sleep 27) -> zero orphan process
    const uniqueSleep = 'sleep 27'
    let interruptedAtMs: number | null = null
    let sawSleepDuringRun = false
    const tStop0 = Date.now()
    const run7 = await runOne(cleanAdapter, {
      cwd: ws,
      model: fastModel,
      permissionMode: 'full_access',
      prompt: `Run the shell command \`${uniqueSleep}\` immediately using your shell/command tool.`,
      onEvent: (event, handle) => {
        if (!interruptedAtMs && event.kind === 'tool' && event.stage === 'tool_use') {
          setTimeout(() => {
            sawSleepDuringRun = psCommandLines(uniqueSleep).length > 0
            interruptedAtMs = Date.now() - tStop0
            handle.interrupt()
          }, 1500)
        }
      }
    })
    await new Promise((r) => setTimeout(r, 800))
    const remainingSleep = psCommandLines(uniqueSleep)
    saveEvidence('a9-07-stop.json', {
      status: run7.result.status,
      stopped: run7.result.stopped,
      interruptedAtMs,
      totalMs: Date.now() - tStop0,
      sawSleepDuringRun,
      remainingSleepCount: remainingSleep.length,
      remainingSleep
    })
    summary.stop = { status: run7.result.status, sawSleepDuringRun, remainingSleepCount: remainingSleep.length }
    console.log('[A9 7/11] stop:', JSON.stringify(summary.stop))

    // 8. Resume (recalls earlier context with zero replay)
    const run8a = await runOne(cleanAdapter, {
      cwd: ws,
      model: fastModel,
      permissionMode: 'full_access',
      prompt: 'Remember this exact secret code for our next turn: A9_RESUME_CODE_91827. Reply with only the word STORED.'
    })
    const run8b = await runOne(cleanAdapter, {
      cwd: ws,
      model: fastModel,
      permissionMode: 'full_access',
      resume: run8a.externalSessionId,
      prompt: 'What was the exact secret code I asked you to remember? Reply with ONLY the code.'
    })
    const resumeEvidence = {
      turn1SessionId: run8a.externalSessionId,
      turn1Text: run8a.text,
      turn2SessionId: run8b.externalSessionId,
      turn2Text: run8b.text,
      recalledCode: run8b.text.includes('A9_RESUME_CODE_91827'),
      zeroReplayOfStored: !run8b.text.includes('STORED')
    }
    saveEvidence('a9-08-resume.json', resumeEvidence)
    summary.resume = { recalledCode: resumeEvidence.recalledCode, zeroReplayOfStored: resumeEvidence.zeroReplayOfStored }
    console.log('[A9 8/11] resume:', JSON.stringify(summary.resume))

    // 9. Run-scoped History MCP injection + ps zero secret leak
    const upstreamSecret = 'UPSTREAM_SECRET_A9_NEVER_LEAK_88421'
    let upstreamHits = 0
    const upstream = createServer((_req, res) => {
      upstreamHits += 1
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } }))
    })
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()))
    const upstreamAddr = upstream.address() as { port: number }
    const psSnapshots: string[] = []
    try {
      const run9 = await runOne(cleanAdapter, {
        cwd: ws,
        model: fastModel,
        permissionMode: 'full_access',
        historyReader: {
          url: `http://127.0.0.1:${upstreamAddr.port}/mcp`,
          token: upstreamSecret,
          serverName: 'scry-history'
        },
        prompt: 'Reply with ONLY the word MCP_OK.',
        onEvent: () => {
          if (psSnapshots.length === 0) psSnapshots.push(...psCommandLines('agy'))
        }
      })
      const leakedInPs = psSnapshots.some((line) => line.includes(upstreamSecret) || line.includes('Bearer') || line.includes('scry-history'))
      saveEvidence('a9-09-mcp-zero-leak.json', {
        status: run9.result.status,
        text: run9.text,
        psSnapshotCount: psSnapshots.length,
        leakedInPs,
        upstreamHits,
        psSample: psSnapshots.slice(0, 3)
      })
      summary.mcpZeroLeak = { status: run9.result.status, psSnapshotCount: psSnapshots.length, leakedInPs }
      console.log('[A9 9/11] mcpZeroLeak:', JSON.stringify(summary.mcpZeroLeak))
    } finally {
      await new Promise<void>((r) => upstream.close(() => r()))
    }

    // 10. Chinese + space path with LANG=zh_CN.UTF-8
    const zhDir = join(tmpRoot, '测试 项目')
    mkdirSync(zhDir, { recursive: true, mode: 0o700 })
    writeFileSync(join(zhDir, '说明.txt'), '验收暗号：中文路径正常-2026\n', 'utf8')
    const savedLang = process.env.LANG
    process.env.LANG = 'zh_CN.UTF-8'
    try {
      const run10 = await runOne(cleanAdapter, {
        cwd: zhDir,
        model: fastModel,
        permissionMode: 'full_access',
        prompt: '读取当前目录下的 说明.txt，只原样回复文件内容。'
      })
      saveEvidence('a9-10-zh-path.json', {
        cwd: zhDir,
        status: run10.result.status,
        text: run10.text,
        matched: run10.text.includes('中文路径正常-2026')
      })
      summary.zhPath = { status: run10.result.status, matched: run10.text.includes('中文路径正常-2026') }
      console.log('[A9 10/11] zhPath:', JSON.stringify(summary.zhPath))
    } finally {
      if (savedLang === undefined) delete process.env.LANG
      else process.env.LANG = savedLang
    }

    // 11. Real Scry daemon started by macOS launchd LaunchAgent
    delete process.env.GEMINI_HOME
    delete process.env.SCRY_PROVIDER_ENV_ALLOW
    const launchdEvidence = await enrollAndCallLaunchdDaemon(repoRoot)
    saveEvidence('a9-11-launchd-daemon.json', launchdEvidence)
    summary.launchdDaemon = launchdEvidence
    console.log('[A9 11/11] launchdDaemon:', JSON.stringify(launchdEvidence))

    summary.finishedAt = new Date().toISOString()
    saveEvidence('a9-summary.json', summary)
    console.log('=== A9 ACCEPTANCE COMPLETE ===')
  } finally {
    delete process.env.GEMINI_HOME
    delete process.env.SCRY_PROVIDER_ENV_ALLOW
    rmSync(tmpRoot, { recursive: true, force: true })
  }
}

main().catch((err) => {
  console.error('A9 ACCEPTANCE FAILED:', err)
  process.exit(1)
})
