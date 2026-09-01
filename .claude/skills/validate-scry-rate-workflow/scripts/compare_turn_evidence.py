#!/usr/bin/env python3
"""按 sessionId 对齐 Scry archive 与 scry CLI records，做 evidence 字段级深度对账。

`verify_local_session.py` 的全 evidence 比较依赖“恰好三轮”前置；三轮未成立时它会
跳过契约 B.6。本脚本不关心轮数，只回答“同一轮在两侧是否逐字段相等”，用于失败运行
仍能交付数据一致性结论。它不替代 `verify_local_session.py`，也不产生 PASS 结论。
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
from collections import Counter
from datetime import datetime
from pathlib import Path
from typing import Any

EVIDENCE_KEYS = (
    "user", "assistant", "tools", "skills", "mcps", "hooks",
    "usage", "files", "diff", "dangerousOperations", "errors", "interventions",
)
TURN_FIELDS = ("providerTurnId", "status", "startedAt", "completedAt", "durationMs")


def load(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json_atomic(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_name(f"{path.name}.tmp-{os.getpid()}")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.chmod(0o600)
    temporary.replace(path)


def first_diff(left: Any, right: Any, path: str = "") -> str | None:
    if type(left) is not type(right):
        return f"{path or '<root>'}: type {type(left).__name__} vs {type(right).__name__}"
    if isinstance(left, dict):
        for key in sorted(set(left) | set(right)):
            if key not in left:
                return f"{path}.{key}: missing in archive"
            if key not in right:
                return f"{path}.{key}: missing in record"
            found = first_diff(left[key], right[key], f"{path}.{key}")
            if found:
                return found
        return None
    if isinstance(left, list):
        if len(left) != len(right):
            return f"{path}: length {len(left)} vs {len(right)}"
        for index, (one, other) in enumerate(zip(left, right)):
            found = first_diff(one, other, f"{path}[{index}]")
            if found:
                return found
        return None
    return None if left == right else f"{path}: {left!r} vs {right!r}"


def archive_turns(user_data: Path, session_id: str) -> list[tuple[Path, dict[str, Any]]]:
    found: list[tuple[Path, dict[str, Any]]] = []
    root = user_data / "trace-archive-turns-v1"
    for path in sorted(root.rglob("turn-*.json")) if root.is_dir() else []:
        archive = load(path)
        if not isinstance(archive, dict) or archive.get("sessionId") != session_id:
            continue
        turns = archive["turns"] if isinstance(archive.get("turns"), list) else [archive]
        for turn in turns:
            found.append((path, turn))
    return found


def cli_records(workspace: Path, session_id: str) -> list[tuple[Path, dict[str, Any]]]:
    root = workspace / ".scry" / "records"
    found: list[tuple[Path, dict[str, Any]]] = []
    for path in sorted(root.glob("*.json")) if root.is_dir() else []:
        record = load(path)
        if isinstance(record, dict) and record.get("sessionId") == session_id:
            found.append((path, record))
    return found


def duration_arithmetic(turn: dict[str, Any]) -> dict[str, Any]:
    started, completed, duration = turn.get("startedAt"), turn.get("completedAt"), turn.get("durationMs")
    if not (isinstance(started, str) and isinstance(completed, str) and isinstance(duration, int)):
        return {"checked": False}

    def moment(value: str) -> float:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000

    try:
        expected = round(moment(completed) - moment(started))
    except ValueError as exc:
        return {"checked": False, "error": str(exc)}
    return {"checked": True, "expected": expected, "actual": duration, "equal": expected == duration}


def compare(user_data: Path, workspace: Path, session_id: str) -> dict[str, Any]:
    archives = archive_turns(user_data, session_id)
    records = cli_records(workspace, session_id)
    archive_ids = [turn.get("providerTurnId") for _, turn in archives if isinstance(turn.get("providerTurnId"), str)]
    record_ids = [record.get("providerTurnId") for _, record in records if isinstance(record.get("providerTurnId"), str)]
    duplicate_archive_ids = sorted(value for value, count in Counter(archive_ids).items() if count > 1)
    duplicate_record_ids = sorted(value for value, count in Counter(record_ids).items() if count > 1)
    by_turn_id = {
        record.get("providerTurnId"): (path, record)
        for path, record in records
        if isinstance(record.get("providerTurnId"), str) and record.get("providerTurnId") not in duplicate_record_ids
    }
    pairs: list[dict[str, Any]] = []
    unmatched_archives: list[str] = []
    for archive_path, turn in archives:
        turn_id = turn.get("providerTurnId")
        matched = by_turn_id.pop(turn_id, None) if isinstance(turn_id, str) else None
        if not matched:
            unmatched_archives.append(f"{archive_path.name}: providerTurnId={turn_id!r}")
            continue
        record_path, record = matched
        evidence = {}
        for key in EVIDENCE_KEYS:
            diff = first_diff((turn.get("turnEvidence") or {}).get(key), record.get(key), key)
            evidence[key] = {"equal": diff is None, "firstDiff": diff}
        fields = {
            field: {"equal": turn.get(field) == record.get(field),
                    "archive": turn.get(field), "record": record.get(field)}
            for field in TURN_FIELDS
        }
        arithmetic = duration_arithmetic(turn)
        pairs.append({
            "providerTurnId": turn_id,
            "turnIndex": record.get("turnIndex"),
            "generation": record.get("generation"),
            "recordId": record.get("recordId"),
            "archivePath": str(archive_path),
            "recordPath": str(record_path),
            "evidence": evidence,
            "turnFields": fields,
            "durationArithmetic": arithmetic,
            "equal": all(item["equal"] for item in evidence.values())
            and all(item["equal"] for item in fields.values())
            and arithmetic.get("equal", False),
        })
    return {
        "ok": bool(pairs)
        and len(pairs) == len(archives) == len(records)
        and not duplicate_archive_ids
        and not duplicate_record_ids
        and not unmatched_archives and not by_turn_id
        and all(pair["equal"] for pair in pairs),
        "sessionId": session_id,
        "workspace": str(workspace),
        "scryUserData": str(user_data),
        "archiveTurns": len(archives),
        "cliRecords": len(records),
        "duplicateArchiveProviderTurnIds": duplicate_archive_ids,
        "duplicateRecordProviderTurnIds": duplicate_record_ids,
        "unmatchedArchives": unmatched_archives,
        "unmatchedRecords": [str(path) for path, _ in by_turn_id.values()],
        "pairs": pairs,
    }


def self_test() -> int:
    with tempfile.TemporaryDirectory() as raw:
        root = Path(raw)
        workspace = root / "workspace"
        user_data = root / "user-data"
        records = workspace / ".scry/records"
        archives = user_data / "trace-archive-turns-v1/qoder/workspace/session"
        records.mkdir(parents=True)
        archives.mkdir(parents=True)
        evidence = {key: {"status": "available"} for key in EVIDENCE_KEYS}
        turn = {
            "providerTurnId": "turn-1",
            "status": "completed",
            "startedAt": "2026-08-08T00:00:00.000Z",
            "completedAt": "2026-08-08T00:00:01.000Z",
            "durationMs": 1000,
            "turnEvidence": evidence,
        }
        record = {**{key: value for key, value in evidence.items()}, **{
            field: turn[field] for field in TURN_FIELDS
        }, "sessionId": "session", "recordId": "record-1", "turnIndex": 1, "generation": 1}
        (archives / "turn-1.json").write_text(
            json.dumps({"sessionId": "session", "turns": [turn]}), encoding="utf-8"
        )
        (records / "record-1.json").write_text(json.dumps(record), encoding="utf-8")
        assert compare(user_data, workspace, "session")["ok"] is True
        (records / "record-duplicate.json").write_text(json.dumps(record), encoding="utf-8")
        duplicate = compare(user_data, workspace, "session")
        assert duplicate["ok"] is False
        assert duplicate["duplicateRecordProviderTurnIds"] == ["turn-1"]
        assert duration_arithmetic({
            "startedAt": "invalid", "completedAt": "invalid", "durationMs": 0,
        })["checked"] is False
    print("self-test: PASS")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--workspace")
    parser.add_argument("--scry-user-data")
    parser.add_argument("--session-id")
    parser.add_argument("--output")
    args = parser.parse_args()
    if args.self_test:
        return self_test()
    if not args.workspace or not args.scry_user_data or not args.session_id:
        parser.error("--workspace, --scry-user-data, and --session-id are required")

    result = compare(
        Path(args.scry_user_data).expanduser().resolve(),
        Path(args.workspace).expanduser().resolve(),
        args.session_id,
    )
    text = json.dumps(result, ensure_ascii=False, indent=2)
    if args.output:
        write_json_atomic(Path(args.output).expanduser().resolve(), result)
    print(text)
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
