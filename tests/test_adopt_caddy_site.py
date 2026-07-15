from __future__ import annotations

import importlib.util
import os
import stat
import tempfile
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPT_PATH = REPO_ROOT / "deploy/scripts/adopt-caddy-site.py"
SPEC = importlib.util.spec_from_file_location("adopt_caddy_site", SCRIPT_PATH)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class AdoptCaddySiteTest(unittest.TestCase):
    def test_removes_only_matching_site_when_comments_contain_braces(self) -> None:
        lines = [
            "https://narcissus.life {\n",
            "\trespond ok\n",
            "}\n",
            "\n",
            "https://readtailor.narcissus.life {\n",
            "\t# literal example: {\n",
            "\trespond `body with\n",
            "}\n",
            "still body`\n",
            "\trespond <<BODY\n",
            "{\n",
            "}\n",
            "BODY\n",
            "\ttry_files {path} /index.html\n",
            "\trespond foo}\n",
            "}\n",
            "\n",
            "https://pourlog.narcissus.life {\n",
            "\trespond ok\n",
            "}\n",
        ]

        updated = MODULE.remove_site_block(lines, "readtailor.narcissus.life")

        rendered = "".join(updated)
        self.assertIn("https://narcissus.life {", rendered)
        self.assertNotIn("https://readtailor.narcissus.life {", rendered)
        self.assertIn("https://pourlog.narcissus.life {", rendered)

    def test_rejects_duplicate_matching_sites(self) -> None:
        with self.assertRaisesRegex(ValueError, "multiple Caddy site blocks"):
            MODULE.remove_site_block(
                [
                    "https://readtailor.narcissus.life {\n",
                    "}\n",
                    "https://readtailor.narcissus.life {\n",
                    "}\n",
                ],
                "readtailor.narcissus.life",
            )

    def test_rejects_unterminated_matching_site(self) -> None:
        with self.assertRaisesRegex(ValueError, "unterminated site block"):
            MODULE.remove_site_block(
                ["https://readtailor.narcissus.life {\n", "\trespond ok\n"],
                "readtailor.narcissus.life",
            )

    def test_atomic_replacement_preserves_mode(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            config = Path(temporary) / "Caddyfile"
            config.write_text("https://example.com {\n\trespond ok\n}\n", encoding="utf-8")
            os.chmod(config, 0o644)
            original_stat = config.stat()

            original_argv = MODULE.os.sys.argv
            MODULE.os.sys.argv = [
                str(SCRIPT_PATH),
                "--config",
                str(config),
                "--domain",
                "readtailor.narcissus.life",
                "--import-path",
                "/etc/caddy/sites-enabled/*.caddy",
            ]
            try:
                MODULE.main()
            finally:
                MODULE.os.sys.argv = original_argv

            self.assertEqual(stat.S_IMODE(config.stat().st_mode), 0o644)
            self.assertEqual(config.stat().st_uid, original_stat.st_uid)
            self.assertEqual(config.stat().st_gid, original_stat.st_gid)
            self.assertIn(
                "import /etc/caddy/sites-enabled/*.caddy",
                config.read_text(encoding="utf-8"),
            )


if __name__ == "__main__":
    unittest.main()
