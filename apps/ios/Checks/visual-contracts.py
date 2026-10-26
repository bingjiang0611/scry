#!/usr/bin/env python3
"""Read-only R5 source policy and contrast report. No App or device writes."""
from pathlib import Path
import argparse
import re

ROOT = Path(__file__).resolve().parents[3]
APP = ROOT / 'apps/ios/ScryRemote'
ALIASES = 'ink muted faint line blue green amber surface canvas message glass noticeBg noticeInk warnBg warnInk positive negative'.split()


def animation_errors(source):
    # Balance nested calls rather than looking at just one line. Ignore comments.
    source = re.sub(r'//[^\n]*|/\*[\s\S]*?\*/', '', source)
    errors = ['withAnimation must use Motion'] if re.search(r'\bwithAnimation\s*\{', source) else []
    for match in re.finditer(r'\bwithAnimation\s*\(|\.(?:animation|transition)\s*\(', source):
        if source[:match.start()].endswith('Motion'):
            continue  # This is the shared factory, not a View animation modifier.
        start = match.end()
        depth = 1
        end = start
        while end < len(source) and depth:
            depth += (source[end] == '(') - (source[end] == ')')
            end += 1
        argument = source[start:end - 1]
        if 'Motion.' not in argument or re.search(r'\.(?:easeInOut|easeIn|easeOut|spring|default|linear)\b', argument):
            errors.append(source[match.start():end].splitlines()[0])
    if re.search(r'(?:Linear|Cubic|Spring)Keyframe\([^\n]*duration:\s*[0-9]', source):
        errors.append('keyframe duration must use Motion')
    return errors


def rgb(value):
    return tuple((value >> shift & 255) / 255 for shift in (16, 8, 0))


def luminance(channels):
    linear = [v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4 for v in channels]
    return sum(v * weight for v, weight in zip(linear, (0.2126, 0.7152, 0.0722)))


def contrast(a, b):
    low, high = sorted((luminance(a), luminance(b)))
    return (high + 0.05) / (low + 0.05)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', type=Path, help='Scan one temporary Swift sample instead of the App')
    args = parser.parse_args()
    files = [args.source] if args.source else sorted(APP.rglob('*.swift'))
    failures = []
    for path in files:
        source = path.read_text()
        if path != APP / 'Motion.swift':
            failures += [f'{path.name}: {error}' for error in animation_errors(source)]
        old = re.findall(r'Palette\.(' + '|'.join(ALIASES) + r')\b', source)
        failures += [f'{path.name}: removed alias {alias}' for alias in sorted(set(old))]
    if failures:
        print('\n'.join('FAIL ' + failure for failure in failures))
        return 1
    assert animation_errors('view.animation(.easeInOut(duration: 0.2), value: changed)')
    assert animation_errors('withAnimation(.default) { changed = true }')
    assert animation_errors('withAnimation { changed = true }')
    assert not animation_errors('view.transition(Motion.fade).animation(Motion.animation(.tab, reduceMotion: true), value: changed)')
    print(f'PASS {len(files)} Swift files: Motion-only calls, no legacy aliases; negative/positive scanner controls')

    source = (APP / 'Theme.swift').read_text()
    colors = {name: (rgb(int(dark, 16)), rgb(int(light, 16))) for name, dark, light in re.findall(
        r'static let (\w+) = adaptive\(dark: 0x([0-9A-Fa-f]+), light: 0x([0-9A-Fa-f]+)', source)}
    backgrounds = ['bg', 'sidebar', 'main', 'panel', 'panel2', 'panel3']
    print('| mode / foreground | ' + ' | '.join(backgrounds) + ' |')
    print('|---|' + '---:|' * len(backgrounds))
    for mode, index in [('dark', 0), ('light', 1)]:
        for foreground in ['fg', 'dim', 'dim2', 'accent', 'warn', 'accentText', 'warnText', 'bad', 'ok']:
            values = []
            for background in backgrounds:
                ratio = contrast(colors[foreground][index], colors[background][index])
                if foreground in ('accentText', 'warnText'):
                    assert ratio >= 4.5, f'{mode}.{foreground}/{background}: {ratio}'
                values.append(f'{ratio:.2f}' + (' **<3**' if ratio < 3 else ' *<4.5*' if ratio < 4.5 else ''))
            print(f'| {mode}.{foreground} | ' + ' | '.join(values) + ' |')
        fill = contrast(colors['onAccent'][index], colors['accentFill'][index])
        assert fill >= 4.5, f'{mode}: onAccent/accentFill {fill}'
        warning_background = tuple(w * 0.12 + p * 0.88 for w, p in zip(colors['warn'][index], colors['panel2'][index]))
        warning = contrast(colors['warn'][index], warning_background)
        warning_text = contrast(colors['warnText'][index], warning_background)
        soft = re.search(r'static let accentSoft = adaptive\(dark: 0x([0-9A-Fa-f]+), light: 0x([0-9A-Fa-f]+), darkAlpha: ([0-9.]+), lightAlpha: ([0-9.]+)', source)
        soft_rgb = rgb(int(soft.group(index + 1), 16))
        alpha = float(soft.group(index + 3))
        accent_background = tuple(a * alpha + p * (1 - alpha) for a, p in zip(soft_rgb, colors['panel2'][index]))
        accent_text = contrast(colors['accentText'][index], accent_background)
        assert warning_text >= 4.5, f'{mode}.warnText/warnSoft: {warning_text}'
        assert accent_text >= 4.5, f'{mode}.accentText/accentSoft: {accent_text}'
        print(f'{mode}: onAccent/accentFill={fill:.2f}; warn/(warn 12% over panel2)={warning:.2f}; '
              f'warnText/(warn 12% over panel2)={warning_text:.2f}; accentText/(accentSoft over panel2)={accent_text:.2f}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
