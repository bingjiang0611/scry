#!/bin/bash
# Wait for one exact GitHub run. Never dispatch, rerun, or cancel it.
set -euo pipefail
if [[ $# -lt 1 || $# -gt 2 || ! $1 =~ ^[0-9]+$ ]]; then
  echo "Usage: bash scripts/wait-ci.sh RUN_ID [OWNER/REPO]" >&2
  exit 2
fi
run=$1
repo=${2:-bingjiang0611/scry}
if gh run watch "$run" --repo "$repo" --exit-status --compact --interval 30; then
  echo "Run $run: success"
else
  status=$?
  echo "Run $run: watch exited $status; failed jobs and steps:" >&2
  gh run view "$run" --repo "$repo" --json status,conclusion,jobs \
    --jq '{status, conclusion, jobs: [.jobs[] | select(.conclusion != "success" and .conclusion != "skipped") | {id: .databaseId, name, conclusion, steps: [.steps[] | select(.conclusion != "success" and .conclusion != "skipped") | {name, conclusion}]}]}' || true
  log=$(mktemp "${TMPDIR:-/tmp}/scry-ci-$run.XXXXXX")
  if gh run view "$run" --repo "$repo" --log-failed >"$log" 2>&1; then
    echo "Failed-job log: $log (last 80 lines)" >&2
  else
    echo "Failed-job logs unavailable; diagnostic: $log" >&2
  fi
  tail -n 80 "$log"
  exit "$status"
fi
