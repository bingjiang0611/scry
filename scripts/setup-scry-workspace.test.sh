#!/bin/sh
set -eu

script_dir="$(cd "$(dirname "$0")" && pwd -P)"
temporary_root="$(mktemp -d)"
trap 'rm -rf "$temporary_root"' EXIT HUP INT TERM

fake_scry="$temporary_root/scry"
workspace="$temporary_root/my project"
mkdir -p "$workspace/.claude"
git -C "$workspace" init -q
printf '{"env":{"KEEP":"yes"}}\n' > "$workspace/.claude/settings.local.json"

printf '#!/bin/sh\nif [ "${1:-}" = doctor ]; then [ -f "${3:-}/scry.config.json" ] || exit 3; exit "${FAKE_DOCTOR_RC:-0}"; fi\nprintf "%%s\\n" "$*" >> "$FAKE_SCRY_LOG"\ncat >/dev/null\n' > "$fake_scry"
chmod +x "$fake_scry"

SCRY_PROVIDERS='claude codex qoder' SCRY_CLI_PATH="$fake_scry" \
  "$script_dir/setup-scry-workspace.sh" "$workspace" >/dev/null

grep -Fq '"workspaceId": "my-project"' "$workspace/scry.config.json"
grep -Fq '"toolOutput": "summary"' "$workspace/scry.config.json"
grep -Fq '"KEEP": "yes"' "$workspace/.claude/settings.local.json"
for spec in \
  'claude:.claude/settings.local.json' \
  'codex:.codex/hooks.json' \
  'qoder:.qoder/settings.json'; do
  provider="${spec%%:*}"
  settings="${spec#*:}"
  for event in UserPromptSubmit PreToolUse PostToolUse PostToolUseFailure Stop; do
    [ "$(grep -Fc "$provider $event'" "$workspace/$settings")" -eq 1 ]
  done
done

[ -x "$workspace/.scry/provider-hook.sh" ]
git -C "$workspace" check-ignore -q .scry/record.json
canonical_workspace="$(cd "$workspace" && pwd -P)"
printf '%s\n' '{"session_id":"test"}' | FAKE_SCRY_LOG="$temporary_root/hook.log" \
  "$workspace/.scry/provider-hook.sh" claude UserPromptSubmit
grep -Fq "recorder hook --provider claude --event UserPromptSubmit --workspace $canonical_workspace --stdin --quiet" \
  "$temporary_root/hook.log" || {
    cat "$temporary_root/hook.log" >&2
    exit 1
  }
printf '%s\n' '{"session_id":"managed"}' | \
  FAKE_SCRY_LOG="$temporary_root/hook.log" SCRY_RECORDER_MANAGED=1 SCRY_CLI_PATH="$fake_scry" \
  "$workspace/.scry/provider-hook.sh" codex Stop
grep -Fq "recorder hook --provider codex --event Stop --workspace $canonical_workspace --stdin --quiet --managed" \
  "$temporary_root/hook.log"

before="$(cksum "$workspace/scry.config.json" "$workspace/.claude/settings.local.json" "$workspace/.codex/hooks.json" "$workspace/.qoder/settings.json")"
FAKE_DOCTOR_RC=5 SCRY_PROVIDERS='claude codex qoder' SCRY_CLI_PATH="$fake_scry" \
  "$script_dir/setup-scry-workspace.sh" "$workspace" >/dev/null 2>&1
after="$(cksum "$workspace/scry.config.json" "$workspace/.claude/settings.local.json" "$workspace/.codex/hooks.json" "$workspace/.qoder/settings.json")"
[ "$before" = "$after" ]

if SCRY_PROVIDERS='opencode' SCRY_CLI_PATH="$fake_scry" \
  "$script_dir/setup-scry-workspace.sh" "$workspace" >/dev/null 2>&1; then
  printf 'unsupported provider unexpectedly succeeded\n' >&2
  exit 1
fi
if SCRY_PROVIDERS='claude' SCRY_CLI_PATH="$fake_scry" \
  "$script_dir/setup-scry-workspace.sh" "$workspace/missing" >/dev/null 2>&1; then
  printf 'missing workspace unexpectedly succeeded\n' >&2
  exit 1
fi

printf 'PASS setup-scry-workspace\n'
