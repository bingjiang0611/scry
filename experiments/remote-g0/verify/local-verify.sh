#!/usr/bin/env bash
# Local (macOS + paired iPhone) verification of the iOS remote transport work.
# Driven by docs/handoff/ios-remote-verification/TASK.md. Every stage records
# its outcome; nothing here deploys the relay or touches user data on the Mac
# beyond installing/restarting Scry, which the TASK requires consent for.
#
#   experiments/remote-g0/verify/local-verify.sh all
#   experiments/remote-g0/verify/local-verify.sh <stage> [args...]
#
# Stages: env checks install-mac restart-mac build-ios install-ios
#         relay-probe <label> netbench <label> [extra -netBench args]
#         host-quit summarize
# Environment:
#   SCRY_IOS_DEVICE_ID          iPhone UDID (auto-detected when exactly one is connected)
#   SCRY_IOS_DEVELOPMENT_TEAM   signing team for the device build (required for build-ios)
#   SCRY_VERIFY_RESULTS         results dir (default: docs/handoff/ios-remote-verification/results/<UTC stamp>)
#   SCRY_VERIFY_ALLOW_RESTART=1 permission to quit/reopen /Applications/Scry.app (restart-mac, host-quit)
#   SCRY_RELAY_URL              relay origin for the probe (default wss://scry-relay-pages.pages.dev)
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT"
STAMP="${SCRY_VERIFY_STAMP:-$(date -u +%Y%m%dT%H%M%SZ)}"
RESULTS="${SCRY_VERIFY_RESULTS:-$ROOT/docs/handoff/ios-remote-verification/results/$STAMP}"
mkdir -p "$RESULTS/logs" "$RESULTS/raw"
CHECKS="$RESULTS/checks.json"
[ -f "$CHECKS" ] || echo '{"stages":[]}' > "$CHECKS"
# The phone's installed app is com.scry.remote.local (a free developer profile
# allows three apps per device, so a new bundle id cannot be installed). Override
# only when the device already holds that bundle, so the install updates it in
# place and keeps the existing pairing and Keychain access group.
BUNDLE_ID="${SCRY_IOS_BUNDLE_ID:-com.scry.remote}"
# The host under test is the installed bundle, matched by path: other checkouts
# keep their own Scry processes alive and a name-only match would quit or wait
# on them instead. `pgrep -f` reads argv, which is empty for a LaunchServices
# launch, so match the ps command line of the main process exactly (helpers
# carry extra arguments and do not match).
HOST_APP="/Applications/Scry.app"
# `set -o pipefail` would turn grep -q's early exit (SIGPIPE on ps) into a
# failure, so compare against a captured list instead of a pipeline.
host_running() {
  local table
  table="$(ps -Ao command=)"
  grep -q -x -F "$HOST_APP/Contents/MacOS/Scry" <<<"$table"
}
APP_PATH="/tmp/scry-remote-device-build/Build/Products/Debug-iphoneos/ScryRemote.app"
NO_PROXY_ENV=(env -u HTTPS_PROXY -u HTTP_PROXY -u https_proxy -u http_proxy)

log() { printf '[verify %s] %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }

# record <name> <status> <exitCode> <seconds> <logfile>
record() {
  node -e '
    const fs = require("fs"); const [file, name, status, code, seconds, log] = process.argv.slice(1)
    const data = JSON.parse(fs.readFileSync(file, "utf8"))
    data.stages = data.stages.filter((s) => s.name !== name)
    data.stages.push({ name, status, exitCode: Number(code), seconds: Number(seconds), log })
    fs.writeFileSync(file, JSON.stringify(data, null, 2))' "$CHECKS" "$1" "$2" "$3" "$4" "$5"
}

# step <name> <command...>: run, log fully to logs/<name>.log (gitignored),
# keep a committed tail, record pass/fail.
step() {
  local name="$1"; shift
  local logfile="$RESULTS/logs/$name.log"
  local started=$SECONDS
  log "stage $name: $*"
  "$@" > "$logfile" 2>&1
  local code=$?
  tail -c 12000 "$logfile" > "$RESULTS/logs/$name.tail.txt"
  local status=pass; [ $code -eq 0 ] || status=fail
  record "$name" "$status" "$code" "$((SECONDS - started))" "logs/$name.tail.txt"
  log "stage $name: $status (exit $code, $((SECONDS - started)) s)"
  return $code
}

skip() { record "$1" skip 0 0 "-"; log "stage $1: skipped ($2)"; }

device_id() {
  if [ -n "${SCRY_IOS_DEVICE_ID:-}" ]; then echo "$SCRY_IOS_DEVICE_ID"; return; fi
  local json; json="$(mktemp)"
  xcrun devicectl list devices --json-output "$json" >/dev/null 2>&1 || { rm -f "$json"; return 1; }
  node -e '
    const d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))
    const phones = (d.result?.devices ?? []).filter((x) => x.hardwareProperties?.platform === "iOS" &&
      (x.connectionProperties?.tunnelState === "connected" || x.connectionProperties?.pairingState === "paired"))
    if (phones.length !== 1) { console.error(`found ${phones.length} candidate iPhones; set SCRY_IOS_DEVICE_ID`); process.exit(1) }
    console.log(phones[0].hardwareProperties.udid)' "$json"
  local code=$?; rm -f "$json"; return $code
}

stage_env() {
  {
    echo "revision=$(git rev-parse HEAD)"
    echo "dirty=$(git status --porcelain | wc -l | tr -d ' ')"
    echo "macos=$(sw_vers -productVersion 2>/dev/null) arch=$(uname -m)"
    echo "xcode=$(xcodebuild -version 2>/dev/null | tr '\n' ' ')"
    echo "swift=$(swift --version 2>/dev/null | head -1)"
    echo "node=$(node --version)"
    echo "device=$(device_id 2>&1)"
    echo "scry_running=$(host_running && echo yes || echo no)"
  } > "$RESULTS/env.txt"
  cat "$RESULTS/env.txt" >&2
}

stage_checks() {
  [ -d node_modules ] || step npm-ci npm ci
  step typecheck-node npm run -s typecheck:node
  step node-unit npm run -s test:unit -- src/main/remote src/main/bootstrap
  [ -d experiments/remote-g0/node_modules ] || step g0-npm-ci npm --prefix experiments/remote-g0 ci
  step g0-node-tests npm --prefix experiments/remote-g0 test
  step cf-relay-smokes "${NO_PROXY_ENV[@]}" bash -c 'node experiments/remote-g0/cf-relay-smoke.mjs && node experiments/remote-g0/cf-relay-lifecycle-smoke.mjs'
  step swift-test swift test --package-path experiments/remote-g0/swift
  step ios-checks bash -c 'python3 apps/ios/Checks/catalog-refresh.py && python3 apps/ios/Checks/catalog-refresh.py --check observation --require-isolation && python3 apps/ios/Checks/new-task-readiness.py'
}

stage_install_mac() { step install-mac npm run install:mac:dev; }

quit_scry() {
  osascript -e 'tell application "Scry" to quit' >/dev/null 2>&1 || true
  for _ in $(seq 1 30); do host_running || return 0; sleep 1; done
  log "Scry did not quit within 30 s"; return 1
}

open_scry() {
  open -a "$HOST_APP" || return 1
  # Relay legs and the LAN listener come up after start; give them time.
  sleep "${SCRY_VERIFY_HOST_WARMUP:-20}"
}

stage_restart_mac() {
  if [ "${SCRY_VERIFY_ALLOW_RESTART:-0}" != 1 ]; then skip restart-mac "SCRY_VERIFY_ALLOW_RESTART is not 1; ask the user to quit and reopen Scry"; return 0; fi
  # The functions travel into the subshell, so the path they use must too.
  step restart-mac bash -c "HOST_APP='$HOST_APP'; $(declare -f log host_running quit_scry open_scry); quit_scry && open_scry"
}

stage_build_ios() {
  local id; id="$(device_id)" || { skip build-ios "no device id"; return 1; }
  if [ -z "${SCRY_IOS_DEVELOPMENT_TEAM:-}" ]; then skip build-ios "SCRY_IOS_DEVELOPMENT_TEAM not set"; return 1; fi
  step build-ios xcodebuild -project apps/ios/ScryRemote.xcodeproj -scheme ScryRemote -configuration Debug \
    -sdk iphoneos -destination "id=$id" -derivedDataPath /tmp/scry-remote-device-build \
    DEVELOPMENT_TEAM="$SCRY_IOS_DEVELOPMENT_TEAM" PRODUCT_BUNDLE_IDENTIFIER="$BUNDLE_ID" \
    CODE_SIGN_STYLE=Automatic -allowProvisioningUpdates build
}

stage_install_ios() {
  local id; id="$(device_id)" || { skip install-ios "no device id"; return 1; }
  step install-ios xcrun devicectl device install app --device "$id" "$APP_PATH"
}

stage_relay_probe() {
  local label="${1:-mac}"
  local out="$RESULTS/relay-probe-$label.jsonl"
  step "relay-probe-$label" bash -c "node experiments/remote-g0/relay-path-probe.mjs '${SCRY_RELAY_URL:-wss://scry-relay-pages.pages.dev}' --samples=10 > '$out'"
}

# Keep committed result files under the 20 KB staged-file gate: the full copy
# stays in raw/ (gitignored); the committed one drops per-tunnel timings beyond
# the first 12 when it would be too large.
trim_for_commit() {
  node -e '
    const fs = require("fs"); const [src, dst] = process.argv.slice(1)
    let lines = fs.readFileSync(src, "utf8").split("\n").filter(Boolean)
    if (Buffer.byteLength(lines.join("\n")) > 19000) {
      lines = lines.map((line) => { const o = JSON.parse(line)
        if (o.event === "tunnels" && o.diagnostics?.timings?.length > 12) { o.diagnostics.timingsTrimmed = o.diagnostics.timings.length; o.diagnostics.timings = o.diagnostics.timings.slice(0, 12) }
        return JSON.stringify(o) })
    }
    fs.writeFileSync(dst, lines.join("\n") + "\n")' "$1" "$2"
}

stage_netbench() {
  local label="$1"; shift
  local id; id="$(device_id)" || { skip "netbench-$label" "no device id"; return 1; }
  local raw="$RESULTS/raw/netbench-$label.jsonl"
  local started=$SECONDS
  log "netbench $label: launching on $id with $*"
  xcrun devicectl device process launch --device "$id" --terminate-existing "$BUNDLE_ID" \
    -- -netBench "-netBenchLabel=$label" "$@" > "$RESULTS/logs/netbench-$label.launch.log" 2>&1 || {
      record "netbench-$label" fail 1 $((SECONDS - started)) "logs/netbench-$label.launch.log"; log "launch failed (device locked?)"; return 1; }
  rm -f "$raw"
  for _ in $(seq 1 72); do
    sleep 5
    xcrun devicectl device copy from --device "$id" --domain-type appDataContainer --domain-identifier "$BUNDLE_ID" \
      --source Documents/netbench/latest.jsonl --destination "$raw" > /dev/null 2>&1 || continue
    if grep -q '"event":"done"' "$raw" 2>/dev/null && grep -q "\"label\":\"$label\"" "$raw"; then
      trim_for_commit "$raw" "$RESULTS/netbench-$label.jsonl"
      local failures; failures="$(grep '"event":"done"' "$raw" | sed -E 's/.*"failures":([0-9]+).*/\1/')"
      local status=pass; [ "$failures" = 0 ] || status=fail
      [ "$label" = host-quit ] && status=pass   # expected to fail requests; judged by summarize
      record "netbench-$label" "$status" "$failures" $((SECONDS - started)) "netbench-$label.jsonl"
      log "netbench $label: done, failures=$failures"
      return 0
    fi
  done
  [ -f "$raw" ] && trim_for_commit "$raw" "$RESULTS/netbench-$label.jsonl"
  record "netbench-$label" fail 124 $((SECONDS - started)) "netbench-$label.jsonl"
  log "netbench $label: no done event within 6 minutes"
  return 1
}

stage_host_quit() {
  if [ "${SCRY_VERIFY_ALLOW_RESTART:-0}" != 1 ]; then skip netbench-host-quit "SCRY_VERIFY_ALLOW_RESTART is not 1"; return 0; fi
  quit_scry || return 1
  sleep 5
  stage_netbench host-quit -netBenchRounds=3
  local code=$?
  open_scry
  return $code
}

stage_summarize() {
  node experiments/remote-g0/verify/summarize.mjs "$RESULTS"
}

stage="${1:-}"; shift || true
case "$stage" in
  env) stage_env ;;
  checks) stage_checks ;;
  install-mac) stage_install_mac ;;
  restart-mac) stage_restart_mac ;;
  build-ios) stage_build_ios ;;
  install-ios) stage_install_ios ;;
  relay-probe) stage_relay_probe "$@" ;;
  netbench) stage_netbench "$@" ;;
  host-quit) stage_host_quit ;;
  summarize) stage_summarize ;;
  all)
    stage_env
    stage_checks
    stage_install_mac
    stage_restart_mac
    stage_build_ios && stage_install_ios
    stage_relay_probe mac
    stage_netbench wifi-relay -netBenchRoute=relay -netBenchRounds=5
    stage_netbench wifi-auto -netBenchRounds=5
    stage_host_quit
    stage_summarize
    ;;
  *) sed -n '2,20p' "$0"; exit 2 ;;
esac
