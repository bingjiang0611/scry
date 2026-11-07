export const CODEX_APP_BIN = '/Applications/ChatGPT.app/Contents/Resources/codex'

export function isAcceptedQoderPath(path: string): boolean {
  return !!path && path.endsWith('/qodercli')
}

export function selectQoderBinCandidate(args: { configured?: string; onPath?: string }): string | undefined {
  if (args.configured && isAcceptedQoderPath(args.configured)) return args.configured
  if (args.onPath && isAcceptedQoderPath(args.onPath)) return args.onPath
  return undefined
}

export function selectCodexBinCandidate(args: {
  configured?: string
  configuredExists?: boolean
  onPath?: string
  appBin?: string
  appBinExists?: boolean
}): string | undefined {
  if (args.configured && args.configuredExists) return args.configured
  if (args.onPath) return args.onPath
  return args.appBinExists ? (args.appBin ?? CODEX_APP_BIN) : undefined
}

export function selectClaudeBinCandidate(args: {
  configured?: string
  configuredExists?: boolean
  native: string
  nativeExists: boolean
  onPath?: string
}): string | undefined {
  if (args.configured && args.configuredExists) return args.configured
  if (args.nativeExists) return args.native
  return args.onPath || undefined
}
