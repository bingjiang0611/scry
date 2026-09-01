#!/usr/bin/env python3
"""发送第一条消息前预检 MCP 执行护栏，避免 agent:start 才暴露阻塞。

发送前覆盖历史高频入口：
- Provider 实际读取的多个 scope 中重复启用同名 server，导致 precedence 不唯一；
- 复用 Scry 的 Provider 配置路径/Claude disabled set，并提前检查以下拒绝规则：
- `command`/`args`/`env`/`url`/`headers` 里出现 `${VAR}` 父进程环境插值；
- `bearer_token_env_var` / `env_http_headers` 这类父进程凭据绑定出现在非 user scope，
  除非 contract 允许该 server/rule 且引用的 env 已由对应 Provider 的项目本地 settings.local.json 提供；
- `env` 里出现可改变执行目标的键。

这不是完整 trust-engine 副本；executable identity、credential proxy 与 scan error
仍由 Scry `agent:start` 的只读 guard 最终裁决。Scry 侧路径或下列规则变化时
必须同步本文件。
只输出服务名、scope、规则与变量名，不读取也不打印任何凭据值。
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import tempfile
import tomllib
from pathlib import Path
from typing import Any

SKILL_DIR = Path(__file__).resolve().parent.parent
CONTRACT_PATH = SKILL_DIR / "references" / "contract.json"
CONTRACT = json.loads(CONTRACT_PATH.read_text(encoding="utf-8"))
CREDENTIAL_SCOPE_EXCEPTIONS = {
    (str(item["server"]), str(item["rule"]))
    for item in CONTRACT.get("mcpExecutionPolicy", {}).get("credentialScopeExceptions", [])
    if isinstance(item, dict) and isinstance(item.get("server"), str) and isinstance(item.get("rule"), str)
}

ENV_INTERPOLATION = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}")
CREDENTIAL_KEYS = ("bearer_token_env_var", "env_http_headers")
INTERPOLATION_KEYS = ("command", "args", "env", "url", "headers", "http_headers")
EXECUTION_SHAPING_ENV = {
    "PATH", "Path", "NODE_OPTIONS", "NODE_PATH", "PYTHONPATH", "PYTHONHOME",
    "RUBYOPT", "PERL5OPT", "BASH_ENV", "ENV", "LD_PRELOAD", "LD_LIBRARY_PATH",
    "JAVA_TOOL_OPTIONS", "_JAVA_OPTIONS", "DOTNET_STARTUP_HOOKS", "LUA_INIT",
}
SERVER_KEY = {"claude": "mcpServers", "codex": "mcp_servers", "qoder": "mcpServers", "opencode": "mcp", "pi": None}
LOCAL_SETTINGS_BY_PROVIDER = {
    "claude": ".claude/settings.local.json",
    "codex": ".codex/settings.local.json",
    "qoder": ".qoder/settings.local.json",
    "opencode": ".opencode/settings.local.json",
}


def absolute_config_root(raw: str | None, fallback: Path, cwd: Path) -> Path:
    configured = (raw or "").strip()
    if not configured:
        return fallback
    path = Path(configured).expanduser()
    return path.resolve() if path.is_absolute() else (cwd / path).resolve()


def config_paths(provider: str, cwd: Path, home: Path) -> list[Path]:
    if provider == "claude":
        return [home / ".claude.json", cwd / ".mcp.json", cwd / ".claude" / "settings.local.json"]
    if provider == "codex":
        root = absolute_config_root(os.environ.get("CODEX_HOME"), home / ".codex", cwd)
        return [root / "config.toml", cwd / ".codex" / "config.toml"]
    if provider == "qoder":
        if (os.environ.get("QODER_CONFIG_DIR") or "").strip():
            root = absolute_config_root(os.environ.get("QODER_CONFIG_DIR"), home / ".qoder", cwd)
        else:
            root = absolute_config_root(os.environ.get("QODER_CLI_HOME"), home, cwd) / ".qoder"
        return [root / "mcp.json", cwd / ".mcp.json", cwd / ".qoder" / "mcp.json"]
    config_home = absolute_config_root(os.environ.get("XDG_CONFIG_HOME"), home / ".config", cwd)
    configured = (os.environ.get("OPENCODE_CONFIG") or "").strip()
    user = absolute_config_root(configured, config_home / "opencode" / "opencode.json", cwd)
    return [user, cwd / "opencode.json"]


def parse(path: Path) -> dict[str, Any] | None:
    try:
        if path.suffix == ".toml":
            return tomllib.loads(path.read_text(encoding="utf-8"))
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, tomllib.TOMLDecodeError):
        return None


def claude_disabled(cwd: Path, home: Path) -> set[str]:
    disabled_json: set[str] = set()
    disabled_user: set[str] = set()
    enabled_json: set[str] = set()

    def add(target: set[str], value: Any) -> None:
        if isinstance(value, list):
            target.update(str(item) for item in value)

    user = parse(home / ".claude.json") or {}
    project = user.get("projects", {}).get(str(cwd), {}) if isinstance(user.get("projects"), dict) else {}
    local = parse(cwd / ".claude" / "settings.local.json") or {}
    for value in (project, local):
        if not isinstance(value, dict):
            continue
        add(disabled_json, value.get("disabledMcpjsonServers"))
        add(disabled_user, value.get("disabledMcpServers"))
        add(enabled_json, value.get("enabledMcpjsonServers"))
    disabled_json.difference_update(enabled_json)
    return disabled_json | disabled_user


def server_groups(
    provider: str,
    parsed: dict[str, Any],
    path: Path,
    cwd: Path,
    home: Path,
) -> list[tuple[str, dict[str, Any], str]]:
    if provider != "claude":
        found = parsed.get(SERVER_KEY[provider])
        scope = "project" if str(path).startswith(f"{cwd}/") else "user"
        return [(scope, found, str(path))] if isinstance(found, dict) else []
    disabled = claude_disabled(cwd, home)
    groups: list[tuple[str, dict[str, Any], str]] = []
    if path == home / ".claude.json":
        top = parsed.get("mcpServers")
        if isinstance(top, dict):
            groups.append(("user", {
                name: {**raw, "disabled": True} if name in disabled and isinstance(raw, dict) else raw
                for name, raw in top.items()
            }, str(path)))
        projects = parsed.get("projects")
        project = projects.get(str(cwd)) if isinstance(projects, dict) else None
        project_servers = project.get("mcpServers") if isinstance(project, dict) else None
        if isinstance(project_servers, dict):
            groups.append(("project", {
                name: {**raw, "disabled": True} if name in disabled and isinstance(raw, dict) else raw
                for name, raw in project_servers.items()
            }, str(path)))
    elif path == cwd / ".mcp.json":
        found = parsed.get("mcpServers")
        if isinstance(found, dict):
            groups.append(("project", {
                name: {**raw, "disabled": True} if name in disabled and isinstance(raw, dict) else raw
                for name, raw in found.items()
            }, str(path)))
    return groups


def interpolations(value: Any, path: str, found: list[str]) -> None:
    if isinstance(value, str):
        names = sorted({match.group(1) for match in ENV_INTERPOLATION.finditer(value)})
        if names:
            found.append(f"{path}: {', '.join(names)}")
    elif isinstance(value, list):
        for index, item in enumerate(value):
            interpolations(item, f"{path}[{index}]", found)
    elif isinstance(value, dict):
        for key, item in value.items():
            interpolations(item, f"{path}.{key}", found)


def credential_env_names(key: str, value: Any) -> list[str]:
    if key == "bearer_token_env_var":
        return [value] if isinstance(value, str) and value else []
    if key == "env_http_headers" and isinstance(value, dict):
        return sorted(str(item) for item in value.values() if isinstance(item, str) and item)
    return []


def provider_local_env(provider: str, cwd: Path) -> tuple[set[str], str | None]:
    relative = LOCAL_SETTINGS_BY_PROVIDER[provider]
    path = cwd / relative
    parsed = parse(path)
    env = parsed.get("env") if isinstance(parsed, dict) else None
    if not isinstance(env, dict):
        return set(), str(path) if path.exists() else None
    names = {str(key) for key, value in env.items() if isinstance(value, str) and value}
    return names, str(path)


def inspect(provider: str, cwd: Path, home: Path) -> dict[str, Any]:
    if provider == "pi":
        return {
            "ok": True,
            "provider": provider,
            "workspace": str(cwd),
            "status": "not_applicable",
            "reason": "Pi RPC has no structured MCP execution surface",
            "checked": [],
            "userScopeServers": [],
            "trustedProjectCredentials": [],
            "violations": [],
            "coverage": {
                "configResolution": "not_applicable",
                "authoritativeRuntimeGuard": "Scry Pi capability declares mcp unsupported",
            },
        }
    checked: list[dict[str, Any]] = []
    violations: list[dict[str, Any]] = []
    trusted_project_credentials: list[dict[str, Any]] = []
    local_env_names, local_settings_path = provider_local_env(provider, cwd)
    user_scope: list[str] = []
    enabled_by_name: dict[str, list[dict[str, str]]] = {}
    for path in config_paths(provider, cwd, home):
        exists = path.is_file()
        parsed = parse(path) if exists else None
        checked.append({"path": str(path), "exists": exists, "parsed": parsed is not None})
        if exists and parsed is None:
            violations.append({
                "server": None,
                "scope": "project" if str(path).startswith(f"{cwd}/") else "user",
                "sourcePath": str(path),
                "rule": "config_unreadable",
                "detail": "configuration exists but cannot be parsed",
            })
        if not parsed:
            continue
        for scope, group, source_path in server_groups(provider, parsed, path, cwd, home):
            for name, raw in group.items():
                if not isinstance(raw, dict):
                    continue
                if raw.get("enabled") is False or raw.get("disabled") is True:
                    continue
                enabled_by_name.setdefault(name, []).append({"scope": scope, "sourcePath": source_path})
                if scope == "user":
                    user_scope.append(name)
                found: list[str] = []
                for key in INTERPOLATION_KEYS:
                    if key in raw:
                        interpolations(raw[key], key, found)
                for detail in found:
                    violations.append({
                        "server": name, "scope": scope, "sourcePath": source_path,
                        "rule": "parent_env_interpolation", "detail": detail,
                    })
                for key in CREDENTIAL_KEYS:
                    if key not in raw or scope == "user":
                        continue
                    env_names = credential_env_names(key, raw[key])
                    rule = "credential_env_outside_user_scope"
                    exception_allowed = (name, rule) in CREDENTIAL_SCOPE_EXCEPTIONS
                    if exception_allowed and env_names and set(env_names).issubset(local_env_names):
                        trusted_project_credentials.append({
                            "server": name,
                            "scope": scope,
                            "sourcePath": source_path,
                            "rule": rule,
                            "key": key,
                            "envNames": sorted(env_names),
                            "localSettingsPath": local_settings_path,
                        })
                        continue
                    if key == "bearer_token_env_var":
                        detail = f"{key}={raw[key]}" if isinstance(raw[key], str) else key
                    else:
                        names = sorted(raw[key]) if isinstance(raw[key], dict) else [key]
                        detail = f"{key}: {', '.join(names)}"
                    violations.append({
                        "server": name, "scope": scope, "sourcePath": source_path,
                        "rule": rule, "detail": detail,
                    })
                env = raw.get("env")
                if isinstance(env, dict):
                    dangerous = sorted(
                        key for key in env
                        if key in EXECUTION_SHAPING_ENV or key.startswith(("DYLD_", "LD_"))
                    )
                    if dangerous:
                        violations.append({
                            "server": name, "scope": scope, "sourcePath": source_path,
                            "rule": "execution_shaping_env", "detail": ", ".join(dangerous),
                        })
    for name, declarations in sorted(enabled_by_name.items()):
        unique = {(item["scope"], item["sourcePath"]) for item in declarations}
        if len(unique) <= 1:
            continue
        violations.append({
            "server": name,
            "scope": "multiple",
            "sourcePath": None,
            "rule": "duplicate_enabled_server",
            "detail": declarations,
        })
    return {
        "ok": not violations,
        "provider": provider,
        "workspace": str(cwd),
        "checked": checked,
        "userScopeServers": sorted(set(user_scope)),
        "trustedProjectCredentials": trusted_project_credentials,
        "violations": violations,
        "coverage": {
            "configResolution": "mirrors providerMcpConfigPaths including environment-specific roots",
            "claudeDisabledSets": True,
            "trustRules": sorted({"duplicate_enabled_server", "parent_env_interpolation", "credential_env_outside_user_scope", "execution_shaping_env"}),
            "projectCredentialSource": "contract credentialScopeExceptions may allow project env references backed by provider settings.local.json",
            "authoritativeRuntimeGuard": "Scry agent:start remains authoritative for executable identity, credential proxy and scan errors",
        },
    }


def self_test() -> int:
    with tempfile.TemporaryDirectory() as raw:
        root = Path(raw)
        workspace = root / "workspace"
        home = root / "home"
        (workspace / ".qoder").mkdir(parents=True)
        (home / ".qoder").mkdir(parents=True)
        (workspace / ".mcp.json").write_text(
            json.dumps({"mcpServers": {"coop": {"url": "https://project.invalid"}}}) + "\n",
            encoding="utf-8",
        )
        user_config = home / ".qoder/mcp.json"
        user_config.write_text(
            json.dumps({"mcpServers": {"coop": {"url": "https://user.invalid"}}}) + "\n",
            encoding="utf-8",
        )
        result = inspect("qoder", workspace, home)
        assert any(item["rule"] == "duplicate_enabled_server" for item in result["violations"])
        user_config.write_text(
            json.dumps({"mcpServers": {"coop": {"url": "https://user.invalid", "disabled": True}}}) + "\n",
            encoding="utf-8",
        )
        result = inspect("qoder", workspace, home)
        assert not any(item["rule"] == "duplicate_enabled_server" for item in result["violations"])
        user_config.write_text("{broken\n", encoding="utf-8")
        result = inspect("qoder", workspace, home)
        assert any(item["rule"] == "config_unreadable" for item in result["violations"])
        (workspace / ".claude").mkdir()
        claude_config = home / ".claude.json"
        claude_config.write_text(json.dumps({
            "mcpServers": {"shared": {"url": "https://user.invalid"}},
            "projects": {
                str(workspace): {"mcpServers": {"shared": {"url": "https://project.invalid"}}}
            },
        }) + "\n", encoding="utf-8")
        result = inspect("claude", workspace, home)
        assert any(item["rule"] == "duplicate_enabled_server" for item in result["violations"])
        (workspace / ".claude" / "settings.local.json").write_text(
            json.dumps({"disabledMcpServers": ["shared"]}) + "\n",
            encoding="utf-8",
        )
        result = inspect("claude", workspace, home)
        assert not any(item["rule"] == "duplicate_enabled_server" for item in result["violations"])
        assert ("ai_native_trace_report", "credential_env_outside_user_scope") in CREDENTIAL_SCOPE_EXCEPTIONS
        codex_project = workspace / ".codex"
        codex_project.mkdir()
        (codex_project / "config.toml").write_text(
            '[mcp_servers.trace]\nurl = "https://trace.invalid"\nbearer_token_env_var = "TRACE_TOKEN"\n',
            encoding="utf-8",
        )
        (codex_project / "settings.local.json").write_text(
            json.dumps({"env": {"TRACE_TOKEN": "fixture"}}) + "\n",
            encoding="utf-8",
        )
        result = inspect("codex", workspace, home)
        assert any(item["rule"] == "credential_env_outside_user_scope" for item in result["violations"])
        (codex_project / "config.toml").write_text(
            '[mcp_servers.ai_native_trace_report]\nurl = "https://trace.invalid"\nbearer_token_env_var = "TRACE_TOKEN"\n',
            encoding="utf-8",
        )
        result = inspect("codex", workspace, home)
        assert not any(item["rule"] == "credential_env_outside_user_scope" for item in result["violations"])
        assert result["trustedProjectCredentials"][0]["server"] == "ai_native_trace_report"
        assert result["trustedProjectCredentials"][0]["envNames"] == ["TRACE_TOKEN"]
        pi_result = inspect("pi", workspace, home)
        assert pi_result["ok"] is True
        assert pi_result["status"] == "not_applicable"
        assert pi_result["checked"] == []
    print("self-test: PASS")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--provider", choices=sorted(SERVER_KEY))
    parser.add_argument("--workspace")
    parser.add_argument("--output")
    args = parser.parse_args()
    if args.self_test:
        return self_test()
    if not args.provider or not args.workspace:
        parser.error("--provider and --workspace are required")

    cwd = Path(args.workspace).expanduser().resolve()
    if not cwd.is_dir():
        print(json.dumps({"ok": False, "error": f"workspace missing: {cwd}"}, ensure_ascii=False))
        return 1
    result = inspect(args.provider, cwd, Path.home())
    text = json.dumps(result, ensure_ascii=False, indent=2)
    if args.output:
        Path(args.output).write_text(text + "\n", encoding="utf-8")
    print(text)
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
