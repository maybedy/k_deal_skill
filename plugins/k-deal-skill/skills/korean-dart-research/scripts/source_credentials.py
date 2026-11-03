"""Opt-in local credential resolution for k-deal-skill. Standard library only.

No configuration is discovered beyond the connection pointer created by the
explicit setup CLI. Secret values stay in process memory and never enter status.
Keep the three distributed copies byte-identical.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Mapping

try:
    import tomllib
except ModuleNotFoundError:  # Python 3.10 can still use env and project JSON.
    tomllib = None

DEFAULT_CONNECTION = Path.home() / ".config" / "k-deal-skill" / "connection.json"
GROUPS = {
    "dart": ("korea-stock-mcp", ("DART_API_KEY", "OPENDART_API_KEY")),
    "krx": ("korea-stock-mcp", ("KRX_API_KEY",)),
    "datago": ("datago", ("DATA_GO_KR_KEY_ENC", "DATA_GO_KR_KEY")),
}
MAX_CONFIG_BYTES = 8 * 1024 * 1024


class CredentialError(Exception):
    """Only fixed, non-sensitive messages may be displayed."""


class Resolution:
    def __init__(self, names, values=None, source="missing", notes=(), connection_used=False):
        self.values = dict(values or {})
        self.names = tuple(names)
        self.source = source
        self.notes = list(notes)
        self.connection_used = connection_used

    def status(self) -> dict:
        return {
            "credentials_present": {name: bool(self.values.get(name)) for name in self.names},
            "credential_sources": {name: self.source if self.values.get(name) else "missing" for name in self.names},
            "local_connection_used": self.connection_used,
            "credential_notes": self.notes,
        }


def _read_text(path: Path, label: str) -> str:
    try:
        with path.open("rb") as handle:
            raw = handle.read(MAX_CONFIG_BYTES + 1)
        if len(raw) > MAX_CONFIG_BYTES:
            raise CredentialError(f"{label} exceeds the configuration size limit.")
        return raw.decode("utf-8")
    except (OSError, UnicodeError, ValueError):
        raise CredentialError(f"{label} could not be read.") from None


def validate_connection_payload(payload: object) -> dict[str, Path]:
    allowed = {"schema_version", "mcp_json", "codex_config"}
    if (not isinstance(payload, dict) or set(payload) - allowed
            or type(payload.get("schema_version")) is not int or payload["schema_version"] != 1):
        raise CredentialError("Invalid k-deal-skill connection schema.")
    paths = {}
    for field in ("mcp_json", "codex_config"):
        if field not in payload:
            continue
        value = payload[field]
        if not isinstance(value, str) or not value or "\x00" in value:
            raise CredentialError("Invalid k-deal-skill connection path.")
        path = Path(value)
        if not path.is_absolute():
            raise CredentialError("k-deal-skill connection paths must be absolute.")
        paths[field] = path
    if not paths:
        raise CredentialError("k-deal-skill connection contains no source configuration.")
    return paths


def read_connection(path: Path) -> dict[str, Path] | None:
    try:
        exists = path.exists()
    except OSError:
        raise CredentialError("k-deal-skill connection could not be inspected.") from None
    if not exists:
        return None
    try:
        payload = json.loads(_read_text(path, "k-deal-skill connection"))
    except (ValueError, TypeError):
        raise CredentialError("Invalid k-deal-skill connection JSON.") from None
    return validate_connection_payload(payload)


def _server_env(payload: object, root: str, server: str) -> Mapping:
    if not isinstance(payload, dict):
        raise CredentialError("MCP configuration has an invalid root.")
    servers = payload.get(root, {})
    if not isinstance(servers, dict):
        raise CredentialError("MCP server configuration has an invalid shape.")
    entry = servers.get(server)
    if entry is None:
        return {}
    if not isinstance(entry, dict) or not isinstance(entry.get("env", {}), dict):
        raise CredentialError("Registered MCP environment has an invalid shape.")
    return entry.get("env", {})


def _allowed_values(env: Mapping, names: tuple[str, ...]) -> dict[str, str]:
    return {name: value.strip() for name in names
            if isinstance(value := env.get(name), str) and value.strip()}


def resolve(service: str, environ: Mapping[str, str] | None = None,
            connection_path: Path | str | None = None) -> Resolution:
    if service not in GROUPS:
        raise CredentialError("Unsupported k-deal-skill credential service.")
    server, names = GROUPS[service]
    env = os.environ if environ is None else environ
    values = _allowed_values(env, names)
    # Treat aliases as one credential: explicit OPENDART/decoded data.go values
    # must not be shadowed by a preferred-name value in a lower-priority source.
    if values:
        return Resolution(names, values, "environment")
    paths = read_connection(Path(connection_path) if connection_path is not None else DEFAULT_CONNECTION)
    if paths is None:
        return Resolution(names, notes=("local_bridge_not_configured",))
    notes = []
    if "codex_config" in paths:
        if tomllib is None:
            # Never read TOML without a supported parser, nor attempt regex parsing.
            notes.append("codex_toml_requires_python_3_11")
        else:
            try:
                payload = tomllib.loads(_read_text(paths["codex_config"], "Codex MCP configuration"))
            except ValueError:
                raise CredentialError("Invalid Codex MCP configuration TOML.") from None
            values = _allowed_values(_server_env(payload, "mcp_servers", server), names)
            if values:
                return Resolution(names, values, "codex_mcp_env", notes, True)
    if "mcp_json" in paths:
        try:
            payload = json.loads(_read_text(paths["mcp_json"], "Project MCP configuration"))
        except (ValueError, TypeError):
            raise CredentialError("Invalid project MCP configuration JSON.") from None
        values = _allowed_values(_server_env(payload, "mcpServers", server), names)
        if values:
            return Resolution(names, values, "project_mcp_env", notes, True)
    return Resolution(names, notes=notes + ["registered_mcp_credential_missing"], connection_used=True)


def missing_message(resolution: Resolution, variable_names: str) -> str:
    message = f"No usable {variable_names} credential was found in the environment or opted-in MCP configuration."
    if "codex_toml_requires_python_3_11" in resolution.notes:
        message += " Reading Codex TOML requires Python 3.11 or newer."
    return message

