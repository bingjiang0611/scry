import { lstat, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const MARKER = '// managed-by: @ali/scry-turn-recorder pi integration'

function piSettingsPath(home = homedir()): string {
  return join(home, '.pi', 'agent', 'settings.json')
}

async function readSettings(path: string): Promise<Record<string, unknown>> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('settings root must be an object')
    return value as Record<string, unknown>
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw new Error(`cannot read Pi settings ${path}: ${String(error)}`)
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temp = `${path}.${process.pid}.tmp`
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  try {
    await rename(temp, path)
  } finally {
    await rm(temp, { force: true })
  }
}

function packageIntegrationPath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../integrations/pi-scry-recorder.mjs')
}

export function piIntegrationTarget(home = homedir()): string {
  return join(home, '.pi', 'agent', 'extensions', 'scry-recorder.ts')
}

export async function piIntegrationStatus(options: { home?: string; source?: string } = {}): Promise<{ installed: boolean; target: string; source: string; reason?: string }> {
  const target = piIntegrationTarget(options.home)
  const source = options.source ?? packageIntegrationPath()
  try {
    const targetStat = await lstat(target)
    if (!targetStat.isFile() || targetStat.isSymbolicLink()) return { installed: false, target, source, reason: 'target is not a regular file' }
    const content = await readFile(target, 'utf8')
    if (!content.startsWith(MARKER) || !content.includes(source)) {
      return { installed: false, target, source, reason: 'target is not managed by the installed Scry package' }
    }
    await stat(source)
    const settings = await readSettings(piSettingsPath(options.home))
    if (!Array.isArray(settings.extensions) || !settings.extensions.includes(target)) {
      return { installed: false, target, source, reason: 'loader is not registered in Pi settings' }
    }
    return { installed: true, target, source }
  } catch (error) {
    return { installed: false, target, source, reason: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : String(error) }
  }
}

export async function installPiIntegration(options: { home?: string; source?: string } = {}): Promise<{ installed: true; target: string; source: string }> {
  const target = piIntegrationTarget(options.home)
  const source = options.source ?? packageIntegrationPath()
  const sourceStat = await stat(source)
  if (!sourceStat.isFile()) throw new Error(`Pi integration source is not a regular file: ${source}`)
  try {
    const existing = await lstat(target)
    if (!existing.isFile() || existing.isSymbolicLink()) throw new Error(`refusing to replace non-regular Pi extension: ${target}`)
    const content = await readFile(target, 'utf8')
    if (!content.startsWith(MARKER)) throw new Error(`refusing to replace unmanaged Pi extension: ${target}`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  await mkdir(dirname(target), { recursive: true, mode: 0o700 })
  const temp = `${target}.${process.pid}.tmp`
  const content = `${MARKER}\nexport { default } from ${JSON.stringify(source)}\n`
  await writeFile(temp, content, { encoding: 'utf8', mode: 0o600 })
  try {
    await rename(temp, target)
  } finally {
    await rm(temp, { force: true })
  }
  const settingsPath = piSettingsPath(options.home)
  const settings = await readSettings(settingsPath)
  const extensions = settings.extensions
  if (extensions != null && (!Array.isArray(extensions) || !extensions.every((item) => typeof item === 'string'))) {
    throw new Error(`Pi settings extensions must be an array of paths: ${settingsPath}`)
  }
  const nextExtensions = [...new Set([...((extensions as string[] | undefined) ?? []), target])]
  await writeJsonAtomic(settingsPath, { ...settings, extensions: nextExtensions })
  return { installed: true, target, source }
}
