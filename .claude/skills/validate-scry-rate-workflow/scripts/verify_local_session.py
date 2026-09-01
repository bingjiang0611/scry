#!/usr/bin/env python3
"""Reconcile one three-turn Scry session with its Scry CLI records and summary."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import subprocess
import sys
import tempfile
from collections import Counter
from datetime import datetime
from pathlib import Path
from typing import Any


SKILL_DIR = Path(__file__).resolve().parent.parent
CONTRACT = json.loads((SKILL_DIR / "references" / "contract.json").read_text(encoding="utf-8"))
PROVIDERS = CONTRACT["providers"]
RUNTIME = {provider: value["runtime"] for provider, value in PROVIDERS.items()}
SOURCE_WORKITEM_ID = CONTRACT["sourceWorkitem"]["id"]
SCRY_SOURCE_REPO = Path("/Users/baobingjiang/IdeaProjects/vibecoding/scry").resolve()
TEST_RUN_PREFIX = "validate-scry-rate-workflow-"
TEST_RUN_ROOT_PARENT = Path(CONTRACT["retention"]["runRootParent"]).expanduser().resolve()
SECOND_PROMPT = CONTRACT["secondPrompt"]
THIRD_PROMPT = CONTRACT["thirdPrompt"]
ARCHIVE_VERSION = CONTRACT["archiveVersion"]
PERMISSION = CONTRACT["permission"]
RUNTIME_SNAPSHOT = CONTRACT["recoveryPolicy"]["runtimeSnapshot"]
EXPECTED_SCRY_CLI_VERSION = str(json.loads(
    (SCRY_SOURCE_REPO / "packages" / "turn-recorder-cli" / "package.json").read_text(encoding="utf-8")
)["version"])
EVIDENCE_KEYS = (
    "user",
    "assistant",
    "tools",
    "skills",
    "mcps",
    "hooks",
    "usage",
    "files",
    "diff",
    "dangerousOperations",
    "errors",
    "interventions",
)


def first_prompt(provider: str, workitem_id: str) -> str:
    command = PROVIDERS[provider]["command"]
    return f"{command} {workitem_id} {CONTRACT['firstPromptSuffix']}"


def add_check(checks: list[dict[str, Any]], name: str, ok: bool, expected: Any, actual: Any) -> None:
    checks.append({"name": name, "ok": ok, "expected": expected, "actual": actual})


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def hash_text(text: str) -> str:
    return "sha256:" + hashlib.sha256(text.encode()).hexdigest()


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


def normalize_path(value: str, workspace: Path) -> str:
    value = value.replace(str(workspace), "$WORKSPACE")
    home = str(Path.home())
    return value.replace(home, "$HOME")


def normalize(value: Any, workspace: Path) -> Any:
    if isinstance(value, str):
        return normalize_path(value, workspace)
    if isinstance(value, list):
        return [normalize(item, workspace) for item in value]
    if isinstance(value, dict):
        return {
            key: normalize(item, workspace)
            for key, item in sorted(value.items())
        }
    return value


def evidence_summary(_key: str, evidence: Any, workspace: Path) -> Any:
    """完整比较证据；只把环境相关绝对路径改成稳定占位符。"""
    return normalize(evidence, workspace)


def strict_equal(expected: Any, actual: Any) -> bool:
    """JSON-like values must match recursively, including their concrete types."""
    if type(expected) is not type(actual):
        return False
    if isinstance(expected, dict):
        return (
            expected.keys() == actual.keys()
            and all(strict_equal(expected[key], actual[key]) for key in expected)
        )
    if isinstance(expected, list):
        return (
            len(expected) == len(actual)
            and all(strict_equal(left, right) for left, right in zip(expected, actual))
        )
    return expected == actual


def exact_text_state(evidence: Any, expected_text: str | None = None) -> tuple[bool, dict[str, Any]]:
    value = evidence.get("value") if isinstance(evidence, dict) else None
    text = value.get("text") if isinstance(value, dict) else None
    text_hash = value.get("textHash") if isinstance(value, dict) else None
    expected_hash = hash_text(text) if isinstance(text, str) else None
    ok = (
        isinstance(evidence, dict)
        and evidence.get("status") == "available"
        and evidence.get("quality") == "exact"
        and isinstance(text, str)
        and bool(text)
        and text_hash == expected_hash
        and (expected_text is None or text == expected_text)
    )
    return ok, {
        "status": evidence.get("status") if isinstance(evidence, dict) else None,
        "quality": evidence.get("quality") if isinstance(evidence, dict) else None,
        "text": text,
        "textHash": text_hash,
        "computedTextHash": expected_hash,
        "expectedText": expected_text,
    }


def turn_timing(turn: dict[str, Any]) -> dict[str, Any]:
    return {
        "startedAt": turn.get("startedAt"),
        "completedAt": turn.get("completedAt"),
        "durationMs": turn.get("durationMs"),
    }


def valid_turn_timing(turn: dict[str, Any]) -> bool:
    started = iso_epoch_ms(turn.get("startedAt"))
    completed = iso_epoch_ms(turn.get("completedAt"))
    duration = numeric(turn.get("durationMs"))
    return (
        started is not None
        and completed is not None
        and duration is not None
        and duration >= 0
        and completed >= started
        and completed - started == duration
    )


def raw_assistant_text(turn: dict[str, Any]) -> str:
    items = turn.get("items")
    if not isinstance(items, list):
        return ""
    output: list[str] = []
    run: list[dict[str, Any]] = []
    run_key: tuple[Any, Any, Any] | None = None

    def flush() -> None:
        nonlocal run, run_key
        if not run:
            return
        deltas = "".join(
            str(event.get("text", ""))
            for event in run
            if event.get("stage") == "text_delta"
        )
        for event in run:
            text = str(event.get("text", ""))
            if event.get("stage") == "text" and deltas and text == deltas:
                continue
            output.append(text)
        run = []
        run_key = None

    for item in items:
        if (
            not isinstance(item, dict)
            or item.get("kind") != "model"
            or item.get("stage") not in {"text", "text_delta"}
            or item.get("text") is None
        ):
            flush()
            continue
        key = (item.get("messageId"), item.get("agentId"), item.get("parentToolUseId"))
        if run and run_key != key:
            flush()
        run_key = key
        run.append(item)
    flush()
    return "".join(output)


def output_summary(value: Any) -> str | None:
    if not isinstance(value, str) or not value:
        return None
    utf16 = value.encode("utf-16-le", errors="surrogatepass")
    return value if len(utf16) <= 1000 else utf16[:1000].decode("utf-16-le", errors="surrogatepass") + "…"


def raw_overview_errors(turn: dict[str, Any]) -> list[dict[str, Any]]:
    items = turn.get("items")
    if not isinstance(items, list):
        return []
    errors = []
    for item in items:
        if (
            not isinstance(item, dict)
            or item.get("stage") != "tool_result"
            or item.get("isError") is not True
        ):
            continue
        raw_output = item["output"] if item.get("output") is not None else item.get("text")
        message = output_summary(raw_output)
        error = {
            "message": message or f"{item.get('tool') or item.get('stage')} failed",
            "source": item.get("stage"),
        }
        if item.get("toolUseId") is not None:
            error["toolUseId"] = item.get("toolUseId")
        errors.append(error)
    return errors


def count_dict(counter: Counter[Any]) -> dict[str, int]:
    return {str(key): value for key, value in sorted(counter.items(), key=lambda item: str(item[0]))}


def evidence_coverage(records: list[dict[str, Any]], key: str) -> dict[str, Any]:
    statuses = Counter()
    qualities = Counter()
    sources = Counter()
    omission_reasons = set()
    for record in records:
        evidence = record.get(key)
        if not isinstance(evidence, dict):
            statuses["missing"] += 1
            qualities["missing"] += 1
            continue
        statuses[str(evidence.get("status", "missing"))] += 1
        qualities[str(evidence.get("quality", "missing"))] += 1
        for source in evidence.get("source", []):
            sources[str(source)] += 1
        reason = evidence.get("omissionReason")
        if reason:
            omission_reasons.add(str(reason))
    return {
        "totalTurns": len(records),
        "statusCounts": count_dict(statuses),
        "qualityCounts": count_dict(qualities),
        "sources": count_dict(sources),
        "omissionReasons": sorted(omission_reasons),
        "complete": bool(records) and statuses == Counter({"available": len(records)}),
    }


def evidence_items(records: list[dict[str, Any]], key: str) -> list[dict[str, Any]]:
    result = []
    for record in records:
        evidence = record.get(key)
        value = evidence.get("value") if isinstance(evidence, dict) else None
        if isinstance(value, list):
            result.extend(item for item in value if isinstance(item, dict))
    return result


def verify_qoder_question_journal(
    run_root: Path,
    provider: str,
    session_id: str,
    records: list[dict[str, Any]],
    checks: list[dict[str, Any]],
) -> None:
    path = run_root / "qoder-question-journal.json"
    if provider != "qoder":
        add_check(
            checks,
            "qoder.question_journal.not_applicable",
            not os.path.lexists(path),
            "absent for non-Qoder provider",
            "present" if os.path.lexists(path) else "absent",
        )
        return
    interventions: list[tuple[int, dict[str, Any]]] = []
    for turn_index, record in enumerate(records, 1):
        evidence = record.get("interventions")
        values = evidence.get("value") if isinstance(evidence, dict) else None
        if isinstance(values, list):
            interventions.extend(
                (turn_index, item)
                for item in values
                if isinstance(item, dict) and item.get("source") == "qoder:AskUserQuestion"
            )
    if not os.path.lexists(path):
        add_check(
            checks,
            "qoder.question_journal.optional_absence",
            not interventions,
            "no Qoder AskUserQuestion intervention when journal is absent",
            {"interventionCount": len(interventions)},
        )
        return
    if path.is_symlink() or not path.is_file():
        add_check(checks, "qoder.question_journal.safe_file", False, "regular run-local JSON", str(path))
        return
    try:
        journal = load_json(path)
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        add_check(checks, "qoder.question_journal.safe_file", False, "parseable run-local JSON", type(exc).__name__)
        return
    answer_evidence = journal.get("answerEvidence") if isinstance(journal, dict) else None
    add_check(
        checks,
        "qoder.question_journal.identity",
        bool(
            isinstance(journal, dict)
            and journal.get("schemaVersion") == 1
            and journal.get("state") == "ANSWER_RECORDED"
            and journal.get("runRoot") == str(run_root)
            and journal.get("provider") == "qoder"
            and journal.get("expectedTurns") == 1
            and journal.get("sessionId") == session_id
            and journal.get("fixedDocumentUrl") == CONTRACT["document"]["url"]
            and journal.get("distinctQuestionCount") == 1
            and isinstance(answer_evidence, dict)
        ),
        {
            "state": "ANSWER_RECORDED",
            "runRoot": str(run_root),
            "provider": "qoder",
            "sessionId": session_id,
            "distinctQuestionCount": 1,
        },
        {
            "state": journal.get("state") if isinstance(journal, dict) else None,
            "runRoot": journal.get("runRoot") if isinstance(journal, dict) else None,
            "provider": journal.get("provider") if isinstance(journal, dict) else None,
            "sessionId": journal.get("sessionId") if isinstance(journal, dict) else None,
            "distinctQuestionCount": journal.get("distinctQuestionCount") if isinstance(journal, dict) else None,
        },
    )
    intervention = interventions[0][1] if len(interventions) == 1 else {}
    turn_index = interventions[0][0] if len(interventions) == 1 else None
    request = intervention.get("request") if isinstance(intervention, dict) else None
    response = intervention.get("response") if isinstance(intervention, dict) else None
    answers = response.get("answers") if isinstance(response, dict) else None
    answer_values = list(answers.values()) if isinstance(answers, dict) else []
    answer = answer_values[0].strip() if len(answer_values) == 1 and isinstance(answer_values[0], str) else None
    actual_answer_evidence = (
        {
            "bytes": len(answer.encode("utf-8")),
            "sha256": hash_text(answer),
        }
        if isinstance(answer, str) and answer
        else None
    )
    journal_tool = journal.get("toolCallId") if isinstance(journal, dict) else None
    journal_run = journal.get("runId") if isinstance(journal, dict) else None
    add_check(
        checks,
        "qoder.question_intervention.unique_bound_answer",
        bool(
            len(interventions) == 1
            and turn_index == 1
            and isinstance(request, dict)
            and request.get("providerId") == "qoder"
            and (journal_tool is None or request.get("questionId") == journal_tool)
            and (journal_run is None or request.get("runId") == journal_run)
            and intervention.get("resolution") == "answered"
            and isinstance(response, dict)
            and response.get("behavior") == "answered"
            and actual_answer_evidence is not None
            and isinstance(answer_evidence, dict)
            and answer_evidence.get("bytes") == actual_answer_evidence["bytes"]
            and answer_evidence.get("sha256") == actual_answer_evidence["sha256"]
        ),
        "one answered turn-1 qoder:AskUserQuestion bound to journal tool/run and answer bytes/hash",
        {
            "interventionCount": len(interventions),
            "turnIndex": turn_index,
            "questionId": request.get("questionId") if isinstance(request, dict) else None,
            "runId": request.get("runId") if isinstance(request, dict) else None,
            "resolution": intervention.get("resolution") if isinstance(intervention, dict) else None,
            "answerEvidence": actual_answer_evidence,
        },
    )


def call_items_overview(items: list[dict[str, Any]], coverage: dict[str, Any]) -> dict[str, Any]:
    statuses = Counter(str(item.get("status", "unknown")) for item in items)
    instances = {
        str(item.get("name") or item.get("command") or item.get("event"))
        for item in items
        if item.get("name") or item.get("command") or item.get("event")
    }
    return {
        "knownCount": len(items),
        "displayCount": len(items) if coverage["complete"] else None,
        "statusCounts": count_dict(statuses),
        "failedCount": statuses["failed"],
        "cancelledCount": statuses["cancelled"],
        "instanceCount": len(instances),
        "complete": coverage["complete"],
    }


def call_overview(records: list[dict[str, Any]], key: str) -> dict[str, Any]:
    return call_items_overview(evidence_items(records, key), evidence_coverage(records, key))


def numeric(value: Any) -> float | int | None:
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def usage_overview(records: list[dict[str, Any]]) -> dict[str, Any]:
    fields = (
        "inputTokens",
        "outputTokens",
        "cacheReadTokens",
        "cacheCreationTokens",
        "reasoningTokens",
        "costUsd",
    )
    result: dict[str, Any] = {}
    models = set()
    for field in fields:
        values = []
        for record in records:
            evidence = record.get("usage")
            value = evidence.get("value") if isinstance(evidence, dict) else None
            if isinstance(value, dict):
                number = numeric(value.get(field))
                if number is not None:
                    values.append(number)
                if value.get("model"):
                    models.add(str(value["model"]))
        known_value = sum(values) if values else None
        complete = bool(records) and len(values) == len(records)
        result[field] = {
            "knownValue": known_value,
            "displayValue": known_value if complete else None,
            "knownTurns": len(values),
            "totalTurns": len(records),
            "complete": complete,
        }
    result["models"] = sorted(models)
    return result


def files_overview(records: list[dict[str, Any]]) -> dict[str, Any]:
    items = evidence_items(records, "files")
    operations = Counter(str(item.get("operation", item.get("op", "unknown"))) for item in items)
    complete = evidence_coverage(records, "files")["complete"]
    paths = {
        str(item.get("path"))
        for item in items
        if item.get("path")
    }
    return {
        "knownUniquePathCount": len(paths),
        "displayUniquePathCount": len(paths) if paths or complete else None,
        "knownCounts": {
            "read": operations["read"],
            "write": operations["write"],
            "edit": operations["edit"],
        },
        "displayCounts": {
            "read": operations["read"] if complete else None,
            "write": operations["write"] if complete else None,
            "edit": operations["edit"] if complete else None,
        },
        "complete": complete,
    }


def diff_overview(records: list[dict[str, Any]]) -> dict[str, Any]:
    snapshots = evidence_items(records, "diff")
    added = 0
    deleted = 0
    file_count = 0
    snapshot_statuses = Counter()
    for snapshot in snapshots:
        snapshot_statuses[str(snapshot.get("status", "unknown"))] += 1
        files = snapshot.get("files")
        if not isinstance(files, list):
            continue
        for file in files:
            if not isinstance(file, dict):
                continue
            file_count += 1
            added += int(numeric(file.get("added")) or 0)
            deleted += int(numeric(file.get("deleted")) or 0)
    coverage = evidence_coverage(records, "diff")
    statuses = coverage["statusCounts"]
    displayable = bool(records) and sum(
        statuses.get(status, 0) for status in ("available", "partial")
    ) == len(records)
    return {
        "added": added,
        "deleted": deleted,
        "fileCount": file_count,
        "displayAdded": added if displayable else None,
        "displayDeleted": deleted if displayable else None,
        "displayFileCount": file_count if displayable else None,
        "snapshotCount": len(snapshots),
        "snapshotStatusCounts": count_dict(snapshot_statuses),
        "complete": coverage["complete"] and snapshot_statuses["failed"] == 0,
    }


def iso_epoch_ms(value: Any) -> int | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        return int(datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000)
    except ValueError:
        return None


def record_evidence_summary(
    records: list[dict[str, Any]],
    workspace: Path,
    provider: str,
    session_id: str,
) -> dict[str, Any]:
    started = [
        (iso_epoch_ms(record.get("startedAt")), record.get("startedAt"))
        for record in records
    ]
    completed = [
        (iso_epoch_ms(record.get("completedAt")), record.get("completedAt"))
        for record in records
    ]
    valid_started = [item for item in started if item[0] is not None]
    valid_completed = [item for item in completed if item[0] is not None]
    first_started = min(valid_started)[1] if valid_started else None
    last_completed = max(valid_completed)[1] if valid_completed else None
    session_span_ms = (
        max(item[0] for item in valid_completed) - min(item[0] for item in valid_started)
        if valid_started and valid_completed
        else None
    )
    durations = [numeric(record.get("durationMs")) for record in records]
    status_counts = Counter(str(record.get("status", "unknown")) for record in records)
    evidence = {key: evidence_coverage(records, key) for key in EVIDENCE_KEYS}
    tool_items = evidence_items(records, "tools")
    tools_coverage = evidence_coverage(records, "tools")
    ordinary_tools = call_items_overview([item for item in tool_items if not agent_tool(item)], tools_coverage)
    subagents = call_items_overview([item for item in tool_items if agent_tool(item)], tools_coverage)
    skills = call_overview(records, "skills")
    mcps = call_overview(records, "mcps")
    hooks = call_overview(records, "hooks")
    call_counts = [
        ordinary_tools["displayCount"],
        subagents["displayCount"],
        skills["displayCount"],
        mcps["displayCount"],
    ]
    call_total = sum(call_counts) if all(value is not None for value in call_counts) else None
    error_items = evidence_items(records, "errors")
    danger_items = evidence_items(records, "dangerousOperations")
    provider_versions = {
        str(record.get("provider", {}).get("version"))
        for record in records
        if record.get("provider", {}).get("version")
    }
    provider_models = {
        str(record.get("provider", {}).get("model"))
        for record in records
        if record.get("provider", {}).get("model")
    }
    provider_models.update(usage_overview(records)["models"])
    return {
        "source": "workspace/.scry/records",
        "identity": {
            "sessionId": session_id or None,
            "workspace": normalize_path(str(workspace), workspace),
            "workspaceIds": sorted({
                str(record.get("workspace", {}).get("id"))
                for record in records
                if record.get("workspace", {}).get("id")
            }),
            "provider": provider,
            "providerVersions": sorted(provider_versions),
            "models": sorted(provider_models),
            "recordIds": [record.get("recordId") for record in records],
            "turnIndexes": [record.get("turnIndex") for record in records],
            "generations": [record.get("generation") for record in records],
        },
        "turns": {
            "count": len(records),
            "statusCounts": count_dict(status_counts),
        },
        "timing": {
            "startedAt": first_started,
            "completedAt": last_completed,
            "sessionSpanMs": session_span_ms,
            "cumulativeDurationMs": (
                sum(value for value in durations if value is not None)
                if durations and all(value is not None for value in durations)
                else None
            ),
        },
        "calls": {
            "total": call_total,
            "ordinaryTools": ordinary_tools,
            "subagents": subagents,
            "skills": skills,
            "mcps": mcps,
            "hooks": hooks,
            "categoriesMutuallyExclusive": True,
            "hooksExcludedFromTotal": True,
        },
        "usage": usage_overview(records),
        "files": files_overview(records),
        "diff": diff_overview(records),
        "errors": {
            "knownCount": len(error_items),
            "displayCount": len(error_items) if evidence["errors"]["complete"] else None,
            "failedToolCount": ordinary_tools["failedCount"] + mcps["failedCount"],
            "failedSkillCount": skills["failedCount"],
            "complete": evidence["errors"]["complete"],
        },
        "dangerousOperations": {
            "knownCount": len(danger_items),
            "displayCount": (
                len(danger_items)
                if evidence["dangerousOperations"]["complete"]
                else None
            ),
            "complete": evidence["dangerousOperations"]["complete"],
        },
        "evidenceCoverage": evidence,
        "versions": {
            "recorder": sorted({
                str(record.get("recorderVersion"))
                for record in records
                if record.get("recorderVersion")
            }),
        },
        "displayRules": {
            "null": "missing values remain null and must never become 0",
            "zero": "explicit numeric zero remains 0 when evidence is complete",
            "callTotal": "ordinary tools + MCP + skills + subagents; hooks are excluded",
            "partialDiff": "show known sums together with partial coverage",
        },
    }


def installed_user_data_dirs() -> set[Path]:
    base = Path.home() / "Library/Application Support"
    return {(base / "scry").resolve(), (base / "Scry").resolve()}


def load_test_app_state(path: Path, checks: list[dict[str, Any]]) -> dict[str, Any]:
    try:
        state = load_json(path)
    except (OSError, json.JSONDecodeError) as exc:
        add_check(checks, "test_app.state.readable", False, "readable JSON object", str(exc))
        return {}
    ownership = state.get("rendererOwnership") if isinstance(state.get("rendererOwnership"), dict) else {}
    ownership_expected = ownership.get("expected") if isinstance(ownership.get("expected"), dict) else {}
    ownership_actual = ownership.get("actual") if isinstance(ownership.get("actual"), dict) else {}
    runtime_root = Path(str(state.get("runtimeRoot", ""))).expanduser().resolve()
    expected_runtime_root = path.parent.resolve() / str(RUNTIME_SNAPSHOT["relativePath"])
    expected_renderer_url = (runtime_root / "out" / "renderer" / "index.html").as_uri()
    snapshot = state.get("buildSnapshot") if isinstance(state.get("buildSnapshot"), dict) else {}
    recorded_source = snapshot.get("sourceFingerprint") if isinstance(snapshot.get("sourceFingerprint"), dict) else {}
    recorded_snapshot = snapshot.get("snapshotFingerprint") if isinstance(snapshot.get("snapshotFingerprint"), dict) else {}
    current_snapshot = tree_fingerprint(runtime_root / "out")
    add_check(
        checks,
        "test_app.state_version",
        state.get("version") == RUNTIME_SNAPSHOT["stateVersion"],
        RUNTIME_SNAPSHOT["stateVersion"],
        state.get("version"),
    )
    add_check(checks, "test_app.source_repo", state.get("scryRepo") == str(SCRY_SOURCE_REPO), str(SCRY_SOURCE_REPO), state.get("scryRepo"))
    add_check(checks, "test_app.runtime_root", runtime_root == expected_runtime_root, str(expected_runtime_root), str(runtime_root))
    add_check(
        checks,
        "test_app.build_snapshot",
        recorded_source == recorded_snapshot == current_snapshot,
        "source out == launch snapshot == current snapshot",
        {"source": recorded_source, "recordedSnapshot": recorded_snapshot, "currentSnapshot": current_snapshot},
    )
    add_check(checks, "test_app.mode", state.get("mode") == "test", "test", state.get("mode"))
    add_check(checks, "test_app.label", state.get("testAppLabel") == "Scry Test", "Scry Test", state.get("testAppLabel"))
    add_check(checks, "test_app.status", state.get("status") == "running", "running", state.get("status"))
    add_check(checks, "test_app.launch_id", bool(state.get("launchId")), "non-empty", state.get("launchId"))
    add_check(checks, "test_app.pid", isinstance(state.get("pid"), int) and state["pid"] > 0, "positive integer", state.get("pid"))
    add_check(checks, "test_app.port", isinstance(state.get("port"), int) and state["port"] > 0, "positive integer", state.get("port"))
    add_check(checks, "test_app.renderer_url", state.get("expectedRendererUrl") == expected_renderer_url, expected_renderer_url, state.get("expectedRendererUrl"))
    add_check(checks, "test_app.browser_path", isinstance(state.get("expectedBrowserPath"), str) and state["expectedBrowserPath"].startswith("/devtools/browser/"), "launch DevToolsActivePort browser path", state.get("expectedBrowserPath"))
    add_check(checks, "test_app.renderer_ready", state.get("ownedRendererReady") is True, True, state.get("ownedRendererReady"))
    add_check(checks, "test_app.window_labeled", state.get("windowTitleLabeled") is True, True, state.get("windowTitleLabeled"))
    add_check(checks, "test_app.ownership_schema", ownership.get("schemaVersion") == 2, 2, ownership.get("schemaVersion"))
    add_check(checks, "test_app.ownership_status", ownership.get("status") == "verified", "verified", ownership.get("status"))
    add_check(
        checks,
        "test_app.ownership_identity",
        ownership_expected.get("url") == expected_renderer_url
        and ownership_expected.get("title") == "Scry Test"
        and ownership_expected.get("appMarker") == "true"
        and ownership_expected.get("launchId") == state.get("launchId")
        and ownership_expected.get("browserPath") == state.get("expectedBrowserPath")
        and ownership.get("port") == state.get("port")
        and ownership_actual.get("url") == expected_renderer_url
        and ownership_actual.get("targetUrl") == expected_renderer_url
        and ownership_actual.get("canonicalTitle") == "Scry Test"
        and ownership_actual.get("appMarker") == "true"
        and ownership_actual.get("launchId") == state.get("launchId")
        and ownership_actual.get("browserPath") == state.get("expectedBrowserPath")
        and ownership_actual.get("pageTargetCount") == 1
        and bool(ownership_actual.get("targetId"))
        and ownership_actual.get("readyState") == "complete"
        and ownership_actual.get("hasDocumentElement") is True
        and ownership_actual.get("hasScry") is True
        and ownership_actual.get("rootMounted") is True,
        "unique final renderer with exact title, marker, and launchId",
        ownership,
    )
    return state


def verify_permission_evidence(
    path: Path,
    checks: list[dict[str, Any]],
    state: dict[str, Any],
    workspace: Path,
    provider: str,
    session_id: str,
    session: dict[str, Any],
) -> dict[str, Any]:
    try:
        evidence = load_json(path)
    except (OSError, json.JSONDecodeError) as exc:
        add_check(checks, "permission.evidence.readable", False, "readable JSON object", str(exc))
        return {}
    actual = evidence.get("actual") if isinstance(evidence.get("actual"), dict) else {}
    actual_at_bind = evidence.get("actualAtBind") if isinstance(evidence.get("actualAtBind"), dict) else {}
    prepared = evidence.get("prepared") if isinstance(evidence.get("prepared"), dict) else {}
    provider_label = PROVIDERS[provider]["displayName"]
    agent_profile_id = PROVIDERS[provider].get("agentProfileId")
    permission_label = PROVIDERS[provider].get("permissionLabel", PERMISSION["label"])
    expected_evidence = {
        "value": PERMISSION["value"],
        "label": permission_label,
        "workspace": str(workspace),
        "providerLabel": provider_label,
        "agentProfileId": agent_profile_id,
    }

    def valid_dom(
        value: dict[str, Any],
        *,
        require_exact_workspace: bool,
        require_selectable_provider: bool,
    ) -> bool:
        descriptor = value.get("providerDescriptor") if isinstance(value.get("providerDescriptor"), dict) else {}
        return (
            value.get("found") is True
            and value.get("disabled") is False
            and value.get("optionPresent") is True
            and value.get("value") == PERMISSION["value"]
            and value.get("label") == permission_label
            and value.get("workspaceLabel") == workspace.name
            and value.get("workspacePath") in {None, str(workspace)}
            and (
                not require_exact_workspace
                or value.get("workspaceExact") is True and value.get("workspacePath") == str(workspace)
            )
            and value.get("providerLabel") == provider_label
            and value.get("providerStatusLabel") == provider_label
            and value.get("agentProfileId") == agent_profile_id
            and (
                not require_selectable_provider
                or value.get("providerSelectable", value.get("providerHealthy")) is True
            )
            and descriptor.get("id") == provider
            and descriptor.get("label") == provider_label
            and descriptor.get("runtimeProvider") == RUNTIME[provider]
            and descriptor.get("available") is True
            and descriptor.get("disabledReason") is None
            and value.get("providerHealthy") is True
            and value.get("identityMatches") is True
            and value.get("testApp") is True
            and value.get("testLaunchId") == state.get("launchId")
        )

    add_check(checks, "permission.schema", evidence.get("schemaVersion") == 2, 2, evidence.get("schemaVersion"))
    add_check(checks, "permission.launch_id", evidence.get("launchId") == state.get("launchId"), state.get("launchId"), evidence.get("launchId"))
    add_check(checks, "permission.pid", evidence.get("pid") == state.get("pid"), state.get("pid"), evidence.get("pid"))
    add_check(checks, "permission.port", evidence.get("port") == state.get("port"), state.get("port"), evidence.get("port"))
    add_check(checks, "permission.workspace", evidence.get("workspace") == str(workspace), str(workspace), evidence.get("workspace"))
    add_check(checks, "permission.provider", evidence.get("provider") == provider, provider, evidence.get("provider"))
    add_check(
        checks,
        "permission.agent_profile",
        evidence.get("agentProfileId") == agent_profile_id,
        agent_profile_id,
        evidence.get("agentProfileId"),
    )
    add_check(checks, "permission.session_id", evidence.get("sessionId") == session_id, session_id, evidence.get("sessionId"))
    add_check(
        checks,
        "permission.expected",
        strict_equal(evidence.get("expected"), expected_evidence),
        expected_evidence,
        evidence.get("expected"),
    )
    add_check(
        checks,
        "permission.prepared_agent_profile",
        prepared.get("agentProfileId") == agent_profile_id,
        agent_profile_id,
        prepared.get("agentProfileId"),
    )
    add_check(
        checks,
        "permission.dom",
        valid_dom(actual, require_exact_workspace=False, require_selectable_provider=True),
        "exact full_access + workspace label + selectable healthy provider identity before first prompt",
        actual,
    )
    add_check(
        checks,
        "permission.dom_at_bind",
        valid_dom(actual_at_bind, require_exact_workspace=True, require_selectable_provider=False),
        "same exact DOM identity after first turn; provider may be session-locked",
        actual_at_bind,
    )
    captured_ms = iso_epoch_ms(evidence.get("capturedAt"))
    bound_ms = iso_epoch_ms(evidence.get("boundAt"))
    session_ms = numeric(session.get("ts"))
    add_check(checks, "permission.captured_at", captured_ms is not None, "valid ISO timestamp", evidence.get("capturedAt"))
    add_check(
        checks,
        "permission.bound_at",
        bound_ms is not None and captured_ms is not None and bound_ms >= captured_ms,
        "valid boundAt >= capturedAt",
        evidence.get("boundAt"),
    )
    if session_ms is not None:
        add_check(
            checks,
            "permission.before_first_prompt",
            captured_ms is not None and captured_ms <= session_ms,
            f"capturedAt <= {session_ms}",
            captured_ms,
        )
    return evidence


def find_session(
    user_data: Path,
    workspace: Path,
    provider: str,
    expected_preview: str,
    session_id: str | None,
    checks: list[dict[str, Any]],
) -> dict[str, Any] | None:
    index_path = user_data / "app-sessions.json"
    try:
        sessions = load_json(index_path)
    except (OSError, json.JSONDecodeError) as exc:
        add_check(checks, "scry.session_index.readable", False, "readable JSON list", str(exc))
        return None
    expected_agent_profile_id = PROVIDERS[provider].get("agentProfileId")
    candidates = [
        item
        for item in sessions
        if isinstance(item, dict)
        and item.get("cwd") == str(workspace)
        and item.get("providerId") == provider
        and item.get("agentProfileId") == expected_agent_profile_id
        and item.get("preview") == expected_preview
        and (session_id is None or item.get("sessionId") == session_id)
    ]
    add_check(checks, "scry.session_index.unique_match", len(candidates) == 1, 1, len(candidates))
    return candidates[0] if len(candidates) == 1 else None


def find_archive(
    user_data: Path,
    workspace: Path,
    provider: str,
    session_id: str,
) -> tuple[list[Path], dict[str, Any] | None]:
    root = user_data / "trace-archive-turns-v1" / provider
    segments: list[tuple[Path, dict[str, Any], dict[str, Any]]] = []
    for path in root.rglob("turn-*.json"):
        if not path.is_file():
            continue
        try:
            data = load_json(path)
        except (OSError, json.JSONDecodeError):
            continue
        turns = data.get("turns")
        if (
            data.get("version") != ARCHIVE_VERSION
            or not _archive_matches(data, workspace, provider, session_id)
            or not isinstance(turns, list)
            or len(turns) != 1
            or not isinstance(turns[0], dict)
        ):
            continue
        segments.append((path, data, turns[0]))
    if not segments or len({path.parent for path, _, _ in segments}) != 1:
        return [], None
    segments.sort(key=lambda item: (
        str(item[2].get("startedAt") or ""),
        int(item[2].get("ts") or 0),
        str(item[2].get("runId") or ""),
    ))
    first = segments[0][1]
    identity = (
        first.get("cwd"),
        first.get("providerId"),
        first.get("runtimeProvider"),
        first.get("sessionId"),
        first.get("externalSessionId"),
    )
    if any((
        data.get("cwd"),
        data.get("providerId"),
        data.get("runtimeProvider"),
        data.get("sessionId"),
        data.get("externalSessionId"),
    ) != identity for _, data, _ in segments[1:]):
        return [], None
    return [path for path, _, _ in segments], {
        "version": ARCHIVE_VERSION,
        "cwd": first.get("cwd"),
        "providerId": first.get("providerId"),
        "runtimeProvider": first.get("runtimeProvider"),
        "sessionId": first.get("sessionId"),
        "externalSessionId": first.get("externalSessionId"),
        "turns": [turn for _, _, turn in segments],
    }


def _archive_matches(data: Any, workspace: Path, provider: str, session_id: str) -> bool:
    return (
        isinstance(data, dict)
        and data.get("cwd") == str(workspace)
        and data.get("providerId") == provider
        and data.get("sessionId") == session_id
    )


def load_records(workspace: Path, session_id: str) -> list[tuple[Path, dict[str, Any]]]:
    records: list[tuple[Path, dict[str, Any]]] = []
    for path in (workspace / ".scry/records").glob("*.json"):
        try:
            data = load_json(path)
        except (OSError, json.JSONDecodeError):
            continue
        if data.get("recordKind") == "agent_turn" and data.get("sessionId") == session_id:
            records.append((path, data))
    return sorted(records, key=lambda pair: pair[1].get("turnIndex", 0))


def skill_names(evidence: Any) -> set[str]:
    if not isinstance(evidence, dict) or not isinstance(evidence.get("value"), list):
        return set()
    return {
        str(item.get("name"))
        for item in evidence["value"]
        if isinstance(item, dict) and item.get("name")
    }


def available_items(record: dict[str, Any], key: str) -> list[dict[str, Any]]:
    evidence = record.get(key)
    value = evidence.get("value") if isinstance(evidence, dict) else None
    known = (
        isinstance(evidence, dict)
        and evidence.get("status") in {"available", "partial"}
        and isinstance(value, list)
    )
    return [item for item in value if isinstance(item, dict)] if known else []


def available_value(record: dict[str, Any], key: str) -> Any:
    evidence = record.get(key)
    if not isinstance(evidence, dict) or evidence.get("status") not in {"available", "partial"}:
        return None
    return evidence.get("value")


def known_array(record: dict[str, Any], key: str) -> bool:
    return isinstance(available_value(record, key), list)


def finite_nonnegative(value: Any) -> float | int | None:
    number = numeric(value)
    return number if number is not None and math.isfinite(number) and number >= 0 else None


def sum_known(values: list[Any]) -> float | int | None:
    known = [number for value in values if (number := finite_nonnegative(value)) is not None]
    return sum(known) if known else None


def agent_tool(call: dict[str, Any]) -> bool:
    if call.get("category") == "agent":
        return True
    if call.get("category") == "tool":
        return False
    value = call.get("input")
    return isinstance(value, dict) and (
        isinstance(value.get("agentThreadId"), str)
        or isinstance(value.get("agentPath"), str)
    )


def summary_projection(records: list[dict[str, Any]], session_id: str) -> dict[str, Any]:
    tools = [item for record in records for item in available_items(record, "tools")]
    ordinary = [item for item in tools if not agent_tool(item)]
    agents = [item for item in tools if agent_tool(item)]
    skills = [item for record in records for item in available_items(record, "skills")]
    mcps = [item for record in records for item in available_items(record, "mcps")]
    hooks = [item for record in records for item in available_items(record, "hooks")]
    usages = [available_value(record, "usage") for record in records]
    usages = [value for value in usages if isinstance(value, dict)]
    structured_paths: set[str] = set()
    for record in records:
        calls = [
            *available_items(record, "tools"),
            *available_items(record, "skills"),
            *available_items(record, "mcps"),
        ]
        from_calls = [item.get("file") for item in calls if isinstance(item.get("file"), dict)]
        files = from_calls if from_calls else available_items(record, "files")
        structured_paths.update(str(item["path"]) for item in files if item.get("path"))
    diff_files = {
        str(item.get("path"))
        for record in records
        for snapshot in available_items(record, "diff")
        for item in (
            snapshot.get("files")
            if snapshot.get("status") == "captured" and isinstance(snapshot.get("files"), list)
            else []
        )
        if isinstance(item, dict) and item.get("path")
    }
    diff_items = [
        item
        for record in records
        for snapshot in available_items(record, "diff")
        for item in (
            snapshot.get("files")
            if snapshot.get("status") == "captured" and isinstance(snapshot.get("files"), list)
            else []
        )
        if isinstance(item, dict)
    ]
    durations = [record.get("durationMs") for record in records]
    usage_sum = lambda key: sum_known([value.get(key) for value in usages])
    total_input = usage_sum("inputTokens")
    total_output = usage_sum("outputTokens")
    calls_known = any(all(known_array(record, key) for key in ("tools", "skills", "mcps")) for record in records)
    hooks_known = any(known_array(record, "hooks") for record in records)
    files_known = any(all(known_array(record, key) for key in ("tools", "files")) for record in records)
    diff_known = any(known_array(record, "diff") for record in records)
    errors_known = any(known_array(record, "errors") for record in records)
    dangers_known = any(known_array(record, "dangerousOperations") for record in records)
    ordinary_total = len(ordinary) if calls_known else None
    agent_total = len(agents) if calls_known else None
    skill_total = len(skills) if calls_known else None
    mcp_total = len(mcps) if calls_known else None
    return {
        "scope": "session",
        "sessionId": session_id,
        "sessions": len({record.get("sessionId") for record in records}),
        "turns": len(records),
        "statusCounts": count_dict(Counter(str(record.get("status", "unknown")) for record in records)),
        "calls": {
            "total": (
                ordinary_total + agent_total + skill_total + mcp_total
                if all(value is not None for value in (ordinary_total, agent_total, skill_total, mcp_total))
                else None
            ),
            "ordinaryTools": {"total": ordinary_total},
            "mcp": {"total": mcp_total},
            "skills": {"total": skill_total},
            "subagents": {"total": agent_total},
        },
        "hooks": {
            "handlerInstances": len(hooks) if hooks_known else None,
            "lifecycleEvents": (
                sum(
                    int(value) if (value := finite_nonnegative(item.get("lifecycleEvents"))) is not None
                    else 2 if item.get("completedAt") else 1
                    for item in hooks
                )
                if hooks_known else None
            ),
        },
        "usage": {
            "totalTokens": None if total_input is None and total_output is None else (total_input or 0) + (total_output or 0),
            "inputTokens": total_input,
            "outputTokens": total_output,
            "cacheReadTokens": usage_sum("cacheReadTokens"),
            "cacheCreationTokens": usage_sum("cacheCreationTokens"),
            "reasoningTokens": usage_sum("reasoningTokens"),
        },
        "files": {"structuredPaths": len(structured_paths) if files_known else None},
        "diff": {
            "files": len(diff_files) if diff_known else None,
            "added": sum(int(finite_nonnegative(item.get("added")) or 0) for item in diff_items) if diff_known else None,
            "deleted": sum(int(finite_nonnegative(item.get("deleted")) or 0) for item in diff_items) if diff_known else None,
        },
        "errors": {"total": sum(len(available_items(record, "errors")) for record in records) if errors_known else None},
        "dangerousOperations": {
            "total": sum(len(available_items(record, "dangerousOperations")) for record in records) if dangers_known else None
        },
        "wall": {
            "cumulativeMs": sum_known(durations),
        },
    }


def nested_value(value: Any, path: tuple[str, ...]) -> Any:
    current = value
    for key in path:
        if not isinstance(current, dict) or key not in current:
            return None
        current = current[key]
    return current


def check_summary_projection(
    checks: list[dict[str, Any]],
    expected: dict[str, Any],
    actual: dict[str, Any],
    prefix: tuple[str, ...] = (),
) -> None:
    for key, expected_value in expected.items():
        path = (*prefix, key)
        if isinstance(expected_value, dict):
            check_summary_projection(checks, expected_value, actual, path)
            continue
        actual_value = nested_value(actual, path)
        add_check(
            checks,
            "cli.summary." + ".".join(path),
            strict_equal(expected_value, actual_value),
            expected_value,
            actual_value,
        )


def run_cli_checks(
    workspace: Path,
    checks: list[dict[str, Any]],
    records: list[dict[str, Any]],
    session_id: str,
    scry_bin: Path,
) -> dict[str, Any] | None:
    try:
        result = subprocess.run(
            [str(scry_bin), "turns", "verify", "--workspace", str(workspace)],
            text=True,
            capture_output=True,
            timeout=60,
            check=False,
        )
        actual = (result.stdout + result.stderr).strip()[-1000:]
        add_check(checks, "cli.store.verify", result.returncode == 0, "exit 0", {
            "exitCode": result.returncode,
            "output": actual,
        })
    except (OSError, subprocess.TimeoutExpired) as exc:
        add_check(checks, "cli.store.verify", False, "exit 0", str(exc))
        return None
    try:
        result = subprocess.run(
            [str(scry_bin), "turns", "summary", session_id, "--workspace", str(workspace), "--json"],
            text=True,
            capture_output=True,
            timeout=60,
            check=False,
        )
        summary = json.loads(result.stdout) if result.returncode == 0 else None
    except (OSError, subprocess.TimeoutExpired, json.JSONDecodeError) as exc:
        add_check(checks, "cli.summary.readable", False, "exit 0 with JSON", str(exc))
        return None
    add_check(
        checks,
        "cli.summary.readable",
        isinstance(summary, dict),
        "exit 0 with JSON object",
        {"exitCode": result.returncode, "stderr": result.stderr.strip()[-1000:]},
    )
    if not isinstance(summary, dict):
        return None
    projection = summary_projection(records, session_id)
    check_summary_projection(checks, projection, summary)
    unique_paths = nested_value(summary, ("files", "uniquePaths"))
    structured_paths = projection["files"]["structuredPaths"]
    unique_paths_ok = (
        unique_paths is None
        if structured_paths is None
        else type(unique_paths) is int and unique_paths >= structured_paths
    )
    add_check(
        checks,
        "cli.summary.files.unique_paths",
        unique_paths_ok,
        None if structured_paths is None else f">= structuredPaths ({structured_paths})",
        unique_paths,
    )
    return summary


def verify(args: argparse.Namespace, *, skip_cli: bool = False) -> dict[str, Any]:
    workspace = Path(args.workspace).expanduser().resolve()
    provider = args.provider
    expected_turns = int(getattr(args, "expected_turns", 3))
    if expected_turns not in {2, 3}:
        raise ValueError("expected_turns must be 2 or 3")
    expected_prompts = [first_prompt(provider, args.workitem_id)] + [
        args.second_prompt, args.third_prompt
    ][: expected_turns - 1]
    expected_skill = PROVIDERS[provider]["skill"]
    user_data = Path(args.scry_user_data).expanduser().resolve()
    test_app_state_path = Path(args.test_app_state).expanduser().resolve()
    test_run_root = test_app_state_path.parent
    local_equality_only = bool(getattr(args, "local_equality_only", False))
    checks: list[dict[str, Any]] = []
    cli_summary: dict[str, Any] | None = None
    test_app_state = load_test_app_state(test_app_state_path, checks)
    scry_bin: Path | None = None
    if not skip_cli:
        scry_bin = Path(args.scry_bin).expanduser()
        absolute = scry_bin.is_absolute()
        executable = absolute and scry_bin.is_file() and os.access(scry_bin, os.X_OK)
        resolved = scry_bin.resolve() if executable else scry_bin
        add_check(checks, "cli.binary.absolute_executable", executable, True, {
            "path": str(resolved),
            "absolute": absolute,
            "executable": executable,
        })
        actual_version = None
        if executable:
            try:
                version_result = subprocess.run(
                    [str(resolved), "--version"],
                    text=True,
                    capture_output=True,
                    timeout=30,
                    check=False,
                )
                lines = [line.strip() for line in version_result.stdout.splitlines() if line.strip()]
                actual_version = lines[-1] if version_result.returncode == 0 and lines else None
            except (OSError, subprocess.TimeoutExpired):
                actual_version = None
        add_check(
            checks,
            "cli.binary.version",
            actual_version == EXPECTED_SCRY_CLI_VERSION,
            EXPECTED_SCRY_CLI_VERSION,
            actual_version,
        )
        scry_bin = resolved

    add_check(checks, "workspace.exists", workspace.is_dir(), True, workspace.is_dir())
    add_check(
        checks,
        "workitem.is_clone",
        local_equality_only or args.workitem_id != SOURCE_WORKITEM_ID,
        (
            f"user-provided clone ID different from {SOURCE_WORKITEM_ID}"
            if not local_equality_only
            else "source or clone ID allowed by local-equality-only profile"
        ),
        args.workitem_id,
    )
    add_check(checks, "scry.user_data.isolated", user_data not in installed_user_data_dirs(), "not installed Scry userData", str(user_data))
    add_check(
        checks,
        "test_app.run_root",
        test_run_root.parent.resolve() == TEST_RUN_ROOT_PARENT
        and test_run_root.name.startswith(TEST_RUN_PREFIX),
        f"{TEST_RUN_ROOT_PARENT}/{TEST_RUN_PREFIX}*",
        str(test_run_root),
    )
    add_check(
        checks,
        "test_app.state_path",
        Path(str(test_app_state.get("statePath", ""))).expanduser().resolve() == test_app_state_path,
        str(test_app_state_path),
        test_app_state.get("statePath"),
    )
    add_check(
        checks,
        "test_app.scry_repo",
        Path(str(test_app_state.get("scryRepo", ""))).expanduser().resolve() == SCRY_SOURCE_REPO,
        str(SCRY_SOURCE_REPO),
        test_app_state.get("scryRepo"),
    )
    add_check(
        checks,
        "test_app.user_data",
        Path(str(test_app_state.get("userDataDir", ""))).expanduser().resolve() == user_data
        and user_data == (test_run_root / "scry-test-user-data").resolve(),
        str((test_run_root / "scry-test-user-data").resolve()),
        test_app_state.get("userDataDir"),
    )
    session = find_session(
        user_data, workspace, provider, expected_prompts[-1], args.session_id, checks
    )
    if session is None:
        return build_result(checks, workspace, provider, args.session_id or "", [], [], user_data)
    session_id = str(session.get("sessionId"))

    permission_evidence_path = Path(args.permission_evidence).expanduser().resolve()
    add_check(
        checks,
        "permission.path",
        permission_evidence_path == (test_run_root / "permission-evidence.json").resolve(),
        str((test_run_root / "permission-evidence.json").resolve()),
        str(permission_evidence_path),
    )
    verify_permission_evidence(
        permission_evidence_path,
        checks,
        test_app_state,
        workspace,
        provider,
        session_id,
        session,
    )

    add_check(checks, "scry.session.provider", session.get("providerId") == provider, provider, session.get("providerId"))
    add_check(
        checks,
        "scry.session.agent_profile",
        session.get("agentProfileId") == PROVIDERS[provider].get("agentProfileId"),
        PROVIDERS[provider].get("agentProfileId"),
        session.get("agentProfileId"),
    )
    add_check(checks, "scry.session.runtime", session.get("runtimeProvider") == RUNTIME[provider], RUNTIME[provider], session.get("runtimeProvider"))
    add_check(checks, "scry.session.cwd", session.get("cwd") == str(workspace), str(workspace), session.get("cwd"))
    add_check(checks, "scry.session.external_id", session.get("externalSessionId") == session_id, session_id, session.get("externalSessionId"))

    archive_paths, archive_data = find_archive(user_data, workspace, provider, session_id)
    add_check(
        checks,
        "scry.archive.unique_match",
        archive_data is not None,
        "one segmented archive set",
        [str(path) for path in archive_paths] if archive_paths else None,
    )
    archive = archive_data or {}
    turns = archive.get("turns", []) if isinstance(archive.get("turns"), list) else []
    add_check(
        checks,
        "scry.archive.version",
        archive.get("version") == ARCHIVE_VERSION,
        ARCHIVE_VERSION,
        archive.get("version"),
    )
    add_check(checks, "scry.archive.cwd", archive.get("cwd") == str(workspace), str(workspace), archive.get("cwd"))
    add_check(checks, "scry.archive.provider", archive.get("providerId") == provider, provider, archive.get("providerId"))
    add_check(checks, "scry.archive.runtime", archive.get("runtimeProvider") == RUNTIME[provider], RUNTIME[provider], archive.get("runtimeProvider"))
    add_check(checks, "scry.archive.session_id", archive.get("sessionId") == session_id, session_id, archive.get("sessionId"))
    add_check(checks, "scry.archive.external_id", archive.get("externalSessionId") == session.get("externalSessionId"), session.get("externalSessionId"), archive.get("externalSessionId"))
    add_check(checks, "scry.turn.count", len(turns) == expected_turns, expected_turns, len(turns))
    add_check(checks, "scry.turn.prompts", [turn.get("userText") for turn in turns] == expected_prompts, expected_prompts, [turn.get("userText") for turn in turns])
    expected_statuses = ["completed"] * expected_turns
    add_check(checks, "scry.turn.done", len(turns) == expected_turns and all(turn.get("done") is True for turn in turns), [True] * expected_turns, [turn.get("done") for turn in turns])
    add_check(checks, "scry.turn.status", [turn.get("status") for turn in turns] == expected_statuses, expected_statuses, [turn.get("status") for turn in turns])
    archive_skills = skill_names(turns[0].get("turnEvidence", {}).get("skills")) if turns else set()
    add_check(checks, "scry.turn1.expected_skill", expected_skill in archive_skills, expected_skill, sorted(archive_skills))
    for index, turn in enumerate(turns, 1):
        expected_prompt = expected_prompts[index - 1] if index <= len(expected_prompts) else None
        evidence = turn.get("turnEvidence", {}) if isinstance(turn, dict) else {}
        user_ok, user_actual = exact_text_state(
            evidence.get("user") if isinstance(evidence, dict) else None,
            expected_prompt,
        )
        add_check(
            checks,
            f"scry.turn{index}.user.exact",
            user_ok and turn.get("userText") == expected_prompt,
            {"status": "available", "quality": "exact", "text": expected_prompt, "validHash": True},
            {**user_actual, "turnUserText": turn.get("userText")},
        )
        raw_assistant = raw_assistant_text(turn)
        assistant_ok, assistant_actual = exact_text_state(
            evidence.get("assistant") if isinstance(evidence, dict) else None,
            raw_assistant,
        )
        add_check(
            checks,
            f"scry.turn{index}.assistant.exact",
            assistant_ok and bool(raw_assistant),
            {"status": "available", "quality": "exact", "text": "non-empty raw model output", "validHash": True},
            assistant_actual,
        )
        timing = turn_timing(turn)
        add_check(
            checks,
            f"scry.turn{index}.timing.valid",
            valid_turn_timing(turn),
            "valid exact startedAt/completedAt/durationMs",
            timing,
        )
        add_check(
            checks,
            f"scry.turn{index}.provider_turn_id",
            isinstance(turn.get("providerTurnId"), str) and bool(turn.get("providerTurnId")),
            "non-empty authoritative Provider turn id",
            turn.get("providerTurnId"),
        )
        raw_errors = raw_overview_errors(turn)
        archived_errors = evidence.get("errors", {}).get("value") if isinstance(evidence, dict) else None
        add_check(
            checks,
            f"scry.turn{index}.errors.raw_selector",
            strict_equal(archived_errors, raw_errors),
            raw_errors,
            archived_errors,
        )

    records = load_records(workspace, session_id)
    record_data = [data for _, data in records]
    add_check(checks, "cli.record.count", len(records) == expected_turns, expected_turns, len(records))
    record_ids = [item.get("recordId") for item in record_data]
    add_check(
        checks,
        "cli.record.ids",
        len(record_ids) == expected_turns
        and all(isinstance(value, str) and bool(value) for value in record_ids)
        and len(set(record_ids)) == expected_turns,
        f"{expected_turns} unique non-empty recordIds",
        record_ids,
    )
    sequences = [item.get("sequence") for item in record_data]
    add_check(
        checks,
        "cli.record.sequences",
        len(sequences) == expected_turns
        and all(type(value) is int for value in sequences)
        and all(left < right for left, right in zip(sequences, sequences[1:])),
        f"{expected_turns} strictly increasing integer sequences",
        sequences,
    )
    recorder_versions = {
        item.get("recorderVersion")
        for item in record_data
        if isinstance(item.get("recorderVersion"), str) and item.get("recorderVersion")
    }
    add_check(checks, "cli.record.recorder_version", len(recorder_versions) == 1, "one non-empty recorder version", sorted(recorder_versions))
    expected_indexes = list(range(1, expected_turns + 1))
    expected_generations = list(range(1, expected_turns + 1))
    expected_record_statuses = ["completed"] * expected_turns
    add_check(checks, "cli.turn.indexes", [item.get("turnIndex") for item in record_data] == expected_indexes, expected_indexes, [item.get("turnIndex") for item in record_data])
    add_check(checks, "cli.turn.generations", [item.get("generation") for item in record_data] == expected_generations, expected_generations, [item.get("generation") for item in record_data])
    add_check(checks, "cli.turn.status", [item.get("status") for item in record_data] == expected_record_statuses, expected_record_statuses, [item.get("status") for item in record_data])
    add_check(checks, "cli.turn.prompts", [item.get("user", {}).get("value", {}).get("text") for item in record_data] == expected_prompts, expected_prompts, [item.get("user", {}).get("value", {}).get("text") for item in record_data])
    identity_ok = len(record_data) == expected_turns and all(
        item.get("workspace", {}).get("root") == str(workspace)
        and item.get("provider", {}).get("id") == provider
        and item.get("sessionId") == session_id
        for item in record_data
    )
    add_check(checks, "cli.record.identity", identity_ok, {
        "workspace": str(workspace), "provider": provider, "sessionId": session_id
    }, [
        {
            "workspace": item.get("workspace", {}).get("root"),
            "provider": item.get("provider", {}).get("id"),
            "sessionId": item.get("sessionId"),
        }
        for item in record_data
    ])
    cli_skills = skill_names(record_data[0].get("skills")) if record_data else set()
    add_check(checks, "cli.turn1.expected_skill", expected_skill in cli_skills, expected_skill, sorted(cli_skills))
    verify_qoder_question_journal(test_run_root, provider, session_id, record_data, checks)
    for index, record in enumerate(record_data, 1):
        expected_prompt = expected_prompts[index - 1] if index <= len(expected_prompts) else None
        user_ok, user_actual = exact_text_state(record.get("user"), expected_prompt)
        add_check(
            checks,
            f"cli.turn{index}.user.exact",
            user_ok,
            {"status": "available", "quality": "exact", "text": expected_prompt, "validHash": True},
            user_actual,
        )
        assistant_ok, assistant_actual = exact_text_state(record.get("assistant"))
        add_check(
            checks,
            f"cli.turn{index}.assistant.exact",
            assistant_ok,
            {"status": "available", "quality": "exact", "text": "non-empty", "validHash": True},
            assistant_actual,
        )
        add_check(
            checks,
            f"cli.turn{index}.timing.valid",
            valid_turn_timing(record),
            "valid exact startedAt/completedAt/durationMs",
            turn_timing(record),
        )

    if not skip_cli:
        assert scry_bin is not None
        cli_summary = run_cli_checks(workspace, checks, record_data, session_id, scry_bin)

    # Parity runs over the pairs that actually exist. A truncated session still
    # has to prove archive == CLI record for the turns it produced; the three-turn
    # shape stays a separate check so a short run can never read as complete.
    if turns and record_data:
        for index, (turn, record) in enumerate(zip(turns, record_data), 1):
            archive_evidence = turn.get("turnEvidence", {})
            expected_timing = turn_timing(turn)
            actual_timing = turn_timing(record)
            add_check(
                checks,
                f"parity.turn{index}.timing",
                strict_equal(expected_timing, actual_timing),
                expected_timing,
                actual_timing,
            )
            add_check(
                checks,
                f"parity.turn{index}.provider_turn_id",
                bool(turn.get("providerTurnId"))
                and strict_equal(turn.get("providerTurnId"), record.get("providerTurnId")),
                turn.get("providerTurnId"),
                record.get("providerTurnId"),
            )
            add_check(
                checks,
                f"parity.turn{index}.status",
                strict_equal(turn.get("status"), record.get("status")),
                turn.get("status"),
                record.get("status"),
            )
            for key in EVIDENCE_KEYS:
                archive_value = archive_evidence.get(key)
                record_value = record.get(key)
                add_check(
                    checks,
                    f"parity.turn{index}.{key}",
                    strict_equal(archive_value, record_value),
                    evidence_summary(key, archive_value, workspace),
                    evidence_summary(key, record_value, workspace),
                )

    return build_result(
        checks,
        workspace,
        provider,
        session_id,
        archive_paths,
        records,
        user_data,
        cli_summary,
    )


def build_result(
    checks: list[dict[str, Any]],
    workspace: Path,
    provider: str,
    session_id: str,
    archive_paths: list[Path],
    records: list[tuple[Path, dict[str, Any]]],
    user_data: Path,
    cli_summary: dict[str, Any] | None = None,
) -> dict[str, Any]:
    record_data = [data for _, data in records]
    record_overview = record_evidence_summary(record_data, workspace, provider, session_id)
    normalized_summary = normalize(cli_summary, workspace) if cli_summary is not None else None
    return {
        "ok": bool(checks) and all(item["ok"] for item in checks),
        "workspace": str(workspace),
        "provider": provider,
        "sessionId": session_id or None,
        "scryUserData": str(user_data),
        "archivePath": str(archive_paths[0].parent) if archive_paths else None,
        "archivePaths": [str(path) for path in archive_paths],
        "records": [
            {"recordId": data.get("recordId"), "path": str(path)}
            for path, data in records
        ],
        "cliSummary": normalized_summary,
        "cliIndependentProjection": normalize(summary_projection(record_data, session_id), workspace),
        "recordEvidenceOverview": record_overview,
        "checks": checks,
        "failures": [item for item in checks if not item["ok"]],
    }


def write_fixture(root: Path, provider: str, workitem_id: str) -> argparse.Namespace:
    workspace = root / "workspace"
    user_data = root / "scry-test-user-data"
    session_id = "session-test"
    workspace.mkdir()
    workspace = workspace.resolve()
    (workspace / ".scry/records").mkdir(parents=True)
    archive_dir = user_data / "trace-archive-turns-v1" / provider / "fixture" / session_id
    archive_dir.mkdir(parents=True)
    prompts = [first_prompt(provider, workitem_id), SECOND_PROMPT, THIRD_PROMPT]
    skill = PROVIDERS[provider]["skill"]
    agent_profile_id = PROVIDERS[provider].get("agentProfileId")
    permission_label = PROVIDERS[provider].get("permissionLabel", PERMISSION["label"])

    def evidence(text: str, include_skill: bool, index: int) -> dict[str, Any]:
        empty = {"status": "available", "quality": "exact", "source": ["fixture"], "value": []}
        tool = {
            "name": "mcp__fixture" if index == 2 else "Read",
            "status": "failed" if index == 2 else "success",
        }
        file = {
            "path": str(workspace / f"fixture-{index}.txt"),
            "operation": "read" if index == 1 else "write",
        }
        return {
            "user": {"status": "available", "quality": "exact", "source": ["fixture"], "value": {"text": text, "textHash": hash_text(text)}},
            "assistant": {"status": "available", "quality": "exact", "source": ["fixture"], "value": {"text": "ok", "textHash": hash_text("ok")}},
            "tools": {
                "status": "available",
                "quality": "exact",
                "source": ["fixture"],
                "value": [tool] if index == 1 else [],
            },
            "skills": {"status": "available", "quality": "exact", "source": ["fixture"], "value": [{"name": skill, "status": "success"}] if include_skill else []},
            "mcps": {"status": "available", "quality": "exact", "source": ["fixture"], "value": [tool] if index == 2 else []},
            "hooks": {"status": "available", "quality": "exact", "source": ["fixture"], "value": [{"name": "fixture-hook", "status": "success"}]},
            "usage": {
                "status": "available",
                "quality": "exact",
                "source": ["fixture"],
                "value": {
                    "inputTokens": index,
                    "outputTokens": index * 2,
                    "cacheReadTokens": index - 1,
                    "cacheCreationTokens": 0,
                    "reasoningTokens": index - 1,
                    "costUsd": float(index),
                    "model": "fixture-model",
                },
            },
            "files": {"status": "available", "quality": "exact", "source": ["fixture"], "value": [file]},
            "diff": {
                "status": "available",
                "quality": "exact",
                "source": ["fixture"],
                "value": [{
                    "status": "captured",
                    "files": [{"path": file["path"], "added": index, "deleted": index - 1}],
                }],
            },
            "dangerousOperations": empty,
            "errors": {
                "status": "available",
                "quality": "exact",
                "source": ["fixture"],
                "value": [{
                    "message": "fixture failure",
                    "source": "tool_result",
                    "toolUseId": "tool-2",
                }] if index == 2 else [],
            },
            "interventions": empty,
        }

    turns = []
    for index, prompt in enumerate(prompts, 1):
        ev = evidence(prompt, index == 1, index)
        started_second = (index - 1) * 2
        completed_second = started_second + index
        started_at = f"2026-07-29T00:00:{started_second:02d}.000Z"
        completed_at = f"2026-07-29T00:00:{completed_second:02d}.000Z"
        duration_ms = index * 1000
        items = [
            {
                "id": f"delta-{index}-1",
                "ts": started_at,
                "runId": f"run-{index}",
                "kind": "model",
                "stage": "text_delta",
                "text": "o",
                "messageId": f"message-{index}",
            },
            {
                "id": f"delta-{index}-2",
                "ts": completed_at,
                "runId": f"run-{index}",
                "kind": "model",
                "stage": "text_delta",
                "text": "k",
                "messageId": f"message-{index}",
            },
            {
                "id": f"snapshot-{index}",
                "ts": completed_at,
                "runId": f"run-{index}",
                "kind": "model",
                "stage": "text",
                "text": "ok",
                "messageId": f"message-{index}",
            },
        ]
        if index == 2:
            items.append({
                "id": "tool-result-2",
                "ts": completed_at,
                "runId": "run-2",
                "kind": "tool",
                "stage": "tool_result",
                "tool": "mcp__fixture",
                "toolUseId": "tool-2",
                "isError": True,
                "text": "fixture failure",
            })
        turns.append({
            "providerTurnId": f"provider-turn-{index}",
            "userText": prompt,
            "items": items,
            "done": True,
            "status": "completed",
            "turnEvidence": ev,
            "startedAt": started_at,
            "completedAt": completed_at,
            "durationMs": duration_ms,
        })
        record = {
            "schemaVersion": 1,
            "recordKind": "agent_turn",
            "sequence": index,
            "recordId": f"record-{index}",
            "recorderVersion": "fixture-recorder",
            "workspace": {"id": "rate-native", "root": str(workspace)},
            "provider": {"id": provider, "version": "fixture-cli", "model": "fixture-model"},
            "sessionId": session_id,
            "providerTurnId": f"provider-turn-{index}",
            "generation": index,
            "turnIndex": index,
            "startedAt": started_at,
            "completedAt": completed_at,
            "durationMs": duration_ms,
            "status": "completed",
            **ev,
        }
        (workspace / f".scry/records/{index:020d}-record-{index}.json").write_text(
            json.dumps(record, ensure_ascii=False), encoding="utf-8"
        )
    session = {
        "sessionId": session_id,
        "externalSessionId": session_id,
        "providerId": provider,
        **({"agentProfileId": agent_profile_id} if agent_profile_id is not None else {}),
        "runtimeProvider": RUNTIME[provider],
        "cwd": str(workspace),
        "preview": prompts[-1],
        "ts": 1785283200000,
    }
    (user_data / "app-sessions.json").write_text(json.dumps([session]), encoding="utf-8")
    for index, turn in enumerate(turns, 1):
        archive = {
            "version": ARCHIVE_VERSION,
            "cwd": str(workspace),
            "sessionId": session_id,
            "externalSessionId": session_id,
            "providerId": provider,
            "runtimeProvider": RUNTIME[provider],
            "turns": [turn],
        }
        (archive_dir / f"turn-{index}.json").write_text(
            json.dumps(archive, ensure_ascii=False), encoding="utf-8"
        )
    runtime_root = root / str(RUNTIME_SNAPSHOT["relativePath"])
    (runtime_root / "out/renderer").mkdir(parents=True)
    (runtime_root / "out/renderer/index.html").write_text("fixture\n", encoding="utf-8")
    runtime_fingerprint = tree_fingerprint(runtime_root / "out")
    runtime_renderer_url = (runtime_root / "out/renderer/index.html").as_uri()
    test_app_state = root / "test-scry-state.json"
    test_app_state.write_text(
        json.dumps({
            "version": RUNTIME_SNAPSHOT["stateVersion"],
            "mode": "test",
            "testAppLabel": "Scry Test",
            "status": "running",
            "launchId": "fixture-launch",
            "pid": 1,
            "port": 1,
            "scryRepo": str(SCRY_SOURCE_REPO),
            "runtimeRoot": str(runtime_root.resolve()),
            "buildSnapshot": {
                "sourceFingerprint": runtime_fingerprint,
                "snapshotFingerprint": runtime_fingerprint,
            },
            "userDataDir": str(user_data.resolve()),
            "statePath": str(test_app_state.resolve()),
            "expectedRendererUrl": runtime_renderer_url,
            "devToolsActivePortPath": str((user_data / "DevToolsActivePort").resolve()),
            "expectedBrowserPath": "/devtools/browser/fixture-browser",
            "ownedRendererReady": True,
            "windowTitleLabeled": True,
            "rendererOwnership": {
                "schemaVersion": 2,
                "status": "verified",
                "port": 1,
                "expected": {
                    "url": runtime_renderer_url,
                    "title": "Scry Test",
                    "appMarker": "true",
                    "launchId": "fixture-launch",
                    "browserPath": "/devtools/browser/fixture-browser",
                },
                "actual": {
                    "browserPath": "/devtools/browser/fixture-browser",
                    "targetId": "fixture-target",
                    "targetUrl": runtime_renderer_url,
                    "pageTargetCount": 1,
                    "url": runtime_renderer_url,
                    "title": "Scry Test",
                    "canonicalTitle": "Scry Test",
                    "titleDecoration": None,
                    "readyState": "complete",
                    "hasDocumentElement": True,
                    "hasScry": True,
                    "rootMounted": True,
                    "appMarker": "true",
                    "launchId": "fixture-launch",
                },
            },
        }),
        encoding="utf-8",
    )
    permission_evidence = root / "permission-evidence.json"
    permission_evidence.write_text(
        json.dumps({
            "schemaVersion": 2,
            "launchId": "fixture-launch",
            "pid": 1,
            "port": 1,
            "workspace": str(workspace),
            "provider": provider,
            "agentProfileId": agent_profile_id,
            "expected": {
                "value": PERMISSION["value"],
                "label": permission_label,
                "workspace": str(workspace),
                "providerLabel": PROVIDERS[provider]["displayName"],
                "agentProfileId": agent_profile_id,
            },
            "prepared": {
                "agentProfileId": agent_profile_id,
            },
            "actual": {
                "found": True,
                "disabled": False,
                "optionPresent": True,
                "value": PERMISSION["value"],
                "label": permission_label,
                "workspacePath": None,
                "workspaceLabel": workspace.name,
                "workspaceExact": False,
                "providerLabel": PROVIDERS[provider]["displayName"],
                "providerStatusLabel": PROVIDERS[provider]["displayName"],
                "agentProfileId": agent_profile_id,
                "providerDescriptor": {
                    "id": provider,
                    "label": PROVIDERS[provider]["displayName"],
                    "runtimeProvider": RUNTIME[provider],
                    "available": True,
                    "disabledReason": None,
                    "health": "ready",
                },
                "providerSelectable": True,
                "providerHealthy": True,
                "identityMatches": True,
                "testApp": True,
                "testLaunchId": "fixture-launch",
            },
            "capturedAt": "2026-07-28T23:59:59.000Z",
            "sessionId": session_id,
            "boundAt": "2026-07-29T00:00:00.000Z",
            "actualAtBind": {
                "found": True,
                "disabled": False,
                "optionPresent": True,
                "value": PERMISSION["value"],
                "label": permission_label,
                "workspacePath": str(workspace),
                "workspaceLabel": workspace.name,
                "workspaceExact": True,
                "providerLabel": PROVIDERS[provider]["displayName"],
                "providerStatusLabel": PROVIDERS[provider]["displayName"],
                "agentProfileId": agent_profile_id,
                "providerDescriptor": {
                    "id": provider,
                    "label": PROVIDERS[provider]["displayName"],
                    "runtimeProvider": RUNTIME[provider],
                    "available": True,
                    "disabledReason": None,
                    "health": "ready",
                },
                "providerSelectable": False,
                "providerHealthy": True,
                "identityMatches": True,
                "testApp": True,
                "testLaunchId": "fixture-launch",
            },
        }),
        encoding="utf-8",
    )
    return argparse.Namespace(
        workspace=str(workspace),
        provider=provider,
        workitem_id=workitem_id,
        second_prompt=SECOND_PROMPT,
        third_prompt=THIRD_PROMPT,
        session_id=None,
        scry_user_data=str(user_data),
        test_app_state=str(test_app_state),
        permission_evidence=str(permission_evidence),
        output=None,
        local_equality_only=False,
    )


def self_test() -> int:
    assert PROVIDERS["qoder"]["command"] == "/rate-native-rate-workflow"
    assert PROVIDERS["qoder"]["skill"] == "rate-workflow"
    assert PROVIDERS["pi"]["agentProfileId"] == "pi:default"
    assert PROVIDERS["pi"]["permissionLabel"] == "本机完全访问"
    assert output_summary("a" * 500) == "a" * 500
    assert output_summary("a" * 501) == "a" * 500 + "…"
    assert output_summary("🐴" + "a" * 498 + "tail") == "🐴" + "a" * 498 + "…"
    TEST_RUN_ROOT_PARENT.mkdir(parents=True, exist_ok=True, mode=0o700)
    with tempfile.TemporaryDirectory(prefix=TEST_RUN_PREFIX, dir=TEST_RUN_ROOT_PARENT) as temp:
        pi_args = write_fixture(Path(temp), "pi", "12345678")
        pi_passing = verify(pi_args, skip_cli=True)
        if not pi_passing["ok"]:
            print(json.dumps(pi_passing, ensure_ascii=False, indent=2))
            return 1

        sessions_path = Path(pi_args.scry_user_data) / "app-sessions.json"
        sessions = load_json(sessions_path)
        sessions.append({
            **sessions[0],
            "sessionId": "pi-other-session",
            "externalSessionId": "pi-other-session",
            "agentProfileId": "pi:other",
        })
        sessions_path.write_text(json.dumps(sessions, ensure_ascii=False), encoding="utf-8")
        pi_with_other_profile = verify(pi_args, skip_cli=True)
        if not pi_with_other_profile["ok"]:
            print(json.dumps(pi_with_other_profile, ensure_ascii=False, indent=2))
            return 1

        sessions[0]["agentProfileId"] = "pi:other"
        sessions_path.write_text(json.dumps(sessions, ensure_ascii=False), encoding="utf-8")
        pi_wrong_session_profile = verify(pi_args, skip_cli=True)
        if pi_wrong_session_profile["ok"] or not any(
            item["name"] == "scry.session_index.unique_match"
            for item in pi_wrong_session_profile["failures"]
        ):
            print(json.dumps(pi_wrong_session_profile, ensure_ascii=False, indent=2))
            return 1

        sessions[0]["agentProfileId"] = "pi:default"
        sessions_path.write_text(json.dumps(sessions, ensure_ascii=False), encoding="utf-8")
        permission_path = Path(pi_args.permission_evidence)
        permission_fixture = load_json(permission_path)
        permission_fixture["agentProfileId"] = "pi:other"
        permission_fixture["expected"]["label"] = PERMISSION["label"]
        permission_fixture["expected"]["agentProfileId"] = "pi:other"
        permission_fixture["prepared"]["agentProfileId"] = "pi:other"
        for snapshot in (permission_fixture["actual"], permission_fixture["actualAtBind"]):
            snapshot["agentProfileId"] = "pi:other"
        permission_path.write_text(json.dumps(permission_fixture, ensure_ascii=False), encoding="utf-8")
        pi_wrong_permission_identity = verify(pi_args, skip_cli=True)
        pi_permission_failures = {item["name"] for item in pi_wrong_permission_identity["failures"]}
        if pi_wrong_permission_identity["ok"] or not {
            "permission.agent_profile",
            "permission.expected",
            "permission.prepared_agent_profile",
            "permission.dom",
            "permission.dom_at_bind",
        } <= pi_permission_failures:
            print(json.dumps(pi_wrong_permission_identity, ensure_ascii=False, indent=2))
            return 1
    with tempfile.TemporaryDirectory(prefix=TEST_RUN_PREFIX, dir=TEST_RUN_ROOT_PARENT) as temp:
        args = write_fixture(Path(temp), "opencode", "12345678")
        passing = verify(args, skip_cli=True)
        if not passing["ok"]:
            print(json.dumps(passing, ensure_ascii=False, indent=2))
            return 1
        permission_path = Path(args.permission_evidence)
        permission_fixture = load_json(permission_path)
        permission_fixture["actual"]["testLaunchId"] = "wrong-launch"
        permission_path.write_text(json.dumps(permission_fixture, ensure_ascii=False), encoding="utf-8")
        failing_identity = verify(args, skip_cli=True)
        if failing_identity["ok"] or not any(
            item["name"] == "permission.dom"
            for item in failing_identity["failures"]
        ):
            print(json.dumps(failing_identity, ensure_ascii=False, indent=2))
            return 1
        permission_fixture["actual"]["testLaunchId"] = "fixture-launch"
        permission_fixture["actual"]["providerSelectable"] = False
        permission_path.write_text(json.dumps(permission_fixture, ensure_ascii=False), encoding="utf-8")
        failing_locked_draft = verify(args, skip_cli=True)
        if failing_locked_draft["ok"] or not any(
            item["name"] == "permission.dom"
            for item in failing_locked_draft["failures"]
        ):
            print(json.dumps(failing_locked_draft, ensure_ascii=False, indent=2))
            return 1
        permission_fixture["actual"].pop("providerSelectable")
        permission_path.write_text(json.dumps(permission_fixture, ensure_ascii=False), encoding="utf-8")
        passing_legacy_capture = verify(args, skip_cli=True)
        if not passing_legacy_capture["ok"]:
            print(json.dumps(passing_legacy_capture, ensure_ascii=False, indent=2))
            return 1
        permission_fixture["actual"]["providerSelectable"] = True
        permission_path.write_text(json.dumps(permission_fixture, ensure_ascii=False), encoding="utf-8")

        state_path = Path(args.test_app_state)
        state_fixture = load_json(state_path)
        state_fixture["rendererOwnership"]["actual"]["browserPath"] = "/devtools/browser/foreign"
        state_path.write_text(json.dumps(state_fixture, ensure_ascii=False), encoding="utf-8")
        failing_ownership = verify(args, skip_cli=True)
        if failing_ownership["ok"] or not any(
            item["name"] == "test_app.ownership_identity"
            for item in failing_ownership["failures"]
        ):
            print(json.dumps(failing_ownership, ensure_ascii=False, indent=2))
            return 1
        state_fixture["rendererOwnership"]["actual"]["browserPath"] = "/devtools/browser/fixture-browser"
        state_path.write_text(json.dumps(state_fixture, ensure_ascii=False), encoding="utf-8")

        overview = passing["recordEvidenceOverview"]
        expected_overview = {
            "turns": {"count": 3, "statusCounts": {"completed": 3}},
            "timing": {"sessionSpanMs": 7000, "cumulativeDurationMs": 6000},
            "calls": {"total": 3, "skills": 1, "mcps": 1, "hooks": 3},
            "usage": {
                "inputTokens": 6,
                "outputTokens": 12,
                "cacheCreationTokens": 0,
                "costUsd": 6.0,
            },
            "files": {"read": 1, "write": 2, "edit": 0},
            "diff": {"added": 6, "deleted": 3, "fileCount": 3},
            "dangerousOperations": 0,
        }
        actual_overview = {
            "turns": overview["turns"],
            "timing": {
                "sessionSpanMs": overview["timing"]["sessionSpanMs"],
                "cumulativeDurationMs": overview["timing"]["cumulativeDurationMs"],
            },
            "calls": {
                "total": overview["calls"]["total"],
                "skills": overview["calls"]["skills"]["displayCount"],
                "mcps": overview["calls"]["mcps"]["displayCount"],
                "hooks": overview["calls"]["hooks"]["displayCount"],
            },
            "usage": {
                key: overview["usage"][key]["displayValue"]
                for key in ("inputTokens", "outputTokens", "cacheCreationTokens", "costUsd")
            },
            "files": overview["files"]["displayCounts"],
            "diff": {
                key: overview["diff"][key]
                for key in ("added", "deleted", "fileCount")
            },
            "dangerousOperations": overview["dangerousOperations"]["displayCount"],
        }
        if actual_overview != expected_overview:
            print(json.dumps({
                "message": "overview fixture mismatch",
                "expected": expected_overview,
                "actual": actual_overview,
            }, ensure_ascii=False, indent=2))
            return 1
        projection = passing["cliIndependentProjection"]
        expected_projection = {
            "calls": {
                "total": 3,
                "ordinaryTools": {"total": 1},
                "mcp": {"total": 1},
                "skills": {"total": 1},
                "subagents": {"total": 0},
            },
            "hooks": {"handlerInstances": 3, "lifecycleEvents": 3},
            "usage": {
                "totalTokens": 18,
                "inputTokens": 6,
                "outputTokens": 12,
                "cacheReadTokens": 3,
                "cacheCreationTokens": 0,
                "reasoningTokens": 3,
            },
            "files": {"structuredPaths": 3},
            "diff": {"files": 3, "added": 6, "deleted": 3},
            "errors": {"total": 1},
            "dangerousOperations": {"total": 0},
            "wall": {"cumulativeMs": 6000},
        }
        actual_projection = {key: projection[key] for key in expected_projection}
        if actual_projection != expected_projection:
            print(json.dumps({
                "message": "CLI summary projection fixture mismatch",
                "expected": expected_projection,
                "actual": actual_projection,
            }, ensure_ascii=False, indent=2))
            return 1
        raw_records = [load_json(Path(item["path"])) for item in passing["records"]]
        fake_summary = summary_projection(raw_records, passing["sessionId"])
        fake_summary["files"]["uniquePaths"] = fake_summary["files"]["structuredPaths"]
        fake_summary_path = Path(temp) / "fake-cli-summary.json"
        fake_summary_path.write_text(json.dumps(fake_summary), encoding="utf-8")
        fake_bin = Path(temp) / "fake-bin"
        fake_bin.mkdir()
        fake_scry = fake_bin / "scry"
        fake_scry.write_text(
            """#!/bin/sh
if [ "$1" = "turns" ] && [ "$2" = "verify" ]; then
  exit 0
fi
if [ "$1" = "turns" ] && [ "$2" = "summary" ] && [ "$3" = "$VALIDATE_SCRY_EXPECTED_SESSION" ] && [ "$4" = "--workspace" ] && [ "$5" = "$VALIDATE_SCRY_EXPECTED_WORKSPACE" ] && [ "$6" = "--json" ]; then
  /bin/cat "$VALIDATE_SCRY_SUMMARY_FIXTURE"
  exit 0
fi
exit 64
""",
            encoding="utf-8",
        )
        fake_scry.chmod(0o755)
        environment_keys = (
            "PATH",
            "VALIDATE_SCRY_EXPECTED_SESSION",
            "VALIDATE_SCRY_EXPECTED_WORKSPACE",
            "VALIDATE_SCRY_SUMMARY_FIXTURE",
        )
        previous_environment = {key: os.environ.get(key) for key in environment_keys}
        try:
            os.environ["PATH"] = str(fake_bin) + os.pathsep + os.environ.get("PATH", "")
            os.environ["VALIDATE_SCRY_EXPECTED_SESSION"] = passing["sessionId"]
            os.environ["VALIDATE_SCRY_EXPECTED_WORKSPACE"] = str(Path(args.workspace))
            os.environ["VALIDATE_SCRY_SUMMARY_FIXTURE"] = str(fake_summary_path)
            cli_checks: list[dict[str, Any]] = []
            cli_actual = run_cli_checks(
                Path(args.workspace), cli_checks, raw_records, passing["sessionId"], fake_scry.resolve()
            )
        finally:
            for key, value in previous_environment.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value
        if cli_actual != fake_summary or not cli_checks or not all(item["ok"] for item in cli_checks):
            print(json.dumps({
                "message": "real CLI invocation contract fixture mismatch",
                "summary": cli_actual,
                "checks": cli_checks,
            }, ensure_ascii=False, indent=2))
            return 1
        partial_records = [
            load_json(Path(item["path"]))
            for item in passing["records"]
        ]
        partial_records[1]["usage"] = {
            "status": "unavailable",
            "quality": "unavailable",
            "source": ["fixture"],
            "omissionReason": "fixture missing usage",
        }
        partial_overview = record_evidence_summary(
            partial_records,
            Path(args.workspace),
            args.provider,
            passing["sessionId"],
        )
        partial_input = partial_overview["usage"]["inputTokens"]
        if partial_input["knownValue"] != 4 or partial_input["displayValue"] is not None:
            print(json.dumps({
                "message": "unknown usage must not be rendered as a complete total",
                "actual": partial_input,
            }, ensure_ascii=False, indent=2))
            return 1
        record_path = Path(passing["records"][1]["path"])
        record = load_json(record_path)
        record["user"]["value"]["text"] = "污染的第三种文本"
        record_path.write_text(json.dumps(record, ensure_ascii=False), encoding="utf-8")
        failing = verify(args, skip_cli=True)
        failure_names = {item["name"] for item in failing["failures"]}
        if failing["ok"] or not {"cli.turn.prompts", "cli.turn2.user.exact"} <= failure_names:
            print(json.dumps(failing, ensure_ascii=False, indent=2))
            return 1
        record = load_json(record_path)
        record["user"]["value"]["text"] = SECOND_PROMPT
        record["user"]["value"]["textHash"] = hash_text(SECOND_PROMPT)
        record["assistant"]["value"]["textHash"] = "sha256:corrupted"
        record_path.write_text(json.dumps(record, ensure_ascii=False), encoding="utf-8")
        failing = verify(args, skip_cli=True)
        if failing["ok"] or not any(
            item["name"] == "cli.turn2.assistant.exact"
            for item in failing["failures"]
        ):
            print(json.dumps(failing, ensure_ascii=False, indent=2))
            return 1
        record["assistant"]["value"]["textHash"] = hash_text("ok")
        record_path.write_text(json.dumps(record, ensure_ascii=False), encoding="utf-8")

        archive_path = Path(passing["archivePaths"][1])
        archive = load_json(archive_path)

        record["diff"]["value"][0]["files"][0]["path"] = "$WORKSPACE/fixture-2.txt"
        record_path.write_text(json.dumps(record, ensure_ascii=False), encoding="utf-8")
        failing = verify(args, skip_cli=True)
        if failing["ok"] or not any(
            item["name"] == "parity.turn2.diff"
            for item in failing["failures"]
        ):
            print(json.dumps(failing, ensure_ascii=False, indent=2))
            return 1
        record["diff"] = archive["turns"][0]["turnEvidence"]["diff"]
        record_path.write_text(json.dumps(record, ensure_ascii=False), encoding="utf-8")

        record["usage"]["value"]["inputTokens"] = True
        record_path.write_text(json.dumps(record, ensure_ascii=False), encoding="utf-8")
        failing = verify(args, skip_cli=True)
        if failing["ok"] or not any(
            item["name"] == "parity.turn2.usage"
            for item in failing["failures"]
        ):
            print(json.dumps(failing, ensure_ascii=False, indent=2))
            return 1
        record["usage"]["value"]["inputTokens"] = 2
        record_path.write_text(json.dumps(record, ensure_ascii=False), encoding="utf-8")

        corrupted_text = "archive 与 CLI 同时污染"
        corrupted_hash = hash_text(corrupted_text)
        record["assistant"]["value"] = {"text": corrupted_text, "textHash": corrupted_hash}
        archive["turns"][0]["turnEvidence"]["assistant"]["value"] = {
            "text": corrupted_text,
            "textHash": corrupted_hash,
        }
        record_path.write_text(json.dumps(record, ensure_ascii=False), encoding="utf-8")
        archive_path.write_text(json.dumps(archive, ensure_ascii=False), encoding="utf-8")
        failing = verify(args, skip_cli=True)
        if failing["ok"] or not any(
            item["name"] == "scry.turn2.assistant.exact"
            for item in failing["failures"]
        ):
            print(json.dumps(failing, ensure_ascii=False, indent=2))
            return 1
        record["assistant"]["value"] = {"text": "ok", "textHash": hash_text("ok")}
        archive["turns"][0]["turnEvidence"]["assistant"]["value"] = {
            "text": "ok",
            "textHash": hash_text("ok"),
        }
        record_path.write_text(json.dumps(record, ensure_ascii=False), encoding="utf-8")

        archive["turns"][0]["turnEvidence"]["errors"]["value"][0]["toolUseId"] = True
        archive_path.write_text(json.dumps(archive, ensure_ascii=False), encoding="utf-8")
        failing = verify(args, skip_cli=True)
        if failing["ok"] or not any(
            item["name"] == "scry.turn2.errors.raw_selector"
            for item in failing["failures"]
        ):
            print(json.dumps(failing, ensure_ascii=False, indent=2))
            return 1
        archive["turns"][0]["turnEvidence"]["errors"]["value"][0]["toolUseId"] = "tool-2"

        archive["turns"][0]["durationMs"] = 1999
        archive_path.write_text(json.dumps(archive, ensure_ascii=False), encoding="utf-8")
        failing = verify(args, skip_cli=True)
        failure_names = {item["name"] for item in failing["failures"]}
        if failing["ok"] or not {
            "scry.turn2.timing.valid",
            "parity.turn2.timing",
        } <= failure_names:
            print(json.dumps(failing, ensure_ascii=False, indent=2))
            return 1
    with tempfile.TemporaryDirectory(prefix=TEST_RUN_PREFIX, dir=TEST_RUN_ROOT_PARENT) as temp:
        qoder_args = write_fixture(Path(temp), "qoder", "12345678")
        qoder_initial = verify(qoder_args, skip_cli=True)
        if not qoder_initial["ok"]:
            print(json.dumps(qoder_initial, ensure_ascii=False, indent=2))
            return 1
        answer = "fixture document body"
        intervention = {
            "kind": "clarification",
            "source": "qoder:AskUserQuestion",
            "resolution": "answered",
            "request": {
                "runId": "run-1",
                "questionId": "tool-qoder-question",
                "providerId": "qoder",
                "questions": [{"question": "固定文档？"}],
            },
            "response": {
                "runId": "run-1",
                "questionId": "tool-qoder-question",
                "behavior": "answered",
                "answers": {"固定文档？": answer},
            },
        }
        first_archive_path = Path(qoder_initial["archivePaths"][0])
        first_archive = load_json(first_archive_path)
        first_archive["turns"][0]["turnEvidence"]["interventions"] = {
            "status": "available",
            "quality": "exact",
            "source": ["fixture"],
            "value": [intervention],
        }
        first_archive_path.write_text(json.dumps(first_archive, ensure_ascii=False), encoding="utf-8")
        first_record_path = Path(qoder_initial["records"][0]["path"])
        first_record = load_json(first_record_path)
        first_record["interventions"] = first_archive["turns"][0]["turnEvidence"]["interventions"]
        first_record_path.write_text(json.dumps(first_record, ensure_ascii=False), encoding="utf-8")
        qoder_run_root = Path(qoder_args.test_app_state).parent
        journal_path = qoder_run_root / "qoder-question-journal.json"
        journal = {
            "schemaVersion": 1,
            "state": "ANSWER_RECORDED",
            "runRoot": str(qoder_run_root),
            "provider": "qoder",
            "expectedTurns": 1,
            "launchId": "fixture-launch",
            "sessionId": "session-test",
            "runId": "run-1",
            "toolCallId": "tool-qoder-question",
            "questionFingerprint": "sha256:fixture",
            "fixedDocumentUrl": CONTRACT["document"]["url"],
            "observationCount": 1,
            "distinctQuestionCount": 1,
            "answerEvidence": {
                "bytes": len(answer.encode("utf-8")),
                "sha256": hash_text(answer),
            },
        }
        journal_path.write_text(json.dumps(journal, ensure_ascii=False), encoding="utf-8")
        qoder_answered = verify(qoder_args, skip_cli=True)
        if not qoder_answered["ok"]:
            print(json.dumps(qoder_answered, ensure_ascii=False, indent=2))
            return 1
        journal["answerEvidence"]["sha256"] = "sha256:wrong"
        journal_path.write_text(json.dumps(journal, ensure_ascii=False), encoding="utf-8")
        qoder_mismatch = verify(qoder_args, skip_cli=True)
        if qoder_mismatch["ok"] or not any(
            item["name"] == "qoder.question_intervention.unique_bound_answer"
            for item in qoder_mismatch["failures"]
        ):
            print(json.dumps(qoder_mismatch, ensure_ascii=False, indent=2))
            return 1
    with tempfile.TemporaryDirectory(prefix=TEST_RUN_PREFIX, dir=TEST_RUN_ROOT_PARENT) as temp:
        source_args = write_fixture(Path(temp), "codex", SOURCE_WORKITEM_ID)
        default_result = verify(source_args, skip_cli=True)
        if default_result["ok"] or not any(
            item["name"] == "workitem.is_clone"
            for item in default_result["failures"]
        ):
            print(json.dumps(default_result, ensure_ascii=False, indent=2))
            return 1
        source_args.local_equality_only = True
        local_result = verify(source_args, skip_cli=True)
        if not local_result["ok"]:
            print(json.dumps(local_result, ensure_ascii=False, indent=2))
            return 1
    print("self-test: PASS")
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", help="Leased rate-native treehouse path")
    parser.add_argument("--provider", choices=sorted(RUNTIME))
    parser.add_argument("--workitem-id", help="User-provided cloned numeric Aone workitem ID")
    parser.add_argument("--session-id", help="Pin an exact Scry session ID")
    parser.add_argument("--scry-user-data", help="Required isolated Scry Test userData directory")
    parser.add_argument("--test-app-state", help="Required state JSON from test_scry_app.mjs")
    parser.add_argument("--permission-evidence", help="Bound permission-evidence.json from capture_permission.mjs")
    parser.add_argument("--scry-bin", help="Required frozen absolute Scry CLI path from the baseline preflight")
    parser.add_argument("--second-prompt", default=SECOND_PROMPT)
    parser.add_argument("--third-prompt", default=THIRD_PROMPT)
    parser.add_argument("--expected-turns", type=int, choices=(2, 3), default=3)
    parser.add_argument("--output", help="Also write the JSON report to this path")
    parser.add_argument(
        "--local-equality-only",
        action="store_true",
        help=(
            "Validate only isolated Scry archive ↔ workspace CLI equality; "
            "allows the fixed source workitem only when the user explicitly chooses local equality without a manual clone ID"
        ),
    )
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if not args.self_test:
        missing = [
            name
            for name in (
                "workspace",
                "provider",
                "workitem_id",
                "scry_user_data",
                "test_app_state",
                "permission_evidence",
                "scry_bin",
            )
            if not getattr(args, name)
        ]
        if missing:
            parser.error("missing required arguments: " + ", ".join("--" + name.replace("_", "-") for name in missing))
        if not args.workitem_id.isdigit():
            parser.error("--workitem-id must contain digits only")
    return args


def main() -> int:
    args = parse_args()
    if args.self_test:
        return self_test()
    result = verify(args)
    rendered = json.dumps(result, ensure_ascii=False, indent=2)
    print(rendered)
    if args.output:
        Path(args.output).write_text(rendered + "\n", encoding="utf-8")
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
