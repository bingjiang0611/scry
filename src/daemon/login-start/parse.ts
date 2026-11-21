import { join } from 'node:path'
import type { LoginStartPolicyEntry } from '../../shared/background-service'
import { renderLaunchdPlist, renderSystemdUnit, type ServiceTemplateInput } from '../supervisor-templates'
import { isLoginStartPolicyEnvKey } from './policy-env'

// Strict parser for our rendered LaunchAgent plist and systemd --user unit (P5 §2.5).
// Ownership requires not only matching executable/asar/userData/env values, but also a
// byte-for-byte match when re-rendered with our template (W2 review S5): any extra key,
// non-empty cleared var, ExecStartPre=, XML comment, or modified directive is rejected as
// foreign rather than silently treated as ours.

export type ParsedServiceFile =
  | {
    kind: 'ours'
    label?: string
    executable: string
    supervisorEntry: string
    daemonEntry: string
    appPath: string
    resourcesPath: string
    userDataDir: string
    policyEnv: LoginStartPolicyEntry[]
  }
  | { kind: 'foreign' }

const FOREIGN: ParsedServiceFile = { kind: 'foreign' }

function unescapeXml(value: string): string {
  return value.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&')
}

function unescapeSystemdWords(line: string, expandDollar: boolean): string[] | undefined {
  const words: string[] = []
  let index = 0
  while (index < line.length) {
    while (index < line.length && line[index] === ' ') index += 1
    if (index >= line.length) break
    if (line[index] !== '"') return undefined
    index += 1
    let raw = ''
    let closed = false
    while (index < line.length) {
      const ch = line[index]!
      if (ch === '\\') {
        if (index + 1 >= line.length) return undefined
        raw += line[index + 1]!
        index += 2
        continue
      }
      if (ch === '"') {
        closed = true
        index += 1
        break
      }
      raw += ch
      index += 1
    }
    if (!closed) return undefined
    const unspec = raw.replaceAll('%%', '%')
    words.push(expandDollar ? unspec.replaceAll('$$', '$') : unspec)
  }
  return words
}

function extractCommon(
  executable: string,
  supervisorEntry: string,
  env: Map<string, string>,
  label?: string
): { parsed: Extract<ParsedServiceFile, { kind: 'ours' }>; templateInput: ServiceTemplateInput } | undefined {
  const electronRunAsNode = env.get('ELECTRON_RUN_AS_NODE')
  const launchedBy = env.get('SCRY_DAEMON_LAUNCHED_BY')
  const userDataDir = env.get('SCRY_DAEMON_USER_DATA_DIR')
  const stateDir = env.get('SCRY_DAEMON_STATE_DIR')
  const daemonEntry = env.get('SCRY_DAEMON_ENTRY')
  const appPath = env.get('SCRY_DAEMON_APP_PATH')
  const resourcesPath = env.get('SCRY_DAEMON_RESOURCES_PATH')
  const packagedRaw = env.get('SCRY_DAEMON_PACKAGED')
  if (
    !executable ||
    electronRunAsNode !== '1' ||
    launchedBy !== 'service' ||
    (packagedRaw !== '0' && packagedRaw !== '1') ||
    !userDataDir || !stateDir || !daemonEntry || !appPath || !resourcesPath
  ) {
    return undefined
  }
  if (stateDir !== join(userDataDir, 'daemon')) return undefined
  if (supervisorEntry !== join(appPath, 'out', 'main', 'daemon-supervisor.js')) return undefined
  if (daemonEntry !== join(appPath, 'out', 'main', 'daemon.js')) return undefined

  const policyEnv: LoginStartPolicyEntry[] = []
  const policyPairs: Array<[string, string]> = []
  for (const [key, value] of env.entries()) {
    if (isLoginStartPolicyEnvKey(key)) {
      policyEnv.push({ key, value })
      policyPairs.push([key, value])
    }
  }
  const templateInput: ServiceTemplateInput = {
    executable,
    supervisorEntry,
    daemonEntry,
    userDataDir,
    appPath,
    resourcesPath,
    isPackaged: packagedRaw === '1',
    ...(policyPairs.length > 0 ? { policyEnv: policyPairs } : {}),
    ...(label ? { label } : {})
  }
  return {
    parsed: {
      kind: 'ours',
      ...(label ? { label } : {}),
      executable,
      supervisorEntry,
      daemonEntry,
      appPath,
      resourcesPath,
      userDataDir,
      policyEnv
    },
    templateInput
  }
}

export function parseLaunchdPlist(content: string, expectedLabel: string): ParsedServiceFile {
  // Never match XML comments or hand-edited plists.
  if (content.includes('<!--')) return FOREIGN
  const labelMatch = content.match(/<key>Label<\/key>\s*<string>([^<]*)<\/string>/)
  if (!labelMatch) return FOREIGN
  const label = unescapeXml(labelMatch[1]!)
  if (label !== expectedLabel) return FOREIGN

  const argsBlock = content.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/)
  if (!argsBlock) return FOREIGN
  const args = [...argsBlock[1]!.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => unescapeXml(m[1]!))
  if (args.length !== 2) return FOREIGN

  const envBlock = content.match(/<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/)
  if (!envBlock) return FOREIGN
  const env = new Map<string, string>()
  for (const match of envBlock[1]!.matchAll(/<key>([^<]+)<\/key>\s*<string>([^<]*)<\/string>/g)) {
    const key = unescapeXml(match[1]!)
    if (env.has(key)) return FOREIGN
    env.set(key, unescapeXml(match[2]!))
  }
  const extracted = extractCommon(args[0]!, args[1]!, env, label)
  if (!extracted) return FOREIGN
  try {
    if (renderLaunchdPlist(extracted.templateInput) !== content) return FOREIGN
  } catch {
    return FOREIGN
  }
  return extracted.parsed
}

export function parseSystemdUnit(content: string): ParsedServiceFile {
  let section = ''
  let execArgs: string[] | undefined
  const env = new Map<string, string>()
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    if (line.startsWith('#') || line.startsWith(';')) return FOREIGN
    if (line.startsWith('[') && line.endsWith(']')) {
      section = line
      continue
    }
    if (section !== '[Service]') continue
    if (line.startsWith('ExecStart=')) {
      if (execArgs !== undefined) return FOREIGN
      const parsed = unescapeSystemdWords(line.slice('ExecStart='.length), true)
      if (!parsed || parsed.length !== 2) return FOREIGN
      execArgs = parsed
    } else if (line.startsWith('Environment=')) {
      const parsed = unescapeSystemdWords(line.slice('Environment='.length), false)
      if (!parsed || parsed.length !== 1) return FOREIGN
      const word = parsed[0]!
      const eq = word.indexOf('=')
      if (eq <= 0) return FOREIGN
      const key = word.slice(0, eq)
      if (env.has(key)) return FOREIGN
      env.set(key, word.slice(eq + 1))
    }
  }
  if (!execArgs) return FOREIGN
  const extracted = extractCommon(execArgs[0]!, execArgs[1]!, env)
  if (!extracted) return FOREIGN
  try {
    if (renderSystemdUnit(extracted.templateInput) !== content) return FOREIGN
  } catch {
    return FOREIGN
  }
  return extracted.parsed
}
