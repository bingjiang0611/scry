#!/usr/bin/env python3
"""Recover, freeze, and build one validation environment with scoped locks."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sys
import tempfile
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Callable, Iterator

import fixed_workspace as fixed
import preflight


SOURCE_CONFIG_ONLY_FAILURES = {
    "config.rate_native_settings",
    "version.rate_native_cli",
    "version.rate_native_cli_path",
}


class MutationClearanceRequired(RuntimeError):
    pass


def emit(value: Any) -> None:
    print(json.dumps(value, ensure_ascii=False, indent=2))


@contextmanager
def releasing(claim: Callable[[], Any], release: Callable[[], Any]) -> Iterator[Any]:
    claimed = claim()
    try:
        yield claimed
    finally:
        release()


@contextmanager
def mutation_lock(
    name: str,
    run_root: Path,
    *,
    require_mutation_clearance: bool = True,
    allowed_pre_send_recovery: tuple[str, Path] | None = None,
) -> Iterator[dict[str, Any]]:
    if allowed_pre_send_recovery is not None and not require_mutation_clearance:
        raise ValueError("pre-send recovery exception requires mutation clearance")
    if allowed_pre_send_recovery is not None and name != "environment":
        raise ValueError("pre-send cleanup CLI recovery may only hold the environment lock")

    def claim() -> dict[str, Any]:
        with fixed.lifecycle_gate():
            recovered = fixed.recover_stale_mutation_locks(run_root)
            fixed.require_no_other_mutation_lock(name, run_root)
            if require_mutation_clearance:
                fixed.require_no_other_active_slot_runs(
                    run_root,
                    require_build_snapshot=name == "build",
                    allowed_pre_send_recovery=allowed_pre_send_recovery,
                )
            claimed = fixed.claim_lock(
                fixed.shared_lock_path(name),
                f"shared:{name}",
                run_root,
                process_owned=True,
            )
            claimed["recoveredStaleLocks"] = recovered
            return claimed

    def release() -> dict[str, Any]:
        with fixed.lifecycle_gate():
            return fixed.release_lock(fixed.shared_lock_path(name), run_root)

    with releasing(claim, release) as value:
        yield value


def write(path: Path, value: dict[str, Any]) -> None:
    preflight.write_json_atomic(path, value)


def scry_build_identity(value: dict[str, Any]) -> dict[str, Any]:
    """The build identity is the committed tree alone; uncommitted worktree
    changes are audit-only disclosure and never change what gets built."""
    scry = value.get("git", {}).get("scry") if isinstance(value, dict) else None
    if not isinstance(scry, dict):
        raise RuntimeError("preflight has no Scry source identity")
    identity = {key: scry.get(key) for key in ("head", "treeHash")}
    if not isinstance(identity["head"], str) or not isinstance(identity["treeHash"], str):
        raise RuntimeError(f"preflight has invalid Scry commit identity: {identity}")
    return identity


def quarantine_partial_build(run_root: Path, build_out: Path) -> dict[str, Any] | None:
    expected = run_root / "scry-build-out"
    if build_out != expected:
        raise RuntimeError(f"isolated build output must be the exact run-root child: {expected}")
    if build_out.is_symlink():
        raise RuntimeError(f"refusing symlinked isolated build output: {build_out}")
    if not build_out.exists():
        return None
    recovery_root = run_root / "build-recovery"
    recovery_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    index = 1
    while True:
        quarantine = recovery_root / f"partial-{index}"
        if not quarantine.exists() and not quarantine.is_symlink():
            break
        index += 1
    quarantine.mkdir(mode=0o700)
    destination = quarantine / build_out.name
    build_out.replace(destination)
    evidence = {
        "schemaVersion": 1,
        "source": str(build_out),
        "destination": str(destination),
        "reason": "incomplete_or_identity_mismatch",
    }
    write(quarantine / "manifest.json", evidence)
    return evidence


def reusable_isolated_build(
    run_root: Path,
    build_out: Path,
    build_preflight_path: Path,
    source_identity: dict[str, Any],
) -> bool:
    manifest_path = run_root / "isolated-build.json"
    if build_out.is_symlink() or not build_out.is_dir() or manifest_path.is_symlink():
        return False
    if not manifest_path.is_file() or not build_preflight_path.is_file() or build_preflight_path.is_symlink():
        return False
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        post_build = json.loads(build_preflight_path.read_text(encoding="utf-8"))
        post_source_identity = scry_build_identity(post_build)
        identity = fixed.build_identity(build_preflight_path)
        fixed.require_complete_build(identity, build_out)
    except (OSError, RuntimeError, ValueError, json.JSONDecodeError):
        return False
    return bool(
        isinstance(manifest, dict)
        and manifest.get("schemaVersion") == 2
        and manifest.get("buildOut") == str(build_out)
        and manifest.get("sourceIdentity") == source_identity
        and manifest.get("buildArtifacts") == post_build.get("buildArtifacts")
        and manifest.get("preflightPath") == str(build_preflight_path)
        and post_build.get("ok") is True
        and post_build.get("buildOut") == str(build_out)
        and post_source_identity == source_identity
    )


def git_blob_sha1(path: Path) -> str:
    if path.is_symlink():
        value = os.fsencode(os.readlink(path))
        digest = hashlib.sha1(f"blob {len(value)}\0".encode())
        digest.update(value)
        return digest.hexdigest()
    digest = hashlib.sha1(f"blob {path.stat().st_size}\0".encode())
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def materialize_head_snapshot(scry_repo: Path, snapshot_dir: Path) -> dict[str, Any]:
    """Materialize the committed HEAD tree into an isolated build source.

    Uncommitted worktree changes are deliberately excluded: builds are pinned
    to the latest commit, so local edits can never change what gets tested.
    """
    if snapshot_dir.is_symlink() or snapshot_dir.exists():
        raise RuntimeError(f"refusing to reuse an existing build snapshot: {snapshot_dir}")
    snapshot_dir.mkdir(mode=0o700)
    archive = snapshot_dir.parent / "scry-build-src.tar"
    try:
        head_code, head = preflight.command(["git", "rev-parse", "HEAD"], scry_repo)
        tree_code, tree = preflight.command(["git", "rev-parse", "HEAD^{tree}"], scry_repo)
        if head_code != 0 or tree_code != 0:
            raise RuntimeError("cannot resolve Scry HEAD commit for the build snapshot")
        code, _ = preflight.command(
            ["git", "archive", "--format=tar", "-o", str(archive), "HEAD"],
            scry_repo,
        )
        if code != 0:
            raise RuntimeError("git archive failed while materializing the build snapshot")
        code, _ = preflight.command(["tar", "-x", "-f", str(archive), "-C", str(snapshot_dir)])
        if code != 0:
            raise RuntimeError("tar extraction failed while materializing the build snapshot")
        listing_code, listing = preflight.command(["git", "ls-tree", "-r", "HEAD"], scry_repo)
        if listing_code != 0:
            raise RuntimeError("cannot list the committed Scry tree for the build snapshot")
        expected: dict[str, str] = {}
        for line in listing.splitlines():
            parts = line.split(None, 3)
            if len(parts) == 4 and parts[1] == "blob":
                expected[parts[3]] = parts[2]
        if not expected:
            raise RuntimeError("committed Scry tree has no blobs to snapshot")
        files = 0
        for path in sorted(
            item for item in snapshot_dir.rglob("*") if item.is_symlink() or item.is_file()
        ):
            relative = str(path.relative_to(snapshot_dir))
            if git_blob_sha1(path) != expected.get(relative):
                raise RuntimeError(f"build snapshot drifted from the committed tree: {relative}")
            files += 1
        if files != len(expected):
            raise RuntimeError(f"build snapshot file count drifted: {files} != {len(expected)}")
        modules = snapshot_dir / "node_modules"
        if modules.exists() or modules.is_symlink():
            raise RuntimeError("committed Scry tree unexpectedly contains node_modules")
        modules.symlink_to(scry_repo / "node_modules", target_is_directory=True)
    except BaseException:
        for item in sorted(snapshot_dir.iterdir(), reverse=True):
            if item.is_symlink() or item.is_file():
                item.unlink(missing_ok=True)
            elif item.is_dir():
                shutil.rmtree(item, ignore_errors=True)
        raise
    finally:
        archive.unlink(missing_ok=True)
    return {
        "path": str(snapshot_dir),
        "head": head,
        "treeHash": tree,
        "files": files,
        "verified": True,
        "nodeModulesSymlink": str(scry_repo / "node_modules"),
    }


def inspect_under_environment_lock(
    provider: str,
    run_root: Path,
    scry_repo: Path,
    rate_native_repo: Path,
    recovery_path: Path,
) -> dict[str, Any]:
    """Serialize the first inspection without requesting mutation clearance."""
    with mutation_lock("environment", run_root, require_mutation_clearance=False):
        inspected = preflight.inspect(provider, scry_repo, rate_native_repo)
        if inspected.get("ok") is True:
            manifest = {
                "schemaVersion": 1,
                "status": "FROZEN_READY",
                "provider": provider,
                "initialFailures": [],
                "attempts": [],
                "maxAttempts": int(preflight.RECOVERY["maxAttempts"]),
                "recoveryRequired": False,
                "finalFailures": [],
            }
            write(recovery_path, manifest)
            return {**inspected, "recovery": manifest, "ok": True}
        return inspected


def reconcile_source_settings_only(
    provider: str,
    scry_repo: Path,
    rate_native_repo: Path,
    recovery_path: Path,
) -> dict[str, Any]:
    """Repair only authoritative source settings; never touch registry or npm."""
    current = preflight.inspect(provider, scry_repo, rate_native_repo)
    failures = {str(item.get("name")) for item in current.get("failures", [])}
    if current.get("ok") is True:
        manifest = {
            "schemaVersion": 1,
            "status": "FROZEN_READY",
            "provider": provider,
            "mode": "source_settings_only",
            "initialFailures": [],
            "attempts": [],
            "maxAttempts": int(preflight.RECOVERY["maxAttempts"]),
            "recoveryRequired": False,
            "finalFailures": [],
        }
        write(recovery_path, manifest)
        return {**current, "recovery": manifest, "ok": True}
    if not failures or not failures <= SOURCE_CONFIG_ONLY_FAILURES:
        raise MutationClearanceRequired(f"settings-only recovery saw new failures: {sorted(failures)}")
    versions = current.get("versions", {})
    source_version = versions.get("scry", {}).get("package")
    installed = versions.get("installedCli", {})
    provenance = versions.get("installedCliProvenance", {})
    cli_path = installed.get("path")
    if not (
        isinstance(source_version, str)
        and installed.get("version") == source_version
        and provenance.get("ready") is True
        and isinstance(cli_path, str)
        and cli_path
    ):
        raise MutationClearanceRequired("settings-only recovery cannot prove an already-compatible stable CLI")
    manifest: dict[str, Any] = {
        "schemaVersion": 1,
        "status": "RECOVERING_ENVIRONMENT",
        "provider": provider,
        "mode": "source_settings_only",
        "initialFailures": sorted(failures),
        "attempts": [],
        "maxAttempts": int(preflight.RECOVERY["maxAttempts"]),
    }
    write(recovery_path, manifest)
    quarantine = recovery_path.parent / "preflight-recovery" / "quarantine"
    for number in range(1, int(preflight.RECOVERY["maxAttempts"]) + 1):
        attempt: dict[str, Any] = {"attempt": number, "status": "RUNNING", "step": "settings"}
        manifest["attempts"].append(attempt)
        write(recovery_path, manifest)
        try:
            attempt["settings"] = preflight.sync_local_settings(rate_native_repo, cli_path, quarantine)
            current = preflight.inspect(provider, scry_repo, rate_native_repo)
            remaining = {str(item.get("name")) for item in current.get("failures", [])}
            attempt["remainingFailures"] = sorted(remaining)
            if current.get("ok") is True:
                attempt["status"] = "CONVERGED"
                manifest.update({"status": "FROZEN_READY", "finalFailures": []})
                write(recovery_path, manifest)
                return {**current, "recovery": manifest, "ok": True}
            if not remaining <= SOURCE_CONFIG_ONLY_FAILURES:
                attempt["status"] = "MUTATION_CLEARANCE_REQUIRED"
                write(recovery_path, manifest)
                raise MutationClearanceRequired(
                    f"settings-only recovery observed non-settings failures: {sorted(remaining)}"
                )
            attempt["status"] = "RETRY_PENDING" if number < int(preflight.RECOVERY["maxAttempts"]) else "EXHAUSTED"
        except MutationClearanceRequired:
            raise
        except (OSError, RuntimeError, ValueError) as exc:
            attempt.update({"status": "FAILED", "error": {"type": type(exc).__name__, "message": str(exc)}})
        write(recovery_path, manifest)
    manifest.update({
        "status": "RECOVERY_FAILED",
        "finalFailures": [str(item.get("name")) for item in current.get("failures", [])],
    })
    write(recovery_path, manifest)
    return {**current, "recovery": manifest, "ok": False}


def frozen_preflight_for_run(run_root: Path) -> dict[str, Any]:
    prepared_path = run_root / "environment-prepared.json"
    candidates: list[Path] = []
    if prepared_path.is_file() and not prepared_path.is_symlink():
        prepared = fixed.read_json(prepared_path)
        raw = prepared.get("baselinePreflight") if isinstance(prepared, dict) else None
        if isinstance(raw, str):
            candidate = Path(raw).expanduser().resolve()
            if candidate.parent == run_root and candidate.name in {"preflight.json", "preflight-build-cache.json"}:
                candidates.append(candidate)
    candidates.extend(run_root / name for name in ("preflight-build-cache.json", "preflight.json"))
    for path in candidates:
        if path.is_symlink() or not path.is_file():
            continue
        value = fixed.read_json(path)
        if isinstance(value, dict) and value.get("ok") is True:
            return value
    raise RuntimeError(f"pre-send run has no safe successful baseline preflight: {run_root}")


def recover_cleanup_cli(
    provider: str,
    old_run_root: Path,
    recovery_run_root: Path,
    scry_repo: Path,
) -> dict[str, Any]:
    """Restore the recorder CLI needed to stop stale recorder state.

    Cleanup always targets the version currently in the Scry source (the
    latest), not the exact version frozen at run time: an upgraded recorder
    must not strand old retained sites. The frozen version is disclosed for
    the record only.
    """
    frozen = frozen_preflight_for_run(old_run_root)
    versions = frozen.get("versions", {})
    frozen_version = versions.get("scry", {}).get("package")
    if not (isinstance(frozen_version, str) and frozen_version):
        raise RuntimeError("frozen preflight has no recorder source version")
    source_versions = preflight.scry_versions(scry_repo)
    target = source_versions.get("package")
    if not (isinstance(target, str) and target):
        raise RuntimeError(f"scry source has no recorder package version: {source_versions}")
    journal_path = recovery_run_root / f"pre-send-cli-recovery-{provider}.json"
    manifest: dict[str, Any] = {
        "schemaVersion": 1,
        "status": "RECOVERING_CLEANUP_CLI",
        "provider": provider,
        "oldRunRoot": str(old_run_root),
        "frozenVersion": frozen_version,
        "targetVersion": target,
        "steps": {},
    }
    write(journal_path, manifest)
    with mutation_lock(
        "environment",
        recovery_run_root,
        allowed_pre_send_recovery=(provider, old_run_root),
    ):
        manifest["steps"]["registry"] = {"status": "RUNNING"}
        write(journal_path, manifest)
        manifest["steps"]["registry"] = {
            "status": "COMPLETED",
            "result": preflight.ensure_registry_version(scry_repo, target),
        }
        write(journal_path, manifest)
        manifest["steps"]["installed"] = {"status": "RUNNING"}
        write(journal_path, manifest)
        installed = preflight.ensure_installed_recorder(target)
        manifest["steps"]["installed"] = {
            "status": "COMPLETED",
            "result": installed,
        }
        manifest["status"] = "CLEANUP_CLI_READY"
        write(journal_path, manifest)
    return manifest


def run_pre_send_finalizer(finalizer: Path, provider: str, old_run_root: str) -> tuple[int, dict[str, Any]]:
    completed = fixed.run(
        [
            sys.executable,
            str(finalizer),
            "--provider",
            provider,
            "--run-root",
            old_run_root,
        ],
        timeout=1800,
    )
    try:
        finalized = json.loads(completed.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError(
            f"pre-send finalizer produced invalid evidence for {provider}: "
            f"{(completed.stderr or completed.stdout).strip()[-2000:]}"
        ) from exc
    if not isinstance(finalized, dict):
        raise RuntimeError(f"pre-send finalizer returned non-object evidence for {provider}")
    return completed.returncode, finalized


def reconcile_pre_send_slots(recovery_run_root: Path, scry_repo: Path) -> list[dict[str, Any]]:
    """Finish current-contract runs that provably never crossed send intent."""
    actions: list[dict[str, Any]] = []
    finalizer = Path(__file__).resolve().parent / "finalize_pre_send.py"
    for provider in sorted(fixed.PROVIDERS, key=fixed.slot_for):
        lock_path = fixed.slot_lock_path(provider)
        if not os.path.lexists(lock_path):
            continue
        if lock_path.is_symlink() or not lock_path.is_file():
            raise RuntimeError(f"Provider slot lock is unsafe: {lock_path}")
        lock = fixed.read_json(lock_path)
        if not isinstance(lock, dict) or not isinstance(lock.get("runRoot"), str):
            raise RuntimeError(f"Provider slot lock is invalid: {lock_path}")
        classification = fixed.classify_slot_run(lock["runRoot"], lock)
        action: dict[str, Any] = {
            "provider": provider,
            "runRoot": lock["runRoot"],
            "classification": classification,
            "action": "preserved",
        }
        if classification == "PRE_SEND_RECOVERY_REQUIRED":
            returncode, finalized = run_pre_send_finalizer(finalizer, provider, lock["runRoot"])
            if returncode != 0 and finalized.get("stage") == "scry_bin":
                action["cleanupCliRecovery"] = recover_cleanup_cli(
                    provider,
                    Path(lock["runRoot"]).expanduser().resolve(),
                    recovery_run_root,
                    scry_repo,
                )["status"]
                returncode, finalized = run_pre_send_finalizer(finalizer, provider, lock["runRoot"])
            if returncode != 0 or finalized.get("state") != "PRE_SEND_ARCHIVED":
                raise RuntimeError(f"pre-send finalizer failed for {provider}: {finalized}")
            action.update({"action": "archived", "lifecycle": finalized.get("state")})
        actions.append(action)
    return actions


def build_environment(provider: str, run_root: Path, scry_repo: Path, rate_native_repo: Path) -> dict[str, Any]:
    recovery_path = run_root / "environment-recovery.json"
    preflight_path = run_root / "preflight.json"
    build_status_path = run_root / "build-status.json"
    build_preflight_path = run_root / "preflight-build-cache.json"
    isolated_build_out = run_root / "scry-build-out"
    result_path = run_root / "environment-prepared.json"
    result: dict[str, Any] = {
        "schemaVersion": 1,
        "ok": False,
        "state": "PREPARING_ENVIRONMENT",
        "provider": provider,
        "runRoot": str(run_root),
        "recoveryPath": str(recovery_path),
        "preflightPath": str(preflight_path),
        "buildStatusPath": str(build_status_path),
        "buildPreflightPath": None,
        "baselinePreflight": None,
        "buildOut": None,
        "buildMode": None,
        "built": False,
        "dependencies": None,
        "slotReconciliation": [],
    }
    try:
        result["slotReconciliation"] = reconcile_pre_send_slots(run_root, scry_repo)
        frozen = inspect_under_environment_lock(
            provider,
            run_root,
            scry_repo,
            rate_native_repo,
            recovery_path,
        )
        if frozen.get("ok") is not True:
            failures = {str(item.get("name")) for item in frozen.get("failures", [])}
            config_only = bool(failures) and failures <= SOURCE_CONFIG_ONLY_FAILURES
            if config_only:
                try:
                    with mutation_lock("environment", run_root, require_mutation_clearance=False):
                        frozen = reconcile_source_settings_only(
                            provider,
                            scry_repo,
                            rate_native_repo,
                            recovery_path,
                        )
                except MutationClearanceRequired:
                    config_only = False
            if not config_only:
                with mutation_lock("environment", run_root):
                    frozen = preflight.reconcile_environment(provider, scry_repo, rate_native_repo, recovery_path)
        write(preflight_path, frozen)
        if frozen.get("ok") is not True:
            result.update({
                "state": str(frozen.get("recovery", {}).get("status", "RECOVERY_FAILED")),
                "failures": [item.get("name") for item in frozen.get("failures", [])],
            })
            write(result_path, result)
            return result

        build_status = fixed.build_status(preflight_path)
        write(build_status_path, build_status)
        # Building and launching both need the tracked lockfile materialized, so a
        # missing or half-installed node_modules is recoverable local state
        # rather than a validation blocker.
        dependencies = preflight.scry_dependencies(scry_repo)
        if dependencies.get("ready") is not True:
            with mutation_lock("build", run_root, require_mutation_clearance=False):
                dependencies = preflight.ensure_scry_dependencies(
                    scry_repo,
                    run_root / "scry-dependencies.log",
                )
            write(run_root / "scry-dependencies.json", dependencies)
        result["dependencies"] = dependencies
        if dependencies.get("ready") is not True:
            raise RuntimeError(f"Scry dependencies are not materialized: {dependencies}")
        baseline = preflight_path
        build_out = scry_repo / "out"
        build_mode = "canonical_cache"
        if build_status["needsBuild"]:
            source_identity = scry_build_identity(frozen)
            with mutation_lock("build", run_root, require_mutation_clearance=False):
                reused = reusable_isolated_build(
                    run_root,
                    isolated_build_out,
                    build_preflight_path,
                    source_identity,
                )
                if not reused:
                    recovered = quarantine_partial_build(run_root, isolated_build_out)
                    if recovered is not None:
                        result["recoveredPartialBuild"] = recovered
                    # Build from a clean HEAD snapshot so uncommitted worktree
                    # changes can never change what gets validated.
                    snapshot = materialize_head_snapshot(scry_repo, run_root / "scry-build-src")
                    result["buildSnapshot"] = snapshot
                    npm, env = preflight.npm_environment()
                    try:
                        completed = fixed.run(
                            [npm, "run", "build", "--", "--outDir", str(isolated_build_out)],
                            Path(snapshot["path"]),
                            timeout=1800,
                            env=env,
                        )
                    finally:
                        shutil.rmtree(Path(snapshot["path"]), ignore_errors=True)
                    build_log = run_root / "scry-build.log"
                    build_log.write_text((completed.stdout or "") + (completed.stderr or ""), encoding="utf-8")
                    build_log.chmod(0o600)
                    result["buildLog"] = str(build_log)
                    if completed.returncode != 0:
                        raise RuntimeError(f"Scry isolated build failed; inspect {build_log}")
                    post_build = preflight.inspect(provider, scry_repo, rate_native_repo, isolated_build_out)
                    write(build_preflight_path, post_build)
                    if post_build.get("ok") is not True:
                        raise RuntimeError(
                            "post-build preflight failed: "
                            + ", ".join(str(item.get("name")) for item in post_build.get("failures", []))
                        )
                    if scry_build_identity(post_build) != source_identity:
                        raise RuntimeError("Scry commit identity changed during isolated build")
                    fixed.require_complete_build(fixed.build_identity(build_preflight_path), isolated_build_out)
                    write(run_root / "isolated-build.json", {
                        "schemaVersion": 2,
                        "buildOut": str(isolated_build_out),
                        "sourceIdentity": source_identity,
                        "buildArtifacts": post_build.get("buildArtifacts"),
                        "preflightPath": str(build_preflight_path),
                        "snapshot": {
                            "head": snapshot["head"],
                            "treeHash": snapshot["treeHash"],
                            "files": snapshot["files"],
                        },
                    })
            baseline = build_preflight_path
            build_out = isolated_build_out
            build_mode = "isolated_reuse" if reused else "isolated_build"
            result["built"] = not reused
            result["buildPreflightPath"] = str(build_preflight_path)

        final = json.loads(baseline.read_text(encoding="utf-8"))
        cli_path = final.get("versions", {}).get("rateNative", {}).get("cliPath")
        if not isinstance(cli_path, str) or not cli_path:
            raise RuntimeError(f"frozen baseline has no reconciled CLI path: {baseline}")
        result.update({
            "ok": True,
            "state": "FROZEN_READY",
            "baselinePreflight": str(baseline),
            "scryBin": cli_path,
            "buildOut": str(build_out.resolve()),
            "buildMode": build_mode,
        })
    except (OSError, RuntimeError, ValueError, json.JSONDecodeError) as exc:
        result.update({"ok": False, "state": "PREPARATION_FAILED", "error": str(exc)})
    write(result_path, result)
    return result


def self_test() -> int:
    global mutation_lock
    state = {"held": False, "released": False}

    def claim() -> str:
        state["held"] = True
        return "claimed"

    def release() -> None:
        state["held"] = False
        state["released"] = True

    try:
        with releasing(claim, release) as value:
            assert value == "claimed" and state["held"] is True
            raise RuntimeError("failure injection")
    except RuntimeError:
        pass
    assert state == {"held": False, "released": True}
    with tempfile.TemporaryDirectory() as raw:
        root = Path(raw).resolve()
        recovery_run = root / "recovery-run"
        old_run = root / "old-run"
        recovery_run.mkdir()
        old_run.mkdir()
        environment_lock = root / "shared-environment.json"
        clearance_calls: list[dict[str, Any]] = []
        original_gate = fixed.lifecycle_gate
        original_recover = fixed.recover_stale_mutation_locks
        original_other_lock = fixed.require_no_other_mutation_lock
        original_clearance = fixed.require_no_other_active_slot_runs
        original_shared_lock_path = fixed.shared_lock_path

        @contextmanager
        def fixture_gate() -> Iterator[None]:
            yield

        def fixture_clearance(
            run_root: Path,
            *,
            require_build_snapshot: bool,
            allowed_pre_send_recovery: tuple[str, Path] | None = None,
        ) -> None:
            clearance_calls.append({
                "runRoot": run_root,
                "requireBuildSnapshot": require_build_snapshot,
                "allowed": allowed_pre_send_recovery,
                "lockExistedBeforeClearance": environment_lock.exists(),
            })

        try:
            fixed.lifecycle_gate = fixture_gate
            fixed.recover_stale_mutation_locks = lambda run_root: []
            fixed.require_no_other_mutation_lock = lambda name, run_root: None
            fixed.require_no_other_active_slot_runs = fixture_clearance
            fixed.shared_lock_path = lambda name: environment_lock
            try:
                with mutation_lock(
                    "environment",
                    recovery_run,
                    allowed_pre_send_recovery=("codex", old_run),
                ):
                    assert environment_lock.is_file()
                    raise RuntimeError("failure injection after cleanup CLI lock claim")
            except RuntimeError as exc:
                assert "failure injection" in str(exc)
        finally:
            fixed.lifecycle_gate = original_gate
            fixed.recover_stale_mutation_locks = original_recover
            fixed.require_no_other_mutation_lock = original_other_lock
            fixed.require_no_other_active_slot_runs = original_clearance
            fixed.shared_lock_path = original_shared_lock_path
        assert clearance_calls == [{
            "runRoot": recovery_run,
            "requireBuildSnapshot": False,
            "allowed": ("codex", old_run),
            "lockExistedBeforeClearance": False,
        }]
        assert not os.path.lexists(environment_lock)
    with tempfile.TemporaryDirectory() as raw:
        run_root = Path(raw).resolve()
        partial = run_root / "scry-build-out"
        partial.mkdir()
        (partial / "half.js").write_text("partial\n", encoding="utf-8")
        recovered = quarantine_partial_build(run_root, partial)
        assert recovered is not None
        destination = Path(recovered["destination"])
        assert not partial.exists()
        assert (destination / "half.js").read_text(encoding="utf-8") == "partial\n"
        assert (destination.parent / "manifest.json").is_file()
        partial.symlink_to(destination, target_is_directory=True)
        try:
            quarantine_partial_build(run_root, partial)
            raise AssertionError("symlinked partial build was accepted")
        except RuntimeError as exc:
            assert "symlinked" in str(exc)
    with tempfile.TemporaryDirectory() as raw:
        run_root = Path(raw)
        repo = run_root / "scry"
        repo.mkdir()
        assert preflight.command(["git", "init"], repo)[0] == 0
        assert preflight.command(["git", "config", "user.name", "fixture"], repo)[0] == 0
        assert preflight.command(["git", "config", "user.email", "fixture@example.invalid"], repo)[0] == 0
        (repo / "tracked.txt").write_text("committed\n", encoding="utf-8")
        (repo / "nested").mkdir()
        (repo / "nested/deep.txt").write_text("deep\n", encoding="utf-8")
        (repo / "nested-link").symlink_to("nested", target_is_directory=True)
        assert preflight.command(["git", "add", "tracked.txt", "nested", "nested-link"], repo)[0] == 0
        assert preflight.command(["git", "commit", "-m", "fixture"], repo)[0] == 0
        (repo / "tracked.txt").write_text("dirty\n", encoding="utf-8")
        (repo / "untracked.txt").write_text("untracked\n", encoding="utf-8")
        (repo / "node_modules").mkdir()
        (repo / "node_modules/dep.js").write_text("dep\n", encoding="utf-8")
        snapshot = materialize_head_snapshot(repo, run_root / "scry-build-src")
        assert snapshot["verified"] is True and snapshot["files"] == 3
        assert (run_root / "scry-build-src/tracked.txt").read_text(encoding="utf-8") == "committed\n"
        assert not (run_root / "scry-build-src/untracked.txt").exists()
        assert (run_root / "scry-build-src/nested-link").is_symlink()
        assert os.readlink(run_root / "scry-build-src/nested-link") == "nested"
        assert git_blob_sha1(run_root / "scry-build-src/nested-link") == git_blob_sha1(repo / "nested-link")
        assert (run_root / "scry-build-src/node_modules").is_symlink()
        assert (run_root / "scry-build-src/node_modules/dep.js").read_text(encoding="utf-8") == "dep\n"
        assert git_blob_sha1(run_root / "scry-build-src/nested/deep.txt") == git_blob_sha1(repo / "nested/deep.txt")
        try:
            materialize_head_snapshot(repo, run_root / "scry-build-src")
            raise AssertionError("existing snapshot dir was accepted")
        except RuntimeError as exc:
            assert "refusing to reuse" in str(exc)
    with tempfile.TemporaryDirectory() as raw:
        root = Path(raw)
        failure = {
            "ok": False,
            "failures": [
                {"name": "config.rate_native_settings"},
                {"name": "version.rate_native_cli_path"},
            ],
            "versions": {
                "scry": {"package": "1.2.3"},
                "installedCli": {"path": "/fixture/stable/scry", "version": "1.2.3"},
                "installedCliProvenance": {"ready": True},
            },
        }
        success = {"ok": True, "failures": [], "versions": failure["versions"]}
        inspections = iter((failure, success))
        sync_calls: list[str] = []
        original_inspect = preflight.inspect
        original_sync = preflight.sync_local_settings
        try:
            preflight.inspect = lambda provider, scry_repo, rate_native_repo: next(inspections)
            preflight.sync_local_settings = lambda repo, cli, quarantine: (
                sync_calls.append(cli) or {"source": "/fixture/settings", "targets": []}
            )
            recovered = reconcile_source_settings_only(
                "codex",
                root / "scry",
                root / "rate-native",
                root / "environment-recovery.json",
            )
        finally:
            preflight.inspect = original_inspect
            preflight.sync_local_settings = original_sync
        assert recovered["ok"] is True
        assert recovered["recovery"]["status"] == "FROZEN_READY"
        assert sync_calls == ["/fixture/stable/scry"]
    with tempfile.TemporaryDirectory() as raw:
        root = Path(raw)
        old_run = root / "old-run"
        recovery_run = root / "recovery-run"
        scry_repo = root / "scry"
        old_run.mkdir()
        recovery_run.mkdir()
        (scry_repo / "packages/turn-recorder-cli").mkdir(parents=True)
        (scry_repo / "src/core/turn-recorder").mkdir(parents=True)
        (scry_repo / "packages/turn-recorder-cli/package.json").write_text('{"version":"1.2.3"}\n')
        (scry_repo / "src/core/turn-recorder/store.ts").write_text(
            "export const RECORDER_VERSION = '1.2.3'\n"
        )
        (old_run / "preflight.json").write_text(json.dumps({
            "ok": True,
            "versions": {
                "scry": {"package": "1.2.3"},
                "rateNative": {"cliVersion": "1.2.3"},
            },
        }))
        calls: list[str] = []
        lock_requests: list[dict[str, Any]] = []
        original_registry = preflight.ensure_registry_version
        original_installed = preflight.ensure_installed_recorder
        original_mutation_lock = mutation_lock

        @contextmanager
        def fixture_mutation_lock(name: str, run_root: Path, **options: Any) -> Iterator[dict[str, Any]]:
            lock_requests.append({"name": name, "runRoot": run_root, "options": options})
            yield {"ok": True}

        try:
            mutation_lock = fixture_mutation_lock
            preflight.ensure_registry_version = lambda repo, expected: (
                calls.append(f"registry:{expected}") or {"exact": expected, "latest": expected}
            )
            preflight.ensure_installed_recorder = lambda expected: (
                calls.append(f"installed:{expected}")
                or {"installed": True, "path": "/fixture/stable/scry", "version": expected}
            )
            cleanup = recover_cleanup_cli("codex", old_run, recovery_run, scry_repo)
            assert cleanup["status"] == "CLEANUP_CLI_READY"
            assert cleanup["frozenVersion"] == "1.2.3" and cleanup["targetVersion"] == "1.2.3"
            assert calls == ["registry:1.2.3", "installed:1.2.3"]
            # 跨版本恢复：source 已升级，清理仍以最新 source 版本为目标，frozen 只披露
            (scry_repo / "packages/turn-recorder-cli/package.json").write_text('{"version":"9.9.9"}\n')
            (scry_repo / "src/core/turn-recorder/store.ts").write_text(
                "export const RECORDER_VERSION = '9.9.9'\n"
            )
            calls.clear()
            cleanup = recover_cleanup_cli("codex", old_run, recovery_run, scry_repo)
            assert cleanup["status"] == "CLEANUP_CLI_READY"
            assert cleanup["frozenVersion"] == "1.2.3" and cleanup["targetVersion"] == "9.9.9"
            assert calls == ["registry:9.9.9", "installed:9.9.9"]
        finally:
            mutation_lock = original_mutation_lock
            preflight.ensure_registry_version = original_registry
            preflight.ensure_installed_recorder = original_installed
        assert lock_requests == [{
            "name": "environment",
            "runRoot": recovery_run,
            "options": {"allowed_pre_send_recovery": ("codex", old_run)},
        }, {
            "name": "environment",
            "runRoot": recovery_run,
            "options": {"allowed_pre_send_recovery": ("codex", old_run)},
        }]
    print("self-test: PASS")
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--provider", choices=sorted(fixed.PROVIDERS))
    parser.add_argument("--run-root")
    parser.add_argument("--scry-repo", default=str(preflight.DEFAULT_SCRY_REPO))
    parser.add_argument("--rate-native-repo", default=str(preflight.DEFAULT_RATE_NATIVE_REPO))
    args = parser.parse_args()
    if not args.self_test and (not args.provider or not args.run_root):
        parser.error("--provider and --run-root are required")
    return args


def main() -> int:
    args = parse_args()
    if args.self_test:
        return self_test()
    result = build_environment(
        args.provider,
        fixed.safe_run_root(args.run_root),
        Path(args.scry_repo).expanduser().resolve(),
        Path(args.rate_native_repo).expanduser().resolve(),
    )
    emit(result)
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
