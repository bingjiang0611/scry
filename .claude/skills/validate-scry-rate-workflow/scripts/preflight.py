#!/usr/bin/env python3
"""Reconcile recoverable local state, then freeze one Scry validation identity."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import tomllib
from pathlib import Path
from typing import Any


SKILL_DIR = Path(__file__).resolve().parent.parent
CONTRACT_PATH = SKILL_DIR / "references" / "contract.json"
CONTRACT = json.loads(CONTRACT_PATH.read_text(encoding="utf-8"))
RECOVERY = CONTRACT["recoveryPolicy"]
RECORDER_RECOVERY = RECOVERY["recorder"]
CONFIG_RECOVERY = RECOVERY["config"]
DEPENDENCY_RECOVERY = RECOVERY["dependencies"]
DEFAULT_SCRY_REPO = Path("/Users/baobingjiang/IdeaProjects/vibecoding/scry")
DEFAULT_RATE_NATIVE_REPO = Path("/Users/baobingjiang/IdeaProjects/rate-native")
EXPECTED_QODER_CONTRACT = {
    "displayName": "Qoder",
    "command": "/rate-native-rate-workflow",
    "skill": "rate-workflow",
    "mcpConfigPaths": [
        "$HOME/.qoder/mcp.json",
        "$WORKSPACE/.mcp.json",
        "$WORKSPACE/.qoder/mcp.json",
    ],
}
EXPECTED_CONTRACT_SCHEMA_VERSION = 8
EXPECTED_PI_CONTRACT = {
    "runtime": "pi_rpc",
    "cli": "pi",
    "displayName": "Pi",
    "treehouseSlot": 5,
    "command": "/skill:rate-workflow",
    "skill": "rate-workflow",
    "agentProfileId": "pi:default",
    "permissionLabel": "本机完全访问",
    "mcpExecution": "none",
    "mcpConfigPaths": [],
}
EXPECTED_PI_SETTINGS = {"skills": ["../.claude/skills"]}
LOCAL_SETTINGS_RELATIVE = (
    ".claude/settings.local.json",
    ".qoder/settings.local.json",
    ".codex/settings.local.json",
    ".opencode/settings.local.json",
)
EMPTY_RATE_NATIVE_RECORDER = {
    "hookPinnedVersion": None,
    "initPinnedVersions": [],
    "cliPathBySettings": {},
    "cliPath": None,
    "cliPathConflicts": [],
    "cli": {"path": None, "absolute": False, "executable": False, "version": None},
}
EXPECTED_SOURCE_WORKITEM_CONTRACT = {
    "id": "85076624",
    "projectId": "952011",
    "url": "https://project.aone.alibaba-inc.com/v2/project/952011/req/85076624",
}
EXPECTED_CLONE_HANDOFF_CONTRACT = {
    "mode": "user_only",
    "agentMayClone": False,
    "waitingStatus": "WAITING_FOR_USER_CLONE",
    "acceptedInputs": ["workitem_id", "canonical_url"],
    "cloneIdMustDifferFromSource": True,
    "pauseBeforeProviderClaim": True,
    "resumeRequiresFreshPreflight": True,
}
EXPECTED_RETENTION_CONTRACT = {
    "mode": "retain_for_review",
    "runRootParent": "/Users/baobingjiang/.local/state/validate-scry-rate-workflow",
    "keepTestAppRunning": True,
    "keepWorkspaceRuntime": True,
    "keepProviderLock": True,
    "autoCleanupBeforeFirstPrompt": True,
    "postSendCleanupRequiresExplicitUserRequest": True,
    "sendIntentEvidence": "turn1-send-intent.json",
    "draftEvidence": "turn1-draft.json",
}
EXPECTED_RECOVERY_CONTRACT = {
    "maxAttempts": 2,
    "freezeAfterRecovery": True,
    "quarantineInsteadOfDelete": True,
    "legacyPostSendCleanupContracts": [
        {
            "schemaVersion": 7,
            "sha256": "sha256:094da09efeff88641de70eca6964594c23547d0afbf5544fe6ad04e975c25661",
            "cleanupCompatibleWithSchemaVersion": 8,
        }
    ],
    "legacyRetainedDraftCleanupContracts": [
        {
            "schemaVersion": 8,
            "sha256": "sha256:05095bef930165e3c165ab4cf7e9ddaaffb36fa23f891a7435571bef1c19adf0",
            "cleanupCompatibleWithSchemaVersion": 8,
        }
    ],
    "runtimeSnapshot": {"relativePath": "scry-runtime", "stateVersion": 3},
    "scryIgnoredUntrackedPrefixes": ["designs/"],
    "treehousePool": {
        "pruneStaleWorktreeRegistry": True,
        "maxRegistryRepairsPerLease": 1,
    },
    "dependencies": {
        "installIfMissing": True,
        "lockfile": "package-lock.json",
        "modulesDir": "node_modules",
        "installArgs": ["ci", "--no-audit", "--no-fund"],
        "requiredExecutables": [
            "node_modules/.bin/electron-vite",
            "node_modules/.bin/electron",
        ],
        "requiredPaths": [
            "node_modules/.package-lock.json",
            "node_modules/electron/dist/Electron.app",
        ],
        "binaryInstallers": [
            {
                "requiredPath": "node_modules/electron/dist/Electron.app",
                "script": "node_modules/electron/install.js",
            }
        ],
        "timeoutSeconds": 3600,
    },
    "recorder": {
        "package": "@ali/scry-turn-recorder",
        "registry": "https://registry.anpm.alibaba-inc.com",
        "installPrefix": "/Users/baobingjiang/.local",
        "publishIfMissing": False,
        "nodeBinDir": "/Users/baobingjiang/.nvm/versions/node/v22.22.1/bin",
    },
    "config": {
        "authoritativeRepo": "/Users/baobingjiang/IdeaProjects/rate-native",
        "sourceCandidates": list(LOCAL_SETTINGS_RELATIVE),
        "managedTargets": list(LOCAL_SETTINGS_RELATIVE),
        "requiredEnvKeys": ["SCRY_CLI_PATH", "DINGTALK_DOC_MCP_URL"],
        "copiedEnvKeys": [
            "SCRY_CLI_PATH",
            "DINGTALK_DOC_MCP_URL",
            "NEXTCR_API_KEY",
            "CC_DINGTALK_USERID",
            "CC_ACTOR_NICK",
        ],
        "mode": "0600",
    },
}
RECOVERABLE_CHECKS = {
    "config.rate_native_settings",
    "version.installed_cli",
    "version.installed_cli_provenance",
    "version.rate_native_cli_path",
    "version.rate_native_cli",
}


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def command(
    command: list[str],
    cwd: Path | None = None,
    timeout: int = 30,
    env: dict[str, str] | None = None,
) -> tuple[int, str]:
    try:
        result = subprocess.run(
            command,
            cwd=cwd,
            text=True,
            encoding="utf-8",
            errors="replace",
            capture_output=True,
            timeout=timeout,
            check=False,
            env=env,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return 127, str(exc)
    return result.returncode, (result.stdout + result.stderr).strip()


def hash_untracked(repo: Path, relatives: list[str]) -> str:
    digest = hashlib.sha256()
    for relative in relatives:
        path = repo / relative
        digest.update(relative.encode())
        digest.update(b"\0")
        try:
            if path.is_symlink():
                digest.update(str(path.readlink()).encode())
            elif path.is_file():
                with path.open("rb") as handle:
                    for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                        digest.update(chunk)
        except OSError as exc:
            digest.update(f"<unreadable:{type(exc).__name__}>".encode())
        digest.update(b"\0")
    return digest.hexdigest()


def git_fingerprint(repo: Path, ignored_untracked_prefixes: tuple[str, ...] = ()) -> dict[str, Any]:
    head_code, head = command(["git", "rev-parse", "HEAD"], repo)
    tree_code, tree = command(["git", "rev-parse", "HEAD^{tree}"], repo)
    status_code, status = command(["git", "status", "--porcelain=v1", "-z", "--untracked-files=no"], repo)
    diff_code, diff = command(["git", "diff", "--binary", "HEAD", "--"], repo)
    untracked_code, untracked = command(["git", "ls-files", "--others", "--exclude-standard", "-z"], repo)
    untracked_files = sorted(item for item in untracked.split("\0") if item) if untracked_code == 0 else []
    ignored_untracked = [
        relative for relative in untracked_files
        if any(relative.startswith(prefix) for prefix in ignored_untracked_prefixes)
    ]
    relevant_untracked = [relative for relative in untracked_files if relative not in ignored_untracked]
    relevant_untracked_hash = hash_untracked(repo, relevant_untracked)
    audit_untracked_hash = hash_untracked(repo, untracked_files)
    payload = (
        (status if status_code == 0 else "")
        + "\0"
        + (diff if diff_code == 0 else "")
        + "\0"
        + relevant_untracked_hash
    )
    audit_payload = payload + "\0" + audit_untracked_hash
    return {
        "head": head if head_code == 0 else None,
        "treeHash": tree if tree_code == 0 else None,
        "dirty": bool(status or relevant_untracked) if status_code == 0 and untracked_code == 0 else None,
        "auditDirty": bool(status or untracked_files) if status_code == 0 and untracked_code == 0 else None,
        "worktreeHash": "sha256:" + hashlib.sha256(payload.encode()).hexdigest(),
        "auditWorktreeHash": "sha256:" + hashlib.sha256(audit_payload.encode()).hexdigest(),
        "untrackedFiles": len(untracked_files),
        "relevantUntrackedFiles": len(relevant_untracked),
        "ignoredUntrackedFiles": len(ignored_untracked),
        "ignoredUntrackedPrefixes": list(ignored_untracked_prefixes),
    }


def tree_fingerprint(root: Path) -> dict[str, Any]:
    if not root.is_dir():
        return {"exists": False, "files": 0, "sha256": None}
    digest = hashlib.sha256()
    files = 0
    for path in sorted((item for item in root.rglob("*") if item.is_file() or item.is_symlink()), key=lambda item: str(item.relative_to(root))):
        relative = str(path.relative_to(root))
        digest.update(relative.encode())
        digest.update(b"\0")
        if path.is_symlink():
            digest.update(str(path.readlink()).encode())
        else:
            with path.open("rb") as handle:
                for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                    digest.update(chunk)
        digest.update(b"\0")
        files += 1
    return {"exists": True, "files": files, "sha256": "sha256:" + digest.hexdigest()}


def scry_versions(repo: Path) -> dict[str, str | None]:
    package_path = repo / "packages" / "turn-recorder-cli" / "package.json"
    store_path = repo / "src" / "core" / "turn-recorder" / "store.ts"
    package_version = str(load_json(package_path).get("version")) if package_path.is_file() else None
    store_text = store_path.read_text(encoding="utf-8") if store_path.is_file() else ""
    match = re.search(r"RECORDER_VERSION\s*=\s*['\"]([^'\"]+)['\"]", store_text)
    return {"package": package_version, "recorderConstant": match.group(1) if match else None}


def executable_version(executable: str | None, attempts: int = 1, timeout: int = 30) -> dict[str, Any]:
    if not executable:
        return {"path": None, "absolute": False, "executable": False, "version": None}
    candidate = Path(executable)
    absolute = candidate.is_absolute()
    runnable = absolute and candidate.is_file() and os.access(candidate, os.X_OK)
    if not runnable:
        return {"path": executable, "absolute": absolute, "executable": False, "version": None}
    version = None
    for _ in range(attempts):
        code, output = command([str(candidate), "--version"], timeout=timeout)
        version = output.splitlines()[-1].strip() if code == 0 and output else None
        if version:
            break
    return {
        "path": str(candidate.resolve()),
        "absolute": True,
        "executable": True,
        "version": version,
    }


def provider_shell_executable(provider: str, executable: str | None) -> dict[str, Any]:
    if not executable:
        return executable_version(None)
    shell = Path(executable)
    shell_ready = shell.is_absolute() and shell.is_file() and os.access(shell, os.X_OK)
    if not shell_ready:
        return {"path": executable, "absolute": shell.is_absolute(), "executable": False, "version": None}
    verified = os.environ.get("PI_AGENT_VERIFIED_PI_EXECUTABLE") if provider == "pi" else None
    probe_path = verified if verified and Path(verified).is_absolute() else str(shell)
    probe = executable_version(
        probe_path,
        attempts=2 if provider == "pi" else 1,
        timeout=120 if provider == "pi" else 30,
    )
    return {
        "path": str(shell.resolve()),
        "absolute": True,
        "executable": True,
        "version": probe.get("version"),
        "versionProbePath": probe.get("path"),
    }


def local_settings_cli_paths(repo: Path) -> dict[str, str | None]:
    paths: dict[str, str | None] = {}
    for relative in LOCAL_SETTINGS_RELATIVE:
        path = repo / relative
        if not path.is_file():
            continue
        try:
            data = load_json(path)
        except (OSError, ValueError):
            paths[relative] = None
            continue
        env = data.get("env") if isinstance(data, dict) else None
        value = env.get("SCRY_CLI_PATH") if isinstance(env, dict) else None
        paths[relative] = value if isinstance(value, str) and value else None
    return paths


def local_settings_health(repo: Path) -> dict[str, Any]:
    targets: list[dict[str, Any]] = []
    ready = True
    required = [str(key) for key in CONFIG_RECOVERY["requiredEnvKeys"]]
    candidates = [repo / str(relative) for relative in CONFIG_RECOVERY["sourceCandidates"]]
    seed_path = next((path for path in candidates if valid_settings_seed(path) is not None), None)
    seed = valid_settings_seed(seed_path) if seed_path is not None else None
    seed_env = seed.get("env") if isinstance(seed, dict) and isinstance(seed.get("env"), dict) else {}
    if seed_path is None:
        ready = False
    for raw in CONFIG_RECOVERY["managedTargets"]:
        relative = Path(str(raw))
        path = repo / relative
        detail: dict[str, Any] = {"path": relative.as_posix()}
        if path.is_symlink():
            detail.update({"ready": False, "issue": "symlink"})
            ready = False
            targets.append(detail)
            continue
        try:
            value = load_json(path)
        except (OSError, ValueError):
            detail.update({"ready": False, "issue": "missing_or_invalid"})
            ready = False
            targets.append(detail)
            continue
        env = value.get("env") if isinstance(value, dict) else None
        env = env if isinstance(env, dict) else {}
        missing = [key for key in required if not isinstance(env.get(key), str) or not env.get(key)]
        mismatched = [
            str(key)
            for key in CONFIG_RECOVERY["copiedEnvKeys"]
            if key != "SCRY_CLI_PATH" and key in seed_env and env.get(key) != seed_env.get(key)
        ]
        mode = path.stat().st_mode & 0o777
        target_ready = not missing and not mismatched and mode == 0o600
        detail.update({
            "ready": target_ready,
            "envKeys": sorted(env),
            "missingRequiredEnvKeys": missing,
            "authoritativeMismatchedKeys": mismatched,
            "mode": f"{mode:04o}",
        })
        ready = ready and target_ready
        targets.append(detail)
    return {
        "ready": ready,
        "authoritativeSeed": str(seed_path) if seed_path else None,
        "seedReady": seed_path is not None,
        "targets": targets,
    }


# rate-native manages the recorder CLI by absolute path instead of copying a
# version constant into the repository, so the treehouse-side proof is the
# binary its local settings pin.  A repository pin is only evidence when it
# exists: an empty hook default or an unpinned installer is the intended state.
def rate_native_recorder(repo: Path) -> dict[str, Any]:
    hook_path = repo / ".claude" / "hooks" / "scry-recorder.sh"
    init_path = repo / "init.sh"
    hook_text = hook_path.read_text(encoding="utf-8") if hook_path.is_file() else ""
    init_text = init_path.read_text(encoding="utf-8") if init_path.is_file() else ""
    hook_match = re.search(r"SCRY_RECORDER_REQUIRED_VERSION:-([0-9]+\.[0-9]+\.[0-9]+)", hook_text)
    settings = local_settings_cli_paths(repo)
    distinct = sorted({value for value in settings.values() if value})
    resolved = distinct[0] if len(distinct) == 1 else None
    return {
        "hookPinnedVersion": hook_match.group(1) if hook_match else None,
        "initPinnedVersions": sorted(set(re.findall(r"@ali/scry-turn-recorder@([0-9]+\.[0-9]+\.[0-9]+)", init_text))),
        "cliPathBySettings": settings,
        "cliPath": resolved,
        "cliPathConflicts": distinct if len(distinct) > 1 else [],
        "cli": executable_version(resolved),
    }


def path_candidates(name: str) -> list[dict[str, Any]]:
    """Every `name` on PATH, so two same-version installs cannot silently swap.

    A single dangling symlink (a global install pointing into a wiped temp
    worktree) and two executables resolving to different files both broke real
    runs: the first as "no CLI at all", the second as a `which` pick that
    flipped mid-run and snapped the frozen recorder identity."""
    found: list[dict[str, Any]] = []
    seen: set[str] = set()
    for entry in os.environ.get("PATH", "").split(os.pathsep):
        if not entry:
            continue
        candidate = Path(entry) / name
        if str(candidate) in seen or not (candidate.exists() or candidate.is_symlink()):
            continue
        seen.add(str(candidate))
        dangling = candidate.is_symlink() and not candidate.exists()
        executable = candidate.is_file() and os.access(candidate, os.X_OK)
        version = None
        if executable:
            code, output = command([str(candidate), "--version"])
            version = output.splitlines()[-1].strip() if code == 0 and output else None
        found.append({
            "path": str(candidate),
            "resolved": None if dangling else str(candidate.resolve()),
            "dangling": dangling,
            "executable": executable,
            "version": version,
        })
    return sorted(found, key=lambda item: item["path"])


def installed_version() -> dict[str, Any]:
    candidates = path_candidates("scry")
    authoritative = Path(str(RECORDER_RECOVERY["installPrefix"])).expanduser().resolve() / "bin" / "scry"
    executable = executable_version(str(authoritative))
    if executable.get("executable") is not True:
        return {"path": None, "version": None, "candidates": candidates}
    return {
        "path": executable.get("path"),
        "version": executable.get("version"),
        "candidates": candidates,
    }


def installed_recorder_provenance(expected: str | None, prefix_override: Path | None = None) -> dict[str, Any]:
    prefix = (
        prefix_override.resolve()
        if prefix_override is not None
        else Path(str(RECORDER_RECOVERY["installPrefix"])).expanduser().resolve()
    )
    package_root = prefix / "lib" / "node_modules" / "@ali" / "scry-turn-recorder"
    binary = prefix / "bin" / "scry"
    executable = executable_version(str(binary))
    resolved = Path(str(executable["path"])).resolve() if executable.get("path") else None
    inside_package = False
    if resolved is not None:
        try:
            resolved.relative_to(package_root)
            inside_package = True
        except ValueError:
            pass
    try:
        package = load_json(package_root / "package.json")
    except (OSError, ValueError):
        package = None
    package_name = package.get("name") if isinstance(package, dict) else None
    package_version = package.get("version") if isinstance(package, dict) else None
    ready = bool(
        expected
        and executable.get("executable") is True
        and executable.get("version") == expected
        and inside_package
        and package_name == RECORDER_RECOVERY["package"]
        and package_version == expected
    )
    return {
        "ready": ready,
        "prefix": str(prefix),
        "binary": str(binary),
        "resolved": str(resolved) if resolved else None,
        "insidePackageRoot": inside_package,
        "packageName": package_name,
        "packageVersion": package_version,
        "executableVersion": executable.get("version"),
    }


def write_json_atomic(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_name(f"{path.name}.tmp-{os.getpid()}")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.chmod(0o600)
    temporary.replace(path)


def npm_environment() -> tuple[str, dict[str, str]]:
    node_bin = Path(str(RECORDER_RECOVERY["nodeBinDir"])).expanduser().resolve()
    npm = node_bin / "npm"
    if not npm.is_file() or not os.access(npm, os.X_OK):
        raise RuntimeError(f"configured npm is not executable: {npm}")
    env = dict(os.environ)
    env["PATH"] = os.pathsep.join([str(node_bin), env.get("PATH", "")])
    env["npm_config_registry"] = str(RECORDER_RECOVERY["registry"])
    return str(npm), env


def semantic_version(value: str | None) -> tuple[int, int, int] | None:
    match = re.fullmatch(r"(\d+)\.(\d+)\.(\d+)", value or "")
    return tuple(map(int, match.groups())) if match else None


def npm_view_version(spec: str) -> tuple[str, str | None]:
    npm, env = npm_environment()
    code, output = command(
        [npm, "view", spec, "version", f"--registry={RECORDER_RECOVERY['registry']}", "--json"],
        timeout=90,
        env=env,
    )
    if code == 0:
        try:
            parsed = json.loads(output)
        except json.JSONDecodeError:
            parsed = output.splitlines()[-1].strip() if output else None
        value = parsed if isinstance(parsed, str) else None
        return ("published", value) if semantic_version(value) else ("unavailable", None)
    lowered = output.lower()
    if "e404" in lowered or "etarget" in lowered or "no match found" in lowered:
        return "absent", None
    return "unavailable", None


def source_identity_provable(fingerprint: dict[str, Any]) -> bool:
    """A run may freeze a modified worktree, but never an unprovable one."""
    return isinstance(fingerprint.get("head"), str) and fingerprint.get("dirty") is not None


def source_release_safe(scry_repo: Path) -> tuple[bool, dict[str, Any]]:
    fingerprint = git_fingerprint(
        scry_repo,
        tuple(str(value) for value in RECOVERY.get("scryIgnoredUntrackedPrefixes", [])),
    )
    return fingerprint.get("dirty") is False, {
        "head": fingerprint.get("head"),
        "dirty": fingerprint.get("dirty"),
        "worktreeHash": fingerprint.get("worktreeHash"),
        "relevantUntrackedFiles": fingerprint.get("relevantUntrackedFiles"),
        "ignoredUntrackedFiles": fingerprint.get("ignoredUntrackedFiles"),
    }


def scry_dependencies(scry_repo: Path) -> dict[str, Any]:
    """Report whether the tracked lockfile is materialized into node_modules."""
    modules = scry_repo / str(DEPENDENCY_RECOVERY["modulesDir"])
    lockfile = scry_repo / str(DEPENDENCY_RECOVERY["lockfile"])
    executables = [str(value) for value in DEPENDENCY_RECOVERY["requiredExecutables"]]
    required = executables + [str(value) for value in DEPENDENCY_RECOVERY["requiredPaths"]]
    missing = [relative for relative in required if not (scry_repo / relative).exists()]
    not_executable = [
        relative for relative in executables
        if (scry_repo / relative).exists() and not os.access(scry_repo / relative, os.X_OK)
    ]
    lockfile_present = lockfile.is_file() and not lockfile.is_symlink()
    return {
        "modulesDir": str(modules),
        "lockfile": str(lockfile),
        "lockfilePresent": lockfile_present,
        "modulesPresent": modules.is_dir(),
        "modulesSymlink": modules.is_symlink(),
        "missing": missing,
        "notExecutable": not_executable,
        "ready": bool(
            lockfile_present
            and modules.is_dir()
            and not modules.is_symlink()
            and not missing
            and not not_executable
        ),
    }


def install_dependency_binaries(scry_repo: Path, env: dict[str, str]) -> list[dict[str, Any]]:
    """Run each package's own installer, because the registry strips lifecycle scripts."""
    node = Path(str(RECORDER_RECOVERY["nodeBinDir"])).expanduser().resolve() / "node"
    actions: list[dict[str, Any]] = []
    for installer in DEPENDENCY_RECOVERY.get("binaryInstallers", []):
        required = scry_repo / str(installer["requiredPath"])
        script = scry_repo / str(installer["script"])
        if required.exists():
            actions.append({"script": str(script), "action": "already-materialized"})
            continue
        if not script.is_file() or script.is_symlink():
            raise RuntimeError(f"dependency binary installer is missing or unsafe: {script}")
        code, output = command(
            [str(node), str(script)],
            scry_repo,
            timeout=int(DEPENDENCY_RECOVERY["timeoutSeconds"]),
            env=env,
        )
        if code != 0 or not required.exists():
            raise RuntimeError(f"dependency binary installer failed for {script}: {output[-2000:]}")
        actions.append({"script": str(script), "action": "installed"})
    return actions


def ensure_scry_dependencies(scry_repo: Path, log_path: Path | None = None) -> dict[str, Any]:
    """Materialize the tracked lockfile into node_modules without touching tracked files."""
    before = scry_dependencies(scry_repo)
    if before["ready"]:
        return {"ready": True, "installed": False, "before": before, "after": before, "log": None}
    if DEPENDENCY_RECOVERY.get("installIfMissing") is not True:
        raise RuntimeError(f"Scry dependencies are incomplete and installing is disabled: {before}")
    if before["modulesSymlink"]:
        raise RuntimeError(f"refusing to install over a symlinked node_modules: {before['modulesDir']}")
    if not before["lockfilePresent"]:
        raise RuntimeError(f"Scry has no tracked lockfile to install deterministically: {before['lockfile']}")
    ignored = tuple(str(value) for value in RECOVERY.get("scryIgnoredUntrackedPrefixes", []))
    identity_keys = ("head", "dirty", "worktreeHash")
    before_identity = git_fingerprint(scry_repo, ignored)
    npm, env = npm_environment()
    arguments = [str(value) for value in DEPENDENCY_RECOVERY["installArgs"]]
    code, output = command(
        [npm, *arguments],
        scry_repo,
        timeout=int(DEPENDENCY_RECOVERY["timeoutSeconds"]),
        env=env,
    )
    if log_path is not None:
        log_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        log_path.write_text(output + "\n", encoding="utf-8")
        log_path.chmod(0o600)
    after_identity = git_fingerprint(scry_repo, ignored)
    if {key: before_identity.get(key) for key in identity_keys} != {key: after_identity.get(key) for key in identity_keys}:
        raise RuntimeError(
            "installing Scry dependencies changed tracked source identity: "
            f"before={before_identity}, after={after_identity}"
        )
    if code != 0:
        detail = f"inspect {log_path}" if log_path is not None else output[-2000:]
        raise RuntimeError(f"deterministic Scry dependency install failed: {detail}")
    binaries = install_dependency_binaries(scry_repo, env)
    after = scry_dependencies(scry_repo)
    if not after["ready"]:
        raise RuntimeError(f"Scry dependencies are still incomplete after installing: {after}")
    return {
        "ready": True,
        "installed": True,
        "command": [Path(npm).name, *arguments],
        "binaryInstallers": binaries,
        "before": before,
        "after": after,
        "sourceIdentity": {key: after_identity.get(key) for key in identity_keys},
        "log": str(log_path) if log_path is not None else None,
    }


class RegistryPublicationRequired(RuntimeError):
    """The requested version needs a separately authorized release."""


def ensure_registry_version(scry_repo: Path, expected: str) -> dict[str, Any]:
    """Verify the exact registry version without publishing or moving tags."""
    package = str(RECORDER_RECOVERY["package"])
    exact_status, exact = npm_view_version(f"{package}@{expected}")
    latest_status, latest = npm_view_version(f"{package}@latest")
    before = {"exactStatus": exact_status, "exact": exact, "latestStatus": latest_status, "latest": latest}
    if semantic_version(expected) is None:
        raise RuntimeError(f"invalid recorder source version: {expected!r}")
    if exact_status == "absent":
        raise RegistryPublicationRequired(
            f"recorder {package}@{expected} is absent from {RECORDER_RECOVERY['registry']}. "
            f"No release or dist-tag write was attempted. In {scry_repo}, prepare the exact "
            "release input and check:cli-release result; execute publish:cli only within "
            "the user's explicit release authorization, then resume this preflight."
        )
    if exact_status != "published" or exact != expected:
        raise RuntimeError(f"cannot prove registry package {package}@{expected}: {before}")
    if latest_status != "published" or semantic_version(latest) is None:
        raise RuntimeError("recorder registry latest is unknown; refusing installation")
    if semantic_version(latest) > semantic_version(expected):
        raise RuntimeError(f"registry latest {latest} is newer than frozen Scry source {expected}")
    # A lagging tag does not prevent installing an already published exact version.
    return {
        "action": "already-current" if latest == expected else "exact-available",
        "before": before,
        "releaseGate": None,
        "exact": exact,
        "latest": latest,
    }


def ensure_installed_recorder(expected: str) -> dict[str, Any]:
    prefix = Path(str(RECORDER_RECOVERY["installPrefix"])).expanduser().resolve()
    binary = prefix / "bin" / "scry"
    current = executable_version(str(binary))
    provenance = installed_recorder_provenance(expected)
    installed = False
    if current.get("version") != expected or provenance.get("ready") is not True:
        npm, env = npm_environment()
        package = str(RECORDER_RECOVERY["package"])
        code, _ = command(
            [
                npm,
                "install",
                "-g",
                "--prefix",
                str(prefix),
                f"{package}@{expected}",
                f"--registry={RECORDER_RECOVERY['registry']}",
            ],
            timeout=600,
            env=env,
        )
        if code != 0:
            raise RuntimeError(f"cannot install exact recorder {package}@{expected} into {prefix}")
        installed = True
        current = executable_version(str(binary))
        provenance = installed_recorder_provenance(expected)
    if current.get("version") != expected or current.get("executable") is not True or provenance.get("ready") is not True:
        raise RuntimeError(f"installed recorder does not match {expected} with stable prefix provenance: {provenance}")
    return {
        "installed": installed,
        "path": current["path"],
        "version": current["version"],
        "provenance": provenance,
    }


def valid_settings_seed(path: Path) -> dict[str, Any] | None:
    try:
        value = load_json(path)
    except (OSError, ValueError):
        return None
    env = value.get("env") if isinstance(value, dict) else None
    required = [key for key in CONFIG_RECOVERY["requiredEnvKeys"] if key != "SCRY_CLI_PATH"]
    if not isinstance(env, dict) or any(not isinstance(env.get(key), str) or not env.get(key) for key in required):
        return None
    return value


def sync_local_settings(rate_native_repo: Path, cli_path: str, quarantine_root: Path) -> dict[str, Any]:
    candidates = [rate_native_repo / str(relative) for relative in CONFIG_RECOVERY["sourceCandidates"]]
    seed_path = next((path for path in candidates if valid_settings_seed(path) is not None), None)
    if seed_path is None:
        raise RuntimeError("no authoritative local settings contains every required secret env key")
    seed = valid_settings_seed(seed_path)
    assert isinstance(seed, dict)
    seed_env = seed.get("env")
    assert isinstance(seed_env, dict)
    copied_env = {key: seed_env[key] for key in CONFIG_RECOVERY["copiedEnvKeys"] if key in seed_env}
    managed: list[dict[str, Any]] = []
    for raw in CONFIG_RECOVERY["managedTargets"]:
        relative = Path(str(raw))
        if relative.is_absolute() or any(part in {"", ".", ".."} for part in relative.parts):
            raise RuntimeError(f"unsafe managed settings path: {raw}")
        target = rate_native_repo / relative
        if target.is_symlink():
            raise RuntimeError(f"refusing to replace symlinked settings: {target}")
        existing: dict[str, Any] = {}
        invalid = False
        if target.exists():
            try:
                loaded = load_json(target)
                existing = loaded if isinstance(loaded, dict) else {}
                invalid = not isinstance(loaded, dict)
            except (OSError, ValueError):
                invalid = True
        quarantined = None
        if invalid:
            quarantined_path = quarantine_root / relative
            quarantined_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            if quarantined_path.exists() or quarantined_path.is_symlink():
                raise RuntimeError(f"settings quarantine destination already exists: {quarantined_path}")
            target.replace(quarantined_path)
            quarantined = str(quarantined_path)
            existing = {}
        target_env = existing.get("env") if isinstance(existing.get("env"), dict) else {}
        target_env.update(copied_env)
        target_env["SCRY_CLI_PATH"] = cli_path
        existing["env"] = target_env
        write_json_atomic(target, existing)
        target.chmod(0o600)
        managed.append({
            "path": str(target),
            "quarantined": quarantined,
            "envKeys": sorted(target_env),
            "mode": "0600",
        })
    return {"source": str(seed_path), "targets": managed}


def mcp_declarations(path: Path) -> dict[str, bool]:
    """MCP server name -> enabled, for one config file Scry reads for a provider."""
    if not path.is_file():
        return {}
    try:
        text = path.read_text(encoding="utf-8")
        if path.suffix == ".toml":
            entries = tomllib.loads(text).get("mcp_servers")
        else:
            data = json.loads(text)
            entries = data.get("mcpServers") if isinstance(data, dict) else None
            if entries is None and isinstance(data, dict):
                entries = data.get("mcp")
    except (OSError, ValueError, tomllib.TOMLDecodeError):
        return {}
    if not isinstance(entries, dict):
        return {}
    declared: dict[str, bool] = {}
    for name, value in entries.items():
        config = value if isinstance(value, dict) else {}
        declared[str(name)] = config.get("enabled") is not False and config.get("disabled") is not True
    return declared


def provider_mcp_targets(provider_contract: dict[str, Any], workspace: Path, home: Path) -> dict[str, dict[str, bool]]:
    templates = provider_contract.get("mcpConfigPaths")
    if not isinstance(templates, list):
        return {}
    targets: dict[str, dict[str, bool]] = {}
    for template in templates:
        expanded = str(template).replace("$WORKSPACE", str(workspace)).replace("$HOME", str(home))
        targets[expanded] = mcp_declarations(Path(expanded))
    return targets


def duplicate_enabled_mcp(targets: dict[str, dict[str, bool]]) -> dict[str, list[str]]:
    """Server names enabled in more than one config file for this provider.

    Scry's execution-trust guard refuses `agent:start` outright in this state,
    so it must fail Step 0 instead of surfacing as a dead composer after the
    test App, permission evidence and provider spawn are already paid for."""
    owners: dict[str, list[str]] = {}
    for path, servers in targets.items():
        for name, enabled in servers.items():
            if enabled:
                owners.setdefault(name, []).append(path)
    return {name: sorted(paths) for name, paths in sorted(owners.items()) if len(paths) > 1}


def add_check(checks: list[dict[str, Any]], name: str, ok: bool, expected: Any, actual: Any) -> None:
    checks.append({"name": name, "ok": ok, "expected": expected, "actual": actual})


def qoder_contract(contract: dict[str, Any]) -> dict[str, Any]:
    providers = contract.get("providers")
    if not isinstance(providers, dict):
        return {}
    qoder = providers.get("qoder")
    return qoder if isinstance(qoder, dict) else {}


def pi_contract(contract: dict[str, Any]) -> dict[str, Any]:
    providers = contract.get("providers")
    if not isinstance(providers, dict):
        return {}
    pi = providers.get("pi")
    return pi if isinstance(pi, dict) else {}


def clone_handoff_contract(contract: dict[str, Any]) -> dict[str, Any]:
    handoff = contract.get("cloneHandoff")
    return handoff if isinstance(handoff, dict) else {}


def source_workitem_contract(contract: dict[str, Any]) -> dict[str, Any]:
    source = contract.get("sourceWorkitem")
    return source if isinstance(source, dict) else {}


def retention_contract(contract: dict[str, Any]) -> dict[str, Any]:
    retention = contract.get("retention")
    return retention if isinstance(retention, dict) else {}


def recovery_contract(contract: dict[str, Any]) -> dict[str, Any]:
    recovery = contract.get("recoveryPolicy")
    return recovery if isinstance(recovery, dict) else {}


def inspect(
    provider: str,
    scry_repo: Path,
    rate_native_repo: Path,
    build_out: Path | None = None,
) -> dict[str, Any]:
    contract = load_json(CONTRACT_PATH)
    contract_sha256 = "sha256:" + hashlib.sha256(CONTRACT_PATH.read_bytes()).hexdigest()
    providers = contract.get("providers", {})
    checks: list[dict[str, Any]] = []
    add_check(
        checks,
        "contract.schemaVersion",
        contract.get("schemaVersion") == EXPECTED_CONTRACT_SCHEMA_VERSION,
        EXPECTED_CONTRACT_SCHEMA_VERSION,
        contract.get("schemaVersion"),
    )
    actual_source_workitem_contract = source_workitem_contract(contract)
    add_check(
        checks,
        "contract.sourceWorkitem",
        actual_source_workitem_contract == EXPECTED_SOURCE_WORKITEM_CONTRACT,
        EXPECTED_SOURCE_WORKITEM_CONTRACT,
        actual_source_workitem_contract,
    )
    actual_retention_contract = retention_contract(contract)
    add_check(
        checks,
        "contract.retention",
        actual_retention_contract == EXPECTED_RETENTION_CONTRACT,
        EXPECTED_RETENTION_CONTRACT,
        actual_retention_contract,
    )
    actual_recovery_contract = recovery_contract(contract)
    add_check(
        checks,
        "contract.recoveryPolicy",
        actual_recovery_contract == EXPECTED_RECOVERY_CONTRACT,
        EXPECTED_RECOVERY_CONTRACT,
        actual_recovery_contract,
    )
    actual_qoder_contract = qoder_contract(contract)
    for field, expected_value in EXPECTED_QODER_CONTRACT.items():
        actual_value = actual_qoder_contract.get(field)
        add_check(
            checks,
            f"contract.providers.qoder.{field}",
            actual_value == expected_value,
            expected_value,
            actual_value,
        )
    actual_pi_contract = pi_contract(contract)
    add_check(
        checks,
        "contract.providers.pi",
        actual_pi_contract == EXPECTED_PI_CONTRACT,
        EXPECTED_PI_CONTRACT,
        actual_pi_contract,
    )
    actual_clone_handoff_contract = clone_handoff_contract(contract)
    add_check(
        checks,
        "contract.cloneHandoff.exact",
        actual_clone_handoff_contract == EXPECTED_CLONE_HANDOFF_CONTRACT,
        EXPECTED_CLONE_HANDOFF_CONTRACT,
        actual_clone_handoff_contract,
    )
    for field, expected_value in EXPECTED_CLONE_HANDOFF_CONTRACT.items():
        actual_value = actual_clone_handoff_contract.get(field)
        add_check(
            checks,
            f"contract.cloneHandoff.{field}",
            actual_value == expected_value,
            expected_value,
            actual_value,
        )
    add_check(checks, "provider.supported", provider in providers, sorted(providers), provider)
    add_check(checks, "scry.repo", scry_repo.is_dir(), True, str(scry_repo))
    add_check(checks, "rate_native.repo", rate_native_repo.is_dir(), True, str(rate_native_repo))
    pi_settings_path = rate_native_repo / ".pi" / "settings.json"
    try:
        pi_settings = load_json(pi_settings_path)
    except (OSError, ValueError):
        pi_settings = None
    add_check(
        checks,
        "config.rate_native_pi_settings",
        pi_settings == EXPECTED_PI_SETTINGS,
        EXPECTED_PI_SETTINGS,
        {"path": str(pi_settings_path), "value": pi_settings},
    )

    source = scry_versions(scry_repo) if scry_repo.is_dir() else {"package": None, "recorderConstant": None}
    rate = rate_native_recorder(rate_native_repo) if rate_native_repo.is_dir() else dict(EMPTY_RATE_NATIVE_RECORDER)
    installed = installed_version()
    expected = source.get("package")
    installed_provenance = installed_recorder_provenance(expected)
    add_check(checks, "version.scry_source", bool(expected) and source.get("recorderConstant") == expected, expected, source)
    add_check(checks, "version.installed_cli", bool(expected) and installed.get("version") == expected, expected, installed)
    add_check(
        checks,
        "version.installed_cli_provenance",
        installed_provenance["ready"] is True,
        "the exact package installed under the configured stable prefix",
        installed_provenance,
    )
    executable_candidates = [item for item in installed.get("candidates", []) if item["executable"]]
    installed["pathAudit"] = {
        "uniqueResolved": len({item["resolved"] for item in executable_candidates if item["resolved"]}) <= 1,
        "authoritativeResolved": installed_provenance.get("resolved"),
        "note": "additional PATH candidates are audit-only; every workflow command uses the frozen absolute CLI path",
    }
    settings_paths = rate.get("cliPathBySettings", {})
    settings_health = local_settings_health(rate_native_repo) if rate_native_repo.is_dir() else {"ready": False, "targets": []}
    add_check(
        checks,
        "config.rate_native_settings",
        settings_health["ready"] is True,
        "all managed settings are valid, contain required env keys, and use mode 0600",
        settings_health,
    )
    add_check(
        checks,
        "version.rate_native_cli_path",
        set(settings_paths) == set(LOCAL_SETTINGS_RELATIVE)
        and all(bool(value) for value in settings_paths.values())
        and bool(rate.get("cliPath"))
        and rate.get("cli", {}).get("executable") is True
        and rate.get("cli", {}).get("path") == installed.get("path"),
        "one absolute executable SCRY_CLI_PATH shared by all four managed settings.local.json files",
        {
            "cliPath": rate.get("cliPath"),
            "cliPathConflicts": rate.get("cliPathConflicts"),
            "cliPathBySettings": settings_paths,
            "cli": rate.get("cli"),
        },
    )
    add_check(
        checks,
        "version.rate_native_cli",
        bool(expected) and rate.get("cli", {}).get("version") == expected,
        expected,
        rate.get("cli", {}).get("version"),
    )
    # A leftover pin would silently override the resolved binary, so it must
    # either be absent or agree with the Scry source version.
    add_check(
        checks,
        "version.rate_native_no_stale_pin",
        bool(expected)
        and rate.get("hookPinnedVersion") in (None, expected)
        and rate.get("initPinnedVersions") in ([], [expected]),
        {"hookPinnedVersion": [None, expected], "initPinnedVersions": [[], [expected]]},
        {
            "hookPinnedVersion": rate.get("hookPinnedVersion"),
            "initPinnedVersions": rate.get("initPinnedVersions"),
        },
    )

    # Scry has provider-specific discovery beyond the launching shell's PATH
    # (for example app-bundled and desktop application locations).  A PATH miss
    # is therefore evidence, not a blocker.  The isolated renderer must prove
    # actual provider availability before the first workflow message.
    provider_cli = providers.get(provider, {}).get("cli") if provider in providers else None
    provider_path = shutil.which(str(provider_cli)) if provider_cli else None
    provider_executable = provider_shell_executable(provider, provider_path)
    if provider == "pi":
        add_check(
            checks,
            "provider.pi.shell_executable",
            provider_executable.get("absolute") is True
            and provider_executable.get("executable") is True
            and bool(provider_executable.get("version")),
            "absolute executable and non-empty version resolved for frozen pi:default",
            provider_executable,
        )
    ignored_untracked = tuple(str(value) for value in RECOVERY.get("scryIgnoredUntrackedPrefixes", []))
    scry_git = git_fingerprint(scry_repo, ignored_untracked) if scry_repo.is_dir() else {}
    rate_git = git_fingerprint(rate_native_repo) if rate_native_repo.is_dir() else {}
    resolved_build_out = (build_out or (scry_repo / "out")).expanduser().resolve()
    build_artifacts = tree_fingerprint(resolved_build_out) if scry_repo.is_dir() else {"exists": False, "files": 0, "sha256": None}
    # Uncommitted Scry changes are audit-only evidence, not a gate: the run is
    # pinned to whatever worktree it froze, and drift during the run still
    # fails.  Only an unprovable source identity (no Git repo, failing git)
    # blocks, because then nothing can be frozen. Missing recorder versions
    # require a separately authorized release, outside this preflight.
    add_check(
        checks,
        "scry.source.identity_provable",
        source_identity_provable(scry_git),
        "provable Scry HEAD and worktree state; local modifications are audit-only",
        {
            "head": scry_git.get("head"),
            "treeHash": scry_git.get("treeHash"),
            "dirty": scry_git.get("dirty"),
            "worktreeHash": scry_git.get("worktreeHash"),
        },
    )
    mcp_targets = provider_mcp_targets(providers.get(provider, {}), rate_native_repo, Path.home())
    mcp_duplicates = duplicate_enabled_mcp(mcp_targets)
    add_check(
        checks,
        "mcp.provider_enabled_unique",
        not mcp_duplicates,
        "no MCP server name enabled in more than one config this provider reads",
        mcp_duplicates,
    )

    return {
        "ok": bool(checks) and all(item["ok"] for item in checks),
        "provider": provider,
        "contractSchemaVersion": contract.get("schemaVersion"),
        "contract": {
            "schemaVersion": contract.get("schemaVersion"),
            "sha256": contract_sha256,
        },
        # Only repository-independent recorder identity belongs in the frozen
        # fingerprint: the per-settings map legitimately differs between the
        # source repo and a bootstrapped treehouse without changing which
        # recorder binary actually runs.
        "versions": {
            "scry": source,
            "installedCli": installed,
            "installedCliProvenance": installed_provenance,
            "rateNative": {
                "cliPath": rate.get("cliPath"),
                "cliVersion": rate.get("cli", {}).get("version"),
                "hookPinnedVersion": rate.get("hookPinnedVersion"),
                "initPinnedVersions": rate.get("initPinnedVersions"),
            },
        },
        "rateNativeRecorder": rate,
        "providerMcp": {
            "configPaths": {path: sorted(servers) for path, servers in mcp_targets.items()},
            "duplicateEnabled": mcp_duplicates,
        },
        "providerCli": {
            "command": provider_cli,
            "shellPath": str(Path(provider_path).resolve()) if provider_path else None,
            "version": provider_executable.get("version"),
            "agentProfileId": providers.get(provider, {}).get("agentProfileId"),
            "authoritativeCheck": "isolated_scry_renderer_before_first_message",
        },
        "git": {"scry": scry_git, "rateNative": rate_git},
        "buildOut": str(resolved_build_out),
        "buildArtifacts": build_artifacts,
        "checks": checks,
        "failures": [item for item in checks if not item["ok"]],
    }


RECOVERY_ACTION_EXCEPTIONS = (OSError, RuntimeError, ValueError, subprocess.TimeoutExpired)


def recovery_failure_names(result: dict[str, Any]) -> list[str]:
    return [str(item.get("name")) for item in result.get("failures", [])]


def recovery_error(exc: BaseException) -> dict[str, str]:
    return {"type": type(exc).__name__, "message": str(exc)}


def run_recovery_step(
    manifest: dict[str, Any],
    recovery_output: Path,
    attempt: dict[str, Any],
    name: str,
    action: Any,
) -> Any:
    """Journal one idempotent mutation before and after it runs."""
    step: dict[str, Any] = {"status": "RUNNING"}
    attempt["steps"][name] = step
    attempt["status"] = "RUNNING"
    attempt["currentStep"] = name
    write_json_atomic(recovery_output, manifest)
    try:
        result = action()
    except RECOVERY_ACTION_EXCEPTIONS as exc:
        step.update({"status": "FAILED", "error": recovery_error(exc)})
        attempt.update({"status": "STEP_FAILED", "error": recovery_error(exc)})
        write_json_atomic(recovery_output, manifest)
        raise
    step.update({"status": "COMPLETED", "result": result})
    attempt[name] = result
    write_json_atomic(recovery_output, manifest)
    return result


def reconcile_environment(
    provider: str,
    scry_repo: Path,
    rate_native_repo: Path,
    recovery_output: Path,
) -> dict[str, Any]:
    initial = inspect(provider, scry_repo, rate_native_repo)
    initial_failures = [str(item.get("name")) for item in initial.get("failures", [])]
    non_recoverable = sorted(set(initial_failures) - RECOVERABLE_CHECKS)
    manifest: dict[str, Any] = {
        "schemaVersion": 1,
        "status": "RECOVERING_ENVIRONMENT",
        "provider": provider,
        "initialFailures": initial_failures,
        "attempts": [],
        "maxAttempts": int(RECOVERY["maxAttempts"]),
    }
    # Publish the recovery intent before any registry, install, or settings
    # mutation. If the process dies, this file says exactly which step had
    # started instead of leaving an unexplained partial environment behind.
    write_json_atomic(recovery_output, manifest)
    if initial.get("ok") is True:
        manifest.update({"status": "FROZEN_READY", "recoveryRequired": False, "finalFailures": []})
        write_json_atomic(recovery_output, manifest)
        return {**initial, "recovery": manifest, "ok": True}
    if non_recoverable:
        manifest.update({"status": "RECOVERY_NOT_APPLICABLE", "unresolved": non_recoverable})
        write_json_atomic(recovery_output, manifest)
        return {**initial, "recovery": manifest}

    current = initial
    expected = current.get("versions", {}).get("scry", {}).get("package")
    if not isinstance(expected, str) or semantic_version(expected) is None:
        manifest.update({
            "status": "RECOVERY_FAILED",
            "error": f"Scry source does not declare a valid recorder version: {expected!r}",
            "finalFailures": recovery_failure_names(current),
        })
        write_json_atomic(recovery_output, manifest)
        return {**current, "recovery": manifest, "ok": False}

    quarantine_root = recovery_output.parent / "preflight-recovery" / "quarantine"
    last_error: dict[str, str] | None = None
    final_inspection_error: dict[str, str] | None = None
    for attempt_number in range(1, int(RECOVERY["maxAttempts"]) + 1):
        attempt: dict[str, Any] = {
            "attempt": attempt_number,
            "status": "STARTED",
            "steps": {},
        }
        manifest["attempts"].append(attempt)
        write_json_atomic(recovery_output, manifest)

        action_error: BaseException | None = None
        try:
            run_recovery_step(
                manifest,
                recovery_output,
                attempt,
                "registry",
                lambda: ensure_registry_version(scry_repo, expected),
            )
            installed = run_recovery_step(
                manifest,
                recovery_output,
                attempt,
                "installed",
                lambda: ensure_installed_recorder(expected),
            )
            run_recovery_step(
                manifest,
                recovery_output,
                attempt,
                "settings",
                lambda: sync_local_settings(
                    rate_native_repo,
                    str(installed["path"]),
                    quarantine_root,
                ),
            )
        except RECOVERY_ACTION_EXCEPTIONS as exc:
            action_error = exc
            last_error = recovery_error(exc)

        if isinstance(action_error, RegistryPublicationRequired):
            attempt["status"] = "REQUIRES_AUTHORIZED_RELEASE"
            attempt.pop("currentStep", None)
            write_json_atomic(recovery_output, manifest)
            break

        # Inspect after recoverable attempts, including exceptions. This turns an
        # install race that actually converged into success, and gives
        # the next retry a fresh view of partially completed idempotent steps.
        try:
            current = inspect(provider, scry_repo, rate_native_repo)
            remaining = recovery_failure_names(current)
            attempt["inspection"] = {"ok": current.get("ok") is True, "failures": remaining}
            attempt["remainingFailures"] = remaining
            final_inspection_error = None
        except RECOVERY_ACTION_EXCEPTIONS as exc:
            inspection_error = recovery_error(exc)
            attempt["inspection"] = {"ok": False, "error": inspection_error}
            attempt["status"] = "INSPECTION_FAILED"
            final_inspection_error = inspection_error
            last_error = inspection_error
            write_json_atomic(recovery_output, manifest)
            continue

        if current.get("ok") is True:
            attempt["status"] = "CONVERGED_AFTER_ERROR" if action_error is not None else "CONVERGED"
            attempt.pop("currentStep", None)
            manifest.update({"status": "FROZEN_READY", "finalFailures": []})
            write_json_atomic(recovery_output, manifest)
            break

        unresolved_fatal = sorted(set(remaining) - RECOVERABLE_CHECKS)
        if unresolved_fatal:
            attempt.update({"status": "UNRECOVERABLE", "unresolved": unresolved_fatal})
            attempt.pop("currentStep", None)
            write_json_atomic(recovery_output, manifest)
            break

        attempt["status"] = "RETRY_PENDING" if attempt_number < int(RECOVERY["maxAttempts"]) else "EXHAUSTED"
        attempt.pop("currentStep", None)
        write_json_atomic(recovery_output, manifest)

    if manifest["status"] != "FROZEN_READY":
        manifest.update({
            "status": "RECOVERY_FAILED",
            "finalFailures": recovery_failure_names(current),
        })
        if last_error is not None:
            # Keep the original top-level string contract while the journal
            # carries the structured exception type for diagnosis.
            manifest["error"] = last_error["message"]
            manifest["errorDetail"] = last_error
        if final_inspection_error is not None:
            manifest["finalInspectionError"] = final_inspection_error
        write_json_atomic(recovery_output, manifest)
    return {**current, "recovery": manifest, "ok": current.get("ok") is True and manifest["status"] == "FROZEN_READY"}


def self_test_recovery_journal(root: Path) -> None:
    failed_inspection = {
        "ok": False,
        "failures": [{"name": "version.installed_cli"}],
        "versions": {"scry": {"package": "1.2.3"}},
    }
    successful_inspection = {
        "ok": True,
        "failures": [],
        "versions": {"scry": {"package": "1.2.3"}},
    }
    original_inspect = inspect
    original_registry = ensure_registry_version
    original_installed = ensure_installed_recorder
    original_settings = sync_local_settings
    original_write = write_json_atomic

    def run_case(
        name: str,
        inspections: list[dict[str, Any]],
        *,
        registry_failures: int = 0,
        installed_failures: int = 0,
    ) -> tuple[dict[str, Any], list[dict[str, Any]], dict[str, int]]:
        global inspect, ensure_registry_version, ensure_installed_recorder, sync_local_settings, write_json_atomic
        inspection_values = iter(inspections)
        snapshots: list[dict[str, Any]] = []
        calls = {"registry": 0, "installed": 0, "settings": 0}

        def fake_inspect(provider: str, scry_repo: Path, rate_native_repo: Path) -> dict[str, Any]:
            return next(inspection_values)

        def fake_registry(scry_repo: Path, expected: str) -> dict[str, Any]:
            calls["registry"] += 1
            if calls["registry"] <= registry_failures:
                raise RuntimeError("transient registry failure")
            return {"action": "already-current", "exact": expected, "latest": expected}

        def fake_installed(expected: str) -> dict[str, Any]:
            calls["installed"] += 1
            if calls["installed"] <= installed_failures:
                raise RuntimeError("transient install failure")
            return {"installed": False, "path": "/fixture/stable/scry", "version": expected}

        def fake_settings(rate_native_repo: Path, cli_path: str, quarantine_root: Path) -> dict[str, Any]:
            calls["settings"] += 1
            return {"source": "/fixture/settings", "targets": [], "cliPath": cli_path}

        def capture_write(path: Path, value: dict[str, Any]) -> None:
            snapshots.append(json.loads(json.dumps(value)))
            original_write(path, value)

        inspect = fake_inspect
        ensure_registry_version = fake_registry
        ensure_installed_recorder = fake_installed
        sync_local_settings = fake_settings
        write_json_atomic = capture_write
        try:
            result = reconcile_environment(
                "claude",
                root / "fixture-scry",
                root / "fixture-rate-native",
                root / f"{name}.json",
            )
        finally:
            inspect = original_inspect
            ensure_registry_version = original_registry
            ensure_installed_recorder = original_installed
            sync_local_settings = original_settings
            write_json_atomic = original_write
        return result, snapshots, calls

    recovered, recovered_snapshots, recovered_calls = run_case(
        "recovery-retry-success",
        [failed_inspection, failed_inspection, successful_inspection],
        installed_failures=1,
    )
    recovered_manifest = recovered["recovery"]
    assert recovered["ok"] is True and recovered_manifest["status"] == "FROZEN_READY"
    assert len(recovered_manifest["attempts"]) == 2
    assert recovered_manifest["attempts"][0]["steps"]["installed"]["status"] == "FAILED"
    assert recovered_manifest["attempts"][0]["inspection"]["failures"] == ["version.installed_cli"]
    assert recovered_manifest["attempts"][1]["status"] == "CONVERGED"
    assert recovered_calls == {"registry": 2, "installed": 2, "settings": 1}
    assert any(
        snapshot["attempts"]
        and snapshot["attempts"][0].get("steps", {}).get("installed", {}).get("status") == "RUNNING"
        for snapshot in recovered_snapshots
    )
    assert all(snapshot["status"] != "RECOVERY_FAILED" for snapshot in recovered_snapshots)

    exhausted, exhausted_snapshots, exhausted_calls = run_case(
        "recovery-retry-exhausted",
        [failed_inspection, failed_inspection, failed_inspection],
        registry_failures=int(RECOVERY["maxAttempts"]),
    )
    exhausted_manifest = exhausted["recovery"]
    assert exhausted["ok"] is False and exhausted_manifest["status"] == "RECOVERY_FAILED"
    assert len(exhausted_manifest["attempts"]) == int(RECOVERY["maxAttempts"])
    assert exhausted_manifest["attempts"][-1]["status"] == "EXHAUSTED"
    assert exhausted_calls == {
        "registry": int(RECOVERY["maxAttempts"]),
        "installed": 0,
        "settings": 0,
    }
    assert exhausted_snapshots[-1]["status"] == "RECOVERY_FAILED"
    assert all(snapshot["status"] == "RECOVERING_ENVIRONMENT" for snapshot in exhausted_snapshots[:-1])


def self_test_dependency_install(root: Path) -> None:
    """A missing node_modules must recover deterministically, never dirty tracked input."""
    fake_npm = root / "fake-npm" / "npm"
    fake_npm.parent.mkdir(parents=True)
    materialize = "\n".join(
        [
            "#!/bin/sh",
            "set -e",
            "mkdir -p node_modules/.bin node_modules/electron/dist",
            "printf '{}\\n' > node_modules/.package-lock.json",
            # The internal registry strips lifecycle scripts, so the package's own
            # installer still has to materialize the platform binary.
            "printf \"require('fs').mkdirSync('node_modules/electron/dist/Electron.app',"
            "{recursive:true})\\n\" > node_modules/electron/install.js",
            "for name in electron-vite electron; do",
            "  printf '#!/bin/sh\\n' > node_modules/.bin/$name",
            "  chmod 755 node_modules/.bin/$name",
            "done",
            "",
        ]
    )
    fake_npm.write_text(materialize, encoding="utf-8")
    fake_npm.chmod(0o755)

    def fixture_repo(name: str, ignore_modules: bool) -> Path:
        repo = root / name
        repo.mkdir()
        assert command(["git", "init"], repo)[0] == 0
        assert command(["git", "config", "user.name", "fixture"], repo)[0] == 0
        assert command(["git", "config", "user.email", "fixture@example.invalid"], repo)[0] == 0
        (repo / "package-lock.json").write_text('{"lockfileVersion":3}\n', encoding="utf-8")
        if ignore_modules:
            (repo / ".gitignore").write_text("node_modules/\n", encoding="utf-8")
        assert command(["git", "add", "-A"], repo)[0] == 0
        assert command(["git", "commit", "-m", "fixture"], repo)[0] == 0
        return repo

    original_npm_environment = globals()["npm_environment"]
    try:
        globals()["npm_environment"] = lambda: (str(fake_npm), dict(os.environ))
        ignored = fixture_repo("deps-ignored", True)
        probe = scry_dependencies(ignored)
        assert probe["ready"] is False and probe["lockfilePresent"] is True and probe["missing"]
        installed = ensure_scry_dependencies(ignored, root / "deps-log" / "scry-dependencies.log")
        assert installed["ready"] is True and installed["installed"] is True
        assert [item["action"] for item in installed["binaryInstallers"]] == ["installed"]
        assert scry_dependencies(ignored)["ready"] is True
        assert (root / "deps-log" / "scry-dependencies.log").stat().st_mode & 0o777 == 0o600
        # An already materialized tree is idempotent and never shells out.
        assert ensure_scry_dependencies(ignored)["installed"] is False
        # node_modules that the repository would track is drift, not recovery.
        tracking = fixture_repo("deps-tracking", False)
        try:
            ensure_scry_dependencies(tracking)
            raise AssertionError("an install that dirties tracked input was accepted")
        except RuntimeError as exc:
            assert "tracked source identity" in str(exc)
        # A symlinked node_modules is never installed over.
        linked = fixture_repo("deps-linked", True)
        (linked / "node_modules").symlink_to(ignored / "node_modules", target_is_directory=True)
        assert scry_dependencies(linked)["modulesSymlink"] is True
        assert scry_dependencies(linked)["ready"] is False
        try:
            ensure_scry_dependencies(linked)
            raise AssertionError("a symlinked node_modules was accepted")
        except RuntimeError as exc:
            assert "symlinked node_modules" in str(exc)
    finally:
        globals()["npm_environment"] = original_npm_environment


def self_test() -> int:
    contract = load_json(CONTRACT_PATH)
    assert contract.get("schemaVersion") == EXPECTED_CONTRACT_SCHEMA_VERSION
    assert source_workitem_contract(contract) == EXPECTED_SOURCE_WORKITEM_CONTRACT
    assert retention_contract(contract) == EXPECTED_RETENTION_CONTRACT
    assert recovery_contract(contract) == EXPECTED_RECOVERY_CONTRACT
    assert all(
        qoder_contract(load_json(CONTRACT_PATH)).get(field) == expected
        for field, expected in EXPECTED_QODER_CONTRACT.items()
    )
    assert pi_contract(contract) == EXPECTED_PI_CONTRACT
    assert EXPECTED_PI_SETTINGS == {"skills": ["../.claude/skills"]}
    assert qoder_contract({"providers": {"qoder": dict(EXPECTED_QODER_CONTRACT)}}) == EXPECTED_QODER_CONTRACT
    assert qoder_contract({"providers": {"qoder": {"displayName": "Qoder CLI"}}}).get("displayName") != EXPECTED_QODER_CONTRACT["displayName"]
    assert qoder_contract({"providers": {"qoder": {"skill": "rate-native-rate-workflow"}}}).get("skill") != EXPECTED_QODER_CONTRACT["skill"]
    assert qoder_contract({"providers": {"qoder": {}}}) == {}
    assert clone_handoff_contract(contract) == EXPECTED_CLONE_HANDOFF_CONTRACT
    assert source_workitem_contract({"sourceWorkitem": dict(EXPECTED_SOURCE_WORKITEM_CONTRACT)}) == EXPECTED_SOURCE_WORKITEM_CONTRACT
    assert source_workitem_contract({"sourceWorkitem": {"id": "different"}}) != EXPECTED_SOURCE_WORKITEM_CONTRACT
    assert source_workitem_contract({}) == {}
    assert clone_handoff_contract({"cloneHandoff": dict(EXPECTED_CLONE_HANDOFF_CONTRACT)}) == EXPECTED_CLONE_HANDOFF_CONTRACT
    assert clone_handoff_contract({"cloneHandoff": {"agentMayClone": True}}) != EXPECTED_CLONE_HANDOFF_CONTRACT
    clone_handoff_with_extra = dict(EXPECTED_CLONE_HANDOFF_CONTRACT)
    clone_handoff_with_extra["fallback"] = "agent_clone"
    assert clone_handoff_contract({"cloneHandoff": clone_handoff_with_extra}) != EXPECTED_CLONE_HANDOFF_CONTRACT
    assert clone_handoff_contract({}) == {}
    with tempfile.TemporaryDirectory() as raw:
        root = Path(raw)
        scry = root / "scry"
        rate = root / "rate-native"
        (scry / "packages/turn-recorder-cli").mkdir(parents=True)
        (scry / "src/core/turn-recorder").mkdir(parents=True)
        (rate / ".claude/hooks").mkdir(parents=True)
        (scry / "packages/turn-recorder-cli/package.json").write_text('{"version":"1.2.3"}\n', encoding="utf-8")
        (scry / "src/core/turn-recorder/store.ts").write_text("export const RECORDER_VERSION = '1.2.3'\n", encoding="utf-8")
        (rate / ".claude/hooks/scry-recorder.sh").write_text('REQUIRED_VERSION="${SCRY_RECORDER_REQUIRED_VERSION:-}"\n', encoding="utf-8")
        (rate / "init.sh").write_text('SCRY_PACKAGE="@ali/scry-turn-recorder@latest"\n', encoding="utf-8")
        assert scry_versions(scry) == {"package": "1.2.3", "recorderConstant": "1.2.3"}
        binary = root / "bin" / "scry"
        binary.parent.mkdir(parents=True)
        binary.write_text("#!/bin/sh\necho 1.2.3\n", encoding="utf-8")
        binary.chmod(0o755)
        stable_prefix = root / "stable-prefix"
        stable_package = stable_prefix / "lib/node_modules/@ali/scry-turn-recorder"
        stable_cli = stable_package / "dist/cli/scry.js"
        stable_cli.parent.mkdir(parents=True)
        (stable_package / "package.json").write_text(
            '{"name":"@ali/scry-turn-recorder","version":"1.2.3"}\n', encoding="utf-8"
        )
        stable_cli.write_text("#!/bin/sh\necho 1.2.3\n", encoding="utf-8")
        stable_cli.chmod(0o755)
        (stable_prefix / "bin").mkdir(parents=True)
        (stable_prefix / "bin/scry").symlink_to(stable_cli)
        assert installed_recorder_provenance("1.2.3", stable_prefix)["ready"] is True
        (stable_prefix / "bin/scry").unlink()
        (stable_prefix / "bin/scry").symlink_to(binary)
        assert installed_recorder_provenance("1.2.3", stable_prefix)["ready"] is False
        (rate / ".claude/settings.local.json").write_text(
            json.dumps({"env": {
                "SCRY_CLI_PATH": str(binary),
                "DINGTALK_DOC_MCP_URL": "https://mcp.example.invalid/server/fixture",
                "NEXTCR_API_KEY": "fixture-key",
            }}) + "\n",
            encoding="utf-8",
        )
        unpinned = rate_native_recorder(rate)
        assert unpinned["hookPinnedVersion"] is None
        assert unpinned["initPinnedVersions"] == []
        assert unpinned["cliPath"] == str(binary)
        assert unpinned["cli"]["version"] == "1.2.3"
        assert unpinned["cliPathConflicts"] == []
        # A four-end config that disagrees on the recorder binary is not a
        # single provable identity, even when each path is executable.
        (rate / ".codex").mkdir()
        (rate / ".codex/settings.local.json").write_text(
            json.dumps({"env": {"SCRY_CLI_PATH": str(root / "bin" / "other")}}) + "\n", encoding="utf-8"
        )
        conflicted = rate_native_recorder(rate)
        assert conflicted["cliPath"] is None
        assert len(conflicted["cliPathConflicts"]) == 2
        (rate / ".codex/settings.local.json").write_text(json.dumps({"env": {}}) + "\n", encoding="utf-8")
        missing_key = rate_native_recorder(rate)
        assert missing_key["cliPathBySettings"][".codex/settings.local.json"] is None
        (rate / ".codex/settings.local.json").unlink()
        # A surviving repository pin is still compared against the source.
        (rate / "init.sh").write_text("npm install -g @ali/scry-turn-recorder@1.2.2\n", encoding="utf-8")
        assert rate_native_recorder(rate)["initPinnedVersions"] == ["1.2.2"]
        (rate / ".claude/hooks/scry-recorder.sh").write_text(
            'REQUIRED_VERSION="${SCRY_RECORDER_REQUIRED_VERSION:-1.2.2}"\n', encoding="utf-8"
        )
        assert rate_native_recorder(rate)["hookPinnedVersion"] == "1.2.2"
        assert executable_version("relative/scry") == {
            "path": "relative/scry",
            "absolute": False,
            "executable": False,
            "version": None,
        }
        assert executable_version(str(root / "bin" / "absent"))["executable"] is False
        assert executable_version(None)["path"] is None
        flaky_marker = root / "flaky-version.marker"
        flaky = root / "bin" / "flaky-version"
        flaky.write_text(
            f"#!/bin/sh\nif test ! -e '{flaky_marker}'; then touch '{flaky_marker}'; exit 1; fi\necho 1.2.3\n",
            encoding="utf-8",
        )
        flaky.chmod(0o755)
        assert executable_version(str(flaky), attempts=2)["version"] == "1.2.3"
        verified_pi = root / "bin" / "verified-pi"
        verified_pi.write_text("#!/bin/sh\necho 9.9.9\n", encoding="utf-8")
        verified_pi.chmod(0o755)
        previous_verified_pi = os.environ.get("PI_AGENT_VERIFIED_PI_EXECUTABLE")
        os.environ["PI_AGENT_VERIFIED_PI_EXECUTABLE"] = str(verified_pi)
        try:
            pi_shell = provider_shell_executable("pi", str(binary))
            assert pi_shell["path"] == str(binary.resolve())
            assert pi_shell["version"] == "9.9.9"
            assert pi_shell["versionProbePath"] == str(verified_pi.resolve())
        finally:
            if previous_verified_pi is None:
                del os.environ["PI_AGENT_VERIFIED_PI_EXECUTABLE"]
            else:
                os.environ["PI_AGENT_VERIFIED_PI_EXECUTABLE"] = previous_verified_pi
        (rate / ".qoder").mkdir()
        (rate / ".qoder/settings.local.json").write_text("{broken", encoding="utf-8")
        synced = sync_local_settings(rate, str(binary), root / "quarantine")
        assert len(synced["targets"]) == len(LOCAL_SETTINGS_RELATIVE)
        assert (root / "quarantine/.qoder/settings.local.json").is_file()
        for relative in LOCAL_SETTINGS_RELATIVE:
            value = load_json(rate / relative)
            assert value["env"]["SCRY_CLI_PATH"] == str(binary)
            assert value["env"]["DINGTALK_DOC_MCP_URL"] == "https://mcp.example.invalid/server/fixture"
            assert value["env"]["NEXTCR_API_KEY"] == "fixture-key"
            assert (rate / relative).stat().st_mode & 0o777 == 0o600
        assert local_settings_health(rate)["ready"] is True
        (rate / ".opencode/settings.local.json").chmod(0o644)
        assert local_settings_health(rate)["ready"] is False
        (rate / ".opencode/settings.local.json").chmod(0o600)
        # Duplicate enabled MCP definitions are what Scry's guard refuses.
        qoder_user = root / "home" / ".qoder"
        qoder_user.mkdir(parents=True)
        (qoder_user / "mcp.json").write_text(json.dumps({"mcpServers": {"coop": {"command": "npx"}}}) + "\n", encoding="utf-8")
        (rate / ".mcp.json").write_text(
            json.dumps({"mcpServers": {"coop": {"url": "https://example"}, "solo": {"url": "https://example"}}}) + "\n",
            encoding="utf-8",
        )
        qoder_targets = provider_mcp_targets(EXPECTED_QODER_CONTRACT, rate, root / "home")
        assert sorted(duplicate_enabled_mcp(qoder_targets)) == ["coop"]
        # An explicitly disabled definition no longer competes for precedence.
        (qoder_user / "mcp.json").write_text(
            json.dumps({"mcpServers": {"coop": {"command": "npx", "disabled": True}}}) + "\n", encoding="utf-8"
        )
        assert duplicate_enabled_mcp(provider_mcp_targets(EXPECTED_QODER_CONTRACT, rate, root / "home")) == {}
        codex_project = rate / ".codex"
        codex_project.mkdir(exist_ok=True)
        (codex_project / "config.toml").write_text('[mcp_servers.coop]\nurl = "https://example"\n', encoding="utf-8")
        assert mcp_declarations(codex_project / "config.toml") == {"coop": True}
        assert mcp_declarations(rate / "absent.json") == {}
        # PATH scanning must expose a dangling install instead of reporting nothing.
        broken = root / "bin" / "dangling"
        broken.symlink_to(root / "bin" / "absent")
        original_path = os.environ.get("PATH", "")
        os.environ["PATH"] = str(root / "bin")
        try:
            candidates = {item["path"]: item for item in path_candidates("dangling")}
            assert candidates[str(broken)]["dangling"] is True
            assert candidates[str(broken)]["executable"] is False
            assert path_candidates("absent") == []
        finally:
            os.environ["PATH"] = original_path
        ignored_repo = root / "ignored-repo"
        ignored_repo.mkdir()
        assert command(["git", "init"], ignored_repo)[0] == 0
        assert command(["git", "config", "user.name", "fixture"], ignored_repo)[0] == 0
        assert command(["git", "config", "user.email", "fixture@example.invalid"], ignored_repo)[0] == 0
        (ignored_repo / "tracked.txt").write_text("tracked\n", encoding="utf-8")
        assert command(["git", "add", "tracked.txt"], ignored_repo)[0] == 0
        assert command(["git", "commit", "-m", "fixture"], ignored_repo)[0] == 0
        (ignored_repo / "designs").mkdir()
        (ignored_repo / "designs/asset.txt").write_text("draft\n", encoding="utf-8")
        ignored = git_fingerprint(ignored_repo, ("designs/",))
        assert ignored["dirty"] is False and ignored["auditDirty"] is True
        (ignored_repo / "src").mkdir()
        (ignored_repo / "src/new.ts").write_text("export {}\n", encoding="utf-8")
        dirty = git_fingerprint(ignored_repo, ("designs/",))
        assert dirty["dirty"] is True
        # A dirty worktree stays acceptable input for a run, and stays
        # unacceptable input for publishing a recorder release.
        assert source_identity_provable(dirty) is True
        assert source_identity_provable({"head": None, "dirty": None}) is False
        assert source_release_safe(ignored_repo)[0] is False
        assert source_release_safe(root / "absent-repo")[0] is False
        self_test_dependency_install(root)
        self_test_recovery_journal(root)
    print("self-test: PASS")
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--provider", choices=sorted(load_json(CONTRACT_PATH)["providers"]))
    parser.add_argument("--scry-repo", default=str(DEFAULT_SCRY_REPO))
    parser.add_argument("--rate-native-repo", default=str(DEFAULT_RATE_NATIVE_REPO))
    parser.add_argument("--build-out", help="fingerprint this explicit Electron build output instead of <scry-repo>/out")
    parser.add_argument("--output")
    parser.add_argument("--repair", action="store_true", help="repair only contract-approved local state before freezing")
    parser.add_argument("--recovery-output", help="required with --repair; stores a redacted recovery manifest")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if not args.self_test and not args.provider:
        parser.error("--provider is required")
    if args.repair and not args.recovery_output:
        parser.error("--recovery-output is required with --repair")
    if args.repair and args.build_out:
        parser.error("--repair cannot be combined with --build-out; recovery always inspects canonical Scry out")
    return args


def main() -> int:
    args = parse_args()
    if args.self_test:
        return self_test()
    scry_repo = Path(args.scry_repo).resolve()
    rate_native_repo = Path(args.rate_native_repo).resolve()
    result = (
        reconcile_environment(
            args.provider,
            scry_repo,
            rate_native_repo,
            Path(args.recovery_output).expanduser().resolve(),
        )
        if args.repair
        else inspect(
            args.provider,
            scry_repo,
            rate_native_repo,
            Path(args.build_out).expanduser().resolve() if args.build_out else None,
        )
    )
    rendered = json.dumps(result, ensure_ascii=False, indent=2) + "\n"
    print(rendered, end="")
    if args.output:
        write_json_atomic(Path(args.output).expanduser().resolve(), result)
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
