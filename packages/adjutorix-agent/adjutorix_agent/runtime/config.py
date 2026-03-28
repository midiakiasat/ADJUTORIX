"""
ADJUTORIX AGENT — RUNTIME CONFIGURATION

Deterministic, validated configuration loader.
- Single source of truth for runtime parameters
- Environment + file layering (env overrides file)
- Strong typing + schema validation
- No implicit defaults beyond explicitly defined constants
- Reject unknown fields to prevent drift

Config precedence (highest first):
1) Environment variables (ADJUTORIX_*)
2) Explicit config file path (env: ADJUTORIX_CONFIG)
3) Default config file: .adjutorix/agent.json

All consumers must use this module. No direct os.environ access elsewhere.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Final

from pydantic import BaseModel, Field, ValidationError, field_validator


# ---------------------------------------------------------------------------
# CONSTANTS
# ---------------------------------------------------------------------------

DEFAULT_CONFIG_PATH: Final[str] = ".adjutorix/agent.json"
ENV_PREFIX: Final[str] = "ADJUTORIX_"


# ---------------------------------------------------------------------------
# SCHEMA
# ---------------------------------------------------------------------------

class ServerConfig(BaseModel):
    host: str = Field(min_length=1)
    port: int = Field(ge=1, le=65535)
    log_level: str = Field(pattern=r"^(debug|info|warning|error|critical)$")


class StorageConfig(BaseModel):
    sqlite_url: str = Field(min_length=1)


class RuntimeConfig(BaseModel):
    max_concurrent_jobs: int = Field(ge=1)
    strict_sequential_mutations: bool
    verify_timeout_seconds: int = Field(ge=1)


class SecurityConfig(BaseModel):
    disable_network_by_default: bool
    allowed_outbound_hosts: list[str]
    block_shell_by_default: bool


class PathsConfig(BaseModel):
    workspace_root: str
    agent_data_dir: str
    ledger_path: str
    temp_dir: str

    @field_validator("workspace_root", "agent_data_dir", "ledger_path", "temp_dir")
    @classmethod
    def _no_empty(cls, v: str) -> str:
        if not v:
            raise ValueError("Path cannot be empty")
        return v


class ObservabilityConfig(BaseModel):
    emit_structured_events: bool
    emit_metrics: bool
    redact_secrets: bool


class ConfigModel(BaseModel):
    server: ServerConfig
    storage: StorageConfig
    runtime: RuntimeConfig
    security: SecurityConfig
    paths: PathsConfig
    observability: ObservabilityConfig

    model_config = {
        "extra": "forbid"  # reject unknown fields
    }


# ---------------------------------------------------------------------------
# DEFAULTS (EXPLICIT)
# ---------------------------------------------------------------------------

DEFAULTS: Final[Dict[str, Any]] = {
    "server": {
        "host": "127.0.0.1",
        "port": 8000,
        "log_level": "info",
    },
    "storage": {
        "sqlite_url": "sqlite:///./.adjutorix/ledger.db",
    },
    "runtime": {
        "max_concurrent_jobs": 1,
        "strict_sequential_mutations": True,
        "verify_timeout_seconds": 600,
    },
    "security": {
        "disable_network_by_default": True,
        "allowed_outbound_hosts": [],
        "block_shell_by_default": True,
    },
    "paths": {
        "workspace_root": ".",
        "agent_data_dir": ".adjutorix",
        "ledger_path": ".adjutorix/ledger.db",
        "temp_dir": ".adjutorix/tmp",
    },
    "observability": {
        "emit_structured_events": True,
        "emit_metrics": True,
        "redact_secrets": True,
    },
}


# ---------------------------------------------------------------------------
# ENV PARSING
# ---------------------------------------------------------------------------

def _env_key(path: str) -> str:
    return ENV_PREFIX + path.replace(".", "_").upper()


def _apply_env_overrides(config: Dict[str, Any]) -> Dict[str, Any]:
    out = json.loads(json.dumps(config))  # deep copy

    def _set(d: Dict[str, Any], path: list[str], value: str) -> None:
        for p in path[:-1]:
            d = d.setdefault(p, {})
        leaf = path[-1]

        # type coercion based on existing default
        base = d.get(leaf)
        if isinstance(base, bool):
            d[leaf] = value.lower() in ("1", "true", "yes")
        elif isinstance(base, int):
            d[leaf] = int(value)
        elif isinstance(base, list):
            d[leaf] = [x for x in value.split(",") if x]
        else:
            d[leaf] = value

    def _walk(prefix: str, node: Dict[str, Any], path: list[str]):
        for k, v in node.items():
            full = path + [k]
            envk = _env_key(".".join(full))
            if envk in os.environ:
                _set(out, full, os.environ[envk])
            if isinstance(v, dict):
                _walk(prefix, v, full)

    _walk("", out, [])
    return out


# ---------------------------------------------------------------------------
# FILE LOADING
# ---------------------------------------------------------------------------

def _load_file(path: Path) -> Dict[str, Any]:
    if not path.exists():
        return {}
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


# ---------------------------------------------------------------------------
# PUBLIC API
# ---------------------------------------------------------------------------

def load_config(dev: bool = False) -> Dict[str, Any]:
    # 1) start from defaults
    config: Dict[str, Any] = json.loads(json.dumps(DEFAULTS))

    # 2) file override
    cfg_path = os.environ.get("ADJUTORIX_CONFIG", DEFAULT_CONFIG_PATH)
    file_cfg = _load_file(Path(cfg_path))

    def _merge(dst: Dict[str, Any], src: Dict[str, Any]) -> None:
        for k, v in src.items():
            if isinstance(v, dict) and isinstance(dst.get(k), dict):
                _merge(dst[k], v)
            else:
                dst[k] = v

    _merge(config, file_cfg)

    # 3) env override
    config = _apply_env_overrides(config)

    # 4) dev adjustments (explicit, not implicit)
    if dev:
        config["server"]["log_level"] = "debug"

    return config


def validate_config(config: Dict[str, Any]) -> None:
    try:
        model = ConfigModel(**config)
    except ValidationError as exc:
        raise RuntimeError(f"Invalid configuration: {exc}") from exc

    # cross-field constraints
    if model.runtime.max_concurrent_jobs != 1 and model.runtime.strict_sequential_mutations:
        raise RuntimeError(
            "Invalid config: strict_sequential_mutations requires max_concurrent_jobs == 1"
        )

    if model.security.disable_network_by_default and model.security.allowed_outbound_hosts:
        # allowed list is meaningful only when network is enabled
        pass

    # ensure paths are normalized
    base = Path(model.paths.agent_data_dir)
    Path(model.paths.temp_dir).mkdir(parents=True, exist_ok=True)
    base.mkdir(parents=True, exist_ok=True)


# ---------------------------------------------------------------------------
# EXPORTS
# ---------------------------------------------------------------------------

__all__ = [
    "load_config",
    "validate_config",
    "ConfigModel",
]
