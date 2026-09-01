#!/usr/bin/env python3
"""Manage fixed warm treehouses, bootstrap fingerprints, and validation locks."""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import uuid
from urllib.parse import urlsplit
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


SKILL_DIR = Path(__file__).resolve().parent.parent
CONTRACT_PATH = SKILL_DIR / "references" / "contract.json"
CONTRACT = json.loads(CONTRACT_PATH.read_text(encoding="utf-8"))
FIXED = CONTRACT["fixedTreehouse"]
PROVIDERS = CONTRACT["providers"]
RECOVERY = CONTRACT["recoveryPolicy"]
RECORDER_RECOVERY = RECOVERY["recorder"]
CONFIG_RECOVERY = RECOVERY["config"]
POOL_RECOVERY = RECOVERY["treehousePool"]
RUN_PREFIX = "validate-scry-rate-workflow-"
RUN_ROOT_PARENT = Path(CONTRACT["retention"]["runRootParent"]).expanduser().resolve()
TREEHOUSE_BIN = Path("/opt/homebrew/bin/treehouse")
RECORDER_PACKAGE = str(RECORDER_RECOVERY["package"])
RECORDER_REGISTRY = str(RECORDER_RECOVERY["registry"])
RETENTION = CONTRACT["retention"]
SCRY_REPO = (SKILL_DIR.parents[2] / "scry").resolve()

SLOT_OWNER_ACTIVE_STAGES = {
    "CLAIMED",
    "WORKSPACE_PREPARING",
    "WORKSPACE_PREPARED",
    "BOOTSTRAP_RECONCILING",
    "BOOTSTRAP_READY",
    "TURN1_INTENT_PREPARED",
    "TURN2_INTENT_PREPARED",
    "TURN3_INTENT_PREPARED",
    "TURN1_DRAFT_PREPARED",
    "RETAINED_DRAFT",
    "RETAINED_FOR_REVIEW",
    "FINALIZING",
}
SLOT_OWNER_INACTIVE_STAGES = {"FINALIZE_FAILED", "ABANDONED"}
SLOT_OWNER_STAGES = SLOT_OWNER_ACTIVE_STAGES | SLOT_OWNER_INACTIVE_STAGES


def emit(value: Any) -> None:
    print(json.dumps(value, ensure_ascii=False, indent=2))


def run(
    command: list[str],
    cwd: Path | None = None,
    timeout: int = 120,
    env: dict[str, str] | None = None,
    stdin: int | None = None,
    start_new_session: bool = False,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        cwd=cwd,
        text=True,
        # Tools under init.sh emit locale-encoded messages and raw filename bytes; a
        # single undecodable byte must not take down a bootstrap with an error that
        # carries no diagnostic evidence.
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        timeout=timeout,
        check=False,
        env=env,
        stdin=stdin,
        # Detaching the controlling terminal turns an interactive prompt into an
        # immediate read failure instead of a silent wait for the whole timeout.
        start_new_session=start_new_session,
    )


def porcelain_path(line: str) -> str:
    """The path a `git status --porcelain=v1` entry refers to, rename target included.

    Kept in step with the same helper in `sanitize_workspace.py`: both scripts decide
    whether a fixed workspace is clean, so they must agree on what a nested warm
    repository looks like in the parent's status.
    """
    raw = line[3:] if len(line) > 3 else ""
    if " -> " in raw:
        raw = raw.split(" -> ", 1)[1]
    raw = raw.strip()
    if len(raw) > 1 and raw.startswith('"') and raw.endswith('"'):
        raw = raw[1:-1]
    return raw.rstrip("/")


def under_nested_repository(path: str, nested: frozenset[str]) -> bool:
    """Whether a status path belongs to a nested warm repository rather than the parent.

    A healthy nested repository collapses to a single `rate-doc/` entry because Git will
    not descend into it, but a half-cloned one is a plain directory whose files are
    listed individually. Both are contract-owned territory, so match on the prefix.
    """
    return any(path == item or path.startswith(f"{item}/") for item in nested)


def nested_warm_repositories(workspace: Path) -> frozenset[str]:
    """Contract warm repositories that currently exist inside the fixed workspace."""
    return frozenset(raw for raw in FIXED["warmRepositories"] if (workspace / raw).is_dir())


def workspace_own_changes(workspace: Path) -> list[str]:
    """`git status` entries that belong to the fixed workspace itself.

    A nested warm repository is a single untracked entry in its parent even though it is
    a repository in its own right: 11 of the 12 are listed in the workspace `.gitignore`
    and `rate-doc` is not, so the parent's raw status is not a usable cleanliness verdict.
    Every caller deciding whether the fixed workspace is clean must go through here --
    judging it independently is how the same nested repository ended up blocking
    `sanitize`, then `release`, then `prepare` in turn.
    """
    status = git(["status", "--porcelain=v1", "--untracked-files=all"], workspace)
    if status.returncode != 0:
        raise RuntimeError(status.stderr.strip() or f"git status failed: {workspace}")
    nested = nested_warm_repositories(workspace)
    return [
        line
        for line in status.stdout.splitlines()
        if line.strip() and not under_nested_repository(porcelain_path(line), nested)
    ]


def now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def provider_config(provider: str) -> dict[str, Any]:
    value = PROVIDERS.get(provider)
    if not isinstance(value, dict):
        raise ValueError(f"unsupported provider: {provider}")
    return value


def slot_for(provider: str) -> int:
    value = provider_config(provider).get("treehouseSlot")
    if type(value) is not int or value <= 0:
        raise ValueError(f"provider {provider} has no valid fixed treehouse slot")
    return value


def workspace_for(provider: str) -> Path:
    return (
        Path(FIXED["poolRoot"]).expanduser()
        / str(slot_for(provider))
        / str(FIXED["workspaceName"])
    ).resolve()


def expected_holder(provider: str) -> str:
    return str(FIXED["leaseHolderPrefix"]) + provider


def safe_run_root(raw: str) -> Path:
    path = Path(raw).expanduser().resolve()
    if not path.is_dir() or path.parent != RUN_ROOT_PARENT or not path.name.startswith(RUN_PREFIX):
        raise ValueError(f"run root must be an existing {RUN_ROOT_PARENT}/{RUN_PREFIX}* directory")
    return path


def safe_relative(raw: str) -> Path:
    path = Path(raw)
    if path.is_absolute() or not path.parts or any(part in {"", ".", ".."} for part in path.parts):
        raise ValueError(f"unsafe contract path: {raw!r}")
    return path


def lock_root() -> Path:
    return Path(FIXED["poolRoot"]).expanduser().resolve() / ".validate-scry-rate-workflow" / "locks"


@contextmanager
def lifecycle_gate() -> Any:
    path = lock_root().parent / "lifecycle.lock"
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor = os.open(path, os.O_RDWR | os.O_CREAT, 0o600)
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX)
        yield descriptor
    finally:
        # Close without LOCK_UN: a start-test-app child may inherit this same
        # open-file description and must keep the gate held if the parent dies.
        os.close(descriptor)


def slot_lock_path(provider: str) -> Path:
    return lock_root() / f"slot-{slot_for(provider)}-{provider}.json"


def shared_lock_path(name: str) -> Path:
    if name not in FIXED["sharedLocks"]:
        raise ValueError(f"unsupported shared lock: {name}")
    return lock_root() / f"shared-{name}.json"


def build_marker_path() -> Path:
    return lock_root().parent / "scry-build.json"


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def inspect_cache_marker(path: Path) -> dict[str, Any]:
    if path.is_symlink():
        return {"value": None, "error": "marker is a symlink", "unsafe": True}
    if not path.exists():
        return {"value": None, "error": None, "unsafe": False}
    if not path.is_file():
        return {"value": None, "error": "marker is not a regular file", "unsafe": False}
    try:
        value = read_json(path)
    except (OSError, json.JSONDecodeError) as exc:
        return {"value": None, "error": str(exc), "unsafe": False}
    if not isinstance(value, dict):
        return {"value": None, "error": "marker JSON is not an object", "unsafe": False}
    return {"value": value, "error": None, "unsafe": False}


def quarantine_invalid_marker(path: Path, run_root: Path, category: str) -> dict[str, str] | None:
    inspected = inspect_cache_marker(path)
    if inspected["unsafe"]:
        raise RuntimeError(f"refusing to recover unsafe cache marker: {path}: {inspected['error']}")
    if inspected["error"] is None:
        return None
    destination = run_root / category / path.name
    destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if destination.exists() or destination.is_symlink():
        raise RuntimeError(f"cache marker quarantine already exists: {destination}")
    shutil.move(str(path), str(destination))
    return {
        "source": str(path),
        "destination": str(destination),
        "reason": str(inspected["error"]),
    }


def write_json_exclusive(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(value, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
    except Exception:
        path.unlink(missing_ok=True)
        raise


def claim_lock(
    path: Path,
    scope: str,
    run_root: Path,
    provider: str | None = None,
    *,
    process_owned: bool = False,
) -> dict[str, Any]:
    value = {
        "schemaVersion": 2 if process_owned else 1,
        "scope": scope,
        "provider": provider,
        "runRoot": str(run_root),
        "claimedAt": now(),
    }
    if process_owned:
        value["ownerPid"] = os.getpid()
        value["ownerCommandSha256"] = process_command_sha256(os.getpid())
    try:
        write_json_exclusive(path, value)
    except FileExistsError:
        existing = read_json(path)
        if existing.get("runRoot") != str(run_root):
            raise RuntimeError(f"lock already held: {path} ({existing})")
        if process_owned and (
            existing.get("schemaVersion") != 2
            or existing.get("ownerPid") != value["ownerPid"]
            or existing.get("ownerCommandSha256") != value["ownerCommandSha256"]
        ):
            raise RuntimeError(f"process-owned lock already held by another process: {path} ({existing})")
        return {"ok": True, "idempotent": True, "path": str(path), "lock": existing}
    return {"ok": True, "idempotent": False, "path": str(path), "lock": value}


def slot_owner_status(value: Any, provider: str, run_root: Path) -> dict[str, Any]:
    """Validate the durable owner hand-off without guessing from a short-lived CLI PID."""
    if not isinstance(value, dict):
        return {"valid": False, "active": None, "reason": "slot_lock_not_object"}
    expected = {
        "schemaVersion": 2,
        "scope": f"slot:{provider}",
        "provider": provider,
        "runRoot": str(run_root),
    }
    actual = {key: value.get(key) for key in expected}
    if actual != expected:
        return {
            "valid": False,
            "active": None,
            "reason": "slot_owner_identity_invalid",
            "expected": expected,
            "actual": actual,
        }
    owner_id = value.get("ownerId")
    owner_state = value.get("ownerState")
    owner_stage = value.get("ownerStage")
    heartbeat = value.get("heartbeatAt")
    try:
        parsed_heartbeat = datetime.fromisoformat(str(heartbeat).replace("Z", "+00:00"))
        heartbeat_valid = parsed_heartbeat.tzinfo is not None
    except ValueError:
        heartbeat_valid = False
    active = owner_stage in SLOT_OWNER_ACTIVE_STAGES
    inactive = owner_stage in SLOT_OWNER_INACTIVE_STAGES
    valid = bool(
        isinstance(owner_id, str)
        and owner_id
        and owner_state in {"ACTIVE", "INACTIVE"}
        and owner_stage in SLOT_OWNER_STAGES
        and heartbeat_valid
        and ((owner_state == "ACTIVE" and active) or (owner_state == "INACTIVE" and inactive))
    )
    return {
        "valid": valid,
        "active": active if valid else None,
        "ownerId": owner_id,
        "ownerState": owner_state,
        "ownerStage": owner_stage,
        "heartbeatAt": heartbeat,
        "reason": None if valid else "slot_owner_fields_invalid",
    }


def slot_owner_value(
    provider: str,
    run_root: Path,
    stage: str,
    existing: dict[str, Any] | None = None,
) -> dict[str, Any]:
    if stage not in SLOT_OWNER_STAGES:
        raise ValueError(f"unsupported Provider slot owner stage: {stage}")
    prior = existing if isinstance(existing, dict) else {}
    owner_id = prior.get("ownerId")
    if not isinstance(owner_id, str) or not owner_id:
        owner_id = str(uuid.uuid4())
    return {
        **prior,
        "schemaVersion": 2,
        "scope": f"slot:{provider}",
        "provider": provider,
        "runRoot": str(run_root),
        "claimedAt": prior.get("claimedAt") if isinstance(prior.get("claimedAt"), str) else now(),
        "ownerId": owner_id,
        "ownerState": "ACTIVE" if stage in SLOT_OWNER_ACTIVE_STAGES else "INACTIVE",
        "ownerStage": stage,
        "heartbeatAt": now(),
    }


def refresh_slot_owner_locked(provider: str, run_root: Path, stage: str) -> dict[str, Any]:
    """Refresh a slot owner while the caller holds the shared lifecycle gate."""
    path = slot_lock_path(provider)
    if path.is_symlink() or not path.is_file():
        raise RuntimeError(f"slot lock is missing or unsafe: {path}")
    existing = read_json(path)
    if not isinstance(existing, dict) or existing.get("runRoot") != str(run_root) or existing.get("provider") != provider:
        raise RuntimeError(f"slot lock belongs to another run: {existing}")
    updated = slot_owner_value(provider, run_root, stage, existing)
    write_json_atomic(path, updated)
    return updated


def heartbeat_slot_owner(provider: str, run_root: Path, stage: str) -> dict[str, Any]:
    with lifecycle_gate():
        updated = refresh_slot_owner_locked(provider, run_root, stage)
    return {"ok": True, "path": str(slot_lock_path(provider)), "owner": slot_owner_status(updated, provider, run_root)}


def claim_slot(provider: str, run_root: Path) -> dict[str, Any]:
    path = slot_lock_path(provider)
    if os.path.lexists(path):
        if path.is_symlink() or not path.is_file():
            raise RuntimeError(f"slot lock is unsafe: {path}")
        existing = read_json(path)
        if not isinstance(existing, dict) or existing.get("runRoot") != str(run_root):
            raise RuntimeError(f"lock already held: {path} ({existing})")
        updated = slot_owner_value(provider, run_root, "CLAIMED", existing)
        write_json_atomic(path, updated)
        return {"ok": True, "idempotent": True, "path": str(path), "lock": updated}
    value = slot_owner_value(provider, run_root, "CLAIMED")
    write_json_exclusive(path, value)
    return {"ok": True, "idempotent": False, "path": str(path), "lock": value}


def prepare_send_intent(
    provider: str,
    run_root: Path,
    turn: int,
    payload: dict[str, Any],
) -> dict[str, Any]:
    """Commit the lexical send boundary under the same gate used by the finalizer."""
    if turn not in {1, 2, 3}:
        raise ValueError(f"turn must be 1, 2 or 3, got {turn}")
    if not isinstance(payload, dict):
        raise ValueError("send intent stdin must be a JSON object")
    if not (
        payload.get("schemaVersion") == 1
        and payload.get("status") == "prepared"
        and payload.get("runRoot") == str(run_root)
        and payload.get("provider") == provider
        and payload.get("turn") == turn
        and isinstance(payload.get("launchId"), str)
        and payload.get("launchId")
        and type(payload.get("pid")) is int
        and payload.get("pid") > 0
        and type(payload.get("port")) is int
        and 1024 <= payload.get("port") <= 65535
        and isinstance(payload.get("text"), str)
        and payload.get("text")
        and isinstance(payload.get("localEqualityOnly"), bool)
    ):
        raise ValueError("send intent payload identity is incomplete or inconsistent")
    descriptor = PROVIDERS[provider]
    if turn == 1:
        workitem_id = payload.get("workitemId")
        if not isinstance(workitem_id, str) or not workitem_id.isdigit():
            raise ValueError("turn-one send intent needs a plain numeric workitemId")
        expected_text = f"{descriptor['command']} {workitem_id} {CONTRACT['firstPromptSuffix']}"
        relative = safe_relative(str(RETENTION["sendIntentEvidence"]))
    else:
        if payload.get("workitemId") is not None:
            raise ValueError("later-turn send intent must not carry a workitemId")
        expected_text = str(CONTRACT["secondPrompt"] if turn == 2 else CONTRACT["thirdPrompt"])
        relative = Path(f"turn{turn}-send-intent.json")
    if payload.get("text") != expected_text:
        raise ValueError(f"send intent prompt drifted: expected {expected_text!r}")

    with lifecycle_gate():
        require_slot_lock(provider, run_root)
        lifecycle_path = run_root / "lifecycle.json"
        if os.path.lexists(lifecycle_path):
            if lifecycle_path.is_symlink() or not lifecycle_path.is_file():
                raise RuntimeError(f"lifecycle evidence is unsafe: {lifecycle_path}")
            lifecycle = read_json(lifecycle_path)
            lifecycle_state = lifecycle.get("state") or lifecycle.get("status") if isinstance(lifecycle, dict) else None
            if lifecycle_state in {
                "PRE_SEND_ARCHIVED",
                "PRE_SEND_ABANDONED",
                "CLEANUP_FAILED",
                "RETAINED_LEGACY",
                "RETAINED_DRAFT",
                "RETAINED_FOR_REVIEW",
                "POST_SEND_ABANDONED",
            }:
                raise RuntimeError(f"refusing to send after terminal lifecycle state {lifecycle_state}")
        intent_path = run_root / relative
        if os.path.lexists(intent_path):
            raise RuntimeError(f"send intent already exists; inspect the owned renderer before any retry: {intent_path}")
        owner = read_json(slot_lock_path(provider))
        owner_status = slot_owner_status(owner, provider, run_root)
        if owner_status.get("valid") is True and owner_status.get("active") is False:
            raise RuntimeError(f"Provider slot owner is inactive: {owner_status}")
        write_json_atomic(intent_path, payload)
        updated = refresh_slot_owner_locked(provider, run_root, f"TURN{turn}_INTENT_PREPARED")
    return {
        "ok": True,
        "path": str(intent_path),
        "owner": slot_owner_status(updated, provider, run_root),
    }


def record_draft(provider: str, run_root: Path, payload: dict[str, Any]) -> dict[str, Any]:
    """Commit the draft stop point under the same gate used by the finalizer.

    A draft is the first contract-fixed prompt typed into the composer without
    clicking send: no session is created, but the scene is retained for manual
    review exactly like a post-send one. The draft record doubles as the
    lexical evidence the finalizer uses to classify the run `RETAINED_DRAFT`.
    """
    if not isinstance(payload, dict):
        raise ValueError("draft stdin must be a JSON object")
    if not (
        payload.get("schemaVersion") == 1
        and payload.get("status") == "drafted"
        and payload.get("runRoot") == str(run_root)
        and payload.get("provider") == provider
        and payload.get("turn") == 1
        and isinstance(payload.get("launchId"), str)
        and payload.get("launchId")
        and type(payload.get("pid")) is int
        and payload.get("pid") > 0
        and type(payload.get("port")) is int
        and 1024 <= payload.get("port") <= 65535
        and isinstance(payload.get("text"), str)
        and payload.get("text")
        and isinstance(payload.get("localEqualityOnly"), bool)
    ):
        raise ValueError("draft payload identity is incomplete or inconsistent")
    workitem_id = payload.get("workitemId")
    if not isinstance(workitem_id, str) or not workitem_id.isdigit():
        raise ValueError("turn-one draft needs a plain numeric workitemId")
    descriptor = PROVIDERS[provider]
    expected_text = f"{descriptor['command']} {workitem_id} {CONTRACT['firstPromptSuffix']}"
    if payload.get("text") != expected_text:
        raise ValueError(f"draft prompt drifted: expected {expected_text!r}")
    relative = safe_relative(str(RETENTION["draftEvidence"]))

    with lifecycle_gate():
        require_slot_lock(provider, run_root)
        lifecycle_path = run_root / "lifecycle.json"
        if os.path.lexists(lifecycle_path):
            if lifecycle_path.is_symlink() or not lifecycle_path.is_file():
                raise RuntimeError(f"lifecycle evidence is unsafe: {lifecycle_path}")
            lifecycle = read_json(lifecycle_path)
            lifecycle_state = lifecycle.get("state") or lifecycle.get("status") if isinstance(lifecycle, dict) else None
            if lifecycle_state in {
                "PRE_SEND_ARCHIVED",
                "PRE_SEND_ABANDONED",
                "CLEANUP_FAILED",
                "RETAINED_LEGACY",
                "RETAINED_DRAFT",
                "RETAINED_FOR_REVIEW",
                "POST_SEND_ABANDONED",
            }:
                raise RuntimeError(f"refusing to record a draft after terminal lifecycle state {lifecycle_state}")
        draft_path = run_root / relative
        if os.path.lexists(draft_path):
            raise RuntimeError(f"draft evidence already exists; inspect the owned renderer before any retry: {draft_path}")
        intent_path = run_root / safe_relative(str(RETENTION["sendIntentEvidence"]))
        if os.path.lexists(intent_path):
            raise RuntimeError("turn-1 send intent already exists; the draft stop point has been crossed")
        owner = read_json(slot_lock_path(provider))
        owner_status = slot_owner_status(owner, provider, run_root)
        if owner_status.get("valid") is True and owner_status.get("active") is False:
            raise RuntimeError(f"Provider slot owner is inactive: {owner_status}")
        write_json_atomic(draft_path, payload)
        updated = refresh_slot_owner_locked(provider, run_root, "TURN1_DRAFT_PREPARED")
    return {
        "ok": True,
        "path": str(draft_path),
        "owner": slot_owner_status(updated, provider, run_root),
    }


def release_lock(path: Path, run_root: Path) -> dict[str, Any]:
    if not path.is_file():
        return {"ok": True, "alreadyReleased": True, "path": str(path)}
    existing = read_json(path)
    if existing.get("runRoot") != str(run_root):
        raise RuntimeError(f"refusing to release lock owned by {existing.get('runRoot')}: {path}")
    path.unlink()
    return {"ok": True, "alreadyReleased": False, "path": str(path)}


def tree_fingerprint(root: Path) -> dict[str, Any]:
    if not root.is_dir():
        return {"files": 0, "sha256": None}
    digest = hashlib.sha256()
    files = 0
    for path in sorted(
        (item for item in root.rglob("*") if item.is_file() or item.is_symlink()),
        key=lambda item: str(item.relative_to(root)),
    ):
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
    return {"files": files, "sha256": "sha256:" + digest.hexdigest()}


def current_contract_identity() -> dict[str, Any]:
    return {
        "schemaVersion": CONTRACT.get("schemaVersion"),
        "sha256": "sha256:" + hashlib.sha256(CONTRACT_PATH.read_bytes()).hexdigest(),
    }


def frozen_contract_identity(run_root: Path) -> dict[str, Any] | None:
    """Read the successful baseline identity without trusting lifecycle claims."""
    candidates: list[Path] = []
    prepared_path = run_root / "environment-prepared.json"
    if prepared_path.is_file() and not prepared_path.is_symlink():
        try:
            prepared = read_json(prepared_path)
            raw_baseline = prepared.get("baselinePreflight") if isinstance(prepared, dict) else None
            if isinstance(raw_baseline, str):
                baseline = Path(raw_baseline).expanduser().resolve()
                if baseline.parent == run_root and baseline.name in {"preflight.json", "preflight-build-cache.json"}:
                    candidates.append(baseline)
        except (OSError, UnicodeError, json.JSONDecodeError):
            return None
    candidates.extend(run_root / name for name in ("preflight-build-cache.json", "preflight.json"))
    seen: set[Path] = set()
    for path in candidates:
        if path in seen:
            continue
        seen.add(path)
        if path.is_symlink() or not path.is_file():
            continue
        try:
            frozen = read_json(path)
        except (OSError, UnicodeError, json.JSONDecodeError):
            return None
        contract = frozen.get("contract") if isinstance(frozen, dict) else None
        schema = frozen.get("contractSchemaVersion") if isinstance(frozen, dict) else None
        if not (
            frozen.get("ok") is True
            and isinstance(contract, dict)
            and type(schema) is int
            and contract.get("schemaVersion") == schema
            and isinstance(contract.get("sha256"), str)
        ):
            return None
        return {"schemaVersion": schema, "sha256": contract["sha256"]}
    return None


def post_send_cleanup_contract_compatibility(run_root: Path) -> dict[str, Any] | None:
    frozen = frozen_contract_identity(run_root)
    current = current_contract_identity()
    if not isinstance(frozen, dict):
        return None
    if frozen == current:
        return {"mode": "current", "frozen": frozen, "current": current}
    allowlist = RECOVERY.get("legacyPostSendCleanupContracts", [])
    if not isinstance(allowlist, list):
        return None
    compatible = next((
        item for item in allowlist
        if isinstance(item, dict)
        and item.get("schemaVersion") == frozen.get("schemaVersion")
        and item.get("sha256") == frozen.get("sha256")
        and item.get("cleanupCompatibleWithSchemaVersion") == current.get("schemaVersion")
    ), None)
    if compatible is None:
        return None
    return {
        "mode": "explicit_legacy_allowlist",
        "frozen": frozen,
        "current": current,
        "allowlistEntry": compatible,
    }


def valid_final_status(status: Any, state: dict[str, Any]) -> bool:
    if not isinstance(status, dict):
        return False
    live = status.get("rendererOwnershipLive")
    return bool(
        status.get("status") == "running"
        and status.get("version") == state.get("version")
        and status.get("launchId") == state.get("launchId")
        and status.get("pid") == state.get("pid")
        and status.get("port") == state.get("port")
        and status.get("runtimeRoot") == state.get("runtimeRoot")
        and status.get("userDataDir") == state.get("userDataDir")
        and status.get("processAlive") is True
        and status.get("commandMatches") is True
        and status.get("cdpReachable") is True
        and status.get("cdpClosed") is False
        and status.get("cdpReady") is True
        and status.get("ownedRendererReady") is True
        and status.get("ownedRendererCount") == 1
        and status.get("runtimeSnapshotReady") is True
        and status.get("buildSnapshotLive") == (
            state.get("buildSnapshot", {}).get("snapshotFingerprint")
            if isinstance(state.get("buildSnapshot"), dict) else None
        )
        and isinstance(live, dict)
        and live.get("status") == "verified"
    )


def valid_completed_watch(run_root: Path, provider: str, state: dict[str, Any]) -> bool:
    session_path = run_root / "turn-session.json"
    watch_path = run_root / "turn-watch.jsonl"
    if session_path.is_symlink() or watch_path.is_symlink() or not session_path.is_file() or not watch_path.is_file():
        return False
    try:
        session = read_json(session_path)
        last_line = None
        with watch_path.open("r", encoding="utf-8") as handle:
            for line in handle:
                if line.strip():
                    last_line = line
        completed = json.loads(last_line) if last_line is not None else None
    except (OSError, UnicodeError, json.JSONDecodeError):
        return False
    renderer = completed.get("renderer") if isinstance(completed, dict) else None
    persistence = completed.get("persistence") if isinstance(completed, dict) else None
    selected = persistence.get("selected") if isinstance(persistence, dict) else None
    provider_turn_ids = completed.get("providerTurnIds") if isinstance(completed, dict) else None
    expected_turns = completed.get("expectedTurns") if isinstance(completed, dict) else None
    valid_turn_count = expected_turns in {2, 3}
    return bool(
        isinstance(session, dict)
        and isinstance(completed, dict)
        and session.get("runRoot") == str(run_root)
        and session.get("provider") == provider
        and session.get("workspace") == state.get("expectedWorkspace")
        and session.get("launchId") == state.get("launchId")
        and completed.get("state") == "COMPLETED"
        and completed.get("provider") == provider
        and completed.get("workspace") == state.get("expectedWorkspace")
        and valid_turn_count
        and completed.get("sessionId") == session.get("sessionId")
        and isinstance(provider_turn_ids, list)
        and len(provider_turn_ids) == expected_turns
        and all(isinstance(value, str) and value for value in provider_turn_ids)
        and len(set(provider_turn_ids)) == expected_turns
        and isinstance(renderer, dict)
        and renderer.get("identity") is True
        and renderer.get("busy") is False
        and renderer.get("turnCount") == expected_turns
        and isinstance(persistence, dict)
        and persistence.get("state") == "ready"
        and isinstance(selected, dict)
        and selected.get("sessionId") == session.get("sessionId")
    )


def retained_review_is_finalized(raw_run_root: str | None, require_build_snapshot: bool) -> bool:
    if not raw_run_root:
        return False
    candidate = Path(raw_run_root).expanduser().resolve()
    if candidate.parent != RUN_ROOT_PARENT or not candidate.name.startswith(RUN_PREFIX):
        return False
    try:
        lifecycle = read_json(candidate / "lifecycle.json")
        state = read_json(candidate / "test-scry-state.json")
        intent = read_json(candidate / str(RETENTION["sendIntentEvidence"]))
        local_parity = read_json(candidate / "local-parity-final.json")
        final_status = read_json(candidate / "test-scry-status-final.json")
    except (OSError, json.JSONDecodeError):
        return False
    if not all(isinstance(value, dict) for value in (lifecycle, state, intent, local_parity, final_status)):
        return False
    frozen_contract = frozen_contract_identity(candidate)
    if not (
        lifecycle.get("schemaVersion") == 1
        and lifecycle.get("state") == "RETAINED_FOR_REVIEW"
        and lifecycle.get("runRoot") == str(candidate)
        and lifecycle.get("provider") in PROVIDERS
        and lifecycle.get("frozenContract") == frozen_contract
        and isinstance(frozen_contract, dict)
        and frozen_contract.get("schemaVersion", 0) >= 5
        and lifecycle.get("launchId") == state.get("launchId") == intent.get("launchId")
        and intent.get("turn") == 1
        and intent.get("provider") == lifecycle.get("provider")
        and intent.get("runRoot") == str(candidate)
        and intent.get("status") in {"prepared", "sent"}
        and isinstance(local_parity.get("ok"), bool)
        and lifecycle.get("localParityOk") == local_parity.get("ok")
        and lifecycle.get("validationOutcome") == (
            "PASS" if local_parity.get("ok") is True else "LOCAL_DATA_FAIL"
        )
        and valid_completed_watch(candidate, str(lifecycle.get("provider")), state)
        and valid_final_status(final_status, state)
    ):
        return False
    # Both environment recovery and build mutation must be isolated from a
    # retained scene. A version-3 run is isolated only while its copied runtime
    # is still byte-for-byte equal to the launch snapshot.
    _ = require_build_snapshot
    snapshot = RECOVERY.get("runtimeSnapshot", {})
    runtime_root = candidate / str(snapshot.get("relativePath", ""))
    build_snapshot = state.get("buildSnapshot") if isinstance(state.get("buildSnapshot"), dict) else {}
    recorded = build_snapshot.get("snapshotFingerprint")
    return bool(
        state.get("status") == "running"
        and state.get("version") == snapshot.get("stateVersion")
        and state.get("runtimeRoot") == str(runtime_root)
        and runtime_root.is_dir()
        and isinstance(recorded, dict)
        and recorded == tree_fingerprint(runtime_root / "out")
    )


def cleanup_boundary_matches(value: Any, run_root: Path) -> bool:
    boundary = value.get("cleanupBoundary") if isinstance(value, dict) else None
    current = current_contract_identity()
    intent = run_root / safe_relative(str(RETENTION["sendIntentEvidence"]))
    return bool(
        isinstance(boundary, dict)
        and boundary.get("frozenSchemaVersion") == current.get("schemaVersion")
        and boundary.get("frozenSha256") == current.get("sha256")
        and boundary.get("sendIntentPath") == str(intent)
        and boundary.get("sendIntentExists") is False
    )


def post_send_cleanup_boundary_matches(value: Any, run_root: Path) -> bool:
    boundary = value.get("cleanupBoundary") if isinstance(value, dict) else None
    compatibility = post_send_cleanup_contract_compatibility(run_root)
    frozen = compatibility.get("frozen") if isinstance(compatibility, dict) else None
    intent = run_root / safe_relative(str(RETENTION["sendIntentEvidence"]))
    return bool(
        isinstance(boundary, dict)
        and isinstance(frozen, dict)
        and isinstance(compatibility, dict)
        and boundary.get("frozenSchemaVersion") == frozen.get("schemaVersion")
        and boundary.get("frozenSha256") == frozen.get("sha256")
        and boundary.get("sendIntentPath") == str(intent)
        and boundary.get("sendIntentExists") is True
        and intent.is_file()
        and not intent.is_symlink()
    )


def explicit_post_send_abandonment_ready(run_root: Path, slot_lock: Any) -> bool:
    provider = slot_lock.get("provider") if isinstance(slot_lock, dict) else None
    if provider not in PROVIDERS or slot_lock.get("runRoot") != str(run_root):
        return False
    lifecycle_path = run_root / "lifecycle.json"
    if lifecycle_path.is_symlink() or not lifecycle_path.is_file():
        return False
    try:
        lifecycle = read_json(lifecycle_path)
    except (OSError, UnicodeError, json.JSONDecodeError):
        return False
    authorization = lifecycle.get("cleanupAuthorization") if isinstance(lifecycle, dict) else None
    owner = slot_owner_status(slot_lock, provider, run_root)
    return bool(
        isinstance(lifecycle, dict)
        and lifecycle.get("schemaVersion") == 1
        and lifecycle.get("state") == "POST_SEND_ABANDONED"
        and lifecycle.get("status") == "POST_SEND_ABANDONED"
        and lifecycle.get("provider") == provider
        and lifecycle.get("runRoot") == str(run_root)
        and isinstance(lifecycle.get("launchId"), str)
        and lifecycle.get("launchId")
        and isinstance(authorization, dict)
        and authorization.get("decision") == "abandon"
        and authorization.get("impactAcknowledged") is True
        and isinstance(authorization.get("userQuote"), str)
        and authorization.get("userQuote").strip()
        and post_send_cleanup_boundary_matches(lifecycle, run_root)
        and owner.get("valid") is True
        and owner.get("active") is False
        and owner.get("ownerStage") == "ABANDONED"
    )


def terminal_cleanup_authorization(provider: str, run_root: Path) -> dict[str, Any]:
    """Return one strict terminal cleanup identity while the Provider slot still exists."""
    require_slot_lock(provider, run_root)
    slot_lock = read_json(slot_lock_path(provider))
    lifecycle_path = run_root / "lifecycle.json"
    if lifecycle_path.is_symlink() or not lifecycle_path.is_file():
        raise RuntimeError(f"terminal cleanup lifecycle is missing or unsafe: {lifecycle_path}")
    lifecycle = read_json(lifecycle_path)
    state = lifecycle.get("state") if isinstance(lifecycle, dict) else None
    owner = slot_owner_status(slot_lock, provider, run_root)
    if state == "POST_SEND_ABANDONED":
        valid = explicit_post_send_abandonment_ready(run_root, slot_lock)
    elif state == "RETAINED_FOR_REVIEW":
        intent_path = run_root / safe_relative(str(RETENTION["sendIntentEvidence"]))
        intent = read_json(intent_path) if intent_path.is_file() and not intent_path.is_symlink() else None
        valid = bool(
            isinstance(lifecycle, dict)
            and lifecycle.get("schemaVersion") == 1
            and lifecycle.get("status") == "RETAINED_FOR_REVIEW"
            and lifecycle.get("provider") == provider
            and lifecycle.get("runRoot") == str(run_root)
            and lifecycle.get("validationOutcome") in {"PASS", "LOCAL_DATA_FAIL"}
            and lifecycle.get("localParityOk") is (lifecycle.get("validationOutcome") == "PASS")
            and isinstance(intent, dict)
            and intent.get("provider") == provider
            and intent.get("runRoot") == str(run_root)
            and intent.get("launchId") == lifecycle.get("launchId")
            and post_send_cleanup_boundary_matches(lifecycle, run_root)
            and owner.get("valid") is True
            and owner.get("active") is True
        )
    elif state == "RETAINED_DRAFT":
        draft_path = run_root / safe_relative(str(RETENTION["draftEvidence"]))
        draft = read_json(draft_path) if draft_path.is_file() and not draft_path.is_symlink() else None
        boundary = lifecycle.get("cleanupBoundary") if isinstance(lifecycle, dict) else None
        frozen = frozen_contract_identity(run_root)
        valid = bool(
            isinstance(lifecycle, dict)
            and lifecycle.get("schemaVersion") == 1
            and lifecycle.get("status") == "RETAINED_DRAFT"
            and lifecycle.get("provider") == provider
            and lifecycle.get("runRoot") == str(run_root)
            and lifecycle.get("ok") is True
            and lifecycle.get("mutationPerformed") is False
            and frozen == current_contract_identity()
            and isinstance(boundary, dict)
            and boundary.get("frozenSchemaVersion") == frozen.get("schemaVersion")
            and boundary.get("frozenSha256") == frozen.get("sha256")
            and boundary.get("draftEvidencePath") == str(draft_path)
            and boundary.get("draftEvidenceExists") is True
            and isinstance(draft, dict)
            and draft.get("provider") == provider
            and draft.get("runRoot") == str(run_root)
            and owner.get("valid") is True
            and owner.get("active") is True
            and owner.get("ownerStage") == "RETAINED_DRAFT"
        )
    elif state == "PRE_SEND_ARCHIVE_PREPARED":
        # The finalizer writes this prepared record right before sanitize: the
        # terminal PRE_SEND_ARCHIVED lifecycle can only be committed after
        # sanitize and release both succeed, so the prepared record is the
        # strict after-cleanup authorization for a pre-send run with neither
        # send intent nor draft evidence.
        boundary = lifecycle.get("cleanupBoundary") if isinstance(lifecycle, dict) else None
        compatibility = post_send_cleanup_contract_compatibility(run_root)
        frozen = compatibility.get("frozen") if isinstance(compatibility, dict) else None
        intent_path = run_root / safe_relative(str(RETENTION["sendIntentEvidence"]))
        draft_path = run_root / safe_relative(str(RETENTION["draftEvidence"]))
        valid = bool(
            isinstance(lifecycle, dict)
            and lifecycle.get("schemaVersion") == 1
            and lifecycle.get("status") == "PRE_SEND_ARCHIVE_PREPARED"
            and lifecycle.get("provider") == provider
            and lifecycle.get("runRoot") == str(run_root)
            and lifecycle.get("ok") is True
            and lifecycle.get("mutationPerformed") is False
            and isinstance(frozen, dict)
            and frozen.get("schemaVersion", 0) >= 5
            and isinstance(boundary, dict)
            and boundary.get("frozenSchemaVersion") == frozen.get("schemaVersion")
            and boundary.get("frozenSha256") == frozen.get("sha256")
            and not os.path.lexists(intent_path)
            and not os.path.lexists(draft_path)
            and owner.get("valid") is True
            and owner.get("active") is True
        )
    else:
        valid = False
    if not valid:
        raise RuntimeError(f"terminal cleanup lifecycle authorization is invalid: {state}")
    return {
        "state": state,
        "path": str(lifecycle_path),
        "sha256": "sha256:" + hashlib.sha256(lifecycle_path.read_bytes()).hexdigest(),
    }


def explicit_pre_send_recovery_ready(run_root: Path, slot_lock: Any) -> bool:
    """Accept only an explicit failed/abandoned hand-off or a prepared transaction."""
    provider = slot_lock.get("provider") if isinstance(slot_lock, dict) else None
    if provider not in PROVIDERS or slot_lock.get("runRoot") != str(run_root):
        return False

    prepared_path = run_root / "pre-send-archive-prepared.json"
    if prepared_path.is_file() and not prepared_path.is_symlink():
        try:
            prepared = read_json(prepared_path)
        except (OSError, UnicodeError, json.JSONDecodeError):
            prepared = None
        if (
            isinstance(prepared, dict)
            and prepared.get("schemaVersion") == 1
            and prepared.get("state") == "PRE_SEND_ARCHIVE_PREPARED"
            and prepared.get("provider") == provider
            and prepared.get("runRoot") == str(run_root)
            and cleanup_boundary_matches(prepared, run_root)
        ):
            return True

    lifecycle_path = run_root / "lifecycle.json"
    if lifecycle_path.is_symlink() or not lifecycle_path.is_file():
        return False
    try:
        lifecycle = read_json(lifecycle_path)
    except (OSError, UnicodeError, json.JSONDecodeError):
        return False
    if not (
        isinstance(lifecycle, dict)
        and lifecycle.get("provider") == provider
        and lifecycle.get("runRoot") == str(run_root)
        and cleanup_boundary_matches(lifecycle, run_root)
    ):
        return False
    state = lifecycle.get("state") or lifecycle.get("status")
    owner = slot_owner_status(slot_lock, provider, run_root)
    return bool(
        owner.get("valid") is True
        and owner.get("active") is False
        and (
            (state == "CLEANUP_FAILED" and owner.get("ownerStage") == "FINALIZE_FAILED")
            or (state == "PRE_SEND_ABANDONED" and owner.get("ownerStage") == "ABANDONED")
        )
    )


def classify_slot_run(raw_run_root: str | None, slot_lock: Any = None) -> str | None:
    if not raw_run_root:
        return None
    candidate = Path(raw_run_root).expanduser().resolve()
    if candidate.parent != RUN_ROOT_PARENT or not candidate.name.startswith(RUN_PREFIX):
        return "WAITING_FOR_LEGACY_CLEANUP"
    if retained_review_is_finalized(raw_run_root, True):
        return "WAITING_FOR_REVIEW_CLEANUP"
    if explicit_post_send_abandonment_ready(candidate, slot_lock):
        return "WAITING_FOR_ABANDONED_CLEANUP"
    frozen = frozen_contract_identity(candidate)
    current = current_contract_identity()
    if frozen != current or current.get("schemaVersion", 0) < 5:
        return "WAITING_FOR_LEGACY_CLEANUP"
    draft = candidate / str(RETENTION["draftEvidence"])
    if os.path.lexists(draft):
        return "WAITING_FOR_DRAFT_CLEANUP"
    intent = candidate / str(RETENTION["sendIntentEvidence"])
    if not os.path.lexists(intent):
        if explicit_pre_send_recovery_ready(candidate, slot_lock):
            return "PRE_SEND_RECOVERY_REQUIRED"
        # Missing intent alone is not abandonment. A fresh run may be between
        # claim/bootstrap/Test-App preparation and its first atomic send intent.
        return "PRE_SEND_ACTIVE"
    return "WAITING_FOR_ACTIVE_REVIEW_FINALIZATION"


def require_no_other_active_slot_runs(
    run_root: Path,
    *,
    require_build_snapshot: bool,
    allowed_pre_send_recovery: tuple[str, Path] | None = None,
) -> None:
    allowed_provider = allowed_pre_send_recovery[0] if allowed_pre_send_recovery else None
    allowed_run_root = allowed_pre_send_recovery[1].resolve() if allowed_pre_send_recovery else None
    allowed_lock_path = slot_lock_path(allowed_provider) if allowed_provider else None
    allowed_found = False
    for path in lock_root().glob("slot-*.json"):
        if path.is_symlink() or not path.is_file():
            raise RuntimeError(f"Provider slot lock is unsafe during mutation clearance: {path}")
        value = read_json(path)
        if not isinstance(value, dict):
            raise RuntimeError(f"Provider slot lock is invalid during mutation clearance: {path}: {value}")
        locked_run_root = value.get("runRoot")
        if allowed_pre_send_recovery is not None:
            is_allowed_target = bool(
                path == allowed_lock_path
                and value.get("provider") == allowed_provider
                and locked_run_root == str(allowed_run_root)
            )
            if is_allowed_target:
                classification = classify_slot_run(locked_run_root, value)
                if classification != "PRE_SEND_RECOVERY_REQUIRED":
                    raise RuntimeError(
                        "cleanup CLI mutation target is no longer recoverable: "
                        f"{path} ({classification}, {value})"
                    )
                allowed_found = True
                continue
            if retained_review_is_finalized(locked_run_root, require_build_snapshot):
                continue
            classification = classify_slot_run(locked_run_root, value)
            raise RuntimeError(
                "cleanup CLI mutation cannot cross another Provider slot that is not strictly isolated: "
                f"{path} ({classification}, {value})"
            )
        if value.get("runRoot") == str(run_root):
            raise RuntimeError(
                f"cannot mutate environment/build after this run claimed a Provider slot: {path} ({value})"
            )
        if not retained_review_is_finalized(value.get("runRoot"), require_build_snapshot):
            raise RuntimeError(
                "cannot rebuild or reconcile Scry while another validation is active: "
                f"{path} ({value}). If that run is already finished, finish its cleanup first "
                "(sanitize_workspace.py --phase after, then fixed_workspace.py release) instead of deleting the lock."
            )
    if allowed_pre_send_recovery is not None and not allowed_found:
        raise RuntimeError(
            "cleanup CLI mutation target slot is missing: "
            f"provider={allowed_provider}, runRoot={allowed_run_root}"
        )


def require_no_mutation_run() -> None:
    for name in ("build", "environment"):
        path = shared_lock_path(name)
        if path.is_file():
            value = read_json(path)
            raise RuntimeError(f"cannot claim a Provider slot while shared {name} recovery is active: {path} ({value})")


def require_no_other_mutation_lock(name: str, run_root: Path) -> None:
    for other in ("build", "environment"):
        if other == name:
            continue
        path = shared_lock_path(other)
        if path.is_file():
            raise RuntimeError(f"shared mutation lock conflicts with {name}: {path} ({read_json(path)})")


def process_command_sha256(pid: int) -> str | None:
    result = run(["ps", "-ww", "-p", str(pid), "-o", "command="], timeout=10)
    command = (result.stdout or "").strip()
    if result.returncode == 0 and command:
        return "sha256:" + hashlib.sha256(command.encode()).hexdigest()
    if result.returncode == 1 and not command:
        return None
    raise RuntimeError((result.stderr or result.stdout).strip() or f"cannot inspect lock owner PID {pid}")


def recover_stale_mutation_locks(run_root: Path) -> list[dict[str, Any]]:
    """Quarantine corrupt regular locks or process-owned locks whose owner is gone.

    Symlinks and non-regular nodes stay hard failures. Valid legacy locks have
    no process identity and deliberately remain manual. A recovered
    build/environment operation is safe to replay because the single
    prepare_environment transaction re-inspects every postcondition.
    """
    recovered: list[dict[str, Any]] = []
    for name in ("environment", "build"):
        path = shared_lock_path(name)
        if not os.path.lexists(path):
            continue
        if path.is_symlink() or not path.is_file():
            raise RuntimeError(f"refusing to recover unsafe shared mutation lock: {path}")
        try:
            value = read_json(path)
        except (UnicodeError, json.JSONDecodeError) as exc:
            value = None
            parse_error = f"{type(exc).__name__}: {exc}"
        else:
            parse_error = None if isinstance(value, dict) else "lock JSON is not an object"
        if parse_error is not None:
            destination = (
                run_root
                / "shared-lock-recovery"
                / f"corrupt-{name}-{time.time_ns()}-{path.name}"
            )
            destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            shutil.move(str(path), str(destination))
            recovered.append({
                "name": name,
                "source": str(path),
                "destination": str(destination),
                "previousRunRoot": None,
                "ownerPid": None,
                "reason": "corrupt_lock_quarantined",
                "parseError": parse_error,
            })
            continue
        pid = value.get("ownerPid")
        expected = value.get("ownerCommandSha256")
        if value.get("schemaVersion") != 2 or not isinstance(pid, int) or not isinstance(expected, str):
            continue
        actual = process_command_sha256(pid)
        if actual == expected:
            continue
        destination = run_root / "shared-lock-recovery" / f"{name}-{path.name}"
        destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        if destination.exists() or destination.is_symlink():
            raise RuntimeError(f"stale lock quarantine already exists: {destination}")
        shutil.move(str(path), str(destination))
        recovered.append({
            "name": name,
            "source": str(path),
            "destination": str(destination),
            "previousRunRoot": value.get("runRoot"),
            "ownerPid": pid,
            "reason": "owner_process_missing_or_reused",
        })
    return recovered


STATUS_RE = re.compile(
    r"^\s*(?P<slot>\d+)\s+(?P<state>available|leased)\s+(?P<path>\S+)(?:\s+\(held by (?P<holder>.+)\))?\s*$"
)


def parse_treehouse_status(output: str) -> dict[int, dict[str, Any]]:
    result: dict[int, dict[str, Any]] = {}
    for line in output.splitlines():
        match = STATUS_RE.match(line)
        if not match:
            continue
        slot = int(match.group("slot"))
        result[slot] = {
            "slot": slot,
            "state": match.group("state"),
            "path": str(Path(match.group("path")).expanduser().resolve()),
            "holder": match.group("holder"),
        }
    return result


def treehouse_status() -> dict[int, dict[str, Any]]:
    source = Path(FIXED["sourceRepo"]).expanduser().resolve()
    result = run([str(TREEHOUSE_BIN), "status"], source)
    if result.returncode != 0:
        raise RuntimeError((result.stderr or result.stdout).strip() or "treehouse status failed")
    return parse_treehouse_status(result.stdout + "\n" + result.stderr)


def mapping_status(provider: str, status: dict[int, dict[str, Any]]) -> dict[str, Any]:
    slot = slot_for(provider)
    expected_workspace = workspace_for(provider)
    actual = status.get(slot)
    slot_lock = read_json(slot_lock_path(provider)) if slot_lock_path(provider).is_file() else None
    locked_run_root = slot_lock.get("runRoot") if isinstance(slot_lock, dict) else None
    lifecycle_state = None
    if isinstance(locked_run_root, str):
        try:
            lifecycle = read_json(Path(locked_run_root) / "lifecycle.json")
            if isinstance(lifecycle, dict):
                lifecycle_state = lifecycle.get("state") or lifecycle.get("status")
        except (OSError, json.JSONDecodeError):
            lifecycle_state = None
    slot_classification = classify_slot_run(locked_run_root, slot_lock)
    return {
        "provider": provider,
        "slot": slot,
        "workspace": str(expected_workspace),
        "expectedHolder": expected_holder(provider),
        "treehouse": actual,
        "mappingReady": bool(
            actual
            and actual["state"] == "leased"
            and actual["holder"] == expected_holder(provider)
            and Path(actual["path"]).resolve() == expected_workspace
        ),
        "slotLock": slot_lock,
        "slotOwner": (
            slot_owner_status(slot_lock, provider, Path(locked_run_root).expanduser().resolve())
            if isinstance(slot_lock, dict) and isinstance(locked_run_root, str)
            else None
        ),
        "slotLifecycle": {
            "state": lifecycle_state,
            "reviewFinalizedForEnvironment": retained_review_is_finalized(locked_run_root, False),
            "reviewFinalizedForBuild": retained_review_is_finalized(locked_run_root, True),
            "classification": slot_classification,
        },
    }


def lease_all() -> dict[str, Any]:
    source = Path(FIXED["sourceRepo"]).expanduser().resolve()
    if not source.is_dir():
        raise RuntimeError(f"rate-native source repo missing: {source}")
    actions: list[dict[str, Any]] = []
    repairs_left = int(POOL_RECOVERY["maxRegistryRepairsPerLease"])
    reconcile = prune_stale_pool_registry(source)
    if reconcile["action"] == "pruned-stale-worktree-registry":
        repairs_left -= 1
        actions.append({"action": "registry-repair", "trigger": "pre-lease-scan", "detail": reconcile})
    for provider in sorted(PROVIDERS, key=slot_for):
        slot = slot_for(provider)
        pool_status = treehouse_status()
        current = pool_status.get(slot)
        if current and current["state"] == "leased":
            if current["holder"] != expected_holder(provider) or Path(current["path"]).resolve() != workspace_for(provider):
                raise RuntimeError(f"fixed slot {slot} is leased by another owner: {current}")
            actions.append({"provider": provider, "slot": slot, "action": "already-leased"})
            continue
        expected_workspace = workspace_for(provider)
        available = {
            Path(item["path"]).resolve()
            for item in pool_status.values()
            if item.get("state") == "available"
        }
        if expected_workspace not in available:
            raise RuntimeError(f"fixed slot {slot} is not available for {provider}: {current}")
        lease_command = [
            str(TREEHOUSE_BIN),
            "get",
            "--lease",
            "--lease-holder",
            expected_holder(provider),
        ]
        held_mismatches: list[Path] = []
        acquired: Path | None = None
        try:
            # treehouse selects an available worktree according to pool recency,
            # not by slot number. Hold non-target selections temporarily so a
            # fixed slot remains reachable without accepting the wrong mapping.
            for _ in range(len(available)):
                result = run(lease_command, source)
                if result.returncode != 0:
                    message = (result.stderr or result.stdout).strip()
                    if STALE_WORKTREE_REGISTRATION_ERROR in message and repairs_left > 0:
                        repairs_left -= 1
                        repair = prune_stale_pool_registry(source)
                        actions.append(
                            {
                                "provider": provider,
                                "slot": slot,
                                "action": "registry-repair",
                                "trigger": message,
                                "detail": repair,
                            }
                        )
                        result = run(lease_command, source)
                    if result.returncode != 0:
                        raise RuntimeError(
                            (result.stderr or result.stdout).strip() or f"failed to lease slot {slot}"
                        )
                output_lines = [line.strip() for line in result.stdout.splitlines() if line.strip()]
                if len(output_lines) != 1:
                    raise RuntimeError(f"unexpected treehouse get output: {result.stdout!r}")
                candidate = Path(output_lines[0]).expanduser().resolve()
                if candidate == expected_workspace:
                    acquired = candidate
                    break
                held_mismatches.append(candidate)
                actions.append(
                    {
                        "provider": provider,
                        "slot": slot,
                        "action": "held-non-target",
                        "workspace": str(candidate),
                    }
                )
            if acquired is None:
                raise RuntimeError(
                    f"expected slot {slot} for {provider} was not selected after holding "
                    f"{len(held_mismatches)} non-target worktrees"
                )
        finally:
            for mismatch in held_mismatches:
                returned = run([str(TREEHOUSE_BIN), "return", "--force", str(mismatch)], source)
                if returned.returncode != 0:
                    raise RuntimeError(
                        (returned.stderr or returned.stdout).strip()
                        or f"failed to return held non-target worktree {mismatch}"
                    )
        actions.append({"provider": provider, "slot": slot, "action": "leased", "workspace": str(acquired)})
    final = treehouse_status()
    mappings = [mapping_status(provider, final) for provider in sorted(PROVIDERS, key=slot_for)]
    return {"ok": all(item["mappingReady"] for item in mappings), "actions": actions, "mappings": mappings}


def git(command: list[str], workspace: Path, timeout: int = 60) -> subprocess.CompletedProcess[str]:
    return run(["git", *command], workspace, timeout)


STALE_WORKTREE_REGISTRATION_ERROR = "missing but already registered worktree"
PRUNE_PLAN_RE = re.compile(r"^Removing worktrees/(?P<admin>[^:]+):\s*(?P<reason>.+)$")


def pool_root() -> Path:
    return Path(FIXED["poolRoot"]).expanduser().resolve()


def path_within(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
    except ValueError:
        return False
    return True


def registered_worktrees(source: Path) -> list[dict[str, Any]]:
    result = git(["worktree", "list", "--porcelain"], source)
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "git worktree list failed")
    entries: list[dict[str, Any]] = []
    for line in result.stdout.splitlines():
        if line.startswith("worktree "):
            entries.append(
                {
                    "path": str(Path(line[len("worktree ") :]).expanduser().resolve()),
                    "prunable": None,
                }
            )
        elif line.startswith("prunable") and entries:
            entries[-1]["prunable"] = line[len("prunable") :].strip() or "prunable"
    return entries


def stale_pool_registrations(source: Path) -> list[dict[str, Any]]:
    root = pool_root()
    return [
        entry
        for entry in registered_worktrees(source)
        if entry["prunable"] and path_within(Path(entry["path"]), root)
    ]


def prune_plan(source: Path) -> list[dict[str, Any]]:
    common = git(["rev-parse", "--git-common-dir"], source)
    if common.returncode != 0:
        raise RuntimeError(common.stderr.strip() or "git rev-parse --git-common-dir failed")
    admin_root = (source / common.stdout.strip()).resolve() / "worktrees"
    dry_run = git(["worktree", "prune", "--dry-run", "--verbose"], source)
    if dry_run.returncode != 0:
        raise RuntimeError((dry_run.stderr or dry_run.stdout).strip() or "git worktree prune --dry-run failed")
    plan: list[dict[str, Any]] = []
    for line in (dry_run.stdout + "\n" + dry_run.stderr).splitlines():
        match = PRUNE_PLAN_RE.match(line.strip())
        if not match:
            continue
        admin = match.group("admin")
        gitdir_file = admin_root / admin / "gitdir"
        target = None
        if gitdir_file.is_file():
            target = Path(gitdir_file.read_text(encoding="utf-8").strip()).expanduser()
        plan.append(
            {
                "admin": admin,
                "reason": match.group("reason"),
                "gitdirTarget": str(target) if target else None,
                "gitdirTargetExists": bool(target and target.exists()),
                "worktree": str(target.parent) if target else None,
                "underPoolRoot": bool(target and path_within(target.parent.resolve(), pool_root())),
            }
        )
    return plan


def prune_stale_pool_registry(source: Path) -> dict[str, Any]:
    """Drop Git worktree registrations left behind when the fixed pool is deleted externally.

    Prune is repo-wide, so it only runs when every planned removal points at a gitdir that no
    longer exists and at least one of them belongs to the fixed pool.
    """
    if not POOL_RECOVERY["pruneStaleWorktreeRegistry"]:
        return {"action": "disabled", "reason": "contract disables stale worktree registry prune"}
    stale = stale_pool_registrations(source)
    if not stale:
        return {"action": "none", "reason": "no stale fixed-pool worktree registration"}
    plan = prune_plan(source)
    if not plan:
        raise RuntimeError(f"stale fixed-pool registrations exist but git plans no prune: {stale}")
    unreadable = [item for item in plan if item["gitdirTarget"] is None]
    if unreadable:
        raise RuntimeError(f"refusing to prune: unreadable worktree registration target: {unreadable}")
    live = [item for item in plan if item["gitdirTargetExists"]]
    if live:
        raise RuntimeError(f"refusing to prune: planned removal still has a live worktree: {live}")
    if not any(item["underPoolRoot"] for item in plan):
        raise RuntimeError(f"refusing to prune: no planned removal is inside the fixed pool: {plan}")
    pruned = git(["worktree", "prune", "--verbose"], source)
    if pruned.returncode != 0:
        raise RuntimeError((pruned.stderr or pruned.stdout).strip() or "git worktree prune failed")
    remaining = stale_pool_registrations(source)
    if remaining:
        raise RuntimeError(f"stale fixed-pool registrations survived prune: {remaining}")
    return {
        "action": "pruned-stale-worktree-registry",
        "sourceRepo": str(source),
        "poolRoot": str(pool_root()),
        "removed": plan,
        "log": (pruned.stdout + pruned.stderr).strip(),
        "at": now(),
    }


def validate_workspace(provider: str) -> Path:
    workspace = workspace_for(provider)
    if not workspace.is_dir():
        raise RuntimeError(f"fixed workspace missing: {workspace}")
    result = git(["rev-parse", "--show-toplevel"], workspace)
    if result.returncode != 0 or Path(result.stdout.strip()).resolve() != workspace:
        raise RuntimeError(f"not the expected Git worktree: {workspace}")
    return workspace


def input_fingerprint(workspace: Path) -> dict[str, Any]:
    digest = hashlib.sha256()
    inputs: list[dict[str, Any]] = []
    for relative in FIXED["bootstrapInputs"]:
        path = workspace / relative
        tracked = git(["show", f"HEAD:{relative}"], workspace)
        if tracked.returncode == 0:
            value = tracked.stdout.encode("utf-8")
            exists = True
            source = "git:HEAD"
        else:
            exists = path.is_file()
            value = path.read_bytes() if exists else b"<missing>"
            source = "worktree-fallback"
        file_hash = "sha256:" + hashlib.sha256(value).hexdigest() if exists else None
        digest.update(str(relative).encode())
        digest.update(b"\0")
        digest.update(value)
        digest.update(b"\0")
        inputs.append({"path": relative, "exists": exists, "source": source, "sha256": file_hash})
    source_root = Path(FIXED["sourceRepo"]).expanduser().resolve()
    for relative in FIXED["warmRepositories"]:
        identity = repository_identity(source_root / str(relative), source_root)
        head = str(identity.get("head") or "<invalid>")
        origin = str(identity.get("originKey") or "<none>")
        digest.update(f"warm:{relative}".encode())
        digest.update(b"\0")
        digest.update(head.encode())
        digest.update(b"\0")
        digest.update(origin.encode())
        digest.update(b"\0")
        inputs.append({
            "path": str(relative),
            "exists": identity["valid"],
            "source": "authority-warm-repository",
            "head": identity.get("head"),
            "originSha256": (
                "sha256:" + hashlib.sha256(origin.encode()).hexdigest()
                if identity.get("originKey")
                else None
            ),
        })
    return {"sha256": "sha256:" + digest.hexdigest(), "inputs": inputs}


def marker_path(provider: str) -> Path:
    return workspace_for(provider).parent / ".validate-scry-rate-workflow-bootstrap.json"


def executable_version(path: str | None) -> dict[str, Any]:
    if not path:
        return {"path": None, "absolute": False, "executable": False, "version": None}
    candidate = Path(path)
    runnable = candidate.is_absolute() and candidate.is_file() and os.access(candidate, os.X_OK)
    if not runnable:
        return {"path": path, "absolute": candidate.is_absolute(), "executable": False, "version": None}
    result = run([str(candidate), "--version"])
    lines = [line.strip() for line in (result.stdout or "").splitlines() if line.strip()]
    return {
        "path": str(candidate.resolve()),
        "absolute": True,
        "executable": True,
        "version": lines[-1] if result.returncode == 0 and lines else None,
    }


def local_settings_status(workspace: Path, expected_version: str | None) -> dict[str, Any]:
    missing: list[str] = []
    issues: list[str] = []
    details: list[dict[str, Any]] = []
    cli_paths: set[str] = set()
    seed_path: Path | None = None
    seed_env: dict[str, Any] = {}
    try:
        seed_path, seed = authoritative_settings_seed()
        raw_seed_env = seed.get("env") if isinstance(seed, dict) else None
        seed_env = raw_seed_env if isinstance(raw_seed_env, dict) else {}
    except RuntimeError as exc:
        issues.append(f"authoritative_seed:{exc}")
    for raw in CONFIG_RECOVERY["managedTargets"]:
        relative = safe_relative(str(raw))
        path = workspace / relative
        try:
            value = read_json(path)
        except (OSError, json.JSONDecodeError):
            missing.append(relative.as_posix())
            issues.append(f"{relative.as_posix()}:missing_or_invalid")
            continue
        env = value.get("env") if isinstance(value, dict) else None
        env = env if isinstance(env, dict) else {}
        missing_keys = [
            key for key in CONFIG_RECOVERY["requiredEnvKeys"]
            if not isinstance(env.get(key), str) or not env.get(key)
        ]
        cli_path = env.get("SCRY_CLI_PATH") if isinstance(env.get("SCRY_CLI_PATH"), str) else None
        if cli_path:
            cli_paths.add(cli_path)
        mode = path.stat().st_mode & 0o777
        if missing_keys:
            issues.append(f"{relative.as_posix()}:missing_env:{','.join(missing_keys)}")
        if mode != 0o600:
            issues.append(f"{relative.as_posix()}:mode:{mode:04o}")
        mismatched_keys = [
            str(key)
            for key in CONFIG_RECOVERY["copiedEnvKeys"]
            if key != "SCRY_CLI_PATH" and key in seed_env and env.get(key) != seed_env.get(key)
        ]
        if mismatched_keys:
            issues.append(f"{relative.as_posix()}:authoritative_mismatch:{','.join(mismatched_keys)}")
        details.append({
            "path": relative.as_posix(),
            "envKeys": sorted(env),
            "missingRequiredEnvKeys": missing_keys,
            "authoritativeMismatchedKeys": mismatched_keys,
            "cliPath": cli_path,
            "mode": f"{mode:04o}",
        })
    cli_path = next(iter(cli_paths)) if len(cli_paths) == 1 else None
    cli = executable_version(cli_path)
    if len(cli_paths) != 1:
        issues.append(f"SCRY_CLI_PATH:expected_one_got:{sorted(cli_paths)}")
    if cli.get("executable") is not True:
        issues.append("SCRY_CLI_PATH:not_executable")
    if expected_version and cli.get("version") != expected_version:
        issues.append(f"SCRY_CLI_PATH:version:{cli.get('version')}!=expected:{expected_version}")
    return {
        "ready": not issues and len(details) == len(CONFIG_RECOVERY["managedTargets"]),
        "missing": missing,
        "issues": issues,
        "details": details,
        "authoritativeSeed": str(seed_path) if seed_path else None,
        "cli": cli,
    }


def normalized_mcp_config(value: Any) -> Any:
    if not isinstance(value, dict):
        return value
    normalized = json.loads(json.dumps(value))
    authorization = (
        normalized.get("mcpServers", {})
        .get("ai_native_trace_report", {})
        .get("headers", {})
        .get("Authorization")
    )
    if isinstance(authorization, str):
        normalized["mcpServers"]["ai_native_trace_report"]["headers"]["Authorization"] = "Bearer <credential>"
    return normalized


def mcp_config_status(workspace: Path) -> dict[str, Any]:
    try:
        value = read_json(workspace / ".mcp.json")
    except (OSError, json.JSONDecodeError):
        return {"ready": False, "issues": ["missing_or_invalid"]}
    tracked = git(["show", "HEAD:.mcp.json"], workspace)
    if tracked.returncode != 0:
        return {"ready": False, "issues": ["tracked_template_unavailable"]}
    try:
        template = json.loads(tracked.stdout)
    except json.JSONDecodeError:
        return {"ready": False, "issues": ["tracked_template_invalid"]}
    authorization = (
        value.get("mcpServers", {})
        .get("ai_native_trace_report", {})
        .get("headers", {})
        .get("Authorization")
        if isinstance(value, dict)
        else None
    )
    # ai_native_trace_report authorizes through OAuth now (init.sh strips the
    # retired trace token), so a missing Authorization header is the expected
    # shape; when a header is present it must still be fully materialized.
    credential_ready = authorization is None or (
        isinstance(authorization, str)
        and authorization.startswith("Bearer ")
        and len(authorization) > len("Bearer ")
        and "${" not in authorization
    )
    structure_ready = normalized_mcp_config(value) == normalized_mcp_config(template)
    issues: list[str] = []
    if not credential_ready:
        issues.append("trace_credential_not_materialized")
    if not structure_ready:
        issues.append("structure_or_endpoint_differs_from_HEAD")
    return {
        "ready": not issues,
        "issues": issues,
        "normalizedSha256": "sha256:" + hashlib.sha256(
            json.dumps(normalized_mcp_config(value), ensure_ascii=False, sort_keys=True).encode()
        ).hexdigest(),
    }


def is_repository_root(path: Path, cwd: Path) -> bool:
    if path.is_symlink() or not path.is_dir():
        return False
    result = git(["-C", str(path), "rev-parse", "--show-toplevel"], cwd)
    return result.returncode == 0 and Path(result.stdout.strip()).resolve() == path.resolve()


def normalize_origin(raw: str | None) -> str | None:
    value = (raw or "").strip()
    if not value:
        return None
    if value.startswith("file://"):
        return "file:" + str(Path(urlsplit(value).path).expanduser().resolve())
    if "://" in value:
        parsed = urlsplit(value)
        host = (parsed.hostname or "").lower()
        port = f":{parsed.port}" if parsed.port else ""
        path = parsed.path.rstrip("/")
        if path.endswith(".git"):
            path = path[:-4]
        return f"remote:{host}{port}{path}"
    scp = re.fullmatch(r"(?:[^@/]+@)?([^:]+):(.+)", value)
    if scp and not value.startswith("/"):
        path = "/" + scp.group(2).strip("/")
        if path.endswith(".git"):
            path = path[:-4]
        return f"remote:{scp.group(1).lower()}{path}"
    return "file:" + str(Path(value).expanduser().resolve())


def repository_identity(path: Path, cwd: Path) -> dict[str, Any]:
    if not is_repository_root(path, cwd):
        return {"valid": False, "head": None, "branch": None, "origin": None, "originKey": None, "dirty": None}
    head = git(["-C", str(path), "rev-parse", "HEAD"], cwd)
    branch = git(["-C", str(path), "symbolic-ref", "--quiet", "--short", "HEAD"], cwd)
    origin = git(["-C", str(path), "remote", "get-url", "origin"], cwd)
    status = git(["-C", str(path), "status", "--porcelain=v1", "--untracked-files=all"], cwd)
    if head.returncode != 0 or status.returncode != 0:
        return {"valid": False, "head": None, "branch": None, "origin": None, "originKey": None, "dirty": None}
    raw_origin = origin.stdout.strip() if origin.returncode == 0 else None
    return {
        "valid": True,
        "head": head.stdout.strip(),
        "branch": branch.stdout.strip() if branch.returncode == 0 else None,
        "origin": raw_origin,
        "originKey": normalize_origin(raw_origin),
        "dirty": bool(status.stdout),
    }


def warm_repository_status(workspace: Path) -> dict[str, Any]:
    source_root = Path(FIXED["sourceRepo"]).expanduser().resolve()
    details: list[dict[str, Any]] = []
    for raw in FIXED["warmRepositories"]:
        relative = safe_relative(str(raw))
        source = repository_identity(source_root / relative, source_root)
        target = repository_identity(workspace / relative, workspace)
        reasons: list[str] = []
        if not source["valid"]:
            reasons.append("authority_missing_or_invalid")
        if not target["valid"]:
            reasons.append("target_missing_or_incomplete")
        elif source["valid"]:
            if target["dirty"]:
                reasons.append("target_dirty")
            if target["originKey"] != source["originKey"]:
                reasons.append("origin_mismatch")
            if target["head"] != source["head"]:
                reasons.append("head_mismatch")
        details.append({
            "path": relative.as_posix(),
            "ready": not reasons,
            "reasons": reasons,
            "sourceHead": source.get("head"),
            "targetHead": target.get("head"),
            "sourceOriginSha256": (
                "sha256:" + hashlib.sha256(str(source["originKey"]).encode()).hexdigest()
                if source.get("originKey") else None
            ),
            "targetOriginSha256": (
                "sha256:" + hashlib.sha256(str(target["originKey"]).encode()).hexdigest()
                if target.get("originKey") else None
            ),
        })
    return {"ready": all(item["ready"] for item in details), "repositories": details}


def warm_repositories_ready(workspace: Path) -> tuple[bool, list[str]]:
    status = warm_repository_status(workspace)
    return status["ready"], [item["path"] for item in status["repositories"] if not item["ready"]]


def clone_local_repository(source: Path, target: Path, workspace: Path, staging_root: Path) -> dict[str, Any]:
    source_head = git(["-C", str(source), "rev-parse", "HEAD"], workspace)
    source_status = git(["-C", str(source), "status", "--porcelain=v1", "--untracked-files=all"], workspace)
    source_origin = git(["-C", str(source), "remote", "get-url", "origin"], workspace)
    if source_head.returncode != 0 or source_status.returncode != 0:
        raise RuntimeError(f"cannot inspect warm repository source: {source}")

    staging_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    with tempfile.TemporaryDirectory(prefix="seed-", dir=staging_root) as raw:
        staged = Path(raw) / "repo"
        cloned = run(["git", "clone", "--local", str(source), str(staged)], workspace, timeout=600)
        if cloned.returncode != 0:
            raise RuntimeError(cloned.stderr.strip() or f"cannot locally clone {source}")
        origin = source_origin.stdout.strip() if source_origin.returncode == 0 else ""
        if origin:
            restored = git(["-C", str(staged), "remote", "set-url", "origin", origin], workspace)
            if restored.returncode != 0:
                raise RuntimeError(restored.stderr.strip() or f"cannot restore origin for {source}")
        else:
            removed = git(["-C", str(staged), "remote", "remove", "origin"], workspace)
            if removed.returncode != 0:
                raise RuntimeError(removed.stderr.strip() or f"cannot remove synthetic local origin for {source}")
        staged_head = git(["-C", str(staged), "rev-parse", "HEAD"], workspace)
        staged_status = git(["-C", str(staged), "status", "--porcelain=v1", "--untracked-files=all"], workspace)
        if (
            not is_repository_root(staged, workspace)
            or staged_head.returncode != 0
            or staged_head.stdout.strip() != source_head.stdout.strip()
            or staged_status.returncode != 0
            or staged_status.stdout
        ):
            raise RuntimeError(f"local clone verification failed: {source} -> {target}")
        if target.exists() or target.is_symlink():
            raise RuntimeError(f"refusing to overwrite warm repository target: {target}")
        staged.replace(target)

    return {
        "source": str(source),
        "target": str(target),
        "head": source_head.stdout.strip(),
        "originRestored": bool(origin),
        "sourceDirtyIgnored": bool(source_status.stdout),
    }


def reconcile_warm_repository_head(
    source: Path,
    target: Path,
    workspace: Path,
    run_root: Path,
) -> dict[str, Any]:
    source_identity = repository_identity(source, workspace)
    target_identity = repository_identity(target, workspace)
    if not source_identity["valid"] or not target_identity["valid"]:
        raise RuntimeError(f"cannot reconcile invalid warm repository: {source} -> {target}")
    if target_identity["dirty"]:
        raise RuntimeError(f"refusing to align dirty warm repository; run sanitize first: {target}")
    if source_identity["originKey"] != target_identity["originKey"]:
        raise RuntimeError(f"warm repository origin mismatch requires quarantine/reseed: {target}")
    previous_head = str(target_identity["head"])
    source_head = str(source_identity["head"])
    if previous_head == source_head:
        return {"target": str(target), "idempotent": True, "head": source_head}
    ref_component = re.sub(r"[^A-Za-z0-9._-]+", "-", target.name)
    recovery_ref = f"refs/validate-scry-rate-workflow/{run_root.name}/{ref_component}"
    saved = git(["-C", str(target), "update-ref", recovery_ref, previous_head], workspace)
    if saved.returncode != 0:
        raise RuntimeError(saved.stderr.strip() or f"cannot preserve previous warm repository HEAD: {target}")
    fetched = git(["-C", str(target), "fetch", "--no-tags", "--force", str(source), source_head], workspace, timeout=600)
    if fetched.returncode != 0:
        raise RuntimeError(fetched.stderr.strip() or f"cannot fetch authority HEAD into warm repository: {target}")
    source_branch = source_identity.get("branch")
    checkout_args = ["-C", str(target), "checkout", "--force", "--detach", source_head]
    if isinstance(source_branch, str) and source_branch:
        checkout_args = ["-C", str(target), "checkout", "--force", "-B", source_branch, source_head]
    checked_out = git(checkout_args, workspace)
    if checked_out.returncode != 0:
        raise RuntimeError(checked_out.stderr.strip() or f"cannot align warm repository checkout: {target}")
    after = repository_identity(target, workspace)
    if not after["valid"] or after["dirty"] or after["head"] != source_head or after["originKey"] != source_identity["originKey"]:
        raise RuntimeError(f"warm repository did not converge to authority identity: {target}")
    return {
        "target": str(target),
        "idempotent": False,
        "previousHead": previous_head,
        "previousBranch": target_identity.get("branch"),
        "recoveryRef": recovery_ref,
        "head": source_head,
        "branch": after.get("branch"),
    }


def seed_warm_repositories(provider: str, run_root: Path) -> dict[str, Any]:
    require_slot_lock(provider, run_root)
    workspace = validate_workspace(provider)
    source_root = Path(FIXED["sourceRepo"]).expanduser().resolve()
    missing: list[tuple[str, Path, Path]] = []
    present: list[str] = []
    quarantined: list[dict[str, str]] = []
    aligned: list[dict[str, Any]] = []
    for raw in FIXED["warmRepositories"]:
        relative = safe_relative(str(raw))
        source = source_root / relative
        target = workspace / relative
        source_identity = repository_identity(source, source_root)
        if not source_identity["valid"]:
            raise RuntimeError(f"warm repository source missing or invalid: {source}")
        if is_repository_root(target, workspace):
            target_identity = repository_identity(target, workspace)
            if target_identity["dirty"]:
                raise RuntimeError(f"refusing to replace or reset dirty warm repository; sanitize first: {target}")
            if target_identity["originKey"] != source_identity["originKey"]:
                destination = run_root / "bootstrap-recovery" / "mismatched-repositories" / relative
                destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                if destination.exists() or destination.is_symlink():
                    raise RuntimeError(f"mismatched repository quarantine already exists: {destination}")
                shutil.move(str(target), str(destination))
                quarantined.append({
                    "source": str(target),
                    "destination": str(destination),
                    "reason": "origin_mismatch",
                })
                missing.append((raw, source, target))
                continue
            if target_identity["head"] != source_identity["head"]:
                aligned.append(reconcile_warm_repository_head(source, target, workspace, run_root))
            else:
                present.append(raw)
            continue
        if target.is_symlink():
            raise RuntimeError(f"refusing to quarantine symlinked warm repository target: {target}")
        if target.exists():
            destination = run_root / "bootstrap-recovery" / "incomplete-repositories" / relative
            destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            if destination.exists() or destination.is_symlink():
                raise RuntimeError(f"incomplete repository quarantine already exists: {destination}")
            shutil.move(str(target), str(destination))
            quarantined.append({"source": str(target), "destination": str(destination)})
        missing.append((raw, source, target))

    staging_root = run_root / "bootstrap-recovery" / "staging"
    seeded = [clone_local_repository(source, target, workspace, staging_root) for _, source, target in missing]
    ready, still_missing = warm_repositories_ready(workspace)
    if not ready:
        raise RuntimeError(f"warm repositories remain missing after local seed: {still_missing}")
    return {
        "ok": True,
        "provider": provider,
        "workspace": str(workspace),
        "transport": "git-clone-local",
        "seeded": seeded,
        "alignedToAuthority": aligned,
        "alreadyPresent": present,
        "quarantinedIncomplete": quarantined,
    }


def authoritative_settings_seed() -> tuple[Path, dict[str, Any]]:
    source_root = Path(str(CONFIG_RECOVERY["authoritativeRepo"])).expanduser().resolve()
    required = [str(key) for key in CONFIG_RECOVERY["requiredEnvKeys"]]
    for raw in CONFIG_RECOVERY["sourceCandidates"]:
        relative = safe_relative(str(raw))
        path = source_root / relative
        try:
            value = read_json(path)
        except (OSError, json.JSONDecodeError):
            continue
        env = value.get("env") if isinstance(value, dict) else None
        if isinstance(env, dict) and all(isinstance(env.get(key), str) and env.get(key) for key in required):
            return path, value
    raise RuntimeError("authoritative rate-native settings are missing, invalid, or incomplete")


def restore_local_settings(provider: str, run_root: Path, scry_bin: str) -> dict[str, Any]:
    require_slot_lock(provider, run_root)
    workspace = validate_workspace(provider)
    cli = executable_version(scry_bin)
    if cli.get("executable") is not True:
        raise RuntimeError(f"reconciled Scry CLI is not executable: {cli}")
    seed_path, seed = authoritative_settings_seed()
    seed_env = seed.get("env")
    assert isinstance(seed_env, dict)
    copied_env = {key: seed_env[key] for key in CONFIG_RECOVERY["copiedEnvKeys"] if key in seed_env}
    copied_env["SCRY_CLI_PATH"] = str(cli["path"])
    recovered: list[dict[str, Any]] = []
    for raw in CONFIG_RECOVERY["managedTargets"]:
        relative = safe_relative(str(raw))
        target = workspace / relative
        if target.is_symlink():
            raise RuntimeError(f"refusing to replace symlinked local settings: {target}")
        existing: dict[str, Any] = {}
        invalid = False
        if target.exists():
            try:
                loaded = read_json(target)
                existing = loaded if isinstance(loaded, dict) else {}
                invalid = not isinstance(loaded, dict)
            except (OSError, json.JSONDecodeError):
                invalid = True
        quarantined = None
        if invalid:
            destination = run_root / "bootstrap-recovery" / "invalid-settings" / relative
            destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            if destination.exists() or destination.is_symlink():
                raise RuntimeError(f"invalid settings quarantine already exists: {destination}")
            shutil.move(str(target), str(destination))
            quarantined = str(destination)
            existing = {}
        target_env = existing.get("env") if isinstance(existing.get("env"), dict) else {}
        target_env.update(copied_env)
        existing["env"] = target_env
        write_json_atomic(target, existing)
        target.chmod(0o600)
        recovered.append({
            "path": str(target),
            "quarantined": quarantined,
            "envKeys": sorted(target_env),
            "mode": "0600",
        })
    return {"ok": True, "source": str(seed_path), "targets": recovered, "cli": cli}


def redact_init_log(text: str, settings: dict[str, Any]) -> str:
    redacted = text
    paths = [settings.get("source")]
    paths.extend(item.get("path") for item in settings.get("targets", []) if isinstance(item, dict))
    for raw in filter(None, paths):
        try:
            value = read_json(Path(str(raw)))
        except (OSError, json.JSONDecodeError):
            continue
        env = value.get("env") if isinstance(value, dict) else None
        if not isinstance(env, dict):
            continue
        for key, candidate in env.items():
            value = candidate
            if isinstance(value, str) and value:
                redacted = redacted.replace(value, f"<{key}:redacted>")
    return redacted


def run_bootstrap_init(workspace: Path, run_root: Path, scry_bin: str, settings: dict[str, Any]) -> dict[str, Any]:
    env = dict(os.environ)
    node_bin = str(Path(str(RECORDER_RECOVERY["nodeBinDir"])).expanduser().resolve())
    local_bin = str(Path(str(RECORDER_RECOVERY["installPrefix"])).expanduser().resolve() / "bin")
    env["PATH"] = os.pathsep.join([node_bin, local_bin, env.get("PATH", "")])
    env["SCRY_CLI_PATH"] = str(Path(scry_bin).expanduser().resolve())
    # Reserve the log before running so a timeout still leaves actionable evidence.
    log_root = run_root / "bootstrap-recovery" / "init-logs"
    log_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor, raw_log_path = tempfile.mkstemp(prefix="attempt-", suffix=".log", dir=log_root)
    os.close(descriptor)
    log_path = Path(raw_log_path)
    log_path.chmod(0o600)

    def persist(stdout: Any, stderr: Any) -> None:
        def text(value: Any) -> str:
            if isinstance(value, bytes):
                return value.decode("utf-8", "replace")
            return value if isinstance(value, str) else ""

        log_path.write_text(redact_init_log(text(stdout) + text(stderr), settings), encoding="utf-8")

    timeout = 1800
    try:
        # `init.sh` pipes third-party installers into `sh`, and those read their
        # confirmation prompts straight from /dev/tty, so closing stdin is not enough:
        # without a controlling terminal the prompt fails fast and init.sh's own `||`
        # handler reports it, instead of burning the entire timeout on a hidden wait.
        result = run(
            ["bash", "init.sh"],
            workspace,
            timeout=timeout,
            env=env,
            stdin=subprocess.DEVNULL,
            start_new_session=True,
        )
    except subprocess.TimeoutExpired as exc:
        persist(exc.stdout, exc.stderr)
        raise RuntimeError(
            f"bootstrap init timed out after {timeout}s; inspect redacted log: {log_path}"
        ) from exc
    persist(result.stdout, result.stderr)
    return {"returnCode": result.returncode, "logPath": str(log_path)}


def registry_recorder_latest() -> str | None:
    """`latest` as `init.sh` would resolve it, or None when the query is unusable."""
    node_bin = Path(str(RECORDER_RECOVERY["nodeBinDir"])).expanduser().resolve()
    npm = node_bin / "npm"
    env = dict(os.environ)
    env["PATH"] = os.pathsep.join([str(node_bin), env.get("PATH", "")])
    result = run(
        [str(npm), "view", f"{RECORDER_PACKAGE}@latest", "version", f"--registry={RECORDER_REGISTRY}"],
        timeout=90,
        env=env,
    )
    if result.returncode != 0:
        return None
    lines = [line.strip() for line in (result.stdout or "").splitlines() if line.strip()]
    latest = lines[-1] if lines else ""
    return latest if re.fullmatch(r"\d+\.\d+\.\d+", latest) else None


def bootstrap_status(provider: str, preflight_path: Path | None = None) -> dict[str, Any]:
    workspace = validate_workspace(provider)
    fingerprint = input_fingerprint(workspace)
    repository_status = warm_repository_status(workspace)
    repositories_ok = repository_status["ready"]
    missing_repositories = [
        item["path"] for item in repository_status["repositories"] if not item["ready"]
    ]
    source_version = None
    if preflight_path is not None and preflight_path.is_file():
        source_version = read_json(preflight_path).get("versions", {}).get("scry", {}).get("package")
    settings = local_settings_status(workspace, source_version)
    settings_ok = settings["ready"]
    mcp = mcp_config_status(workspace)
    mcp_ok = mcp["ready"]
    marker_inspection = inspect_cache_marker(marker_path(provider))
    marker = marker_inspection["value"]
    marker_matches = bool(
        isinstance(marker, dict)
        and marker.get("provider") == provider
        and marker.get("slot") == slot_for(provider)
        and marker.get("workspace") == str(workspace)
        and marker.get("bootstrapFingerprint") == fingerprint["sha256"]
    )
    needs_init = not (marker_matches and repositories_ok and settings_ok and mcp_ok)
    recorder_registry = None
    if needs_init and source_version:
        latest = registry_recorder_latest()
        recorder_registry = {
            "package": RECORDER_PACKAGE,
            "registry": RECORDER_REGISTRY,
            "latest": latest,
            "sourceVersion": source_version,
            "matchesSource": None if latest is None else latest == source_version,
        }
    ready = marker_matches and repositories_ok and settings_ok and mcp_ok
    init_recorder_compatible = bool(
        not needs_init
        or (recorder_registry and recorder_registry.get("matchesSource") is True)
    )
    return {
        "ok": True,
        "state": "ready" if ready else "repair_required",
        "ready": ready,
        "provider": provider,
        "slot": slot_for(provider),
        "workspace": str(workspace),
        "needsInit": needs_init,
        "markerPath": str(marker_path(provider)),
        "marker": marker,
        "markerError": marker_inspection["error"],
        "markerUnsafe": marker_inspection["unsafe"],
        "fingerprint": fingerprint,
        "repositoriesReady": repositories_ok,
        "missingRepositories": missing_repositories,
        "warmRepositories": repository_status["repositories"],
        "settingsReady": settings_ok,
        "missingSettings": settings["missing"],
        "settingsIssues": settings["issues"],
        "settings": settings,
        "mcpConfigReady": mcp_ok,
        "mcpConfig": mcp,
        "recorderRegistry": recorder_registry,
        "initRecorderCompatible": init_recorder_compatible,
        "initWouldChangeRecorder": bool(needs_init and not init_recorder_compatible),
        "initWouldDowngradeRecorder": bool(needs_init and not init_recorder_compatible),
    }


def write_json_atomic(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_name(f"{path.name}.tmp-{os.getpid()}")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.chmod(0o600)
    temporary.replace(path)


def build_identity(preflight_path: Path) -> dict[str, Any]:
    value = read_json(preflight_path)
    scry = value.get("git", {}).get("scry") if isinstance(value, dict) else None
    artifacts = value.get("buildArtifacts") if isinstance(value, dict) else None
    if not isinstance(scry, dict) or not isinstance(artifacts, dict):
        raise ValueError(f"preflight lacks Scry/build fingerprints: {preflight_path}")
    # The build identity is the committed tree alone: uncommitted worktree
    # changes are audit-only disclosure and never change what gets built.
    identity = {
        "scryHead": scry.get("head"),
        "scryTreeHash": scry.get("treeHash"),
        "buildArtifacts": artifacts,
    }
    if not isinstance(identity["scryHead"], str) or not isinstance(identity["scryTreeHash"], str):
        raise ValueError(f"preflight has invalid Scry identity: {preflight_path}")
    return identity


def require_complete_build(identity: dict[str, Any], out: Path | None = None) -> None:
    artifacts = identity.get("buildArtifacts")
    if not isinstance(artifacts, dict) or artifacts.get("exists") is not True:
        raise RuntimeError("refusing to cache a missing Scry out/ build")
    if not isinstance(artifacts.get("files"), int) or artifacts["files"] < 4 or not artifacts.get("sha256"):
        raise RuntimeError(f"refusing to cache incomplete Scry build artifacts: {artifacts}")
    out = (out or (SCRY_REPO / "out")).expanduser().resolve()
    required = (
        out / "main" / "index.js",
        out / "preload" / "index.cjs",
        out / "renderer" / "index.html",
    )
    missing = [str(path) for path in required if not path.is_file()]
    renderer_assets = out / "renderer" / "assets"
    if not renderer_assets.is_dir() or not any(path.is_file() for path in renderer_assets.iterdir()):
        missing.append(str(renderer_assets / "<asset>"))
    if missing:
        raise RuntimeError(f"refusing to cache a build without required entrypoints: {missing}")
    actual = tree_fingerprint(out)
    expected = {"files": artifacts.get("files"), "sha256": artifacts.get("sha256")}
    if actual != expected:
        raise RuntimeError(f"Scry out/ changed after preflight: expected={expected}, actual={actual}")


def build_status(preflight_path: Path) -> dict[str, Any]:
    current = build_identity(preflight_path)
    marker_inspection = inspect_cache_marker(build_marker_path())
    marker = marker_inspection["value"]
    build_error = None
    try:
        require_complete_build(current)
    except RuntimeError as exc:
        build_error = str(exc)
    ready = bool(build_error is None and isinstance(marker, dict) and marker.get("schemaVersion") == 2 and marker.get("identity") == current)
    return {
        "ok": True,
        "ready": ready,
        "needsBuild": not ready,
        "markerPath": str(build_marker_path()),
        "marker": marker,
        "markerError": marker_inspection["error"],
        "markerUnsafe": marker_inspection["unsafe"],
        "currentIdentity": current,
        "buildComplete": build_error is None,
        "buildError": build_error,
    }


def mark_build(preflight_path: Path, run_root: Path) -> dict[str, Any]:
    require_no_other_active_slot_runs(run_root, require_build_snapshot=True)
    lock = shared_lock_path("build")
    if not lock.is_file() or read_json(lock).get("runRoot") != str(run_root):
        raise RuntimeError(f"shared build lock is not held by this run: {lock}")
    preflight = read_json(preflight_path)
    if not isinstance(preflight, dict) or preflight.get("ok") is not True:
        raise RuntimeError(f"refusing to mark a build from a failed preflight: {preflight_path}")
    recovered_marker = quarantine_invalid_marker(build_marker_path(), run_root, "build-recovery/invalid-marker")
    identity = build_identity(preflight_path)
    require_complete_build(identity)
    marker = {
        "schemaVersion": 2,
        "identity": identity,
        "markedAt": now(),
        "runRoot": str(run_root),
    }
    write_json_atomic(build_marker_path(), marker)
    return {
        "ok": True,
        "markerPath": str(build_marker_path()),
        "marker": marker,
        "recoveredInvalidMarker": recovered_marker,
    }


def mark_retained(provider: str, run_root: Path) -> dict[str, Any]:
    """Create the sole machine-readable boundary between active and review-only runs."""
    require_slot_lock(provider, run_root)
    intent_path = run_root / safe_relative(str(RETENTION["sendIntentEvidence"]))
    final_status_path = run_root / "test-scry-status-final.json"
    local_parity_path = run_root / "local-parity-final.json"
    state_path = run_root / "test-scry-state.json"
    for path in (intent_path, final_status_path, local_parity_path, state_path):
        if path.is_symlink() or not path.is_file():
            raise RuntimeError(f"retained lifecycle evidence missing or unsafe: {path}")
    intent = read_json(intent_path)
    status = read_json(final_status_path)
    parity = read_json(local_parity_path)
    state = read_json(state_path)
    if not all(isinstance(value, dict) for value in (intent, status, parity, state)):
        raise RuntimeError("retained lifecycle evidence must contain JSON objects")
    frozen_contract = frozen_contract_identity(run_root)
    if frozen_contract != current_contract_identity() or frozen_contract.get("schemaVersion", 0) < 5:
        raise RuntimeError("retained run has no successful baseline for the current schema-5+ contract")
    if not (
        intent.get("turn") == 1
        and intent.get("provider") == provider
        and intent.get("runRoot") == str(run_root)
        and intent.get("status") in {"prepared", "sent"}
        and intent.get("launchId") == state.get("launchId")
    ):
        raise RuntimeError(f"turn-one send intent does not match retained run: {intent}")
    if not isinstance(parity.get("ok"), bool):
        raise RuntimeError("local-parity-final.json has no boolean validation outcome")
    if not valid_completed_watch(run_root, provider, state):
        raise RuntimeError("turn watcher does not prove the completed, idle, persisted turns")
    if not valid_final_status(status, state):
        raise RuntimeError("test-scry-status-final.json does not prove a live owned renderer")
    snapshot = RECOVERY.get("runtimeSnapshot", {})
    runtime_root = run_root / str(snapshot.get("relativePath", ""))
    build_snapshot = state.get("buildSnapshot") if isinstance(state.get("buildSnapshot"), dict) else {}
    recorded = build_snapshot.get("snapshotFingerprint")
    if not (
        state.get("version") == snapshot.get("stateVersion")
        and state.get("runtimeRoot") == str(runtime_root)
        and isinstance(recorded, dict)
        and recorded == tree_fingerprint(runtime_root / "out")
    ):
        raise RuntimeError("retained run does not have an intact version-3 runtime snapshot")
    lifecycle = {
        "schemaVersion": 1,
        "state": "RETAINED_FOR_REVIEW",
        "status": "RETAINED_FOR_REVIEW",
        "provider": provider,
        "runRoot": str(run_root),
        "launchId": state.get("launchId"),
        "intentStatus": intent.get("status"),
        "stateVersion": state.get("version"),
        "runtimeRoot": state.get("runtimeRoot"),
        "frozenContract": frozen_contract,
        "cleanupBoundary": {
            "frozenSchemaVersion": frozen_contract["schemaVersion"],
            "frozenSha256": frozen_contract["sha256"],
            "sendIntentPath": str(intent_path),
            "sendIntentExists": True,
        },
        "finalStatus": str(final_status_path),
        "localParityFinal": str(local_parity_path),
        "localParityOk": parity.get("ok"),
        "validationOutcome": "PASS" if parity.get("ok") is True else "LOCAL_DATA_FAIL",
        "markedAt": now(),
    }
    path = run_root / "lifecycle.json"
    if path.exists() or path.is_symlink():
        existing = read_json(path)
        if not isinstance(existing, dict):
            raise RuntimeError(f"refusing to overwrite lifecycle evidence: {path}")
        if existing.get("provider") != provider or existing.get("runRoot") != str(run_root):
            raise RuntimeError(f"lifecycle evidence belongs to another run: {existing}")
        boundary = existing.get("cleanupBoundary")
        if isinstance(boundary, dict) and (
            boundary.get("frozenSchemaVersion") != frozen_contract["schemaVersion"]
            or boundary.get("frozenSha256") != frozen_contract["sha256"]
        ):
            raise RuntimeError(f"provisional lifecycle contract identity does not match the baseline: {existing}")
        if (
            existing.get("state") == "RETAINED_FOR_REVIEW"
            and existing.get("launchId") == state.get("launchId")
            and existing.get("frozenContract") == frozen_contract
            and existing.get("localParityOk") == parity.get("ok")
            and existing.get("validationOutcome") == (
                "PASS" if parity.get("ok") is True else "LOCAL_DATA_FAIL"
            )
        ):
            return {"ok": True, "idempotent": True, "path": str(path), "lifecycle": existing}
        if not (
            (
                existing.get("mutationPerformed") is False
                and existing.get("status") in {"RETAINED_FOR_REVIEW", "RETAINED_LEGACY"}
            )
            or (
                existing.get("state") == "RETAINED_FOR_REVIEW"
                and existing.get("launchId") == state.get("launchId")
            )
        ):
            raise RuntimeError(f"refusing to replace incompatible lifecycle evidence: {path}")
        lifecycle["replacesProvisionalState"] = existing.get("status")
    write_json_atomic(path, lifecycle)
    return {"ok": True, "idempotent": False, "path": str(path), "lifecycle": lifecycle}


def mark_post_send_abandoned(provider: str, run_root: Path, payload: dict[str, Any]) -> dict[str, Any]:
    """Authorize cleanup of one incomplete post-send run without weakening retention.

    This is deliberately narrower than ``mark_retained``: it cannot classify a
    completed three-turn run, and the authorization is bound to the frozen launch and
    first send intent. Merely timing out or losing the renderer is not authorization.
    """
    if not isinstance(payload, dict):
        raise ValueError("mark-post-send-abandoned stdin must be a JSON object")
    if not (
        payload.get("schemaVersion") == 1
        and payload.get("decision") == "abandon"
        and payload.get("impactAcknowledged") is True
        and payload.get("provider") == provider
        and payload.get("runRoot") == str(run_root)
        and isinstance(payload.get("launchId"), str)
        and payload.get("launchId")
        and isinstance(payload.get("userQuote"), str)
        and payload.get("userQuote").strip()
    ):
        raise ValueError("post-send cleanup authorization is incomplete or not bound to this run")

    with lifecycle_gate():
        require_slot_lock(provider, run_root)
        intent_path = run_root / safe_relative(str(RETENTION["sendIntentEvidence"]))
        state_path = run_root / "test-scry-state.json"
        for path in (intent_path, state_path):
            if path.is_symlink() or not path.is_file():
                raise RuntimeError(f"post-send abandonment evidence missing or unsafe: {path}")
        intent = read_json(intent_path)
        state = read_json(state_path)
        compatibility = post_send_cleanup_contract_compatibility(run_root)
        frozen_contract = compatibility.get("frozen") if isinstance(compatibility, dict) else None
        if not isinstance(frozen_contract, dict) or frozen_contract.get("schemaVersion", 0) < 5:
            raise RuntimeError("post-send abandonment contract is neither current nor explicitly cleanup-compatible")
        if not (
            isinstance(intent, dict)
            and isinstance(state, dict)
            and intent.get("turn") == 1
            and intent.get("provider") == provider
            and intent.get("runRoot") == str(run_root)
            and intent.get("status") in {"prepared", "sent"}
            and intent.get("launchId") == state.get("launchId") == payload.get("launchId")
            and state.get("provider") == provider
            and state.get("runRoot") == str(run_root)
        ):
            raise RuntimeError("post-send abandonment identity does not match the owned launch")
        if valid_completed_watch(run_root, provider, state):
            raise RuntimeError("completed evidence must be retained and finalized, not abandoned")

        lifecycle_path = run_root / "lifecycle.json"
        existing = None
        if os.path.lexists(lifecycle_path):
            if lifecycle_path.is_symlink() or not lifecycle_path.is_file():
                raise RuntimeError(f"lifecycle evidence is unsafe: {lifecycle_path}")
            existing = read_json(lifecycle_path)
            if not isinstance(existing, dict):
                raise RuntimeError(f"lifecycle evidence must be a JSON object: {lifecycle_path}")
            existing_state = existing.get("state") or existing.get("status")
            if existing_state == "POST_SEND_ABANDONED":
                if (
                    existing.get("provider") == provider
                    and existing.get("runRoot") == str(run_root)
                    and existing.get("launchId") == payload.get("launchId")
                    and existing.get("cleanupAuthorization") == payload
                    and post_send_cleanup_boundary_matches(existing, run_root)
                ):
                    updated = refresh_slot_owner_locked(provider, run_root, "ABANDONED")
                    return {
                        "ok": True,
                        "idempotent": True,
                        "path": str(lifecycle_path),
                        "lifecycle": existing,
                        "owner": slot_owner_status(updated, provider, run_root),
                    }
                raise RuntimeError("existing post-send abandonment belongs to different evidence")
            provisional = bool(
                existing.get("provider") == provider
                and existing.get("runRoot") == str(run_root)
                and existing.get("mutationPerformed") is False
                and existing.get("status") in {"RETAINED_FOR_REVIEW", "RETAINED_LEGACY"}
            )
            if not provisional:
                raise RuntimeError(f"refusing to replace terminal or incompatible lifecycle evidence: {existing}")

        lifecycle = {
            "schemaVersion": 1,
            "state": "POST_SEND_ABANDONED",
            "status": "POST_SEND_ABANDONED",
            "provider": provider,
            "runRoot": str(run_root),
            "launchId": payload["launchId"],
            "intentStatus": intent.get("status"),
            "frozenContract": frozen_contract,
            "cleanupContractCompatibility": compatibility,
            "cleanupBoundary": {
                "frozenSchemaVersion": frozen_contract["schemaVersion"],
                "frozenSha256": frozen_contract["sha256"],
                "sendIntentPath": str(intent_path),
                "sendIntentExists": True,
            },
            "cleanupAuthorization": payload,
            "replacesProvisionalState": (existing.get("status") if isinstance(existing, dict) else None),
            "markedAt": now(),
        }
        write_json_atomic(lifecycle_path, lifecycle)
        updated = refresh_slot_owner_locked(provider, run_root, "ABANDONED")
    return {
        "ok": True,
        "idempotent": False,
        "path": str(lifecycle_path),
        "lifecycle": lifecycle,
        "owner": slot_owner_status(updated, provider, run_root),
    }


def mark_bootstrap(provider: str, run_root: Path, preflight_path: Path) -> dict[str, Any]:
    require_slot_lock(provider, run_root)
    status = bootstrap_status(provider, preflight_path)
    if (
        not status["repositoriesReady"]
        or not status["settingsReady"]
        or not status["mcpConfigReady"]
        or not status["initRecorderCompatible"]
    ):
        raise RuntimeError(f"bootstrap incomplete: {status}")
    workspace = Path(status["workspace"])
    head = git(["rev-parse", "HEAD"], workspace)
    if head.returncode != 0:
        raise RuntimeError(head.stderr.strip() or "cannot read rate-native HEAD")
    marker = {
        "schemaVersion": 1,
        "provider": provider,
        "slot": slot_for(provider),
        "workspace": str(workspace),
        "bootstrapFingerprint": status["fingerprint"]["sha256"],
        "rateNativeHeadAtBootstrap": head.stdout.strip(),
        "markedAt": now(),
    }
    write_json_atomic(marker_path(provider), marker)
    return {"ok": True, "markerPath": str(marker_path(provider)), "marker": marker}


def reset_bootstrap_inputs(provider: str, run_root: Path) -> dict[str, Any]:
    require_slot_lock(provider, run_root)
    workspace = validate_workspace(provider)
    relative = ".mcp.json"
    unhide = git(["update-index", "--no-skip-worktree", "--", relative], workspace)
    if unhide.returncode != 0:
        raise RuntimeError(unhide.stderr.strip() or f"cannot clear skip-worktree for {relative}")
    restore = git(["checkout", "HEAD", "--", relative], workspace)
    if restore.returncode != 0:
        raise RuntimeError(restore.stderr.strip() or f"cannot restore bootstrap template {relative}")
    return {
        "ok": True,
        "provider": provider,
        "workspace": str(workspace),
        "restored": [relative],
    }


def reconcile_bootstrap(
    provider: str,
    run_root: Path,
    preflight_path: Path,
    scry_bin: str,
) -> dict[str, Any]:
    heartbeat_slot_owner(provider, run_root, "BOOTSTRAP_RECONCILING")
    require_slot_lock(provider, run_root)
    preflight = read_json(preflight_path)
    if not isinstance(preflight, dict) or preflight.get("ok") is not True:
        raise RuntimeError(f"cannot bootstrap from a failed preflight: {preflight_path}")
    expected_cli = preflight.get("versions", {}).get("rateNative", {}).get("cliPath")
    expected_version = preflight.get("versions", {}).get("scry", {}).get("package")
    actual_cli = executable_version(scry_bin)
    if (
        actual_cli.get("path") != expected_cli
        or actual_cli.get("version") != expected_version
        or actual_cli.get("executable") is not True
    ):
        raise RuntimeError(
            f"bootstrap CLI does not match frozen preflight: expected path={expected_cli}, "
            f"version={expected_version}; actual={actual_cli}"
        )
    before = bootstrap_status(provider, preflight_path)
    if before["ready"]:
        heartbeat_slot_owner(provider, run_root, "BOOTSTRAP_READY")
        return {"ok": True, "idempotent": True, "before": before, "after": before}
    if not before["initRecorderCompatible"]:
        raise RuntimeError(f"registry recorder is not compatible with frozen preflight: {before['recorderRegistry']}")

    recovered_marker = quarantine_invalid_marker(
        marker_path(provider),
        run_root,
        "bootstrap-recovery/invalid-marker",
    )
    reset = reset_bootstrap_inputs(provider, run_root)
    settings = restore_local_settings(provider, run_root, scry_bin)
    repositories = seed_warm_repositories(provider, run_root)
    init = run_bootstrap_init(validate_workspace(provider), run_root, scry_bin, settings)
    if init["returnCode"] != 0:
        raise RuntimeError(f"bootstrap init failed; inspect redacted log: {init['logPath']}")
    post_init = bootstrap_status(provider, preflight_path)
    if (
        not post_init["repositoriesReady"]
        or not post_init["settingsReady"]
        or not post_init["mcpConfigReady"]
        or not post_init["initRecorderCompatible"]
    ):
        raise RuntimeError(f"bootstrap postconditions failed; inspect {init['logPath']}: {post_init}")
    marker = mark_bootstrap(provider, run_root, preflight_path)
    after = bootstrap_status(provider, preflight_path)
    if not after["ready"]:
        raise RuntimeError(f"bootstrap marker did not converge: {after}")
    heartbeat_slot_owner(provider, run_root, "BOOTSTRAP_READY")
    return {
        "ok": True,
        "idempotent": False,
        "before": before,
        "recoveredInvalidMarker": recovered_marker,
        "reset": reset,
        "settings": settings,
        "repositories": repositories,
        "init": init,
        "marker": marker,
        "after": after,
    }


def require_slot_lock(provider: str, run_root: Path) -> None:
    path = slot_lock_path(provider)
    if not path.is_file():
        raise RuntimeError(f"slot lock is not held: {path}")
    value = read_json(path)
    if value.get("runRoot") != str(run_root):
        raise RuntimeError(f"slot lock belongs to another run: {value}")


def require_test_app_start_owner(provider: str, run_root: Path) -> dict[str, Any]:
    path = slot_lock_path(provider)
    if path.is_symlink() or not path.is_file():
        raise RuntimeError(f"test App start requires a regular Provider slot lock: {path}")
    value = read_json(path)
    owner = slot_owner_status(value, provider, run_root)
    if not (
        owner.get("valid") is True
        and owner.get("active") is True
        and owner.get("ownerState") == "ACTIVE"
        and owner.get("ownerStage") == "BOOTSTRAP_READY"
    ):
        raise RuntimeError(f"test App start requires the exact ACTIVE/BOOTSTRAP_READY owner: {owner}")
    return owner


def recover_stale_test_app_authorization(run_root: Path, authorization_path: Path) -> dict[str, Any] | None:
    if not os.path.lexists(authorization_path):
        return None
    if authorization_path.is_symlink() or not authorization_path.is_file():
        raise RuntimeError(f"test App start authorization is unsafe: {authorization_path}")
    parse_error = None
    try:
        value = read_json(authorization_path)
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        value = None
        parse_error = f"{type(exc).__name__}: {exc}"
    wrapper_pid = value.get("wrapperPid") if isinstance(value, dict) else None
    wrapper_command = value.get("wrapperCommandSha256") if isinstance(value, dict) else None
    identity_valid = bool(
        isinstance(value, dict)
        and value.get("schemaVersion") == 1
        and value.get("runRoot") == str(run_root)
        and type(wrapper_pid) is int
        and wrapper_pid > 0
        and isinstance(wrapper_command, str)
        and wrapper_command.startswith("sha256:")
        and isinstance(value.get("token"), str)
        and len(value["token"]) >= 32
    )
    current_wrapper_command = process_command_sha256(wrapper_pid) if identity_valid else None
    if identity_valid and current_wrapper_command == wrapper_command:
        raise RuntimeError(f"test App start authorization still has a live wrapper PID: {wrapper_pid}")
    processes = run(["ps", "-axo", "command="], timeout=30)
    if processes.returncode != 0:
        raise RuntimeError("cannot prove stale test App authorization has no matching child")
    matching_child = any(
        "test_scry_app.mjs start-locked" in line
        and (str(run_root) in line or str(authorization_path) in line)
        for line in processes.stdout.splitlines()
    )
    if matching_child:
        raise RuntimeError("test App start authorization still has a matching child process")
    residue = [
        run_root / RECOVERY["runtimeSnapshot"]["relativePath"],
        run_root / "scry-test-user-data",
        run_root / "Scry Test.app",
        run_root / "scry-test.log",
        run_root / "test-scry-state.json",
    ]
    residue.extend(
        run_root / name
        for name in os.listdir(run_root)
        if re.fullmatch(r"test-scry-state\.json\.(?:tmp-\d+|stop\.lock)", name)
    )
    existing = [str(path) for path in residue if os.path.lexists(path)]
    if existing:
        raise RuntimeError(f"stale test App authorization has launch residue requiring review: {existing}")
    recovery_root = run_root / "test-app-recovery"
    recovery_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    destination = recovery_root / f"stale-authorization-{int(time.time() * 1000)}-{uuid.uuid4().hex}.json"
    if os.path.lexists(destination):
        raise RuntimeError(f"stale authorization quarantine destination exists: {destination}")
    authorization_path.replace(destination)
    return {
        "source": str(authorization_path),
        "destination": str(destination),
        "wrapperPid": wrapper_pid,
        "reason": "stale_wrapper" if identity_valid else "malformed_or_identity_invalid",
        "parseError": parse_error,
    }


def start_test_app(
    provider: str,
    run_root: Path,
    scry_repo: Path,
    workspace: Path,
    build_out: Path | None,
    port: int | None,
    runner: Any = subprocess.run,
) -> dict[str, Any]:
    authorization_path = run_root / "test-app-start-authorization.json"
    script = SKILL_DIR / "scripts" / "test_scry_app.mjs"
    with lifecycle_gate() as gate_fd:
        owner = require_test_app_start_owner(provider, run_root)
        expected_workspace = workspace_for(provider).resolve()
        if not scry_repo.is_dir() or scry_repo.resolve() != SCRY_REPO:
            raise RuntimeError(f"test App start requires canonical Scry repo {SCRY_REPO}, got {scry_repo}")
        if not workspace.is_dir() or workspace.resolve() != expected_workspace:
            raise RuntimeError(f"test App start requires fixed workspace {expected_workspace}, got {workspace}")
        if build_out is not None:
            allowed_build_outs = {SCRY_REPO / "out", run_root / "scry-build-out"}
            if build_out.is_symlink() or not build_out.is_dir() or build_out.resolve() not in allowed_build_outs:
                raise RuntimeError(f"test App build output is outside the allowed identities: {build_out}")
        if port is not None and not (1024 <= port <= 65535):
            raise RuntimeError(f"test App CDP port is invalid: {port}")
        recovered_authorization = recover_stale_test_app_authorization(run_root, authorization_path)
        token = uuid.uuid4().hex + uuid.uuid4().hex
        wrapper_command_sha256 = process_command_sha256(os.getpid())
        if wrapper_command_sha256 is None:
            raise RuntimeError("cannot prove the test App start wrapper command identity")
        authorization = {
            "schemaVersion": 1,
            "provider": provider,
            "runRoot": str(run_root),
            "token": token,
            "wrapperPid": os.getpid(),
            "wrapperCommandSha256": wrapper_command_sha256,
            "ownerId": owner.get("ownerId"),
            "ownerStage": owner.get("ownerStage"),
            "createdAt": now(),
        }
        write_json_exclusive(authorization_path, authorization)
        command = [
            "node", str(script), "start-locked",
            "--authorization", str(authorization_path),
            "--lifecycle-gate-fd", str(gate_fd),
            "--run-root", str(run_root),
            "--provider", provider,
            "--scry-repo", str(scry_repo),
            "--workspace", str(workspace),
        ]
        if build_out is not None:
            command.extend(["--build-out", str(build_out)])
        if port is not None:
            command.extend(["--port", str(port)])
        environment = {**os.environ, "SCRY_TEST_START_TOKEN": token}
        try:
            completed = runner(
                command,
                text=True,
                encoding="utf-8",
                errors="replace",
                capture_output=True,
                timeout=120,
                env=environment,
                pass_fds=(gate_fd,),
            )
        finally:
            if authorization_path.is_file() and not authorization_path.is_symlink():
                try:
                    current = read_json(authorization_path)
                except (OSError, UnicodeError, json.JSONDecodeError):
                    current = None
                if isinstance(current, dict) and current.get("token") == token:
                    authorization_path.unlink()
        stdout = completed.stdout if isinstance(completed.stdout, str) else ""
        stderr = completed.stderr if isinstance(completed.stderr, str) else ""
        if completed.returncode != 0:
            raise RuntimeError(f"locked Scry Test start failed: {(stderr or stdout).strip() or f'exit {completed.returncode}'}")
        lines = [line for line in stdout.splitlines() if line.strip()]
        try:
            state = json.loads(lines[-1]) if lines else None
            persisted = read_json(run_root / "test-scry-state.json")
        except (OSError, UnicodeError, json.JSONDecodeError) as exc:
            raise RuntimeError(f"locked Scry Test start returned invalid state: {exc}") from exc
        launch = state.get("launchIdentity") if isinstance(state, dict) else None
        if not (
            isinstance(state, dict)
            and state == persisted
            and state.get("status") == "running"
            and state.get("provider") == provider
            and state.get("runRoot") == str(run_root)
            and state.get("statePath") == str(run_root / "test-scry-state.json")
            and isinstance(launch, dict)
            and launch.get("provider") == provider
            and launch.get("runRoot") == str(run_root)
            and launch.get("ownerId") == owner.get("ownerId")
            and launch.get("ownerStage") == "BOOTSTRAP_READY"
            and state.get("startAuthorization", {}).get("consumed") is True
            and token not in json.dumps(state, ensure_ascii=False)
        ):
            raise RuntimeError(f"locked Scry Test start did not prove one running owned state: {state}")
        return {
            "ok": True,
            "state": state,
            "authorizationConsumed": True,
            "recoveredAuthorization": recovered_authorization,
        }


def release_slot(provider: str, run_root: Path) -> dict[str, Any]:
    require_slot_lock(provider, run_root)
    strict_authorization = terminal_cleanup_authorization(provider, run_root)
    manifest_path = run_root / "workspace-cleanup-after" / "manifest.json"
    if not manifest_path.is_file():
        raise RuntimeError(f"refusing to release slot before after-cleanup: {manifest_path}")
    manifest = read_json(manifest_path)
    if (
        not isinstance(manifest, dict)
        or manifest.get("ok") is not True
        or manifest.get("provider") != provider
        or manifest.get("workspace") != str(workspace_for(provider))
    ):
        raise RuntimeError(f"after-cleanup manifest does not match the slot: {manifest}")
    authorization = manifest.get("cleanupAuthorization")
    lifecycle_path = run_root / "lifecycle.json"
    if not (
        isinstance(authorization, dict)
        and authorization == strict_authorization
        and authorization.get("path") == str(lifecycle_path)
        and isinstance(authorization.get("sha256"), str)
        and lifecycle_path.is_file()
        and not lifecycle_path.is_symlink()
        and authorization.get("sha256") == "sha256:" + hashlib.sha256(lifecycle_path.read_bytes()).hexdigest()
    ):
        raise RuntimeError("after-cleanup manifest has no matching terminal lifecycle authorization")
    for name in FIXED["sharedLocks"]:
        path = shared_lock_path(name)
        if path.is_file() and read_json(path).get("runRoot") == str(run_root):
            raise RuntimeError(f"refusing to release slot while this run still owns shared lock: {path}")
    workspace = workspace_for(provider)
    residue: set[str] = set()
    for raw in FIXED["cleanupExactPaths"]:
        path = workspace / raw
        if path.exists() or path.is_symlink():
            residue.add(str(raw))
    for pattern in FIXED["cleanupGlobPaths"]:
        residue.update(path.relative_to(workspace).as_posix() for path in workspace.glob(pattern))
    if residue:
        raise RuntimeError(f"refusing to release a slot with runtime residue: {sorted(residue)}")
    dirty: list[str] = []
    if workspace_own_changes(workspace):
        dirty.append(str(workspace))
    for raw in sorted(nested_warm_repositories(workspace)):
        repo = workspace / raw
        status = git(["-C", str(repo), "status", "--porcelain=v1", "--untracked-files=all"], workspace)
        if status.returncode != 0:
            raise RuntimeError(status.stderr.strip() or f"cannot verify repository cleanliness: {repo}")
        if status.stdout:
            dirty.append(str(repo))
    if dirty:
        raise RuntimeError(f"refusing to release a slot with dirty repositories: {dirty}")
    return release_lock(slot_lock_path(provider), run_root)


def prepare(provider: str, run_root: Path, expected_head: str) -> dict[str, Any]:
    heartbeat_slot_owner(provider, run_root, "WORKSPACE_PREPARING")
    require_slot_lock(provider, run_root)
    workspace = validate_workspace(provider)
    own = workspace_own_changes(workspace)
    if own:
        raise RuntimeError(
            "fixed workspace has tracked or non-ignored changes; sanitize/quarantine "
            f"before prepare: {own!r}"
        )
    commit = git(["cat-file", "-e", f"{expected_head}^{{commit}}"], workspace)
    if commit.returncode != 0:
        raise RuntimeError(f"expected HEAD is unavailable in fixed worktree: {expected_head}")
    reset = git(["reset", "--hard", expected_head], workspace)
    if reset.returncode != 0:
        raise RuntimeError(reset.stderr.strip() or "git reset failed")
    actual = git(["rev-parse", "HEAD"], workspace)
    if actual.returncode != 0 or actual.stdout.strip() != expected_head:
        raise RuntimeError(f"fixed workspace HEAD mismatch after reset: {actual.stdout.strip()}")
    heartbeat_slot_owner(provider, run_root, "WORKSPACE_PREPARED")
    return {
        "ok": True,
        "provider": provider,
        "slot": slot_for(provider),
        "workspace": str(workspace),
        "head": expected_head,
        "bootstrap": bootstrap_status(provider),
    }


def self_test_workspace_cleanliness(root: Path) -> None:
    """A nested warm repository must never be mistaken for the parent's own dirt.

    Three separate steps judged this independently and each one blocked a run in turn:
    `sanitize` archived `rate-doc` away, `release_slot` refused the slot, then `prepare`
    refused the workspace. They now share `workspace_own_changes`, and every future
    cleanliness check must too.
    """
    workspace = root / "cleanliness" / "rate-native"
    workspace.mkdir(parents=True)
    for arguments in (
        ["init", "-q"],
        ["config", "user.name", "fixture"],
        ["config", "user.email", "fixture@example.invalid"],
    ):
        assert git(arguments, workspace).returncode == 0, arguments
    (workspace / "README.md").write_text("tracked\n", encoding="utf-8")
    assert git(["add", "-A"], workspace).returncode == 0
    assert git(["commit", "-q", "-m", "fixture"], workspace).returncode == 0
    assert workspace_own_changes(workspace) == []

    # `rate-doc` is the one warm repository the workspace `.gitignore` does not list, so
    # it surfaces in the parent's status and must not count as the parent's dirt. A
    # healthy clone collapses to `?? rate-doc/`; a half-cloned one lists its files.
    nested = workspace / "rate-doc"
    nested.mkdir()
    (nested / "OVERVIEW.md").write_text("doc\n", encoding="utf-8")
    assert nested_warm_repositories(workspace) == frozenset({"rate-doc"}), workspace
    half_cloned = git(["status", "--porcelain=v1", "--untracked-files=all"], workspace).stdout
    assert "rate-doc/OVERVIEW.md" in half_cloned, half_cloned
    assert workspace_own_changes(workspace) == [], workspace_own_changes(workspace)

    for arguments in (
        ["init", "-q"],
        ["config", "user.name", "fixture"],
        ["config", "user.email", "fixture@example.invalid"],
        ["add", "-A"],
        ["commit", "-q", "-m", "doc"],
    ):
        assert git(arguments, nested).returncode == 0, arguments
    healthy = git(["status", "--porcelain=v1", "--untracked-files=all"], workspace).stdout
    assert healthy.strip() == "?? rate-doc/", healthy
    assert workspace_own_changes(workspace) == [], workspace_own_changes(workspace)

    # Real dirt still blocks, and is reported verbatim.
    (workspace / "stray.txt").write_text("dirt\n", encoding="utf-8")
    assert workspace_own_changes(workspace) == ["?? stray.txt"], workspace_own_changes(workspace)
    (workspace / "README.md").write_text("modified\n", encoding="utf-8")
    assert " M README.md" in workspace_own_changes(workspace)

    assert porcelain_path("?? rate-doc/") == "rate-doc"
    assert porcelain_path("R  old.md -> new.md") == "new.md"
    assert under_nested_repository("rate-doc", frozenset({"rate-doc"})) is True
    assert under_nested_repository("rate-doc/\u6a21\u578b/a.md", frozenset({"rate-doc"})) is True
    assert under_nested_repository("rate-doctor", frozenset({"rate-doc"})) is False


def self_test() -> int:
    global shared_lock_path, lock_root, workspace_for
    fixture = """
1     available    ~/.treehouse/rate-native-3b0c3e/1/rate-native
2     leased       ~/.treehouse/rate-native-3b0c3e/2/rate-native  (held by validate-scry-rate-workflow:fixed:claude)
noise
"""
    parsed = parse_treehouse_status(fixture)
    assert parsed[1]["state"] == "available"
    assert parsed[2]["holder"] == "validate-scry-rate-workflow:fixed:claude"
    RUN_ROOT_PARENT.mkdir(parents=True, exist_ok=True, mode=0o700)
    gate_probe_code = (
        "import fcntl,os,sys; "
        "fd=os.open(sys.argv[1],os.O_RDWR|os.O_CREAT,0o600); "
        "\ntry: fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)"
        "\nexcept BlockingIOError: sys.exit(2)"
        "\nelse: fcntl.flock(fd,fcntl.LOCK_UN); sys.exit(0)"
    )

    def probe_gate(path: Path) -> int:
        return subprocess.run(
            [sys.executable, "-c", gate_probe_code, str(path)],
            text=True,
            capture_output=True,
            check=False,
        ).returncode

    original_lock_root = lock_root
    original_workspace_for = workspace_for
    with tempfile.TemporaryDirectory(prefix=RUN_PREFIX, dir=RUN_ROOT_PARENT) as launch_raw:
        launch_run = Path(launch_raw).resolve()
        fixture_lock_root = launch_run / "fixture-locks"
        fixture_lock_root.mkdir()
        fixture_workspace = launch_run / "workspace-fixture"
        fixture_workspace.mkdir()
        lock_root = lambda: fixture_lock_root
        workspace_for = lambda provider: fixture_workspace
        try:
            owner_value = slot_owner_value("codex", launch_run, "BOOTSTRAP_READY")
            write_json_exclusive(slot_lock_path("codex"), owner_value)
            gate_path = fixture_lock_root.parent / "lifecycle.lock"

            with lifecycle_gate() as inherited_gate_fd:
                inherited = subprocess.Popen(
                    [sys.executable, "-c", "import sys; sys.stdin.read(1)"],
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                    pass_fds=(inherited_gate_fd,),
                )
                assert probe_gate(gate_path) == 2
            assert probe_gate(gate_path) == 2
            inherited.communicate("x", timeout=5)
            assert inherited.returncode == 0
            assert probe_gate(gate_path) == 0

            def fake_start(command: list[str], **kwargs: Any) -> subprocess.CompletedProcess[str]:
                assert probe_gate(gate_path) == 2
                assert tuple(kwargs["pass_fds"])
                assert command[command.index("--lifecycle-gate-fd") + 1] == str(kwargs["pass_fds"][0])
                authorization_path = Path(command[command.index("--authorization") + 1])
                authorization = read_json(authorization_path)
                assert kwargs["env"]["SCRY_TEST_START_TOKEN"] == authorization["token"]
                state = {
                    "status": "running",
                    "provider": "codex",
                    "runRoot": str(launch_run),
                    "statePath": str(launch_run / "test-scry-state.json"),
                    "startAuthorization": {"consumed": True},
                    "launchIdentity": {
                        "provider": "codex",
                        "runRoot": str(launch_run),
                        "ownerId": owner_value["ownerId"],
                        "ownerStage": "BOOTSTRAP_READY",
                    },
                }
                write_json_atomic(launch_run / "test-scry-state.json", state)
                return subprocess.CompletedProcess(command, 0, json.dumps(state) + "\n", "")

            started = start_test_app(
                "codex",
                launch_run,
                SCRY_REPO,
                fixture_workspace,
                None,
                None,
                runner=fake_start,
            )
            assert started["ok"] is True
            assert not os.path.lexists(launch_run / "test-app-start-authorization.json")
            assert probe_gate(gate_path) == 0
        finally:
            lock_root = original_lock_root
            workspace_for = original_workspace_for

    with tempfile.TemporaryDirectory(prefix=RUN_PREFIX, dir=RUN_ROOT_PARENT) as failure_raw:
        failure_run = Path(failure_raw).resolve()
        fixture_lock_root = failure_run / "fixture-locks"
        fixture_lock_root.mkdir()
        fixture_workspace = failure_run / "workspace-fixture"
        fixture_workspace.mkdir()
        lock_root = lambda: fixture_lock_root
        workspace_for = lambda provider: fixture_workspace
        try:
            write_json_exclusive(slot_lock_path("codex"), slot_owner_value("codex", failure_run, "BOOTSTRAP_READY"))
            gate_path = fixture_lock_root.parent / "lifecycle.lock"

            def failing_start(*_args: Any, **_kwargs: Any) -> subprocess.CompletedProcess[str]:
                assert probe_gate(gate_path) == 2
                raise subprocess.TimeoutExpired("fixture", 1)

            try:
                start_test_app(
                    "codex", failure_run, SCRY_REPO, fixture_workspace, None, None,
                    runner=failing_start,
                )
                raise AssertionError("injected start failure was accepted")
            except subprocess.TimeoutExpired:
                pass
            assert not os.path.lexists(failure_run / "test-app-start-authorization.json")
            assert probe_gate(gate_path) == 0

            stale_auth = failure_run / "test-app-start-authorization.json"
            write_json_exclusive(stale_auth, {
                "schemaVersion": 1,
                "provider": "codex",
                "runRoot": str(failure_run),
                "token": "x" * 64,
                "wrapperPid": os.getpid(),
                "wrapperCommandSha256": "sha256:reused-by-different-command",
            })
            recovered = recover_stale_test_app_authorization(failure_run, stale_auth)
            assert recovered is not None and recovered["reason"] == "stale_wrapper"
            assert not os.path.lexists(stale_auth) and Path(recovered["destination"]).is_file()

            stale_auth.write_text("{broken\n", encoding="utf-8")
            malformed = recover_stale_test_app_authorization(failure_run, stale_auth)
            assert malformed is not None and malformed["reason"] == "malformed_or_identity_invalid"
            assert "JSONDecodeError" in str(malformed["parseError"])
            assert not os.path.lexists(stale_auth) and Path(malformed["destination"]).is_file()
        finally:
            lock_root = original_lock_root
            workspace_for = original_workspace_for

    with tempfile.TemporaryDirectory(prefix=RUN_PREFIX, dir=RUN_ROOT_PARENT) as raw:
        run_root = Path(raw).resolve()
        assert safe_run_root(raw) == run_root
        (run_root / "local-parity-final.json").write_text('{"ok":true}\n', encoding="utf-8")
        snapshot_config = RECOVERY["runtimeSnapshot"]
        snapshot_root = run_root / str(snapshot_config["relativePath"])
        (snapshot_root / "out").mkdir(parents=True)
        (snapshot_root / "out" / "entry.js").write_text("fixture\n", encoding="utf-8")
        snapshot_fingerprint = tree_fingerprint(snapshot_root / "out")
        state_path = run_root / "test-scry-state.json"
        state = {
            "version": snapshot_config["stateVersion"],
            "status": "running",
            "runtimeRoot": str(snapshot_root),
            "launchId": "fixture-launch",
            "pid": 123,
            "port": 456,
            "userDataDir": str(run_root / "scry-test-user-data"),
            "expectedWorkspace": str(run_root / "workspace-fixture"),
            "buildSnapshot": {"snapshotFingerprint": snapshot_fingerprint},
        }
        state_path.write_text(json.dumps(state), encoding="utf-8")
        intent_path = run_root / str(RETENTION["sendIntentEvidence"])
        intent_path.write_text(json.dumps({
            "turn": 1,
            "status": "sent",
            "launchId": state["launchId"],
            "provider": "codex",
            "runRoot": str(run_root),
        }), encoding="utf-8")
        final_status = {
            **state,
            "processAlive": True,
            "commandMatches": True,
            "cdpReachable": True,
            "cdpClosed": False,
            "cdpReady": True,
            "ownedRendererReady": True,
            "ownedRendererCount": 1,
            "rendererOwnershipLive": {"status": "verified"},
            "buildSnapshotLive": snapshot_fingerprint,
            "runtimeSnapshotReady": True,
        }
        (run_root / "test-scry-status-final.json").write_text(json.dumps(final_status), encoding="utf-8")
        (run_root / "turn-session.json").write_text(json.dumps({
            "runRoot": str(run_root),
            "provider": "codex",
            "workspace": state["expectedWorkspace"],
            "launchId": state["launchId"],
            "sessionId": "session-fixture",
        }), encoding="utf-8")
        (run_root / "turn-watch.jsonl").write_text(json.dumps({
            "state": "COMPLETED",
            "provider": "codex",
            "workspace": state["expectedWorkspace"],
            "expectedTurns": 3,
            "sessionId": "session-fixture",
            "providerTurnIds": ["turn-1", "turn-2", "turn-3"],
            "renderer": {"identity": True, "busy": False, "turnCount": 3},
            "persistence": {"state": "ready", "selected": {"sessionId": "session-fixture"}},
        }) + "\n", encoding="utf-8")
        contract_identity = current_contract_identity()
        (run_root / "preflight.json").write_text(json.dumps({
            "ok": True,
            "provider": "codex",
            "contractSchemaVersion": contract_identity["schemaVersion"],
            "contract": contract_identity,
        }), encoding="utf-8")
        (run_root / "lifecycle.json").write_text(json.dumps({
            "schemaVersion": 1,
            "state": "RETAINED_FOR_REVIEW",
            "provider": "codex",
            "runRoot": str(run_root),
            "launchId": state["launchId"],
            "frozenContract": contract_identity,
            "localParityOk": True,
            "validationOutcome": "PASS",
        }), encoding="utf-8")
        assert retained_review_is_finalized(str(run_root), True) is True
        assert retained_review_is_finalized(str(run_root), False) is True
        (run_root / "local-parity-final.json").write_text('{"ok":false}\n', encoding="utf-8")
        assert retained_review_is_finalized(str(run_root), True) is False
        lifecycle_value = read_json(run_root / "lifecycle.json")
        lifecycle_value.update({"localParityOk": False, "validationOutcome": "LOCAL_DATA_FAIL"})
        (run_root / "lifecycle.json").write_text(json.dumps(lifecycle_value), encoding="utf-8")
        assert retained_review_is_finalized(str(run_root), True) is True
        (run_root / "local-parity-final.json").write_text('{"ok":true}\n', encoding="utf-8")
        lifecycle_value.update({"localParityOk": True, "validationOutcome": "PASS"})
        (run_root / "lifecycle.json").write_text(json.dumps(lifecycle_value), encoding="utf-8")
        assert classify_slot_run(str(run_root)) == "WAITING_FOR_REVIEW_CLEANUP"
        with (
            tempfile.TemporaryDirectory(prefix=RUN_PREFIX, dir=RUN_ROOT_PARENT) as recovery_raw,
            tempfile.TemporaryDirectory(prefix=RUN_PREFIX, dir=RUN_ROOT_PARENT) as target_raw,
        ):
            recovery_run = Path(recovery_raw).resolve()
            target_run = Path(target_raw).resolve()
            target_intent = target_run / str(RETENTION["sendIntentEvidence"])
            target_boundary = {
                "frozenSchemaVersion": contract_identity["schemaVersion"],
                "frozenSha256": contract_identity["sha256"],
                "sendIntentPath": str(target_intent),
                "sendIntentExists": False,
            }
            (target_run / "preflight.json").write_text(json.dumps({
                "ok": True,
                "provider": "qoder",
                "contractSchemaVersion": contract_identity["schemaVersion"],
                "contract": contract_identity,
            }), encoding="utf-8")
            (target_run / "lifecycle.json").write_text(json.dumps({
                "schemaVersion": 1,
                "state": "CLEANUP_FAILED",
                "provider": "qoder",
                "runRoot": str(target_run),
                "cleanupBoundary": target_boundary,
            }), encoding="utf-8")
            target_slot = slot_owner_value("qoder", target_run, "FINALIZE_FAILED")
            review_slot = slot_owner_value("codex", run_root, "RETAINED_FOR_REVIEW")
            assert classify_slot_run(str(target_run), target_slot) == "PRE_SEND_RECOVERY_REQUIRED"
            original_pool_root = FIXED["poolRoot"]
            try:
                FIXED["poolRoot"] = str(run_root / "review-clearance-pool")
                lock_root().mkdir(parents=True, exist_ok=True, mode=0o700)
                write_json_exclusive(slot_lock_path("qoder"), target_slot)
                write_json_exclusive(slot_lock_path("codex"), review_slot)
                require_no_other_active_slot_runs(
                    recovery_run,
                    require_build_snapshot=False,
                    allowed_pre_send_recovery=("qoder", target_run),
                )
            finally:
                FIXED["poolRoot"] = original_pool_root
        (snapshot_root / "out" / "entry.js").write_text("drifted\n", encoding="utf-8")
        assert retained_review_is_finalized(str(run_root), False) is False
        (snapshot_root / "out" / "entry.js").write_text("fixture\n", encoding="utf-8")
        (run_root / "lifecycle.json").unlink()
        assert retained_review_is_finalized(str(run_root), True) is False
        assert retained_review_is_finalized(str(run_root), False) is False
        intent_path.unlink()
        active_slot = slot_owner_value("codex", run_root, "BOOTSTRAP_READY")
        assert classify_slot_run(str(run_root), active_slot) == "PRE_SEND_ACTIVE"
        draft_path = run_root / str(RETENTION["draftEvidence"])
        draft_path.write_text(json.dumps({
            "schemaVersion": 1,
            "status": "drafted",
            "runRoot": str(run_root),
            "provider": "codex",
            "turn": 1,
            "workitemId": "85237895",
            "text": "fixture draft text",
            "localEqualityOnly": False,
            "launchId": state["launchId"],
            "pid": 1,
            "port": 9222,
            "draftedAt": now(),
        }), encoding="utf-8")
        assert classify_slot_run(str(run_root), active_slot) == "WAITING_FOR_DRAFT_CLEANUP"
        draft_path.unlink()
        assert classify_slot_run(str(run_root), active_slot) == "PRE_SEND_ACTIVE"
        cleanup_boundary = {
            "frozenSchemaVersion": contract_identity["schemaVersion"],
            "frozenSha256": contract_identity["sha256"],
            "sendIntentPath": str(intent_path),
            "sendIntentExists": False,
        }
        (run_root / "lifecycle.json").write_text(json.dumps({
            "schemaVersion": 1,
            "state": "CLEANUP_FAILED",
            "provider": "codex",
            "runRoot": str(run_root),
            "cleanupBoundary": cleanup_boundary,
        }), encoding="utf-8")
        assert classify_slot_run(str(run_root), active_slot) == "PRE_SEND_ACTIVE"
        failed_slot = slot_owner_value("codex", run_root, "FINALIZE_FAILED", active_slot)
        assert classify_slot_run(str(run_root), failed_slot) == "PRE_SEND_RECOVERY_REQUIRED"
        original_pool_root = FIXED["poolRoot"]
        with (
            tempfile.TemporaryDirectory(prefix=RUN_PREFIX, dir=RUN_ROOT_PARENT) as recovery_raw,
            tempfile.TemporaryDirectory(prefix=RUN_PREFIX, dir=RUN_ROOT_PARENT) as active_raw,
            tempfile.TemporaryDirectory(prefix=RUN_PREFIX, dir=RUN_ROOT_PARENT) as legacy_raw,
        ):
            recovery_run = Path(recovery_raw).resolve()
            active_run = Path(active_raw).resolve()
            legacy_run = Path(legacy_raw).resolve()
            try:
                FIXED["poolRoot"] = str(run_root / "cleanup-clearance-pool")
                lock_root().mkdir(parents=True, exist_ok=True, mode=0o700)
                write_json_exclusive(slot_lock_path("codex"), failed_slot)
                require_no_other_active_slot_runs(
                    recovery_run,
                    require_build_snapshot=False,
                    allowed_pre_send_recovery=("codex", run_root),
                )

                (active_run / "preflight.json").write_text(json.dumps({
                    "ok": True,
                    "provider": "qoder",
                    "contractSchemaVersion": contract_identity["schemaVersion"],
                    "contract": contract_identity,
                }), encoding="utf-8")
                active_other_slot = slot_owner_value("qoder", active_run, "BOOTSTRAP_READY")
                assert classify_slot_run(str(active_run), active_other_slot) == "PRE_SEND_ACTIVE"
                write_json_exclusive(slot_lock_path("qoder"), active_other_slot)
                try:
                    require_no_other_active_slot_runs(
                        recovery_run,
                        require_build_snapshot=False,
                        allowed_pre_send_recovery=("codex", run_root),
                    )
                    raise AssertionError("cleanup CLI mutation crossed an active Provider slot")
                except RuntimeError as exc:
                    assert "cannot cross another Provider slot" in str(exc)
                    assert "PRE_SEND_ACTIVE" in str(exc)
                slot_lock_path("qoder").unlink()

                legacy_other_slot = slot_owner_value("claude", legacy_run, "BOOTSTRAP_READY")
                assert classify_slot_run(str(legacy_run), legacy_other_slot) == "WAITING_FOR_LEGACY_CLEANUP"
                write_json_exclusive(slot_lock_path("claude"), legacy_other_slot)
                try:
                    require_no_other_active_slot_runs(
                        recovery_run,
                        require_build_snapshot=False,
                        allowed_pre_send_recovery=("codex", run_root),
                    )
                    raise AssertionError("cleanup CLI mutation crossed a legacy Provider slot")
                except RuntimeError as exc:
                    assert "cannot cross another Provider slot" in str(exc)
                    assert "WAITING_FOR_LEGACY_CLEANUP" in str(exc)
            finally:
                FIXED["poolRoot"] = original_pool_root
        (run_root / "lifecycle.json").unlink()
        (run_root / "pre-send-archive-prepared.json").write_text(json.dumps({
            "schemaVersion": 1,
            "state": "PRE_SEND_ARCHIVE_PREPARED",
            "provider": "codex",
            "runRoot": str(run_root),
            "cleanupBoundary": cleanup_boundary,
        }), encoding="utf-8")
        assert classify_slot_run(str(run_root), active_slot) == "PRE_SEND_RECOVERY_REQUIRED"
        (run_root / "pre-send-archive-prepared.json").unlink()
        original_pool_root = FIXED["poolRoot"]
        try:
            FIXED["poolRoot"] = str(run_root / "owner-pool")
            claimed = claim_slot("codex", run_root)
            assert slot_owner_status(claimed["lock"], "codex", run_root)["active"] is True
            intent_payload = {
                "schemaVersion": 1,
                "status": "prepared",
                "runRoot": str(run_root),
                "provider": "codex",
                "turn": 1,
                "workitemId": "85237895",
                "text": "/rate-workflow 85237895 理解prd后停下",
                "localEqualityOnly": False,
                "launchId": "fixture-launch",
                "pid": 123,
                "port": 4567,
                "preparedAt": now(),
            }
            prepared_intent = prepare_send_intent("codex", run_root, 1, intent_payload)
            assert prepared_intent["ok"] is True
            assert prepared_intent["owner"]["ownerStage"] == "TURN1_INTENT_PREPARED"
            assert read_json(intent_path) == intent_payload
            try:
                prepare_send_intent("codex", run_root, 1, intent_payload)
                raise AssertionError("duplicate send intent was accepted")
            except RuntimeError as exc:
                assert "already exists" in str(exc)
            test_state_path = run_root / "test-scry-state.json"
            test_state_path.write_text(json.dumps({
                "provider": "codex",
                "runRoot": str(run_root),
                "launchId": "fixture-launch",
            }), encoding="utf-8")
            authorization = {
                "schemaVersion": 1,
                "decision": "abandon",
                "impactAcknowledged": True,
                "provider": "codex",
                "runRoot": str(run_root),
                "launchId": "fixture-launch",
                "userQuote": "清理这个旧运行并重跑",
            }
            abandoned = mark_post_send_abandoned("codex", run_root, authorization)
            assert abandoned["ok"] is True and abandoned["idempotent"] is False
            assert abandoned["owner"]["ownerStage"] == "ABANDONED"
            assert terminal_cleanup_authorization("codex", run_root)["state"] == "POST_SEND_ABANDONED"
            abandoned_lock = read_json(slot_lock_path("codex"))
            assert classify_slot_run(str(run_root), abandoned_lock) == "WAITING_FOR_ABANDONED_CLEANUP"
            assert mark_post_send_abandoned("codex", run_root, authorization)["idempotent"] is True
            (run_root / "lifecycle.json").unlink()
            test_state_path.unlink()
            write_json_atomic(
                slot_lock_path("codex"),
                slot_owner_value("codex", run_root, "TURN1_INTENT_PREPARED", abandoned_lock),
            )
        finally:
            FIXED["poolRoot"] = original_pool_root
        intent_path.unlink()
        intent_path.write_text('{}\n', encoding="utf-8")
        assert classify_slot_run(str(run_root), active_slot) == "WAITING_FOR_ACTIVE_REVIEW_FINALIZATION"
        settings_fixture = run_root / "settings.json"
        settings_fixture.write_text(
            json.dumps({"env": {"NEXTCR_API_KEY": "fixture-secret", "SCRY_CLI_PATH": "/fixture/scry"}}),
            encoding="utf-8",
        )
        redacted = redact_init_log(
            "token=fixture-secret cli=/fixture/scry",
            {"source": str(settings_fixture), "targets": []},
        )
        assert "fixture-secret" not in redacted and "/fixture/scry" not in redacted
        intent_path.unlink()
        current_identity = current_contract_identity()
        write_json_atomic(run_root / "preflight-build-cache.json", {
            "ok": True,
            "contractSchemaVersion": current_identity["schemaVersion"],
            "contract": dict(current_identity),
        })
        original_pool_root = FIXED["poolRoot"]
        try:
            FIXED["poolRoot"] = str(run_root / "prepared-authorization-pool")
            lock_root().mkdir(parents=True, exist_ok=True, mode=0o700)
            write_json_exclusive(
                slot_lock_path("qoder"),
                slot_owner_value("qoder", run_root, "FINALIZING"),
            )
            write_json_atomic(run_root / "lifecycle.json", {
                "schemaVersion": 1,
                "state": "PRE_SEND_ARCHIVE_PREPARED",
                "status": "PRE_SEND_ARCHIVE_PREPARED",
                "provider": "qoder",
                "runRoot": str(run_root),
                "cleanupBoundary": {
                    "frozenSchemaVersion": current_identity["schemaVersion"],
                    "frozenSha256": current_identity["sha256"],
                },
                "ok": True,
                "mutationPerformed": False,
            })
            prepared_authorization = terminal_cleanup_authorization("qoder", run_root)
            assert prepared_authorization["state"] == "PRE_SEND_ARCHIVE_PREPARED"
            assert prepared_authorization["path"] == str(run_root / "lifecycle.json")
            intent_path.write_text("{}\n", encoding="utf-8")
            try:
                terminal_cleanup_authorization("qoder", run_root)
                raise AssertionError("prepared authorization survived a send intent")
            except RuntimeError:
                pass
            intent_path.unlink()
            drifted_boundary = {
                "schemaVersion": 1,
                "state": "PRE_SEND_ARCHIVE_PREPARED",
                "status": "PRE_SEND_ARCHIVE_PREPARED",
                "provider": "qoder",
                "runRoot": str(run_root),
                "cleanupBoundary": {
                    "frozenSchemaVersion": current_identity["schemaVersion"],
                    "frozenSha256": "sha256:drifted",
                },
                "ok": True,
                "mutationPerformed": False,
            }
            write_json_atomic(run_root / "lifecycle.json", drifted_boundary)
            try:
                terminal_cleanup_authorization("qoder", run_root)
                raise AssertionError("prepared authorization survived a boundary drift")
            except RuntimeError:
                pass
        finally:
            FIXED["poolRoot"] = original_pool_root
        (run_root / "lifecycle.json").unlink()
        (run_root / "preflight-build-cache.json").unlink()
        mcp_repo = run_root / "mcp-fixture-repo"
        mcp_repo.mkdir()
        mcp_git = ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false"]
        git(["init", "--quiet"], mcp_repo)
        oauth_template = {
            "mcpServers": {"ai_native_trace_report": {"type": "http", "url": "https://trace.example.invalid/"}}
        }
        write_json_atomic(mcp_repo / ".mcp.json", oauth_template)
        git([*mcp_git, "add", ".mcp.json"], mcp_repo)
        git([*mcp_git, "commit", "--quiet", "--no-verify", "-m", "fixture-oauth"], mcp_repo)
        assert mcp_config_status(mcp_repo)["ready"] is True
        bearer_template = {
            "mcpServers": {
                "ai_native_trace_report": {
                    "type": "http",
                    "url": "https://trace.example.invalid/",
                    "headers": {"Authorization": "Bearer template"},
                }
            }
        }
        write_json_atomic(mcp_repo / ".mcp.json", bearer_template)
        git([*mcp_git, "commit", "--quiet", "--no-verify", "-am", "fixture-bearer"], mcp_repo)
        materialized = json.loads(json.dumps(bearer_template))
        materialized["mcpServers"]["ai_native_trace_report"]["headers"]["Authorization"] = "Bearer real-secret"
        write_json_atomic(mcp_repo / ".mcp.json", materialized)
        assert mcp_config_status(mcp_repo)["ready"] is True
        half_materialized = json.loads(json.dumps(bearer_template))
        half_materialized["mcpServers"]["ai_native_trace_report"]["headers"]["Authorization"] = "Bearer ${TOKEN}"
        write_json_atomic(mcp_repo / ".mcp.json", half_materialized)
        assert mcp_config_status(mcp_repo)["issues"] == ["trace_credential_not_materialized"]
        drifted = json.loads(json.dumps(oauth_template))
        drifted["mcpServers"]["ai_native_trace_report"]["url"] = "https://drifted.example.invalid/"
        write_json_atomic(mcp_repo / ".mcp.json", drifted)
        assert mcp_config_status(mcp_repo)["issues"] == ["structure_or_endpoint_differs_from_HEAD"]
        shutil.rmtree(mcp_repo)
        with tempfile.TemporaryDirectory(dir="/tmp") as locks_raw:
            lock = Path(locks_raw) / "lock.json"
            first = claim_lock(lock, "fixture", run_root)
            second = claim_lock(lock, "fixture", run_root)
            assert first["idempotent"] is False and second["idempotent"] is True
            assert release_lock(lock, run_root)["alreadyReleased"] is False
            assert release_lock(lock, run_root)["alreadyReleased"] is True
            foreign_process_lock = Path(locks_raw) / "foreign-process-lock.json"
            write_json_exclusive(
                foreign_process_lock,
                {
                    "schemaVersion": 2,
                    "scope": "fixture",
                    "provider": None,
                    "runRoot": str(run_root),
                    "claimedAt": now(),
                    "ownerPid": os.getpid() + 1,
                    "ownerCommandSha256": "sha256:foreign",
                },
            )
            try:
                claim_lock(foreign_process_lock, "fixture", run_root, process_owned=True)
                raise AssertionError("different process must not claim an existing process-owned lock")
            except RuntimeError as exc:
                assert "another process" in str(exc)
            mutation_locks = Path(locks_raw) / "mutation-locks"
            mutation_locks.mkdir()
            original_shared_lock_path = shared_lock_path
            try:
                shared_lock_path = lambda name: mutation_locks / f"shared-{name}.json"
                corrupt_lock = shared_lock_path("environment")
                corrupt_lock.write_text('{"schemaVersion":2,"ownerPid":', encoding="utf-8")
                recovered = recover_stale_mutation_locks(run_root)
                assert len(recovered) == 1
                assert recovered[0]["reason"] == "corrupt_lock_quarantined"
                assert not os.path.lexists(corrupt_lock)
                assert Path(recovered[0]["destination"]).read_text(encoding="utf-8") == (
                    '{"schemaVersion":2,"ownerPid":'
                )

                corrupt_lock.write_bytes(b"\xff")
                recovered = recover_stale_mutation_locks(run_root)
                assert len(recovered) == 1
                assert "UnicodeDecodeError" in recovered[0]["parseError"]

                corrupt_lock.write_text("[]\n", encoding="utf-8")
                recovered = recover_stale_mutation_locks(run_root)
                assert len(recovered) == 1
                assert recovered[0]["parseError"] == "lock JSON is not an object"

                unsafe_target = mutation_locks / "unsafe-target.json"
                unsafe_target.write_text("{}\n", encoding="utf-8")
                corrupt_lock.symlink_to(unsafe_target)
                try:
                    recover_stale_mutation_locks(run_root)
                    raise AssertionError("symlinked mutation lock was recovered")
                except RuntimeError as exc:
                    assert "unsafe shared mutation lock" in str(exc)
                corrupt_lock.unlink()
                unsafe_target.unlink()

                corrupt_lock.mkdir()
                try:
                    recover_stale_mutation_locks(run_root)
                    raise AssertionError("non-regular mutation lock was recovered")
                except RuntimeError as exc:
                    assert "unsafe shared mutation lock" in str(exc)
                corrupt_lock.rmdir()
            finally:
                shared_lock_path = original_shared_lock_path
        workspace = run_root / "workspace"
        workspace.mkdir()
        for relative in ("a", "b"):
            (workspace / relative).write_text(relative, encoding="utf-8")
        original_inputs = FIXED["bootstrapInputs"]
        try:
            FIXED["bootstrapInputs"] = ["a", "b"]
            first_hash = input_fingerprint(workspace)["sha256"]
            (workspace / "b").write_text("changed", encoding="utf-8")
            second_hash = input_fingerprint(workspace)["sha256"]
            assert first_hash != second_hash
            assert git(["init"], workspace).returncode == 0
            assert git(["config", "user.name", "fixture"], workspace).returncode == 0
            assert git(["config", "user.email", "fixture@example.invalid"], workspace).returncode == 0
            assert git(["add", "a", "b"], workspace).returncode == 0
            assert git(["commit", "-m", "fixture"], workspace).returncode == 0
            tracked_hash = input_fingerprint(workspace)["sha256"]
            (workspace / "b").write_text("local-only", encoding="utf-8")
            assert input_fingerprint(workspace)["sha256"] == tracked_hash
            (workspace / "plain-directory").mkdir()
            assert is_repository_root(workspace / "plain-directory", workspace) is False
        finally:
            FIXED["bootstrapInputs"] = original_inputs
        preflight = run_root / "preflight.json"
        preflight.write_text(
            json.dumps(
                {
                    "git": {"scry": {"head": "abc", "treeHash": "treeabc", "dirty": False, "worktreeHash": "sha256:source"}},
                    "buildArtifacts": {"treeHash": "sha256:out"},
                }
            ),
            encoding="utf-8",
        )
        assert build_identity(preflight)["buildArtifacts"]["treeHash"] == "sha256:out"
        assert build_identity(preflight)["scryTreeHash"] == "treeabc"
        explicit_out = run_root / "scry-build-out"
        for relative in ("main/index.js", "preload/index.cjs", "renderer/index.html", "renderer/assets/index.js"):
            target = explicit_out / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text("fixture\n", encoding="utf-8")
        explicit_identity = {
            "buildArtifacts": {"exists": True, **tree_fingerprint(explicit_out)},
        }
        require_complete_build(explicit_identity, explicit_out)
        (explicit_out / "main/index.js").write_text("drift\n", encoding="utf-8")
        try:
            require_complete_build(explicit_identity, explicit_out)
            raise AssertionError("drifted explicit build output was accepted")
        except RuntimeError as exc:
            assert "changed after preflight" in str(exc)
        seed_source = run_root / "seed-source"
        seed_target = run_root / "seed-target"
        seed_source.mkdir()
        assert git(["init"], seed_source).returncode == 0
        assert git(["config", "user.name", "fixture"], seed_source).returncode == 0
        assert git(["config", "user.email", "fixture@example.invalid"], seed_source).returncode == 0
        (seed_source / "tracked.txt").write_text("committed\n", encoding="utf-8")
        assert git(["add", "tracked.txt"], seed_source).returncode == 0
        assert git(["commit", "-m", "fixture"], seed_source).returncode == 0
        assert git(["remote", "add", "origin", "ssh://example.invalid/repo.git"], seed_source).returncode == 0
        (seed_source / "tracked.txt").write_text("dirty\n", encoding="utf-8")
        (seed_source / "untracked.txt").write_text("untracked\n", encoding="utf-8")
        seeded = clone_local_repository(seed_source, seed_target, run_root, run_root / "staging")
        assert seeded["sourceDirtyIgnored"] is True
        assert (seed_target / "tracked.txt").read_text(encoding="utf-8") == "committed\n"
        assert not (seed_target / "untracked.txt").exists()
        assert git(["status", "--porcelain=v1", "--untracked-files=all"], seed_target).stdout == ""
        assert git(["remote", "get-url", "origin"], seed_target).stdout.strip() == "ssh://example.invalid/repo.git"
        registry_source = run_root / "registry-source"
        registry_source.mkdir()
        assert git(["init"], registry_source).returncode == 0
        assert git(["config", "user.name", "fixture"], registry_source).returncode == 0
        assert git(["config", "user.email", "fixture@example.invalid"], registry_source).returncode == 0
        (registry_source / "seed.txt").write_text("seed\n", encoding="utf-8")
        assert git(["add", "seed.txt"], registry_source).returncode == 0
        assert git(["commit", "-m", "fixture"], registry_source).returncode == 0
        fixture_pool = run_root / "registry-pool"
        slot_worktree = fixture_pool / "1" / "rate-native"
        outside_worktree = run_root / "registry-outside" / "rate-native"
        original_pool_root = FIXED["poolRoot"]
        FIXED["poolRoot"] = str(fixture_pool)
        try:
            assert git(["worktree", "add", "--detach", str(slot_worktree), "HEAD"], registry_source).returncode == 0
            assert git(["worktree", "add", "--detach", str(outside_worktree), "HEAD"], registry_source).returncode == 0
            assert prune_stale_pool_registry(registry_source)["action"] == "none"
            shutil.rmtree(slot_worktree)
            repair = prune_stale_pool_registry(registry_source)
            assert repair["action"] == "pruned-stale-worktree-registry"
            assert [item["underPoolRoot"] for item in repair["removed"]] == [True]
            assert stale_pool_registrations(registry_source) == []
            live_paths = [entry["path"] for entry in registered_worktrees(registry_source)]
            assert str(outside_worktree.resolve()) in live_paths
            assert git(["worktree", "add", "--detach", str(slot_worktree), "HEAD"], registry_source).returncode == 0
            shutil.rmtree(outside_worktree)
            assert prune_stale_pool_registry(registry_source)["action"] == "none"
            assert str(slot_worktree.resolve()) in [
                entry["path"] for entry in registered_worktrees(registry_source)
            ]
        finally:
            FIXED["poolRoot"] = original_pool_root
        self_test_workspace_cleanliness(run_root)
    print("self-test: PASS")
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="action", required=True)
    subparsers.add_parser("self-test")
    subparsers.add_parser("lease-all")
    status_parser = subparsers.add_parser("status")
    status_parser.add_argument("--provider", choices=sorted(PROVIDERS))
    for action in (
        "claim",
        "heartbeat",
        "release",
        "mark-retained",
        "mark-post-send-abandoned",
        "bootstrap-status",
        "mark-bootstrap",
        "reset-bootstrap-inputs",
        "seed-repositories",
        "reconcile-bootstrap",
    ):
        command_parser = subparsers.add_parser(action)
        command_parser.add_argument("--provider", required=True, choices=sorted(PROVIDERS))
        if action in {
            "claim",
            "heartbeat",
            "release",
            "mark-retained",
            "mark-post-send-abandoned",
            "mark-bootstrap",
            "reset-bootstrap-inputs",
            "seed-repositories",
            "reconcile-bootstrap",
        }:
            command_parser.add_argument("--run-root", required=True)
        if action == "bootstrap-status":
            command_parser.add_argument("--preflight", help="compare registry latest against this preflight's frozen source version")
        if action in {"mark-bootstrap", "reconcile-bootstrap"}:
            command_parser.add_argument("--preflight", required=True)
        if action == "reconcile-bootstrap":
            command_parser.add_argument("--scry-bin", required=True)
        if action == "heartbeat":
            command_parser.add_argument("--stage", required=True, choices=sorted(SLOT_OWNER_ACTIVE_STAGES))
    intent_parser = subparsers.add_parser("prepare-send-intent")
    intent_parser.add_argument("--provider", required=True, choices=sorted(PROVIDERS))
    intent_parser.add_argument("--run-root", required=True)
    intent_parser.add_argument("--turn", required=True, type=int, choices=(1, 2, 3))
    draft_parser = subparsers.add_parser("record-draft")
    draft_parser.add_argument("--provider", required=True, choices=sorted(PROVIDERS))
    draft_parser.add_argument("--run-root", required=True)
    for action in ("claim-shared", "release-shared"):
        command_parser = subparsers.add_parser(action)
        command_parser.add_argument("--name", required=True, choices=sorted(FIXED["sharedLocks"]))
        command_parser.add_argument("--run-root", required=True)
    build_status_parser = subparsers.add_parser("build-status")
    build_status_parser.add_argument("--preflight", required=True)
    mark_build_parser = subparsers.add_parser("mark-build")
    mark_build_parser.add_argument("--preflight", required=True)
    mark_build_parser.add_argument("--run-root", required=True)
    prepare_parser = subparsers.add_parser("prepare")
    prepare_parser.add_argument("--provider", required=True, choices=sorted(PROVIDERS))
    prepare_parser.add_argument("--run-root", required=True)
    prepare_parser.add_argument("--expected-head", required=True)
    start_app_parser = subparsers.add_parser("start-test-app")
    start_app_parser.add_argument("--provider", required=True, choices=sorted(PROVIDERS))
    start_app_parser.add_argument("--run-root", required=True)
    start_app_parser.add_argument("--scry-repo", required=True)
    start_app_parser.add_argument("--workspace", required=True)
    start_app_parser.add_argument("--build-out")
    start_app_parser.add_argument("--port", type=int)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.action == "self-test":
        return self_test()
    if args.action == "lease-all":
        with lifecycle_gate():
            result = lease_all()
    elif args.action == "status":
        status = treehouse_status()
        providers = [args.provider] if args.provider else sorted(PROVIDERS, key=slot_for)
        result = {"ok": True, "mappings": [mapping_status(provider, status) for provider in providers]}
        result["ok"] = all(item["mappingReady"] for item in result["mappings"])
    elif args.action == "claim":
        run_root = safe_run_root(args.run_root)
        with lifecycle_gate():
            mapping = mapping_status(args.provider, treehouse_status())
            if not mapping["mappingReady"]:
                raise RuntimeError(f"fixed treehouse mapping is not ready: {mapping}")
            require_no_mutation_run()
            result = claim_slot(args.provider, run_root)
    elif args.action == "heartbeat":
        result = heartbeat_slot_owner(args.provider, safe_run_root(args.run_root), args.stage)
    elif args.action == "prepare-send-intent":
        try:
            payload = json.loads(sys.stdin.read())
        except json.JSONDecodeError as exc:
            raise ValueError(f"prepare-send-intent stdin is not valid JSON: {exc}") from exc
        result = prepare_send_intent(
            args.provider,
            safe_run_root(args.run_root),
            args.turn,
            payload,
        )
    elif args.action == "record-draft":
        try:
            payload = json.loads(sys.stdin.read())
        except json.JSONDecodeError as exc:
            raise ValueError(f"record-draft stdin is not valid JSON: {exc}") from exc
        result = record_draft(
            args.provider,
            safe_run_root(args.run_root),
            payload,
        )
    elif args.action == "release":
        result = release_slot(args.provider, safe_run_root(args.run_root))
    elif args.action == "mark-retained":
        result = mark_retained(args.provider, safe_run_root(args.run_root))
    elif args.action == "mark-post-send-abandoned":
        try:
            payload = json.loads(sys.stdin.read())
        except json.JSONDecodeError as exc:
            raise ValueError(f"mark-post-send-abandoned stdin is not valid JSON: {exc}") from exc
        result = mark_post_send_abandoned(
            args.provider,
            safe_run_root(args.run_root),
            payload,
        )
    elif args.action == "claim-shared":
        run_root = safe_run_root(args.run_root)
        if args.name in {"build", "environment"}:
            with lifecycle_gate():
                require_no_other_mutation_lock(args.name, run_root)
                require_no_other_active_slot_runs(
                    run_root,
                    require_build_snapshot=args.name == "build",
                )
                result = claim_lock(shared_lock_path(args.name), f"shared:{args.name}", run_root)
        else:
            result = claim_lock(shared_lock_path(args.name), f"shared:{args.name}", run_root)
    elif args.action == "release-shared":
        result = release_lock(shared_lock_path(args.name), safe_run_root(args.run_root))
    elif args.action == "bootstrap-status":
        result = bootstrap_status(
            args.provider,
            Path(args.preflight).expanduser().resolve() if args.preflight else None,
        )
    elif args.action == "mark-bootstrap":
        result = mark_bootstrap(
            args.provider,
            safe_run_root(args.run_root),
            Path(args.preflight).expanduser().resolve(),
        )
    elif args.action == "reset-bootstrap-inputs":
        result = reset_bootstrap_inputs(args.provider, safe_run_root(args.run_root))
    elif args.action == "seed-repositories":
        result = seed_warm_repositories(args.provider, safe_run_root(args.run_root))
    elif args.action == "reconcile-bootstrap":
        result = reconcile_bootstrap(
            args.provider,
            safe_run_root(args.run_root),
            Path(args.preflight).expanduser().resolve(),
            args.scry_bin,
        )
    elif args.action == "prepare":
        result = prepare(args.provider, safe_run_root(args.run_root), args.expected_head)
    elif args.action == "start-test-app":
        result = start_test_app(
            args.provider,
            safe_run_root(args.run_root),
            Path(args.scry_repo).expanduser().resolve(),
            Path(args.workspace).expanduser().resolve(),
            Path(args.build_out).expanduser().resolve() if args.build_out else None,
            args.port,
        )
    elif args.action == "build-status":
        result = build_status(Path(args.preflight).expanduser().resolve())
    elif args.action == "mark-build":
        result = mark_build(
            Path(args.preflight).expanduser().resolve(),
            safe_run_root(args.run_root),
        )
    else:
        raise AssertionError(args.action)
    emit(result)
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired, json.JSONDecodeError) as exc:
        emit({"ok": False, "error": str(exc)})
        sys.exit(1)
