#!/usr/bin/env python3
"""Run lightweight identity checks against one frozen validation bundle."""

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
import preflight
import workflow_snapshot


PHASES = {"handoff", "pre-launch", "final"}


def contract_identity(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    return {
        "schemaVersion": value.get("schemaVersion") if isinstance(value, dict) else None,
        "sha256": "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest(),
    }


def add_check(checks: list[dict[str, Any]], name: str, ok: bool, expected: Any, actual: Any) -> None:
    checks.append({"name": name, "ok": bool(ok), "expected": expected, "actual": actual})


def command_value(command: list[str], cwd: Path | None = None) -> tuple[int, str]:
    completed = fixed.run(command, cwd=cwd, timeout=30)
    return completed.returncode, (completed.stdout or completed.stderr).strip()


def canonical_scry_audit(
    scry_repo: Path,
    frozen_source: dict[str, Any],
    probe: Callable[[list[str], Path | None], tuple[int, str]] = command_value,
) -> dict[str, Any]:
    head_code, current_head = probe(["git", "rev-parse", "HEAD"], scry_repo)
    tree_code, current_tree = probe(["git", "rev-parse", "HEAD^{tree}"], scry_repo)
    return {
        "path": str(scry_repo),
        "frozenHead": frozen_source.get("head"),
        "currentHead": current_head if head_code == 0 else None,
        "changedSinceFreeze": (
            head_code != 0
            or tree_code != 0
            or current_head != frozen_source.get("head")
            or current_tree != frozen_source.get("treeHash")
        ),
        "probeErrors": {
            "head": None if head_code == 0 else current_head,
            "tree": None if tree_code == 0 else current_tree,
        },
    }


def verify(provider: str, run_root: Path, phase: str, workspace: Path | None) -> dict[str, Any]:
    run_root = fixed.safe_run_root(str(run_root))
    checks: list[dict[str, Any]] = []
    failures: list[str] = []
    audit: dict[str, Any] = {}
    try:
        prepared_path = run_root / "environment-prepared.json"
        if prepared_path.is_symlink() or not prepared_path.is_file():
            raise RuntimeError(f"environment evidence is missing or unsafe: {prepared_path}")
        prepared = fixed.read_json(prepared_path)
        scry_repo = Path(str(prepared.get("scryRepo", ""))).expanduser().resolve()
        manifest = workflow_snapshot.validate(run_root, scry_repo)
        expected_script = Path(str(manifest["path"])) / "scripts" / Path(__file__).name
        add_check(checks, "workflow.entrypoint", Path(__file__).resolve() == expected_script, str(expected_script), str(Path(__file__).resolve()))
        add_check(checks, "environment.state", prepared.get("state") == "FROZEN_READY", "FROZEN_READY", prepared.get("state"))
        add_check(checks, "environment.provider", prepared.get("provider") == provider, provider, prepared.get("provider"))
        add_check(checks, "environment.runRoot", prepared.get("runRoot") == str(run_root), str(run_root), prepared.get("runRoot"))
        add_check(checks, "workflow.manifest", prepared.get("workflowSnapshot") == manifest, manifest, prepared.get("workflowSnapshot"))

        baseline = Path(str(prepared.get("baselinePreflight", ""))).expanduser().resolve()
        allowed_baselines = {run_root / "preflight.json", run_root / "preflight-build-cache.json"}
        if baseline not in allowed_baselines or baseline.is_symlink() or not baseline.is_file():
            raise RuntimeError(f"baseline preflight path is outside the run root: {baseline}")
        baseline_fingerprint = workflow_snapshot.regular_file_fingerprint(baseline)
        baseline_writable = workflow_snapshot.writable_paths(baseline)
        add_check(checks, "baseline.read_only", not baseline_writable, [], baseline_writable)
        add_check(
            checks,
            "baseline.fingerprint",
            baseline_fingerprint == prepared.get("baselinePreflightFingerprint"),
            prepared.get("baselinePreflightFingerprint"),
            baseline_fingerprint,
        )
        frozen = fixed.read_json(baseline)
        add_check(checks, "baseline.ok", frozen.get("ok") is True, True, frozen.get("ok"))
        frozen_contract = frozen.get("contract") if isinstance(frozen, dict) else None
        live_contract = contract_identity(Path(str(manifest["path"])) / "references" / "contract.json")
        add_check(checks, "contract.frozen", frozen_contract == live_contract, live_contract, frozen_contract)

        build_out = Path(str(prepared.get("buildOut", ""))).expanduser().resolve()
        expected_build_out = run_root / "scry-build-out"
        add_check(checks, "build.path", build_out == expected_build_out, str(expected_build_out), str(build_out))
        build_actual = preflight.tree_fingerprint(build_out)
        build_expected = frozen.get("buildArtifacts") if isinstance(frozen, dict) else None
        add_check(checks, "build.fingerprint", build_actual == build_expected, build_expected, build_actual)
        build_writable = workflow_snapshot.writable_paths(build_out)
        add_check(checks, "build.read_only", not build_writable, [], build_writable[:10])
        build_symlinks = workflow_snapshot.tree_symlinks(build_out)
        add_check(checks, "build.no_symlinks", not build_symlinks, [], build_symlinks[:10])

        versions = frozen.get("versions", {}) if isinstance(frozen, dict) else {}
        rate_native = versions.get("rateNative", {}) if isinstance(versions, dict) else {}
        cli_path = rate_native.get("cliPath") if isinstance(rate_native, dict) else None
        expected_cli_version = rate_native.get("cliVersion") if isinstance(rate_native, dict) else None
        add_check(checks, "recorder.path", prepared.get("scryBin") == cli_path, cli_path, prepared.get("scryBin"))
        cli = preflight.executable_version(cli_path)
        add_check(checks, "recorder.version", cli.get("version") == expected_cli_version, expected_cli_version, cli)
        cli_fingerprint = workflow_snapshot.executable_fingerprint(Path(str(cli_path)))
        add_check(
            checks,
            "recorder.fingerprint",
            cli_fingerprint == prepared.get("scryBinFingerprint"),
            prepared.get("scryBinFingerprint"),
            cli_fingerprint,
        )
        expected_provenance = versions.get("installedCliProvenance") if isinstance(versions, dict) else None
        current_provenance = preflight.installed_recorder_provenance(expected_cli_version)
        add_check(
            checks,
            "recorder.provenance",
            current_provenance == expected_provenance,
            expected_provenance,
            current_provenance,
        )

        if phase in {"pre-launch", "final"}:
            if workspace is None:
                raise RuntimeError(f"--workspace is required for phase {phase}")
            workspace = workspace.expanduser().resolve()
            expected_workspace = fixed.workspace_for(provider)
            add_check(checks, "workspace.path", workspace == expected_workspace, str(expected_workspace), str(workspace))
            code, head = command_value(["git", "rev-parse", "HEAD"], workspace)
            expected_head = frozen.get("git", {}).get("rateNative", {}).get("head")
            add_check(checks, "workspace.head", code == 0 and head == expected_head, expected_head, head if code == 0 else {"exit": code, "output": head})

        frozen_source = frozen.get("git", {}).get("scry", {}) if isinstance(frozen, dict) else {}
        audit["canonicalScry"] = canonical_scry_audit(scry_repo, frozen_source)
    except (OSError, RuntimeError, ValueError, json.JSONDecodeError) as exc:
        failures.append(str(exc))
    failures.extend(item["name"] for item in checks if item.get("ok") is not True)
    return {
        "schemaVersion": 1,
        "ok": not failures,
        "phase": phase,
        "provider": provider,
        "runRoot": str(run_root),
        "checks": checks,
        "failures": failures,
        "audit": audit,
    }


def write_json_atomic(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if os.path.lexists(path) and path.is_symlink():
        raise RuntimeError(f"refusing to replace a symlink output: {path}")
    temporary = path.with_name(f"{path.name}.tmp-{os.getpid()}")
    if os.path.lexists(temporary):
        raise RuntimeError(f"verification temporary output already exists: {temporary}")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.chmod(0o600)
    temporary.replace(path)


def self_test() -> int:
    with tempfile.TemporaryDirectory() as raw:
        root = Path(raw)
        contract = root / "contract.json"
        contract.write_text('{"schemaVersion":8}\n', encoding="utf-8")
        assert contract_identity(contract)["sha256"].startswith("sha256:")
        build = root / "out"
        build.mkdir()
        (build / "fixture.js").write_text("before\n", encoding="utf-8")
        before = preflight.tree_fingerprint(build)
        (build / "fixture.js").write_text("after\n", encoding="utf-8")
        assert preflight.tree_fingerprint(build) != before
        answers = iter([(0, "new-head"), (0, "new-tree")])
        audit = canonical_scry_audit(
            root,
            {"head": "old-head", "treeHash": "old-tree"},
            lambda command, cwd: next(answers),
        )
        assert audit["changedSinceFreeze"] is True
        checks: list[dict[str, Any]] = []
        add_check(checks, "audit-only", True, "old-head", "new-head")
        assert checks[0]["ok"] is True
    print("self-test: PASS")
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--provider", choices=sorted(fixed.PROVIDERS))
    parser.add_argument("--run-root")
    parser.add_argument("--phase", choices=sorted(PHASES))
    parser.add_argument("--workspace")
    parser.add_argument("--output")
    args = parser.parse_args()
    if not args.self_test and not all((args.provider, args.run_root, args.phase, args.output)):
        parser.error("--provider, --run-root, --phase and --output are required")
    return args


def main() -> int:
    args = parse_args()
    if args.self_test:
        return self_test()
    run_root = fixed.safe_run_root(args.run_root)
    output = Path(args.output).expanduser().resolve()
    if (
        output.parent != run_root
        or not output.name.startswith("frozen-identity-")
        or output.suffix != ".json"
    ):
        raise RuntimeError(f"verification output must be a frozen-identity-*.json child of {run_root}")
    result = verify(
        args.provider,
        run_root,
        args.phase,
        Path(args.workspace) if args.workspace else None,
    )
    write_json_atomic(output, result)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
