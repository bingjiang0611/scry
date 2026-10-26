#!/usr/bin/env node
import { type ParsedArgs, workspaceOf, flag, print, parseArgs } from './command-args.js'
import { collectSupportBundle } from './support-bundle.js'
import { resolve } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { RECORDER_VERSION } from '../core/turn-recorder/store.js'
import { upgradeCli, runBackgroundUpdate, shouldScheduleAutoUpdate, consumeUpdateNotice, scheduleBackgroundUpdate } from './update.js'
import { initCommand, statusCommand, integrationsCommand } from './workspace-commands.js'
import { commitHookCommand, recorderCommand } from './recorder-command.js'
import { recordsCommand, turnsCommand } from './records-command.js'
import { doctorCommand } from './doctor-command.js'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export type { ParsedArgs } from './command-args.js'
export { parseArgs } from './command-args.js'

function helpText(): string {
  return `Scry CLI\n\nUsage:\n  scry init [--providers claude,codex,qoder,opencode]\n  scry status [--workspace <root>]\n  scry commit-hook status|trust|revoke [--yes]\n  scry records archive --before <30d|ISO> [--out <dir>] [--yes]
  scry records maintain [--apply]\n  scry recorder hook|recover|notify-drain|start|serve|status|stop|restart [options]\n  scry recorder notify-retry (--sequence N | --all-dead) [--workspace <root>]\n  scry turns list|show|timeline|summary|export|content|verify [options]\n  scry doctor [--workspace <root>]\n  scry support-bundle create [--out <path>]\n  scry integrations install-pi|status-pi|diff|repair|uninstall [--yes]\n  scry upgrade [--check]\n  scry version\n\nOptions:\n  --workspace <root>   Workspace root (also accepts --workspace=<root>)\n  --providers <list>   Providers configured by init; otherwise auto-detected\n  --help, -h           Show help\n  --version            Show version\n`
}

/**
 * Archive a contiguous prefix of records. Refuses to archive anything the configured commit hook
 * has not acknowledged, because moving an undelivered record would silently drop it. Exit codes:
 * 0 done, 2 recorder unavailable, 3 approval required or nothing to archive, 5 refused.
 */
/** Report the capture settings actually in force, including defaults the config omits. */
/**
 * Sanitised diagnostics for a maintainer. Writes to --out when given, otherwise stdout; the
 * payload lists what it deliberately omits so a recipient can see the boundary.
 */
async function supportBundleCommand(args: ParsedArgs): Promise<number> {
  if (args.positionals[1] !== 'create') throw new Error('usage: scry support-bundle create [--out <path>]')
  const workspace = workspaceOf(args)
  const bundle = await collectSupportBundle(workspace)
  const out = flag(args, 'out')
  if (!out) {
    print(bundle)
    return bundle.recorder.enabled ? 0 : 2
  }
  const target = resolve(out)
  await writeFile(target, `${JSON.stringify(bundle, null, 2)}\n`, { mode: 0o600 })
  print({ action: 'support-bundle', status: 'written', path: target, omitted: bundle.omitted })
  return bundle.recorder.enabled ? 0 : 2
}

async function upgradeCommand(args: ParsedArgs): Promise<number> {
  if (process.env.SCRY_CLI_BUNDLED === '1') {
    print({
      status: 'managed_by_app',
      currentVersion: RECORDER_VERSION,
      message: 'Scry App 内置 CLI 随 App 一起升级'
    })
    return 0
  }
  const result = await upgradeCli({
    currentVersion: RECORDER_VERSION,
    entryPath: process.argv[1],
    checkOnly: args.flags.has('check'),
    allowBreaking: !args.flags.has('check')
  })
  print(result)
  return result.status === 'error' ? 1 : 0
}

export async function runScryCli(argv: string[]): Promise<number> {
  const args = parseArgs(argv)
  if (args.flags.has('version') || args.positionals[0] === 'version') {
    process.stdout.write(`${RECORDER_VERSION}\n`)
    return 0
  }
  if (args.flags.has('help') || args.positionals[0] === 'help' || args.positionals.length === 0) {
    process.stdout.write(helpText())
    return 0
  }
  switch (args.positionals[0]) {
    case '__auto_update':
      {
        const result = await runBackgroundUpdate(
          process.env.SCRY_UPDATE_CURRENT_VERSION ?? RECORDER_VERSION,
          process.argv[1]
        )
        if (result?.status === 'updated' && result.latestVersion) {
          process.stderr.write(`Scry CLI 已自动更新：${result.currentVersion} → ${result.latestVersion}\n`)
        }
        return 0
      }
    case 'init': return initCommand(args)
    case 'status': return statusCommand(args)
    case 'commit-hook': return commitHookCommand(args)
    case 'records': return recordsCommand(args)
    case 'support-bundle': return supportBundleCommand(args)
    case 'recorder': return recorderCommand(args)
    case 'turns': return turnsCommand(args)
    case 'doctor': return doctorCommand(args)
    case 'integrations': return integrationsCommand(args)
    case 'upgrade': return upgradeCommand(args)
    default:
      throw new Error('usage: scry init|status|commit-hook|records|support-bundle|recorder|turns|doctor|integrations|upgrade ...')
  }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  let parsedCliArgs: ParsedArgs
  try {
    parsedCliArgs = parseArgs(argv)
  } catch (error) {
    process.stderr.write(`scry: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
    return
  }
  const autoUpdateEligible = shouldScheduleAutoUpdate({
    command: parsedCliArgs.positionals[0],
    action: parsedCliArgs.positionals[1],
    noUpdateCheck: parsedCliArgs.flags.has('no-update-check'),
    stderrIsTTY: process.stderr.isTTY === true
  })
  try {
    if (autoUpdateEligible) {
      const notice = await consumeUpdateNotice()
      if (notice) process.stderr.write(`${notice}\n`)
    }
    process.exitCode = await runScryCli(argv)
  } catch (error) {
    process.stderr.write(`scry: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  } finally {
    if (autoUpdateEligible) await scheduleBackgroundUpdate(RECORDER_VERSION, process.argv[1])
  }
}

let isMain = false
try {
  isMain = !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
} catch {}
if (isMain) await main()
