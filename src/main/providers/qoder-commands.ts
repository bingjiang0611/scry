import { lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'

export const MAX_PROJECT_COMMAND_BYTES = 256 * 1024

function missingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

export function projectCommandMatch(prompt: string): RegExpMatchArray | null {
  return prompt.match(/^\/([A-Za-z0-9][A-Za-z0-9._-]*)(?:[ \t]+([\s\S]*))?$/)
}

function commandBody(source: string): string {
  const normalized = source.replace(/^\uFEFF/, '')
  const frontmatter = normalized.match(/^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/)
  return normalized.slice(frontmatter?.[0].length ?? 0).trim()
}

function positionalArgs(source: string): string[] {
  const args: string[] = []
  let current = ''
  let quote: '"' | "'" | undefined
  let started = false
  for (let index = 0; index < source.length; index++) {
    const char = source[index]
    if (quote) {
      if (char === quote) {
        quote = undefined
      } else if (char === '\\' && quote === '"' && index + 1 < source.length) {
        current += source[++index]
      } else {
        current += char
      }
      started = true
      continue
    }
    if (/\s/.test(char)) {
      if (started) {
        args.push(current)
        current = ''
        started = false
      }
    } else if (char === '"' || char === "'") {
      quote = char
      started = true
    } else if (char === '\\' && index + 1 < source.length) {
      current += source[++index]
      started = true
    } else {
      current += char
      started = true
    }
  }
  if (started) args.push(current)
  return args
}

function applyCommandArgs(body: string, rawArgs: string): string {
  const args = positionalArgs(rawArgs)
  let replaced = false
  let expanded = body.replace(/\$ARGUMENTS\[(\d+)\]/g, (_match, rawIndex: string) => {
    replaced = true
    return args[Number(rawIndex)] ?? ''
  })
  expanded = expanded.replace(/\$(\d+)/g, (_match, rawIndex: string) => {
    replaced = true
    return args[Number(rawIndex)] ?? ''
  })
  expanded = expanded.replace(/\$ARGUMENTS/g, () => {
    replaced = true
    return rawArgs
  })
  return rawArgs && !replaced ? `${expanded}\n\nARGUMENTS: ${rawArgs}` : expanded
}

export async function expandQoderProjectCommand(prompt: string, cwd?: string): Promise<string> {
  const match = cwd ? projectCommandMatch(prompt) : null
  if (!cwd || !match) return prompt

  const qoderDir = join(cwd, '.qoder')
  const commandsDir = join(qoderDir, 'commands')
  const commandPath = join(commandsDir, `${match[1]}.md`)
  let qoderStat
  let commandsStat
  let commandStat
  try {
    [qoderStat, commandsStat, commandStat] = await Promise.all([
      lstat(qoderDir),
      lstat(commandsDir),
      lstat(commandPath)
    ])
  } catch (error) {
    if (missingFile(error)) return prompt
    throw error
  }
  if (qoderStat.isSymbolicLink() || !qoderStat.isDirectory() ||
      commandsStat.isSymbolicLink() || !commandsStat.isDirectory() ||
      commandStat.isSymbolicLink() || !commandStat.isFile()) {
    throw new Error(`Qoder 项目命令不是安全的常规文件：${commandPath}`)
  }
  if (commandStat.size > MAX_PROJECT_COMMAND_BYTES) {
    throw new Error(`Qoder 项目命令超过 ${MAX_PROJECT_COMMAND_BYTES} 字节：${commandPath}`)
  }
  const body = commandBody(await readFile(commandPath, 'utf8'))
  if (!body) throw new Error(`Qoder 项目命令内容为空：${commandPath}`)
  return applyCommandArgs(body, (match[2] ?? '').trim())
}
