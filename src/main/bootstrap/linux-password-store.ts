// Which safeStorage backend the App asks Chromium for on Linux (B4-S F1, option A,
// maintainer 2026-11-12). Pure: no Electron import, so the rule is tested on its own.
//
// Chromium picks the store from the desktop it recognises. Hyprland is not one of them,
// and neither is an unnamed desktop, so Electron 42 falls back to `basic_text` there even
// while gnome-keyring is unlocked (status doc table rows 12-13). Daemon mode keeps the
// App's local daemon grant in safeStorage and refuses `basic_text`, so on Omarchy every
// run failed. Asking for libsecret names the backend and nothing more: without a running
// Secret Service keyring safeStorage stays unavailable and daemon mode still refuses (F2).
// There is no plaintext fallback here; that was option B and it was not approved.
//
// Only those two cases are changed. GNOME and its relatives already get libsecret, KDE
// gets kwallet, and every other desktop keeps Chromium's own choice. An explicit
// `--password-store` always wins, including one the user set to `basic`.

export type LinuxPasswordStore = 'gnome-libsecret'

/** The older variables Chromium reads when XDG_CURRENT_DESKTOP names no desktop. */
const LEGACY_DESKTOP_VARIABLES = ['DESKTOP_SESSION', 'KDE_FULL_SESSION', 'GNOME_DESKTOP_SESSION_ID'] as const

const isHyprland = (value: string): boolean => value.toLowerCase() === 'hyprland'

export function linuxPasswordStoreSwitch(input: {
  platform: NodeJS.Platform
  /** `app.commandLine.hasSwitch('password-store')`: argv and anything Chromium merged into it. */
  hasPasswordStoreSwitch: boolean
  env: NodeJS.ProcessEnv
}): LinuxPasswordStore | undefined {
  if (input.platform !== 'linux' || input.hasPasswordStoreSwitch) return undefined
  // A colon-separated list in priority order (XDG Desktop Entry spec).
  const desktops = (input.env.XDG_CURRENT_DESKTOP ?? '').split(':').map((value) => value.trim()).filter(Boolean)
  if (desktops.length > 0) {
    // KDE listed anywhere keeps kwallet; Chromium would have found it.
    if (desktops.some((value) => value.toLowerCase() === 'kde')) return undefined
    return desktops.some(isHyprland) ? 'gnome-libsecret' : undefined
  }
  const session = input.env.DESKTOP_SESSION?.trim() ?? ''
  if (session && isHyprland(session)) return 'gnome-libsecret'
  // Unnamed: Chromium would consult these next and may find a desktop it knows.
  if (LEGACY_DESKTOP_VARIABLES.some((name) => (input.env[name]?.trim() ?? '') !== '')) return undefined
  return 'gnome-libsecret'
}

/** The two `app.commandLine` methods the wiring uses; a fake in tests. */
export interface PasswordStoreCommandLine {
  hasSwitch(name: string): boolean
  appendSwitch(name: string, value?: string): void
}

/**
 * Must run before `app` is ready: Chromium reads the switch when it first sets up
 * safeStorage, and a later append has no effect. Returns what was appended.
 */
export function applyLinuxPasswordStore(
  commandLine: PasswordStoreCommandLine,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env
): LinuxPasswordStore | undefined {
  const store = linuxPasswordStoreSwitch({ platform, hasPasswordStoreSwitch: commandLine.hasSwitch('password-store'), env })
  if (store) commandLine.appendSwitch('password-store', store)
  return store
}
