#!/usr/bin/env python3
"""Archive validation residue and restore one fixed warm workspace safely."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import fixed_workspace as fixed_workspace_control


SKILL_DIR = Path(__file__).resolve().parent.parent
CONTRACT = json.loads((SKILL_DIR / "references" / "contract.json").read_text(encoding="utf-8"))
FIXED = CONTRACT["fixedTreehouse"]
PROVIDERS = CONTRACT["providers"]
RECORDER_RECOVERY = CONTRACT["recoveryPolicy"]["recorder"]
RUN_PREFIX = "validate-scry-rate-workflow-"
RUN_ROOT_PARENT = Path(CONTRACT["retention"]["runRootParent"]).expanduser().resolve()
PREFLIGHT_CANDIDATES = ("preflight-build-cache.json", "preflight.json")


def emit(value: Any) -> None:
    print(json.dumps(value, ensure_ascii=False, indent=2))


def now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def run(command: list[str], cwd: Path | None = None, timeout: int = 120) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        cwd=cwd,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        timeout=timeout,
        check=False,
    )


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json_atomic(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_name(f"{path.name}.tmp-{os.getpid()}")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.chmod(0o600)
    temporary.replace(path)


def slot_for(provider: str) -> int:
    config = PROVIDERS.get(provider)
    value = config.get("treehouseSlot") if isinstance(config, dict) else None
    if type(value) is not int or value <= 0:
        raise ValueError(f"provider {provider!r} has no fixed treehouse slot")
    return value


def workspace_for(provider: str) -> Path:
    return (
        Path(FIXED["poolRoot"]).expanduser()
        / str(slot_for(provider))
        / str(FIXED["workspaceName"])
    ).resolve()


def safe_run_root(raw: str) -> Path:
    path = Path(raw).expanduser().resolve()
    if not path.is_dir() or path.parent != RUN_ROOT_PARENT or not path.name.startswith(RUN_PREFIX):
        raise ValueError(f"run root must be an existing {RUN_ROOT_PARENT}/{RUN_PREFIX}* directory")
    return path


def slot_lock_path(provider: str) -> Path:
    return (
        Path(FIXED["poolRoot"]).expanduser().resolve()
        / ".validate-scry-rate-workflow"
        / "locks"
        / f"slot-{slot_for(provider)}-{provider}.json"
    )


def require_slot_lock(provider: str, run_root: Path) -> None:
    path = slot_lock_path(provider)
    if not path.is_file():
        raise RuntimeError(f"slot lock is not held: {path}")
    value = read_json(path)
    if value.get("runRoot") != str(run_root):
        raise RuntimeError(f"slot lock belongs to another run: {value}")


def require_after_cleanup_authorization(provider: str, run_root: Path) -> dict[str, Any]:
    return fixed_workspace_control.terminal_cleanup_authorization(provider, run_root)


def require_test_app_stopped(run_root: Path) -> dict[str, Any] | None:
    path = run_root / "test-scry-state.json"
    if not path.is_file():
        return None
    value = read_json(path)
    if not isinstance(value, dict) or value.get("status") not in {"stopped", "stale"}:
        raise RuntimeError(f"refusing to sanitize before the owned Scry Test is stopped: {value}")
    if isinstance(value.get("version"), int) and value.get("version") >= 2:
        stop_attempt = value.get("stopAttempt") if isinstance(value.get("stopAttempt"), dict) else {}
        final_observation = stop_attempt.get("finalObservation") if isinstance(stop_attempt.get("finalObservation"), dict) else {}
        stop_control = value.get("stopControl") if isinstance(value.get("stopControl"), dict) else {}
        if (
            final_observation.get("processAlive") is not False
            or final_observation.get("cdpOpen") is not False
            or value.get("ownedRendererReady") is not False
            or value.get("windowTitleLabeled") is not False
            or not isinstance(stop_control.get("signalsReserved"), int)
            or stop_control.get("signalsReserved", 0) > 2
        ):
            raise RuntimeError(f"refusing to sanitize without terminal owned App evidence: {value}")
    return {
        "status": value.get("status"),
        "launchId": value.get("launchId"),
        "pid": value.get("pid"),
        "port": value.get("port"),
        "finalObservation": value.get("stopAttempt", {}).get("finalObservation") if isinstance(value.get("stopAttempt"), dict) else None,
    }


def validate_relative(raw: str) -> Path:
    path = Path(raw)
    if path.is_absolute() or not path.parts or any(part in {"", ".", ".."} for part in path.parts):
        raise ValueError(f"unsafe cleanup path in contract: {raw!r}")
    return path


def require_safe_ancestors(workspace: Path, path: Path) -> None:
    current = path.parent
    while current != workspace:
        if current.is_symlink():
            raise RuntimeError(f"cleanup path has a symlinked parent: {path} via {current}")
        if current == current.parent:
            raise RuntimeError(f"cleanup path escaped workspace: {path}")
        current = current.parent


def collect_runtime_paths(workspace: Path, exact_paths: list[str], glob_paths: list[str]) -> list[Path]:
    candidates: set[Path] = set()
    for raw in exact_paths:
        relative = validate_relative(raw)
        path = workspace / relative
        if path.exists() or path.is_symlink():
            require_safe_ancestors(workspace, path)
            candidates.add(path)
    for raw in glob_paths:
        validate_relative(raw)
        for path in workspace.glob(raw):
            try:
                path.relative_to(workspace)
            except ValueError as exc:
                raise RuntimeError(f"cleanup glob escaped workspace: {path}") from exc
            if path.exists() or path.is_symlink():
                require_safe_ancestors(workspace, path)
                candidates.add(path)

    selected: list[Path] = []
    for path in sorted(candidates, key=lambda item: (len(item.relative_to(workspace).parts), str(item))):
        if any(parent == existing for existing in selected for parent in path.parents):
            continue
        selected.append(path)
    return selected


def archive_runtime_paths(workspace: Path, archive_root: Path) -> list[str]:
    paths = collect_runtime_paths(
        workspace,
        list(FIXED["cleanupExactPaths"]),
        list(FIXED["cleanupGlobPaths"]),
    )
    moved: list[str] = []
    for source in paths:
        relative = source.relative_to(workspace)
        destination = archive_root / "runtime" / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        if destination.exists() or destination.is_symlink():
            raise RuntimeError(f"archive destination already exists: {destination}")
        shutil.move(str(source), str(destination))
        moved.append(relative.as_posix())
    return moved


def health_snapshot(workspace: Path) -> dict[str, Any] | None:
    path = workspace / ".scry" / "upload" / "health.json"
    if not path.is_file():
        return None
    try:
        value = read_json(path)
    except (OSError, json.JSONDecodeError) as exc:
        return {"readError": str(exc)}
    if not isinstance(value, dict):
        return {"readError": "health.json is not an object"}
    allowed = (
        "pendingCount",
        "deadLetterCount",
        "lastErrorCode",
        "lastSuccessAt",
        "lastAttemptAt",
    )
    return {key: value.get(key) for key in allowed}


def require_absolute_scry_bin(raw: str | None) -> str:
    if not isinstance(raw, str) or not raw:
        raise ValueError("--scry-bin is required for workspace cleanup")
    candidate = Path(raw).expanduser()
    if not candidate.is_absolute():
        raise ValueError(f"--scry-bin must be an absolute path: {raw}")
    if not candidate.is_file() or not os.access(candidate, os.X_OK):
        raise ValueError(f"--scry-bin is not an executable file: {candidate}")
    return str(candidate.resolve())


def frozen_preflight(run_root: Path, provider: str) -> dict[str, Any]:
    for name in PREFLIGHT_CANDIDATES:
        path = run_root / name
        if path.is_symlink():
            raise RuntimeError(f"frozen preflight is a symlink: {path}")
        if not os.path.lexists(path):
            continue
        if not path.is_file():
            raise RuntimeError(f"frozen preflight is not a regular file: {path}")
        try:
            value = read_json(path)
        except (OSError, UnicodeError, json.JSONDecodeError) as exc:
            raise RuntimeError(f"frozen preflight is unreadable: {path}: {exc}") from exc
        if not isinstance(value, dict) or value.get("ok") is not True or value.get("provider") != provider:
            raise RuntimeError(f"frozen preflight does not identify a successful {provider} baseline: {path}")
        return value
    raise RuntimeError(f"no frozen preflight exists under {run_root}")


def frozen_scry_bin(run_root: Path, provider: str, raw: str | None) -> dict[str, Any]:
    """Resolve the recorder CLI used to operate on workspace state.

    Cleanup always uses the CLI currently installed under the stable prefix (the
    latest), not the exact version frozen at run time: an upgraded recorder must
    not strand old retained sites. The frozen version is only disclosed for the
    record; the gates are identity (inside the configured package root, package
    name matches) and runnability (--version succeeds), never version parity.
    """
    supplied = Path(require_absolute_scry_bin(raw))
    frozen = frozen_preflight(run_root, provider)
    versions = frozen.get("versions") if isinstance(frozen.get("versions"), dict) else {}
    source = versions.get("scry") if isinstance(versions.get("scry"), dict) else {}
    rate_native = versions.get("rateNative") if isinstance(versions.get("rateNative"), dict) else {}
    frozen_version = source.get("package")
    if not (isinstance(frozen_version, str) and frozen_version):
        raise RuntimeError("frozen preflight has no recorder source version")

    package_name = RECORDER_RECOVERY.get("package")
    prefix = Path(str(RECORDER_RECOVERY.get("installPrefix", ""))).expanduser().resolve()
    binary = prefix / "bin" / "scry"
    package_root = prefix / "lib" / "node_modules" / str(package_name)
    if not binary.is_file() or not os.access(binary, os.X_OK):
        raise RuntimeError(f"stable prefix recorder CLI is not executable: {binary}")
    candidate = binary.resolve()
    try:
        candidate.relative_to(package_root)
    except ValueError as exc:
        raise RuntimeError(f"recorder CLI is outside the configured package root: {candidate}") from exc
    try:
        package = read_json(package_root / "package.json")
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"installed recorder package identity is unreadable: {package_root}: {exc}") from exc
    if not (isinstance(package, dict) and package.get("name") == package_name):
        raise RuntimeError(f"installed recorder package identity mismatch: {package_root}")
    if supplied.resolve() != candidate:
        raise RuntimeError(f"--scry-bin does not match the stable prefix recorder CLI: {supplied} != {candidate}")

    try:
        completed = run([str(candidate), "--version"], timeout=30)
    except (OSError, UnicodeError, subprocess.TimeoutExpired) as exc:
        raise RuntimeError(f"cannot execute recorder CLI: {exc}") from exc
    lines = (completed.stdout or completed.stderr).strip().splitlines()
    live_version = lines[-1].strip() if lines else None
    if completed.returncode != 0 or not live_version:
        raise RuntimeError(f"recorder CLI --version failed: {live_version!r}")
    return {
        "path": str(candidate),
        "frozenVersion": frozen_version,
        "liveVersion": live_version,
        "versionParity": frozen_version == live_version,
    }


def recorder_cli_for_workspace(
    workspace: Path,
    run_root: Path,
    provider: str,
    raw: str | None,
) -> dict[str, Any] | None:
    recorder_state = workspace / ".scry"
    if recorder_state.is_symlink():
        raise RuntimeError(f"refusing recorder cleanup through a symlink: {recorder_state}")
    if not recorder_state.exists():
        return None
    return frozen_scry_bin(run_root, provider, raw)


def stop_recorder(workspace: Path, scry_bin: str | None) -> dict[str, Any]:
    if not (workspace / ".scry").exists():
        return {"attempted": False, "reason": "no .scry directory"}
    if scry_bin is None:
        raise RuntimeError("recorder state exists but no recorder CLI was supplied")
    result = run([scry_bin, "recorder", "stop", "--workspace", str(workspace)], workspace)
    if result.returncode != 0:
        detail = (result.stderr or result.stdout).strip()
        raise RuntimeError(f"scry recorder stop failed: {detail}")
    return {
        "attempted": True,
        "returnCode": result.returncode,
        "stdout": result.stdout.strip()[-1000:],
        "stderr": result.stderr.strip()[-1000:],
    }


def git_result(repo: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return run(["git", *args], repo)


def porcelain_path(line: str) -> str:
    """The path a `git status --porcelain=v1` entry refers to, rename target included."""
    raw = line[3:] if len(line) > 3 else ""
    if " -> " in raw:
        raw = raw.split(" -> ", 1)[1]
    raw = raw.strip()
    if len(raw) > 1 and raw.startswith('"') and raw.endswith('"'):
        raw = raw[1:-1]
    return raw.rstrip("/")


def foreign_status(porcelain: str, nested_relatives: frozenset[str]) -> list[str]:
    """Status entries that are this repository's own, excluding nested warm repositories.

    A nested warm repository shows up as a single untracked entry in its parent, but it
    is archived under its own name, so the parent must neither move it nor count it as
    leftover dirt.
    """
    return [
        line
        for line in porcelain.splitlines()
        if line.strip() and porcelain_path(line) not in nested_relatives
    ]


def archive_git_changes(
    repo: Path,
    archive_root: Path,
    name: str,
    nested_relatives: frozenset[str] = frozenset(),
) -> dict[str, Any]:
    if not repo.is_dir():
        raise RuntimeError(
            f"expected a Git repository at {repo}, but the path is gone; a nested repository "
            "must not be archived by its parent"
        )
    top = git_result(repo, "rev-parse", "--show-toplevel")
    if top.returncode != 0 or Path(top.stdout.strip()).resolve() != repo.resolve():
        raise RuntimeError(f"expected a Git repository at {repo}")
    status = git_result(repo, "status", "--porcelain=v1", "--untracked-files=all")
    if status.returncode != 0:
        raise RuntimeError(status.stderr.strip() or f"git status failed: {repo}")
    skipped = sorted(nested_relatives)
    if not foreign_status(status.stdout, nested_relatives):
        return {
            "name": name,
            "repo": str(repo),
            "dirty": False,
            "archivedUntracked": [],
            "skippedNestedRepositories": skipped,
        }

    destination = archive_root / "git" / name
    destination.mkdir(parents=True, exist_ok=False)
    (destination / "status.txt").write_text(status.stdout, encoding="utf-8")
    patch = git_result(repo, "diff", "--binary", "HEAD", "--")
    if patch.returncode != 0:
        raise RuntimeError(patch.stderr.strip() or f"git diff failed: {repo}")
    (destination / "tracked.patch").write_text(patch.stdout, encoding="utf-8")

    untracked = git_result(repo, "ls-files", "--others", "--exclude-standard", "-z")
    if untracked.returncode != 0:
        raise RuntimeError(untracked.stderr.strip() or f"cannot list untracked files: {repo}")
    archived_untracked: list[str] = []
    for raw in filter(None, untracked.stdout.split("\0")):
        relative = validate_relative(raw)
        if relative.as_posix() in nested_relatives:
            continue
        source = repo / relative
        if not source.exists() and not source.is_symlink():
            continue
        target = destination / "untracked" / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(source), str(target))
        archived_untracked.append(relative.as_posix())

    reset = git_result(repo, "reset", "--hard", "HEAD")
    if reset.returncode != 0:
        raise RuntimeError(reset.stderr.strip() or f"git reset failed: {repo}")
    final = git_result(repo, "status", "--porcelain=v1", "--untracked-files=all")
    if final.returncode != 0:
        raise RuntimeError(final.stderr.strip() or f"git status failed after archive: {repo}")
    remaining = foreign_status(final.stdout, nested_relatives)
    if remaining:
        raise RuntimeError(f"repository remains dirty after evidence archive: {repo}: {remaining!r}")
    return {
        "name": name,
        "repo": str(repo),
        "dirty": True,
        "patch": str(destination / "tracked.patch"),
        "archivedUntracked": archived_untracked,
        "skippedNestedRepositories": skipped,
    }


def load_or_quarantine_manifest(
    archive_root: Path,
    expected_identity: dict[str, Any],
) -> tuple[dict[str, Any] | None, dict[str, str] | None]:
    manifest_path = archive_root / "manifest.json"
    if manifest_path.is_symlink():
        raise RuntimeError(f"cleanup manifest is a symlink: {manifest_path}")
    if not manifest_path.exists():
        return None, None
    try:
        existing = read_json(manifest_path) if manifest_path.is_file() else None
        error = None if isinstance(existing, dict) else "manifest is not a JSON object"
    except (OSError, json.JSONDecodeError) as exc:
        existing = None
        error = str(exc)
    identity_matches = bool(
        isinstance(existing, dict)
        and existing.get("ok") is True
        and all(existing.get(key) == value for key, value in expected_identity.items())
    )
    if identity_matches:
        return existing, None
    if isinstance(existing, dict) and existing.get("ok") is True:
        error = "manifest identity does not match this schema/phase/provider/workspace/archive root"

    recovery_root = archive_root / "recovery"
    recovery_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    destination = recovery_root / f"invalid-manifest-{time.time_ns()}"
    if manifest_path.is_file():
        destination = destination.with_suffix(".json")
    shutil.move(str(manifest_path), str(destination))
    return None, {
        "source": str(manifest_path),
        "destination": str(destination),
        "reason": error or "manifest did not record ok=true",
    }


def repository_root(path: Path) -> bool:
    if path.is_symlink() or not path.is_dir():
        return False
    top = git_result(path, "rev-parse", "--show-toplevel")
    return top.returncode == 0 and Path(top.stdout.strip()).resolve() == path.resolve()


def sanitize(provider: str, run_root: Path, phase: str, scry_bin: str | None) -> dict[str, Any]:
    require_slot_lock(provider, run_root)
    cleanup_authorization = require_after_cleanup_authorization(provider, run_root) if phase == "after" else None
    test_app = require_test_app_stopped(run_root) if phase == "after" else None
    workspace = workspace_for(provider)
    if not workspace.is_dir():
        raise RuntimeError(f"fixed workspace missing: {workspace}")
    top = git_result(workspace, "rev-parse", "--show-toplevel")
    if top.returncode != 0 or Path(top.stdout.strip()).resolve() != workspace:
        raise RuntimeError(f"not the expected fixed rate-native worktree: {workspace}")
    scry_bin_identity = recorder_cli_for_workspace(workspace, run_root, provider, scry_bin)
    scry_bin = scry_bin_identity["path"] if scry_bin_identity else None

    archive_root = run_root / f"workspace-cleanup-{phase}"
    manifest_path = archive_root / "manifest.json"
    resumed_partial = archive_root.exists()
    archive_root.mkdir(mode=0o700, exist_ok=True)
    manifest_identity = {
        "schemaVersion": 2,
        "phase": phase,
        "provider": provider,
        "workspace": str(workspace),
        "archiveRoot": str(archive_root),
    }
    existing, recovered_manifest = load_or_quarantine_manifest(archive_root, manifest_identity)
    if existing is not None:
        return {**existing, "idempotent": True}
    prior_attempts = sorted(
        path.name
        for path in archive_root.glob("attempt-*")
        if path.is_dir() and not path.is_symlink()
    )
    attempt_root = archive_root / f"attempt-{time.time_ns()}-{os.getpid()}"
    attempt_root.mkdir(mode=0o700)
    health = health_snapshot(workspace)
    recorder = stop_recorder(workspace, scry_bin)
    moved = archive_runtime_paths(workspace, attempt_root)

    repositories = [("rate-native", workspace)]
    nested_relatives: set[str] = set()
    incomplete_repositories: list[dict[str, str]] = []
    for raw in FIXED["warmRepositories"]:
        relative = validate_relative(raw)
        repo = workspace / relative
        if not repo.exists() and not repo.is_symlink():
            continue
        require_safe_ancestors(workspace, repo)
        if repo.is_symlink():
            raise RuntimeError(f"nested repository path is a symlink: {repo}")
        try:
            repo.resolve().relative_to(workspace)
        except ValueError as exc:
            raise RuntimeError(f"nested repository escapes fixed workspace: {repo}") from exc
        if not repository_root(repo):
            destination = attempt_root / "incomplete-repositories" / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(repo), str(destination))
            incomplete_repositories.append({
                "source": str(repo),
                "destination": str(destination),
            })
            continue
        repositories.append((relative.as_posix().replace("/", "__"), repo))
        nested_relatives.add(relative.as_posix())
    # Only the parent skips them: each nested warm repository is archived under its own
    # name, so the parent must not move it away first and then try to archive the hole.
    nested = frozenset(nested_relatives)
    git_archives = [
        archive_git_changes(repo, attempt_root, name, nested if repo == workspace else frozenset())
        for name, repo in repositories
    ]

    for _ in range(10):
        time.sleep(0.2)
        reappeared = [
            path.relative_to(workspace).as_posix()
            for path in collect_runtime_paths(
                workspace,
                list(FIXED["cleanupExactPaths"]),
                list(FIXED["cleanupGlobPaths"]),
            )
        ]
        if reappeared:
            raise RuntimeError(f"runtime state reappeared after recorder stop; a writer is still active: {reappeared}")

    result = {
        "schemaVersion": 2,
        "ok": True,
        "phase": phase,
        "provider": provider,
        "slot": slot_for(provider),
        "workspace": str(workspace),
        "archivedAt": now(),
        "archiveRoot": str(archive_root),
        "attemptRoot": str(attempt_root),
        "resumedPartial": resumed_partial,
        "priorAttempts": prior_attempts,
        "recoveredInvalidManifest": recovered_manifest,
        "uploadHealthBeforeArchive": health,
        "testAppBeforeCleanup": test_app,
        "cleanupAuthorization": cleanup_authorization,
        "recorderStop": recorder,
        "recorderCli": scry_bin_identity,
        "runtimePaths": moved,
        "incompleteRepositories": incomplete_repositories,
        "gitRepositories": git_archives,
    }
    write_json_atomic(manifest_path, result)
    return result


def self_test_nested_repository(root: Path) -> None:
    """A nested warm repository the parent does not ignore must survive the parent's archive.

    Observed for real: `rate-doc` is the only warm repository missing from the fixed
    workspace's `.gitignore`, so it surfaced as `?? rate-doc/` in the parent, the parent
    moved the whole nested repository into its own untracked evidence, and archiving
    `rate-doc` afterwards died on a vanished working directory.
    """
    def fixture_git(repo: Path, *arguments: str) -> None:
        assert git_result(repo, *arguments).returncode == 0, (repo, arguments)

    def fixture_repo(repo: Path) -> None:
        repo.mkdir(parents=True, exist_ok=True)
        fixture_git(repo, "init", "-q")
        fixture_git(repo, "config", "user.name", "fixture")
        fixture_git(repo, "config", "user.email", "fixture@example.invalid")

    parent = root / "nested-fixture" / "rate-native"
    fixture_repo(parent)
    (parent / "README.md").write_text("tracked\n", encoding="utf-8")
    fixture_git(parent, "add", "-A")
    fixture_git(parent, "commit", "-q", "-m", "fixture")

    nested = parent / "rate-doc"
    fixture_repo(nested)
    (nested / "OVERVIEW.md").write_text("doc\n", encoding="utf-8")
    fixture_git(nested, "add", "-A")
    fixture_git(nested, "commit", "-q", "-m", "doc")
    (parent / "own-scratch.txt").write_text("parent dirt\n", encoding="utf-8")

    archive = root / "nested-fixture" / "archive"
    archive.mkdir(parents=True)
    parent_archive = archive_git_changes(parent, archive, "rate-native", frozenset({"rate-doc"}))
    assert parent_archive["archivedUntracked"] == ["own-scratch.txt"], parent_archive
    assert parent_archive["skippedNestedRepositories"] == ["rate-doc"], parent_archive
    # The parent must neither move the nested repository away nor report the leftover
    # `?? rate-doc/` entry as dirt it failed to clean.
    assert (nested / "OVERVIEW.md").is_file(), "parent archived the nested repository"
    assert archive_git_changes(nested, archive, "rate-doc")["dirty"] is False

    # A vanished repository is a readable contract violation, not a bare OS error.
    shutil.rmtree(nested)
    try:
        archive_git_changes(nested, archive, "rate-doc-missing")
        raise AssertionError("archiving a vanished repository was accepted")
    except RuntimeError as exc:
        assert "the path is gone" in str(exc), exc

    assert porcelain_path("?? rate-doc/") == "rate-doc"
    assert porcelain_path("R  old.md -> new.md") == "new.md"
    assert foreign_status("?? rate-doc/\n", frozenset({"rate-doc"})) == []
    assert foreign_status("?? other/\n", frozenset({"rate-doc"})) == ["?? other/"]


def self_test() -> int:
    global RECORDER_RECOVERY
    RUN_ROOT_PARENT.mkdir(parents=True, exist_ok=True, mode=0o700)
    with tempfile.TemporaryDirectory(prefix=RUN_PREFIX, dir=RUN_ROOT_PARENT) as raw:
        root = Path(raw)
        assert safe_run_root(raw) == root.resolve()
        scry_fixture = root / "scry"
        scry_fixture.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
        scry_fixture.chmod(0o700)
        assert require_absolute_scry_bin(str(scry_fixture)) == str(scry_fixture.resolve())
        for invalid in (None, "scry", str(root / "missing-scry")):
            try:
                require_absolute_scry_bin(invalid)
                raise AssertionError(f"invalid Scry CLI was accepted: {invalid!r}")
            except ValueError:
                pass
        no_recorder_workspace = root / "no-recorder-workspace"
        no_recorder_workspace.mkdir()
        assert recorder_cli_for_workspace(no_recorder_workspace, root, "codex", None) is None

        original_recorder_recovery = RECORDER_RECOVERY
        prefix = root / "stable-prefix"
        package_name = "@fixture/scry-turn-recorder"
        package_root = prefix / "lib" / "node_modules" / package_name
        cli_entry = package_root / "dist" / "scry"
        cli_entry.parent.mkdir(parents=True)
        cli_entry.write_text("#!/bin/sh\nprintf '1.2.3\\n'\n", encoding="utf-8")
        cli_entry.chmod(0o700)
        (package_root / "package.json").write_text(
            json.dumps({"name": package_name, "version": "1.2.3"}) + "\n",
            encoding="utf-8",
        )
        binary = prefix / "bin" / "scry"
        binary.parent.mkdir(parents=True)
        binary.symlink_to(cli_entry)
        RECORDER_RECOVERY = {
            **original_recorder_recovery,
            "package": package_name,
            "installPrefix": str(prefix),
        }
        (root / "preflight.json").write_text(json.dumps({
            "ok": True,
            "provider": "codex",
            "versions": {
                "scry": {"package": "1.2.3", "recorderConstant": "1.2.3"},
                "installedCli": {"path": str(cli_entry.resolve()), "version": "1.2.3"},
                "installedCliProvenance": {
                    "ready": True,
                    "prefix": str(prefix.resolve()),
                    "binary": str(binary),
                    "resolved": str(cli_entry.resolve()),
                    "insidePackageRoot": True,
                    "packageName": package_name,
                    "packageVersion": "1.2.3",
                    "executableVersion": "1.2.3",
                },
                "rateNative": {"cliPath": str(binary), "cliVersion": "1.2.3"},
            },
        }) + "\n", encoding="utf-8")
        (no_recorder_workspace / ".scry").mkdir()
        try:
            recorder_cli_for_workspace(no_recorder_workspace, root, "codex", None)
            raise AssertionError("recorder state accepted a missing frozen CLI")
        except ValueError:
            pass
        identity = recorder_cli_for_workspace(no_recorder_workspace, root, "codex", str(binary))
        assert identity == {
            "path": str(cli_entry.resolve()),
            "frozenVersion": "1.2.3",
            "liveVersion": "1.2.3",
            "versionParity": True,
        }, identity
        # 实跑版本与冻结版本不一致只披露、不设闸门：升级后的 CLI 必须能清理旧现场
        cli_entry.write_text("#!/bin/sh\nprintf '9.9.9\\n'\n", encoding="utf-8")
        identity = recorder_cli_for_workspace(no_recorder_workspace, root, "codex", str(binary))
        assert identity["liveVersion"] == "9.9.9" and identity["versionParity"] is False, identity
        cli_entry.write_text("#!/bin/sh\nprintf '1.2.3\\n'\n", encoding="utf-8")
        # 已安装 package 的 version 落后同样只披露；package name 才是身份边界
        package_path = package_root / "package.json"
        package_path.write_text(
            json.dumps({"name": package_name, "version": "9.9.9"}) + "\n",
            encoding="utf-8",
        )
        identity = recorder_cli_for_workspace(no_recorder_workspace, root, "codex", str(binary))
        assert identity["path"] == str(cli_entry.resolve()), identity
        package_path.write_text(
            json.dumps({"name": "some-other-package", "version": "1.2.3"}) + "\n",
            encoding="utf-8",
        )
        try:
            recorder_cli_for_workspace(no_recorder_workspace, root, "codex", str(binary))
            raise AssertionError("recorder state accepted a foreign package identity")
        except RuntimeError as exc:
            assert "package identity mismatch" in str(exc)
        package_path.write_text(
            json.dumps({"name": package_name, "version": "1.2.3"}) + "\n",
            encoding="utf-8",
        )
        RECORDER_RECOVERY = original_recorder_recovery
        state = root / "test-scry-state.json"
        state.write_text('{"status":"running"}\n', encoding="utf-8")
        try:
            require_test_app_stopped(root)
            raise AssertionError("running test app state was accepted")
        except RuntimeError:
            pass
        state.write_text('{"status":"stale","launchId":"fixture"}\n', encoding="utf-8")
        assert require_test_app_stopped(root)["status"] == "stale"
        state.write_text(json.dumps({
            "version": 2,
            "status": "stopped",
            "ownedRendererReady": False,
            "windowTitleLabeled": False,
            "stopControl": {"signalsReserved": 2},
            "stopAttempt": {"finalObservation": {"processAlive": False, "cdpOpen": False}},
        }), encoding="utf-8")
        assert require_test_app_stopped(root)["finalObservation"] == {"processAlive": False, "cdpOpen": False}
        state.write_text(json.dumps({
            "version": 2,
            "status": "stopped",
            "ownedRendererReady": False,
            "windowTitleLabeled": False,
            "stopControl": {"signalsReserved": 2},
            "stopAttempt": {"finalObservation": {"processAlive": False, "cdpOpen": None}},
        }), encoding="utf-8")
        try:
            require_test_app_stopped(root)
            raise AssertionError("unknown CDP state was accepted as stopped")
        except RuntimeError:
            pass
        state.unlink()
        try:
            require_after_cleanup_authorization("codex", root)
            raise AssertionError("after-cleanup without lifecycle authorization was accepted")
        except RuntimeError:
            pass
        workspace = root / "workspace"
        workspace.mkdir()
        (workspace / ".scry" / "records").mkdir(parents=True)
        (workspace / ".scry" / "records" / "turn.json").write_text("{}\n", encoding="utf-8")
        (workspace / ".claude").mkdir()
        (workspace / ".claude" / "traces-fixture.jsonl").write_text("fixture\n", encoding="utf-8")
        paths = collect_runtime_paths(workspace, [".scry"], [".claude/traces*.jsonl*"])
        assert [path.relative_to(workspace).as_posix() for path in paths] == [
            ".scry",
            ".claude/traces-fixture.jsonl",
        ]
        archive = root / "archive"
        original_exact = FIXED["cleanupExactPaths"]
        original_globs = FIXED["cleanupGlobPaths"]
        try:
            FIXED["cleanupExactPaths"] = [".scry"]
            FIXED["cleanupGlobPaths"] = [".claude/traces*.jsonl*"]
            moved = archive_runtime_paths(workspace, archive)
        finally:
            FIXED["cleanupExactPaths"] = original_exact
            FIXED["cleanupGlobPaths"] = original_globs
        assert moved == [".scry", ".claude/traces-fixture.jsonl"]
        assert (archive / "runtime" / ".scry" / "records" / "turn.json").is_file()

        repo = root / "repo"
        repo.mkdir()
        assert run(["git", "init"], repo).returncode == 0
        assert run(["git", "config", "user.name", "fixture"], repo).returncode == 0
        assert run(["git", "config", "user.email", "fixture@example.invalid"], repo).returncode == 0
        (repo / "tracked.txt").write_text("before\n", encoding="utf-8")
        assert run(["git", "add", "tracked.txt"], repo).returncode == 0
        assert run(["git", "commit", "-m", "fixture"], repo).returncode == 0
        (repo / "tracked.txt").write_text("after\n", encoding="utf-8")
        (repo / "untracked.txt").write_text("untracked\n", encoding="utf-8")
        result = archive_git_changes(repo, archive, "fixture")
        assert result["dirty"] is True
        assert (archive / "git" / "fixture" / "untracked" / "untracked.txt").is_file()
        assert git_result(repo, "status", "--porcelain=v1").stdout == ""

        partial = root / "partial-cleanup"
        partial.mkdir()
        invalid_manifest = partial / "manifest.json"
        invalid_manifest.write_text("{broken\n", encoding="utf-8")
        identity = {
            "schemaVersion": 2,
            "phase": "before",
            "provider": "codex",
            "workspace": "/fixture/workspace",
            "archiveRoot": str(partial),
        }
        existing, recovered = load_or_quarantine_manifest(partial, identity)
        assert existing is None and recovered is not None
        assert Path(recovered["destination"]).read_text(encoding="utf-8") == "{broken\n"
        valid_manifest = partial / "manifest.json"
        valid_manifest.write_text(json.dumps({"ok": True, **identity}) + "\n", encoding="utf-8")
        existing, recovered = load_or_quarantine_manifest(partial, identity)
        assert existing == {"ok": True, **identity} and recovered is None

        incomplete = root / "incomplete-repository"
        incomplete.mkdir()
        assert repository_root(incomplete) is False

        self_test_nested_repository(root)
    print("self-test: PASS")
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--provider", choices=sorted(PROVIDERS))
    parser.add_argument("--run-root")
    parser.add_argument("--phase", choices=("before", "after"))
    parser.add_argument("--scry-bin")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.self_test:
        return self_test()
    if not args.provider or not args.run_root or not args.phase:
        raise ValueError("--provider, --run-root, and --phase are required")
    emit(sanitize(args.provider, safe_run_root(args.run_root), args.phase, args.scry_bin))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired, json.JSONDecodeError) as exc:
        emit({"ok": False, "error": str(exc)})
        sys.exit(1)
