import { describe, expect, it } from 'vitest'
import { applyLinuxPasswordStore, linuxPasswordStoreSwitch } from './linux-password-store'

// B4-S F1, option A (maintainer, 2026-11-12). Electron 42 picks the `basic_text` safeStorage
// backend when it does not recognise the desktop (Hyprland, or nothing set), even with an
// unlocked keyring; daemon mode then refuses every run. The App asks for libsecret there
// and nowhere else. A missing keyring still fails closed: this only names the backend.

const choose = (env: NodeJS.ProcessEnv, options: { platform?: NodeJS.Platform; hasPasswordStoreSwitch?: boolean } = {}) =>
  linuxPasswordStoreSwitch({
    platform: options.platform ?? 'linux',
    hasPasswordStoreSwitch: options.hasPasswordStoreSwitch ?? false,
    env
  })

describe('linuxPasswordStoreSwitch', () => {
  it('asks for libsecret on Hyprland, whatever the case or position in the list', () => {
    expect(choose({ XDG_CURRENT_DESKTOP: 'Hyprland' })).toBe('gnome-libsecret')
    expect(choose({ XDG_CURRENT_DESKTOP: 'hyprland' })).toBe('gnome-libsecret')
    expect(choose({ XDG_CURRENT_DESKTOP: 'wlroots:Hyprland' })).toBe('gnome-libsecret')
  })

  it('asks for libsecret when no desktop is named at all', () => {
    expect(choose({})).toBe('gnome-libsecret')
    expect(choose({ XDG_CURRENT_DESKTOP: '' })).toBe('gnome-libsecret')
    expect(choose({ XDG_CURRENT_DESKTOP: ' : ' })).toBe('gnome-libsecret')
    // A Hyprland session started without XDG_CURRENT_DESKTOP is still Hyprland.
    expect(choose({ DESKTOP_SESSION: 'hyprland' })).toBe('gnome-libsecret')
  })

  it('never overrides a store the user chose on the command line', () => {
    expect(choose({ XDG_CURRENT_DESKTOP: 'Hyprland' }, { hasPasswordStoreSwitch: true })).toBeUndefined()
    expect(choose({}, { hasPasswordStoreSwitch: true })).toBeUndefined()
  })

  it('leaves every other desktop to Chromium, KDE included', () => {
    expect(choose({ XDG_CURRENT_DESKTOP: 'GNOME' })).toBeUndefined()
    expect(choose({ XDG_CURRENT_DESKTOP: 'KDE' })).toBeUndefined()
    expect(choose({ XDG_CURRENT_DESKTOP: 'sway' })).toBeUndefined()
    expect(choose({ XDG_CURRENT_DESKTOP: 'ubuntu:GNOME' })).toBeUndefined()
    // KDE keeps kwallet even when listed next to Hyprland.
    expect(choose({ XDG_CURRENT_DESKTOP: 'Hyprland:KDE' })).toBeUndefined()
  })

  it('leaves an unnamed XDG desktop alone when an older variable names one', () => {
    // Chromium falls back to these when XDG_CURRENT_DESKTOP is missing.
    expect(choose({ DESKTOP_SESSION: 'plasma' })).toBeUndefined()
    expect(choose({ DESKTOP_SESSION: 'gnome' })).toBeUndefined()
    expect(choose({ KDE_FULL_SESSION: 'true' })).toBeUndefined()
    expect(choose({ GNOME_DESKTOP_SESSION_ID: 'this-is-deprecated' })).toBeUndefined()
  })

  it('never touches macOS or any other platform', () => {
    expect(choose({ XDG_CURRENT_DESKTOP: 'Hyprland' }, { platform: 'darwin' })).toBeUndefined()
    expect(choose({}, { platform: 'darwin' })).toBeUndefined()
    expect(choose({}, { platform: 'win32' })).toBeUndefined()
  })
})

describe('applyLinuxPasswordStore', () => {
  const commandLine = (existing: Record<string, string> = {}) => {
    const switches = new Map(Object.entries(existing))
    return {
      switches,
      hasSwitch: (name: string) => switches.has(name),
      appendSwitch: (name: string, value = '') => { switches.set(name, value) }
    }
  }

  it('appends the switch Chromium reads, by its exact name', () => {
    const line = commandLine()
    expect(applyLinuxPasswordStore(line, 'linux', { XDG_CURRENT_DESKTOP: 'Hyprland' })).toBe('gnome-libsecret')
    expect([...line.switches]).toEqual([['password-store', 'gnome-libsecret']])
  })

  it('keeps an explicit --password-store as given', () => {
    const line = commandLine({ 'password-store': 'basic' })
    expect(applyLinuxPasswordStore(line, 'linux', { XDG_CURRENT_DESKTOP: 'Hyprland' })).toBeUndefined()
    expect([...line.switches]).toEqual([['password-store', 'basic']])
  })

  it('appends nothing on GNOME or macOS', () => {
    const gnome = commandLine()
    const mac = commandLine()
    applyLinuxPasswordStore(gnome, 'linux', { XDG_CURRENT_DESKTOP: 'GNOME' })
    applyLinuxPasswordStore(mac, 'darwin', {})
    expect(gnome.switches.size + mac.switches.size).toBe(0)
  })
})
