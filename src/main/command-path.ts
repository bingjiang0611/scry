import { statSync } from 'node:fs'
import { posix, win32 } from 'node:path'

function runnableFile(path: string, platform: NodeJS.Platform): boolean {
  try {
    const file = statSync(path)
    return file.isFile() && (platform === 'win32' || (file.mode & 0o111) !== 0)
  } catch {
    return false
  }
}

export function resolveCommandOnPath(
  command: string,
  pathValue: string,
  options: {
    platform?: NodeJS.Platform
    pathExt?: string
    isRunnable?: (path: string) => boolean
  } = {}
): string | undefined {
  const platform = options.platform ?? process.platform
  const pathApi = platform === 'win32' ? win32 : posix
  const extensions = platform === 'win32' && !pathApi.extname(command)
    ? (options.pathExt ?? process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : ['']
  const names = platform === 'win32' ? [command, ...extensions.map((extension) => `${command}${extension}`)] : [command]
  const isRunnable = options.isRunnable ?? ((path: string) => runnableFile(path, platform))
  for (const rawDir of pathValue.split(pathApi.delimiter)) {
    const directory = rawDir.replace(/^"(.*)"$/, '$1')
    if (!directory || !pathApi.isAbsolute(directory)) continue
    for (const name of names) {
      const candidate = pathApi.join(directory, name)
      if (isRunnable(candidate)) return candidate
    }
  }
  return undefined
}
