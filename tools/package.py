#!/usr/bin/env python3
"""Validate and reproducibly package the k-deal-skill distribution."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import re
import sys
import zipfile

ROOT = Path(__file__).resolve().parents[1]
PLUGIN = ROOT / "plugins" / "k-deal-skill"
SKILLS = {"korean-dart-research", "krx-market-data", "korean-law-search", "korean-public-data"}
SKIP_PARTS = {"__pycache__", ".git", "dist", ".cache", ".pytest_cache"}
FORBIDDEN_NAMES = {".env", ".mcp.json", "mcp.json", "config.toml", ".DS_Store"}


def read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def files_in(root: Path):
    for path in sorted(root.rglob("*")):
        relative = path.relative_to(root)
        if any(part in SKIP_PARTS for part in relative.parts) or path.suffix == ".pyc":
            continue
        if path.is_symlink():
            raise ValueError(f"Symlink is not allowed: {relative}")
        if path.is_file():
            if path.name in FORBIDDEN_NAMES or path.name.startswith(".env.") or ".sqlite" in path.name:
                raise ValueError(f"Private or desktop-only file in distribution: {relative}")
            yield path


def validate_plugin(root: Path):
    portable = read_json(root / "plugin.json")
    compat = read_json(root / ".claude-plugin" / "plugin.json")
    if portable.get("name") != "k-deal-skill" or not re.fullmatch(r"\d+\.\d+\.\d+", portable.get("version", "")):
        raise ValueError("Invalid plugin identity/version")
    if any(compat.get(k) != portable.get(k) for k in ("name", "version")):
        raise ValueError("Claude and portable identities differ")
    if portable.get("$schema") != "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json":
        raise ValueError("Unexpected portable schema")
    found = {p.name for p in (root / "skills").iterdir() if p.is_dir() and p.name not in SKIP_PARTS}
    if found != SKILLS:
        raise ValueError(f"Expected four skills, found: {sorted(found)}")
    for name in sorted(SKILLS):
        path = root / "skills" / name / "SKILL.md"
        body = path.read_text(encoding="utf-8")
        match = re.match(r"\A---\s*\n(.*?)\n---\s*\n", body, re.S)
        if not match or not re.search(rf"^name:\s*[\"']?{re.escape(name)}[\"']?\s*$", match.group(1), re.M):
            raise ValueError(f"Invalid skill frontmatter: {name}")
        if not re.search(r"^description:\s*\S", match.group(1), re.M):
            raise ValueError(f"Missing description: {name}")
        for target in re.findall(r"\]\(([^)]+)\)", body):
            if re.match(r"[a-z]+:", target) or target.startswith("#"):
                continue
            dest = (path.parent / target.split("#", 1)[0]).resolve()
            if not dest.is_relative_to(root.resolve()) or not dest.exists():
                raise ValueError(f"Unresolved relative link: {name}: {target}")
    if portable.get("extensions", {}).get("com.openai", {}).get("apps"):
        raise ValueError("Local skill package must not bind hosted apps")
    for path in files_in(root):
        if path.suffix in {".py", ".md", ".json", ".yaml", ".yml"}:
            content = path.read_text(encoding="utf-8")
            if re.search(r"/Users/[^/]+/|[A-Za-z]:\\Users\\", content):
                raise ValueError(f"Personal absolute path: {path.relative_to(root)}")
            if re.search(r"sk-proj-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9]{20,}", content):
                raise ValueError(f"Credential-like value: {path.relative_to(root)}")
    return portable


def write_zip(destination: Path, entries):
    destination.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for name, data in sorted(entries):
            info = zipfile.ZipInfo(name, date_time=(2026, 10, 22, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            zf.writestr(info, data)
    with zipfile.ZipFile(destination) as zf:
        if zf.testzip():
            raise ValueError("ZIP CRC validation failed")
        names = zf.namelist()
        if len(names) != len(set(names)) or any(n.startswith("/") or ".." in Path(n).parts for n in names):
            raise ValueError("Unsafe archive path")
    return {"file": destination.name, "bytes": destination.stat().st_size,
            "sha256": hashlib.sha256(destination.read_bytes()).hexdigest(), "entries": len(names)}


def main():
    manifest = validate_plugin(PLUGIN)
    marketplace = read_json(ROOT / ".agents/plugins/marketplace.json")
    entry = marketplace["plugins"][0]
    if entry["name"] != manifest["name"] or entry["source"] != {"source": "local", "path": "./plugins/k-deal-skill"}:
        raise ValueError("Invalid workspace marketplace reference")
    claude = read_json(ROOT / ".claude-plugin/marketplace.json")["plugins"][0]
    if claude["source"] != "./plugins/k-deal-skill" or claude["version"] != manifest["version"]:
        raise ValueError("Invalid Claude marketplace reference")
    dist = ROOT / "dist"
    version = manifest["version"]
    plugin_zip = write_zip(dist / f"k-deal-skill-{version}.zip", ((p.relative_to(PLUGIN).as_posix(), p.read_bytes()) for p in files_in(PLUGIN)))
    root_entries = []
    allowed = {".agents", ".claude-plugin", ".github", "plugins", "tools", "tests", "docs"}
    for p in files_in(ROOT):
        rel = p.relative_to(ROOT)
        if rel.parts[0] in allowed or rel.as_posix() in {"README.md", ".gitignore"}:
            root_entries.append((rel.as_posix(), p.read_bytes()))
    source_zip = write_zip(dist / f"k-deal-skill-marketplace-{version}.zip", root_entries)
    artifacts = [plugin_zip, source_zip]
    report = {"plugin": manifest["name"], "version": version, "skills": sorted(SKILLS),
              "validation": "passed", "mcp_servers_bundled": False,
              "api_credentials_bundled": False, "databases_bundled": False,
              "workspace_import": "not_checked_by_build", "workspace_api_key_setup": "not_checked_by_build",
              "artifacts": artifacts}
    (dist / "build-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (dist / "SHA256SUMS.txt").write_text("".join(f"{a['sha256']}  {a['file']}\n" for a in artifacts), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, KeyError) as exc:
        print(f"Package validation failed: {exc}", file=sys.stderr)
        raise SystemExit(1) from None
