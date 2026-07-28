import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configuredHookCommands, loadClaudeHookConfig, loadCodexHookConfig } from './hook-config'
import type { TraceEvent } from '../shared/trace'

const roots: string[] = []
const originalSources = process.env.SCRY_CLAUDE_SETTING_SOURCES

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  if (originalSources == null) delete process.env.SCRY_CLAUDE_SETTING_SOURCES
  else process.env.SCRY_CLAUDE_SETTING_SOURCES = originalSources
})

function hookEvent(name = 'PreToolUse:Bash'): TraceEvent {
  const event = name.split(':')[0]
  return {
    id: 'hook',
    ts: '',
    runId: 'run',
    kind: 'hook',
    stage: 'hook_response',
    hookEvent: event,
    hookName: name
  }
}

function writeSettings(root: string, content: unknown): void {
  mkdirSync(join(root, '.claude'), { recursive: true })
  writeFileSync(join(root, '.claude', 'settings.json'), JSON.stringify(content))
}

function installPlugin(home: string, pluginId: string, hookConfig: unknown): string {
  const installPath = join(home, '.claude', 'plugins', 'cache', pluginId.replace('@', '-'))
  mkdirSync(join(installPath, 'hooks'), { recursive: true })
  writeFileSync(join(installPath, 'hooks', 'hooks.json'), JSON.stringify(hookConfig))
  mkdirSync(join(home, '.claude', 'plugins'), { recursive: true })
  writeFileSync(
    join(home, '.claude', 'plugins', 'installed_plugins.json'),
    JSON.stringify({ version: 2, plugins: { [pluginId]: [{ scope: 'user', installPath, version: '1.0.0' }] } })
  )
  return installPath
}

describe('Claude Hook 配置反查', () => {
  it('按 event 和 matcher 合并 user/project 命令并保留来源', () => {
    const home = mkdtempSync(join(tmpdir(), 'scry-hook-home-'))
    const cwd = mkdtempSync(join(tmpdir(), 'scry-hook-project-'))
    roots.push(home, cwd)
    writeSettings(home, {
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'user-bash.sh', timeout: 15 }] },
          { matcher: 'Edit|Write', hooks: [{ type: 'command', command: 'user-edit.sh' }] }
        ]
      }
    })
    writeSettings(cwd, {
      hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'project-all.py', timeout: 5 }] }] }
    })

    const commands = configuredHookCommands(hookEvent(), loadClaudeHookConfig(cwd, home))

    expect(commands.map(({ command, source, matcher, timeoutSeconds }) => ({ command, source, matcher, timeoutSeconds }))).toEqual([
      { command: 'user-bash.sh', source: 'user', matcher: 'Bash', timeoutSeconds: 15 },
      { command: 'project-all.py', source: 'project', matcher: undefined, timeoutSeconds: 5 }
    ])
  })

  it('遵守 SCRY_CLAUDE_SETTING_SOURCES，不展示未加载 scope', () => {
    const home = mkdtempSync(join(tmpdir(), 'scry-hook-home-'))
    const cwd = mkdtempSync(join(tmpdir(), 'scry-hook-project-'))
    roots.push(home, cwd)
    writeSettings(home, { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'user-stop.sh' }] }] } })
    writeSettings(cwd, { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'project-stop.sh' }] }] } })
    process.env.SCRY_CLAUDE_SETTING_SOURCES = 'project'

    const commands = configuredHookCommands(hookEvent('Stop'), loadClaudeHookConfig(cwd, home))

    expect(commands.map((command) => command.command)).toEqual(['project-stop.sh'])
  })

  it('从已启用插件的安装记录加载 Hook，并展开 CLAUDE_PLUGIN_ROOT', () => {
    const home = mkdtempSync(join(tmpdir(), 'scry-hook-home-'))
    const cwd = mkdtempSync(join(tmpdir(), 'scry-hook-project-'))
    roots.push(home, cwd)
    const pluginId = 'security-guidance@claude-plugins-official'
    writeSettings(home, { enabledPlugins: { [pluginId]: true } })
    const installPath = installPlugin(home, pluginId, {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Edit|Write|MultiEdit',
            hooks: [{ type: 'command', command: 'python3 "${CLAUDE_PLUGIN_ROOT}/hooks/security_reminder_hook.py"' }]
          }
        ]
      }
    })

    const commands = configuredHookCommands(hookEvent('PreToolUse:Edit'), loadClaudeHookConfig(cwd, home))

    expect(commands).toEqual([
      {
        command: `python3 "${installPath}/hooks/security_reminder_hook.py"`,
        source: 'plugin',
        sourcePath: join(installPath, 'hooks', 'hooks.json'),
        matcher: 'Edit|Write|MultiEdit',
        pluginId
      }
    ])
  })

  it('不加载被更高优先级设置禁用的插件，也不扫描缓存猜测版本', () => {
    const home = mkdtempSync(join(tmpdir(), 'scry-hook-home-'))
    const cwd = mkdtempSync(join(tmpdir(), 'scry-hook-project-'))
    roots.push(home, cwd)
    const pluginId = 'security-guidance@claude-plugins-official'
    writeSettings(home, { enabledPlugins: { [pluginId]: true } })
    installPlugin(home, pluginId, {
      hooks: { PreToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'should-not-load.py' }] }] }
    })
    mkdirSync(join(cwd, '.claude'), { recursive: true })
    writeFileSync(join(cwd, '.claude', 'settings.local.json'), JSON.stringify({ enabledPlugins: { [pluginId]: false } }))

    const commands = configuredHookCommands(hookEvent('PreToolUse:Edit'), loadClaudeHookConfig(cwd, home))

    expect(commands).toEqual([])
  })
})

describe('Codex Hook 配置反查', () => {
  it('合并 user/project hooks.json，让未上报 command 的运行事件可展示候选命令', () => {
    const home = mkdtempSync(join(tmpdir(), 'scry-codex-hook-home-'))
    const cwd = mkdtempSync(join(tmpdir(), 'scry-codex-hook-project-'))
    roots.push(home, cwd)
    mkdirSync(join(home, '.codex'), { recursive: true })
    mkdirSync(join(cwd, '.codex'), { recursive: true })
    writeFileSync(join(home, '.codex', 'hooks.json'), JSON.stringify({
      hooks: {
        UserPromptSubmit: [
          { hooks: [{ type: 'command', command: 'user-prompt-a.py', timeout: 10 }] },
          { hooks: [{ type: 'command', command: 'user-prompt-b.py', timeout: 20 }] }
        ]
      }
    }))
    writeFileSync(join(cwd, '.codex', 'hooks.json'), JSON.stringify({
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'project-prompt.sh' }] }]
      }
    }))

    const commands = configuredHookCommands(
      hookEvent('UserPromptSubmit:command'),
      loadCodexHookConfig(cwd, home)
    )

    expect(commands.map(({ command, source, timeoutSeconds }) => ({ command, source, timeoutSeconds }))).toEqual([
      { command: 'user-prompt-a.py', source: 'user', timeoutSeconds: 10 },
      { command: 'user-prompt-b.py', source: 'user', timeoutSeconds: 20 },
      { command: 'project-prompt.sh', source: 'project', timeoutSeconds: undefined }
    ])
  })
})
