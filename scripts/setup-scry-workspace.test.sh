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

printf '#!/bin/sh\nprintf "%%s\\n" "$#" > "$FAKE_SCRY_LOG"\nfor arg do printf "%%s\\n" "$arg" >> "$FAKE_SCRY_LOG"; done\nexit "${FAKE_SCRY_EXIT:-0}"\n' > "$fake_scry"
chmod +x "$fake_scry"

assert_args() {
  log="$1"
  shift
  expected_count="$#"
  actual_count="$(sed -n '1p' "$log")"
  [ "$actual_count" = "$expected_count" ] || {
    printf 'wrong argv count: expected %s, got %s\n' "$expected_count" "$actual_count" >&2
    exit 1
  }
  line=2
  for expected do
    actual="$(sed -n "${line}p" "$log")"
    [ "$actual" = "$expected" ] || {
      printf 'wrong argv[%s]: expected <%s>, got <%s>\n' "$((line - 2))" "$expected" "$actual" >&2
      exit 1
    }
    line=$((line + 1))
  done
}

FAKE_SCRY_LOG="$temporary_root/explicit.log" SCRY_PROVIDERS='claude codex opencode' SCRY_CLI_PATH="$fake_scry" \
  "$script_dir/setup-scry-workspace.sh" "$workspace"
assert_args "$temporary_root/explicit.log" init --workspace "$canonical_workspace" --providers 'claude codex opencode'

FAKE_SCRY_LOG="$temporary_root/detected.log" SCRY_CLI_PATH="$fake_scry" \
  "$script_dir/setup-scry-workspace.sh" "$workspace"
assert_args "$temporary_root/detected.log" init --workspace "$canonical_workspace"
if grep -Fq -- '--providers' "$temporary_root/detected.log"; then
  printf 'wrapper unexpectedly added providers\n' >&2
  exit 1
fi

if SCRY_CLI_PATH="$fake_scry" "$script_dir/setup-scry-workspace.sh" "$workspace/missing" >/dev/null 2>&1; then
  printf 'missing workspace unexpectedly succeeded\n' >&2
  exit 1
fi

status=0
FAKE_SCRY_LOG="$temporary_root/failed.log" FAKE_SCRY_EXIT=17 SCRY_CLI_PATH="$fake_scry" \
  "$script_dir/setup-scry-workspace.sh" "$workspace" >/dev/null 2>&1 || status=$?
if [ "$status" -ne 17 ]; then
  printf 'wrapper changed downstream exit 17 to %s\n' "$status" >&2
  exit 1
fi
assert_args "$temporary_root/failed.log" init --workspace "$canonical_workspace"

printf 'PASS setup-scry-workspace\n'
