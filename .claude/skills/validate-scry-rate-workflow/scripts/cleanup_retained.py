#!/usr/bin/env python3
"""Safely supersede one terminal same-provider validation site."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import tempfile
from pathlib import Path
from typing import Any, Callable

import fixed_workspace as fixed


ALLOWED_CLASSIFICATIONS = {"WAITING_FOR_DRAFT_CLEANUP", "WAITING_FOR_REVIEW_CLEANUP"}
SCRIPT_DIR = Path(__file__).resolve().parent


def run_json(command: list[str], stage: str, timeout: int = 1800) -> dict[str, Any]:
    completed = fixed.run(command, timeout=timeout, env=os.environ.copy())
    try:
        value = json.loads(completed.stdout)
    except json.JSONDecodeError as exc:
        detail = (completed.stderr or completed.stdout).strip()[-2000:]
        raise RuntimeError(f"{stage} produced invalid evidence: {detail}") from exc
    if completed.returncode != 0 or not isinstance(value, dict) or value.get("ok") is False:
        detail = value.get("error") if isinstance(value, dict) else None
        raise RuntimeError(f"{stage} failed: {detail or (completed.stderr or completed.stdout).strip()[-2000:]}")
    return value


def write_json_atomic(path: Path, value: dict[str, Any]) -> None:
    if os.path.lexists(path) and path.is_symlink():
        raise RuntimeError(f"refusing to replace a symlink evidence path: {path}")
    temporary = path.with_name(f"{path.name}.tmp-{os.getpid()}")
    if os.path.lexists(temporary):
        raise RuntimeError(f"cleanup temporary evidence already exists: {temporary}")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.chmod(0o600)
    temporary.replace(path)


def cleanup(
    provider: str,
    old_run_root: Path,
    superseding_run_root: Path,
    runner: Callable[[list[str], str, int], dict[str, Any]] = run_json,
) -> dict[str, Any]:
    old_run_root = fixed.safe_run_root(str(old_run_root))
    superseding_run_root = fixed.safe_run_root(str(superseding_run_root))
    if old_run_root == superseding_run_root:
        raise RuntimeError("a run cannot supersede itself")
    lock_path = fixed.slot_lock_path(provider)
    if lock_path.is_symlink() or not lock_path.is_file():
        raise RuntimeError(f"Provider slot lock is missing or unsafe: {lock_path}")
    lock = fixed.read_json(lock_path)
    if not isinstance(lock, dict) or lock.get("runRoot") != str(old_run_root):
        raise RuntimeError(f"Provider slot no longer belongs to the retained run: {lock}")
    classification = fixed.classify_slot_run(str(old_run_root), lock)
    cleanup_authorization = fixed.terminal_cleanup_authorization(provider, old_run_root)
    transaction_path = old_run_root / "superseded-cleanup-prepared.json"
    transaction: dict[str, Any] | None = None
    if os.path.lexists(transaction_path):
        if transaction_path.is_symlink() or not transaction_path.is_file():
            raise RuntimeError(f"supersession transaction is unsafe: {transaction_path}")
        transaction = fixed.read_json(transaction_path)
        if not (
            isinstance(transaction, dict)
            and transaction.get("schemaVersion") == 1
            and transaction.get("state") == "SUPERSEDED_CLEANUP_PREPARED"
            and transaction.get("provider") == provider
            and transaction.get("runRoot") == str(old_run_root)
            and transaction.get("previousClassification") in ALLOWED_CLASSIFICATIONS
            and transaction.get("cleanupAuthorization") == cleanup_authorization
        ):
            raise RuntimeError(f"supersession transaction is invalid: {transaction}")
    elif classification in ALLOWED_CLASSIFICATIONS:
        transaction = {
            "schemaVersion": 1,
            "state": "SUPERSEDED_CLEANUP_PREPARED",
            "provider": provider,
            "runRoot": str(old_run_root),
            "supersedingRunRoot": str(superseding_run_root),
            "previousClassification": classification,
            "cleanupAuthorization": cleanup_authorization,
        }
        write_json_atomic(transaction_path, transaction)
    else:
        raise RuntimeError(
            f"automatic supersession only accepts terminal retained sites or its own prepared transaction, got {classification}"
        )
    prepared_path = old_run_root / "environment-prepared.json"
    if prepared_path.is_symlink() or not prepared_path.is_file():
        raise RuntimeError(f"retained run has no safe environment evidence: {prepared_path}")
    prepared = fixed.read_json(prepared_path)
    scry_bin = prepared.get("scryBin") if isinstance(prepared, dict) else None
    if not isinstance(scry_bin, str) or not Path(scry_bin).is_absolute():
        raise RuntimeError("retained run has no absolute recorder CLI identity")

    stop = runner(
        ["node", str(SCRIPT_DIR / "test_scry_app.mjs"), "stop", "--run-root", str(old_run_root)],
        "test_stop",
        120,
    )
    status = runner(
        ["node", str(SCRIPT_DIR / "test_scry_app.mjs"), "status", "--run-root", str(old_run_root)],
        "test_status",
        30,
    )
    if not (
        status.get("status") in {"stopped", "stale"}
        and status.get("processAlive") is False
        and status.get("cdpClosed") is True
    ):
        raise RuntimeError(f"retained Test App did not reach a proven stopped state: {status}")
    sanitize = runner(
        [
            sys.executable,
            str(SCRIPT_DIR / "sanitize_workspace.py"),
            "--provider",
            provider,
            "--run-root",
            str(old_run_root),
            "--phase",
            "after",
            "--scry-bin",
            scry_bin,
        ],
        "sanitize_after",
        1800,
    )
    after_manifest = old_run_root / "workspace-cleanup-after" / "manifest.json"
    if after_manifest.is_symlink() or not after_manifest.is_file():
        raise RuntimeError(f"after-cleanup manifest is missing or unsafe: {after_manifest}")
    result_path = old_run_root / "superseded-cleanup.json"
    result = {
        "schemaVersion": 1,
        "ok": False,
        "state": "SUPERSEDED_CLEANUP_RELEASE_PREPARED",
        "provider": provider,
        "runRoot": str(old_run_root),
        "supersedingRunRoot": str(superseding_run_root),
        "previousClassification": transaction["previousClassification"],
        "preparedTransaction": {
            "path": str(transaction_path),
            "sha256": "sha256:" + hashlib.sha256(transaction_path.read_bytes()).hexdigest(),
            "originalSupersedingRunRoot": transaction.get("supersedingRunRoot"),
        },
        "testApp": {
            "launchId": stop.get("launchId"),
            "status": status.get("status"),
            "processAlive": status.get("processAlive"),
            "cdpClosed": status.get("cdpClosed"),
        },
        "sanitize": {
            "attemptRoot": sanitize.get("attemptRoot"),
            "idempotent": sanitize.get("idempotent", False),
            "manifestPath": str(after_manifest),
            "manifestSha256": "sha256:" + hashlib.sha256(after_manifest.read_bytes()).hexdigest(),
        },
        "release": None,
    }
    write_json_atomic(result_path, result)
    release = runner(
        [
            sys.executable,
            str(SCRIPT_DIR / "fixed_workspace.py"),
            "release",
            "--provider",
            provider,
            "--run-root",
            str(old_run_root),
        ],
        "slot_release",
        120,
    )
    if lock_path.exists() or lock_path.is_symlink():
        raise RuntimeError(f"Provider slot still exists after retained cleanup: {lock_path}")
    result.update({"ok": True, "state": "SUPERSEDED_CLEANUP", "release": release})
    write_json_atomic(result_path, result)
    return result


def recover_released_cleanups(
    provider: str,
    superseding_run_root: Path,
    run_parent: Path | None = None,
) -> list[dict[str, Any]]:
    """Finalize a cleanup killed after the atomic slot-lock release."""
    superseding_run_root = fixed.safe_run_root(str(superseding_run_root))
    parent = (run_parent or fixed.RUN_ROOT_PARENT).resolve()
    recovered: list[dict[str, Any]] = []
    for result_path in sorted(parent.glob(f"{fixed.RUN_PREFIX}*/superseded-cleanup.json")):
        if result_path.is_symlink() or not result_path.is_file():
            raise RuntimeError(f"supersession result evidence is unsafe: {result_path}")
        result = fixed.read_json(result_path)
        if not (
            isinstance(result, dict)
            and result.get("state") == "SUPERSEDED_CLEANUP_RELEASE_PREPARED"
            and result.get("provider") == provider
        ):
            continue
        old_run_root = fixed.safe_run_root(str(result.get("runRoot", "")))
        if result_path != old_run_root / "superseded-cleanup.json":
            raise RuntimeError(f"supersession result path mismatch: {result_path}")
        transaction_path = old_run_root / "superseded-cleanup-prepared.json"
        after_manifest = old_run_root / "workspace-cleanup-after" / "manifest.json"
        released_lock = old_run_root / "released-slot-lock.json"
        if any(path.is_symlink() or not path.is_file() for path in (transaction_path, after_manifest, released_lock)):
            raise RuntimeError(f"released cleanup evidence is incomplete for {old_run_root}")
        transaction = fixed.read_json(transaction_path)
        manifest = fixed.read_json(after_manifest)
        released_owner = fixed.read_json(released_lock)
        prepared = result.get("preparedTransaction") if isinstance(result.get("preparedTransaction"), dict) else {}
        sanitize = result.get("sanitize") if isinstance(result.get("sanitize"), dict) else {}
        transaction_hash = "sha256:" + hashlib.sha256(transaction_path.read_bytes()).hexdigest()
        manifest_hash = "sha256:" + hashlib.sha256(after_manifest.read_bytes()).hexdigest()
        evidence_checks = {
            "result_pending": result.get("ok") is False,
            "result_run": result.get("runRoot") == str(old_run_root),
            "transaction_path": prepared.get("path") == str(transaction_path),
            "transaction_hash": prepared.get("sha256") == transaction_hash,
            "manifest_path": sanitize.get("manifestPath") == str(after_manifest),
            "manifest_hash": sanitize.get("manifestSha256") == manifest_hash,
            "transaction_identity": (
                isinstance(transaction, dict)
                and transaction.get("schemaVersion") == 1
                and transaction.get("state") == "SUPERSEDED_CLEANUP_PREPARED"
                and transaction.get("provider") == provider
                and transaction.get("runRoot") == str(old_run_root)
                and transaction.get("previousClassification") in ALLOWED_CLASSIFICATIONS
                and result.get("previousClassification") == transaction.get("previousClassification")
                and prepared.get("originalSupersedingRunRoot") == transaction.get("supersedingRunRoot")
            ),
            "cleanup_authorization": isinstance(transaction, dict) and transaction.get("cleanupAuthorization") == manifest.get("cleanupAuthorization"),
            "manifest": manifest.get("ok") is True and manifest.get("provider") == provider,
            "workspace": manifest.get("workspace") == str(fixed.workspace_for(provider)),
            "test_app_closed": (
                isinstance(result.get("testApp"), dict)
                and result["testApp"].get("status") in {"stopped", "stale"}
                and result["testApp"].get("processAlive") is False
                and result["testApp"].get("cdpClosed") is True
            ),
            "released_provider": released_owner.get("provider") == provider,
            "released_run": released_owner.get("runRoot") == str(old_run_root),
            "slot_absent": not os.path.lexists(fixed.slot_lock_path(provider)),
        }
        failed_checks = [name for name, ok in evidence_checks.items() if not ok]
        if failed_checks:
            raise RuntimeError(
                f"released cleanup evidence is invalid for {old_run_root}: {failed_checks}"
            )
        result.update({
            "ok": True,
            "state": "SUPERSEDED_CLEANUP",
            "recoveredByRunRoot": str(superseding_run_root),
            "release": {
                "ok": True,
                "alreadyReleased": False,
                "path": str(fixed.slot_lock_path(provider)),
                "evidencePath": str(released_lock),
                "owner": released_owner,
                "recovered": True,
            },
        })
        write_json_atomic(result_path, result)
        recovered.append(result)
    return recovered


def self_test() -> int:
    with tempfile.TemporaryDirectory() as raw:
        root = Path(raw)
        old_run = root / "validate-scry-rate-workflow-old"
        new_run = root / "validate-scry-rate-workflow-new"
        old_run.mkdir()
        new_run.mkdir()
        cli = root / "scry"
        cli.write_text("fixture\n", encoding="utf-8")
        (old_run / "environment-prepared.json").write_text(
            json.dumps({"scryBin": str(cli)}), encoding="utf-8"
        )
        lock = root / "slot.json"
        lock.write_text(json.dumps({"runRoot": str(old_run.resolve())}), encoding="utf-8")
        calls: list[str] = []
        fail_sanitize_once = {"value": True}
        original_safe = fixed.safe_run_root
        original_lock_path = fixed.slot_lock_path
        original_classify = fixed.classify_slot_run
        original_cleanup_authorization = fixed.terminal_cleanup_authorization
        original_workspace_for = fixed.workspace_for
        try:
            fixed.safe_run_root = lambda value: Path(value).resolve()
            fixed.slot_lock_path = lambda provider: lock
            fixed.classify_slot_run = lambda value, owner: "WAITING_FOR_DRAFT_CLEANUP"
            fixed.terminal_cleanup_authorization = lambda provider, run_root: {
                "state": "RETAINED_DRAFT",
                "path": str(run_root / "lifecycle.json"),
                "sha256": "sha256:fixture",
            }

            def fixture_runner(command: list[str], stage: str, timeout: int) -> dict[str, Any]:
                calls.append(stage)
                if stage == "test_stop":
                    return {"ok": True, "launchId": "fixture-launch"}
                if stage == "test_status":
                    return {"ok": True, "status": "stopped", "processAlive": False, "cdpClosed": True}
                if stage == "sanitize_after":
                    if fail_sanitize_once["value"]:
                        fail_sanitize_once["value"] = False
                        raise RuntimeError("fixture interrupted after stop")
                    manifest = old_run / "workspace-cleanup-after/manifest.json"
                    manifest.parent.mkdir(parents=True, exist_ok=True)
                    manifest.write_text(json.dumps({
                        "ok": True,
                        "provider": "codex",
                        "workspace": "/fixture/workspace",
                        "cleanupAuthorization": fixed.terminal_cleanup_authorization("codex", old_run),
                    }), encoding="utf-8")
                    return {"ok": True, "attemptRoot": "/fixture/attempt", "idempotent": False}
                if stage == "slot_release":
                    lock.unlink()
                    return {"ok": True, "alreadyReleased": False, "path": str(lock)}
                raise AssertionError(stage)

            try:
                cleanup("codex", old_run, new_run, fixture_runner)
                raise AssertionError("interrupted cleanup unexpectedly succeeded")
            except RuntimeError as exc:
                assert "interrupted after stop" in str(exc)
            assert lock.is_file()
            assert (old_run / "superseded-cleanup-prepared.json").is_file()
            fixed.classify_slot_run = lambda value, owner: "WAITING_FOR_ACTIVE_REVIEW_FINALIZATION"
            calls.clear()
            result = cleanup("codex", old_run, new_run, fixture_runner)

            old_run_2 = root / "validate-scry-rate-workflow-old-2"
            new_run_2 = root / "validate-scry-rate-workflow-new-2"
            old_run_2.mkdir()
            new_run_2.mkdir()
            (old_run_2 / "environment-prepared.json").write_text(
                json.dumps({"scryBin": str(cli)}), encoding="utf-8"
            )
            lock.write_text(json.dumps({
                "runRoot": str(old_run_2.resolve()),
                "provider": "codex",
            }), encoding="utf-8")
            fixed.classify_slot_run = lambda value, owner: "WAITING_FOR_DRAFT_CLEANUP"
            fixed.workspace_for = lambda provider: Path("/fixture/workspace")

            def killed_after_release(command: list[str], stage: str, timeout: int) -> dict[str, Any]:
                if stage == "test_stop":
                    return {"ok": True, "launchId": "fixture-launch-2"}
                if stage == "test_status":
                    return {"ok": True, "status": "stopped", "processAlive": False, "cdpClosed": True}
                if stage == "sanitize_after":
                    manifest = old_run_2 / "workspace-cleanup-after/manifest.json"
                    manifest.parent.mkdir(parents=True, exist_ok=True)
                    manifest.write_text(json.dumps({
                        "ok": True,
                        "provider": "codex",
                        "workspace": "/fixture/workspace",
                        "cleanupAuthorization": fixed.terminal_cleanup_authorization("codex", old_run_2.resolve()),
                    }), encoding="utf-8")
                    return {"ok": True, "attemptRoot": "/fixture/attempt-2", "idempotent": False}
                if stage == "slot_release":
                    lock.replace(old_run_2 / "released-slot-lock.json")
                    raise RuntimeError("fixture killed after atomic release")
                raise AssertionError(stage)

            try:
                cleanup("codex", old_run_2, new_run_2, killed_after_release)
                raise AssertionError("post-release interruption unexpectedly succeeded")
            except RuntimeError as exc:
                assert "killed after atomic release" in str(exc)
            pending = fixed.read_json(old_run_2 / "superseded-cleanup.json")
            assert pending["state"] == "SUPERSEDED_CLEANUP_RELEASE_PREPARED"
            recovered = recover_released_cleanups("codex", new_run_2, root)
            assert len(recovered) == 1 and recovered[0]["state"] == "SUPERSEDED_CLEANUP"
            assert recovered[0]["release"]["recovered"] is True
        finally:
            fixed.safe_run_root = original_safe
            fixed.slot_lock_path = original_lock_path
            fixed.classify_slot_run = original_classify
            fixed.terminal_cleanup_authorization = original_cleanup_authorization
            fixed.workspace_for = original_workspace_for
        assert result["state"] == "SUPERSEDED_CLEANUP"
        assert calls == ["test_stop", "test_status", "sanitize_after", "slot_release"]
        assert result["previousClassification"] == "WAITING_FOR_DRAFT_CLEANUP"
        assert fixed.read_json(old_run / "superseded-cleanup.json") == result
    print("self-test: PASS")
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--provider", choices=sorted(fixed.PROVIDERS))
    parser.add_argument("--run-root")
    parser.add_argument("--superseding-run-root")
    args = parser.parse_args()
    if not args.self_test and (not args.provider or not args.run_root or not args.superseding_run_root):
        parser.error("--provider, --run-root and --superseding-run-root are required")
    return args


def main() -> int:
    args = parse_args()
    if args.self_test:
        return self_test()
    try:
        result = cleanup(
            args.provider,
            Path(args.run_root),
            Path(args.superseding_run_root),
        )
    except (OSError, RuntimeError, ValueError, json.JSONDecodeError) as exc:
        result = {
            "schemaVersion": 1,
            "ok": False,
            "state": "SUPERSEDED_CLEANUP_FAILED",
            "provider": args.provider,
            "runRoot": args.run_root,
            "supersedingRunRoot": args.superseding_run_root,
            "error": str(exc),
        }
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
