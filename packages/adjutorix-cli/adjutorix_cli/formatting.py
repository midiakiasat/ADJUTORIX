from __future__ import annotations

import json
import shutil
import textwrap
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Iterable, Mapping, Sequence

from rich.console import Console, Group
from rich.json import JSON
from rich.panel import Panel
from rich.table import Table
from rich.text import Text


class OutputMode(str, Enum):
    text = "text"
    json = "json"
    compact = "compact"


class Tone(str, Enum):
    neutral = "neutral"
    success = "success"
    warning = "warning"
    danger = "danger"
    info = "info"
    muted = "muted"


@dataclass(slots=True)
class FormatConfig:
    mode: OutputMode = OutputMode.text
    width: int | None = None
    color: bool = True
    indent: int = 2
    sort_keys: bool = True
    title_align: str = "left"
    max_value_width: int = 96
    compact_list_limit: int = 8
    show_none: bool = False


@dataclass(slots=True)
class KeyValueRow:
    key: str
    value: Any
    tone: Tone = Tone.neutral


@dataclass(slots=True)
class Section:
    title: str
    rows: list[KeyValueRow] = field(default_factory=list)
    subtitle: str | None = None
    tone: Tone = Tone.neutral


@dataclass(slots=True)
class RenderedArtifact:
    text: str
    json_data: Any | None = None


class Formatter:
    """
    Canonical presentation boundary for ADJUTORIX CLI.

    Goals:
    - one normalization path from arbitrary structured payloads to text/json
    - one tone/severity mapping for statuses, governance levels, and verification surfaces
    - one consistent tabular/key-value rendering strategy
    - deterministic output for identical inputs
    """

    def __init__(self, config: FormatConfig | None = None) -> None:
        self.config = config or FormatConfig(width=_detect_terminal_width())

    def render(self, payload: Any, *, title: str | None = None, subtitle: str | None = None) -> RenderedArtifact:
        normalized = normalize_for_output(payload, show_none=self.config.show_none)
        if self.config.mode is OutputMode.json:
            return RenderedArtifact(text=self._render_json(normalized), json_data=normalized)
        if self.config.mode is OutputMode.compact:
            return RenderedArtifact(text=self._render_compact(normalized, title=title), json_data=normalized)
        return RenderedArtifact(text=self._render_rich_text(normalized, title=title, subtitle=subtitle), json_data=normalized)

    def render_sections(self, sections: Sequence[Section], *, title: str | None = None) -> RenderedArtifact:
        normalized = [
            {
                "title": section.title,
                "subtitle": section.subtitle,
                "tone": section.tone.value,
                "rows": [
                    {
                        "key": row.key,
                        "value": normalize_for_output(row.value, show_none=self.config.show_none),
                        "tone": row.tone.value,
                    }
                    for row in section.rows
                ],
            }
            for section in sections
        ]
        if self.config.mode is OutputMode.json:
            return RenderedArtifact(text=self._render_json({"title": title, "sections": normalized}), json_data=normalized)
        if self.config.mode is OutputMode.compact:
            return RenderedArtifact(text=self._render_compact({"title": title, "sections": normalized}, title=title), json_data=normalized)
        blocks: list[str] = []
        if title:
            blocks.append(self._banner(title))
        for section in sections:
            blocks.append(self._render_section(section))
        return RenderedArtifact(text="\n\n".join(blocks).rstrip(), json_data=normalized)

    def render_table(
        self,
        title: str,
        columns: Sequence[str],
        rows: Iterable[Sequence[Any]],
        *,
        subtitle: str | None = None,
    ) -> RenderedArtifact:
        row_list = [list(row) for row in rows]
        normalized = {
            "title": title,
            "subtitle": subtitle,
            "columns": list(columns),
            "rows": [normalize_for_output(row, show_none=self.config.show_none) for row in row_list],
        }
        if self.config.mode is OutputMode.json:
            return RenderedArtifact(text=self._render_json(normalized), json_data=normalized)
        if self.config.mode is OutputMode.compact:
            compact_lines = [title]
            if subtitle:
                compact_lines.append(subtitle)
            compact_lines.append(" | ".join(columns))
            for row in row_list:
                compact_lines.append(" | ".join(self._stringify_cell(cell) for cell in row))
            return RenderedArtifact(text="\n".join(compact_lines), json_data=normalized)
        return RenderedArtifact(text=self._render_ascii_table(title, columns, row_list, subtitle=subtitle), json_data=normalized)

    def console(self, *, stderr: bool = False) -> Console:
        return Console(width=self.config.width, no_color=not self.config.color, stderr=stderr)

    def print(self, payload: Any, *, title: str | None = None, subtitle: str | None = None, stderr: bool = False) -> None:
        artifact = self.render(payload, title=title, subtitle=subtitle)
        self.console(stderr=stderr).print(artifact.text)

    def _render_json(self, payload: Any) -> str:
        return json.dumps(payload, indent=self.config.indent, sort_keys=self.config.sort_keys, ensure_ascii=False)

    def _render_compact(self, payload: Any, *, title: str | None = None) -> str:
        if isinstance(payload, Mapping):
            pairs: list[str] = []
            for key in sorted(payload) if self.config.sort_keys else payload:
                value = payload[key]
                pairs.append(f"{key}={self._compact_value(value)}")
            head = f"{title}: " if title else ""
            return head + ", ".join(pairs)
        if isinstance(payload, Sequence) and not isinstance(payload, (str, bytes, bytearray)):
            return f"{title}: {', '.join(self._compact_value(item) for item in payload)}" if title else ", ".join(self._compact_value(item) for item in payload)
        return f"{title}: {self._compact_value(payload)}" if title else self._compact_value(payload)

    def _render_rich_text(self, payload: Any, *, title: str | None = None, subtitle: str | None = None) -> str:
        if isinstance(payload, Mapping):
            section = Section(
                title=title or "ADJUTORIX",
                subtitle=subtitle,
                rows=[KeyValueRow(key=str(k), value=v, tone=infer_tone_from_key_value(str(k), v)) for k, v in payload.items()],
            )
            return self._render_section(section)
        if isinstance(payload, Sequence) and not isinstance(payload, (str, bytes, bytearray)):
            lines = [self._banner(title or "ADJUTORIX")]
            if subtitle:
                lines.append(subtitle)
            for item in payload:
                lines.append(f"- {self._compact_value(item)}")
            return "\n".join(lines)
        return f"{self._banner(title or 'ADJUTORIX')}\n{self._wrap(self._compact_value(payload))}"

    def _render_section(self, section: Section) -> str:
        key_width = max((len(row.key) for row in section.rows), default=0)
        key_width = min(max(key_width, 8), 32)
        lines: list[str] = [self._banner(section.title, tone=section.tone)]
        if section.subtitle:
            lines.append(self._wrap(section.subtitle, indent=0))
        for row in section.rows:
            value_lines = self._format_value_lines(row.value, available=max(16, (self.config.width or 100) - key_width - 5))
            label = colorize(f"{row.key:<{key_width}}", row.tone, enabled=self.config.color)
            if not value_lines:
                lines.append(f"{label} :")
                continue
            lines.append(f"{label} : {value_lines[0]}")
            for extra in value_lines[1:]:
                lines.append(f"{' ' * key_width}   {extra}")
        return "\n".join(lines).rstrip()

    def _render_ascii_table(
        self,
        title: str,
        columns: Sequence[str],
        rows: Sequence[Sequence[Any]],
        *,
        subtitle: str | None = None,
    ) -> str:
        normalized_rows = [[self._stringify_cell(cell) for cell in row] for row in rows]
        widths = [len(column) for column in columns]
        for row in normalized_rows:
            for index, cell in enumerate(row):
                widths[index] = min(max(widths[index], len(cell)), self.config.max_value_width)

        def fmt_row(values: Sequence[str]) -> str:
            padded = [truncate_text(value, widths[idx]) for idx, value in enumerate(values)]
            return "| " + " | ".join(f"{value:<{widths[idx]}}" for idx, value in enumerate(padded)) + " |"

        border = "+-" + "-+-".join("-" * width for width in widths) + "-+"
        lines = [self._banner(title)]
        if subtitle:
            lines.append(self._wrap(subtitle))
        lines.extend([border, fmt_row([str(column) for column in columns]), border])
        for row in normalized_rows:
            lines.append(fmt_row(row))
        lines.append(border)
        return "\n".join(lines)

    def _compact_value(self, value: Any) -> str:
        normalized = normalize_for_output(value, show_none=self.config.show_none)
        if isinstance(normalized, Mapping):
            parts = []
            for idx, (key, item) in enumerate(normalized.items()):
                if idx >= self.config.compact_list_limit:
                    parts.append("…")
                    break
                parts.append(f"{key}={self._compact_value(item)}")
            return "{" + ", ".join(parts) + "}"
        if isinstance(normalized, Sequence) and not isinstance(normalized, (str, bytes, bytearray)):
            parts = [self._compact_value(item) for item in normalized[: self.config.compact_list_limit]]
            if len(normalized) > self.config.compact_list_limit:
                parts.append("…")
            return "[" + ", ".join(parts) + "]"
        return self._stringify_cell(normalized)

    def _stringify_cell(self, value: Any) -> str:
        if value is None:
            return "null"
        if isinstance(value, bool):
            return "true" if value else "false"
        if isinstance(value, (int, float)):
            return str(value)
        if isinstance(value, str):
            return value
        return json.dumps(normalize_for_output(value, show_none=self.config.show_none), ensure_ascii=False, sort_keys=self.config.sort_keys)

    def _format_value_lines(self, value: Any, *, available: int) -> list[str]:
        normalized = normalize_for_output(value, show_none=self.config.show_none)
        if isinstance(normalized, Mapping):
            text = json.dumps(normalized, ensure_ascii=False, sort_keys=self.config.sort_keys)
            return wrap_lines(text, width=min(available, self.config.max_value_width))
        if isinstance(normalized, Sequence) and not isinstance(normalized, (str, bytes, bytearray)):
            if not normalized:
                return ["[]"]
            rendered: list[str] = []
            for idx, item in enumerate(normalized):
                prefix = f"[{idx}] "
                item_lines = wrap_lines(self._compact_value(item), width=max(8, available - len(prefix)))
                rendered.append(prefix + item_lines[0])
                for continuation in item_lines[1:]:
                    rendered.append(" " * len(prefix) + continuation)
            return rendered
        return wrap_lines(self._stringify_cell(normalized), width=min(available, self.config.max_value_width))

    def _banner(self, title: str, tone: Tone = Tone.neutral) -> str:
        bar = "=" * min(max(len(title), 12), max(12, (self.config.width or 80) // 2))
        colored = colorize(title, tone, enabled=self.config.color)
        return f"{colored}\n{bar}"

    def _wrap(self, text: str, *, indent: int = 0) -> str:
        width = max(20, (self.config.width or 100) - indent)
        return textwrap.fill(text, width=width, subsequent_indent=" " * indent)


def normalize_for_output(value: Any, *, show_none: bool = False) -> Any:
    if value is None:
        return None if show_none else None
    if isinstance(value, (str, int, float, bool)):
        return value
    if hasattr(value, "model_dump") and callable(getattr(value, "model_dump")):
        return normalize_for_output(value.model_dump(mode="python", by_alias=True), show_none=show_none)
    if hasattr(value, "to_dict") and callable(getattr(value, "to_dict")):
        return normalize_for_output(value.to_dict(), show_none=show_none)
    if isinstance(value, Mapping):
        normalized: dict[str, Any] = {}
        for key, item in value.items():
            rendered = normalize_for_output(item, show_none=show_none)
            if rendered is None and not show_none:
                continue
            normalized[str(key)] = rendered
        return normalized
    if isinstance(value, (list, tuple, set, frozenset)):
        normalized_items = [normalize_for_output(item, show_none=show_none) for item in value]
        return [item for item in normalized_items if item is not None or show_none]
    if hasattr(value, "__dict__"):
        return normalize_for_output(vars(value), show_none=show_none)
    return str(value)


def infer_tone_from_key_value(key: str, value: Any) -> Tone:
    lower_key = key.lower()
    text_value = str(value).lower() if value is not None else ""

    if any(token in lower_key for token in ["error", "failed", "fatal", "blocked"]):
        return Tone.danger
    if any(token in lower_key for token in ["warning", "degraded", "stale"]):
        return Tone.warning
    if any(token in lower_key for token in ["ok", "passed", "ready", "healthy", "allowed"]):
        return Tone.success

    if text_value in {"failed", "fatal", "blocked", "false"}:
        return Tone.danger
    if text_value in {"warning", "degraded", "stale", "pending"}:
        return Tone.warning
    if text_value in {"passed", "ready", "healthy", "allow", "allowed", "true"}:
        return Tone.success
    if text_value in {"info", "informative", "connected", "running"}:
        return Tone.info
    if text_value in {"none", "null", "unknown", "unset"}:
        return Tone.muted
    return Tone.neutral


def colorize(text: str, tone: Tone, *, enabled: bool) -> str:
    if not enabled:
        return text
    color_code = {
        Tone.neutral: "37",
        Tone.success: "32",
        Tone.warning: "33",
        Tone.danger: "31",
        Tone.info: "36",
        Tone.muted: "90",
    }[tone]
    return f"\x1b[{color_code}m{text}\x1b[0m"


def truncate_text(text: str, width: int) -> str:
    if width <= 0:
        return ""
    if len(text) <= width:
        return text
    if width <= 1:
        return text[:width]
    return text[: width - 1] + "…"


def wrap_lines(text: str, *, width: int) -> list[str]:
    if width <= 4:
        return [text]
    wrapped = textwrap.wrap(text, width=width, replace_whitespace=False, drop_whitespace=False)
    return wrapped or [""]


def _detect_terminal_width() -> int:
    try:
        return shutil.get_terminal_size((100, 24)).columns
    except OSError:
        return 100


def make_formatter(
    *,
    mode: OutputMode = OutputMode.text,
    width: int | None = None,
    color: bool = True,
    indent: int = 2,
    sort_keys: bool = True,
    max_value_width: int = 96,
    compact_list_limit: int = 8,
    show_none: bool = False,
) -> Formatter:
    return Formatter(
        FormatConfig(
            mode=mode,
            width=width or _detect_terminal_width(),
            color=color,
            indent=indent,
            sort_keys=sort_keys,
            max_value_width=max_value_width,
            compact_list_limit=compact_list_limit,
            show_none=show_none,
        )
    )


def render_payload(
    payload: Any,
    *,
    title: str | None = None,
    subtitle: str | None = None,
    mode: OutputMode = OutputMode.text,
    width: int | None = None,
    color: bool = True,
) -> str:
    formatter = make_formatter(mode=mode, width=width, color=color)
    return formatter.render(payload, title=title, subtitle=subtitle).text


def render_table(
    title: str,
    columns: Sequence[str],
    rows: Iterable[Sequence[Any]],
    *,
    subtitle: str | None = None,
    mode: OutputMode = OutputMode.text,
    width: int | None = None,
    color: bool = True,
) -> str:
    formatter = make_formatter(mode=mode, width=width, color=color)
    return formatter.render_table(title, columns, rows, subtitle=subtitle).text


def render_sections(
    sections: Sequence[Section],
    *,
    title: str | None = None,
    mode: OutputMode = OutputMode.text,
    width: int | None = None,
    color: bool = True,
) -> str:
    formatter = make_formatter(mode=mode, width=width, color=color)
    return formatter.render_sections(sections, title=title).text
