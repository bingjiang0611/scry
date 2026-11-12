#!/usr/bin/env python3
"""Check R1 tokens against SPEC on macOS; print the requested contrast table."""
from pathlib import Path
import os
import re
import subprocess
import tempfile

root = Path(__file__).resolve().parents[3]
spec = (root / 'docs/handoff/ios-redesign-2026-10-25/SPEC.md').read_text()
colors = {name: (int(dark, 16), int(light, 16)) for name, dark, light in
          re.findall(r'\| `(\w+)` \| `#([0-9a-f]{6})` \| `#([0-9a-f]{6})`', spec)}
assert len(colors) == 21
colors.update(accentFill=(0x2f6ad8, 0x2f6ad8), onAccent=(0xffffff, 0xffffff),
              accentText=(0x5b9cff, 0x2c64cc), warnText=(0xefb958, 0x7f5409))
checks = []
for name, values in colors.items():
    for mode, value in zip(('dark', 'light'), values):
        checks.append(f'check(Palette.{name}, 0x{value:06x}, 1, .{mode}Aqua, "{mode}.{name}")')
# NSAppearance calls light mode aqua, not lightAqua.
checks = [line.replace('.lightAqua', '.aqua') for line in checks]
for name, values, alphas in [
    ('accentSoft', colors['accent'], (0.12, 0.09)),
    ('hover', (0xffffff, 0x222220), (0.06, 0.05)),
    ('subtle', (0xffffff, 0x222220), (0.04, 0.038)),
]:
    for mode, value, alpha in zip(('darkAqua', 'aqua'), values, alphas):
        checks.append(f'check(Palette.{name}, 0x{value:06x}, {alpha}, .{mode}, "{mode}.{name}")')

fixture = '''import SwiftUI
import AppKit
// Dependency fixtures for the presentation controller; its actual implementation
// is compiled below. Identity/route authority remains covered by store tests.
struct RemoteRunStore {
  struct SessionIdentity: Hashable { let key: String }
}
enum Route: Hashable { case home, newSession, chat, transcript, settings }
@main struct Check {
  static func check(_ color: Color, _ hex: UInt32, _ alpha: CGFloat, _ appearance: NSAppearance.Name, _ label: String) {
    NSAppearance(named: appearance)!.performAsCurrentDrawingAppearance {
      let resolved = NSColor(color).usingColorSpace(.sRGB)!
      let actual = [resolved.redComponent, resolved.greenComponent, resolved.blueComponent, resolved.alphaComponent]
      let expected = [CGFloat((hex >> 16) & 255) / 255, CGFloat((hex >> 8) & 255) / 255, CGFloat(hex & 255) / 255, alpha]
      if !zip(actual, expected).allSatisfy({ abs($0 - $1) < 0.0001 }) {
        print("FAIL \\(label): \\(actual) != \\(expected)")
        exit(1)
      }
    }
  }
  static func main() {
''' + '\n'.join(checks) + '''
    precondition(Palette.provider("claude") == Palette.providerClaude)
    precondition(Palette.provider("codex") == Palette.providerCodex)
    precondition(Palette.provider("qoder") == Palette.providerQoder)
    precondition(Palette.provider("opencode") == Palette.providerOpenCode)
    precondition(Palette.provider("pi") == Palette.providerPi)
    precondition(Palette.provider("unknown") == Palette.dim2)
    precondition(Motion.hover == 0.12 && Motion.small == 0.20 && Motion.medium == 0.25 && Motion.large == 0.40)
    precondition(Motion.exitSmall == 0.15 && Motion.exitMedium == 0.20 && Motion.overshoot == 0.30)
    let expected: [(Motion.Effect, Animation)] = [
      (.press, .timingCurve(0, 0, 0.58, 1, duration: 0.12)),
      (.select, .timingCurve(0.22, 1, 0.36, 1, duration: 0.20)),
      (.confirm, .timingCurve(0.34, 1.56, 0.64, 1, duration: 0.30)),
      (.enter, .timingCurve(0, 0, 0.58, 1, duration: 0.20)),
      (.exit, .timingCurve(0.42, 0, 1, 1, duration: 0.15)),
      (.tab, .timingCurve(0.42, 0, 0.58, 1, duration: 0.20)),
      (.reorder, .timingCurve(0.42, 0, 0.58, 1, duration: 0.25)),
      (.disclosureOpen, .timingCurve(0, 0, 0.58, 1, duration: 0.20)),
      (.disclosureClose, .timingCurve(0.42, 0, 1, 1, duration: 0.15)),
      (.chevron, .timingCurve(0.22, 1, 0.36, 1, duration: 0.20)),
      (.rowIn, .timingCurve(0, 0, 0.58, 1, duration: 0.20)),
      (.streamIn, .timingCurve(0, 0, 0.58, 1, duration: 0.20)),
      (.drawerOpen, .timingCurve(0, 0, 0.58, 1, duration: 0.25)),
      (.drawerClose, .timingCurve(0.42, 0, 1, 1, duration: 0.20)),
      (.reset, .timingCurve(0.42, 0, 0.58, 1, duration: 0.25)),
      (.scroll, .timingCurve(0.42, 0, 0.58, 1, duration: 0.25)),
      (.page, .timingCurve(0, 0, 0.58, 1, duration: 0.40)),
      (.sheet, .timingCurve(0, 0, 0.58, 1, duration: 0.40))
    ]
    for (effect, animation) in expected {
      precondition(Motion.animation(effect, reduceMotion: false) == animation)
      precondition(Motion.animation(effect, reduceMotion: true) == .timingCurve(0, 0, 0.58, 1, duration: 0.15))
    }
    precondition(Motion.rowDelay(index: -1) == 0 && Motion.rowDelay(index: 0) == 0)
    precondition(Motion.rowDelay(index: 1) == 0.016)
    precondition(abs(Motion.rowDelay(index: 9) - 0.144) < 1e-9)
    precondition(Motion.rowDelay(index: 100) == Motion.rowDelay(index: 9))
    precondition(Typography.reply == .callout && Typography.replyLineSpacing == 5)
    precondition(Typography.bubble == .callout && Typography.rowTitle == .subheadline)
    precondition(Typography.headerTitle == .subheadline.weight(.semibold))
    precondition(Typography.groupLabel == .footnote.weight(.semibold) && Typography.meta == .caption)
    precondition(Typography.mono == .system(.footnote, design: .monospaced))
    precondition(Typography.codeBlock == .system(.caption, design: .monospaced))
    precondition(Typography.sheetTitle == .headline)
    precondition(DrawerPosition.progress(origin: 0, translation: 85, width: 340) == 0.25)
    precondition(DrawerPosition.progress(origin: 0.6, translation: -34, width: 340) == 0.5)
    precondition(DrawerPosition.progress(origin: 0, translation: -30, width: 340) == 0)
    precondition(DrawerPosition.progress(origin: 1, translation: 30, width: 340) == 1)
    precondition(DrawerPosition.opens(origin: 0, predictedTranslation: 200, width: 340))
    precondition(!DrawerPosition.opens(origin: 1, predictedTranslation: -200, width: 340))
    precondition(!DrawerPosition.opens(origin: 0, predictedTranslation: 100, width: 340))
    precondition(Motion.arrival(reduceMotion: true) == Motion.animation(.enter, reduceMotion: true).delay(0))
    precondition(Motion.arrival(reduceMotion: false) == Motion.animation(.enter, reduceMotion: false).delay(0.2))
    precondition(Motion.drawerRelease(velocity: 3, remaining: 0.5, reduceMotion: true) == Motion.easeOut(duration: 0.15))
    precondition(Motion.drawerRelease(velocity: 3, remaining: 0.5, reduceMotion: false) == .interpolatingSpring(duration: 0.38, bounce: 0.12, initialVelocity: 6))
    let first = RemoteRunStore.SessionIdentity(key: "host-a/session")
    let second = RemoteRunStore.SessionIdentity(key: "host-b/session")
    let transition = ConversationTransition()
    precondition(!transition.contains(.sessionTitle(first), route: .transcript))
    transition.begin(.session(first))
    let ticket = transition.ticket
    precondition(transition.contains(.sessionTitle(first), route: .transcript))
    precondition(transition.contains(.sessionProvider(first), route: .transcript))
    precondition(!transition.contains(.sessionTitle(second), route: .transcript))
    precondition(!transition.contains(.sessionTitle(first), route: .home))
    precondition(!transition.accepts(first))
    transition.begin(.submission(second))
    precondition(transition.ticket != ticket)
    precondition(transition.accepts(second) && !transition.accepts(first) && !transition.accepts(nil))
    precondition(transition.contains(.submittedText, route: .chat))
    precondition(transition.contains(.submittedAttachment(0), route: .chat))
    precondition(transition.contains(.composerSurface, route: .chat))
    precondition(!transition.contains(.submittedText, route: .transcript))
    precondition(!transition.contains(.sessionTitle(first), route: .transcript))
    transition.cancel()
    precondition(transition.destination == nil && transition.ticket == nil)
    precondition(!transition.contains(.composerSurface, route: .chat))
    print("PASS colors, motion/reduced motion, row delays, fonts; drawer position/release; scoped route identities, replacement and cancellation")
  }
}
'''
workspace = (root / 'apps/ios/ScryRemote/WorkspaceShell.swift').read_text()
assert '.offset(x: reduceMotion ? 0 : (drawerProgress - 1) * width)' in workspace
assert '.opacity(reduceMotion ? drawerProgress : 1)' in workspace
assert 'dragOrigin = reduceMotion ? drawerProgress : presentedProgress' in workspace
assert 'if !active, dragOrigin != nil { setDrawer(drawerOpen) }' in workspace
assert 'value.velocity.width / width' in workspace
panel = workspace.split('private func drawer(width:', 1)[1].split('private func drawerGesture', 1)[0]
def observes_translated_panel(source):
    return source.index('.onGeometryChange(') < source.index('.offset(')
assert observes_translated_panel(panel)
# Negative control: the original outside-offset observer cannot measure drag origin.
assert not observes_translated_panel('.offset(x: 0) .onGeometryChange(for: CGFloat.self)')
print('PASS reduced drawer has no translation; geometry observes translated subtree; interrupted/cancelled drag contract and negative control')

with tempfile.TemporaryDirectory(prefix='scry-theme-motion-') as temporary:
    source = Path(temporary) / 'Check.swift'
    executable = Path(temporary) / 'check'
    source.write_text(fixture)
    subprocess.run(['xcrun', 'swiftc', '-parse-as-library',
                    str(root / 'apps/ios/ScryRemote/Theme.swift'),
                    str(root / 'apps/ios/ScryRemote/Motion.swift'),
                    str(root / 'apps/ios/ScryRemote/ConversationTransitions.swift'), str(source),
                    '-o', str(executable)], check=True)
    subprocess.run(['codesign', '--force', '--sign', os.environ.get('SCRY_IOS_CHECK_SIGN_IDENTITY', '-'), str(executable)], check=True)
    subprocess.run(['codesign', '--verify', '--strict', str(executable)], check=True)
    subprocess.run([str(executable)], check=True)


def luminance(hex_value):
    channels = [(hex_value >> shift & 255) / 255 for shift in (16, 8, 0)]
    linear = [v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4 for v in channels]
    return sum(v * weight for v, weight in zip(linear, (0.2126, 0.7152, 0.0722)))


print('| mode / text | main | sidebar | panel2 |')
print('|---|---:|---:|---:|')
for mode, index in [('dark', 0), ('light', 1)]:
    for foreground in ['fg', 'dim', 'dim2', 'accent', 'ok', 'warn', 'bad']:
        ratios = []
        for background in ['main', 'sidebar', 'panel2']:
            a, b = sorted([luminance(colors[foreground][index]), luminance(colors[background][index])])
            ratio = (b + 0.05) / (a + 0.05)
            ratios.append(f'{ratio:.2f}' + (' **<4.5**' if ratio < 4.5 else ''))
        print(f'| {mode}.{foreground} | ' + ' | '.join(ratios) + ' |')
