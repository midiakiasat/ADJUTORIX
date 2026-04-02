from __future__ import annotations

import json
from typing import Any

import pytest
from typer.testing import CliRunner

from adjutorix_cli.main import app

runner = CliRunner(mix_stderr=False)


@pytest.fixture
def verify_payload() -> dict[str, Any]:
    return {
        "verifyId": "verify-42",
        "patchId": "patch-42",
        "status": "passed",
        "phase": "completed",
        "replayable": True,
        "applyReadinessImpact": "ready",
        "checks": [
            {
                "id": "check-replay",
                "title": "Replay",
                "kind": "replay",
                "status": "passed",
                "severity": "info",
                "blocking": True,
                "summary": "Replay lineage is intact.",
                "details": ["No divergence detected across selected lineage."],
                "evidence": [
                    {
                        "id": "evidence-replay",
                        "title": "Replay evidence",
                        "kind": "replay",
                        "summary": "Replay proof for selected lineage.",
                        "payload": {"selected_seq": 12},
                        "fresh": True,
                    }
                ],
                "metadata": {},
            },
            {
                "id": "check-policy",
                "title": "Policy gate",
                "kind": "policy",
                "status": "passed",
                "severity": "info",
                "blocking": True,
                "summary": "Governance gate is satisfied.",
                "details": ["No blocked invariants were detected."],
                "evidence": [
                    {
                        "id": "evidence-policy",
                        "title": "Policy proof",
                        "kind": "policy",
                        "summary": "Governance proof bundle.",
                        "payload": {"invariants": 5},
                        "fresh": True,
                    }
                ],
                "metadata": {},
            },
            {
                "id": "check-diagnostics",
                "title": "Diagnostics",
                "kind": "diagnostics",
                "status": "passed",
                "severity": "info",
                "blocking": False,
                "summary": "No blocking diagnostics remain.",
                "details": [],
                "evidence": [],
                "metadata": {},
            },
        ],
        "artifacts": [
            {
                "id": "artifact-summary",
                "title": "Verify summary",
                "kind": "summary",
                "summary": "4/4 checks passed; apply ready.",
                "payload": {"checks": 4},
                "fresh": True,
            }
        ],
        "summary": {
            "totalChecks": 4,
            "passedChecks": 4,
            "warningChecks": 0,
            "failedChecks": 0,
            "blockedChecks": 0,
            "replayChecks": 1,
        },
        "health": {"level": "healthy", "reasons": []},
        "recordedEnvironmentFingerprint": "fp-1",
        "currentEnvironmentFingerprint": "fp-1",
    }


@pytest.fixture
def verify_payload_warning(verify_payload: dict[str, Any]) -> dict[str, Any]:
    payload = json.loads(json.dumps(verify_payload))
    payload["status"] = "warning"
    payload["summary"]["warningChecks"] = 1
    payload["checks"][2]["status"] = "warning"
    payload["checks"][2]["severity"] = "warning"
    payload["checks"][2]["summary"] = "One non-blocking warning remains."
    return payload


@pytest.fixture
def verify_payload_failed(verify_payload: dict[str, Any]) -> dict[str, Any]:
    payload = json.loads(json.dumps(verify_payload))
    payload["status"] = "failed"
    payload["applyReadinessImpact"] = "blocked"
    payload["replayable"] = False
    payload["summary"]["passedChecks"] = 2
    payload["summary"]["failedChecks"] = 1
    payload["checks"][0]["status"] = "failed"
    payload["checks"][0]["severity"] = "fatal"
    payload["checks"][0]["summary"] = "Replay divergence detected."
    return payload


@pytest.fixture
def verify_payload_stale(verify_payload: dict[str, Any]) -> dict[str, Any]:
    payload = json.loads(json.dumps(verify_payload))
    payload["artifacts"][0]["fresh"] = False
    return payload


@pytest.fixture
def verify_payload_env_mismatch(verify_payload: dict[str, Any]) -> dict[str, Any]:
    payload = json.loads(json.dumps(verify_payload))
    payload["currentEnvironmentFingerprint"] = "fp-2"
    return payload


def _invoke_verify(monkeypatch: pytest.MonkeyPatch, args: list[str], payload: dict[str, Any]):
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
            assert method in {"verify.assess", "verify.governance"}
            return payload

    monkeypatch.setattr(main_mod, "RpcClient", DummyClient)
    return runner.invoke(app, args)


def test_verify_text_success_renders_authoritative_summary(monkeypatch: pytest.MonkeyPatch, verify_payload: dict[str, Any]) -> None:
    result = _invoke_verify(
        monkeypatch,
        [
            "verify",
            "status",
            "verify-42",
        ],
        verify_payload,
    )

    assert result.exit_code == 0, result.stdout
    text = result.stdout.lower()
    assert "verify  verify-42" in text or "verify verify-42" in text or "verify-42" in text
    assert "passed" in text
    assert "ready" in text
    assert "replayable" in text


def test_verify_json_success_emits_machine_readable_payload(monkeypatch: pytest.MonkeyPatch, verify_payload: dict[str, Any]) -> None:
    result = _invoke_verify(
        monkeypatch,
        [
            "verify",
            "status",
            "verify-42",
            "--output",
            "json",
        ],
        verify_payload,
    )

    assert result.exit_code == 0, result.stdout
    parsed = json.loads(result.stdout)
    assert parsed["verifyId"] == "verify-42"
    assert parsed["status"] == "passed"
    assert parsed["applyReadinessImpact"] == "ready"
    assert parsed["replayable"] is True


def test_verify_warning_allowed_in_status_but_visible(monkeypatch: pytest.MonkeyPatch, verify_payload_warning: dict[str, Any]) -> None:
    result = _invoke_verify(
        monkeypatch,
        [
            "verify",
            "status",
            "verify-42",
        ],
        verify_payload_warning,
    )

    assert result.exit_code == 0, result.stdout
    text = result.stdout.lower()
    assert "warning" in text
    assert "ready" in text or "apply" in text


def test_verify_failed_status_exits_nonzero(monkeypatch: pytest.MonkeyPatch, verify_payload_failed: dict[str, Any]) -> None:
    result = _invoke_verify(
        monkeypatch,
        [
            "verify",
            "status",
            "verify-42",
        ],
        verify_payload_failed,
    )

    assert result.exit_code != 0
    text = (result.stdout + result.stderr).lower()
    assert "failed" in text or "blocked" in text or "divergence" in text


def test_verify_assess_requires_fresh_evidence_when_requested(monkeypatch: pytest.MonkeyPatch, verify_payload_stale: dict[str, Any]) -> None:
    result = _invoke_verify(
        monkeypatch,
        [
            "verify",
            "assess",
            "verify-42",
            "--require-fresh-evidence",
        ],
        verify_payload_stale,
    )

    assert result.exit_code != 0
    text = (result.stdout + result.stderr).lower()
    assert "stale" in text or "fresh" in text or "evidence" in text


def test_verify_assess_environment_match_blocks_when_required(monkeypatch: pytest.MonkeyPatch, verify_payload_env_mismatch: dict[str, Any]) -> None:
    result = _invoke_verify(
        monkeypatch,
        [
            "verify",
            "assess",
            "verify-42",
            "--require-environment-match",
        ],
        verify_payload_env_mismatch,
    )

    assert result.exit_code != 0
    text = (result.stdout + result.stderr).lower()
    assert "environment" in text or "fingerprint" in text or "mismatch" in text


def test_verify_assess_compact_summary_is_stable(monkeypatch: pytest.MonkeyPatch, verify_payload: dict[str, Any]) -> None:
    result = _invoke_verify(
        monkeypatch,
        [
            "verify",
            "assess",
            "verify-42",
            "--output",
            "compact",
        ],
        verify_payload,
    )

    assert result.exit_code == 0, result.stdout
    text = result.stdout.lower()
    assert "status=passed" in text or "passed" in text
    assert "verify_id=verify-42" in text or "verify-42" in text
    assert "fresh_evidence=true" in text or "fresh" in text


def test_verify_governance_apply_reports_unsafety_for_failed_verify(monkeypatch: pytest.MonkeyPatch, verify_payload_failed: dict[str, Any]) -> None:
    result = _invoke_verify(
        monkeypatch,
        [
            "verify",
            "governance",
            "verify-42",
            "--action",
            "apply",
        ],
        verify_payload_failed,
    )

    assert result.exit_code != 0
    text = (result.stdout + result.stderr).lower()
    assert "governance" in text
    assert "blocked" in text or "failed" in text or "apply" in text


def test_verify_rpc_method_and_params_are_stable(monkeypatch: pytest.MonkeyPatch, verify_payload: dict[str, Any]) -> None:
    from adjutorix_cli import main as main_mod

    captured: dict[str, Any] = {}

    class DummyClient:
        def __init__(self, runtime: Any):
            self.runtime = runtime

        def call(self, method: str, params: dict[str, Any] | None = None):
            captured["method"] = method
            captured["params"] = params or {}
            return verify_payload

    monkeypatch.setattr(main_mod, "RpcClient", DummyClient)
    result = runner.invoke(
        app,
        [
            "verify",
            "assess",
            "verify-42",
            "--require-replayable",
            "--require-apply-ready",
            "--require-fresh-evidence",
        ],
    )

    assert result.exit_code == 0, result.stdout
    assert captured["method"] == "verify.assess"
    assert captured["params"]["verify_id"] == "verify-42"
    assert captured["params"]["require_replayable"] is True
    assert captured["params"]["require_apply_ready"] is True
    assert captured["params"]["require_fresh_evidence"] is True
