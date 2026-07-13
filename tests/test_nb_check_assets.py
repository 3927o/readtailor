#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from collections import Counter
from pathlib import Path

from bs4 import BeautifulSoup

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))

from nb_check import AssetChecker, EpubBaseline, FidelityChecker


class FakeBaseline:
    def __init__(self, image_bytes: bytes):
        self.image_hash = hashlib.md5(image_bytes).hexdigest()

    def image_refs(self):
        return Counter({self.image_hash: 1}), {self.image_hash: ["chapter.xhtml"]}


def soup_with_image(src: str) -> BeautifulSoup:
    return BeautifulSoup(f'<html><body><img src="{src}"></body></html>', "html.parser")


class AssetCheckerTests(unittest.TestCase):
    def test_cli_writes_machine_readable_problem_levels(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            product = root / "book.normalized.html"
            report = root / "report.json"
            product.write_text("<html><body>invalid</body></html>", encoding="utf-8")

            completed = subprocess.run(
                [
                    sys.executable,
                    str(Path(__file__).resolve().parents[1] / "tools" / "nb_check.py"),
                    str(product),
                    "--json-report",
                    str(report),
                ],
                check=False,
                capture_output=True,
                text=True,
            )
            payload = json.loads(report.read_text(encoding="utf-8"))

            self.assertEqual(completed.returncode, 1)
            self.assertEqual(payload["version"], "nb-check-1.0")
            self.assertGreater(payload["totals"]["errors"], 0)
            self.assertIn("errors", payload["sections"]["structure"])
            self.assertFalse(payload["sections"]["fidelity"]["verified"])

    def test_existing_asset_passes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "assets").mkdir()
            (root / "assets" / "a.png").write_bytes(b"image")
            product = root / "book.normalized.html"
            product.write_text("", encoding="utf-8")

            checker = AssetChecker(soup_with_image("assets/a.png"), str(product))
            checker.run()

            self.assertEqual(checker.errors, [])
            self.assertEqual(checker.metrics["asset_references"], 1)
            self.assertEqual(checker.metrics["asset_files"], 1)

    def test_missing_asset_fails(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            product = Path(tmp) / "book.normalized.html"
            product.write_text("", encoding="utf-8")

            checker = AssetChecker(soup_with_image("assets/missing.png"), str(product))
            checker.run()

            self.assertTrue(any("[资源缺失]" in error for error in checker.errors))

    def test_image_hash_matches_epub_baseline(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "assets").mkdir()
            image_bytes = b"same-image"
            (root / "assets" / "a.png").write_bytes(image_bytes)

            checker = FidelityChecker(
                soup_with_image("assets/a.png"),
                FakeBaseline(image_bytes),
                root,
            )
            checker.check_image_recall()

            self.assertEqual(checker.errors, [])
            self.assertEqual(checker.warnings, [])

    def test_image_hash_mismatch_fails(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "assets").mkdir()
            (root / "assets" / "a.png").write_bytes(b"different-image")

            checker = FidelityChecker(
                soup_with_image("assets/a.png"),
                FakeBaseline(b"source-image"),
                root,
            )
            checker.check_image_recall()

            self.assertTrue(any("[图片丢失]" in error for error in checker.errors))


class FidelityTextDiffTests(unittest.TestCase):
    def test_endnote_reordering_is_reported_but_does_not_block(self) -> None:
        baseline = EpubBaseline.__new__(EpubBaseline)
        baseline._docs = [
            (
                "chapter.xhtml",
                BeautifulSoup(
                    '<body><p>正文<a epub:type="noteref" href="#n1">[1]</a></p></body>',
                    "html.parser",
                ),
            ),
            (
                "notes.xhtml",
                BeautifulSoup(
                    '<body><section epub:type="rearnotes">'
                    '<aside epub:type="rearnote"><p>'
                    '<a epub:type="noteref" href="chapter.xhtml">[1]</a>注一</p></aside>'
                    '<aside epub:type="rearnote"><p>注二</p></aside>'
                    "</section></body>",
                    "html.parser",
                ),
            ),
            ("afterword.xhtml", BeautifulSoup("<body><p>译后记</p></body>", "html.parser")),
        ]

        self.assertEqual(baseline.visible_text(), "正文[1][1]注一注二译后记")
        self.assertEqual(baseline.note_counts(), (1, 2))

        product = BeautifulSoup(
            '<body><main><section data-role="bodymatter"><p>正文[1]</p></section>'
            '<section data-role="backmatter"><p>译后记</p></section>'
            '<section data-role="notes"><div data-role="note"><p>注一</p></div>'
            '<div data-role="note"><p>注二</p></div></section></main></body>',
            "html.parser",
        )
        checker = FidelityChecker(product, baseline, Path("."))
        checker.check_char_recall()

        self.assertEqual(checker.errors, [])
        self.assertLess(checker.metrics["char_recall"], 1.0)
        self.assertEqual(checker.metrics["char_recall_gate"], "advisory")
        self.assertTrue(any("非阻断" in warning for warning in checker.warnings))


if __name__ == "__main__":
    unittest.main()
