#!/usr/bin/env python3
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))

from nb_linter import MAX_LINES_PER_CATEGORY, NbBookLinter, cap_by_category


def normalized_html(fragment: str) -> str:
    return f"""<!doctype html>
    <html lang="zh">
      <head>
        <meta charset="utf-8">
        <title>Test</title>
        <meta name="source-format" content="epub">
        <meta name="normalized-spec" content="nb-1.0">
      </head>
      <body>
        <main id="book" data-type="book">
          <section id="bodymatter" data-role="bodymatter">
            <section id="ch-001" data-type="chapter">
              <h1>Chapter</h1>
              {fragment}
            </section>
          </section>
        </main>
      </body>
    </html>"""


def messages(fragment: str) -> list[str]:
    result = NbBookLinter(normalized_html(fragment)).run_all_checks()
    return result["errors"] + result["warnings"]


class ReadingContractLinterTests(unittest.TestCase):
    def test_rejects_attribute_free_div_with_content(self) -> None:
        result = messages("<div><p>text</p></div>")
        self.assertTrue(any("无任何属性的 <div>" in item for item in result))

    def test_rejects_attribute_free_span_with_content(self) -> None:
        result = messages("<p><span>text</span></p>")
        self.assertTrue(any("无任何属性的 <span>" in item for item in result))

    def test_rejects_section_hidden_in_wrapper(self) -> None:
        result = messages(
            '<div data-role="unknown" data-reason="wrapped-section">'
            '<section id="sec-001" data-type="section"><h2>S</h2><p>text</p></section>'
            '</div>'
        )
        self.assertTrue(any("结构性 <section data-type> 必须直接" in item for item in result))

    def test_allows_semantic_inline_elements(self) -> None:
        result = messages("<p>这是<strong>重要</strong>而且<em>强调</em>的正文。</p>")
        self.assertEqual(result, [])

    def test_rejects_section_without_id(self) -> None:
        html = normalized_html("<p>text</p>").replace(
            '<section id="ch-001" data-type="chapter">',
            '<section data-type="chapter">',
        )
        result = NbBookLinter(html).run_all_checks()
        self.assertTrue(any("章节 <section data-type> 缺失必需的稳定 id" in item for item in result["errors"]))

    def test_rejects_content_region_without_id(self) -> None:
        html = normalized_html("<p>text</p>").replace(
            '<section id="bodymatter" data-role="bodymatter">',
            '<section data-role="bodymatter">',
        )
        result = NbBookLinter(html).run_all_checks()
        self.assertTrue(any("顶层 section[data-role='bodymatter'] 缺失" in item for item in result["errors"]))

    def test_allows_assets_image_path(self) -> None:
        result = messages('<p>text <img src="assets/fig-001.png"></p>')
        self.assertEqual(result, [])

    def test_rejects_data_uri_image(self) -> None:
        payload = "A" * 500
        result = messages(f'<p>text <img src="data:image/png;base64,{payload}"></p>')
        self.assertTrue(any("禁止 data URI" in item for item in result))
        self.assertTrue(all(len(item) < 500 for item in result))

    def test_rejects_external_image_url(self) -> None:
        result = messages('<p>text <img src="https://example.com/a.png"></p>')
        self.assertTrue(any("禁止外部或协议相对 URL" in item for item in result))

    def test_rejects_asset_path_traversal(self) -> None:
        result = messages('<p>text <img src="assets/../secret.png"></p>')
        self.assertTrue(any("不得包含空段、. 或 .." in item for item in result))

    def test_rejects_encoded_asset_path_traversal(self) -> None:
        result = messages('<p>text <img src="assets/%2e%2e/secret.png"></p>')
        self.assertTrue(any("不得包含空段、. 或 .." in item for item in result))

    def test_rejects_signed_asset_url(self) -> None:
        result = messages('<p>text <img src="assets/a.png?token=temporary"></p>')
        self.assertTrue(any("不得包含查询参数或片段" in item for item in result))

    def test_rejects_non_assets_relative_path(self) -> None:
        result = messages('<p>text <img src="images/a.png"></p>')
        self.assertTrue(any("必须以 assets/ 开头" in item for item in result))


class CapByCategoryTests(unittest.TestCase):
    def test_caps_same_category_and_appends_summary(self) -> None:
        lines = [f"[错误] 无任何属性的 <span> …  @ ch-001 > p:nth({i}) > span" for i in range(100)]
        out = cap_by_category(lines, per_category=10)
        self.assertEqual(sum(1 for o in out if o.startswith("[错误]")), 10)
        self.assertEqual(sum(1 for o in out if "该类共 100 条" in o), 1)
        self.assertEqual(len(out), 11)

    def test_groups_by_message_ignoring_location(self) -> None:
        spans = [f"[错误] 无任何属性的 <span> …  @ path{i}" for i in range(30)]
        divs = [f"[错误] 无任何属性的 <div> …  @ path{i}" for i in range(30)]
        out = cap_by_category(spans + divs, per_category=5)
        # 两类各自独立封顶：5 条样本 + 1 条汇总
        self.assertEqual(sum(1 for o in out if "<span>" in o and o.startswith("[错误]")), 5)
        self.assertEqual(sum(1 for o in out if "<div>" in o and o.startswith("[错误]")), 5)
        self.assertEqual(sum(1 for o in out if "该类共 30 条" in o), 2)

    def test_leaves_small_lists_untouched(self) -> None:
        lines = ["[错误] a  @ x", "[错误] b  @ y"]
        self.assertEqual(cap_by_category(lines, per_category=MAX_LINES_PER_CATEGORY), lines)


if __name__ == "__main__":
    unittest.main()
