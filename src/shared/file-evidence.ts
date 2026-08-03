import type { TraceEvent } from './trace.js'

function shellCommands(source: string): string[][] {
  const commands: string[][] = []
  let words: string[] = []
  let current = ''
  let quote = ''
  let escaped = false
  const flushWord = (): void => {
    if (current) words.push(current)
    current = ''
  }
  const flushCommand = (): void => {
    flushWord()
    if (words.length) commands.push(words)
    words = []
  }
  for (const char of source) {
    if (escaped) {
      current += char
      escaped = false
      continue
    }
    if (char === '\\' && quote !== "'") {
      escaped = true
      continue
    }
    if (quote) {
      if (char === quote) quote = ''
      else current += char
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      continue
    }
    if (/[\n;|&()]/.test(char)) {
      flushCommand()
      continue
    }
    if (/\s/.test(char)) {
      flushWord()
      continue
    }
    current += char
  }
  flushCommand()
  return commands
}

function concreteFileArg(value: string): boolean {
  return !!value &&
    value !== '-' &&
    !value.startsWith('-') &&
    !/[<>*?[\]{}$]/.test(value) &&
    !/^(?:https?|data):/i.test(value) &&
    !value.startsWith('/dev/')
}

function grepReadFiles(args: string[]): string[] {
  const files: string[] = []
  let patternSeen = false
  const optionsWithValue = new Set([
    '-A', '-B', '-C', '-D', '-d', '-e', '-f', '-g', '-m', '-r', '-t',
    '--after-context', '--before-context', '--binary-files', '--context',
    '--devices', '--encoding', '--engine', '--exclude', '--exclude-dir',
    '--file', '--glob', '--include', '--max-count', '--max-depth',
    '--path-separator', '--pre', '--pre-glob', '--regexp', '--replace',
    '--sort', '--sortr', '--type', '--type-add'
  ])
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '-e' || arg === '--regexp') {
      patternSeen = true
      i++
    } else if (arg === '-f' || arg === '--file') {
      const patternFile = args[++i]
      if (patternFile && concreteFileArg(patternFile)) files.push(patternFile)
      patternSeen = true
    } else if (optionsWithValue.has(arg)) {
      i++
    } else if (!arg.startsWith('-') && !patternSeen) {
      patternSeen = true
    } else if (concreteFileArg(arg)) {
      files.push(arg)
    }
  }
  return files
}

function sedReadFiles(args: string[]): string[] {
  if (args.some((arg) => arg === '-i' || arg.startsWith('--in-place') || /^-i.+/.test(arg))) return []
  const files: string[] = []
  let scriptSeen = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '-e' || arg === '--expression') {
      scriptSeen = true
      i++
    } else if (arg === '-f' || arg === '--file') {
      const scriptFile = args[++i]
      if (scriptFile && concreteFileArg(scriptFile)) files.push(scriptFile)
      scriptSeen = true
    } else if (!arg.startsWith('-') && !scriptSeen) {
      scriptSeen = true
    } else if (concreteFileArg(arg)) {
      files.push(arg)
    }
  }
  return files
}

function commandReadFiles(words: string[]): string[] {
  let commandIndex = 0
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[commandIndex] ?? '')) commandIndex++
  if ((words[commandIndex] ?? '').split('/').pop() === 'env') {
    commandIndex++
    while ((words[commandIndex] ?? '').startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[commandIndex] ?? '')) commandIndex++
  }
  if ((words[commandIndex] ?? '').split('/').pop() === 'command') commandIndex++
  const command = (words[commandIndex] ?? '').split('/').pop() ?? ''
  const args = words.slice(commandIndex + 1)

  if (['sh', 'bash', 'zsh'].includes(command)) {
    const commandFlag = args.findIndex((arg) => /^-[A-Za-z]*c[A-Za-z]*$/.test(arg))
    return commandFlag >= 0 && args[commandFlag + 1] ? bashReadTargets(args[commandFlag + 1]) : []
  }
  if (command === 'sed') return sedReadFiles(args)
  if (command === 'grep' || command === 'rg') {
    return command === 'rg' && args.includes('--files') ? [] : grepReadFiles(args)
  }
  if (!['cat', 'head', 'tail', 'nl', 'less', 'more', 'wc'].includes(command)) return []

  const files: string[] = []
  const optionsWithValue = ['head', 'tail'].includes(command)
    ? new Set(['-n', '-c', '--lines', '--bytes'])
    : new Set<string>()
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (optionsWithValue.has(arg)) i++
    else if (concreteFileArg(arg)) files.push(arg)
  }
  return files
}

function bashReadTargets(command: string): string[] {
  const files = new Set<string>()
  for (const words of shellCommands(command)) {
    for (const path of commandReadFiles(words)) files.add(path)
  }
  return [...files].slice(0, 64)
}

function looksLikeConcreteFilePath(path: string): boolean {
  const base = path.replace(/\\/g, '/').split('/').pop() ?? ''
  if (!base || base === '.' || base === '..') return false
  if (/^[^.].*\.[A-Za-z0-9_-]{1,16}$/.test(base)) return true
  if (base.startsWith('.') && base.slice(1).includes('.')) return true
  return new Set([
    '.bash_history', '.editorconfig', '.env', '.gitignore', '.npmrc', '.zsh_history',
    'Dockerfile', 'Gemfile', 'LICENSE', 'Makefile', 'NOTICE', 'README', 'Rakefile'
  ]).has(base)
}

// Codex 常把读取落成 Bash commandExecution。只识别明确的只读命令和
// 具体文件形态，不把 rg 的 pattern、glob 或目录冒充文件；返回值以 ~R 展示。
export function bashReadFiles(command: string): string[] {
  return bashReadTargets(command).filter(looksLikeConcreteFilePath)
}

function normalizeTracePath(value: string): string {
  const slashed = value.replace(/\\/g, '/').replace(/\/+/g, '/')
  const drive = slashed.match(/^[A-Za-z]:/)?.[0] ?? ''
  const absolute = slashed.startsWith('/') || !!drive
  const rest = drive ? slashed.slice(drive.length) : slashed
  const parts: string[] = []
  for (const part of rest.split('/')) {
    if (!part || part === '.') continue
    if (part === '..' && parts.length && parts.at(-1) !== '..') parts.pop()
    else if (part !== '..' || !absolute) parts.push(part)
  }
  return `${drive}${absolute && !drive ? '/' : drive ? '/' : ''}${parts.join('/')}` || (absolute ? '/' : '.')
}

function inferredPath(
  path: string,
  cwd: string | undefined,
  candidates: string[]
): { path: string; matchedCandidate: boolean } {
  const normalized = normalizeTracePath(path)
  const isAbsolute = normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)
  const resolved = !isAbsolute && cwd ? normalizeTracePath(`${cwd}/${normalized}`) : normalized
  const exact = candidates.find((candidate) => {
    const value = normalizeTracePath(candidate)
    return value === normalized || value === resolved
  })
  if (exact) return { path: exact, matchedCandidate: true }
  const suffixMatches = candidates.filter((candidate) => {
    const value = normalizeTracePath(candidate)
    return value.endsWith(`/${normalized}`) || resolved.endsWith(`/${value}`)
  })
  return suffixMatches.length === 1
    ? { path: suffixMatches[0], matchedCandidate: true }
    : { path: resolved, matchedCandidate: false }
}

export function inferredReadPathsFromCommand(
  command: string,
  cwd: string | undefined,
  candidates: string[]
): string[] {
  return bashReadTargets(command)
    .map((path) => inferredPath(path, cwd, candidates))
    .filter((result) => result.matchedCandidate || looksLikeConcreteFilePath(result.path))
    .map((result) => result.path)
}

export function inferredReadPaths(event: TraceEvent, candidates: string[]): string[] {
  if (event.tool !== 'Bash' || event.stage === 'tool_result') return []
  const input = event.input as Record<string, unknown> | undefined
  if (typeof input?.command !== 'string') return []
  const cwd = typeof input.cwd === 'string' ? input.cwd : undefined
  return inferredReadPathsFromCommand(input.command, cwd, candidates)
}
