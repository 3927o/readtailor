"""nb-1.0 产物统一校验入口（结构层 + 包资源层 + 保真层）。

用法：
    python tools/nb_check.py book.html                        # 结构层 + 包资源层
    python tools/nb_check.py book.html --baseline book.epub   # 三层完整校验

三层分工：
- 结构层（永远跑）：产物自身是否符合 docs/contracts/normalized_book_spec.md 的结构规则。
  规则实现在同目录 nb_linter.py。
- 包资源层（永远跑）：assets/... 路径安全且引用文件真实存在。
- 保真层（提供 --baseline 时跑）：产物相对源 EPUB 有没有丢内容。
  * char_recall  —— 可见文本 n-gram 召回率（诊断性 warning，不阻断发布）
  * img_recall   —— assets 图片按字节哈希做多重集守恒（同一张图用 3 次丢 1 次也能抓到）
  * note 守恒    —— EPUB 里的 epub:type noteref/footnote 数 ↔ 产物 noteref/note 数
  * TOC 对账     —— EPUB nav 文档条目数 ↔ 产物 nav[data-role=toc] 条目数

重要：没提供 --baseline 时，结构层全绿**不代表**内容没丢——报告会明确标注
"内容保真未验证"。给 agent 的终验必须带上源 EPUB。

退出码：0 = 通过；1 = 有 error；2 = 只有 warning。
"""
from __future__ import annotations

import argparse
import hashlib
import html as html_mod
import json
import os
import posixpath
import re
import sys
import warnings
import zipfile
from collections import Counter
from pathlib import Path
from typing import Optional
from urllib.parse import unquote

from bs4 import BeautifulSoup, Tag, XMLParsedAsHTMLWarning

warnings.filterwarnings("ignore", category=XMLParsedAsHTMLWarning)

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from nb_linter import (  # noqa: E402
    MEDIA_RESOURCE_ATTRS,
    NbBookLinter,
    asset_reference_error,
)

WS_RE = re.compile(r"\s+")
CHAR_RECALL_THRESHOLD = 0.999
VALIDATOR_VERSION = "nb-check-1.0"
CHAR_NGRAM_SIZE = 16
MAX_NGRAM_WARNING_REGIONS = 20


def norm_text(s: str) -> str:
    # 双侧统一：先把字面实体（含无分号 legacy 形式，如 "&nbsp"）解码成
    # Unicode，再删全部空白（\s 含 \xa0）。这样畸形实体不会污染字符对账；
    # 产物里若真残留字面实体，由结构层的 check_entity_residue 负责报错。
    return WS_RE.sub("", html_mod.unescape(html_mod.unescape(s)))


def _local_name(tag: Tag) -> str:
    return tag.name.split(":")[-1]


# ---------------------------------------------------------------------------
# EPUB 基准抽取（只读，不做任何 DOM 改写）
# ---------------------------------------------------------------------------

class EpubBaseline:
    def __init__(self, path: str):
        self.zf = zipfile.ZipFile(path)
        self.opf_path = self._find_opf()
        self.opf_dir = posixpath.dirname(self.opf_path)
        opf = BeautifulSoup(self._read(self.opf_path), "html.parser")

        # manifest: id -> (href, media-type, properties)
        self.manifest: dict[str, tuple[str, str, str]] = {}
        for item in opf.find_all(lambda t: _local_name(t) == "item"):
            iid = item.get("id")
            if iid:
                self.manifest[iid] = (
                    item.get("href") or "",
                    item.get("media-type") or "",
                    item.get("properties") or "",
                )

        # spine（linear 项）
        self.spine_hrefs: list[str] = []
        for iref in opf.find_all(lambda t: _local_name(t) == "itemref"):
            if (iref.get("linear") or "yes").lower() == "no":
                continue
            entry = self.manifest.get(iref.get("idref") or "")
            if entry:
                self.spine_hrefs.append(entry[0])

        # nav 文档（EPUB3）
        self.nav_href: Optional[str] = None
        for href, mtype, props in self.manifest.values():
            if "nav" in (props or "").split():
                self.nav_href = href
                break

        # 解析好的 spine 文档缓存
        self._docs: list[tuple[str, BeautifulSoup]] = []
        for href in self.spine_hrefs:
            raw = self._read(self._resolve(href))
            if raw is None:
                continue
            self._docs.append((href, BeautifulSoup(raw, "html.parser")))

    def _find_opf(self) -> str:
        container = BeautifulSoup(self._read("META-INF/container.xml"), "html.parser")
        rootfile = container.find(lambda t: _local_name(t) == "rootfile")
        return rootfile.get("full-path")

    def _resolve(self, href: str) -> str:
        href = href.split("#")[0]
        return posixpath.normpath(posixpath.join(self.opf_dir, href)) if self.opf_dir else href

    def _read(self, name: str) -> Optional[bytes]:
        try:
            return self.zf.read(name)
        except KeyError:
            return None

    # ---- 可见文本 -----------------------------------------------------------

    def visible_text(self) -> str:
        parts = []
        for href, doc in self._docs:
            body = doc.find("body") or doc
            parts.append(body.get_text())
        return norm_text("".join(parts))

    @staticmethod
    def _is_note_body(element: Tag) -> bool:
        tokens = set(str(element.get("epub:type") or "").split())
        return bool(tokens & {"footnote", "rearnote", "endnote"})

    # ---- 图片引用（多重集） ---------------------------------------------------

    def image_refs(self) -> tuple[Counter, dict[str, list[str]]]:
        """返回 (哈希→引用次数, 哈希→引用它的 spine 文档列表)。"""
        counts: Counter = Counter()
        locations: dict[str, list[str]] = {}
        for href, doc in self._docs:
            doc_dir = posixpath.dirname(href)
            for img in doc.find_all("img"):
                src = img.get("src") or ""
                if not src or src.startswith("data:"):
                    continue
                target = posixpath.normpath(posixpath.join(doc_dir, src.split("#")[0]))
                data = self._read(self._resolve(target)) or self._read(target)
                if data is None:
                    continue
                h = hashlib.md5(data).hexdigest()
                counts[h] += 1
                locations.setdefault(h, []).append(href)
        return counts, locations

    # ---- note 标记计数 --------------------------------------------------------

    def note_counts(self) -> tuple[int, int]:
        n_refs = n_notes = 0
        for _, doc in self._docs:
            for el in doc.find_all(True):
                tokens = set(str(el.get("epub:type") or "").split())
                # Some EPUBs mislabel the link at the start of an endnote body
                # as noteref even though it points back to the正文. nb-1.0
                # normalizes that link to data-role=backref, so only forward
                # references outside note bodies participate in conservation.
                inside_note = any(
                    isinstance(parent, Tag) and self._is_note_body(parent)
                    for parent in el.parents
                )
                if "noteref" in tokens and not inside_note:
                    n_refs += 1
                if tokens & {"footnote", "rearnote", "endnote"}:
                    n_notes += 1
        return n_refs, n_notes

    # ---- TOC 条目 --------------------------------------------------------------

    def toc_entries(self) -> Optional[list[str]]:
        # EPUB3：manifest 里 properties="nav" 的目录文档
        if self.nav_href:
            raw = self._read(self._resolve(self.nav_href))
            if raw is not None:
                nav_doc = BeautifulSoup(raw, "html.parser")
                nav = None
                for n in nav_doc.find_all("nav"):
                    if "toc" in (n.get("epub:type") or ""):
                        nav = n
                        break
                nav = nav or nav_doc.find("nav")
                if nav:
                    return [a.get_text(strip=True) for a in nav.find_all("a")]
        # EPUB2 fallback：NCX（media-type application/x-dtbncx+xml）
        for href, mtype, _props in self.manifest.values():
            if "dtbncx" in mtype:
                raw = self._read(self._resolve(href))
                if raw is None:
                    break
                ncx = BeautifulSoup(raw, "html.parser")
                labels = [
                    t.get_text(strip=True)
                    for np in ncx.find_all(lambda t: _local_name(t) == "navpoint")
                    for t in np.find_all(lambda t: _local_name(t) == "text")[:1]
                ]
                return labels or None
        return None


# ---------------------------------------------------------------------------
# 包资源层
# ---------------------------------------------------------------------------

def resolve_asset_path(package_root: Path, reference: str) -> Optional[Path]:
    """把已通过语法校验的 assets/... 引用解析为包内文件路径。"""
    if asset_reference_error(reference):
        return None
    root = package_root.resolve()
    target = (root / unquote(reference.strip())).resolve()
    try:
        common = os.path.commonpath((str(root), str(target)))
    except ValueError:
        return None
    return target if common == str(root) else None


class AssetChecker:
    def __init__(self, product_soup: BeautifulSoup, product_path: str):
        self.product = product_soup
        self.product_path = Path(product_path).resolve()
        self.package_root = self.product_path.parent
        self.errors: list[str] = []
        self.warnings: list[str] = []
        self.metrics: dict[str, object] = {}

    def run(self) -> None:
        checked = 0
        unique_files: set[Path] = set()
        for tag_name, attr_name in MEDIA_RESOURCE_ATTRS:
            for node in self.product.find_all(tag_name):
                if not node.has_attr(attr_name):
                    continue
                reference = str(node.get(attr_name) or "")
                if asset_reference_error(reference):
                    # 具体路径语法错误由结构层报告；这里不重复。
                    continue
                checked += 1
                target = resolve_asset_path(self.package_root, reference)
                if target is None:
                    self.errors.append(
                        f"[资源越界] {tag_name}.{attr_name}={reference!r} 无法安全解析到书籍包内"
                    )
                    continue
                unique_files.add(target)
                if not target.is_file():
                    self.errors.append(
                        f"[资源缺失] {tag_name}.{attr_name}={reference!r} 对应文件不存在"
                    )

        self.metrics["asset_references"] = checked
        self.metrics["asset_files"] = len(unique_files)


# ---------------------------------------------------------------------------
# 保真层
# ---------------------------------------------------------------------------

class FidelityChecker:
    def __init__(
        self,
        product_soup: BeautifulSoup,
        baseline: EpubBaseline,
        package_root: Path,
    ):
        self.product = product_soup
        self.baseline = baseline
        self.package_root = package_root.resolve()
        self.errors: list[str] = []
        self.warnings: list[str] = []
        self.metrics: dict[str, object] = {}

    def run(self) -> None:
        self.check_char_recall()
        self.check_image_recall()
        self.check_note_conservation()
        self.check_toc_reconciliation()

    # ---- char_recall（固定长度字符片段多重集） ---------------------------------

    @staticmethod
    def _ngram_counts(text: str, size: int) -> Counter:
        if not text or len(text) < size:
            return Counter()
        return Counter(text[index:index + size] for index in range(len(text) - size + 1))

    @staticmethod
    def _unmatched_regions(
        text: str,
        unmatched: Counter,
        size: int,
    ) -> list[tuple[int, int, int]]:
        """Return (start, end, ngram_count) for consecutive unmatched windows."""
        remaining = unmatched.copy()
        positions: list[int] = []
        for index in range(max(0, len(text) - size + 1)):
            gram = text[index:index + size]
            if remaining.get(gram, 0) > 0:
                positions.append(index)
                remaining[gram] -= 1

        regions: list[tuple[int, int, int]] = []
        for position in positions:
            if regions and position == regions[-1][1] - size + 1:
                start, _end, count = regions[-1]
                regions[-1] = (start, position + size, count + 1)
            else:
                regions.append((position, position + size, 1))
        return regions

    def check_char_recall(self) -> None:
        epub_text = self.baseline.visible_text()
        body = self.product.find("body")
        prod_text = norm_text(body.get_text()) if body else ""

        if not epub_text:
            ngram_size = min(CHAR_NGRAM_SIZE, len(prod_text)) if prod_text else CHAR_NGRAM_SIZE
            source_counts: Counter = Counter()
            product_counts = self._ngram_counts(prod_text, ngram_size)
        else:
            ngram_size = min(CHAR_NGRAM_SIZE, len(epub_text))
            source_counts = self._ngram_counts(epub_text, ngram_size)
            product_counts = self._ngram_counts(prod_text, ngram_size)

        matched_counts = source_counts & product_counts
        missing_counts = source_counts - product_counts
        extra_counts = product_counts - source_counts
        source_total = sum(source_counts.values())
        product_total = sum(product_counts.values())
        matched = sum(matched_counts.values())
        missing = sum(missing_counts.values())
        extra = sum(extra_counts.values())
        recall = matched / source_total if source_total else 1.0
        extra_ratio = extra / product_total if product_total else 0.0

        self.metrics["char_recall"] = recall
        self.metrics["char_recall_gate"] = "advisory"
        self.metrics["char_recall_method"] = "character_ngram_multiset"
        self.metrics["char_ngram_size"] = ngram_size
        self.metrics["source_ngrams"] = source_total
        self.metrics["matched_ngrams"] = matched
        self.metrics["missing_ngrams"] = missing
        self.metrics["extra_ngrams"] = extra
        self.metrics["extra_ngram_ratio"] = extra_ratio

        missing_regions = self._unmatched_regions(epub_text, missing_counts, ngram_size)
        extra_regions = self._unmatched_regions(prod_text, extra_counts, ngram_size)
        self.metrics["missing_regions"] = len(missing_regions)
        self.metrics["extra_regions"] = len(extra_regions)

        for start, end, count in missing_regions[:MAX_NGRAM_WARNING_REGIONS]:
            context = epub_text[max(0, start - 20):min(len(epub_text), end + 20)]
            self.warnings.append(
                f"[内容差异·非阻断] 源文本局部片段未召回（约 {end - start} 字符，"
                f"{count} 个 {ngram_size}-gram）: {context[:120]!r}"
            )
        if len(missing_regions) > MAX_NGRAM_WARNING_REGIONS:
            self.warnings.append(
                f"[内容差异·非阻断] 另有 {len(missing_regions) - MAX_NGRAM_WARNING_REGIONS} "
                "个源文本缺失区域未展开"
            )

        for start, end, count in extra_regions[:MAX_NGRAM_WARNING_REGIONS]:
            context = prod_text[max(0, start - 20):min(len(prod_text), end + 20)]
            self.warnings.append(
                f"[内容差异·非阻断] 产物存在源中未召回的局部片段（约 {end - start} 字符，"
                f"{count} 个 {ngram_size}-gram）: {context[:120]!r}"
            )
        if len(extra_regions) > MAX_NGRAM_WARNING_REGIONS:
            self.warnings.append(
                f"[内容差异·非阻断] 另有 {len(extra_regions) - MAX_NGRAM_WARNING_REGIONS} "
                "个产物新增区域未展开"
            )

        if recall < CHAR_RECALL_THRESHOLD:
            self.warnings.append(
                f"[内容差异·非阻断] char_recall = {recall*100:.4f}% "
                f"低于参考阈值 {CHAR_RECALL_THRESHOLD*100}%"
                f"（{ngram_size}-gram 多重集召回）"
            )

    # ---- img_recall（多重集守恒） ------------------------------------------------

    def check_image_recall(self) -> None:
        epub_counts, epub_locs = self.baseline.image_refs()

        prod_counts: Counter = Counter()
        for img in self.product.find_all("img"):
            src = img.get("src") or ""
            target = resolve_asset_path(self.package_root, str(src))
            if target is None or not target.is_file():
                continue  # 路径不合法或文件缺失由结构层/包资源层报告。
            try:
                data = target.read_bytes()
            except OSError as exc:
                self.errors.append(f"[图片读取失败] {src!r}: {exc}")
                continue
            prod_counts[hashlib.md5(data).hexdigest()] += 1

        total_epub = sum(epub_counts.values())
        total_prod = sum(prod_counts.values())
        self.metrics["img_refs_epub"] = total_epub
        self.metrics["img_refs_product"] = total_prod

        for h, n_epub in epub_counts.items():
            n_prod = prod_counts.get(h, 0)
            if n_prod < n_epub:
                locs = ", ".join(epub_locs.get(h, [])[:5])
                self.errors.append(
                    f"[图片丢失] 同一图片（md5={h[:10]}…）源中引用 {n_epub} 次、"
                    f"产物仅 {n_prod} 次；源引用位置: {locs}"
                )

        for h, n_prod in prod_counts.items():
            n_epub = epub_counts.get(h, 0)
            if n_prod > n_epub:
                self.warnings.append(
                    f"[图片新增或重复] 同一图片（md5={h[:10]}…）源中引用 {n_epub} 次、"
                    f"产物引用 {n_prod} 次"
                )

    # ---- note 守恒 ---------------------------------------------------------------

    def check_note_conservation(self) -> None:
        n_refs, n_notes = self.baseline.note_counts()
        if n_refs == 0 and n_notes == 0:
            return  # 源没有语义标记，无法对账
        p_refs = len(self.product.select('[data-role="noteref"]'))
        p_notes = len(self.product.select('[data-role="note"]'))
        self.metrics["noterefs_epub_vs_product"] = (n_refs, p_refs)
        self.metrics["notes_epub_vs_product"] = (n_notes, p_notes)
        if n_refs and p_refs != n_refs:
            self.warnings.append(
                f"[脚注] 源 epub:type=noteref 共 {n_refs} 个，产物 noteref {p_refs} 个"
            )
        if n_notes and p_notes != n_notes:
            self.warnings.append(
                f"[脚注] 源 footnote/rearnote 共 {n_notes} 个，产物 note {p_notes} 个"
            )

    # ---- TOC 对账 ----------------------------------------------------------------

    def check_toc_reconciliation(self) -> None:
        epub_toc = self.baseline.toc_entries()
        prod_nav = self.product.find("nav", attrs={"data-role": "toc"})
        if epub_toc is None:
            if prod_nav is not None:
                self.warnings.append(
                    "[TOC] 源 EPUB 未发现 nav 文档，但产物有 TOC——确认不是凭空生成（§11）"
                )
            return
        if prod_nav is None:
            self.errors.append(
                f"[TOC] 源 EPUB 有 nav 目录（{len(epub_toc)} 条），产物缺 <nav data-role=\"toc\">"
            )
            return
        prod_entries = [a.get_text(strip=True) for a in prod_nav.find_all("a")]
        self.metrics["toc_entries_epub_vs_product"] = (len(epub_toc), len(prod_entries))
        if len(prod_entries) != len(epub_toc):
            self.warnings.append(
                f"[TOC] 条目数不一致：源 {len(epub_toc)} 条 vs 产物 {len(prod_entries)} 条"
            )
        missing = [t for t in epub_toc if t and t not in prod_entries]
        if missing:
            self.warnings.append(
                f"[TOC] 源目录条目在产物 TOC 中缺失: {missing[:5]}"
            )


# ---------------------------------------------------------------------------
# 主入口
# ---------------------------------------------------------------------------

def main() -> int:
    ap = argparse.ArgumentParser(description="nb-1.0 产物校验（结构层 + 保真层）")
    ap.add_argument("product", help="规范化产物 HTML 路径")
    ap.add_argument(
        "--baseline",
        help="源 EPUB 路径（提供后加跑保真层；也接受 raw.html 用于调试）",
    )
    ap.add_argument(
        "--json-report",
        help="同时把含问题级别、分层计数和指标的机器可读报告写到指定路径",
    )
    args = ap.parse_args()

    with open(args.product, encoding="utf-8") as f:
        product_html = f.read()
    product_soup = BeautifulSoup(product_html, "html.parser")

    # ---- 结构层 ----
    linter = NbBookLinter(product_html)
    struct = linter.run_all_checks()

    print("════════ 结构层（nb-1.0 规范自检） ════════")
    for e in struct["errors"]:
        print(e)
    for w in struct["warnings"]:
        print(w)
    print(f"结构层小计：{len(struct['errors'])} error / {len(struct['warnings'])} warning")

    # ---- 包资源层 ----
    assets = AssetChecker(product_soup, args.product)
    assets.run()
    print()
    print("════════ 包资源层（assets 文件检查） ════════")
    for e in assets.errors:
        print("[错误] " + e)
    for w in assets.warnings:
        print("[警告] " + w)
    print(
        f"资源引用 {assets.metrics.get('asset_references', 0)} 次 / "
        f"实际文件 {assets.metrics.get('asset_files', 0)} 个"
    )
    print(f"包资源层小计：{len(assets.errors)} error / {len(assets.warnings)} warning")

    fid_errors: list[str] = []
    fid_warnings: list[str] = []
    fid_metrics: dict[str, object] = {}

    # ---- 保真层 ----
    if args.baseline:
        print()
        print("════════ 保真层（对源 EPUB 守恒对账） ════════")
        if args.baseline.lower().endswith(".epub"):
            baseline = EpubBaseline(args.baseline)
            fc = FidelityChecker(product_soup, baseline, assets.package_root)
            fc.run()
            fid_errors, fid_warnings = fc.errors, fc.warnings
            fid_metrics = fc.metrics
            for e in fid_errors:
                print("[错误] " + e)
            for w in fid_warnings:
                print("[警告] " + w)
            cr = fc.metrics.get("char_recall")
            if isinstance(cr, float):
                print(f"char_recall = {cr*100:.4f}%")
            print(
                f"图片引用：源 {fc.metrics.get('img_refs_epub')} 次 / "
                f"产物 {fc.metrics.get('img_refs_product')} 次"
            )
            print(f"保真层小计：{len(fid_errors)} error / {len(fid_warnings)} warning")
        else:
            print("（暂只支持 .epub 基准；raw.html 基准请用旧 evaluator）")
    else:
        print()
        print("⚠ 未提供 --baseline：内容保真【未验证】。结构层全绿不代表没丢内容；")
        print("  终验请带上源 EPUB：nb_check.py <product.html> --baseline <book.epub>")

    # ---- 汇总 ----
    n_err = len(struct["errors"]) + len(assets.errors) + len(fid_errors)
    n_warn = len(struct["warnings"]) + len(assets.warnings) + len(fid_warnings)
    print()
    print(f"—— 总计：{n_err} 个错误，{n_warn} 个警告 ——")
    if args.json_report:
        report = {
            "version": VALIDATOR_VERSION,
            "product": os.path.basename(args.product),
            "baseline": os.path.basename(args.baseline) if args.baseline else None,
            "sections": {
                "structure": {
                    "errors": struct["errors"],
                    "warnings": struct["warnings"],
                },
                "assets": {
                    "errors": assets.errors,
                    "warnings": assets.warnings,
                    "metrics": assets.metrics,
                },
                "fidelity": {
                    "errors": fid_errors,
                    "warnings": fid_warnings,
                    "metrics": fid_metrics,
                    "verified": bool(args.baseline and args.baseline.lower().endswith(".epub")),
                },
            },
            "totals": {"errors": n_err, "warnings": n_warn},
        }
        report_path = Path(args.json_report)
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(
            json.dumps(report, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
    if n_err:
        return 1
    if n_warn:
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
