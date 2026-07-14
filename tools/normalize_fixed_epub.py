#!/usr/bin/env python3
"""Deterministically normalize the phase-two fixture EPUB to nb-1.0.

This is intentionally a fixture-specific normalizer. It reads the EPUB package
metadata, spine, and NCX instead of relying on extracted filenames alone, but
it also asserts the fixed book's known conservation counts before publishing.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import posixpath
import re
import shutil
import warnings
import zipfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Iterable, Optional
from urllib.parse import unquote

from bs4 import BeautifulSoup, NavigableString, Tag, XMLParsedAsHTMLWarning


warnings.filterwarnings("ignore", category=XMLParsedAsHTMLWarning)


EXPECTED_NOTEREFS = 2754
EXPECTED_FORWARD_NOTEREFS = 1377
EXPECTED_BACKREFS = 1377
EXPECTED_NOTES = 1377
EXPECTED_IMAGE_REFS = 1
EXPECTED_TOC_ENTRIES = 91

FRONTMATTER_TYPES = {
    "Text/part0001.xhtml": "titlepage",
    "Text/part0002.xhtml": "colophon",
    "Text/part0003.xhtml": "colophon",
    "Text/part0004.xhtml": "preface",
}
BODY_HREFS = {f"Text/part{number:04d}.xhtml" for number in range(5, 91)}
PART_CHAPTER_RANGES = {
    "Text/part0030.xhtml": range(31, 53),
    "Text/part0053.xhtml": range(54, 70),
    "Text/part0070.xhtml": range(71, 91),
}
BACKMATTER_TYPES = {
    "Text/part0092.xhtml": "afterword",
    "Text/part0093.xhtml": "colophon",
}
NOTES_HREF = "Text/part0091.xhtml"

DROP_TAGS = {"script", "style", "iframe", "object", "embed", "link"}
HEADING_RE = re.compile(r"^h[1-6]$")
EXTERNAL_LINK_RE = re.compile(r"^(?:https?|mailto|tel):", re.I)


def local_name(tag: Tag) -> str:
    return tag.name.split(":")[-1]


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def stable_json(data: object) -> str:
    return json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True) + "\n"


@dataclass(frozen=True)
class ManifestItem:
    href: str
    media_type: str


@dataclass
class TocEntry:
    label: str
    src: str
    children: list["TocEntry"]


class FixedEpubNormalizer:
    def __init__(self, input_epub: Path, output_dir: Path):
        self.input_epub = input_epub.resolve()
        self.output_dir = output_dir.resolve()
        self.zip = zipfile.ZipFile(self.input_epub)
        self.opf_path = self._find_opf()
        self.opf_dir = posixpath.dirname(self.opf_path)
        self.manifest: dict[str, ManifestItem] = {}
        self.spine_hrefs: list[str] = []
        self.docs: dict[str, BeautifulSoup] = {}
        self.title = ""
        self.language = "zh"
        self.authors: list[str] = []
        self.identifiers: dict[str, str] = {}
        self.publisher: Optional[str] = None
        self.published_date: Optional[str] = None
        self.cover_href: Optional[str] = None
        self.ncx_href = ""
        self.toc_entries: list[TocEntry] = []
        self.file_target_ids: dict[str, str] = {}
        self.source_id_targets: dict[tuple[str, str], str] = {}
        self.note_targets: dict[str, str] = {}
        self.ref_counter = 0
        self.figure_counter = 0
        self.table_counter = 0
        self.asset_records: dict[str, dict[str, object]] = {}
        self._read_package()

    def _read(self, path: str) -> bytes:
        return self.zip.read(path)

    def _parse_markup(self, data: bytes) -> BeautifulSoup:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", XMLParsedAsHTMLWarning)
            return BeautifulSoup(data, "html.parser")

    def _find_opf(self) -> str:
        container = self._parse_markup(self._read("META-INF/container.xml"))
        rootfile = container.find(lambda tag: isinstance(tag, Tag) and local_name(tag) == "rootfile")
        if not rootfile or not rootfile.get("full-path"):
            raise ValueError("EPUB container does not identify an OPF package")
        return str(rootfile["full-path"])

    def _package_path(self, href: str) -> str:
        return posixpath.normpath(posixpath.join(self.opf_dir, href))

    def _read_package(self) -> None:
        opf = self._parse_markup(self._read(self.opf_path))
        title = opf.find(lambda tag: isinstance(tag, Tag) and local_name(tag) == "title")
        language = opf.find(lambda tag: isinstance(tag, Tag) and local_name(tag) == "language")
        self.title = title.get_text(strip=True) if title else "查拉图斯特拉如是说"
        self.language = language.get_text(strip=True) if language else "zh"
        self.authors = [
            node.get_text(strip=True)
            for node in opf.find_all(
                lambda tag: isinstance(tag, Tag) and local_name(tag) == "creator"
            )
            if node.get_text(strip=True)
        ]
        publisher = opf.find(
            lambda tag: isinstance(tag, Tag) and local_name(tag) == "publisher"
        )
        published_date = opf.find(
            lambda tag: isinstance(tag, Tag) and local_name(tag) == "date"
        )
        self.publisher = publisher.get_text(strip=True) if publisher else None
        self.published_date = published_date.get_text(strip=True) if published_date else None

        for identifier in opf.find_all(
            lambda tag: isinstance(tag, Tag) and local_name(tag) == "identifier"
        ):
            value = identifier.get_text(strip=True)
            if not value:
                continue
            scheme = str(identifier.get("opf:scheme") or identifier.get("scheme") or "").lower()
            if scheme == "isbn":
                key = "isbn"
            elif identifier.get("id"):
                key = str(identifier["id"])
            else:
                key = f"identifier_{len(self.identifiers) + 1}"
            self.identifiers[key] = value

        cover_meta = opf.find(
            "meta",
            attrs={"name": lambda value: value and str(value).lower() == "cover"},
        )
        cover_item_id = str(cover_meta.get("content") or "") if cover_meta else ""

        for item in opf.find_all(lambda tag: isinstance(tag, Tag) and local_name(tag) == "item"):
            item_id = item.get("id")
            href = item.get("href")
            if not item_id or not href:
                continue
            manifest_item = ManifestItem(str(href), str(item.get("media-type") or ""))
            self.manifest[str(item_id)] = manifest_item
            if str(item_id) == cover_item_id:
                self.cover_href = manifest_item.href
            if "dtbncx" in manifest_item.media_type:
                self.ncx_href = manifest_item.href

        for itemref in opf.find_all(lambda tag: isinstance(tag, Tag) and local_name(tag) == "itemref"):
            if str(itemref.get("linear") or "yes").lower() == "no":
                continue
            item = self.manifest.get(str(itemref.get("idref") or ""))
            if not item:
                continue
            self.spine_hrefs.append(item.href)
            package_path = self._package_path(item.href)
            self.docs[item.href] = self._parse_markup(self._read(package_path))

        if not self.ncx_href:
            raise ValueError("fixed fixture must contain an NCX")
        self.toc_entries = self._read_ncx()
        self._prepare_target_maps()
        self._assert_fixture_shape()

    def _read_ncx(self) -> list[TocEntry]:
        ncx = self._parse_markup(self._read(self._package_path(self.ncx_href)))
        nav_map = ncx.find(lambda tag: isinstance(tag, Tag) and local_name(tag) == "navmap")
        if not nav_map:
            raise ValueError("NCX does not contain navMap")

        def parse(nav_point: Tag) -> TocEntry:
            label_node = nav_point.find(
                lambda tag: isinstance(tag, Tag) and local_name(tag) == "navlabel",
                recursive=False,
            )
            label_text = ""
            if label_node:
                text_node = label_node.find(
                    lambda tag: isinstance(tag, Tag) and local_name(tag) == "text"
                )
                label_text = text_node.get_text(strip=True) if text_node else ""
            content = nav_point.find(
                lambda tag: isinstance(tag, Tag) and local_name(tag) == "content",
                recursive=False,
            )
            src = str(content.get("src") or "") if content else ""
            children = [
                parse(child)
                for child in nav_point.find_all(
                    lambda tag: isinstance(tag, Tag) and local_name(tag) == "navpoint",
                    recursive=False,
                )
            ]
            return TocEntry(label=label_text, src=src, children=children)

        return [
            parse(nav_point)
            for nav_point in nav_map.find_all(
                lambda tag: isinstance(tag, Tag) and local_name(tag) == "navpoint",
                recursive=False,
            )
        ]

    def _prepare_target_maps(self) -> None:
        for href in self.spine_hrefs:
            stem = PurePosixPath(href).stem
            if href == NOTES_HREF:
                target = "book-notes"
            elif href in FRONTMATTER_TYPES:
                target = f"front-{stem}"
            elif href in BODY_HREFS:
                target = f"body-{stem}"
            elif href in BACKMATTER_TYPES:
                target = f"back-{stem}"
            else:
                target = f"source-{stem}"
            self.file_target_ids[href] = target

            doc = self.docs[href]
            for node in doc.find_all(id=True):
                source_id = str(node.get("id") or "")
                if source_id:
                    self.source_id_targets[(href, source_id)] = f"{stem}--{source_id}"

        forward_index = 0
        for href in self.spine_hrefs:
            if href == NOTES_HREF:
                continue
            for ref in self.docs[href].find_all(
                attrs={"epub:type": lambda value: value and "noteref" in value.split()}
            ):
                forward_index += 1
                source_id = str(ref.get("id") or "")
                if source_id:
                    self.source_id_targets[(href, source_id)] = f"ref-{forward_index:05d}"
        if forward_index != EXPECTED_FORWARD_NOTEREFS:
            raise ValueError(
                f"fixed fixture has {forward_index} forward noterefs; "
                f"expected {EXPECTED_FORWARD_NOTEREFS}"
            )

        notes_doc = self.docs.get(NOTES_HREF)
        if notes_doc:
            for index, note in enumerate(
                notes_doc.find_all(attrs={"epub:type": lambda value: value == "rearnote"}),
                start=1,
            ):
                source_id = str(note.get("id") or f"rearnote_{index}")
                self.note_targets[source_id] = f"note-{index:04d}"
                self.source_id_targets[(NOTES_HREF, source_id)] = f"note-{index:04d}"

    def _iter_toc(self, entries: Optional[Iterable[TocEntry]] = None) -> Iterable[TocEntry]:
        for entry in entries if entries is not None else self.toc_entries:
            yield entry
            yield from self._iter_toc(entry.children)

    def _assert_fixture_shape(self) -> None:
        source_noterefs = 0
        source_notes = 0
        source_images = 0
        for doc in self.docs.values():
            source_noterefs += len(
                doc.find_all(attrs={"epub:type": lambda value: value and "noteref" in value.split()})
            )
            source_notes += len(
                doc.find_all(attrs={"epub:type": lambda value: value and "rearnote" in value.split()})
            )
            source_images += len(doc.find_all("img", src=True))

        actual = {
            "noterefs": source_noterefs,
            "notes": source_notes,
            "image_refs": source_images,
            "toc_entries": sum(1 for _ in self._iter_toc()),
        }
        expected = {
            "noterefs": EXPECTED_NOTEREFS,
            "notes": EXPECTED_NOTES,
            "image_refs": EXPECTED_IMAGE_REFS,
            "toc_entries": EXPECTED_TOC_ENTRIES,
        }
        if actual != expected:
            raise ValueError(f"input is not the fixed phase-two fixture: expected {expected}, got {actual}")
        required = (
            set(FRONTMATTER_TYPES)
            | BODY_HREFS
            | set(BACKMATTER_TYPES)
            | {"Text/part0000.xhtml", NOTES_HREF}
        )
        missing = sorted(required - set(self.docs))
        if missing:
            raise ValueError(f"fixed fixture spine is missing expected documents: {missing}")

    def _new_soup(self) -> BeautifulSoup:
        return BeautifulSoup("", "html.parser")

    def _new_tag(self, soup: BeautifulSoup, tag_name: str, **attrs: str) -> Tag:
        return soup.new_tag(tag_name, attrs=attrs)

    def _resolve_internal_href(self, current_href: str, source_href: str) -> tuple[str, str]:
        decoded = unquote(source_href)
        path, separator, fragment = decoded.partition("#")
        if path:
            target_href = posixpath.normpath(posixpath.join(posixpath.dirname(current_href), path))
        else:
            target_href = current_href
        return target_href, fragment if separator else ""

    def _rewrite_href(
        self,
        current_href: str,
        source_href: str,
        *,
        current_note_id: Optional[str] = None,
        is_noteref: bool = False,
    ) -> tuple[str, bool]:
        if EXTERNAL_LINK_RE.match(source_href):
            return source_href, False
        target_href, fragment = self._resolve_internal_href(current_href, source_href)
        if is_noteref:
            if not current_note_id:
                note_target = self.note_targets.get(fragment)
                if note_target:
                    return f"#{note_target}", False
        if fragment:
            target = self.source_id_targets.get((target_href, fragment))
        else:
            target = self.file_target_ids.get(target_href)
        if target:
            return f"#{target}", False
        return source_href, True

    def _copy_asset(self, current_href: str, source: str) -> str:
        source_path, _, _fragment = source.partition("#")
        package_path = posixpath.normpath(
            posixpath.join(self.opf_dir, posixpath.dirname(current_href), source_path)
        )
        data = self._read(package_path)
        basename = PurePosixPath(source_path).name
        output_name = basename
        digest = sha256_bytes(data)
        existing = self.asset_records.get(output_name)
        if existing and existing["sha256"] != digest:
            stem = PurePosixPath(basename).stem
            suffix = PurePosixPath(basename).suffix
            output_name = f"{stem}-{digest[:12]}{suffix}"
        assets_dir = self.output_dir / "assets"
        assets_dir.mkdir(parents=True, exist_ok=True)
        (assets_dir / output_name).write_bytes(data)
        record = self.asset_records.setdefault(
            output_name,
            {"path": f"assets/{output_name}", "sha256": digest, "size_bytes": len(data), "references": 0},
        )
        record["references"] = int(record["references"]) + 1
        return f"assets/{output_name}"

    def _copy_cover_asset(self) -> Optional[str]:
        if not self.cover_href:
            return None
        package_path = self._package_path(self.cover_href)
        data = self._read(package_path)
        output_name = PurePosixPath(self.cover_href).name
        assets_dir = self.output_dir / "assets"
        assets_dir.mkdir(parents=True, exist_ok=True)
        (assets_dir / output_name).write_bytes(data)
        self.asset_records[output_name] = {
            "path": f"assets/{output_name}",
            "sha256": sha256_bytes(data),
            "size_bytes": len(data),
            "references": 0,
        }
        return f"assets/{output_name}"

    def _copy_children(
        self,
        source: Tag,
        destination: Tag,
        soup: BeautifulSoup,
        current_href: str,
        *,
        current_note_id: Optional[str] = None,
    ) -> None:
        for child in list(source.children):
            copied = self._copy_node(
                child,
                soup,
                current_href,
                current_note_id=current_note_id,
            )
            if copied is None:
                continue
            if isinstance(copied, list):
                for item in copied:
                    destination.append(item)
            else:
                destination.append(copied)

    def _copy_node(
        self,
        source: NavigableString | Tag,
        soup: BeautifulSoup,
        current_href: str,
        *,
        current_note_id: Optional[str] = None,
    ) -> NavigableString | Tag | list[NavigableString | Tag] | None:
        if isinstance(source, NavigableString):
            return NavigableString(str(source))
        name = local_name(source).lower()
        if name in DROP_TAGS:
            return None

        epub_type = str(source.get("epub:type") or "")
        is_noteref = "noteref" in epub_type.split()
        if name == "sup" and source.find(attrs={"epub:type": lambda value: value and "noteref" in value.split()}):
            copied_children: list[NavigableString | Tag] = []
            for child in list(source.children):
                copied = self._copy_node(
                    child,
                    soup,
                    current_href,
                    current_note_id=current_note_id,
                )
                if isinstance(copied, list):
                    copied_children.extend(copied)
                elif copied is not None:
                    copied_children.append(copied)
            return copied_children

        if name in {"b", "i"}:
            name = "strong" if name == "b" else "em"
        if name == "span":
            style = str(source.get("style") or "").lower()
            if "font-weight" in style and "bold" in style:
                name = "strong"
            elif "font-style" in style and "italic" in style:
                name = "em"

        if name == "img":
            self.figure_counter += 1
            figure = self._new_tag(soup, "figure", **{"data-role": "figure", "id": f"fig-{self.figure_counter:03d}"})
            img_attrs: dict[str, str] = {"src": self._copy_asset(current_href, str(source.get("src") or ""))}
            if source.has_attr("alt"):
                img_attrs["alt"] = str(source.get("alt") or "")
            figure.append(self._new_tag(soup, "img", **img_attrs))
            return figure

        if name == "hr":
            return self._new_tag(soup, "div", **{"data-role": "separator"})

        if name == "table":
            self.table_counter += 1
            target = self._new_tag(
                soup,
                "table",
                **{"data-role": "table", "id": f"tbl-{self.table_counter:03d}"},
            )
        elif name == "a":
            attrs: dict[str, str] = {}
            if is_noteref and current_note_id:
                attrs["data-role"] = "backref"
            elif is_noteref:
                self.ref_counter += 1
                attrs["data-role"] = "noteref"
                attrs["id"] = f"ref-{self.ref_counter:05d}"
            elif source.get("id"):
                attrs["id"] = self.source_id_targets.get(
                    (current_href, str(source["id"])),
                    f"{PurePosixPath(current_href).stem}--{source['id']}",
                )
            source_href = str(source.get("href") or "")
            if source_href:
                rewritten, broken = self._rewrite_href(
                    current_href,
                    source_href,
                    current_note_id=current_note_id,
                    is_noteref=is_noteref,
                )
                attrs["href"] = rewritten
                if broken:
                    attrs["data-broken"] = "true"
                if EXTERNAL_LINK_RE.match(rewritten):
                    attrs["target"] = "_blank"
                    attrs["rel"] = "noopener noreferrer"
            target = self._new_tag(soup, "a", **attrs)
        else:
            allowed = {
                "p", "span", "div", "nav", "ol", "ul", "li", "dl", "dt", "dd",
                "blockquote", "strong", "em", "u", "s", "sup", "sub", "code", "pre",
                "br", "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption",
                "figure", "figcaption",
            }
            if name not in allowed:
                copied_children = []
                for child in list(source.children):
                    copied = self._copy_node(
                        child,
                        soup,
                        current_href,
                        current_note_id=current_note_id,
                    )
                    if isinstance(copied, list):
                        copied_children.extend(copied)
                    elif copied is not None:
                        copied_children.append(copied)
                return copied_children
            target = self._new_tag(soup, name)

        if name not in {"a", "table", "img"} and source.get("id"):
            target["id"] = self.source_id_targets.get(
                (current_href, str(source["id"])),
                f"{PurePosixPath(current_href).stem}--{source['id']}",
            )
        for attr in ("colspan", "rowspan", "start", "title"):
            if source.has_attr(attr):
                target[attr] = str(source.get(attr))
        self._copy_children(
            source,
            target,
            soup,
            current_href,
            current_note_id=current_note_id,
        )
        return target

    def _remove_empty_nodes(self, root: Tag) -> None:
        for tag in list(root.find_all(["p", "li", "td"])):
            if tag.get_text(strip=True) or tag.find(["img", "figure", "svg", "audio", "video"]):
                continue
            if tag.name == "p" and tag.find(id=True):
                continue
            tag.decompose()
        for tag in list(root.find_all(["div", "span"])):
            if tag.attrs:
                continue
            tag.unwrap()

    def _build_content_section(
        self,
        soup: BeautifulSoup,
        href: str,
        data_type: str,
        *,
        heading_level: int,
        require_heading: bool,
        source_children: Optional[list[NavigableString | Tag]] = None,
        section_id: Optional[str] = None,
    ) -> Tag:
        resolved_id = section_id or self.file_target_ids[href]
        section = self._new_tag(
            soup,
            "section",
            **{
                "id": resolved_id,
                "data-type": data_type,
                "data-src-file": PurePosixPath(href).name,
            },
        )
        body = self.docs[href].find("body") or self.docs[href]
        source_name = PurePosixPath(href).name
        subsection_level = min(heading_level + 1, 6)
        heading_index = 0
        subsection_index = 0
        # 章内出现第二个及以后的标题（本 fixture 里是说教内部的编号小节 1、2、3…）
        # 按 §4.2.3 首选建模：各自独立成 <section data-type="subsection">，标题即
        # 编号、带机械 id，随后的内容归入该 subsection。这样每个小节可锚点跳转、
        # 会进入下游 outline 目录（build_reading_nodes 只枚举 section[data-type]）。
        current_target: Tag = section
        for child in source_children if source_children is not None else list(body.children):
            if isinstance(child, Tag) and HEADING_RE.match(local_name(child).lower()):
                heading_index += 1
                if heading_index == 1:
                    heading = self._new_tag(soup, f"h{heading_level}")
                    if child.get("id") and section_id != self.source_id_targets.get(
                        (href, str(child["id"]))
                    ):
                        heading["id"] = self.source_id_targets[(href, str(child["id"]))]
                    self._copy_children(child, heading, soup, href)
                    section.append(heading)
                    current_target = section
                else:
                    subsection_index += 1
                    subsection = self._new_tag(
                        soup,
                        "section",
                        **{
                            "id": f"{resolved_id}-sub-{subsection_index:03d}",
                            "data-type": "subsection",
                            "data-src-file": source_name,
                        },
                    )
                    sub_heading = self._new_tag(soup, f"h{subsection_level}")
                    if child.get("id"):
                        sub_heading["id"] = self.source_id_targets[(href, str(child["id"]))]
                    self._copy_children(child, sub_heading, soup, href)
                    subsection.append(sub_heading)
                    section.append(subsection)
                    current_target = subsection
                continue
            copied = self._copy_node(child, soup, href)
            if isinstance(copied, list):
                for item in copied:
                    current_target.append(item)
            elif copied is not None:
                current_target.append(copied)

        self._remove_empty_nodes(section)
        first_tag = next((child for child in section.children if isinstance(child, Tag)), None)
        if require_heading and (first_tag is None or first_tag.name != f"h{heading_level}"):
            raise ValueError(f"body document {href} does not start with a usable heading")
        return section

    def _body_href(self, number: int) -> str:
        return f"Text/part{number:04d}.xhtml"

    def _build_first_part(self, soup: BeautifulSoup) -> Tag:
        part = self._build_content_section(
            soup,
            self._body_href(6),
            "part",
            heading_level=2,
            require_heading=True,
        )
        part.append(
            self._build_content_section(
                soup,
                self._body_href(7),
                "chapter",
                heading_level=3,
                require_heading=True,
            )
        )

        group_href = self._body_href(8)
        group_body = self.docs[group_href].find("body") or self.docs[group_href]
        source_children = list(group_body.children)
        heading_positions = [
            index
            for index, child in enumerate(source_children)
            if isinstance(child, Tag) and HEADING_RE.match(local_name(child).lower())
        ]
        if len(heading_positions) < 2:
            raise ValueError("part0008 must contain its chapter and first section headings")
        split_at = heading_positions[1]
        group = self._build_content_section(
            soup,
            group_href,
            "chapter",
            heading_level=3,
            require_heading=True,
            source_children=source_children[:split_at],
        )
        first_section_id = self.source_id_targets[(group_href, "sigil_toc_id_1")]
        group.append(
            self._build_content_section(
                soup,
                group_href,
                "section",
                heading_level=4,
                require_heading=True,
                source_children=source_children[split_at:],
                section_id=first_section_id,
            )
        )
        for number in range(9, 30):
            group.append(
                self._build_content_section(
                    soup,
                    self._body_href(number),
                    "section",
                    heading_level=4,
                    require_heading=True,
                )
            )
        part.append(group)
        return part

    def _build_bodymatter(self, soup: BeautifulSoup) -> Tag:
        bodymatter = self._new_tag(
            soup,
            "section",
            **{"data-role": "bodymatter", "id": "bodymatter"},
        )
        book = self._build_content_section(
            soup,
            self._body_href(5),
            "book",
            heading_level=1,
            require_heading=True,
        )
        book.append(self._build_first_part(soup))
        for part_href, chapter_numbers in PART_CHAPTER_RANGES.items():
            part = self._build_content_section(
                soup,
                part_href,
                "part",
                heading_level=2,
                require_heading=True,
            )
            for number in chapter_numbers:
                part.append(
                    self._build_content_section(
                        soup,
                        self._body_href(number),
                        "chapter",
                        heading_level=3,
                        require_heading=True,
                    )
                )
            book.append(part)
        bodymatter.append(book)
        return bodymatter

    def _build_notes(self, soup: BeautifulSoup) -> Tag:
        notes = self._new_tag(soup, "section", **{"data-role": "notes", "id": "book-notes"})
        source_doc = self.docs[NOTES_HREF]
        body = source_doc.find("body") or source_doc
        source_heading = body.find(HEADING_RE)
        if source_heading:
            heading = self._new_tag(soup, "h1")
            self._copy_children(source_heading, heading, soup, NOTES_HREF)
            notes.append(heading)

        source_notes = source_doc.find_all(
            attrs={"epub:type": lambda value: value and "rearnote" in value.split()}
        )
        for index, source_note in enumerate(source_notes, start=1):
            note_id = f"note-{index:04d}"
            note = self._new_tag(
                soup,
                "div",
                **{"data-role": "note", "data-note-kind": "endnote", "id": note_id},
            )
            self._copy_children(
                source_note,
                note,
                soup,
                NOTES_HREF,
                current_note_id=note_id,
            )
            self._remove_empty_nodes(note)
            notes.append(note)
        return notes

    def _toc_target(self, src: str) -> str:
        path, separator, fragment = src.partition("#")
        href = posixpath.normpath(posixpath.join(posixpath.dirname(self.ncx_href), path))
        if separator:
            target = self.source_id_targets.get((href, fragment))
        else:
            target = self.file_target_ids.get(href)
        if not target:
            raise ValueError(f"NCX target cannot be resolved: {src}")
        return target

    def _build_toc_list(self, soup: BeautifulSoup, entries: list[TocEntry]) -> Tag:
        ordered = self._new_tag(soup, "ol")
        for entry in entries:
            item = self._new_tag(soup, "li")
            anchor = self._new_tag(soup, "a", href=f"#{self._toc_target(entry.src)}")
            anchor.append(NavigableString(entry.label))
            item.append(anchor)
            if entry.children:
                item.append(self._build_toc_list(soup, entry.children))
            ordered.append(item)
        return ordered

    def _append_source_navigation_labels(self, soup: BeautifulSoup, toc: Tag) -> None:
        source_doc = self.docs["Text/part0000.xhtml"]
        source_navs = source_doc.find_all("nav")
        if source_navs:
            heading = source_navs[0].find(HEADING_RE)
            if heading:
                copied_heading = self._new_tag(soup, "h1")
                self._copy_children(heading, copied_heading, soup, "Text/part0000.xhtml")
                toc.append(copied_heading)
        toc.append(self._build_toc_list(soup, self.toc_entries))
        for source_nav in source_navs[1:]:
            for source_node in source_nav.find_all([HEADING_RE, "a"]):
                paragraph = self._new_tag(soup, "p")
                paragraph.append(NavigableString(source_node.get_text(" ", strip=True)))
                if paragraph.get_text(strip=True):
                    toc.append(paragraph)

    def _build_html(self) -> bytes:
        soup = self._new_soup()
        html = self._new_tag(soup, "html", lang=self.language)
        head = self._new_tag(soup, "head")
        head.append(self._new_tag(soup, "meta", charset="utf-8"))
        title = self._new_tag(soup, "title")
        title.append(NavigableString(self.title))
        head.append(title)
        head.append(self._new_tag(soup, "meta", name="normalized-spec", content="nb-1.0"))
        head.append(self._new_tag(soup, "meta", name="source-format", content="epub"))
        html.append(head)
        body = self._new_tag(soup, "body")
        main = self._new_tag(soup, "main", id="book", **{"data-type": "book"})

        toc = self._new_tag(soup, "nav", **{"data-role": "toc", "id": "toc"})
        self._append_source_navigation_labels(soup, toc)
        main.append(toc)

        frontmatter = self._new_tag(soup, "section", **{"data-role": "frontmatter", "id": "frontmatter"})
        for href, data_type in FRONTMATTER_TYPES.items():
            frontmatter.append(
                self._build_content_section(
                    soup,
                    href,
                    data_type,
                    heading_level=1,
                    require_heading=False,
                )
            )
        main.append(frontmatter)

        main.append(self._build_bodymatter(soup))

        backmatter = self._new_tag(soup, "section", **{"data-role": "backmatter", "id": "backmatter"})
        for href, data_type in BACKMATTER_TYPES.items():
            backmatter.append(
                self._build_content_section(
                    soup,
                    href,
                    data_type,
                    heading_level=1,
                    require_heading=False,
                )
            )
        main.append(backmatter)
        main.append(self._build_notes(soup))
        body.append(main)
        html.append(body)
        soup.append(html)
        return ("<!doctype html>\n" + str(soup) + "\n").encode("utf-8")

    def normalize(self) -> dict[str, object]:
        self.output_dir.mkdir(parents=True, exist_ok=True)
        assets_dir = self.output_dir / "assets"
        if assets_dir.exists():
            shutil.rmtree(assets_dir)
        self.asset_records.clear()
        cover_path = self._copy_cover_asset()
        html_bytes = self._build_html()
        html_path = self.output_dir / "book.normalized.html"
        html_path.write_bytes(html_bytes)

        # metadata.json is the single source of truth for bibliographic metadata
        # (see packages/normalized-book/src/metadata.ts parseBookMetadata).
        metadata: dict[str, object] = {
            "title": self.title,
            "authors": self.authors,
            "language": self.language,
            "cover_path": cover_path,
            "identifiers": self.identifiers,
            "publisher": self.publisher,
            "published_date": self.published_date,
            "source_filename": self.input_epub.name,
        }
        (self.output_dir / "metadata.json").write_text(
            stable_json(metadata),
            encoding="utf-8",
        )

        output_soup = BeautifulSoup(html_bytes, "html.parser")
        report: dict[str, object] = {
            "normalizer": "normalize_fixed_epub.py",
            "normalized_spec": "nb-1.0",
            "source": {
                "filename": self.input_epub.name,
                "sha256": sha256_bytes(self.input_epub.read_bytes()),
                "spine_documents": len(self.spine_hrefs),
                "toc_entries": EXPECTED_TOC_ENTRIES,
                "noterefs": EXPECTED_NOTEREFS,
                "forward_noterefs": EXPECTED_FORWARD_NOTEREFS,
                "backrefs": EXPECTED_BACKREFS,
                "notes": EXPECTED_NOTES,
                "image_references": EXPECTED_IMAGE_REFS,
            },
            "output": {
                "html": "book.normalized.html",
                "html_sha256": sha256_bytes(html_bytes),
                "toc_entries": len(output_soup.select('nav[data-role="toc"] a')),
                "noterefs": len(output_soup.select('[data-role="noteref"]')),
                "backrefs": len(output_soup.select('[data-role="backref"]')),
                "broken_internal_links": len(output_soup.select('[data-broken="true"]')),
                "notes": len(output_soup.select('[data-role="note"]')),
                "image_references": len(output_soup.find_all("img")),
                "assets": [self.asset_records[name] for name in sorted(self.asset_records)],
            },
        }
        (self.output_dir / "normalization_report.json").write_text(
            stable_json(report),
            encoding="utf-8",
        )
        return report


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Normalize fixtures/fixed_input.epub to nb-1.0")
    parser.add_argument("input_epub", type=Path)
    parser.add_argument("output_dir", type=Path)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    normalizer = FixedEpubNormalizer(args.input_epub, args.output_dir)
    report = normalizer.normalize()
    print(stable_json(report), end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
