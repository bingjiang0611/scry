import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { groupSessionsWithDelegatedChildren, type DelegatedTaskView } from '../../shared/delegation'
import { buildDelegationSwitchDialogOptions } from '../../main/delegation-policy-dialog'
import {
  DelegatedChildReadOnlyNotice,
  DelegatedUsageBreakdown,
  DelegationConfirmationCard,
  DelegationSwitchesSection,
  DelegationTaskCard,
  StopAllSubtasksButton
} from './DelegationPanel'

describe('P6-3 App UI components, sidebar nesting, and main native switch dialog', () => {
  it('groups delegated child sessions under their parent session', () => {
    const grouped = groupSessionsWithDelegatedChildren([
      { sessionKey: 'parent-1', title: 'Parent', parentSessionKey: null, lineageKind: null },
      { sessionKey: 'child-1', title: 'Subtask 1', parentSessionKey: 'parent-1', lineageKind: 'delegated' },
      { sessionKey: 'orphan-1', title: 'Other', parentSessionKey: null, lineageKind: null }
    ])
    expect(grouped).toHaveLength(2)
    expect(grouped[0]?.session.sessionKey).toBe('parent-1')
    expect(grouped[0]?.delegatedChildren.map((c) => c.sessionKey)).toEqual(['child-1'])
    expect(grouped[1]?.session.sessionKey).toBe('orphan-1')
    expect(grouped[1]?.delegatedChildren).toEqual([])
  })

  it('renders task card with status badge, permission mode/source, summary quality, and open-child action', () => {
    const task: DelegatedTaskView = {
      taskId: 't-1',
      parentSessionKey: 'parent-1',
      parentRunId: 'run-p1',
      childSessionKey: 'child-1',
      childRunId: 'run-c1',
      provider: 'codex',
      permissionMode: 'default',
      permissionModeSource: 'inherited',
      status: 'completed',
      stateVersion: 3,
      title: 'Inspect API',
      summary: { status: 'available', quality: 'inferred', value: 'Found 2 endpoints' }
    }
    const html = renderToStaticMarkup(<DelegationTaskCard task={task} onOpenChild={() => {}} />)
    expect(html).toContain('Inspect API')
    expect(html).toContain('codex')
    expect(html).toContain('Found 2 endpoints')
    expect(html).toContain('推断')
    expect(html).toContain('打开子会话')
    expect(html).toContain('class="badge"')
  })

  it('renders confirmation card with verb+object buttons and S8 risk notice', () => {
    const task: DelegatedTaskView = {
      taskId: 't-2',
      parentSessionKey: 'parent-1',
      parentRunId: 'run-p1',
      childSessionKey: null,
      childRunId: null,
      provider: 'qoder',
      permissionMode: 'auto_review',
      permissionModeSource: 'requested',
      status: 'awaiting_confirmation',
      stateVersion: 1,
      title: 'Run checks',
      confirmationQuestionId: 'q-confirm-2'
    }
    const html = renderToStaticMarkup(
      <DelegationConfirmationCard task={task} kind="delegate" onRespond={() => {}} />
    )
    expect(html).toContain('批准委派')
    expect(html).toContain('拒绝委派')
    expect(html).toContain('子任务输出仅作为数据返回')
  })

  it('renders read-only child notice, stop-all-subtasks button, parallel usage breakdown, and disabled remote switches', () => {
    const html = renderToStaticMarkup(
      <>
        <DelegatedChildReadOnlyNotice />
        <StopAllSubtasksButton activeSubtaskCount={2} onStopAll={() => {}} />
        <DelegatedUsageBreakdown
          usage={{
            status: 'partial',
            unavailableCount: 1,
            tokens: { exact: 12400, estimated: 3100 },
            usd: { exact: 0.15 },
            credits: {}
          }}
        />
        <DelegationSwitchesSection
          isLocalHost={false}
          projectDelegationEnabled={false}
          sessionFullAccessEnabled={false}
          onToggleProjectDelegation={() => {}}
          onToggleSessionFullAccess={() => {}}
        />
      </>
    )
    expect(html).toContain('只读')
    expect(html).toContain('停止全部子任务（2）')
    expect(html).toContain('12,400')
    expect(html).toContain('3,100')
    expect(html).toContain('1 个子任务的用量不可用')
    expect(html).toContain('disabled')
  })

  it('builds main-process native confirmation dialog with S8 warning and provider full_access copy', () => {
    const dlg = buildDelegationSwitchDialogOptions({
      switchKind: 'session_full_access',
      nextEnabled: true,
      targetLabel: 'Demo Session',
      providerFullAccessCopy: 'Codex danger-full-access'
    })
    expect(dlg.type).toBe('warning')
    expect(dlg.defaultId).toBe(1) // cancel by default!
    expect(dlg.detail).toContain('Codex danger-full-access')
    expect(dlg.detail).toContain('父 Agent')
  })
})
