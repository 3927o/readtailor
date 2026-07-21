#!/usr/bin/env python3
from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

from bs4 import BeautifulSoup

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))

from build_reading_nodes import ReadingNodeBuilder, build_manifest, extract_blocks


class ReadingNodeBuilderTests(unittest.TestCase):
    def build(self, body: str):
        html = f"""<!doctype html><html lang="zh"><head><title>T</title></head><body>
        <main id="book" data-type="book">
          <section id="bodymatter" data-role="bodymatter">{body}</section>
        </main></body></html>"""
        builder = ReadingNodeBuilder(BeautifulSoup(html, "html.parser"))
        return builder.build()

    def test_leaf_subsections_remain_independent(self) -> None:
        nodes = self.build("""
          <section id="part-1" data-type="part"><h1>Part</h1>
            <section id="s-1" data-type="subsection"><h2>1</h2><p>alpha</p></section>
            <section id="s-2" data-type="subsection"><h2>2</h2><p>beta</p></section>
          </section>
        """)
        self.assertEqual([node.section_id for node in nodes], ["s-1", "s-2"])
        self.assertEqual([node.title for node in nodes], ["1", "2"])

    def test_parent_content_keeps_document_order_around_children(self) -> None:
        nodes = self.build("""
          <section id="chapter-1" data-type="chapter"><h1>Chapter</h1>
            <p>before</p>
            <section id="epigraph" data-type="epigraph"><p>quotation</p></section>
            <p>after</p>
          </section>
        """)
        self.assertEqual(
            [(node.section_id, node.segment) for node in nodes],
            [("chapter-1", 1), ("epigraph", 1), ("chapter-1", 2)],
        )
        self.assertEqual(
            [BeautifulSoup(node.content_html, "html.parser").get_text(strip=True) for node in nodes],
            ["before", "quotation", "after"],
        )

    def test_parent_and_child_content_do_not_overlap(self) -> None:
        nodes = self.build("""
          <section id="chapter-1" data-type="chapter"><h1>Chapter</h1>
            <p>intro</p>
            <section id="section-1" data-type="section"><h2>Section</h2><p>child</p></section>
          </section>
        """)
        parent, child = nodes
        self.assertIn("intro", parent.content_html)
        self.assertNotIn("child", parent.content_html)
        self.assertIn("child", child.content_html)

    def test_empty_grouping_section_is_not_a_node(self) -> None:
        nodes = self.build("""
          <section id="part-1" data-type="part"><h1>Part</h1>
            <section id="chapter-1" data-type="chapter"><h2>Chapter</h2><p>text</p></section>
          </section>
        """)
        self.assertEqual(len(nodes), 1)
        self.assertEqual(nodes[0].section_id, "chapter-1")

    def test_region_owned_unknown_content_is_preserved(self) -> None:
        nodes = self.build("""
          <div data-role="unknown" data-reason="publisher_notice"><p>notice</p></div>
          <section id="chapter-1" data-type="chapter"><h1>Chapter</h1><p>text</p></section>
        """)
        self.assertEqual(
            [(node.section_id, node.data_type) for node in nodes],
            [("bodymatter", "bodymatter"), ("chapter-1", "chapter")],
        )
        self.assertIn("notice", nodes[0].content_html)

    def test_non_navigable_unit_stays_inside_its_section(self) -> None:
        nodes = self.build("""
          <section id="chapter-1" data-type="chapter"><h1>Chapter</h1>
            <div data-role="unit" data-unit-num="1"><p>first</p></div>
            <div data-role="unit" data-unit-num="2"><p>second</p></div>
          </section>
        """)
        self.assertEqual(len(nodes), 1)
        self.assertEqual(nodes[0].section_id, "chapter-1")
        self.assertIn("first", nodes[0].content_html)
        self.assertIn("second", nodes[0].content_html)
        self.assertEqual(nodes[0].block_count, 2)

    def test_block_v1_preserves_inline_semantics_as_text(self) -> None:
        blocks = extract_blocks(
            "<p>这是<strong>重要</strong>而且<em>强调</em>的正文。<br>下一行</p>"
        )
        self.assertEqual(len(blocks), 1)
        self.assertEqual(blocks[0].kind, "p")
        self.assertEqual(blocks[0].text, "这是重要而且强调的正文。\n下一行")

    def test_block_v1_uses_atomic_children_without_container_overlap(self) -> None:
        blocks = extract_blocks("""
          <blockquote><p>first</p><p>second</p></blockquote>
          <ul><li>one</li><li><p>two</p><ul><li>nested</li></ul></li></ul>
          <figure><img src="assets/a.png"><figcaption><p>caption</p></figcaption></figure>
        """)
        self.assertEqual(
            [(block.kind, block.text.strip()) for block in blocks],
            [
                ("p", "first"),
                ("p", "second"),
                ("li", "one"),
                ("p", "two"),
                ("li", "nested"),
                ("figure", ""),
                ("p", "caption"),
            ],
        )

    def test_block_v1_does_not_repeat_paragraphs_inside_flow_containers(self) -> None:
        blocks = extract_blocks("""
          <table><tbody><tr><td><p>cell</p></td></tr></tbody></table>
          <dl><dt>term</dt><dd><p>definition</p></dd></dl>
        """)
        self.assertEqual(
            [(block.kind, block.text.strip()) for block in blocks],
            [
                ("p", "cell"),
                ("dt", "term"),
                ("p", "definition"),
            ],
        )

    def test_character_counts_and_absolute_positions_use_utf16(self) -> None:
        nodes = self.build("""
          <section id="chapter-1" data-type="chapter"><h1>One</h1>
            <p>A😀</p><figure><img src="assets/a.png"><figcaption>图</figcaption></figure>
          </section>
          <section id="chapter-2" data-type="chapter"><h1>Two</h1><p>中</p></section>
        """)

        first, second = nodes
        self.assertEqual(first.character_count, 4)
        self.assertEqual(second.character_count, 1)
        self.assertEqual(first.node_absolute_start, 0)
        self.assertEqual(second.node_absolute_start, 4)
        self.assertEqual(
            first.as_dict()["blocks"],
            [
                {
                    "blockIndex": 1,
                    "kind": "p",
                    "blockAbsoluteStart": 0,
                    "blockUtf16Length": 3,
                },
                {
                    "blockIndex": 2,
                    "kind": "figure",
                    "blockAbsoluteStart": 3,
                    "blockUtf16Length": 0,
                },
                {
                    "blockIndex": 3,
                    "kind": "figcaption",
                    "blockAbsoluteStart": 3,
                    "blockUtf16Length": 1,
                },
            ],
        )


class ReadingManifestTests(unittest.TestCase):
    def build_manifest(self, body: str) -> dict[str, object]:
        html = f"""<!doctype html><html lang="zh-CN"><head><title>测试书</title></head><body>
        <main id="book" data-type="book">{body}</main></body></html>"""
        with tempfile.TemporaryDirectory() as temp_dir:
            input_path = Path(temp_dir) / "book.normalized.html"
            input_path.write_text(html, encoding="utf-8")
            first = build_manifest(input_path)
            second = build_manifest(input_path)
        self.assertEqual(first, second)
        return first

    def test_manifest_has_complete_outline_and_tailoring_eligibility(self) -> None:
        manifest = self.build_manifest("""
          <section id="frontmatter" data-role="frontmatter">
            <section id="preface" data-type="preface"><h1>前言</h1><p>开场</p></section>
          </section>
          <section id="bodymatter" data-role="bodymatter">
            <p>区域文字</p>
            <section id="part-1" data-type="part"><h1>第一部</h1>
              <section id="chapter-1" data-type="chapter"><h2>第一章</h2><p>正文</p></section>
              <section id="chapter-media" data-type="chapter"><h2>图章</h2><figure><img src="assets/a.png"></figure></section>
            </section>
          </section>
          <section id="backmatter" data-role="backmatter">
            <section id="appendix" data-type="appendix"><h1>附录</h1><p>材料</p></section>
          </section>
        """)

        self.assertEqual(manifest["version"], "reading-nodes-1.0")
        self.assertEqual(
            manifest["tailoringEligibilityVersion"],
            "tailoring-eligibility-1.0",
        )
        self.assertEqual(
            manifest["outline"],
            [
                {
                    "sectionId": "preface",
                    "dataType": "preface",
                    "title": "前言",
                    "parentSectionId": None,
                    "firstNodeOrder": 1,
                },
                {
                    "sectionId": "part-1",
                    "dataType": "part",
                    "title": "第一部",
                    "parentSectionId": None,
                    "firstNodeOrder": 3,
                },
                {
                    "sectionId": "chapter-1",
                    "dataType": "chapter",
                    "title": "第一章",
                    "parentSectionId": "part-1",
                    "firstNodeOrder": 3,
                },
                {
                    "sectionId": "chapter-media",
                    "dataType": "chapter",
                    "title": "图章",
                    "parentSectionId": "part-1",
                    "firstNodeOrder": 4,
                },
                {
                    "sectionId": "appendix",
                    "dataType": "appendix",
                    "title": "附录",
                    "parentSectionId": None,
                    "firstNodeOrder": 5,
                },
            ],
        )

        eligibility = {
            node["sectionId"]: (
                node["tailoringEligible"],
                node["exclusionReason"],
            )
            for node in manifest["nodes"]
        }
        self.assertEqual(eligibility["preface"], (False, "non_bodymatter"))
        self.assertEqual(eligibility["bodymatter"], (False, "excluded_data_type"))
        self.assertEqual(eligibility["chapter-1"], (True, None))
        self.assertEqual(eligibility["chapter-media"], (False, "no_text_block"))
        self.assertEqual(eligibility["appendix"], (False, "non_bodymatter"))

    def test_manifest_position_index_does_not_copy_original_content(self) -> None:
        manifest = self.build_manifest("""
          <section id="bodymatter" data-role="bodymatter">
            <section id="chapter-1" data-type="chapter"><h1>第一章</h1>
              <p>A😀</p><p>秘密正文</p>
            </section>
            <section id="chapter-2" data-type="chapter"><h1>第二章</h1><p>中</p></section>
          </section>
        """)

        first, second = manifest["nodes"]
        self.assertEqual(first["characterCount"], 7)
        self.assertEqual(first["nodeAbsoluteStart"], 0)
        self.assertEqual(second["characterCount"], 1)
        self.assertEqual(second["nodeAbsoluteStart"], 7)
        self.assertEqual(manifest["bookTotalCharacters"], 8)
        self.assertNotIn("content_html", first)
        self.assertTrue(all("text" not in block for block in first["blocks"]))
        self.assertNotIn("秘密正文", str(manifest))


if __name__ == "__main__":
    unittest.main()
