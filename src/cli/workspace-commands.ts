import { type ParsedArgs, workspaceOf, flag, print } from './command-args.js'
import { initWorkspace, integrationsDiff, integrationsRepair, integrationsUninstall } from './workspace-init.js'
import { recorderEnablement, refreshRecorderPendingHealth } from '../core/turn-recorder/recorder.js'
import { readHealth, verifyStore } from '../core/turn-recorder/store.js'
import { relative } from 'node:path'
import { workspaceStatus } from './status.js'
import { installPiIntegration, piIntegrationStatus } from './pi-integration.js'


export async function initCommand(args: ParsedArgs): Promise<number> {
  const scriptPath = process.argv[1]
  if (!scriptPath) throw new Error('cannot locate scry CLI entrypoint')
  const result = await initWorkspace({
    workspace: workspaceOf(args),
    providers: flag(args, 'providers'),
    cliPath: scriptPath
  })
  const enablement = await recorderEnablement(result.workspace)
  if (!enablement.enabled) throw new Error(`recorder 初始化后仍不可用：${enablement.reason}${enablement.detail ? ` (${enablement.detail})` : ''}`)
  await refreshRecorderPendingHealth(enablement.dataRoot)
  const [health, store] = await Promise.all([readHealth(enablement.dataRoot), verifyStore(enablement.dataRoot)])
  const healthy = store.ok && !health.lastError && health.pendingCount === 0
  if (args.flags.has('json')) {
    print({ ...result, doctor: { healthy, health, store } })
    return store.ok ? 0 : 4
  }
  process.stdout.write(`Scry 已初始化：${result.workspace}\n`)
  process.stdout.write(`已配置 Provider：${result.providers.join('、')}\n`)
  process.stdout.write(`本次写入 ${result.changedFiles.length} 个文件，保留 ${result.unchangedFiles.length} 个未变化文件。\n`)
  for (const path of result.changedFiles) process.stdout.write(`  - ${relative(result.workspace, path) || path}\n`)
  if (!healthy) process.stdout.write('提醒：已有 pending 或错误记录；初始化已完成，请再运行 scry doctor 查看详情。\n')
  process.stdout.write('当前只确认配置和本地存储可用；Provider 是否真正加载 Hook，要在重启后执行一轮任务验证。\n')
  if (result.codexTrustRequired) process.stdout.write('Codex：重启后在这个项目中执行 /hooks，并信任项目 Hook。\n')
  process.stdout.write(`验证命令：scry turns list --workspace "${result.workspace}"\n`)
  return store.ok ? 0 : 4
}

/**
 * Six-stage provider matrix. Exit codes: 0 capturing or nothing to report, 2 recorder not
 * enabled for this workspace, 3 configured providers exist but no hook event has ever
 * arrived (or events arrived without a committed record).
 */
export async function statusCommand(args: ParsedArgs): Promise<number> {
  const report = await workspaceStatus(workspaceOf(args))
  print(report)
  if (!report.recorder.enabled) return 2
  const configured = report.providers.filter((row) => row.configured !== 'no')
  if (configured.length === 0) return 2
  return configured.some((row) => row.state === 'capturing') ? 0 : 3
}

export async function integrationsCommand(args: ParsedArgs): Promise<number> {
  const action = args.positionals[1]
  if (action === 'install-pi') {
    print(await installPiIntegration())
    return 0
  }
  if (action === 'status-pi') {
    const status = await piIntegrationStatus()
    print(status)
    return status.installed ? 0 : 1
  }
  if (action === 'diff') {
    const workspace = workspaceOf(args)
    const result = await integrationsDiff(workspace)
    print(result)
    const drift = result.providers.some((row) => row.duplicateEvents.length > 0 || (row.present && row.managedEvents.length > 0 && row.missingEvents.length > 0))
    return drift ? 3 : 0
  }
  if (action === 'repair') {
    const workspace = workspaceOf(args)
    if (!args.flags.has('yes')) {
      print({ action: 'repair', status: 'approval-required', ...await integrationsDiff(workspace), next: 're-run with --yes' })
      return 3
    }
    const scriptPath = process.argv[1]
    if (!scriptPath) throw new Error('cannot locate scry CLI entrypoint')
    const result = await integrationsRepair({ workspace, cliPath: scriptPath })
    print({ action: 'repair', status: result.providers.length === 0 ? 'nothing-installed' : 'done', ...result })
    return result.providers.length === 0 ? 3 : 0
  }
  if (action === 'uninstall') {
    const workspace = workspaceOf(args)
    if (!args.flags.has('yes')) {
      const plan = await integrationsDiff(workspace)
      print({
        action: 'uninstall',
        status: 'approval-required',
        ...plan,
        willRemove: 'managed hook entries, .opencode plugin (if managed), .scry/provider-hook.sh, .scry/cli-path, .scry/node-bin-dir',
        willRetain: 'scry.config.json, .scry/records, Git exclude entry, Pi user-global extension',
        next: 're-run with --yes'
      })
      return 3
    }
    print({ action: 'uninstall', status: 'done', ...await integrationsUninstall(workspace) })
    return 0
  }
  throw new Error('usage: scry integrations install-pi|status-pi|diff|repair|uninstall [--yes]')
}
