#!/usr/bin/env python3
"""Normalize complete xctrace XML tables for explicit physical-device run folders.

Each folder must contain stream.json, process.json, timing.log, and exports for
hitches, core-animation-fps-estimate, os-signpost-interval. Missing evidence is
an error, not zero. No traces are uploaded and no trace contents are modified.
"""
from pathlib import Path
import argparse
import hashlib
import json
import xml.etree.ElementTree as ET

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('runs', nargs='+', type=Path)
args = parser.parse_args()


def table(path):
    document = ET.parse(path).getroot()
    references = {element.attrib['id']: element for element in document.iter() if 'id' in element.attrib}

    def resolve(element):
        while 'ref' in element.attrib:
            element = references[element.attrib['ref']]
        return element

    names = [column.findtext('mnemonic') for column in document.findall('.//schema/col')]
    rows = [{name: resolve(element) for name, element in zip(names, row)} for row in document.findall('.//row')]
    return rows, resolve


reports = []
for directory in args.runs:
    stream = json.loads((directory / 'stream.json').read_text())
    assert stream['workload'] == 'stream600-paragraphs-30hz-tail500-v2'
    assert stream['actualLines'] == stream['requestedLines'] == 600
    assert stream['outputRows'] == 1
    expected = ''.join(f'Line {sequence:04d}: fixed streamed paragraph for batch F observation.\n\n' for sequence in range(1, 601))
    assert stream['outputSHA256'] == hashlib.sha256(expected.encode()).hexdigest()
    processes = json.loads((directory / 'process.json').read_text())['result']['runningProcesses']
    assert len(processes) == 1
    process = processes[0]['processIdentifier']
    rows, _ = table(directory / 'os-signpost-interval.xml')
    phases = [row for row in rows if row['name'].text == 'Stream600' and row['subsystem'].text == 'com.scry.batch-f']
    assert len(phases) == 1
    phase = phases[0]
    start = int(phase['start'].text)
    duration = int(phase['duration'].text)
    assert duration > 0
    end = start + duration

    def overlap(timestamp, period):
        return max(0, min(end, timestamp + period) - max(start, timestamp))

    hitches = []
    rows, resolve = table(directory / 'hitches.xml')
    for row in rows:
        pid = row['process'].find('pid')
        if pid is None or int(resolve(pid).text) != process:
            continue
        amount = overlap(int(row['start'].text), int(row['duration'].text))
        if amount:
            hitches.append(amount)
    rows, _ = table(directory / 'core-animation-fps-estimate.xml')
    weight = 0
    fps = 0
    for row in rows:
        amount = overlap(int(row['interval'].text), int(row['period'].text))
        weight += amount
        fps += float(row['fps'].text) * amount
    assert weight > 0, 'No FPS evidence in the stream phase'
    timing = [json.loads(line.removeprefix('SCRY_TIMING_RUN=')) for line in (directory / 'timing.log').read_text().splitlines() if line.startswith('SCRY_TIMING_RUN=')]
    assert len(timing) == 1
    reports.append({
        'label': directory.name,
        'stream': stream,
        'instruments': {
            'phaseMs': duration / 1e6,
            'appHitches': len(hitches),
            'appHitchTimeMs': sum(hitches) / 1e6,
            'appHitchMsPerSecond': sum(hitches) / duration * 1000,
            'weightedDisplayFpsEstimate': fps / weight,
            'fpsPhaseCoverage': weight / duration,
        },
        'host': {key: timing[0][key] for key in ['cores', 'loadBefore', 'loadAfter', 'highLoad']},
        'exportSHA256': {name: hashlib.sha256((directory / (name + '.xml')).read_bytes()).hexdigest() for name in ['hitches', 'core-animation-fps-estimate', 'os-signpost-interval']},
    })
print(json.dumps({'schema': 1, 'runs': reports}, ensure_ascii=False, indent=2))
