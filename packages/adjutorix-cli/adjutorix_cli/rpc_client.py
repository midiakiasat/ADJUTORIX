from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Mapping, MutableMapping, Sequence

import httpx
from pydantic import BaseModel, ConfigDict, Field, ValidationError

DEFAULT_AGENT_URL = "http://127.0.0.1:8000/rpc"
DEFAULT_TIMEOUT_SECONDS = 30.0
DEFAULT_TOKEN_FILE = Path.home() / ".adjutorix" / "token"


class RpcClientError(Exception):
    """Base transport/protocol exception for ADJUTORIX CLI RPC access."""

    def __init__(
        self,
        message: str,
        *,
        code: str = "RPC_CLIENT_ERROR",
        details: Mapping[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.code = code
        self.details = dict(details or {})


class RpcAuthError(RpcClientError):
    pass


class RpcTransportError(RpcClientError):
    pass


class RpcProtocolError(RpcClientError):
    pass


class RpcServerError(RpcClientError):
    pass


class RpcRequestEnvelope(BaseModel):
    model_config = ConfigDict(extra="forbid")

    jsonrpc: str = "2.0"
    id: int | str
    method: str
    params: dict[str, Any] = Field(default_factory=dict)


class RpcErrorEnvelope(BaseModel):
    model_config = ConfigDict(extra="allow")

    code: int | str | None = None
    message: str = "Unknown RPC error"
    data: Any | None = None


class RpcResponseEnvelope(BaseModel):
    model_config = ConfigDict(extra="allow")

    jsonrpc: str = "2.0"
    id: int | str | None = None
    result: Any | None = None
    error: RpcErrorEnvelope | None = None


@dataclass(slots=True)
class RpcRetryPolicy:
    max_attempts: int = 1
    base_backoff_seconds: float = 0.25
    retryable_status_codes: tuple[int, ...] = (408, 425, 429, 500, 502, 503, 504)
    retryable_exception_types: tuple[type[BaseException], ...] = (
        httpx.ConnectError,
        httpx.ConnectTimeout,
        httpx.ReadTimeout,
        httpx.WriteTimeout,
        httpx.RemoteProtocolError,
        httpx.PoolTimeout,
    )

    def backoff_for_attempt(self, attempt_index: int) -> float:
        return max(0.0, self.base_backoff_seconds * (2 ** max(0, attempt_index - 1)))


@dataclass(slots=True)
class RpcClientConfig:
    agent_url: str = DEFAULT_AGENT_URL
    token: str | None = None
    token_file: Path = DEFAULT_TOKEN_FILE
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS
    user_agent: str = "adjutorix-cli/0.1.0"
    retry_policy: RpcRetryPolicy = field(default_factory=RpcRetryPolicy)
    additional_headers: dict[str, str] = field(default_factory=dict)
    verify_tls: bool = True


@dataclass(slots=True)
class RpcCallMetadata:
    request_id: int | str
    method: str
    started_at_monotonic: float
    finished_at_monotonic: float
    elapsed_seconds: float
    status_code: int | None = None
    attempts: int = 1


@dataclass(slots=True)
class RpcCallResult:
    result: Any
    metadata: RpcCallMetadata


class _RequestCounter:
    def __init__(self) -> None:
        self._value = 0

    def next(self) -> int:
        self._value += 1
        return self._value


class RpcClient:
    """
    Canonical JSON-RPC transport for ADJUTORIX CLI.

    Guarantees:
    - one request id source
    - one auth/header projection path
    - one timeout/retry policy
    - one response validation/error normalization path
    - deterministic metadata for every successful call
    """

    def __init__(
        self,
        config: RpcClientConfig | None = None,
        *,
        http_client_factory: Callable[[RpcClientConfig], httpx.Client] | None = None,
        sleeper: Callable[[float], None] | None = None,
        monotonic: Callable[[], float] | None = None,
        token_loader: Callable[[RpcClientConfig], str] | None = None,
    ) -> None:
        self.config = config or RpcClientConfig()
        self._counter = _RequestCounter()
        self._http_client_factory = http_client_factory or self._default_http_client_factory
        self._sleeper = sleeper or time.sleep
        self._monotonic = monotonic or time.monotonic
        self._token_loader = token_loader or self._load_token

    def call(self, method: str, params: Mapping[str, Any] | None = None) -> RpcCallResult:
        if not method or not method.strip():
            raise RpcProtocolError(
                "RPC method name must be non-empty.",
                code="INVALID_METHOD_NAME",
            )

        request_id = self._counter.next()
        normalized_params = self._normalize_params(params)
        envelope = RpcRequestEnvelope(id=request_id, method=method, params=normalized_params)

        started = self._monotonic()
        response, attempts = self._perform_request_with_retry(envelope)
        finished = self._monotonic()

        parsed = self._parse_response(method=method, request_id=request_id, response=response)
        metadata = RpcCallMetadata(
            request_id=request_id,
            method=method,
            started_at_monotonic=started,
            finished_at_monotonic=finished,
            elapsed_seconds=max(0.0, finished - started),
            status_code=response.status_code,
            attempts=attempts,
        )
        return RpcCallResult(result=parsed, metadata=metadata)

    def call_result(self, method: str, params: Mapping[str, Any] | None = None) -> Any:
        return self.call(method, params).result

    def call_many(self, calls: Sequence[tuple[str, Mapping[str, Any] | None]]) -> list[RpcCallResult]:
        results: list[RpcCallResult] = []
        for method, params in calls:
            results.append(self.call(method, params))
        return results

    def build_headers(self) -> dict[str, str]:
        token = self._token_loader(self.config)
        headers: dict[str, str] = {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": self.config.user_agent,
            "x-adjutorix-token": token,
        }
        headers.update(self.config.additional_headers)
        return headers

    def build_request_body(self, method: str, params: Mapping[str, Any] | None = None) -> dict[str, Any]:
        request_id = self._counter.next()
        normalized_params = self._normalize_params(params)
        envelope = RpcRequestEnvelope(id=request_id, method=method, params=normalized_params)
        return envelope.model_dump(mode="python")

    def _perform_request_with_retry(self, envelope: RpcRequestEnvelope) -> tuple[httpx.Response, int]:
        policy = self.config.retry_policy
        last_exception: BaseException | None = None
        last_status_code: int | None = None

        for attempt in range(1, policy.max_attempts + 1):
            try:
                response = self._perform_request_once(envelope)
                last_status_code = response.status_code
                if self._should_retry_response(response, attempt):
                    if attempt < policy.max_attempts:
                        self._sleeper(policy.backoff_for_attempt(attempt))
                        continue
                    raise RpcTransportError(
                        f"Retry budget exhausted for RPC {envelope.method} after HTTP {response.status_code}.",
                        code="HTTP_RETRY_EXHAUSTED",
                        details={
                            "method": envelope.method,
                            "status_code": response.status_code,
                            "attempts": attempt,
                        },
                    )
                return response, attempt
            except policy.retryable_exception_types as exc:
                last_exception = exc
                if attempt < policy.max_attempts:
                    self._sleeper(policy.backoff_for_attempt(attempt))
                    continue
                raise RpcTransportError(
                    f"Retry budget exhausted for RPC {envelope.method}: {exc}",
                    code="TRANSPORT_RETRY_EXHAUSTED",
                    details={
                        "method": envelope.method,
                        "attempts": attempt,
                    },
                ) from exc
            except httpx.HTTPStatusError as exc:
                last_status_code = exc.response.status_code
                if self._should_retry_status_code(exc.response.status_code, attempt):
                    if attempt < policy.max_attempts:
                        self._sleeper(policy.backoff_for_attempt(attempt))
                        continue
                raise self._normalize_http_status_error(envelope.method, exc) from exc
            except httpx.HTTPError as exc:
                raise RpcTransportError(
                    f"Transport failure calling {envelope.method}: {exc}",
                    code="TRANSPORT_ERROR",
                    details={"method": envelope.method},
                ) from exc

        if last_exception is not None:
            raise RpcTransportError(
                f"Transport failure calling {envelope.method}: {last_exception}",
                code="TRANSPORT_ERROR",
                details={"method": envelope.method},
            ) from last_exception
        raise RpcTransportError(
            f"Transport failure calling {envelope.method}.",
            code="TRANSPORT_ERROR",
            details={
                "method": envelope.method,
                "status_code": last_status_code,
            },
        )

    def _perform_request_once(self, envelope: RpcRequestEnvelope) -> httpx.Response:
        with self._http_client_factory(self.config) as client:
            response = client.post(
                self.config.agent_url,
                headers=self.build_headers(),
                content=json.dumps(envelope.model_dump(mode="python"), separators=(",", ":")),
            )
            response.raise_for_status()
            return response

    @staticmethod
    def _default_http_client_factory(config: RpcClientConfig) -> httpx.Client:
        return httpx.Client(
            timeout=config.timeout_seconds,
            verify=config.verify_tls,
            follow_redirects=False,
        )

    def _parse_response(self, *, method: str, request_id: int | str, response: httpx.Response) -> Any:
        try:
            payload = response.json()
        except ValueError as exc:
            raise RpcProtocolError(
                f"Non-JSON response returned for RPC {method}.",
                code="NON_JSON_RESPONSE",
                details={"method": method, "status_code": response.status_code},
            ) from exc

        try:
            envelope = RpcResponseEnvelope.model_validate(payload)
        except ValidationError as exc:
            raise RpcProtocolError(
                f"Malformed JSON-RPC envelope returned for RPC {method}.",
                code="MALFORMED_RPC_ENVELOPE",
                details={"method": method, "status_code": response.status_code},
            ) from exc

        if envelope.jsonrpc != "2.0":
            raise RpcProtocolError(
                f"Unexpected JSON-RPC version for RPC {method}: {envelope.jsonrpc!r}",
                code="UNEXPECTED_JSONRPC_VERSION",
                details={"method": method, "jsonrpc": envelope.jsonrpc},
            )

        if envelope.id != request_id:
            raise RpcProtocolError(
                f"Mismatched JSON-RPC id for RPC {method}: expected {request_id!r}, received {envelope.id!r}",
                code="MISMATCHED_RPC_ID",
                details={"method": method, "expected_id": request_id, "received_id": envelope.id},
            )

        if envelope.error is not None:
            raise RpcServerError(
                envelope.error.message,
                code="RPC_SERVER_ERROR",
                details={
                    "method": method,
                    "rpc_error_code": envelope.error.code,
                    "rpc_error_data": envelope.error.data,
                },
            )

        return envelope.result

    def _load_token(self, config: RpcClientConfig) -> str:
        if config.token is not None and config.token.strip():
            return config.token.strip()

        env_token = os.environ.get("ADJUTORIX_TOKEN", "").strip()
        if env_token:
            return env_token

        try:
            token = config.token_file.read_text(encoding="utf-8").strip()
        except FileNotFoundError as exc:
            raise RpcAuthError(
                "No ADJUTORIX token available. Provide a token or create ~/.adjutorix/token.",
                code="TOKEN_NOT_FOUND",
                details={"token_file": os.fspath(config.token_file)},
            ) from exc
        except OSError as exc:
            raise RpcAuthError(
                f"Unable to read ADJUTORIX token file: {exc}",
                code="TOKEN_READ_ERROR",
                details={"token_file": os.fspath(config.token_file)},
            ) from exc

        if not token:
            raise RpcAuthError(
                "ADJUTORIX token file exists but is empty.",
                code="TOKEN_EMPTY",
                details={"token_file": os.fspath(config.token_file)},
            )
        return token

    @staticmethod
    def _normalize_params(params: Mapping[str, Any] | None) -> dict[str, Any]:
        if params is None:
            return {}
        if not isinstance(params, Mapping):
            raise RpcProtocolError(
                "JSON-RPC params must be a mapping for ADJUTORIX CLI calls.",
                code="INVALID_PARAMS_TYPE",
            )

        normalized: dict[str, Any] = {}
        for key, value in params.items():
            if not isinstance(key, str) or not key:
                raise RpcProtocolError(
                    "JSON-RPC param keys must be non-empty strings.",
                    code="INVALID_PARAM_KEY",
                )
            normalized[key] = RpcClient._normalize_json_value(value)
        return normalized

    @staticmethod
    def _normalize_json_value(value: Any) -> Any:
        if value is None or isinstance(value, (str, int, float, bool)):
            return value
        if isinstance(value, Path):
            return os.fspath(value)
        if isinstance(value, Mapping):
            normalized: dict[str, Any] = {}
            for key, inner in value.items():
                if not isinstance(key, str):
                    raise RpcProtocolError(
                        "Nested mapping keys must be strings.",
                        code="INVALID_NESTED_PARAM_KEY",
                    )
                normalized[key] = RpcClient._normalize_json_value(inner)
            return normalized
        if isinstance(value, (list, tuple)):
            return [RpcClient._normalize_json_value(item) for item in value]
        if hasattr(value, "model_dump") and callable(getattr(value, "model_dump")):
            dumped = value.model_dump(mode="python")
            return RpcClient._normalize_json_value(dumped)
        if hasattr(value, "__dict__"):
            return RpcClient._normalize_json_value(vars(value))
        raise RpcProtocolError(
            f"Unsupported param value type for JSON-RPC serialization: {type(value)!r}",
            code="UNSUPPORTED_PARAM_VALUE",
        )

    def _should_retry_response(self, response: httpx.Response, attempt: int) -> bool:
        return self._should_retry_status_code(response.status_code, attempt)

    def _should_retry_status_code(self, status_code: int, attempt: int) -> bool:
        policy = self.config.retry_policy
        if attempt >= policy.max_attempts:
            return False
        return status_code in policy.retryable_status_codes

    @staticmethod
    def _normalize_http_status_error(method: str, exc: httpx.HTTPStatusError) -> RpcClientError:
        status = exc.response.status_code
        if status in (401, 403):
            return RpcAuthError(
                f"Authentication rejected for RPC {method}: HTTP {status}",
                code="AUTH_REJECTED",
                details={"method": method, "status_code": status},
            )
        return RpcTransportError(
            f"HTTP failure calling RPC {method}: HTTP {status}",
            code="HTTP_STATUS_ERROR",
            details={"method": method, "status_code": status},
        )


def build_rpc_client(
    *,
    agent_url: str = DEFAULT_AGENT_URL,
    token: str | None = None,
    token_file: Path = DEFAULT_TOKEN_FILE,
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
    user_agent: str = "adjutorix-cli/0.1.0",
    max_attempts: int = 1,
    base_backoff_seconds: float = 0.25,
    additional_headers: Mapping[str, str] | None = None,
    verify_tls: bool = True,
) -> RpcClient:
    config = RpcClientConfig(
        agent_url=agent_url,
        token=token,
        token_file=token_file,
        timeout_seconds=timeout_seconds,
        user_agent=user_agent,
        retry_policy=RpcRetryPolicy(
            max_attempts=max(1, max_attempts),
            base_backoff_seconds=max(0.0, base_backoff_seconds),
        ),
        additional_headers=d