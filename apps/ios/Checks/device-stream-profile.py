#!/usr/bin/env python3
"""Summarize complete physical-device Time Profiler XML for stream600.

Input is a device-observation-record --time-profiler run directory, with an
additional xctrace export of the observed time-profile schema. All XML refs are
resolved. Inclusive weights are not additive; CPU samples are not wall time.
Only the Stream600 interval, its process, and its main thread are summarized.
"""
from pathlib import Path
from collections import Counter
import argparse
import hashlib
import json
import re
import statistics
import xml.etree.ElementTree as ET

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('run', type=Path)
args = parser.parse_args()


def read_table(path):
    root = ET.parse(path).getroot()
    refs = {element.attrib['id']: element for element in root.iter() if 'id' in element.attrib}

    def resolve(element):
        while 'ref' in element.attrib:
            element = refs[element.attrib['ref']]
        return element

    names = [column.findtext('mnemonic') for column in root.findall('.//schema/col')]
    return [{name: resolve(element) for name, element in zip(names, row)} for row in root.findall('.//row')], resolve


intervals, resolve_interval = read_table(args.run / 'os-signpost-interval.xml')
phases = [row for row in intervals if row['subsystem'].text == 'com.scry.batch-f' and row['name'].text == 'Stream600']
assert len(phases) == 1
phase = phases[0]
start = int(phase['start'].text)
end = start + int(phase['duration'].text)
pid = int(resolve_interval(phase['process'].find('pid')).text)
appends = []
for row in intervals:
    if row['subsystem'].text != 'com.scry.batch-f' or row['name'].text != 'Append600':
        continue
    assert int(resolve_interval(row['process'].find('pid')).text) == pid
    sequence = int(re.fullmatch(r'sequence=\s*(\d+)', row['start-message'].get('fmt')).group(1))
    timestamp = int(row['start'].text)
    finish = timestamp + int(row['duration'].text)
    assert start <= timestamp <= finish <= end
    appends.append((sequence, timestamp, finish))
appends.sort()
assert [row[0] for row in appends] == list(range(1, 601))
assert all(a[2] <= b[1] for a, b in zip(appends, appends[1:]))

rows, resolve_sample = read_table(args.run / 'time-profile.xml')
inclusive = Counter()
app_inclusive = Counter()
leaf_symbols = Counter()
leaf_binaries = Counter()
stacks = Counter()
main_total = 0
phase_samples = 0
main_samples = 0
unsymbolicated_leaf = 0
unavailable_stack = 0
bins = [0] * 6
append_windows = [appends[index:index + 100] for index in range(0, 600, 100)]
window_bounds = [(start if index == 0 else append_windows[index][0][1], end if index == 5 else append_windows[index + 1][0][1]) for index in range(6)]
for row in rows:
    timestamp = int(row['time'].text)
    if not start <= timestamp < end:
        continue
    if int(resolve_sample(row['process'].find('pid')).text) != pid:
        continue
    phase_samples += 1
    if not row['thread'].get('fmt', '').startswith('Main Thread '):
        continue
    weight = int(row['weight'].text)
    main_total += weight
    main_samples += 1
    for index, (left, right) in enumerate(window_bounds):
        if left <= timestamp < right:
            bins[index] += weight
            break
    if row['stack'].tag == 'sentinel':
        unavailable_stack += weight
        continue
    backtrace = resolve_sample(row['stack'].find('backtrace'))
    frames = [resolve_sample(frame) for frame in backtrace]
    symbols = []
    binaries = []
    app_symbols = []
    for frame in frames:
        binary_element = frame.find('binary')
        binary_name = resolve_sample(binary_element).get('name') if binary_element is not None else 'unavailable binary'
        symbol = binary_name + ': ' + frame.get('name')
        symbols.append(symbol)
        binaries.append(binary_name)
        if binary_name == 'ScryRemote.debug.dylib':
            app_symbols.append(symbol)
    assert symbols
    for symbol in set(symbols):
        inclusive[symbol] += weight
    for symbol in set(app_symbols):
        app_inclusive[symbol] += weight
    leaf_symbols[symbols[0]] += weight
    leaf_binaries[binaries[0]] += weight
    if frames[0].get('name').startswith('0x'):
        unsymbolicated_leaf += weight
    stacks[tuple(symbols[:60])] += weight
assert main_total > 0
assert sum(bins) == main_total


def weights(counter, count):
    return [{'symbol': symbol, 'sampledCpuMs': weight / 1e6, 'fractionMainCpu': weight / main_total} for symbol, weight in counter.most_common(count)]


stream = json.loads((args.run / 'stream.json').read_text())
expected = ''.join(f'Line {sequence:04d}: fixed streamed paragraph for batch F observation.\n\n' for sequence in range(1, 601))
assert stream['actualLines'] == stream['requestedLines'] == 600
assert stream['outputSHA256'] == hashlib.sha256(expected.encode()).hexdigest()
durations = [(finish - timestamp) / 1e6 for _, timestamp, finish in appends]
result = {
    'schema': 1,
    'sourceRevision': stream['revision'],
    'phaseMs': (end - start) / 1e6,
    'phaseSamplesAllThreads': phase_samples,
    'mainSamples': main_samples,
    'mainSampledCpuMs': main_total / 1e6,
    'unsymbolicatedLeafFraction': unsymbolicated_leaf / main_total,
    'unavailableStackCpuMs': unavailable_stack / 1e6,
    'appendSync': {
        'count': len(appends),
        'sumMs': sum(durations),
        'medianMs': statistics.median(durations),
        'maxMs': max(durations),
    },
    'windows': [{
        'firstSequence': window[0][0],
        'lastSequence': window[-1][0],
        'wallMs': (right - left) / 1e6,
        'mainSampledCpuMs': bins[index] / 1e6,
        'appendSyncMs': sum((finish - timestamp) / 1e6 for _, timestamp, finish in window),
    } for index, (window, (left, right)) in enumerate(zip(append_windows, window_bounds))],
    'focusInclusiveCpuMs': {name: inclusive.get(symbol, None) / 1e6 if symbol in inclusive else None for name, symbol in {
        'scrollTo': 'SwiftUI: ScrollViewProxy.scrollTo<A>(_:anchor:)',
        'markdownParse': 'ScryRemote.debug.dylib: static ConversationMarkdownParser.parse(_:)',
        'inlineRendered': 'ScryRemote.debug.dylib: ConversationMarkdownInline.rendered.getter',
    }.items()},
    'leafBinaries': weights(leaf_binaries, 20),
    'inclusiveTop': weights(inclusive, 30),
    'appInclusiveTop': weights(app_inclusive, 20),
    'leafTop': weights(leaf_symbols, 20),
    'representativeStacks': [{'sampledCpuMs': weight / 1e6, 'framesLeafFirst': list(stack)} for stack, weight in stacks.most_common(5)],
    'sourceSHA256': {name: hashlib.sha256((args.run / name).read_bytes()).hexdigest() for name in ['time-profile.xml', 'os-signpost-interval.xml', 'stream.json']},
}
print(json.dumps(result, ensure_ascii=False, indent=2))
