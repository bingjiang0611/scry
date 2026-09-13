"""Offline regression checks for registry recovery: no login, network or publish."""
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import preflight


class RegistryRecoveryTests(unittest.TestCase):
    def verify(self, exact, latest):
        with patch.object(preflight, "npm_view_version", side_effect=[exact, latest]), \
                patch.object(preflight, "command", side_effect=AssertionError("mutation attempted")):
            return preflight.ensure_registry_version(Path("/fixture/scry"), "1.2.3")

    def test_exact_version_with_lagging_tag_needs_no_write(self):
        result = self.verify(("published", "1.2.3"), ("published", "1.2.2"))
        self.assertEqual(result["action"], "exact-available")
        self.assertIsNone(result["releaseGate"])

    def test_current_version_needs_no_write(self):
        self.assertEqual(self.verify(("published", "1.2.3"), ("published", "1.2.3"))["action"], "already-current")

    def test_missing_version_requires_separate_authorized_release(self):
        with self.assertRaisesRegex(preflight.RegistryPublicationRequired, "No release or dist-tag write"):
            self.verify(("absent", None), ("published", "1.2.2"))

    def test_unknown_or_newer_registry_still_fails_closed(self):
        for exact, latest in [
            (("unavailable", None), ("published", "1.2.3")),
            (("published", "1.2.3"), ("unavailable", None)),
            (("published", "1.2.3"), ("published", "1.2.4")),
        ]:
            with self.subTest(exact=exact, latest=latest), self.assertRaises(RuntimeError):
                self.verify(exact, latest)

    def test_missing_package_is_not_retried_or_installed(self):
        state = {"ok": False, "failures": [{"name": "version.installed_cli"}],
                 "versions": {"scry": {"package": "1.2.3"}}}
        with tempfile.TemporaryDirectory() as tmp, \
                patch.object(preflight, "inspect", return_value=state), \
                patch.object(preflight, "ensure_registry_version",
                             side_effect=preflight.RegistryPublicationRequired("missing exact version")) as registry, \
                patch.object(preflight, "ensure_installed_recorder") as install:
            result = preflight.reconcile_environment("codex", Path(tmp), Path(tmp), Path(tmp) / "recovery.json")
        self.assertFalse(result["ok"])
        self.assertEqual(registry.call_count, 1)
        install.assert_not_called()
        self.assertEqual(result["recovery"]["attempts"][0]["status"], "REQUIRES_AUTHORIZED_RELEASE")


if __name__ == "__main__":
    unittest.main()
