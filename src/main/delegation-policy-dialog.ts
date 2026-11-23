import type { BrowserWindow, MessageBoxOptions } from 'electron'

export interface DelegationSwitchConfirmRequest {
  switchKind: 'project_delegation' | 'session_full_access'
  nextEnabled: boolean
  /** Canonical target identifier (cwd or sessionKey) — never renderer-supplied display aliases. */
  targetLabel: string
  providerId?: string
}

const PROVIDER_FULL_ACCESS_COPY: Record<string, string> = {
  claude: '跳过 Claude Code 工具与命令权限确认（bypassPermissions），直接以本机用户权限执行',
  codex: '跳过 Codex 沙箱与审批（danger-full-access），直接以本机用户权限执行',
  qoder: '跳过 Qoder 工具与命令权限确认（bypassPermissions），直接以本机用户权限执行'
}

/**
 * Builds the native OS confirmation dialog payload for the two local-only P6 switches
 * (P6 security §S2): explains S8 ("父听子话") and the Provider's own full_access wording.
 */
export function buildDelegationSwitchDialogOptions(req: DelegationSwitchConfirmRequest): MessageBoxOptions {
  if (!req.nextEnabled) {
    return {
      type: 'question',
      buttons: ['关闭开关', '取消'],
      defaultId: 0,
      cancelId: 1,
      title: req.switchKind === 'project_delegation' ? '关闭 Agent 委派子任务' : '关闭子任务完全访问',
      message: `确认关闭「${req.targetLabel}」的此项开关？`,
      detail: '关闭仅影响尚未派发的子任务；已经派发运行中的子任务不会自动停止，可手动停止。'
    }
  }
  if (req.switchKind === 'project_delegation') {
    return {
      type: 'warning',
      buttons: ['开启委派', '取消'],
      defaultId: 1,
      cancelId: 1,
      title: '开启 Agent 委派子任务',
      message: `确认在项目「${req.targetLabel}」开启 Agent 委派子任务？`,
      detail:
        '子任务仍以本机用户权限运行（Scry 不是沙箱）。每次委派和取消仍需你在 Scry 中逐次确认；' +
        '子任务结果返回后，父 Agent 仍以其自身权限档位行动，权限上限挡不住父 Agent 采信子任务输出。'
    }
  }
  const providerCopy =
    (req.providerId && PROVIDER_FULL_ACCESS_COPY[req.providerId]) ||
    '本机完全访问（跳过该 Provider 的工具与命令审批，以本机用户权限执行）'
  return {
    type: 'warning',
    buttons: ['开启完全访问', '取消'],
    defaultId: 1,
    cancelId: 1,
    title: '开启子任务完全访问',
    message: `确认在会话「${req.targetLabel}」允许子任务使用完全访问权限？`,
    detail:
      `该 Provider 的完全访问说明：${providerCopy}。\n` +
      '开启后，子任务可在同一 Provider 内继承或请求完全访问，但每次委派仍需你在 Scry 中逐次确认；' +
      '子任务结果回到父 Agent 后，父 Agent 仍以其自身权限档位行动。'
  }
}

export async function confirmDelegationSwitchInMain(
  showMessageBox: (win: BrowserWindow | undefined, options: MessageBoxOptions) => Promise<{ response: number }>,
  win: BrowserWindow | undefined,
  req: DelegationSwitchConfirmRequest
): Promise<boolean> {
  const options = buildDelegationSwitchDialogOptions(req)
  const { response } = await showMessageBox(win, options)
  return response === 0
}
