import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import '../../src/renderer/styles.css'
import '../../src/renderer/motion.css'
import '../../src/renderer/session-evidence.css'
import '../../src/renderer/inventory-evidence.css'
import '../../src/renderer/analytics-evidence.css'
import '../../src/renderer/codex-alignment.css'
import { PinnedSummaryHost, usePinnedSummaryVisibility } from '../../src/renderer/components/PinnedSummary'
import { OverviewPanel } from '../../src/renderer/components/OverviewPanel'
import { AssistantTurn } from '../../src/renderer/components/ChatTurn'
import { AskUserQuestionResult } from '../../src/renderer/components/AskUserQuestionDialog'
import { CliPicker, ModelEffortPicker, RunControlSelect } from '../../src/renderer/components/Pickers'
import { ViewChrome } from '../../src/renderer/components/ViewChrome'
import { qoderSkillSessionFixture } from '../../src/renderer/__fixtures__/session-capabilities'
import type { Turn } from '../../src/renderer/format'
import type { TraceEvent } from '../../src/shared/trace'
import { SidebarArchiveFixture } from './sidebar-archive-smoke'
import { PiCommandFixture } from './pi-command-smoke'

const piPickerFixtureCopy = { restore: '恢复历史 Profile' }

const answeredQuestionRequest = {
  runId: 'answered-run',
  questionId: 'answered-tool',
  questions: [
    { question: '是否继续修复 App 与独立 CLI 的 ACK 共存问题?', header: 'ACK', multiSelect: false, options: [{ label: '1', description: '继续修复' }] },
    { question: 'ACK 冲突时按哪个优先？', header: 'ACK', multiSelect: false, options: [{ label: '2', description: '按仓库' }] }
  ]
}

const thinkingTurn: Turn = {
  runId: 'thinking-run',
  userText: '这个接口有 mock 能力吗',
  done: true,
  items: [
    {
      id: 'thinking-event',
      runId: 'thinking-run',
      ts: '2026-09-08T00:00:00.000Z',
      kind: 'model',
      stage: 'thinking',
      thinking: "I need to find out about the code's mock capability."
    },
    {
      id: 'answer-event',
      runId: 'thinking-run',
      ts: '2026-09-08T00:00:01.000Z',
      kind: 'model',
      stage: 'text',
      text: '我查一下调用链和配置。'
    }
  ]
}

const contextSample: TraceEvent = {
  id: 'context-1', runId: 'context-live', ts: '2026-09-10T00:00:00Z', kind: 'harness', stage: 'context_usage',
  contextTokens: 100000, contextModel: 'ultimate', contextProvider: 'qoder', contextUsageQuality: 'exact',
  contextUsageSource: 'pi_rpc_assistant_usage',
  modelUsage: [{ model: 'ultimate', upstreamProvider: 'qoder', contextWindow: 272000 }]
}

const usageSample: TraceEvent = {
  id: 'usage-1', runId: 'context-live', ts: contextSample.ts, kind: 'harness', stage: 'usage_snapshot',
  tokensIn: 100, cacheReadTokens: 100, cacheCreationTokens: 0
}
const usageFixtureCopy = { finish: '接收最终用量与 Credit' }

function Fixture() {
  const [turns, setTurns] = useState<Turn[]>([qoderSkillSessionFixture()])
  const [selection, setSelection] = useState('none')
  const [clicks, setClicks] = useState(0)
  const [panelVisible, setPanelVisible] = useState(false)
  const [model, setModel] = useState('ultimate')
  const [effort, setEffort] = useState('default')
  const [permission, setPermission] = useState('default')
  const [agentId, setAgentId] = useState('qoder')
  const [composerMenu, setComposerMenu] = useState<'permission' | 'agent' | 'modelEffort' | null>(null)
  const pinnedSummary = usePinnedSummaryVisibility(true, panelVisible)
  const select = (event: TraceEvent) => {
    setClicks((value) => value + 1)
    setSelection(JSON.stringify({ id: event.id, kind: event.kind, tool: event.tool, source: (event.input as { source?: string } | undefined)?.source ?? null }))
  }
  return <>
    <button id="hooks" onClick={() => setTurns([{
      runId: 'hook-run', userText: '检查 Hook 展开', done: true,
      items: [
        { id: 'hook-start', runId: 'hook-run', ts: '2026-09-09T00:00:00.000Z', kind: 'hook', stage: 'hook_started', hookId: 'h1', hookEvent: 'Stop', hookCommand: 'test-hook' },
        { id: 'hook-end', runId: 'hook-run', ts: '2026-09-09T00:00:01.000Z', kind: 'hook', stage: 'hook_response', hookId: 'h1', hookEvent: 'Stop', hookCommand: 'test-hook', hookOutcome: 'success' }
      ]
    }])}>Hook 明细</button>
    <button id="context-start" onClick={() => setTurns([{
      runId: 'context-live', userText: 'context probe', done: false, items: [contextSample, usageSample]
    }])}>开始上下文采样</button>
    <button id="context-update" onClick={() => setTurns((current) => current.map((turn) => ({
      ...turn, items: [...turn.items, { ...contextSample, id: 'context-2', contextTokens: 201600 },
        { ...usageSample, id: 'usage-2', cacheReadTokens: 300 }]
    })))}>收到下一请求用量</button>
    <button id="context-compact" onClick={() => setTurns((current) => current.map((turn) => ({
      ...turn, items: [...turn.items, {
        id: 'context-compact', runId: turn.runId, ts: '2026-09-10T00:00:01Z', kind: 'harness',
        stage: 'context_compaction', compaction: { trigger: 'auto', preTokens: 201600 }
      }]
    })))}>压缩完成</button>
    <button id="context-after" onClick={() => setTurns((current) => current.map((turn) => ({
      ...turn, items: [...turn.items, { ...contextSample, id: 'context-3', contextTokens: 20000 }]
    })))}>收到压缩后用量</button>
    <button id="usage-finish" onClick={() => setTurns((current) => current.map((turn) => ({
      ...turn, done: true, items: [...turn.items,
        { ...usageSample, id: 'usage-final', stage: 'result', tokensIn: 200, cacheReadTokens: 300, upstreamProvider: 'qoder' },
        { id: 'credit-final', runId: turn.runId, ts: usageSample.ts, kind: 'harness', stage: 'credit_usage',
          creditUsage: { status: 'partial', quality: 'exact', source: ['pi_qoder_credit_observation'],
            value: { provider: 'qoder', unit: 'credits', scope: 'main', amount: 2.5, knownRequests: 1, missingRequests: 0 },
            omissionReason: 'Only observed main-session requests are covered.' } }
      ]
    })))}>{usageFixtureCopy.finish}</button>
    <button id="empty" onClick={() => setTurns([])}>新会话</button>
    <button id="pending" onClick={() => setTurns([qoderSkillSessionFixture('pending-run', 'pending')])}>读取中</button>
    <button id="success" onClick={() => setTurns([qoderSkillSessionFixture('pending-run', 'success')])}>收到成功结果</button>
    <button id="failed" onClick={() => setTurns([qoderSkillSessionFixture('failed-run', 'failed')])}>另一个失败会话</button>
    <button id="multi" onClick={() => setTurns([qoderSkillSessionFixture('run-1'), qoderSkillSessionFixture('run-2')])}>两轮历史</button>
    <section id="chrome">
      <ViewChrome
        cwd={null}
        agent={undefined}
        showSummary={pinnedSummary.visible}
        showPanel={panelVisible}
        onToggleSummary={pinnedSummary.toggle}
        onTogglePanel={() => setPanelVisible((current) => !current)}
      />
    </section>
    <output id="selection" data-clicks={clicks}>{selection}</output>
    <section id="pinned">
      <PinnedSummaryHost
        visible={pinnedSummary.visible}
        cwd={null}
        gitDiff={undefined}
        turns={turns}
        busy={false}
        temporary={!pinnedSummary.persistent}
        onDismiss={pinnedSummary.dismiss}
        onOpenCall={(_runId, event) => select(event)}
        onOpenAgents={() => undefined}
      />
    </section>
    <section id="thinking"><AssistantTurn turn={thinkingTurn} selectedId={null} onSelect={() => undefined} /></section>
    <section id="question-result" className="main-area" style={{ width: 820 }}>
      <div className="chat-body">
        <div className="tool-group-body">
          <div className="tool-card">
            <AskUserQuestionResult
              request={answeredQuestionRequest}
              answers={{
                '是否继续修复 App 与独立 CLI 的 ACK 共存问题?': '1',
                'ACK 冲突时按哪个优先？': '按 canonical cwd 优先：同一个仓库只认 App 写入的那一份，CLI 只读取并在缺失时补写；跨仓库的临时目录不共享 ACK，避免 /tmp 下不同 repo 的锁互相覆盖。'
              }}
              output='{"behavior":"answered"}'
              durationMs={409000}
            />
          </div>
          <div className="tool-card">
            <AskUserQuestionResult request={answeredQuestionRequest} resolution="user_cancelled" />
          </div>
        </div>
      </div>
    </section>
    <PiCommandFixture />
    <section id="model-effort" className="runtime-composer">
      <div className="composer-controls">
        <RunControlSelect
          ariaLabel="权限"
          value={permission}
          options={[
            { value: 'default', label: '默认审批', description: '危险操作会暂停并请求你的确认' },
            { value: 'auto_review', label: '自动审查', description: '由 Provider 的原生审查器判断是否放行' },
            { value: 'full_access', label: '完全访问', description: '跳过审批并允许 Agent 直接执行操作' }
          ]}
          tone={permission === 'full_access' ? 'danger' : undefined}
          onChange={setPermission}
          open={composerMenu === 'permission'}
          onOpenChange={(open) => setComposerMenu(open ? 'permission' : null)}
        />
      </div>
      <div className="composer-action-controls">
        <CliPicker
          agents={[
            { id: 'qoder', name: 'Qoder', bin: 'qodercli', path: '/fixture/qodercli' },
            { id: 'pi:rotom', name: 'Rotom', bin: 'rotom', path: '/fixture/rotom', version: '0.1.26' },
            { id: 'pi:564f7a994e4e34da', name: 'Rotom', bin: 'rotom', path: '/fixture/rotom', version: '0.1.26' },
            { id: 'pi:1234567890abcdef', name: 'Rotom', bin: 'rotom', path: '/fixture/another-rotom', version: '0.1.26' }
          ]}
          selectedId={agentId}
          onSelect={setAgentId}
          onAddPi={() => undefined}
          onRemovePi={() => undefined}
          onRescan={() => undefined}
          open={composerMenu === 'agent'}
          onOpenChange={(open) => setComposerMenu(open ? 'agent' : null)}
        />
        <ModelEffortPicker
          modelValue={model}
          modelOptions={[
            { value: '', label: '自动模型' },
            { value: 'ultimate', label: 'Ultimate' },
            { value: 'performance', label: 'Performance' }
          ]}
          effortValue={effort}
          open={composerMenu === 'modelEffort'}
          onOpenChange={(open) => setComposerMenu(open ? 'modelEffort' : null)}
          effortOptions={[
            { value: 'default', label: '默认' },
            { value: 'xhigh', label: '极高' },
            { value: 'high', label: '高' },
            { value: 'low', label: '低' },
            { value: 'max', label: '最大' },
            { value: 'medium', label: '中' }
          ]}
          onModelChange={(value) => {
            setModel(value)
            setEffort('default')
          }}
          onEffortChange={setEffort}
        />
      </div>
    </section>
    <button id="restore-pi-profile" onClick={() => { setAgentId('pi:564f7a994e4e34da'); setComposerMenu(null) }}>
      {piPickerFixtureCopy.restore}
    </button>
    <SidebarArchiveFixture />
    <section id="overview"><OverviewPanel turns={turns} sessionId={turns[0]?.runId === 'fixture-run' ? '01a10000-1111-7000-8000-00000000abcd' : turns[0]?.runId ?? null} busy={turns.some((turn) => !turn.done)} selected={null} onSelect={select} usage={null} stats={null} /></section>
  </>
}
createRoot(document.getElementById('root')!).render(<Fixture />)
