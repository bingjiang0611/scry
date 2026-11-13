#!/usr/bin/env bash
# One separate manual diagnostic, never a replacement for primary or A/A evidence.
set -uo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
output=../native-results
(sudo -n /usr/bin/fs_usage -w -f filesys -t 15 mdworker mdworker_shared mds mds_stores \
  2> "$output/indexer-trace-stderr.log" | node scripts/performance-indexer-trace.mjs \
  > "$output/indexer-observed-counts.json") &
trace_pid=$!
status=0
node .agents/skills/scry-performance-climb/scripts/timing-run.mjs native-process-profile -- \
  node scripts/performance-native-run.mjs bench "$output/runner-profile.json" \
  > "$output/runner-profile-timing.log" 2>&1 || status=$?
trace_status=0
# fs_usage has its own fixed 15-second duration. Wait for this exact owned pipeline;
# do not kill processes by name or change SIP, indexing or other system settings.
wait "$trace_pid" || trace_status=$?
finalize_status=0
node --input-type=module - "$trace_status" <<'JS' || finalize_status=$?
import { readFileSync, writeFileSync } from 'node:fs'
import { finalizeIndexerTrace } from './scripts/performance-indexer-trace.mjs'
const counts = JSON.parse(readFileSync('../native-results/indexer-observed-counts.json', 'utf8'))
const report = finalizeIndexerTrace(counts, Number(process.argv[2]))
writeFileSync('../native-results/indexer-trace.json', JSON.stringify(report, null, 2))
JS
if [ "$status" -ne 0 ]; then exit "$status"; fi
exit "$finalize_status"
