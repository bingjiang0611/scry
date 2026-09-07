#!/usr/bin/env python3
"""Materialize and verify one immutable run-local workflow bundle."""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import stat
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


SNAPSHOT_NAME = "workflow"
MANIFEST_NAME = "workflow-snapshot.json"
IGNORED_PARTS = {"__pycache__"}


def now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def snapshot_files(root: Path) -> list[Path]:
    if root.is_symlink() or not root.is_dir():
        raise RuntimeError(f"workflow source must be a regular directory: {root}")
    files: list[Path] = []
    for path in sorted(root.rglob("*"), key=lambda item: str(item.relative_to(root))):
        relative = path.relative_to(root)
        if any(part in IGNORED_PARTS for part in relative.parts) or path.suffix == ".pyc":
            continue
        if path.is_symlink():
            raise RuntimeError(f"workflow source contains a symlink: {path}")
        if path.is_file():
            files.append(path)
        elif not path.is_dir():
            raise RuntimeError(f"workflow source contains an unsupported node: {path}")
    if not files:
        raise RuntimeError(f"workflow source has no files: {root}")
    return files


def fingerprint(root: Path) -> dict[str, Any]:
    digest = hashlib.sha256()
    files = snapshot_files(root)
    for path in files:
        relative = path.relative_to(root).as_posix()
        digest.update(relative.encode())
        digest.update(b"\0")
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
        digest.update(b"\0")
    return {"files": len(files), "sha256": "sha256:" + digest.hexdigest()}


def regular_file_fingerprint(path: Path) -> dict[str, Any]:
    if not path.is_absolute() or path.is_symlink() or not path.is_file():
        raise RuntimeError(f"file identity is missing or unsafe: {path}")
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return {
        "path": str(path),
        "size": path.stat().st_size,
        "sha256": "sha256:" + digest.hexdigest(),
    }


def executable_fingerprint(path: Path) -> dict[str, Any]:
    if not os.access(path, os.X_OK):
        raise RuntimeError(f"executable identity is not runnable: {path}")
    return {
        **regular_file_fingerprint(path),
        "resolved": str(path.resolve()),
    }


def write_json_atomic(path: Path, value: dict[str, Any]) -> None:
    temporary = path.with_name(f"{path.name}.tmp-{os.getpid()}")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.chmod(0o600)
    temporary.replace(path)


def make_read_only(root: Path) -> None:
    if root.is_symlink() or not root.is_dir():
        raise RuntimeError(f"refusing to freeze a symlinked or missing tree root: {root}")
    symlinks = tree_symlinks(root)
    if symlinks:
        raise RuntimeError(f"refusing to freeze a tree containing symlinks: {symlinks[:10]}")
    for path in sorted(root.rglob("*"), key=lambda item: len(item.parts), reverse=True):
        if path.is_symlink():
            continue
        if path.is_file():
            path.chmod(0o500 if path.suffix in {".py", ".mjs"} else 0o400)
        elif path.is_dir():
            path.chmod(0o500)
    root.chmod(0o500)


def tree_symlinks(root: Path) -> list[str]:
    if root.is_symlink():
        return [str(root)]
    return [str(path) for path in root.rglob("*") if path.is_symlink()]


def writable_paths(root: Path) -> list[str]:
    return [
        str(path)
        for path in [root, *root.rglob("*")]
        if not path.is_symlink() and stat.S_IMODE(path.stat().st_mode) & 0o222
    ]


def materialize(skill_dir: Path, run_root: Path, scry_repo: Path) -> dict[str, Any]:
    skill_dir = skill_dir.resolve()
    run_root = run_root.resolve()
    scry_repo = scry_repo.resolve()
    destination = run_root / SNAPSHOT_NAME
    manifest_path = run_root / MANIFEST_NAME
    if os.path.lexists(destination) or os.path.lexists(manifest_path):
        raise RuntimeError(f"run root already contains workflow snapshot state: {run_root}")
    source_before = fingerprint(skill_dir)
    temporary = Path(tempfile.mkdtemp(prefix="workflow.tmp-", dir=run_root))
    try:
        for source in snapshot_files(skill_dir):
            relative = source.relative_to(skill_dir)
            target = temporary / relative
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            shutil.copy2(source, target)
        source_after = fingerprint(skill_dir)
        copied = fingerprint(temporary)
        if source_before != source_after or copied != source_before:
            raise RuntimeError(
                "workflow source changed while freezing: "
                f"{json.dumps({'before': source_before, 'after': source_after, 'copied': copied})}"
            )
        temporary.replace(destination)
        make_read_only(destination)
    except BaseException:
        if temporary.exists():
            shutil.rmtree(temporary, ignore_errors=True)
        if destination.exists():
            destination.chmod(0o700)
            shutil.rmtree(destination, ignore_errors=True)
        raise
    manifest = {
        "schemaVersion": 1,
        "path": str(destination),
        "sourceSkillDir": str(skill_dir),
        "scryRepo": str(scry_repo),
        "fingerprint": source_before,
        "createdAt": now(),
    }
    write_json_atomic(manifest_path, manifest)
    return manifest


def validate(run_root: Path, expected_scry_repo: Path | None = None) -> dict[str, Any]:
    run_root = run_root.resolve()
    manifest_path = run_root / MANIFEST_NAME
    snapshot = run_root / SNAPSHOT_NAME
    if manifest_path.is_symlink() or not manifest_path.is_file():
        raise RuntimeError(f"workflow snapshot manifest is missing or unsafe: {manifest_path}")
    if snapshot.is_symlink() or not snapshot.is_dir():
        raise RuntimeError(f"workflow snapshot is missing or unsafe: {snapshot}")
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"workflow snapshot manifest is unreadable: {manifest_path}: {exc}") from exc
    expected = {
        "schemaVersion": 1,
        "path": str(snapshot),
    }
    actual = {key: manifest.get(key) if isinstance(manifest, dict) else None for key in expected}
    if actual != expected:
        raise RuntimeError(f"workflow snapshot identity mismatch: expected {expected}, got {actual}")
    raw_scry_repo = manifest.get("scryRepo")
    if not isinstance(raw_scry_repo, str) or not Path(raw_scry_repo).is_absolute():
        raise RuntimeError("workflow snapshot has no absolute Scry repo identity")
    scry_repo = Path(raw_scry_repo).resolve()
    if expected_scry_repo is not None and scry_repo != expected_scry_repo.resolve():
        raise RuntimeError(
            f"workflow snapshot Scry repo mismatch: expected {expected_scry_repo.resolve()}, got {scry_repo}"
        )
    writable = writable_paths(snapshot)
    if writable:
        raise RuntimeError(f"workflow snapshot contains writable paths: {writable[:10]}")
    recorded = manifest.get("fingerprint")
    live = fingerprint(snapshot)
    if not isinstance(recorded, dict) or live != recorded:
        raise RuntimeError(f"workflow snapshot fingerprint mismatch: expected {recorded}, got {live}")
    return manifest


def self_test() -> int:
    with tempfile.TemporaryDirectory() as raw:
        root = Path(raw)
        skill = root / "skill"
        run = root / "validate-scry-rate-workflow-fixture"
        scry = root / "scry"
        (skill / "scripts").mkdir(parents=True)
        (skill / "references").mkdir()
        run.mkdir()
        scry.mkdir()
        (skill / "SKILL.md").write_text("fixture\n", encoding="utf-8")
        (skill / "scripts/tool.py").write_text("print('ok')\n", encoding="utf-8")
        (skill / "references/contract.json").write_text("{}\n", encoding="utf-8")
        (skill / "scripts/__pycache__").mkdir()
        (skill / "scripts/__pycache__/tool.pyc").write_bytes(b"ignored")
        manifest = materialize(skill, run, scry)
        assert manifest["fingerprint"]["files"] == 3
        assert validate(run, scry) == manifest
        executable = root / "fixture-cli"
        executable.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
        executable.chmod(0o700)
        assert executable_fingerprint(executable)["sha256"].startswith("sha256:")
        assert regular_file_fingerprint(skill / "SKILL.md")["size"] == len("fixture\n")
        assert not (run / SNAPSHOT_NAME / "scripts/__pycache__").exists()
        external = root / "external"
        external.mkdir()
        external_file = external / "target.txt"
        external_file.write_text("outside\n", encoding="utf-8")
        linked = root / "linked-tree"
        linked.mkdir()
        (linked / "file-link").symlink_to(external_file)
        (linked / "dir-link").symlink_to(external, target_is_directory=True)
        external_mode = stat.S_IMODE(external.stat().st_mode)
        external_file_mode = stat.S_IMODE(external_file.stat().st_mode)
        try:
            make_read_only(linked)
            raise AssertionError("tree containing symlinks was frozen")
        except RuntimeError as exc:
            assert "containing symlinks" in str(exc)
        assert stat.S_IMODE(external.stat().st_mode) == external_mode
        assert stat.S_IMODE(external_file.stat().st_mode) == external_file_mode
        linked_root = root / "linked-root"
        linked_root.symlink_to(external, target_is_directory=True)
        try:
            make_read_only(linked_root)
            raise AssertionError("symlinked root was frozen")
        except RuntimeError as exc:
            assert "symlinked or missing tree root" in str(exc)
        (run / SNAPSHOT_NAME).chmod(0o700)
        target = run / SNAPSHOT_NAME / "SKILL.md"
        target.chmod(0o600)
        target.write_text("tampered\n", encoding="utf-8")
        try:
            validate(run, scry)
            raise AssertionError("tampered workflow snapshot was accepted")
        except RuntimeError as exc:
            assert "writable paths" in str(exc) or "fingerprint mismatch" in str(exc)
    print("self-test: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(self_test())
