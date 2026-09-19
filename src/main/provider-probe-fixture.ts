import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const inheritedEnvironmentKeys = [
  'PATH', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TERM',
  'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL'
] as const

export interface ClaudeProbeFixture {
  root: string
  cwd: string
  env: Record<string, string>
  cleanup: () => Promise<void>
}

export async function createClaudeProbeFixture(): Promise<ClaudeProbeFixture> {
  const root = await mkdtemp(join(tmpdir(), 'scry-claude-probe-'))
  const cwd = join(root, 'workspace')
  const home = join(root, 'home')
  await Promise.all([
    mkdir(cwd, { recursive: true }),
    mkdir(home, { recursive: true }),
    mkdir(join(root, 'tmp'), { recursive: true }),
    mkdir(join(root, 'claude-config'), { recursive: true }),
    mkdir(join(root, 'xdg-config'), { recursive: true }),
    mkdir(join(root, 'xdg-data'), { recursive: true }),
    mkdir(join(root, 'xdg-state'), { recursive: true })
  ])
  await writeFile(join(cwd, 'package.json'), '{"name":"scry-provider-probe","private":true}\n')
  const env: Record<string, string> = {
    HOME: home,
    TMPDIR: join(root, 'tmp'),
    CLAUDE_CONFIG_DIR: join(root, 'claude-config'),
    XDG_CONFIG_HOME: join(root, 'xdg-config'),
    XDG_DATA_HOME: join(root, 'xdg-data'),
    XDG_STATE_HOME: join(root, 'xdg-state'),
    SCRY_NO_UPDATE_CHECK: '1'
  }
  // Provider probes may use an explicitly supplied credential, but never inherit the
  // test runner's unrelated secrets, agent nesting flags, or project configuration.
  for (const key of inheritedEnvironmentKeys) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }

  return {
    root,
    cwd,
    env,
    cleanup: () => rm(root, { recursive: true, force: true })
  }
}

