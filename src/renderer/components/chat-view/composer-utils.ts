import type { SlashCmd } from '@shared/trace'
import type { QueuedPrompt } from '../../App'
import type { Turn } from '../../format'

interface ClipboardDataLike {
  files?: ArrayLike<File>
  items?: ArrayLike<{ kind: string; type: string; getAsFile: () => File | null }>
}

export function imageFilesFromClipboardData(data: ClipboardDataLike): File[] {
  const files = new Map<string, File>()
  for (const file of Array.from(data.files ?? [])) {
    if (file.type.startsWith('image/')) files.set(`${file.name}:${file.size}:${file.type}`, file)
  }
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== 'file' || !item.type.startsWith('image/')) continue
    const file = item.getAsFile()
    if (file) files.set(`${file.name}:${file.size}:${file.type}`, file)
  }
  return [...files.values()]
}

export function filterSlashCommands(input: string, commands: SlashCmd[]): SlashCmd[] {
  if (!input.startsWith('/') || /\s/.test(input)) return []
  const query = input.slice(1).normalize('NFKC').toLocaleLowerCase()
  const normalizedName = (command: SlashCmd): string => command.name.replace(/^\/+/, '').normalize('NFKC').toLocaleLowerCase()
  return commands
    .filter((command) => normalizedName(command).includes(query))
    .sort((a, b) => {
      const aName = normalizedName(a)
      const bName = normalizedName(b)
      const aPrefix = aName.startsWith(query) ? 0 : 1
      const bPrefix = bName.startsWith(query) ? 0 : 1
      return aPrefix - bPrefix || aName.localeCompare(bName)
    })
    .slice(0, 50)
}

export function formatElapsedMs(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

export type ComposerHistoryDirection = 'older' | 'newer'

export interface ComposerHistoryNavigation {
  position: number | null
  value: string
}

export function composerPromptHistory(turns: Turn[], queuedPrompts: QueuedPrompt[]): string[] {
  const history: string[] = []
  for (const value of [...turns.map((turn) => turn.userText), ...queuedPrompts.map((prompt) => prompt.text)]) {
    if (!value.trim() || history.at(-1) === value) continue
    history.push(value)
  }
  return history
}

export function navigateComposerHistory(
  history: readonly string[],
  input: string,
  position: number | null,
  direction: ComposerHistoryDirection
): ComposerHistoryNavigation | null {
  if (history.length === 0) return null
  if (position == null) {
    if (input !== '' || direction === 'newer') return null
    const nextPosition = history.length - 1
    return { position: nextPosition, value: history[nextPosition] }
  }
  if (direction === 'older') {
    const nextPosition = Math.max(0, Math.min(position - 1, history.length - 1))
    return { position: nextPosition, value: history[nextPosition] }
  }
  if (position >= history.length - 1) return { position: null, value: '' }
  const nextPosition = Math.min(position + 1, history.length - 1)
  return { position: nextPosition, value: history[nextPosition] }
}

const IME_ENTER_GUARD_MS = 120

export function composerEnterConfirmsIme(input: {
  nativeIsComposing: boolean
  keyCode: number
  compositionActive: boolean
  compositionEndedAt: number
  now: number
}): boolean {
  return input.nativeIsComposing || input.keyCode === 229 || input.compositionActive ||
    input.now - input.compositionEndedAt < IME_ENTER_GUARD_MS
}
