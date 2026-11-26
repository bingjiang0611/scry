"""Stream local Qoder 1.1.91 replay inputs to replay-qoder-stop-samples.mjs. Do not save stdout."""
import argparse
from datetime import datetime
import json
from pathlib import Path
import re
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--logs', type=Path, default=Path.home() / '.qoder/logs')
parser.add_argument('--projects', type=Path, default=Path.home() / '.qoder/projects')
parser.add_argument('--log-limit', type=int, help='only for reproducing the original sample selection')
parser.add_argument('--before', type=datetime.fromisoformat, help='only for reproducing the original sample selection')
args = parser.parse_args()
decoder = json.JSONDecoder()
version = re.compile(rb'(?<![.0-9])1\.1\.91(?![.0-9])')
event = re.compile(rb'"hook_event_name"\s*:\s*"(Stop|UserPromptSubmit)"')
clock = re.compile(rb'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:[.,]\d+)?(?:Z|[+-]\d\d:?\d\d)?')


def payload_of(line):
    for value in (line, line.replace(rb'\"', b'"')):
        key = event.search(value)
        if not key:
            continue
        for start in reversed([m.start() for m in re.finditer(rb'\{', value[:key.start()])][-10:]):
            try:
                payload, _ = decoder.raw_decode(value[start:].decode(errors='replace'))
            except ValueError:
                continue
            if isinstance(payload, dict) and payload.get('hook_event_name') == key[1].decode():
                return payload
    return None


log_search = subprocess.run(['rg', '-l', '-m1', 'hook_event_name.{0,12}Stop', str(args.logs), '-g', '*.log'],
                            capture_output=True, text=True)
if log_search.returncode not in (0, 1):
    raise SystemExit('could not enumerate local Qoder logs')
paths = [Path(line) for line in log_search.stdout.splitlines()]
if args.before:
    paths = [path for path in paths if path.stat().st_mtime <= args.before.timestamp()]
paths = sorted(paths, key=lambda path: path.stat().st_mtime, reverse=True)[:args.log_limit]
projects = args.projects.resolve()
starts, stops = {}, {}
for file in paths:
    if file.stat().st_size > 18_000_000:
        continue
    data = file.read_bytes()
    if not version.search(data):
        continue
    for line in data.splitlines():
        if b'hook_event_name' not in line:
            continue
        payload = payload_of(line)
        if not payload:
            continue
        is_stop = payload['hook_event_name'] == 'Stop'
        request = payload.get('parent_request_set_id' if is_stop else 'request_set_id')
        path = payload.get('transcript_path')
        if not (isinstance(request, str) and isinstance(path, str)):
            continue
        transcript = Path(path)
        if not transcript.is_absolute() or not transcript.is_relative_to(args.projects) or transcript.is_symlink():
            continue
        if not transcript.is_file() or not transcript.resolve().is_relative_to(projects) or transcript.stat().st_size > 12_000_000:
            continue
        key = (path, payload.get('session_id'), request)
        if not is_stop:
            starts[key] = payload.get('prompt')
            continue
        observed = clock.search(line[:line.index(b'hook_event_name')])
        if observed:
            stamp = datetime.fromisoformat(observed.group().decode().replace('Z', '+00:00')).timestamp()
            if key not in stops or stamp < stops[key][0]:
                stops[key] = stamp, payload.get('cwd')
for key, (stamp, cwd) in stops.items():
    if isinstance(starts.get(key), str):
        path, session, request = key
        print(json.dumps({'path': path, 'cwd': cwd, 'sessionId': session, 'requestSetId': request,
                          'prompt': starts[key], 'hookLogAt': stamp * 1000}))
