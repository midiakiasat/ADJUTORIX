from __future__ import annotations

import json
from typing import Any

import pytest
from typer.testing import CliRunner

from adjutorix_cli.main import app

runner = CliRunner(mix_stderr=False)


@pytest.fixture
def replay_payload() -> dict[str, Any]:
    return {
        "ledger": {
            "ledger_id": "ledger-42",
            "headSeq": 12,
            "selectedSeq": 12,
            "replayable": True,
            "continuity": "intact",
            "entries": [
                {
                    "id": "entry-10",
                    "seq": 10,
                    "title": "Patch proposed",
                    "kind": "patch",
                    "phase": "completed",
                    "replayable": True,
                    "status": "completed",
                    "metadata": {},
                },
                {
                    "id": "entry-11",
                    "seq": 11,
                    "title": "Verify executed",
                    "kind": "verify",
                    "phase": "completed",
                    "replayable": True,
                    "status": "passed",
                    "metadata": {},
                },
                {
                    "id": "entry-12",
                    "seq": 12,
                    "title": "Apply ready",
                    "kind": "apply-gate",
                    "phase": "completed",
                    "replayable": True,
                    "status": "ready",
                    "metadata": {},
                },
            ],
            "edges": [
                {
                    "id": "edge-10-11",
                    "fromSeq": 10,
                    "toSeq": 11,
                    "kind": "replay",
                    "metadata": {},
                },
                {
                    "id": "edge-11-12",
                    "fromSeq": 11,
                    "toSeq": 12,
                    "kind": "replay",
                    "metadata": {},
                },
            ],
        },
        "selectedSeq": 12,
        "scope": "lineage",
        "expectation": {
            "expected_status": "passed",
            "expected_determinism": "deterministic",
            "require_replayable_lineage": True,
            "allow_environment_drift": False,
            "require_exact_selected_seq": True,
            "require_exact_head_seq": False,
            "require_zero_failures": True,
        },
        "recordedEnvironment": {
            "fingerprint": "fp-1",
            "platform": "darwin/arm64",
            "toolchain": {"python": "3.12.7", "node": "22.11.0"},
            "workspace_root": "/repo/adjutorix-app",
            "trust_level": "trusted",
            "readonly_media": False,
            "offline": False,
            "degraded": False,
        },
        "currentEnvironment": {
            "fingerprint": "fp-1",
            "platform": "darwin/arm64",
            "toolchain": {"python": "3.12.7", "node": "22.11.0"},
            "workspace_root": "/repo/adjutorix-app",
            "trust_level": "trusted",
            "readonly_media": False,
            "offline": False,
            "degraded": False,
        },
        "rollback_on_failure": False,
    }


@pytest.fixture
def replay_payload_blocked(replay_payload: dict[str, Any]) -> dict[str, Any]:
    payload = json.loads(json.dumps(replay_payload))
    payload["ledger"]["entries"][2]["replayable"] = False
    return payload


@pytest.fixture
def replay_payload_drifted(replay_payload: dict[str, Any]) -> dict[str, Any]:
    payload = json.loads(json.dumps(replay_payload))
    payload["currentEnvironment"]["fingerprint"] = "fp-2"
    return payload


def _invoke_replay(monkeypatch: pytest.MonkeyPatch, args: list[str], payload: dict[str, Any]):
    from adjutorix_cli import main as main_mod

    class DummyResult:
        def __init__(self, result: Any):
            self.result = result

    class DummyClient:
        def __init__(self, runtime: Any):
            self.runtime = runtime
            self.calls: list[tuple[str, dict[str, Any]]] = []

        def call(self, method: str, params: dict[str, Any] | None = None):
            self.calls.append((method, params or {}))
            assert method == "replay.execute"
            return payload

    monkeypatch.setattr(main_mod, "RpcClient", DummyClient)
    return runner.invoke(app, args)


def test_replay_text_success_renders_authoritative_summary(monkeypatch: pytest.MonkeyPatch, replay_payload: dict[str, Any]) -> None:
    result = _invoke_replay(
        monkeypatch,
        [
            "replay",
            "run",
            "--ledger-id",
            "ledger-42",
            "--selected-seq",
            "12",
            "--scope",
            "lineage",
        ],
        replay_payload,
    )

    assert result.exit_code == 0, result.stdout
    assert "Replay Report" in result.stdout
    assert "ledger-42" in result.stdout
    assert "passed" in result.stdout.lower()
    assert "deterministic" in result.stdout.lower()
    assert "Apply ready" in result.stdout or "Apply ready" in json.dumps(replay_payload)


def test_replay_json_success_emits_machine_readable_payload(monkeypatch: pytest.MonkeyPatch, replay_payload: dict[str, Any]) -> None:
    result = _invoke_replay(
        monkeypatch,
        [
            "replay",
            "run",
            "--ledger-id",
            "ledger-42",
            "--selected-seq",
            "12",
            "--scope",
            "lineage",
            "--output",
            "json",
        ],
        replay_payload,
    )

    assert result.exit_code == 0, result.stdout
    parsed = json.loads(result.stdout)
    assert parsed["ledger_id"] == "ledger-42"
    assert parsed["status"] == "passed"
    assert parsed["determinism"] == "deterministic"
    assert parsed["selected_seq"] == 12
    assert parsed["environment_match"] in {"exact", "compatible"}


def test_replay_blocked_non_replayable_lineage_exits_nonzero(monkeypatch: pytest.MonkeyPatch, replay_payload_blocked: dict[str, Any]) -> None:
    result = _invoke_replay(
        monkeypatch,
        [
            "replay",
            "run",
            "--ledger-id",
            "ledger-42",
            "--selected-seq",
            "12",
            "--scope",
            "lineage",
        ],
        replay_payload_blocked,
    )

    assert result.exit_code != 0
    text = (result.stdout + result.stderr).lower()
    assert "non-replayable" in text or "blocked" in text or "fatal" in text


def test_replay_environment_drift_blocks_when_not_allowed(monkeypatch: pytest.MonkeyPatch, replay_payload_drifted: dict[str, Any]) -> None:
    result = _invoke_replay(
        monkeypatch,
        [
            "replay",
            "run",
            "--ledger-id",
            "ledger-42",
            "--selected-seq",
            "12",
            "--scope",
            "lineage",
        ],
        replay_payload_drifted,
    )

    assert result.exit_code != 0
    text = (result.stdout + result.stderr).lower()
    assert "drift" in text or "environment" in text or "blocked" in text


def test_replay_allow_environment_drift_switch_changes_outcome(monkeypatch: pytest.MonkeyPatch, replay_payload_drifted: dict[str, Any]) -> None:
    payload = json.loads(json.dumps(replay_payload_drifted))
    payload["expectation"]["allow_environment_drift"] = True

    result = _invoke_replay(
        monkeypatch,
        [
            "replay",
            "run",
            "--ledger-id",
            "ledger-42",
            "--selected-seq",
            "12",
            "--scope",
            "lineage",
            "--allow-environment-drift",
        ],
        payload,
    )

    assert result.exit_code == 0, result.stdout
    assert "drifted" in result.stdout.lower() or "compatible" in result.stdout.lower() or "passed" in result.stdout.lower()


def test_replay_missing_selected_seq_for_selected_scope_fails_parse(monkeypatch: pytest.MonkeyPatch, replay_payload: dict[str, Any]) -> None:
    result = _invoke_replay(
        monkeypatch,
        [
            "replay",
            "run",
            "--ledger-id",
            "ledger-42",
            "--scope",
            "selected",
        ],
        replay_payload,
    )

    assert result.exit_code != 0
    text = (result.stdout + result.stderr).lower()
    assert "selected" in text and ("required" in text or "missing" in text)


def test_replay_summary_command_renders_compact_status(monkeypatch: pytest.MonkeyPatch, replay_payload: dict[str, Any]) -> None:
    result = _invoke_replay(
        monkeypatch,
        [
            "replay",
            "summary",
            "--ledger-id",
            "ledger-42",
            "--selected-seq",
            "12",
            "--scope",
            "lineage",
            "--output",
            "compact",
        ],
        replay_payload,
    )

    assert result.exit_code == 0, result.stdout
    text = result.stdout.lower()
    assert "status=passed" in text or "passed" in text
    assert "ledger_id=ledger-42" in text or "ledger-42" in text


def test_replay_governance_gate_reports_apply_unsafety(monkeypatch: pytest.MonkeyPatch, replay_payload_blocked: dict[str, Any]) -> None:
    result = _invoke_replay(
        monkeypatch,
        [
            "replay",
            "governance",
            "--ledger-id",
            "ledger-42",
            "--selected-seq",
            "12",
            "--scope",
            "lineage",
            "--action",
            "apply",
        ],
        replay_payload_blocked,
    )

    assert result.exit_code != 0
    text = (result.stdout + result.stderr).lower()
    assert "governance" in text
    assert "blocked" in text or "not replayable" in text or "apply" in text


def test_replay_rpc_method_and_params_are_stable(monkeypatch: pytest.MonkeyPatch, replay_payload: dict[str, Any]) -> None:
    from adjutorix_cli import main as main_mod

    captured: dict[str, Any] = {}

    class DummyClient:
        def __init__(self, runtime: Any):
            self.runtime = runtime

        def call(self, method: str, params: dict[str, Any] | None = None):
            captured["method"] = method
            captured["params"] = params or {}
            return replay_payload

    monkeypatch.setattr(main_mod, "RpcClient", DummyClient)
    result = runner.invoke(
        app,
        [
            "replay",
            "run",
            "--ledger-id",
            "ledger-42",
            "--selected-seq",
            "12",
            "--scope",
            "lineage",
            "--rollback-on-failure",
        ],
    )

    assert result.exit_code == 0, result.stdout
    assert captured["method"] == "replay.execute"
    assert captured["params"]["ledger_id"] == "ledger-42"
    assert captured["params"]["selected_seq"] == 12
    assert captured["params"]["scope"] == "lineage"
    assert captured["params"]["rollback_on_failure"] is True
