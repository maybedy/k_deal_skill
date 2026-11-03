#!/usr/bin/env python3
"""Explicitly connect existing local MCP configuration by path, without copying keys."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile

MODULE_PATH = Path(__file__).resolve().parents[1] / "plugins/k-deal-skill/skills/korean-dart-research/scripts/source_credentials.py"
_spec = importlib.util.spec_from_file_location("kds_connection_credentials", MODULE_PATH)
credentials = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(credentials)


def write_connection(mcp_json: str | None, codex_config: str | None, output: str | Path | None = None) -> dict:
    if not mcp_json and not codex_config:
        raise credentials.CredentialError("Supply --mcp-json, --codex-config, or both.")
    payload = {"schema_version": 1}
    for field, supplied in (("mcp_json", mcp_json), ("codex_config", codex_config)):
        if supplied:
            try:
                path = Path(supplied).expanduser().resolve(strict=True)
                if not path.is_file():
                    raise OSError()
            except (OSError, ValueError, RuntimeError):
                raise credentials.CredentialError("A supplied MCP configuration is not an accessible local file.") from None
            payload[field] = str(path)
    # This validates paths only; setup does not open or copy source credentials.
    paths = credentials.validate_connection_payload(payload)
    target = Path(output).expanduser() if output is not None else credentials.DEFAULT_CONNECTION
    try:
        target = target.resolve()
        if target in paths.values():
            raise credentials.CredentialError("Connection output must not replace an MCP source configuration.")
        backup = None
        if target.exists():
            # Reject unknown payloads before making a backup: backup only our
            # path-only schema, never an arbitrary file containing secrets.
            credentials.read_connection(target)
            stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
            backup = target.with_name(f"{target.name}.{stamp}.bak")
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        if backup is not None:
            shutil.copy2(target, backup)
            backup.chmod(0o600)
        temporary = None
        try:
            with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=target.parent, prefix=".connection-", suffix=".tmp", delete=False) as handle:
                temporary = Path(handle.name)
                os.chmod(temporary, 0o600)
                handle.write(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, target)
            temporary = None
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
    except (OSError, ValueError):
        raise credentials.CredentialError("The local connection file could not be saved.") from None
    return {"status": "configured", "connection_file": str(target), "backup_file": str(backup) if backup else None,
            "source_paths": {name: str(path) for name, path in paths.items()}, "secret_values_copied": False}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Opt in to reusing credentials from specific existing local MCP configuration files. Stores paths only.")
    parser.add_argument("--mcp-json", help="Exact local project MCP JSON file.")
    parser.add_argument("--codex-config", help="Exact local Codex config.toml file.")
    parser.add_argument("--output", help="Connection pointer destination; defaults to ~/.config/k-deal-skill/connection.json.")
    args = parser.parse_args(argv)
    try:
        result = write_connection(args.mcp_json, args.codex_config, args.output)
    except credentials.CredentialError as exc:
        print(json.dumps({"status": "error", "message": str(exc)}))
        return 2
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
