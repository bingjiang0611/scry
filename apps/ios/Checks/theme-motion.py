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
      (.drawerRelease, .spring(duration: 0.38, bounce: 0.12)),
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
    print("PASS 56 color resolutions, provider mapping, 19 motion presets/reduced motion, row delay bounds, 9 font roles")
  }
}
'''
workspace = (root / 'apps/ios/ScryRemote/WorkspaceShell.swift').read_text()
assert '.offset(x: reduceMotion || drawerOpen ? 0 : -width)' in workspace
assert 'if drawerUsesReleaseCurve { return .drawerRelease }' in workspace
assert workspace.count('Motion.animation(drawerEffect') == 3
assert 'drawerUsesReleaseCurve = released\n    drawerOpen = open' in workspace
print('PASS reduced drawer keeps position for opacity; one effect selects button/release curves')

with tempfile.TemporaryDirectory(prefix='scry-theme-motion-') as temporary:
    source = Path(temporary) / 'Check.swift'
    executable = Path(temporary) / 'check'
    source.write_text(fixture)
    subprocess.run(['xcrun', 'swiftc', '-parse-as-library',
                    str(root / 'apps/ios/ScryRemote/Theme.swift'),
                    str(root / 'apps/ios/ScryRemote/Motion.swift'), str(source),
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
