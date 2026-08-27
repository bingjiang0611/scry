#!/bin/sh
set -eu

script_dir="$(cd "$(dirname "$0")" && pwd -P)"
temporary_root="$(mktemp -d)"
trap 'rm -rf "$temporary_root"' EXIT HUP INT TERM

fake_scry="$temporary_root/scry"
workspace="$temporary_root/my project"
mkdir -p "$workspace"
git -C "$workspace" init -q

printf '#!/bin/sh\n[ "${1:-}" = doctor ] || exit 2\n[ -f "${3:-}/scry.config.json" ] || exit 3\nexit "${FAKE_DOCTOR_RC:-0}"\n' > "$fake_scry"
chmod +x "$fake_scry"

SCRY_CLI_PATH="$fake_scry" "$script_dir/setup-scry-workspace.sh" "$workspace" >/dev/null
[ -f "$workspace/scry.config.json" ]
grep -Fq '"workspaceId": "my-project"' "$workspace/scry.config.json"
node -e '
  const config = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))
  if (config.schemaVersion !== 1 || config.dataDir !== ".scry" || config.capture.toolOutput !== "summary") process.exit(1)
' "$workspace/scry.config.json"
git -C "$workspace" check-ignore -q .scry/record.json

before="$(cksum "$workspace/scry.config.json")"
FAKE_DOCTOR_RC=5 SCRY_CLI_PATH="$fake_scry" "$script_dir/setup-scry-workspace.sh" "$workspace" >/dev/null 2>&1
after="$(cksum "$workspace/scry.config.json")"
[ "$before" = "$after" ]

if SCRY_CLI_PATH="$fake_scry" "$script_dir/setup-scry-workspace.sh" "$workspace/missing" >/dev/null 2>&1; then
  printf 'missing workspace unexpectedly succeeded\n' >&2
  exit 1
fi

printf 'PASS setup-scry-workspace\n'
