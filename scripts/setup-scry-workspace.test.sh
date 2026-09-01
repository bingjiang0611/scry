#!/bin/sh
set -eu

script_dir="$(cd "$(dirname "$0")" && pwd -P)"
temporary_root="$(mktemp -d)"
trap 'rm -rf "$temporary_root"' EXIT HUP INT TERM

fake_scry="$temporary_root/scry"
workspace="$temporary_root/my project"
mkdir -p "$workspace"
git -C "$workspace" init -q
canonical_workspace="$(cd "$workspace" && pwd -P)"

printf '#!/bin/sh\nprintf "%%s\\n" "$*" > "$FAKE_SCRY_LOG"\n' > "$fake_scry"
chmod +x "$fake_scry"

FAKE_SCRY_LOG="$temporary_root/explicit.log" SCRY_PROVIDERS='claude codex opencode' SCRY_CLI_PATH="$fake_scry" \
  "$script_dir/setup-scry-workspace.sh" "$workspace"
grep -Fq "init --workspace $canonical_workspace --providers claude codex opencode" "$temporary_root/explicit.log"

FAKE_SCRY_LOG="$temporary_root/detected.log" SCRY_CLI_PATH="$fake_scry" \
  "$script_dir/setup-scry-workspace.sh" "$workspace"
grep -Fq "init --workspace $canonical_workspace" "$temporary_root/detected.log"
if grep -Fq -- '--providers' "$temporary_root/detected.log"; then
  printf 'wrapper unexpectedly added providers\n' >&2
  exit 1
fi

if SCRY_CLI_PATH="$fake_scry" "$script_dir/setup-scry-workspace.sh" "$workspace/missing" >/dev/null 2>&1; then
  printf 'missing workspace unexpectedly succeeded\n' >&2
  exit 1
fi

printf 'PASS setup-scry-workspace\n'
