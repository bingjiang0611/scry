#!/usr/bin/env python3
"""Safely archive a schema-5+ validation that never crossed turn-1 send intent."""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import uuid
from contextlib import contextmanager, nullcontext
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


SCRIPT_DIR = Path(__file__).resolve().parent
SKILL_DIR = SCRIPT_DIR.parent
CONTRACT_PATH = SKILL_DIR / "references" / "contract.json"
SCRY_REPO = (SCRIPT_DIR.parents[3] / "scry").resolve()
RUN_PREFIX = "validate-scry-rate-workflow-"
LIFECYCLE_NAME = "lifecycle.json"
PREPARED_ARCHIVE_NAME = "pre-send-archive-prepared.json"
PREFLIGHT_CANDIDATES = ("preflight-build-cache.json", "preflight.json")


class FinalizeError(RuntimeError):
    def __init__(self, stage: str, message: str, details: Any = None):
        super().__init__(message)
        self.stage = stage
        self.details = details


def now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def emit(value: Any) -> None:
    print(json.dumps(value, ensure_ascii=False, indent=2))


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def contract_bytes() -> bytes:
    return CONTRACT_PATH.read_bytes()


def contract_hash(raw: bytes) -> str:
    return "sha256:" + hashlib.sha256(raw).hexdigest()


def safe_relative(raw: Any, label: str) -> Path:
    if not isinstance(raw, str) or not raw:
        raise ValueError(f"{label} must be a non-empty relative path")
    path = Path(raw)
    if path.is_absolute() or any(part in {"", ".", ".."} for part in path.parts):
        raise ValueError(f"unsafe {label}: {raw!r}")
    return path


def safe_run_root(raw: str, contract: dict[str, Any]) -> Path:
    parent_raw = contract.get("retention", {}).get("runRootParent")
    if not isinstance(parent_raw, str) or not parent_raw:
        raise ValueError("contract retention.runRootParent is invalid")
    parent = Path(parent_raw).expanduser().resolve()
    candidate = Path(raw).expanduser()
    if candidate.is_symlink():
        raise ValueError(f"run root must not be a symlink: {candidate}")
    candidate = candidate.resolve()
    if not candidate.is_dir() or candidate.parent != parent or not candidate.name.startswith(RUN_PREFIX):
        raise ValueError(f"run root must be an existing {parent}/{RUN_PREFIX}* directory")
    return candidate


def baseline_preflight(run_root: Path) -> tuple[Path | None, dict[str, Any] | None, str | None]:
    for name in PREFLIGHT_CANDIDATES:
        path = run_root / name
        if path.is_symlink():
            return path, None, f"{name} is a symlink"
        if not os.path.lexists(path):
            continue
        if not path.is_file():
            return path, None, f"{name} is not a regular file"
        try:
            value = read_json(path)
        except (OSError, UnicodeError, json.JSONDecodeError) as exc:
            return path, None, f"{name} cannot be parsed: {exc}"
        if not isinstance(value, dict):
            return path, None, f"{name} is not a JSON object"
        return path, value, None
    return None, None, "no frozen preflight was found"


def classify_frozen_contract(
    run_root: Path,
    frozen: dict[str, Any] | None,
    current_contract: dict[str, Any],
    current_contract_raw: bytes,
    preflight_error: str | None = None,
) -> dict[str, Any]:
    """Return a non-mutating decision about the turn-1 cleanup boundary."""
    if not isinstance(frozen, dict):
        return {
            "eligible": False,
            "status": "RETAINED_LEGACY",
            "reason": preflight_error or "frozen contract is unavailable",
        }
    if frozen.get("ok") is not True:
        return {
            "eligible": False,
            "status": "RETAINED_LEGACY",
            "reason": "the frozen preflight was not successful",
        }

    frozen_contract = frozen.get("contract")
    frozen_schema = frozen.get("contractSchemaVersion")
    if not isinstance(frozen_contract, dict):
        return {
            "eligible": False,
            "status": "RETAINED_LEGACY",
            "reason": "preflight has no frozen contract identity",
        }
    embedded_schema = frozen_contract.get("schemaVersion")
    if (
        type(frozen_schema) is not int
        or type(embedded_schema) is not int
        or frozen_schema != embedded_schema
        or frozen_schema < 5
    ):
        return {
            "eligible": False,
            "status": "RETAINED_LEGACY",
            "reason": f"frozen contract schema is legacy or inconsistent: {frozen_schema!r}/{embedded_schema!r}",
            "frozenSchemaVersion": frozen_schema,
        }

    current_schema = current_contract.get("schemaVersion")
    frozen_sha = frozen_contract.get("sha256")
    current_sha = contract_hash(current_contract_raw)
    if current_schema != frozen_schema or frozen_sha != current_sha:
        return {
            "eligible": False,
            "status": "RETAINED_LEGACY",
            "reason": "the frozen contract contents cannot be proven from the current skill contract",
            "frozenSchemaVersion": frozen_schema,
            "frozenSha256": frozen_sha,
            "currentSchemaVersion": current_schema,
            "currentSha256": current_sha,
        }

    retention = current_contract.get("retention")
    if not isinstance(retention, dict) or retention.get("autoCleanupBeforeFirstPrompt") is not True:
        return {
            "eligible": False,
            "status": "RETAINED_LEGACY",
            "reason": "the frozen contract does not explicitly enable pre-send auto-cleanup",
            "frozenSchemaVersion": frozen_schema,
            "frozenSha256": frozen_sha,
        }
    try:
        intent_relative = safe_relative(retention.get("sendIntentEvidence"), "sendIntentEvidence")
    except ValueError as exc:
        return {
            "eligible": False,
            "status": "RETAINED_LEGACY",
            "reason": str(exc),
            "frozenSchemaVersion": frozen_schema,
            "frozenSha256": frozen_sha,
        }
    intent_path = run_root / intent_relative
    try:
        draft_relative = safe_relative(retention.get("draftEvidence"), "draftEvidence")
    except ValueError as exc:
        return {
            "eligible": False,
            "status": "RETAINED_LEGACY",
            "reason": str(exc),
            "frozenSchemaVersion": frozen_schema,
            "frozenSha256": frozen_sha,
        }
    draft_path = run_root / draft_relative
    if os.path.lexists(intent_path):
        return {
            "eligible": False,
            "status": "RETAINED_FOR_REVIEW",
            "reason": "turn-1 send intent exists; delivery may have occurred",
            "frozenSchemaVersion": frozen_schema,
            "frozenSha256": frozen_sha,
            "sendIntentPath": str(intent_path),
            "draftEvidencePath": str(draft_path),
        }
    if os.path.lexists(draft_path):
        return {
            "eligible": False,
            "status": "RETAINED_DRAFT",
            "reason": "turn-1 draft evidence exists; the scene is retained for manual review",
            "frozenSchemaVersion": frozen_schema,
            "frozenSha256": frozen_sha,
            "sendIntentPath": str(intent_path),
            "draftEvidencePath": str(draft_path),
        }
    return {
        "eligible": True,
        "status": "PRE_SEND_CLEANUP_REQUIRED",
        "reason": "schema-5+ frozen contract enables cleanup and neither turn-1 send intent nor draft evidence is present",
        "frozenSchemaVersion": frozen_schema,
        "frozenSha256": frozen_sha,
        "sendIntentPath": str(intent_path),
        "draftEvidencePath": str(draft_path),
    }


def slot_for(provider: str, contract: dict[str, Any]) -> int:
    providers = contract.get("providers")
    descriptor = providers.get(provider) if isinstance(providers, dict) else None
    slot = descriptor.get("treehouseSlot") if isinstance(descriptor, dict) else None
    if type(slot) is not int or slot <= 0:
        raise ValueError(f"unsupported provider or invalid fixed slot: {provider!r}")
    return slot


def lock_root(contract: dict[str, Any]) -> Path:
    pool = contract.get("fixedTreehouse", {}).get("poolRoot")
    if not isinstance(pool, str) or not pool:
        raise ValueError("contract fixedTreehouse.poolRoot is invalid")
    return Path(pool).expanduser().resolve() / ".validate-scry-rate-workflow" / "locks"


def slot_lock_path(provider: str, contract: dict[str, Any]) -> Path:
    return lock_root(contract) / f"slot-{slot_for(provider, contract)}-{provider}.json"


def workspace_for(provider: str, contract: dict[str, Any]) -> Path:
    fixed = contract.get("fixedTreehouse", {})
    pool = fixed.get("poolRoot")
    workspace = fixed.get("workspaceName")
    if not isinstance(pool, str) or not isinstance(workspace, str) or not workspace:
        raise FinalizeError("workspace", "contract fixed treehouse workspace is invalid")
    return (Path(pool).expanduser() / str(slot_for(provider, contract)) / workspace).resolve()


def browser_lock_path(contract: dict[str, Any]) -> Path:
    shared = contract.get("fixedTreehouse", {}).get("sharedLocks")
    if not isinstance(shared, list) or "browser" not in shared:
        raise FinalizeError("browser_lock", "contract does not declare the browser shared lock")
    return lock_root(contract) / "shared-browser.json"


def require_slot_lock(provider: str, run_root: Path, contract: dict[str, Any]) -> tuple[Path, dict[str, Any]]:
    path = slot_lock_path(provider, contract)
    if path.is_symlink() or not path.is_file():
        raise FinalizeError("slot_lock", f"Provider slot lock is missing or unsafe: {path}")
    try:
        value = read_json(path)
    except (OSError, json.JSONDecodeError) as exc:
        raise FinalizeError("slot_lock", f"Provider slot lock is unreadable: {path}: {exc}") from exc
    if (
        not isinstance(value, dict)
        or value.get("runRoot") != str(run_root)
        or value.get("provider") != provider
    ):
        raise FinalizeError("slot_lock", f"Provider slot lock does not belong to this run: {value}")
    return path, value


def update_slot_owner_locked(
    path: Path,
    value: dict[str, Any],
    provider: str,
    run_root: Path,
    stage: str,
) -> dict[str, Any]:
    """Record a durable owner hand-off while the lifecycle gate is held."""
    owner_id = value.get("ownerId")
    if not isinstance(owner_id, str) or not owner_id:
        owner_id = str(uuid.uuid4())
    updated = {
        **value,
        "schemaVersion": 2,
        "scope": f"slot:{provider}",
        "provider": provider,
        "runRoot": str(run_root),
        "ownerId": owner_id,
        "ownerState": "INACTIVE" if stage in {"FINALIZE_FAILED", "ABANDONED"} else "ACTIVE",
        "ownerStage": stage,
        "heartbeatAt": now(),
    }
    write_json_atomic(path, updated)
    return updated


def mark_slot_finalize_failed(
    provider: str,
    run_root: Path,
    contract: dict[str, Any],
) -> dict[str, Any] | None:
    """Hand an unsuccessful direct finalizer back to Step 0 without PID guessing."""
    try:
        with lifecycle_gate(contract):
            path, value = require_slot_lock(provider, run_root, contract)
            updated = update_slot_owner_locked(path, value, provider, run_root, "FINALIZE_FAILED")
            return {
                "path": str(path),
                "ownerId": updated.get("ownerId"),
                "ownerState": updated.get("ownerState"),
                "ownerStage": updated.get("ownerStage"),
                "heartbeatAt": updated.get("heartbeatAt"),
            }
    except (FinalizeError, OSError, ValueError, json.JSONDecodeError):
        return None


def release_owned_browser_lock(
    provider: str,
    run_root: Path,
    contract: dict[str, Any],
) -> dict[str, Any]:
    """Release only this run's browser lock while the lifecycle gate is held."""
    path = browser_lock_path(contract)
    if not os.path.lexists(path):
        return {"path": str(path), "owned": False, "released": False, "reason": "absent"}
    if path.is_symlink() or not path.is_file():
        raise FinalizeError("browser_lock", f"browser lock is not a regular file: {path}")
    try:
        value = read_json(path)
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise FinalizeError("browser_lock", f"browser lock is unreadable: {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise FinalizeError("browser_lock", f"browser lock JSON is not an object: {path}")
    if value.get("runRoot") != str(run_root):
        return {"path": str(path), "owned": False, "released": False, "reason": "owned_by_other_run"}
    require_slot_lock(provider, run_root, contract)
    if value.get("scope") != "shared:browser":
        raise FinalizeError("browser_lock", f"this run's browser lock has an invalid scope: {value.get('scope')!r}")
    path.unlink()
    return {"path": str(path), "owned": True, "released": True}


@contextmanager
def lifecycle_gate(contract: dict[str, Any]) -> Any:
    path = lock_root(contract).parent / "lifecycle.lock"
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor = os.open(path, os.O_RDWR | os.O_CREAT, 0o600)
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX)
        yield
    finally:
        fcntl.flock(descriptor, fcntl.LOCK_UN)
        os.close(descriptor)


def write_json_atomic(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor, raw = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    temporary = Path(raw)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(value, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        temporary.chmod(0o600)
        temporary.replace(path)
    except Exception:
        temporary.unlink(missing_ok=True)
        raise


def prepare_json_atomic(path: Path, value: dict[str, Any]) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor, raw = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    temporary = Path(raw)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(value, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        temporary.chmod(0o600)
        return temporary
    except Exception:
        temporary.unlink(missing_ok=True)
        raise


def lifecycle_record(
    status: str,
    provider: str,
    run_root: Path,
    decision: dict[str, Any],
    **extra: Any,
) -> dict[str, Any]:
    return {
        "schemaVersion": 1,
        "state": status,
        "status": status,
        "provider": provider,
        "runRoot": str(run_root),
        "updatedAt": now(),
        "cleanupBoundary": {
            "frozenSchemaVersion": decision.get("frozenSchemaVersion"),
            "frozenSha256": decision.get("frozenSha256"),
            "sendIntentPath": decision.get("sendIntentPath"),
            "sendIntentExists": decision.get("status") == "RETAINED_FOR_REVIEW",
            "draftEvidencePath": decision.get("draftEvidencePath"),
            "draftEvidenceExists": decision.get("status") == "RETAINED_DRAFT",
        },
        **extra,
    }


def run_json(command: list[str], stage: str, timeout: int) -> dict[str, Any]:
    try:
        completed = subprocess.run(
            command,
            text=True,
            encoding="utf-8",
            errors="replace",
            capture_output=True,
            timeout=timeout,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise FinalizeError(stage, f"command failed before producing evidence: {exc}") from exc
    parsed: Any = None
    if completed.stdout.strip():
        try:
            parsed = json.loads(completed.stdout)
        except json.JSONDecodeError:
            parsed = None
    if completed.returncode != 0 or not isinstance(parsed, dict) or parsed.get("ok") is False:
        detail = parsed.get("error") if isinstance(parsed, dict) else None
        if not detail:
            detail = (completed.stderr or completed.stdout).strip()[-2000:]
        raise FinalizeError(stage, str(detail or f"command exited {completed.returncode}"), parsed)
    return parsed


def validate_launch_state(state_path: Path, run_root: Path, contract: dict[str, Any]) -> dict[str, Any] | None:
    if not os.path.lexists(state_path):
        return None
    if state_path.is_symlink() or not state_path.is_file():
        raise FinalizeError("test_state", f"test App state is not a regular file: {state_path}")
    try:
        state = read_json(state_path)
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise FinalizeError("test_state", f"test App state cannot be parsed: {exc}") from exc
    snapshot = contract.get("recoveryPolicy", {}).get("runtimeSnapshot")
    if not isinstance(snapshot, dict):
        raise FinalizeError("test_state", "contract runtimeSnapshot is invalid")
    runtime_relative = safe_relative(snapshot.get("relativePath"), "runtimeSnapshot.relativePath")
    expected = {
        "version": snapshot.get("stateVersion"),
        "mode": "test",
        "statePath": str(state_path),
        "scryRepo": str(SCRY_REPO),
        "runtimeRoot": str((run_root / runtime_relative).resolve()),
        "userDataDir": str((run_root / "scry-test-user-data").resolve()),
    }
    actual = {key: state.get(key) if isinstance(state, dict) else None for key in expected}
    status = state.get("status") if isinstance(state, dict) else None
    launch_id = state.get("launchId") if isinstance(state, dict) else None
    pid = state.get("pid") if isinstance(state, dict) else None
    port = state.get("port") if isinstance(state, dict) else None
    valid = bool(
        isinstance(state, dict)
        and actual == expected
        and status in {"starting", "running", "failed", "stopping", "stopped", "stale"}
        and isinstance(launch_id, str)
        and launch_id
        and type(pid) is int
        and pid > 0
        and type(port) is int
        and 1024 <= port <= 65535
    )
    app_path = state.get("appPath") if isinstance(state, dict) else None
    allowed_app_paths = {
        (run_root / "Scry Test.app").resolve(),
        (SCRY_REPO / "node_modules" / "electron" / "dist" / "Electron.app").resolve(),
    }
    if app_path is not None and Path(str(app_path)).resolve() not in allowed_app_paths:
        valid = False
    if not valid:
        raise FinalizeError(
            "test_state",
            "test App state does not match the schema-5+ owned runtime identity",
            {"expected": expected, "actual": actual, "status": status},
        )
    return state


def scan_run_root_processes(run_root: Path, contract: dict[str, Any]) -> dict[str, Any]:
    snapshot = contract.get("recoveryPolicy", {}).get("runtimeSnapshot", {})
    runtime_relative = safe_relative(snapshot.get("relativePath"), "runtimeSnapshot.relativePath")
    indicators = (
        f"--user-data-dir={run_root / 'scry-test-user-data'}",
        str(run_root / "Scry Test.app" / "Contents" / "MacOS" / "Electron"),
        str(run_root / runtime_relative),
    )
    try:
        result = subprocess.run(
            ["ps", "-axo", "pid=,command="],
            text=True,
            encoding="utf-8",
            errors="replace",
            capture_output=True,
            timeout=30,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise FinalizeError("process_scan", f"cannot inspect processes for missing launch state: {exc}") from exc
    if result.returncode != 0:
        raise FinalizeError("process_scan", "cannot prove a missing-state run has no live Test App")
    excluded = {os.getpid(), os.getppid()}
    matches: list[dict[str, Any]] = []
    for line in result.stdout.splitlines():
        match = line.strip().split(maxsplit=1)
        if len(match) != 2 or not match[0].isdigit():
            continue
        pid = int(match[0])
        command = match[1]
        if pid in excluded or str(run_root) not in command:
            continue
        reasons = [indicator for indicator in indicators if indicator in command]
        if reasons:
            matches.append({"pid": pid, "matchedIdentityFields": reasons})
    return {"ok": not matches, "matchingProcesses": matches}


def quarantine_prelaunch_residue(run_root: Path, contract: dict[str, Any]) -> list[dict[str, str]]:
    snapshot = contract.get("recoveryPolicy", {}).get("runtimeSnapshot", {})
    runtime_relative = safe_relative(snapshot.get("relativePath"), "runtimeSnapshot.relativePath")
    candidates = [
        run_root / runtime_relative,
        run_root / "scry-test-user-data",
        run_root / "Scry Test.app",
        run_root / "scry-test.log",
        run_root / "test-scry-state.json",
    ]
    candidates.extend(sorted(run_root.glob("test-scry-state.json.tmp-*")))
    candidates.append(run_root / "test-scry-state.json.stop.lock")
    existing = [path for path in candidates if os.path.lexists(path)]
    if not existing:
        return []
    for path in existing:
        if path.is_symlink():
            raise FinalizeError("prelaunch_quarantine", f"refusing to move symlinked prelaunch residue: {path}")
        try:
            path.resolve().relative_to(run_root)
        except ValueError as exc:
            raise FinalizeError("prelaunch_quarantine", f"prelaunch residue escapes run root: {path}") from exc
    quarantine = run_root / "pre-send-recovery" / f"prelaunch-{os.getpid()}-{int(datetime.now().timestamp() * 1_000_000)}"
    quarantine.mkdir(parents=True, mode=0o700)
    moved: list[dict[str, str]] = []
    for source in existing:
        relative = source.relative_to(run_root)
        destination = quarantine / relative
        destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        source.replace(destination)
        moved.append({"source": str(source), "destination": str(destination)})
    write_json_atomic(quarantine / "manifest.json", {
        "schemaVersion": 1,
        "recoveredAt": now(),
        "moved": moved,
    })
    return moved


def confirm_terminal_status(status: dict[str, Any]) -> None:
    expected = {
        "status": {"stopped", "stale"},
        "processAlive": False,
        "cdpClosed": True,
        "ownedRendererReady": False,
        "windowTitleLabeled": False,
    }
    problems: dict[str, Any] = {}
    if status.get("status") not in expected["status"]:
        problems["status"] = status.get("status")
    for key in ("processAlive", "cdpClosed", "ownedRendererReady", "windowTitleLabeled"):
        if status.get(key) is not expected[key]:
            problems[key] = status.get(key)
    if problems:
        raise FinalizeError(
            "test_status",
            "owned Test App did not reach a proven stopped/stale terminal state",
            {"expected": expected, "actual": problems},
        )


def require_executable(candidate: Path) -> str:
    """Return the live `--version` of a runnable recorder CLI.

    Version parity with the frozen run is deliberately NOT checked here:
    cleanup always uses the CLI currently installed under the stable prefix,
    so an upgraded recorder must not strand old retained sites. The live
    version is disclosed for the record.
    """
    try:
        completed = subprocess.run(
            [str(candidate), "--version"],
            text=True,
            encoding="utf-8",
            errors="replace",
            capture_output=True,
            timeout=30,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise FinalizeError("scry_bin", f"cannot execute recorder CLI: {exc}") from exc
    actual_lines = (completed.stdout or completed.stderr).strip().splitlines()
    actual_version = actual_lines[-1].strip() if actual_lines else None
    if completed.returncode != 0 or not actual_version:
        raise FinalizeError("scry_bin", f"recorder CLI --version failed: {actual_version!r}")
    return actual_version


def frozen_scry_bin(frozen: dict[str, Any], supplied: str | None) -> tuple[Path, str]:
    versions = frozen.get("versions", {})
    frozen_version = versions.get("scry", {}).get("package")
    if not (isinstance(frozen_version, str) and frozen_version):
        raise FinalizeError("scry_bin", "frozen preflight has no recorder source version")
    current_contract = json.loads(contract_bytes())
    recorder = current_contract.get("recoveryPolicy", {}).get("recorder", {})
    prefix = Path(str(recorder.get("installPrefix", ""))).expanduser().resolve()
    package_name = recorder.get("package")
    package_root = prefix / "lib" / "node_modules" / str(package_name)
    binary = prefix / "bin" / "scry"
    if not binary.is_file() or not os.access(binary, os.X_OK):
        raise FinalizeError("scry_bin", f"stable prefix recorder CLI is not executable: {binary}")
    candidate = binary.resolve()
    try:
        candidate.relative_to(package_root)
        inside_package = True
    except ValueError:
        inside_package = False
    if not inside_package:
        raise FinalizeError("scry_bin", f"recorder CLI is outside the configured package root: {candidate}")
    package_json = package_root / "package.json"
    try:
        installed_package = read_json(package_json)
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise FinalizeError("scry_bin", f"installed recorder package identity is unreadable: {package_json}: {exc}") from exc
    if not (isinstance(installed_package, dict) and installed_package.get("name") == package_name):
        raise FinalizeError("scry_bin", f"installed recorder package identity mismatch: {package_root}")
    if supplied is not None:
        supplied_path = Path(supplied).expanduser()
        if not supplied_path.is_absolute() or supplied_path.resolve() != candidate:
            raise FinalizeError(
                "scry_bin",
                f"--scry-bin does not match the stable prefix recorder CLI: {supplied_path} != {candidate}",
            )
    live_version = require_executable(candidate)
    return candidate, live_version


def restore_slot_lock(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(value, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
    except Exception:
        path.unlink(missing_ok=True)
        raise


def prepared_archive_value(
    path: Path,
    provider: str,
    run_root: Path,
    decision: dict[str, Any],
) -> dict[str, Any] | None:
    if not os.path.lexists(path):
        return None
    if path.is_symlink() or not path.is_file():
        raise FinalizeError("prepared_archive", f"prepared archive journal is unsafe: {path}")
    try:
        value = read_json(path)
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise FinalizeError("prepared_archive", f"prepared archive journal is unreadable: {path}: {exc}") from exc
    boundary = value.get("cleanupBoundary") if isinstance(value, dict) else None
    if not (
        isinstance(value, dict)
        and value.get("schemaVersion") == 1
        and value.get("state") == "PRE_SEND_ARCHIVE_PREPARED"
        and value.get("provider") == provider
        and value.get("runRoot") == str(run_root)
        and isinstance(boundary, dict)
        and boundary.get("frozenSchemaVersion") == decision.get("frozenSchemaVersion")
        and boundary.get("frozenSha256") == decision.get("frozenSha256")
        and boundary.get("sendIntentPath") == decision.get("sendIntentPath")
        and isinstance(value.get("slotLock"), dict)
        and value["slotLock"].get("runRoot") == str(run_root)
        and value["slotLock"].get("provider") == provider
    ):
        raise FinalizeError("prepared_archive", f"prepared archive journal identity is invalid: {path}")
    return value


def recover_prepared_archive(
    provider: str,
    run_root: Path,
    decision: dict[str, Any],
    contract: dict[str, Any],
) -> dict[str, Any] | None:
    journal_path = run_root / PREPARED_ARCHIVE_NAME
    value = prepared_archive_value(journal_path, provider, run_root, decision)
    if value is None:
        return None
    lock_path = slot_lock_path(provider, contract)
    if os.path.lexists(lock_path):
        if lock_path.is_symlink() or not lock_path.is_file():
            raise FinalizeError("prepared_archive", f"Provider slot lock is unsafe during recovery: {lock_path}")
        existing = read_json(lock_path)
        if not isinstance(existing, dict) or existing.get("runRoot") != str(run_root) or existing.get("provider") != provider:
            raise FinalizeError("prepared_archive", f"Provider slot lock changed during prepared recovery: {existing}")
        restored = False
    else:
        restore_slot_lock(lock_path, value["slotLock"])
        restored = True
    journal_path.unlink()
    return {"journal": str(journal_path), "slotLockRestored": restored}


def discard_completed_prepared_archive(
    provider: str,
    run_root: Path,
    decision: dict[str, Any],
) -> None:
    path = run_root / PREPARED_ARCHIVE_NAME
    value = prepared_archive_value(path, provider, run_root, decision)
    if value is not None:
        path.unlink()


def completed_lifecycle(
    path: Path,
    provider: str,
    run_root: Path,
    decision: dict[str, Any],
    contract: dict[str, Any],
) -> dict[str, Any] | None:
    """Recognize only a previously completed transaction for this exact run."""
    if path.is_symlink() or not path.is_file():
        return None
    try:
        value = read_json(path)
    except (OSError, UnicodeError, json.JSONDecodeError):
        return None
    boundary = value.get("cleanupBoundary") if isinstance(value, dict) else None
    if (
        not isinstance(value, dict)
        or value.get("ok") is not True
        or value.get("status") != "PRE_SEND_ARCHIVED"
        or value.get("provider") != provider
        or value.get("runRoot") != str(run_root)
        or not isinstance(boundary, dict)
        or boundary.get("frozenSchemaVersion") != decision.get("frozenSchemaVersion")
        or boundary.get("frozenSha256") != decision.get("frozenSha256")
        or boundary.get("sendIntentPath") != decision.get("sendIntentPath")
    ):
        return None
    lock_path = slot_lock_path(provider, contract)
    if os.path.lexists(lock_path):
        return None
    manifest_path = run_root / "workspace-cleanup-after" / "manifest.json"
    if manifest_path.is_symlink() or not manifest_path.is_file():
        return None
    try:
        manifest = read_json(manifest_path)
    except (OSError, UnicodeError, json.JSONDecodeError):
        return None
    if (
        not isinstance(manifest, dict)
        or manifest.get("ok") is not True
        or manifest.get("phase") != "after"
        or manifest.get("provider") != provider
    ):
        return None
    return {**value, "idempotent": True}


def finalize(provider: str, run_root: Path, supplied_scry_bin: str | None) -> dict[str, Any]:
    current_raw = contract_bytes()
    current_contract = json.loads(current_raw)
    preflight_path, frozen, preflight_error = baseline_preflight(run_root)
    decision = classify_frozen_contract(
        run_root,
        frozen,
        current_contract,
        current_raw,
        preflight_error,
    )
    lifecycle_path = run_root / LIFECYCLE_NAME

    try:
        with lifecycle_gate(current_contract):
            browser_lock = release_owned_browser_lock(provider, run_root, current_contract)
    except (FinalizeError, OSError, ValueError, json.JSONDecodeError) as exc:
        stage = exc.stage if isinstance(exc, FinalizeError) else "browser_lock"
        owner_handoff = mark_slot_finalize_failed(provider, run_root, current_contract)
        failure = lifecycle_record(
            "CLEANUP_FAILED",
            provider,
            run_root,
            decision,
            ok=False,
            mutationPerformed=False,
            failedAt=now(),
            stage=stage,
            error=str(exc),
            slotLockRetained=slot_lock_path(provider, current_contract).is_file(),
            ownerHandoff=owner_handoff,
        )
        write_json_atomic(lifecycle_path, failure)
        return failure

    if not decision["eligible"]:
        retained_stage = (
            decision["status"]
            if decision["status"] in {"RETAINED_FOR_REVIEW", "RETAINED_DRAFT"}
            else None
        )
        gate = lifecycle_gate(current_contract) if retained_stage else nullcontext()
        with gate:
            owner_stage = None
            if retained_stage:
                lock_path, lock_value = require_slot_lock(provider, run_root, current_contract)
                lock_value = update_slot_owner_locked(
                    lock_path,
                    lock_value,
                    provider,
                    run_root,
                    retained_stage,
                )
                owner_stage = lock_value.get("ownerStage")
            if lifecycle_path.is_symlink():
                raise ValueError(f"lifecycle evidence is a symlink: {lifecycle_path}")
            if lifecycle_path.is_file():
                try:
                    existing = read_json(lifecycle_path)
                except (OSError, json.JSONDecodeError):
                    existing = None
                existing_state = (
                    existing.get("state") or existing.get("status")
                    if isinstance(existing, dict) else None
                )
                if (
                    isinstance(existing, dict)
                    and existing.get("provider") == provider
                    and existing.get("runRoot") == str(run_root)
                    and existing_state in {
                        "RETAINED_FOR_REVIEW",
                        "RETAINED_DRAFT",
                        "RETAINED_LEGACY",
                        "PRE_SEND_ARCHIVED",
                        "CLEANUP_FAILED",
                    }
                ):
                    return {**existing, "ownerStage": owner_stage, "idempotent": True}
            result = lifecycle_record(
                decision["status"],
                provider,
                run_root,
                decision,
                ok=True,
                mutationPerformed=False,
                reason=decision["reason"],
                preflightPath=str(preflight_path) if preflight_path else None,
                browserLock=browser_lock,
                ownerStage=owner_stage,
            )
            write_json_atomic(lifecycle_path, result)
            return result

    if not isinstance(frozen, dict):
        raise AssertionError("eligible cleanup must have a frozen preflight")
    previous = completed_lifecycle(
        lifecycle_path,
        provider,
        run_root,
        decision,
        current_contract,
    )
    if previous is not None:
        with lifecycle_gate(current_contract):
            discard_completed_prepared_archive(provider, run_root, decision)
        return previous
    evidence: dict[str, Any] = {
        "preflightPath": str(preflight_path),
        "browserLock": browser_lock,
    }

    try:
        with lifecycle_gate(current_contract):
            gate_completed = completed_lifecycle(
                lifecycle_path,
                provider,
                run_root,
                decision,
                current_contract,
            )
            if gate_completed is not None:
                discard_completed_prepared_archive(provider, run_root, decision)
                return gate_completed
            prepared_recovery = recover_prepared_archive(provider, run_root, decision, current_contract)
            if prepared_recovery is not None:
                evidence["preparedArchiveRecovery"] = prepared_recovery
            lock_path, lock_value = require_slot_lock(provider, run_root, current_contract)
            lock_value = update_slot_owner_locked(
                lock_path,
                lock_value,
                provider,
                run_root,
                "FINALIZING",
            )
            evidence["slotLock"] = {"path": str(lock_path), "claimedAt": lock_value.get("claimedAt")}
            intent_path = Path(str(decision["sendIntentPath"]))
            if os.path.lexists(intent_path):
                lock_value = update_slot_owner_locked(
                    lock_path,
                    lock_value,
                    provider,
                    run_root,
                    "RETAINED_FOR_REVIEW",
                )
                retained_decision = {
                    **decision,
                    "eligible": False,
                    "status": "RETAINED_FOR_REVIEW",
                    "reason": "turn-1 send intent appeared before cleanup; delivery may have occurred",
                }
                retained = lifecycle_record(
                    "RETAINED_FOR_REVIEW",
                    provider,
                    run_root,
                    retained_decision,
                    ok=True,
                    mutationPerformed=False,
                    reason=retained_decision["reason"],
                    preflightPath=str(preflight_path) if preflight_path else None,
                    evidence=evidence,
                    ownerStage=lock_value.get("ownerStage"),
                )
                write_json_atomic(lifecycle_path, retained)
                return retained
            draft_path = Path(str(decision["draftEvidencePath"]))
            if os.path.lexists(draft_path):
                lock_value = update_slot_owner_locked(
                    lock_path,
                    lock_value,
                    provider,
                    run_root,
                    "RETAINED_DRAFT",
                )
                retained_draft = lifecycle_record(
                    "RETAINED_DRAFT",
                    provider,
                    run_root,
                    decision,
                    ok=True,
                    mutationPerformed=False,
                    reason="turn-1 draft evidence appeared before cleanup; the scene is retained for manual review",
                    preflightPath=str(preflight_path) if preflight_path else None,
                    evidence=evidence,
                    ownerStage=lock_value.get("ownerStage"),
                )
                write_json_atomic(lifecycle_path, retained_draft)
                return retained_draft
            state_path = run_root / "test-scry-state.json"
            try:
                state = validate_launch_state(state_path, run_root, current_contract)
            except FinalizeError as exc:
                if exc.stage != "test_state" or state_path.is_symlink() or not os.path.lexists(state_path):
                    raise
                process_scan = scan_run_root_processes(run_root, current_contract)
                evidence["invalidStateProcessScan"] = process_scan
                if process_scan["matchingProcesses"]:
                    raise FinalizeError(
                        "process_scan",
                        "invalid launch state has a matching live Test App process",
                        process_scan,
                    ) from exc
                evidence["quarantinedPrelaunchResidue"] = quarantine_prelaunch_residue(
                    run_root, current_contract
                )
                state = None
            if state is None:
                process_scan = scan_run_root_processes(run_root, current_contract)
                evidence["missingStateProcessScan"] = process_scan
                if process_scan["matchingProcesses"]:
                    raise FinalizeError(
                        "process_scan",
                        "missing launch state has a matching live Test App process",
                        process_scan,
                    )
                evidence.setdefault(
                    "quarantinedPrelaunchResidue",
                    quarantine_prelaunch_residue(run_root, current_contract),
                )
            else:
                stop = run_json(
                    ["node", str(SCRIPT_DIR / "test_scry_app.mjs"), "stop", "--run-root", str(run_root)],
                    "test_stop",
                    90,
                )
                status = run_json(
                    ["node", str(SCRIPT_DIR / "test_scry_app.mjs"), "status", "--run-root", str(run_root)],
                    "test_status",
                    30,
                )
                confirm_terminal_status(status)
                evidence["testApp"] = {
                    "launchId": stop.get("launchId"),
                    "status": status.get("status"),
                    "processAlive": status.get("processAlive"),
                    "cdpClosed": status.get("cdpClosed"),
                }

            # The after-cleanup requires a terminal authorization while the
            # terminal PRE_SEND_ARCHIVED record can only replace it after
            # sanitize and release both succeed, so persist the lexical
            # boundary as a prepared lifecycle before sanitizing. Runs with a
            # send intent or draft evidence already returned above, so this
            # only replaces a missing or previously failed finalize record.
            prepared_lifecycle_value = lifecycle_record(
                "PRE_SEND_ARCHIVE_PREPARED",
                provider,
                run_root,
                decision,
                ok=True,
                mutationPerformed=False,
                preparedAt=now(),
                reason="pre-send archive prepared; the terminal record follows sanitize and release",
                evidence=evidence,
            )
            write_json_atomic(lifecycle_path, prepared_lifecycle_value)
            evidence["preparedLifecycle"] = {"path": str(lifecycle_path)}

            sanitize_command = [
                sys.executable,
                str(SCRIPT_DIR / "sanitize_workspace.py"),
                "--provider",
                provider,
                "--run-root",
                str(run_root),
                "--phase",
                "after",
            ]
            recorder_state = workspace_for(provider, current_contract) / ".scry"
            if os.path.lexists(recorder_state):
                scry_bin, scry_bin_live = frozen_scry_bin(frozen, supplied_scry_bin)
                evidence["scryBin"] = str(scry_bin)
                evidence["scryBinLiveVersion"] = scry_bin_live
                sanitize_command.extend(["--scry-bin", str(scry_bin)])
            else:
                evidence["scryBin"] = None
                evidence["scryBinReason"] = "no workspace .scry state"
            sanitize = run_json(
                sanitize_command,
                "sanitize_after",
                1800,
            )
            evidence["sanitizeAfter"] = {
                "manifest": str(run_root / "workspace-cleanup-after" / "manifest.json"),
                "attemptRoot": sanitize.get("attemptRoot"),
                "idempotent": sanitize.get("idempotent", False),
            }

            expected_release = {
                "ok": True,
                "alreadyReleased": False,
                "path": str(lock_path),
            }
            evidence["slotRelease"] = expected_release

            completed = lifecycle_record(
                "PRE_SEND_ARCHIVED",
                provider,
                run_root,
                decision,
                ok=True,
                mutationPerformed=True,
                completedAt=now(),
                evidence=evidence,
            )
            prepared_archive_path = run_root / PREPARED_ARCHIVE_NAME
            write_json_atomic(prepared_archive_path, {
                "schemaVersion": 1,
                "state": "PRE_SEND_ARCHIVE_PREPARED",
                "provider": provider,
                "runRoot": str(run_root),
                "preparedAt": now(),
                "cleanupBoundary": completed["cleanupBoundary"],
                "slotLock": lock_value,
            })
            prepared_lifecycle = prepare_json_atomic(lifecycle_path, completed)
            try:
                try:
                    release = run_json(
                        [
                            sys.executable,
                            str(SCRIPT_DIR / "fixed_workspace.py"),
                            "release",
                            "--provider",
                            provider,
                            "--run-root",
                            str(run_root),
                        ],
                        "slot_release",
                        120,
                    )
                    if any(release.get(key) != value for key, value in expected_release.items()):
                        raise FinalizeError(
                            "slot_release",
                            "Provider slot release returned unexpected evidence",
                            {"expected": expected_release, "actual": release},
                        )
                    prepared_lifecycle.replace(lifecycle_path)
                    prepared_archive_path.unlink()
                except BaseException:
                    if not os.path.lexists(lock_path):
                        restore_slot_lock(lock_path, lock_value)
                    raise
            finally:
                prepared_lifecycle.unlink(missing_ok=True)
            if lock_path.exists() or lock_path.is_symlink():
                raise FinalizeError("slot_release", f"Provider slot lock still exists after release: {lock_path}")
            return completed
    except (FinalizeError, OSError, ValueError, json.JSONDecodeError) as exc:
        stage = exc.stage if isinstance(exc, FinalizeError) else "finalize"
        details = exc.details if isinstance(exc, FinalizeError) else None
        owner_handoff = mark_slot_finalize_failed(provider, run_root, current_contract)
        failure = lifecycle_record(
            "CLEANUP_FAILED",
            provider,
            run_root,
            decision,
            ok=False,
            mutationPerformed=True,
            failedAt=now(),
            stage=stage,
            error=str(exc),
            details=details,
            evidence=evidence,
            slotLockRetained=slot_lock_path(provider, current_contract).is_file(),
            ownerHandoff=owner_handoff,
        )
        try:
            write_json_atomic(lifecycle_path, failure)
        except OSError:
            pass
        return failure


def self_test() -> int:
    global lifecycle_gate, slot_lock_path, workspace_for, require_executable
    with tempfile.TemporaryDirectory() as raw:
        root = Path(raw)
        run_root = root / f"{RUN_PREFIX}fixture"
        run_root.mkdir()
        current = {
            "schemaVersion": 5,
            "retention": {
                "autoCleanupBeforeFirstPrompt": True,
                "sendIntentEvidence": "turn1-send-intent.json",
                "draftEvidence": "turn1-draft.json",
            },
        }
        current_raw = json.dumps(current, sort_keys=True).encode()
        frozen = {
            "ok": True,
            "contractSchemaVersion": 5,
            "contract": {"schemaVersion": 5, "sha256": contract_hash(current_raw)},
        }
        eligible = classify_frozen_contract(run_root, frozen, current, current_raw)
        assert eligible["eligible"] is True
        assert eligible["status"] == "PRE_SEND_CLEANUP_REQUIRED"

        (run_root / "turn1-draft.json").write_text('{"status":"drafted"}\n', encoding="utf-8")
        post_draft = classify_frozen_contract(run_root, frozen, current, current_raw)
        assert post_draft["eligible"] is False
        assert post_draft["status"] == "RETAINED_DRAFT"
        (run_root / "turn1-draft.json").unlink()

        (run_root / "turn1-send-intent.json").write_text('{"status":"prepared"}\n', encoding="utf-8")
        post_send = classify_frozen_contract(run_root, frozen, current, current_raw)
        assert post_send["eligible"] is False
        assert post_send["status"] == "RETAINED_FOR_REVIEW"
        (run_root / "turn1-send-intent.json").unlink()

        legacy = {
            "ok": True,
            "contractSchemaVersion": 3,
            "contract": {"schemaVersion": 3, "sha256": "sha256:legacy"},
        }
        legacy_decision = classify_frozen_contract(run_root, legacy, current, current_raw)
        assert legacy_decision["eligible"] is False
        assert legacy_decision["status"] == "RETAINED_LEGACY"

        unknown = {
            "ok": True,
            "contractSchemaVersion": 5,
            "contract": {"schemaVersion": 5, "sha256": "sha256:unknown"},
        }
        unknown_decision = classify_frozen_contract(run_root, unknown, current, current_raw)
        assert unknown_decision["eligible"] is False
        assert unknown_decision["status"] == "RETAINED_LEGACY"

        failed = {
            "ok": False,
            "contractSchemaVersion": 5,
            "contract": {"schemaVersion": 5, "sha256": contract_hash(current_raw)},
        }
        failed_decision = classify_frozen_contract(run_root, failed, current, current_raw)
        assert failed_decision["eligible"] is False
        assert failed_decision["status"] == "RETAINED_LEGACY"

        cli_fixture = root / "scry-fixture"
        cli_fixture.write_text("#!/bin/sh\nprintf '1.2.3\\n'\n", encoding="utf-8")
        cli_fixture.chmod(0o700)
        assert require_executable(cli_fixture) == "1.2.3"
        # 版本差异不再是闸门：升级后的 CLI 必须能清理旧现场，只披露 live 版本
        cli_fixture.write_text("#!/bin/sh\nprintf '9.9.9\\n'\n", encoding="utf-8")
        assert require_executable(cli_fixture) == "9.9.9"
        cli_fixture.write_text("#!/bin/sh\nexit 3\n", encoding="utf-8")
        try:
            require_executable(cli_fixture)
            raise AssertionError("a failing recorder CLI --version was accepted")
        except FinalizeError as exc:
            assert exc.stage == "scry_bin"

        invalid_state = run_root / "test-scry-state.json"
        invalid_state.write_bytes(b"\xff")
        state_contract = {
            "recoveryPolicy": {
                "runtimeSnapshot": {"relativePath": "scry-runtime", "stateVersion": 3},
            },
        }
        try:
            validate_launch_state(invalid_state, run_root, state_contract)
            raise AssertionError("non-UTF-8 launch state was accepted")
        except FinalizeError as exc:
            assert exc.stage == "test_state"
        valid_state = {
            "version": 3,
            "mode": "test",
            "statePath": str(invalid_state),
            "scryRepo": str(SCRY_REPO),
            "runtimeRoot": str((run_root / "scry-runtime").resolve()),
            "userDataDir": str((run_root / "scry-test-user-data").resolve()),
            "status": "running",
            "launchId": "fixture-launch",
            "pid": 123,
            "port": 12345,
            "appPath": str((SCRY_REPO / "node_modules/electron/dist/Electron.app").resolve()),
        }
        invalid_state.write_text(json.dumps(valid_state), encoding="utf-8")
        assert validate_launch_state(invalid_state, run_root, state_contract) == valid_state
        valid_state["appPath"] = str(root / "outside.app")
        invalid_state.write_text(json.dumps(valid_state), encoding="utf-8")
        try:
            validate_launch_state(invalid_state, run_root, state_contract)
            raise AssertionError("unowned Electron app path was accepted")
        except FinalizeError as exc:
            assert exc.stage == "test_state"
        invalid_state.unlink()

        race_run = root / f"{RUN_PREFIX}intent-race"
        race_run.mkdir()
        current_contract_raw = contract_bytes()
        current_contract = json.loads(current_contract_raw)
        current_schema = current_contract["schemaVersion"]
        (race_run / "preflight.json").write_text(json.dumps({
            "ok": True,
            "contractSchemaVersion": current_schema,
            "contract": {
                "schemaVersion": current_schema,
                "sha256": contract_hash(current_contract_raw),
            },
        }), encoding="utf-8")
        race_lock = root / "race-slot-lock.json"
        race_lock.write_text(json.dumps({
            "schemaVersion": 2,
            "scope": "slot:codex",
            "provider": "codex",
            "runRoot": str(race_run),
            "claimedAt": now(),
            "ownerId": "fixture-owner",
            "ownerState": "ACTIVE",
            "ownerStage": "BOOTSTRAP_READY",
            "heartbeatAt": now(),
        }), encoding="utf-8")
        gate_entries = 0
        original_gate = lifecycle_gate
        original_slot_lock_path = slot_lock_path

        @contextmanager
        def intent_race_gate(contract: dict[str, Any]) -> Any:
            nonlocal gate_entries
            gate_entries += 1
            if gate_entries == 2:
                (race_run / "turn1-send-intent.json").write_text(
                    '{"status":"prepared"}\n', encoding="utf-8"
                )
            yield

        try:
            lifecycle_gate = intent_race_gate
            slot_lock_path = lambda provider, contract: race_lock
            retained = finalize("codex", race_run, None)
        finally:
            lifecycle_gate = original_gate
            slot_lock_path = original_slot_lock_path
        assert retained["status"] == "RETAINED_FOR_REVIEW"
        assert retained["mutationPerformed"] is False
        assert race_lock.is_file()
        assert not (race_run / "workspace-cleanup-after" / "manifest.json").exists()
        assert read_json(race_run / LIFECYCLE_NAME) == retained

        completed_run = root / f"{RUN_PREFIX}completed-race"
        completed_run.mkdir()
        (completed_run / "preflight.json").write_text(json.dumps({
            "ok": True,
            "contractSchemaVersion": current_schema,
            "contract": {
                "schemaVersion": current_schema,
                "sha256": contract_hash(current_contract_raw),
            },
        }), encoding="utf-8")
        completed_decision = classify_frozen_contract(
            completed_run,
            read_json(completed_run / "preflight.json"),
            current_contract,
            current_contract_raw,
        )
        completed_lifecycle_value = lifecycle_record(
            "PRE_SEND_ARCHIVED",
            "codex",
            completed_run,
            completed_decision,
            ok=True,
            mutationPerformed=True,
        )
        write_json_atomic(completed_run / LIFECYCLE_NAME, completed_lifecycle_value)
        write_json_atomic(completed_run / "workspace-cleanup-after" / "manifest.json", {
            "schemaVersion": 2,
            "ok": True,
            "phase": "after",
            "provider": "codex",
        })
        completed_lock = root / "completed-slot-lock.json"
        completed_lock.write_text(json.dumps({
            "provider": "codex",
            "runRoot": str(completed_run),
        }), encoding="utf-8")
        completed_gate_entries = 0

        @contextmanager
        def completed_race_gate(contract: dict[str, Any]) -> Any:
            nonlocal completed_gate_entries
            completed_gate_entries += 1
            if completed_gate_entries == 2:
                completed_lock.unlink()
            yield

        try:
            lifecycle_gate = completed_race_gate
            slot_lock_path = lambda provider, contract: completed_lock
            completed_again = finalize("codex", completed_run, None)
        finally:
            lifecycle_gate = original_gate
            slot_lock_path = original_slot_lock_path
        assert completed_again["status"] == "PRE_SEND_ARCHIVED"
        assert completed_again["idempotent"] is True
        assert read_json(completed_run / LIFECYCLE_NAME) == completed_lifecycle_value

        failure_run = root / f"{RUN_PREFIX}scry-bin-failure"
        failure_run.mkdir()
        (failure_run / "preflight.json").write_text(json.dumps({
            "ok": True,
            "contractSchemaVersion": current_schema,
            "contract": {
                "schemaVersion": current_schema,
                "sha256": contract_hash(current_contract_raw),
            },
            "versions": {
                "scry": {"package": "1.2.3"},
                "rateNative": {
                    "cliPath": str(failure_run / "missing-scry"),
                    "cliVersion": "1.2.3",
                },
            },
        }), encoding="utf-8")
        fake_lock = root / "slot-lock.json"
        fake_lock.write_text(json.dumps({
            "provider": "codex",
            "runRoot": str(failure_run),
            "claimedAt": "fixture",
        }), encoding="utf-8")

        original_gate = lifecycle_gate
        original_slot_lock_path = slot_lock_path
        original_workspace_for = workspace_for
        original_require_executable = require_executable
        failure_workspace = root / "failure-workspace"
        (failure_workspace / ".scry").mkdir(parents=True)

        @contextmanager
        def fixture_gate(contract: dict[str, Any]) -> Any:
            yield

        # 冻结 cliPath 指向缺失路径不再阻塞清理（统一解析当前 stable prefix 最新 CLI）；
        # 可执行性仍是闸门：--version 失败即清理失败
        def broken_recorder_cli(candidate: Path) -> str:
            raise FinalizeError("scry_bin", f"recorder CLI --version failed: {candidate}")

        try:
            lifecycle_gate = fixture_gate
            slot_lock_path = lambda provider, contract: fake_lock
            workspace_for = lambda provider, contract: failure_workspace
            require_executable = broken_recorder_cli
            failure = finalize("codex", failure_run, None)
        finally:
            lifecycle_gate = original_gate
            slot_lock_path = original_slot_lock_path
            workspace_for = original_workspace_for
            require_executable = original_require_executable
        assert failure["status"] == "CLEANUP_FAILED"
        assert failure["stage"] == "scry_bin"
        assert failure["slotLockRetained"] is True
        assert fake_lock.is_file()
        failed_owner = read_json(fake_lock)
        assert failed_owner["ownerState"] == "INACTIVE"
        assert failed_owner["ownerStage"] == "FINALIZE_FAILED"
        assert read_json(failure_run / LIFECYCLE_NAME) == failure

        draft_run = root / f"{RUN_PREFIX}draft"
        draft_run.mkdir()
        (draft_run / "preflight.json").write_text(json.dumps({
            "ok": True,
            "contractSchemaVersion": current_schema,
            "contract": {
                "schemaVersion": current_schema,
                "sha256": contract_hash(current_contract_raw),
            },
        }), encoding="utf-8")
        clean_draft_decision = classify_frozen_contract(
            draft_run,
            read_json(draft_run / "preflight.json"),
            current_contract,
            current_contract_raw,
        )
        assert clean_draft_decision["eligible"] is True
        assert clean_draft_decision["status"] == "PRE_SEND_CLEANUP_REQUIRED"
        (draft_run / str(current_contract["retention"]["draftEvidence"])).write_text(
            '{"status":"drafted"}\n', encoding="utf-8"
        )
        draft_decision = classify_frozen_contract(
            draft_run,
            read_json(draft_run / "preflight.json"),
            current_contract,
            current_contract_raw,
        )
        assert draft_decision["eligible"] is False
        assert draft_decision["status"] == "RETAINED_DRAFT"

        draft_lock = root / "draft-slot-lock.json"
        draft_lock.write_text(json.dumps({
            "schemaVersion": 2,
            "scope": "slot:codex",
            "provider": "codex",
            "runRoot": str(draft_run),
            "claimedAt": now(),
            "ownerId": "fixture-owner",
            "ownerState": "ACTIVE",
            "ownerStage": "TURN1_DRAFT_PREPARED",
            "heartbeatAt": now(),
        }), encoding="utf-8")

        @contextmanager
        def draft_gate(contract: dict[str, Any]) -> Any:
            yield

        try:
            lifecycle_gate = draft_gate
            slot_lock_path = lambda provider, contract: draft_lock
            retained_draft = finalize("codex", draft_run, None)
        finally:
            lifecycle_gate = original_gate
            slot_lock_path = original_slot_lock_path
        assert retained_draft["status"] == "RETAINED_DRAFT"
        assert retained_draft["mutationPerformed"] is False
        assert retained_draft["ownerStage"] == "RETAINED_DRAFT"
        assert read_json(draft_lock)["ownerStage"] == "RETAINED_DRAFT"
        assert read_json(draft_run / LIFECYCLE_NAME) == retained_draft

        draft_race_run = root / f"{RUN_PREFIX}draft-race"
        draft_race_run.mkdir()
        (draft_race_run / "preflight.json").write_text(json.dumps({
            "ok": True,
            "contractSchemaVersion": current_schema,
            "contract": {
                "schemaVersion": current_schema,
                "sha256": contract_hash(current_contract_raw),
            },
        }), encoding="utf-8")
        race_draft_lock = root / "race-draft-slot-lock.json"
        race_draft_lock.write_text(json.dumps({
            "schemaVersion": 2,
            "scope": "slot:codex",
            "provider": "codex",
            "runRoot": str(draft_race_run),
            "claimedAt": now(),
            "ownerId": "fixture-owner",
            "ownerState": "ACTIVE",
            "ownerStage": "BOOTSTRAP_READY",
            "heartbeatAt": now(),
        }), encoding="utf-8")
        draft_gate_entries = 0

        @contextmanager
        def draft_race_gate(contract: dict[str, Any]) -> Any:
            nonlocal draft_gate_entries
            draft_gate_entries += 1
            if draft_gate_entries == 2:
                (draft_race_run / str(current_contract["retention"]["draftEvidence"])).write_text(
                    '{"status":"drafted"}\n', encoding="utf-8"
                )
            yield

        try:
            lifecycle_gate = draft_race_gate
            slot_lock_path = lambda provider, contract: race_draft_lock
            retained_draft_race = finalize("codex", draft_race_run, None)
        finally:
            lifecycle_gate = original_gate
            slot_lock_path = original_slot_lock_path
        assert retained_draft_race["status"] == "RETAINED_DRAFT"
        assert retained_draft_race["mutationPerformed"] is False
        assert race_draft_lock.is_file()
        assert not (draft_race_run / "workspace-cleanup-after" / "manifest.json").exists()
        assert read_json(draft_race_run / LIFECYCLE_NAME) == retained_draft_race
    print("self-test: PASS")
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--provider")
    parser.add_argument("--run-root")
    parser.add_argument("--scry-bin")
    args = parser.parse_args()
    if not args.self_test and (not args.provider or not args.run_root):
        parser.error("--provider and --run-root are required")
    return args


def main() -> int:
    args = parse_args()
    if args.self_test:
        return self_test()
    raw = contract_bytes()
    contract = json.loads(raw)
    run_root = safe_run_root(args.run_root, contract)
    slot_for(args.provider, contract)
    result = finalize(args.provider, run_root, args.scry_bin)
    emit(result)
    return 0 if result.get("ok") is True else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, RuntimeError, json.JSONDecodeError) as exc:
        emit({"ok": False, "status": "CLEANUP_FAILED", "error": str(exc)})
        sys.exit(1)
