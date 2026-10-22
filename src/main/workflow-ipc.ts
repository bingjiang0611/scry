import type { WorkflowApproval } from '../shared/workflow'
import type { WorkflowService } from './workflow-service'
import { validateWorkflowRoleBinding } from './workflow-program'
import { workflowRecoveryCopy } from '../shared/constants/copy'

type Service = Pick<WorkflowService, 'planCommand' | 'preview' | 'findPreview' | 'approve' | 'start' | 'resume' | 'stop' | 'snapshot' | 'list' | 'cancelPlanning'>
const identity = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,96}$/.test(value)) throw new Error('工作流身份无效')
  return value
}
function approval(value: unknown): WorkflowApproval {
  if (!value || typeof value !== 'object') throw new Error('工作流确认请求无效')
  const input = value as Record<string, unknown>
  if (!Number.isSafeInteger(input.approvedAt) || (input.approvedAt as number) <= 0) throw new Error('工作流确认时间无效')
  return { workflowId: identity(input.workflowId), programRevision: identity(input.programRevision), approvedAt: input.approvedAt as number }
}

/** register must be the production trusted sender/frame/origin wrapper. */
export function registerWorkflowIpc({ register, service, resolveWorkspace, assertCurrentWorkspace }: {
  register: (channel: string, listener: (...args: unknown[]) => unknown) => void
  service: Service
  resolveWorkspace: (cwd: string) => string
  assertCurrentWorkspace: (cwd: string) => void
}): void {
  register('workflow:plan', payload => {
    if (!payload || typeof payload !== 'object') throw new Error('工作流计划请求无效')
    const value = payload as Record<string, unknown>
    if (typeof value.command !== 'string' || value.command.length > 16_000 || typeof value.cwd !== 'string' || value.cwd.length > 4096 || !value.cwd.trim()) throw new Error('工作流入口请求无效')
    const commandId = value.commandId === undefined ? undefined : identity(value.commandId)
    if (!Array.isArray(value.roles) || value.roles.length > 3) throw new Error('工作流角色配置无效')
    const orchestrator = validateWorkflowRoleBinding(value.orchestrator)
    if (orchestrator.role !== 'orchestrator') throw new Error('编排角色无效')
    const roles = value.roles.map((role, index) => validateWorkflowRoleBinding(role, index + 1))
    const workspace = resolveWorkspace(value.cwd)
    assertCurrentWorkspace(workspace)
    return service.planCommand({ command: value.command, commandId, workspace, orchestrator, roles })
  })
  register('workflow:preview', async workflowId => {
    const preview = await service.preview(identity(workflowId))
    resolveWorkspace(preview.workspace)
    return preview
  })
  register('workflow:approve', payload => service.approve(approval(payload)))
  register('workflow:start', (workflowId, payload) => {
    const accepted = approval(payload)
    if (identity(workflowId) !== accepted.workflowId) throw new Error('工作流确认不匹配')
    const commandId = (payload as Record<string, unknown>).commandId
    return service.start(accepted.workflowId, accepted, commandId === undefined ? undefined : identity(commandId))
  })
  register('workflow:resume', (workflowId, payload) => {
    const accepted = approval(payload)
    if (identity(workflowId) !== accepted.workflowId) throw new Error(workflowRecoveryCopy.fingerprint)
    const commandId = identity((payload as Record<string, unknown>).commandId)
    return (async () => {
      // Workspace authority comes from the frozen program, never a progress summary.
      const preview = await service.findPreview(accepted.workflowId)
      if (preview) resolveWorkspace(preview.workspace)
      return service.resume(accepted.workflowId, accepted, commandId)
    })()
  })
  register('workflow:stop', (workflowId, commandId) => service.stop(identity(workflowId), identity(commandId)))
  register('workflow:snapshot', async workflowId => {
    const progress = await service.snapshot(identity(workflowId))
    if (progress) resolveWorkspace(progress.workspace)
    return progress ?? null
  })
  register('workflow:list', (cwd, cursor) => {
    if (typeof cwd !== 'string' || cwd.length > 4096 || (cursor !== undefined && (typeof cursor !== 'string' || cursor.length > 101))) throw new Error('工作流列表请求无效')
    return service.list(resolveWorkspace(cwd), cursor as string | undefined)
  })
  register('workflow:cancelPlanning', commandId => service.cancelPlanning(identity(commandId)))
}
