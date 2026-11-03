from __future__ import annotations
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("kds_package", ROOT / "tools/package.py")
package = importlib.util.module_from_spec(spec)
spec.loader.exec_module(package)


class PackagingTests(unittest.TestCase):
    def test_archive_is_reproducible_and_preserves_hidden_manifest(self):
        with tempfile.TemporaryDirectory() as tmp:
            a, b = Path(tmp) / "a.zip", Path(tmp) / "b.zip"
            entries = [(".claude-plugin/plugin.json", b'{"name":"test"}'), ("skills/a/SKILL.md", b"test")]
            package.write_zip(a, entries)
            package.write_zip(b, reversed(entries))
            self.assertEqual(a.read_bytes(), b.read_bytes())
            with zipfile.ZipFile(a) as zf:
                self.assertIn(".claude-plugin/plugin.json", zf.namelist())

    def test_credentials_database_and_symlink_are_rejected(self):
        for name in (".env", "private.sqlite", ".mcp.json"):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as tmp:
                (Path(tmp) / name).write_text("do not package")
                with self.assertRaises(ValueError):
                    list(package.files_in(Path(tmp)))
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "link").symlink_to("/tmp")
            with self.assertRaises(ValueError):
                list(package.files_in(Path(tmp)))

    def test_actual_package_and_marketplace_references_resolve(self):
        manifest = package.validate_plugin(package.PLUGIN)
        self.assertEqual(manifest["name"], "k-deal-skill")
        catalog = json.loads((ROOT / ".agents/plugins/marketplace.json").read_text())
        target = ROOT / catalog["plugins"][0]["source"]["path"]
        self.assertEqual(target.resolve(), package.PLUGIN.resolve())
        self.assertNotIn("apps", manifest["extensions"]["com.openai"])


if __name__ == "__main__":
    unittest.main()
