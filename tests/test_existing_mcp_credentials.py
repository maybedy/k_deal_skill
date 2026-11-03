"""Offline tests for explicit, path-only reuse of existing local MCP credentials."""
from contextlib import redirect_stdout
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SKILLS = ROOT / "plugins/k-deal-skill/skills"


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


resolver = load("test_kds_credentials", SKILLS / "korean-dart-research/scripts/source_credentials.py")
setup = load("test_kds_connect", ROOT / "tools/connect_existing_mcp.py")
dart = load("test_connected_dart", SKILLS / "korean-dart-research/scripts/dart_fetch.py")
krx = load("test_connected_krx", SKILLS / "krx-market-data/scripts/krx_fetch.py")
public = load("test_connected_public", SKILLS / "korean-public-data/scripts/api_fetch.py")


class ConnectionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.connection = self.root / "connection.json"
        self.project = self.root / "project.json"
        self.codex = self.root / "codex.toml"
        for module in (resolver, setup.credentials, dart.credentials, krx.credentials, public.credentials):
            pointer = patch.object(module, "DEFAULT_CONNECTION", self.connection)
            pointer.start()
            self.addCleanup(pointer.stop)
            original_read = module._read_text
            def guarded_read(path, label, read=original_read):
                if not path.resolve().is_relative_to(self.root.resolve()):
                    raise AssertionError("Credential tests may read only their temporary fixtures.")
                return read(path, label)
            guard = patch.object(module, "_read_text", side_effect=guarded_read)
            guard.start()
            self.addCleanup(guard.stop)

    def tearDown(self):
        self.temporary.cleanup()

    def pointer(self, **paths):
        self.connection.write_text(json.dumps({"schema_version": 1, **{name: str(path) for name, path in paths.items()}}))

    def project_config(self, stock=None, datago=None, unrelated=None):
        self.project.write_text(json.dumps({"mcpServers": {"korea-stock-mcp": {"env": stock or {}}, "datago": {"env": datago or {}}, "unrelated": {"env": unrelated or {}}}}))

    def test_no_opt_in_means_no_source_file_reads(self):
        self.project_config(stock={"DART_API_KEY": "not-authorized"})
        with patch.object(Path, "open", side_effect=AssertionError("No files may be opened")):
            resolved = resolver.resolve("dart", environ={}, connection_path=self.connection)
        self.assertFalse(any(resolved.status()["credentials_present"].values()))
        self.assertFalse(resolved.connection_used)

    def test_explicit_alias_credentials_win_without_reading_even_malformed_opt_in(self):
        self.connection.write_text("not-json do-not-echo")
        for service, env in (("dart", {"OPENDART_API_KEY": "explicit-alias"}), ("datago", {"DATA_GO_KR_KEY": "explicit-decoded"}), ("krx", {"KRX_API_KEY": "explicit-krx"})):
            with self.subTest(service=service), patch.object(Path, "open", side_effect=AssertionError("Must not open configs")):
                resolved = resolver.resolve(service, environ=env, connection_path=self.connection)
            self.assertEqual(resolved.values, env)
            self.assertEqual(resolved.source, "environment")

    def test_codex_precedence_and_empty_value_project_fallback(self):
        self.project_config(stock={"DART_API_KEY": "project-dart", "KRX_API_KEY": "project-krx"}, datago={"DATA_GO_KR_KEY_ENC": "project-data"})
        self.codex.write_text('[mcp_servers.korea-stock-mcp.env]\nDART_API_KEY = "codex-dart"\nKRX_API_KEY = ""\n')
        self.pointer(mcp_json=self.project, codex_config=self.codex)
        d = resolver.resolve("dart", environ={}, connection_path=self.connection)
        k = resolver.resolve("krx", environ={}, connection_path=self.connection)
        p = resolver.resolve("datago", environ={}, connection_path=self.connection)
        self.assertEqual((d.values["DART_API_KEY"], d.source), ("codex-dart", "codex_mcp_env"))
        self.assertEqual((k.values["KRX_API_KEY"], k.source), ("project-krx", "project_mcp_env"))
        self.assertEqual((p.values["DATA_GO_KR_KEY_ENC"], p.source), ("project-data", "project_mcp_env"))

    def test_alias_family_does_not_mix_lower_priority_sources(self):
        self.project_config(stock={"DART_API_KEY": "project-dart"}, datago={"DATA_GO_KR_KEY_ENC": "project-encoded"})
        self.codex.write_text('[mcp_servers.korea-stock-mcp.env]\nOPENDART_API_KEY = "codex-alias"\n[mcp_servers.datago.env]\nDATA_GO_KR_KEY = "codex-decoded"\n')
        self.pointer(mcp_json=self.project, codex_config=self.codex)
        self.assertEqual(resolver.resolve("dart", environ={}, connection_path=self.connection).values, {"OPENDART_API_KEY": "codex-alias"})
        self.assertEqual(resolver.resolve("datago", environ={}, connection_path=self.connection).values, {"DATA_GO_KR_KEY": "codex-decoded"})

    def test_registered_server_and_key_allowlists_exclude_secondary_and_unrelated_keys(self):
        self.project_config(stock={"DART_API_KEY_2": "secondary-secret", "OTHER_KEY": "other-secret"}, unrelated={"DART_API_KEY": "wrong-server", "KRX_API_KEY": "wrong-server"})
        self.pointer(mcp_json=self.project)
        resolved = resolver.resolve("dart", environ={"DART_API_KEY_2": "env-secondary"}, connection_path=self.connection)
        self.assertEqual(resolved.values, {})
        status = json.dumps(resolved.status())
        for secret in ("secondary-secret", "other-secret", "wrong-server", "env-secondary"):
            self.assertNotIn(secret, status)

    def test_status_exposes_sources_and_booleans_only(self):
        self.project_config(stock={"DART_API_KEY": "sensitive-value"})
        self.pointer(mcp_json=self.project)
        resolved = resolver.resolve("dart", environ={}, connection_path=self.connection)
        status = resolved.status()
        self.assertTrue(status["credentials_present"]["DART_API_KEY"])
        self.assertEqual(status["credential_sources"]["DART_API_KEY"], "project_mcp_env")
        self.assertFalse(status["credentials_present"]["OPENDART_API_KEY"])
        self.assertNotIn("sensitive-value", json.dumps(status))
        self.assertNotIn("sensitive-value", repr(resolved))

    def test_malformed_pointer_is_safe_and_does_not_open_sources(self):
        for payload in ({"schema_version": 1, "mcp_json": "relative.json"}, {"schema_version": 1, "mcp_json": str(self.project), "DART_API_KEY": "do-not-echo"}, {"schema_version": True, "mcp_json": str(self.project)}, {"schema_version": 99, "mcp_json": str(self.project)}):
            with self.subTest(payload=payload):
                self.connection.write_text(json.dumps(payload))
                with self.assertRaises(resolver.CredentialError) as ctx:
                    resolver.resolve("dart", environ={}, connection_path=self.connection)
                self.assertNotIn("do-not-echo", str(ctx.exception))
        self.connection.write_text('{"DART_API_KEY":"unclosed-secret')
        with self.assertRaises(resolver.CredentialError) as ctx:
            resolver.resolve("dart", environ={}, connection_path=self.connection)
        self.assertNotIn("unclosed-secret", str(ctx.exception))

    def test_source_parse_errors_do_not_echo_key_or_source_contents(self):
        self.codex.write_text('DART_API_KEY = "secret-unterminated')
        self.pointer(codex_config=self.codex)
        with self.assertRaises(resolver.CredentialError) as ctx:
            resolver.resolve("dart", environ={}, connection_path=self.connection)
        self.assertNotIn("secret-unterminated", str(ctx.exception))
        self.project.write_text('{"api_key":"json-secret')
        self.pointer(mcp_json=self.project)
        with self.assertRaises(resolver.CredentialError) as ctx:
            resolver.resolve("dart", environ={}, connection_path=self.connection)
        self.assertNotIn("json-secret", str(ctx.exception))

    def test_python_310_skips_toml_without_reading_it_and_reports_limitation(self):
        self.project_config(stock={"DART_API_KEY": "project-fallback"})
        self.codex.write_text("must-not-read")
        self.pointer(mcp_json=self.project, codex_config=self.codex)
        original_read = resolver._read_text
        def read(path, label):
            self.assertNotEqual(path, self.codex)
            return original_read(path, label)
        with patch.object(resolver, "tomllib", None), patch.object(resolver, "_read_text", side_effect=read):
            resolved = resolver.resolve("dart", environ={}, connection_path=self.connection)
        self.assertEqual(resolved.values, {"DART_API_KEY": "project-fallback"})
        self.assertIn("codex_toml_requires_python_3_11", resolved.status()["credential_notes"])

    def test_setup_writes_only_paths_and_schema_without_reading_source_keys(self):
        self.project_config(stock={"DART_API_KEY": "never-copy-me"})
        self.codex.write_text('[mcp_servers.korea-stock-mcp.env]\nDART_API_KEY="never-copy-either"\n')
        with patch.object(setup.credentials, "_read_text", side_effect=AssertionError("No source reads at setup")):
            result = setup.write_connection(str(self.project), str(self.codex), self.connection)
        payload = json.loads(self.connection.read_text())
        self.assertEqual(payload, {"schema_version": 1, "mcp_json": str(self.project.resolve()), "codex_config": str(self.codex.resolve())})
        self.assertFalse(result["secret_values_copied"])
        self.assertNotIn("never-copy", self.connection.read_text())
        self.assertEqual(self.connection.stat().st_mode & 0o777, 0o600)

    def test_setup_backs_up_previous_valid_pointer_but_not_arbitrary_secret_file(self):
        self.project_config(stock={"DART_API_KEY": "existing-secret"})
        self.codex.write_text("# placeholder")
        setup.write_connection(str(self.project), None, self.connection)
        before = self.connection.read_text()
        result = setup.write_connection(str(self.project), str(self.codex), self.connection)
        backup = Path(result["backup_file"])
        self.assertEqual(backup.read_text(), before)
        self.assertRegex(backup.name, r"connection\.json\.\d{8}T\d{12}Z\.bak")
        self.assertNotIn("existing-secret", backup.read_text())
        self.connection.write_text('{"secret":"do-not-copy"}')
        backup_count = len(list(self.root.glob("*.bak")))
        with self.assertRaises(setup.credentials.CredentialError):
            setup.write_connection(str(self.project), None, self.connection)
        self.assertEqual(len(list(self.root.glob("*.bak"))), backup_count)

    def test_setup_cannot_overwrite_source_configuration(self):
        self.project_config(stock={"DART_API_KEY": "preserve"})
        original = self.project.read_bytes()
        with self.assertRaises(setup.credentials.CredentialError):
            setup.write_connection(str(self.project), None, self.project)
        self.assertEqual(self.project.read_bytes(), original)

    def test_helpers_load_and_report_the_opted_in_connection(self):
        self.project_config(stock={"DART_API_KEY": "dart-dummy", "KRX_API_KEY": "krx-dummy"}, datago={"DATA_GO_KR_KEY": "public+dummy"})
        self.pointer(mcp_json=self.project)
        with patch.dict(os.environ, {}, clear=True), patch.object(dart.credentials, "DEFAULT_CONNECTION", self.connection), patch.object(krx.credentials, "DEFAULT_CONNECTION", self.connection), patch.object(public.credentials, "DEFAULT_CONNECTION", self.connection):
            self.assertEqual(dart.load_key(), "dart-dummy")
            self.assertEqual(krx.load_key(), "krx-dummy")
            self.assertEqual(public.encoded_key(), "public%2Bdummy")
            for module in (dart, krx):
                with redirect_stdout(io.StringIO()) as output:
                    self.assertEqual(module.main(["env-status"]), 0)
                result = json.loads(output.getvalue())
                self.assertTrue(any(result["credentials_present"].values()))
                self.assertIn("project_mcp_env", result["credential_sources"].values())
                self.assertNotIn("dummy", output.getvalue())
            status = public.status()
            self.assertTrue(status["credentials_present"]["DATA_GO_KR_KEY"])
            self.assertEqual(status["credential_sources"]["DATA_GO_KR_KEY"], "project_mcp_env")
            self.assertNotIn("dummy", json.dumps(status))

    def test_helpers_surface_malformed_connection_as_safe_errors(self):
        self.connection.write_text('{"DART_API_KEY":"sensitive')
        for module in (dart, krx):
            with self.subTest(module=module.__name__), patch.dict(os.environ, {}, clear=True), patch.object(module.credentials, "DEFAULT_CONNECTION", self.connection), redirect_stdout(io.StringIO()) as output:
                self.assertEqual(module.main(["env-status"]), 2)
            self.assertNotIn("sensitive", output.getvalue())
            self.assertEqual(json.loads(output.getvalue())["error"]["code"], "credential_configuration")
        with patch.object(public.credentials, "DEFAULT_CONNECTION", self.connection):
            with self.assertRaises(public.PublicDataError) as ctx:
                public.status(environ={})
        self.assertNotIn("sensitive", str(ctx.exception))

    def test_distributed_resolver_copies_are_identical(self):
        copies = [(SKILLS / name / "scripts/source_credentials.py").read_bytes() for name in ("korean-dart-research", "krx-market-data", "korean-public-data")]
        self.assertEqual(copies[0], copies[1])
        self.assertEqual(copies[1], copies[2])


if __name__ == "__main__":
    unittest.main()
