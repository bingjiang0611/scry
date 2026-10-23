#!/usr/bin/env python3
"""Record one generated fixture on an explicitly authorized physical device.

Run under .agents/skills/scry-performance-climb/scripts/timing-run.mjs. Install
and verify the generated fixture first; this command does not install/sign apps.
It terminates/relaunches the specified fixture via iCTRL, writes its two private
Documents files, and records until the fixed workload reports completion. Raw
iCTRL replies and trace data remain local. The target must be a physical device;
no simulator/device discovery or automatic fallback is performed.
"""
from pathlib import Path
import argparse
import json
import os
import queue
import signal
import subprocess
import threading
import time

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--device', required=True)
parser.add_argument('--bundle', required=True)
parser.add_argument('--output', required=True, type=Path)
args = parser.parse_args()
owner = json.loads(Path('/tmp/scry-performance-timing.lock/owner.json').read_text())
assert owner['pid'] == os.getppid(), 'Invoke through timing-run.mjs; do not time concurrently'
base = args.output
base.mkdir(parents=True, exist_ok=False)
label = base.name


def run(command, **kwargs):
    return subprocess.run(command, check=True, text=True, **kwargs)


def ictrl(method, parameters):
    output = subprocess.check_output([str(Path.home() / '.local/bin/ictrl'), 'call', method, json.dumps(parameters)], text=True)
    (base / (method + '.json')).write_text(output)
    print(output, flush=True)
    value = json.loads(output)
    if 'error' in value:
        raise RuntimeError(value['error'])
    return value['result']


def transfer(direction, source, destination, **kwargs):
    run(['xcrun', 'devicectl', 'device', 'copy', direction, '--device', args.device,
         '--domain-type', 'appDataContainer', '--domain-identifier', args.bundle,
         '--source', str(source), '--destination', str(destination)], **kwargs)


config = base / 'batch-f-preview.json'
config.write_text(json.dumps(['-uiMockData', '-route', 'chat', '-batchFStream']))
ictrl('terminate_app', {'bundle_id': args.bundle})
pending = base / 'batch-f-stream.json'
pending.write_text(json.dumps({'pending': label}))
transfer('to', pending, 'Documents/batch-f-stream.json')
transfer('to', config, 'Documents/batch-f-preview.json')
ictrl('launch_app', {'bundle_id': args.bundle})
start = ictrl('find_element', {'element_id': 'batch-f-stream', 'match': 'exact'})
assert start.get('ref') and start.get('hittable'), start
ictrl('device_info', {})
run(['xcrun', 'devicectl', 'device', 'info', 'processes', '--device', args.device,
     '--search', 'ScryRemote', '--json-output', str(base / 'process.json')])
processes = json.loads((base / 'process.json').read_text())['result']['runningProcesses']
assert len(processes) == 1, processes
pid = processes[0]['processIdentifier']
notification = 'com.scry.batch-f.trace.' + label
with (base / 'notify.log').open('w') as notify_log, (base / 'xctrace.log').open('w') as trace_log:
    listener = subprocess.Popen(['notifyutil', '-1', notification], stdout=notify_log, stderr=subprocess.STDOUT)
    recorder = subprocess.Popen([
        'xcrun', 'xctrace', 'record', '--template', 'Activity Monitor',
        '--instrument', 'Hitches', '--instrument', 'Core Animation FPS', '--instrument', 'os_signpost',
        '--device', args.device, '--attach', str(pid), '--output', str(base / 'animation.trace'),
        '--notify-tracing-started', notification,
    ], stdout=trace_log, stderr=subprocess.STDOUT)
    try:
        completion = queue.Queue()

        def wait_for(tag, process):
            completion.put((tag, process.wait()))

        threading.Thread(target=wait_for, args=('notify', listener), daemon=True).start()
        threading.Thread(target=wait_for, args=('record', recorder), daemon=True).start()
        tag, status = completion.get(timeout=35)
        assert tag == 'notify' and status == 0, 'Recorder did not start: ' + (base / 'xctrace.log').read_text()
        ictrl('tap', {'ref': start['ref']})
        deadline = time.monotonic() + 180
        delay = 0.5
        while True:
            transfer('from', 'Documents/batch-f-stream.json', base / 'stream.json', stdout=subprocess.DEVNULL)
            data = json.loads((base / 'stream.json').read_text())
            if 'pending' not in data:
                break
            assert recorder.poll() is None, 'Recorder exited during stream'
            assert time.monotonic() < deadline, 'Fixture did not report completion'
            time.sleep(delay)
            delay = min(4, delay * 2)
        recorder.send_signal(signal.SIGINT)
        result = recorder.wait()
        print((base / 'xctrace.log').read_text(), flush=True)
        assert result == 0, result
    finally:
        if listener.poll() is None:
            listener.terminate()
            listener.wait()
        if recorder.poll() is None:
            recorder.send_signal(signal.SIGINT)
            recorder.wait()
report = json.loads((base / 'stream.json').read_text())
print(json.dumps(report, ensure_ascii=False, indent=2), flush=True)
assert report.get('actualLines') == report.get('requestedLines') == 600, report
run(['xcrun', 'xctrace', 'export', '--input', str(base / 'animation.trace'), '--toc', '--output', str(base / 'toc.xml')])
for schema in ['hitches', 'core-animation-fps-estimate', 'os-signpost-interval']:
    run(['xcrun', 'xctrace', 'export', '--input', str(base / 'animation.trace'), '--xpath',
         f'/trace-toc/run[@number="1"]/data/table[@schema="{schema}"]', '--output', str(base / (schema + '.xml'))])
print('RESULT', base, flush=True)
