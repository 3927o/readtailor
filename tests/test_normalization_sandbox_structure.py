from __future__ import annotations

import json
import os
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
HELPER = REPO_ROOT / "tools" / "normalization_sandbox.py"


class NormalizationSandboxStructureTests(unittest.TestCase):
    def write(self, root: Path, relative: str, content: str | bytes) -> None:
        path = root / "source" / "unpacked" / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(content, bytes):
            path.write_bytes(content)
        else:
            path.write_text(textwrap.dedent(content).strip(), encoding="utf-8")

    def inspect(self, root: Path) -> dict[str, object]:
        completed = subprocess.run(
            ["python3", str(HELPER), "inspect-epub-structure"],
            cwd=REPO_ROOT,
            env={**os.environ, "READTAILOR_SANDBOX_ROOT": str(root)},
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        return json.loads(completed.stdout)

    def test_reports_package_spine_navigation_features_and_reference_issues(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.write(
                root,
                "META-INF/Container.XML",
                """
                <?xml version="1.0"?>
                <container xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
                  <rootfiles>
                    <rootfile full-path="OPS/package.opf"
                              media-type="application/oebps-package+xml"/>
                  </rootfiles>
                </container>
                """,
            )
            self.write(
                root,
                "OPS/package.opf",
                """
                <?xml version="1.0"?>
                <package xmlns="http://www.idpf.org/2007/opf" version="3.0"
                         unique-identifier="book-id">
                  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
                    <dc:identifier id="book-id">urn:test</dc:identifier>
                    <dc:title>Test Book</dc:title>
                    <dc:creator>Test Author</dc:creator>
                    <dc:language>en</dc:language>
                  </metadata>
                  <manifest>
                    <item id="chapter" href="Text/Chapter.xhtml" media-type="application/xhtml+xml"/>
                    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
                    <item id="style" href="styles/book.css" media-type="text/css"/>
                    <item id="image" href="Images/pic.png" media-type="image/png"/>
                    <item id="orphan" href="unused.bin" media-type="application/octet-stream"/>
                  </manifest>
                  <spine><itemref idref="chapter"/></spine>
                </package>
                """,
            )
            self.write(
                root,
                "OPS/text/chapter.xhtml",
                """
                <html xmlns="http://www.w3.org/1999/xhtml"
                      xmlns:epub="http://www.idpf.org/2007/ops">
                  <head><title>Chapter One</title><link rel="stylesheet" href="../styles/book.css"/></head>
                  <body>
                    <h1>Chapter One</h1><p>Hello world.</p>
                    <aside epub:type="footnote">A note.</aside>
                    <img src="../Images/PIC.PNG"/><img src="../Images/missing.png"/>
                    <table><tr><td>cell</td></tr></table><ruby>字<rt>zi</rt></ruby>
                  </body>
                </html>
                """,
            )
            self.write(
                root,
                "OPS/nav.xhtml",
                """
                <html xmlns="http://www.w3.org/1999/xhtml"
                      xmlns:epub="http://www.idpf.org/2007/ops">
                  <body><nav epub:type="toc"><ol><li><a href="text/chapter.xhtml">One</a></li></ol></nav></body>
                </html>
                """,
            )
            self.write(root, "OPS/styles/book.css", "body { background: url('../Images/pic.png'); }")
            self.write(root, "OPS/Images/pic.png", b"png")
            self.write(root, "OPS/unused.bin", b"unused")

            report = self.inspect(root)

            self.assertEqual(report["version"], "epub-structure-1.0")
            self.assertEqual(report["package"]["metadata"]["titles"], ["Test Book"])
            self.assertEqual(report["manifest"]["byCategory"]["documents"], 2)
            self.assertEqual(report["spine"]["total"], 1)
            fields = report["spine"]["entryFields"]
            row = dict(zip(fields, report["spine"]["items"][0]))
            self.assertEqual(row["path"], "OPS/text/chapter.xhtml")
            self.assertEqual(row["title"], "Chapter One")
            self.assertEqual(row["notes"], 1)
            self.assertEqual(row["tables"], 1)
            self.assertEqual(row["ruby"], 1)
            self.assertEqual(report["navigation"]["navTypes"], {"toc": 1})
            self.assertEqual(report["features"]["images"], 2)

            case_mismatches = report["issues"]["caseMismatches"]["items"]
            self.assertIn(
                {"expected": "META-INF/container.xml", "actual": "META-INF/Container.XML"},
                case_mismatches,
            )
            self.assertIn(
                {"expected": "OPS/Text/Chapter.xhtml", "actual": "OPS/text/chapter.xhtml"},
                case_mismatches,
            )
            self.assertIn(
                {"expected": "OPS/Images/PIC.PNG", "actual": "OPS/Images/pic.png"},
                case_mismatches,
            )
            self.assertIn(
                {"path": "OPS/Images/missing.png"},
                report["issues"]["missingReferences"]["items"],
            )
            self.assertIn(
                {"id": "orphan", "path": "OPS/unused.bin", "mediaType": "application/octet-stream"},
                report["issues"]["orphanedManifestItems"]["items"],
            )


if __name__ == "__main__":
    unittest.main()
