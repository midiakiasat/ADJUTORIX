from __future__ import annotations

import json
import os
import sys
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping, Sequence

import httpx
import typer
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from pydantic_settings import BaseSettings, SettingsConfigDict
from rich.console import Console
from rich.json import JSON
from rich.panel import Panel
from rich.table import Table

APP_NAME = "ADJUTORIX"
APP_VERSION = "0.1.0"
DEFAULT_AGENT_URL = "http://127.0.0.1:8000/rpc"
DEFAULT_TIMEOUT_SECONDS = 30.0
DEFAULT_TOKEN_FILE = Path.home() / ".adjutorix" / "token"

app = typer.Typer(
    add_completion=False,
    help=(
        "Governed CLI for ADJUTORIX agent, verify, replay, ledger, workspace, and patch workflows. "
        "Every consequential action remains explicit, inspectable, and authority-bounded."
    ),
    no_args_is_help=True,
    rich_markup_mode="rich",
)

workspace_app = typer.Typer(help="Workspace inspection and control commands.")
agent_app = typer.Typer(help="Agent connectivity, session, and messaging commands.")
verify_app = typer.Typer(help="Verification lifecycle and evidence commands.")
patch_app = typer.Typer(help="Patch inspection and governed apply commands.")
ledger_app = typer.Typer(help="Ledger inspection and replay-oriented transaction history commands.")

app.add_typer(workspace_app, name="workspace")
app.add_typer(agent_app, name="agent")
app.add_typer(verify_app, name="verify")
app.add_typer(patch_app, name="patch")
app.add_typer(ledger_app, name="ledger")


class OutputMode(str, Enum):
    text = "text"
    json = "json"


class Severity(str, Enum):
    info = "info"
    warning = "warning"
    error = "error"


class CliError(Exception):
    def __init__(self, message: str, *, exit_code: int = 1, details: Mapping[str, Any] | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.exit_code = exit_code
        self.details = dict(details or {})


class RpcError(CliError):
    pass


class ConfirmationError(CliError):
    pass


class Config(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="ADJUTORIX_",
        env_file=None,
        extra="ignore",
    )

    agent_url: str = DEFAULT_AGENT_URL
    token: str | None = None
    token_file: Path = DEFAULT_TOKEN_FILE
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS
    output: OutputMode = OutputMode.text
    no_color: bool = False
    require_confirmation_for_apply: bool = True


class RpcEnvelope(BaseModel):
    model_config = ConfigDict(extra="allow")

    jsonrpc: str = Field(default="2.0")
    id: int | str | None = None
    result: Any | None = None
    error: dict[str, Any] | None = None


class WorkspaceSelection(BaseModel):
    workspace_id: str | None = None
    root_path: str | None = None
    trust_level: str | None = None
    status: str | None = None


class VerifySelection(BaseModel):
    verify_id: str
    status: str | None = None
    phase: str | None = None
    replayable: bool | None = None
    apply_readiness_impact: str | None = None


class PatchSelection(BaseModel):
    patch_id: str
    title: str | None = None
    status: str | None = None
    apply_readiness: str | None = None


class LedgerSelection(BaseModel):
    ledger_id: str
    head_seq: int | None = None
    selected_seq: int | None = None
    replayable: bool | None = None


@dataclass(slots=True)
class Runtime:
    config: Config
    console: Console
    output: OutputMode


class RpcClient:
    def __init__(self, runtime: Runtime) -> None:
        self.runtime = runtime
        self._request_id = 0

    def _next_id(self) -> int:
        self._request_id += 1
        return self._request_id

    def _load_token(self) -> str:
        cfg = self.runtime.config
        if cfg.token:
            return cfg.token
        if cfg.token_file.exists():
            token = cfg.token_file.read_text(encoding="utf-8").strip()
            if token:
                return token
        raise CliError(
            "No ADJUTORIX token available. Provide --token, set ADJUTORIX_TOKEN, or bootstrap ~/.adjutorix/token.",
            exit_code=2,
            details={"token_file": str(cfg.token_file)},
        )

    def call(self, method: str, params: Mapping[str, Any] | None = None) -> Any:
        request_id = self._next_id()
        payload = {
            "jsonrpc": "2.0",
            "id": request_id,
            "method": method,
            "params": dict(params or {}),
        }
        headers = {
            "Content-Type": "application/json",
            "x-adjutorix-token": self._load_token(),
        }
        try:
            with httpx.Client(timeout=self.runtime.config.timeout_seconds) as client:
                response = client.post(self.runtime.config.agent_url, json=payload, headers=headers)
                response.raise_for_status()
        except httpx.HTTPStatusError as exc:
            raise RpcError(
                f"HTTP failure calling {method}: {exc.response.status_code}",
                exit_code=3,
                details={"method": method, "status_code": exc.response.status_code},
            ) from exc
        except httpx.HTTPError as exc:
            raise RpcError(
                f"Transport failure calling {method}: {exc}",
                exit_code=3,
                details={"method": method},
            ) from exc

        try:
            envelope = RpcEnvelope.model_validate(response.json())
        except (ValueError, ValidationError) as exc:
            raise RpcError(
                f"Malformed RPC response for {method}",
                exit_code=3,
                details={"method": method},
            ) from exc

        if envelope.error is not None:
            raise RpcError(
                str(envelope.error.get("message", f"RPC error calling {method}")),
                exit_code=4,
                details={"method": method, "rpc_error": envelope.error},
            )
        return envelope.result


def make_runtime(
    output: OutputMode,
    agent_url: str | None,
    token: str | None,
    token_file: Path | None,
    timeout_seconds: float | None,
    no_color: bool,
) -> Runtime:
    cfg = Config(
        output=output,
        agent_url=agent_url or DEFAULT_AGENT_URL,
        token=token,
        token_file=token_file or DEFAULT_TOKEN_FILE,
        timeout_seconds=timeout_seconds or DEFAULT_TIMEOUT_SECONDS,
        no_color=no_color,
    )
    console = Console(no_color=no_color, stderr=False)
    return Runtime(config=cfg, console=console, output=output)


def emit(runtime: Runtime, payload: Any, *, title: str | None = None) -> None:
    if runtime.output is OutputMode.json:
        runtime.console.print(JSON.from_data(payload))
        return

    if isinstance(payload, str):
        runtime.console.print(payload)
        return

    if isinstance(payload, Mapping):
        runtime.console.print(Panel.fit(json.dumps(payload, indent=2, sort_keys=True), title=title or "ADJUTORIX"))
        return

    runtime.console.print(payload)


def emit_table(runtime: Runtime, title: str, columns: Sequence[str], rows: Iterable[Sequence[Any]]) -> None:
    if runtime.output is OutputMode.json:
        emit(runtime, {"title": title, "columns": list(columns), "rows": [list(row) for row in rows]})
        return

    table = Table(title=title)
    for column in columns:
        table.add_column(column)
    for row in rows:
        table.add_row(*["" if value is None else str(value) for value in row])
    runtime.console.print(table)


def require_confirmation(confirm: bool, subject: str) -> None:
    if not confirm:
        raise ConfirmationError(
            f"Refusing consequential action without explicit confirmation: {subject}. Pass --confirm to proceed.",
            exit_code=5,
            details={"subject": subject},
        )


def common_options(
    output: OutputMode = typer.Option(OutputMode.text, "--output", case_sensitive=False),
    agent_url: str | None = typer.Option(None, "--agent-url", help="Override agent RPC URL."),
    token: str | None = typer.Option(None, "--token", help="Override auth token directly."),
    token_file: Path | None = typer.Option(None, "--token-file", help="Override token file path."),
    timeout_seconds: float | None = typer.Option(None, "--timeout", min=0.1, help="RPC timeout in seconds."),
    no_color: bool = typer.Option(False, "--no-color", help="Disable terminal color output."),
) -> Runtime:
    return make_runtime(output, agent_url, token, token_file, timeout_seconds, no_color)


@app.callback()
def root() -> None:
    """ADJUTORIX governed CLI root."""


@app.command("ping")
def ping(
    output: OutputMode = typer.Option(OutputMode.text, "--output", case_sensitive=False),
    agent_url: str | None = typer.Option(None, "--agent-url"),
    token: str | None = typer.Option(None, "--token"),
    token_file: Path | None = typer.Option(None, "--token-file"),
    timeout_seconds: float | None = typer.Option(None, "--timeout"),
    no_color: bool = typer.Option(False, "--no-color"),
) -> None:
    runtime = common_options(output, agent_url, token, token_file, timeout_seconds, no_color)
    client = RpcClient(runtime)
    result = client.call("system.ping", {})
    emit(runtime, {"ok": True, "result": result}, title="Ping")


@workspace_app.command("status")
def workspace_status(
    workspace_id: str | None = typer.Option(None, "--workspace-id"),
    output: OutputMode = typer.Option(OutputMode.text, "--output", case_sensitive=False),
    agent_url: str | None = typer.Option(None, "--agent-url"),
    token: str | None = typer.Option(None, "--token"),
    token_file: Path | None = typer.Option(None, "--token-file"),
    timeout_seconds: float | None = typer.Option(None, "--timeout"),
    no_color: bool = typer.Option(False, "--no-color"),
) -> None:
    runtime = common_options(output, agent_url, token, token_file, timeout_seconds, no_color)
    client = RpcClient(runtime)
    result = client.call("workspace.status", {"workspace_id": workspace_id} if workspace_id else {})
    if runtime.output is OutputMode.json:
        emit(runtime, result)
        return

    ws = WorkspaceSelection.model_validate(result if isinstance(result, Mapping) else {})
    emit_table(
        runtime,
        "Workspace Status",
        ["Field", "Value"],
        [
            ("Workspace ID", ws.workspace_id),
            ("Root Path", ws.root_path),
            ("Trust Level", ws.trust_level),
            ("Status", ws.status),
        ],
    )


@workspace_app.command("open")
def workspace_open(
    path: str = typer.Argument(..., help="Workspace root path to open."),
    output: OutputMode = typer.Option(OutputMode.text, "--output", case_sensitive=False),
    agent_url: str | None = typer.Option(None, "--agent-url"),
    token: str | None = typer.Option(None, "--token"),
    token_file: Path | None = typer.Option(None, "--token-file"),
    timeout_seconds: float | None = typer.Option(None, "--timeout"),
    no_color: bool = typer.Option(False, "--no-color"),
) -> None:
    runtime = common_options(output, agent_url, token, token_file, timeout_seconds, no_color)
    client = RpcClient(runtime)
    result = client.call("workspace.open", {"path": os.fspath(Path(path).expanduser().resolve())})
    emit(runtime, result, title="Workspace Opened")


@agent_app.command("connect")
def agent_connect(
    output: OutputMode = typer.Option(OutputMode.text, "--output", case_sensitive=False),
    agent_url: str | None = typer.Option(None, "--agent-url"),
    token: str | None = typer.Option(None, "--token"),
    token_file: Path | None = typer.Option(None, "--token-file"),
    timeout_seconds: float | None = typer.Option(None, "--timeout"),
    no_color: bool = typer.Option(False, "--no-color"),
) -> None:
    runtime = common_options(output, agent_url, token, token_file, timeout_seconds, no_color)
    client = RpcClient(runtime)
    result = client.call("agent.connect", {})
    emit(runtime, result, title="Agent Connected")


@agent_app.command("status")
def agent_status(
    output: OutputMode = typer.Option(OutputMode.text, "--output", case_sensitive=False),
    agent_url: str | None = typer.Option(None, "--agent-url"),
    token: str | None = typer.Option(None, "--token"),
    token_file: Path | None = typer.Option(None, "--token-file"),
    timeout_seconds: float | None = typer.Option(None, "--timeout"),
    no_color: bool = typer.Option(False, "--no-color"),
) -> None:
    runtime = common_options(output, agent_url, token, token_file, timeout_seconds, no_color)
    client = RpcClient(runtime)
    result = client.call("agent.status", {})
    emit(runtime, result, title="Agent Status")


@agent_app.command("send")
def agent_send(
    message: str = typer.Argument(..., help="Message to send to the connected ADJUTORIX agent."),
    output: OutputMode = typer.Option(OutputMode.text, "--output", case_sensitive=False),
    agent_url: str | None = typer.Option(None, "--agent-url"),
    token: str | None = typer.Option(None, "--token"),
    token_file: Path | None = typer.Option(None, "--token-file"),
    timeout_seconds: float | None = typer.Option(None, "--timeout"),
    no_color: bool = typer.Option(False, "--no-color"),
) -> None:
    runtime = common_options(output, agent_url, token, token_file, timeout_seconds, no_color)
    client = RpcClient(runtime)
    result = client.call("agent.send", {"message": message})
    emit(runtime, result, title="Agent Message Accepted")


@verify_app.command("status")
def verify_status(
    verify_id: str = typer.Argument(..., help="Verification identifier."),
    output: OutputMode = typer.Option(OutputMode.text, "--output", case_sensitive=False),
    agent_url: str | None = typer.Option(None, "--agent-url"),
    token: str | None = typer.Option(None, "--token"),
    token_file: Path | None = typer.Option(None, "--token-file"),
    timeout_seconds: float | None = typer.Option(None, "--timeout"),
    no_color: bool = typer.Option(False, "--no-color"),
) -> None:
    runtime = common_options(output, agent_url, token, token_file, timeout_seconds, no_color)
    client = RpcClient(runtime)
    raise RuntimeError("agent_method_not_exposed:verify.status")
    if runtime.output is OutputMode.json:
        emit(runtime, result)
        return

    verify = VerifySelection.model_validate(result if isinstance(result, Mapping) else {"verify_id": verify_id})
    emit_table(
        runtime,
        f"Verify {verify.verify_id}",
        ["Field", "Value"],
        [
            ("Status", verify.status),
            ("Phase", verify.phase),
            ("Replayable", verify.replayable),
            ("Apply Impact", verify.apply_readiness_impact),
        ],
    )


@verify_app.command("start")
def verify_start(
    patch_id: str = typer.Argument(..., help="Patch identifier to verify."),
    output: OutputMode = typer.Option(OutputMode.text, "--output", case_sensitive=False),
    agent_url: str | None = typer.Option(None, "--agent-url"),
    token: str | None = typer.Option(None, "--token"),
    token_file: Path | None = typer.Option(None, "--token-file"),
    timeout_seconds: float | None = typer.Option(None, "--timeout"),
    no_color: bool = typer.Option(False, "--no-color"),
) -> None:
    runtime = common_options(output, agent_url, token, token_file, timeout_seconds, no_color)
    client = RpcClient(runtime)
    result = client.call("verify.start", {"patch_id": patch_id})
    emit(runtime, result, title="Verify Started")


@patch_app.command("status")
def patch_status(
    patch_id: str = typer.Argument(..., help="Patch identifier."),
    output: OutputMode = typer.Option(OutputMode.text, "--output", case_sensitive=False),
    agent_url: str | None = typer.Option(None, "--agent-url"),
    token: str | None = typer.Option(None, "--token"),
    token_file: Path | None = typer.Option(None, "--token-file"),
    timeout_seconds: float | None = typer.Option(None, "--timeout"),
    no_color: bool = typer.Option(False, "--no-color"),
) -> None:
    runtime = common_options(output, agent_url, token, token_file, timeout_seconds, no_color)
    client = RpcClient(runtime)
    result = client.call("patch.status", {"patch_id": patch_id})
    if runtime.output is OutputMode.json:
        emit(runtime, result)
        return

    patch = PatchSelection.model_validate(result if isinstance(result, Mapping) else {"patch_id": patch_id})
    emit_table(
        runtime,
        f"Patch {patch.patch_id}",
        ["Field", "Value"],
        [
            ("Title", patch.title),
            ("Status", patch.status),
            ("Apply Readiness", patch.apply_readiness),
        ],
    )


@patch_app.command("apply")
def patch_apply(
    patch_id: str = typer.Argument(..., help="Patch identifier to apply."),
    confirm: bool = typer.Option(False, "--confirm", help="Acknowledge explicit consequential apply intent."),
    output: OutputMode = typer.Option(OutputMode.text, "--output", case_sensitive=False),
    agent_url: str | None = typer.Option(None, "--agent-url"),
    token: str | None = typer.Option(None, "--token"),
    token_file: Path | None = typer.Option(None, "--token-file"),
    timeout_seconds: float | None = typer.Option(None, "--timeout"),
    no_color: bool = typer.Option(False, "--no-color"),
) -> None:
    runtime = common_options(output, agent_url, token, token_file, timeout_seconds, no_color)
    require_confirmation(confirm, f"apply patch {patch_id}")
    client = RpcClient(runtime)
    raise RuntimeError("agent_method_not_exposed:patch.apply")
    emit(runtime, result, title="Patch Applied")


@ledger_app.command("status")
def ledger_status(
    ledger_id: str = typer.Argument(..., help="Ledger identifier."),
    output: OutputMode = typer.Option(OutputMode.text, "--output", case_sensitive=False),
    agent_url: str | None = typer.Option(None, "--agent-url"),
    token: str | None = typer.Option(None, "--token"),
    token_file: Path | None = typer.Option(None, "--token-file"),
    timeout_seconds: float | None = typer.Option(None, "--timeout"),
    no_color: bool = typer.Option(False, "--no-color"),
) -> None:
    runtime = common_options(output, agent_url, token, token_file, timeout_seconds, no_color)
    client = RpcClient(runtime)
    result = client.call("ledger.status", {"ledger_id": ledger_id})
    if runtime.output is OutputMode.json:
        emit(runtime, result)
        return

    ledger = LedgerSelection.model_validate(result if isinstance(result, Mapping) else {"ledger_id": ledger_id})
    emit_table(
        runtime,
        f"Ledger {ledger.ledger_id}",
        ["Field", "Value"],
        [
            ("Head Seq", ledger.head_seq),
            ("Selected Seq", ledger.selected_seq),
            ("Replayable", ledger.replayable),
        ],
    )


def _handle_error(exc: Exception) -> typer.Exit:
    if isinstance(exc, CliError):
        console = Console(stderr=True)
        console.print(Panel.fit(exc.message, title="ADJUTORIX Error", border_style="red"))
        if exc.details:
            console.print(JSON.from_data(exc.details))
        return typer.Exit(exc.exit_code)

    console = Console(stderr=True)
    console.print(Panel.fit(f"Unexpected failure: {exc}", title="ADJUTORIX Error", border_style="red"))
    return typer.Exit(1)


def main(argv: Sequence[str] | None = None) -> int:
    args = list(argv) if argv is not None else sys.argv[1:]
    try:
        app(args=args, standalone_mode=False)
    except typer.Exit as exc:
        return int(exc.exit_code or 0)
    except Exception as exc:  # noqa: BLE001
        raise _handle_error(exc)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
