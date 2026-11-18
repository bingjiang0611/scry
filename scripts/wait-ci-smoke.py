#!/usr/bin/env python3
"""Offline shell-wrapper checks, no npm install/build or live CI mutation."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).with_name("wait-ci.sh")
FAKE_GH = """#!/bin/bash
printf '%s\\n' "$*" >> "$CALLS"
case "$*" in
  *"run watch"*) exit "$WATCH_STATUS" ;;
  *"--json"*) echo '{"status":"completed","conclusion":"failure","jobs":[{"name":"unit","conclusion":"failure"}]}' ;;
  *"--log-failed"*) echo 'failed step: assertion evidence'; exit "${LOG_STATUS:-0}" ;;
  *) exit 97 ;;
esac
"""


class WaitTests(unittest.TestCase):
    def run_wait(self, status, log_status=0, args=None):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            gh = root / "gh"
            gh.write_text(FAKE_GH)
            gh.chmod(0o700)
            env = dict(os.environ, PATH=f"{root}:{os.environ['PATH']}", TMPDIR=directory,
                       CALLS=str(root / "calls"), WATCH_STATUS=str(status), LOG_STATUS=str(log_status))
            result = subprocess.run(["bash", str(SCRIPT), *(args or ["42", "owner/repo"])],
                                    env=env, capture_output=True, text=True, timeout=5)
            calls = (root / "calls").read_text() if (root / "calls").exists() else ""
            logs = [p.read_text() for p in root.glob("scry-ci-*")]
            return result, calls, logs

    def test_success_exact_run(self):
        result, calls, logs = self.run_wait(0)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(calls, "run watch 42 --repo owner/repo --exit-status --compact --interval 30\n")
        self.assertEqual(logs, [])

    def test_failure_reports_jobs_and_keeps_logs(self):
        result, calls, logs = self.run_wait(1)
        self.assertEqual(result.returncode, 1)
        self.assertIn('"name":"unit"', result.stdout)
        self.assertIn("assertion evidence", result.stdout)
        self.assertIn("--log-failed", calls)
        self.assertEqual(logs, ["failed step: assertion evidence\n"])

    def test_diagnostic_failure_preserves_watch_exit(self):
        result, _, _ = self.run_wait(4, 7)
        self.assertEqual(result.returncode, 4)
        self.assertIn("logs unavailable", result.stderr)

    def test_invalid_id_never_calls_gh(self):
        result, calls, _ = self.run_wait(0, args=["latest"])
        self.assertEqual(result.returncode, 2)
        self.assertEqual(calls, "")

    def test_default_repo(self):
        result, calls, _ = self.run_wait(0, args=["42"])
        self.assertEqual(result.returncode, 0)
        self.assertIn("--repo bingjiang0611/scry", calls)


if __name__ == "__main__":
    unittest.main()
