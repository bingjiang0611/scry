#!/usr/bin/env python3
"""Drive qodercli in a real pty (interactive mode), then either end it cleanly
or interrupt the running turn with SIGINT. Never uses SIGTERM/SIGKILL.

usage: qoder-tty.py --cwd DIR --prompt TEXT --mode normal|interrupt
                    [--interrupt-after SEC] [--max-wait SEC] [--log FILE]
"""
import argparse
import fcntl
import os
import pty
import select
import signal
import struct
import subprocess
import sys
import termios
import time


def records(d):
    try:
        return len([f for f in os.listdir(d) if f.endswith('.json')])
    except FileNotFoundError:
        return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--cwd', required=True)
    ap.add_argument('--prompt', required=True)
    ap.add_argument('--mode', choices=['normal', 'interrupt'], required=True)
    ap.add_argument('--interrupt-after', type=float, default=18.0)
    ap.add_argument('--interrupt-delay', type=float, default=10.0)
    ap.add_argument('--max-wait', type=float, default=180.0)
    ap.add_argument('--log', required=True)
    args = ap.parse_args()

    recdir = os.path.join(args.cwd, '.scry', 'records')
    opendir = os.path.join(args.cwd, '.scry', 'runtime', 'qoder')

    def sessions():
        try:
            return len([d for d in os.listdir(opendir) if os.path.isdir(os.path.join(opendir, d))])
        except FileNotFoundError:
            return 0

    before = records(recdir)
    sessions_before = sessions()
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 120, 0, 0))

    proc = subprocess.Popen(
        ['qodercli', '-i', args.prompt, '--permission-mode', 'bypass_permissions'],
        cwd=args.cwd, stdin=slave, stdout=slave, stderr=slave,
        start_new_session=True, close_fds=True,
    )
    os.close(slave)
    started = time.time()
    buf = bytearray()
    new_record_at = None
    accepted_at = None
    interrupt_at = None
    log = open(args.log, 'wb')

    def drain(timeout=0.2):
        r, _, _ = select.select([master], [], [], timeout)
        if master in r:
            try:
                chunk = os.read(master, 65536)
            except OSError:
                return False
            if not chunk:
                return False
            buf.extend(chunk)
            log.write(chunk)
            log.flush()
        return True

    while True:
        drain()
        elapsed = time.time() - started
        if new_record_at is None and records(recdir) > before:
            new_record_at = elapsed
            print(f'NEW_RECORD_AT {elapsed:.1f}s', flush=True)
        if accepted_at is None and sessions() > sessions_before:
            accepted_at = elapsed
            print(f'ACCEPTED_AT {elapsed:.1f}s (new session dir)', flush=True)
        if args.mode == 'interrupt' and interrupt_at is None and accepted_at is not None \
                and elapsed >= accepted_at + args.interrupt_delay:
            os.kill(proc.pid, signal.SIGINT)
            interrupt_at = elapsed
            print(f'SIGINT_AT {elapsed:.1f}s (accepted={accepted_at:.1f}s, record_seen={new_record_at is not None})', flush=True)
        if args.mode == 'normal' and new_record_at is not None and elapsed - new_record_at >= 4:
            os.write(master, b'\x04')  # Ctrl-D: leave the TUI without touching menus
            print('EOF_SENT', flush=True)
            new_record_at = new_record_at  # keep
            args.mode = 'closing'
        if proc.poll() is not None:
            break
        if elapsed > args.max_wait:
            print('MAX_WAIT_REACHED', flush=True)
            os.kill(proc.pid, signal.SIGINT)
            try:
                proc.wait(timeout=15)
            except subprocess.TimeoutExpired:
                os.kill(proc.pid, signal.SIGINT)
                try:
                    proc.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    print('STILL_ALIVE_AFTER_SIGINT', flush=True)
            break

    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        print('STILL_ALIVE_AFTER_EXIT', flush=True)
    for _ in range(10):
        if not drain(0.1):
            break
    print(f'EXIT_CODE {proc.returncode}', flush=True)
    print(f'RECORDS_BEFORE {before} AFTER {records(recdir)}', flush=True)
    log.close()
    os.close(master)


if __name__ == '__main__':
    sys.exit(main())
