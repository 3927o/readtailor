from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

from bs4 import BeautifulSoup


ROOT = Path(__file__).resolve().parents[1]
TOOLS = ROOT / "tools"
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from nb_linter import NbBookLinter  # noqa: E402
from normalize_fixed_epub import FixedEpubNormalizer  # noqa: E402


class NormalizeFixedEpubTests(unittest.TestCase):
    fixture = ROOT / "fixtures" / "fixed_input.epub"

    def normalize(self, output_dir: Path) -> dict[str, object]:
        return FixedEpubNormalizer(self.fixture, output_dir).normalize()

    def test_generates_deterministic_nb_package(self) -> None:
        with tempfile.TemporaryDirectory() as first_tmp, tempfile.TemporaryDirectory() as second_tmp:
            first = Path(first_tmp)
            second = Path(second_tmp)
            first_report = self.normalize(first)
            second_report = self.normalize(second)

            self.assertEqual(
                (first / "book.normalized.html").read_bytes(),
                (second / "book.normalized.html").read_bytes(),
            )
            self.assertEqual(
                (first / "normalization_report.json").read_bytes(),
                (second / "normalization_report.json").read_bytes(),
            )
            self.assertEqual(
                (first / "metadata.json").read_bytes(),
                (second / "metadata.json").read_bytes(),
            )
            self.assertEqual(first_report, second_report)
            self.assertEqual(
                (first / "assets" / "image00335.jpeg").read_bytes(),
                (second / "assets" / "image00335.jpeg").read_bytes(),
            )
            self.assertEqual(
                (first / "assets" / "cover00336.jpeg").read_bytes(),
                (second / "assets" / "cover00336.jpeg").read_bytes(),
            )

    def test_preserves_fixture_contract_and_passes_linter(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp)
            self.normalize(output)
            html = (output / "book.normalized.html").read_text(encoding="utf-8")
            soup = BeautifulSoup(html, "html.parser")
            report = json.loads((output / "normalization_report.json").read_text(encoding="utf-8"))
            metadata = json.loads((output / "metadata.json").read_text(encoding="utf-8"))

            self.assertEqual(len(soup.select('[data-role="noteref"]')), 1377)
            self.assertEqual(len(soup.select('[data-role="backref"]')), 1377)
            self.assertEqual(len(soup.select('[data-role="note"]')), 1377)
            self.assertEqual(len(soup.select('nav[data-role="toc"] a')), 91)
            self.assertEqual(len(soup.select('section#frontmatter nav')), 0)
            self.assertEqual(len(soup.find_all("img")), 1)
            self.assertEqual(soup.find("img")["src"], "assets/image00335.jpeg")
            self.assertTrue((output / "assets" / "image00335.jpeg").is_file())
            self.assertEqual(report["source"]["noterefs"], 2754)
            self.assertEqual(report["output"]["noterefs"], 1377)
            self.assertEqual(report["output"]["backrefs"], 1377)
            self.assertEqual(report["output"]["broken_internal_links"], 0)
            self.assertEqual(report["output"]["notes"], 1377)
            self.assertNotIn("metadata", report)
            self.assertEqual(metadata["title"], "查拉图斯特拉如是说")
            self.assertEqual(metadata["authors"], ["弗里德里希·尼采"])
            self.assertEqual(metadata["language"], "zh")
            self.assertEqual(metadata["cover_path"], "assets/cover00336.jpeg")
            self.assertEqual(metadata["identifiers"]["isbn"], "9787553518329")
            self.assertEqual(metadata["source_filename"], self.fixture.name)

            ids = [node["id"] for node in soup.find_all(id=True)]
            self.assertEqual(len(ids), len(set(ids)))
            self.assertFalse(soup.find(["script", "style", "iframe", "object", "embed", "b", "i"] ))
            self.assertFalse(soup.find(style=True))
            self.assertFalse(soup.find(attrs={"epub:type": True}))
            self.assertFalse(soup.select('[data-broken="true"]'))

            book = soup.select_one('section#bodymatter > section[data-type="book"]')
            self.assertIsNotNone(book)
            parts = book.find_all("section", attrs={"data-type": "part"}, recursive=False)
            self.assertEqual([part["id"] for part in parts], [
                "body-part0006",
                "body-part0030",
                "body-part0053",
                "body-part0070",
            ])
            self.assertEqual([part.find(recursive=False).name for part in parts], ["h2"] * 4)
            self.assertEqual(
                [len(part.find_all("section", attrs={"data-type": "chapter"}, recursive=False)) for part in parts],
                [2, 22, 16, 20],
            )
            sermon = soup.select_one('section#body-part0008[data-type="chapter"]')
            self.assertEqual(
                len(sermon.find_all("section", attrs={"data-type": "section"}, recursive=False)),
                22,
            )
            self.assertEqual(sermon.find(recursive=False).name, "h3")
            self.assertEqual(sermon.find("section", recursive=False).find(recursive=False).name, "h4")

            result = NbBookLinter(html).run_all_checks()
            self.assertEqual(result["errors"], [], "\n".join(result["errors"]))


if __name__ == "__main__":
    unittest.main()
