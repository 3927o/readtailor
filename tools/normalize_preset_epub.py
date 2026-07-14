#!/usr/bin/env python3
"""Deterministically normalize the preset demo EPUBs to nb-1.0.

Like tools/normalize_fixed_epub.py this is intentionally a *known-input*
normalizer, not a general one: each supported book carries a small explicit
plan (spine classification + structure mode + note markup), selected by the
OPF dc:title. Everything else — target skeleton, link rewriting, asset
copying, note relocation, TOC building — is shared, deterministic code with
no model in the loop. Adding another preset book means adding a plan entry
and verifying `nb_check.py --baseline` stays green.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import posixpath
import re
import warnings
import zipfile
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath
from typing import Iterable, Optional
from urllib.parse import unquote

from bs4 import BeautifulSoup, NavigableString, Tag, XMLParsedAsHTMLWarning

warnings.filterwarnings("ignore", category=XMLParsedAsHTMLWarning)

DROP_TAGS = {"script", "style", "iframe", "object", "embed", "link", "meta", "title"}
HEADING_RE = re.compile(r"^h[1-6]$")
EXTERNAL_LINK_RE = re.compile(r"^(?:https?|mailto|tel):", re.I)

FRONT = "frontmatter"
BODY = "bodymatter"
BACK = "backmatter"


@dataclass
class FilePlan:
    """How one linear-spine document maps into the target skeleton."""

    region: str  # frontmatter | bodymatter | backmatter
    mode: str  # cover | single | h2split | h1h2split
    dtype: Optional[str] = None  # data-type for single/cover modes
    notes: bool = False  # extract note bodies from this document


@dataclass
class BookPlan:
    key: str
    files: dict[str, FilePlan]  # spine basename -> plan
    note_body_selector: Optional[str] = None  # CSS selector for note-body blocks


PLANS: dict[str, BookPlan] = {
    "局外人": BookPlan(
        key="juwairen",
        note_body_selector="p.note",
        files={
            "coverpage.html": FilePlan(FRONT, "cover", "titlepage"),
            "front001.html": FilePlan(FRONT, "single", "colophon"),
            "front002.html": FilePlan(FRONT, "single", "foreword", notes=True),
            **{f"chapter{i:03d}.html": FilePlan(BODY, "h1h2split") for i in range(1, 12)},
        },
    ),
    "菊与刀": BookPlan(
        key="juyudao",
        files={
            "coverpage.xhtml": FilePlan(FRONT, "cover", "titlepage"),
            "titlepage.xhtml": FilePlan(FRONT, "single", "titlepage"),
            "copyrightpage.xhtml": FilePlan(FRONT, "single", "colophon"),
            "Section0001.xhtml": FilePlan(FRONT, "single", "epigraph"),
            **{
                f"Section0002_{i:04d}.xhtml": FilePlan(BODY, "single", "chapter")
                for i in range(1, 14)
            },
            "Section0003.xhtml": FilePlan(BACK, "single", "abstract"),
            "Section0004.xhtml": FilePlan(BACK, "single", "afterword"),
            "guomaipage.xhtml": FilePlan(BACK, "single", "colophon"),
        },
    ),
    "呐喊": BookPlan(
        key="nahan",
        note_body_selector="p.note",
        files={
            "cover.xhtml": FilePlan(FRONT, "cover", "titlepage"),
            "copyright.xhtml": FilePlan(FRONT, "single", "colophon"),
            "perface1.xhtml": FilePlan(FRONT, "single", "preface", notes=True),
            **{
                f"chapter{i}.xhtml": FilePlan(BODY, "h2split", "chapter", notes=True)
                for i in range(1, 15)
            },
            "perface2.xhtml": FilePlan(BACK, "single", "afterword"),
        },
    ),
}


def local_name(tag: Tag) -> str:
    return tag.name.split(":")[-1]


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def stable_json(data: object) -> str:
    return json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True) + "\n"


def visible_text(node: Tag | NavigableString) -> str:
    if isinstance(node, NavigableString):
        return str(node)
    return node.get_text()


def has_visible_text(node: Tag | NavigableString) -> bool:
    return bool(visible_text(node).strip())


@dataclass
class TocEntry:
    label: str
    href: str  # package-relative document path
    fragment: str
    children: list["TocEntry"] = field(default_factory=list)


class PresetEpubNormalizer:
    def __init__(self, input_epub: Path, output_dir: Path):
        self.input_epub = input_epub.resolve()
        self.output_dir = output_dir.resolve()
        self.zip = zipfile.ZipFile(self.input_epub)
        self.opf_path = self._find_opf()
        self.opf_dir = posixpath.dirname(self.opf_path)

        self.title = ""
        self.language = "und"
        self.authors: list[str] = []
        self.identifiers: dict[str, str] = {}
        self.publisher: Optional[str] = None
        self.published_date: Optional[str] = None
        self.cover_href: Optional[str] = None
        self.ncx_href: Optional[str] = None
        self.nav_href: Optional[str] = None

        self.manifest: dict[str, tuple[str, str, str]] = {}
        self.spine_hrefs: list[str] = []
        self.docs: dict[str, BeautifulSoup] = {}

        self._read_package()
        plan = PLANS.get(self.title.strip())
        if plan is None:
            raise ValueError(
                f"no preset plan for dc:title={self.title!r}; "
                f"supported: {sorted(PLANS)}"
            )
        self.plan = plan

        # link/id bookkeeping
        self.referenced_ids: dict[str, set[str]] = {}  # href -> ids referenced by hrefs
        self.source_id_targets: dict[tuple[str, str], str] = {}
        self.file_target_ids: dict[str, str] = {}
        self.note_source_ids: dict[tuple[str, str], str] = {}  # (href, id) -> note id
        self.forward_ref_ids: dict[tuple[str, str], str] = {}  # (href, a id) -> ref id
        self.note_bodies: list[tuple[str, Tag, str]] = []  # (href, block, note_id)

        # output state
        self.soup = BeautifulSoup("", "html.parser")
        self.ref_counter = 0
        self.figure_counter = 0
        self.table_counter = 0
        self.type_counters: dict[str, int] = {}
        self.asset_records: dict[str, dict[str, object]] = {}
        self.section_source_ids: dict[str, set[tuple[str, str]]] = {}
        self.file_first_section: dict[str, str] = {}
        self.current_section_id: Optional[str] = None
        self.broken_links = 0

    # ------------------------------------------------------------------ package

    def _read(self, path: str) -> bytes:
        return self.zip.read(path)

    def _parse(self, data: bytes) -> BeautifulSoup:
        return BeautifulSoup(data, "html.parser")

    def _find_opf(self) -> str:
        container = self._parse(self._read("META-INF/container.xml"))
        rootfile = container.find(
            lambda tag: isinstance(tag, Tag) and local_name(tag) == "rootfile"
        )
        if not rootfile or not rootfile.get("full-path"):
            raise ValueError("EPUB container does not identify an OPF package")
        return str(rootfile["full-path"])

    def _package_path(self, href: str) -> str:
        return posixpath.normpath(posixpath.join(self.opf_dir, unquote(href)))

    def _read_package(self) -> None:
        opf = self._parse(self._read(self.opf_path))

        def meta_text(name: str) -> Optional[str]:
            node = opf.find(lambda tag: isinstance(tag, Tag) and local_name(tag) == name)
            text = node.get_text(strip=True) if node else ""
            return text or None

        self.title = meta_text("title") or ""
        self.language = meta_text("language") or "und"
        self.publisher = meta_text("publisher")
        self.published_date = meta_text("date")
        self.authors = [
            node.get_text(strip=True)
            for node in opf.find_all(
                lambda tag: isinstance(tag, Tag) and local_name(tag) == "creator"
            )
            if node.get_text(strip=True)
        ]

        for identifier in opf.find_all(
            lambda tag: isinstance(tag, Tag) and local_name(tag) == "identifier"
        ):
            value = identifier.get_text(strip=True)
            if not value:
                continue
            scheme = str(
                identifier.get("opf:scheme") or identifier.get("scheme") or ""
            ).lower()
            if value.lower().startswith("urn:isbn:"):
                key, value = "isbn", value[len("urn:isbn:"):]
            elif scheme == "isbn" or (scheme == "" and re.fullmatch(r"97[89]\d{10}", value)):
                key = "isbn"
            elif scheme:
                key = scheme
            elif identifier.get("id"):
                key = str(identifier["id"])
            else:
                key = f"identifier_{len(self.identifiers) + 1}"
            if key in self.identifiers and self.identifiers[key] != value:
                key = f"{key}_{len(self.identifiers) + 1}"
            self.identifiers[key] = value

        cover_meta = opf.find(
            "meta", attrs={"name": lambda v: v and str(v).lower() == "cover"}
        )
        cover_ref = str(cover_meta.get("content") or "") if cover_meta else ""

        for item in opf.find_all(lambda tag: isinstance(tag, Tag) and local_name(tag) == "item"):
            item_id, href = item.get("id"), item.get("href")
            if not item_id or not href:
                continue
            media_type = str(item.get("media-type") or "")
            properties = str(item.get("properties") or "")
            self.manifest[str(item_id)] = (str(href), media_type, properties)
            if "dtbncx" in media_type:
                self.ncx_href = str(href)
            if "nav" in properties.split():
                self.nav_href = str(href)
            if cover_ref and str(item_id) == cover_ref:
                self.cover_href = str(href)

        # some producers put the cover *filename* (not the item id) into the meta
        if cover_ref and not self.cover_href:
            for href, media_type, _ in self.manifest.values():
                if PurePosixPath(href).name == cover_ref and media_type.startswith("image/"):
                    self.cover_href = href
                    break

        for itemref in opf.find_all(
            lambda tag: isinstance(tag, Tag) and local_name(tag) == "itemref"
        ):
            if str(itemref.get("linear") or "yes").lower() == "no":
                continue
            entry = self.manifest.get(str(itemref.get("idref") or ""))
            if not entry:
                continue
            href = entry[0]
            self.spine_hrefs.append(href)
            self.docs[href] = self._parse(self._read(self._package_path(href)))

    # ------------------------------------------------------------------ TOC source

    def _read_toc_entries(self) -> list[TocEntry]:
        if self.nav_href:
            nav_doc = self._parse(self._read(self._package_path(self.nav_href)))
            nav = None
            for candidate in nav_doc.find_all("nav"):
                if "toc" in str(candidate.get("epub:type") or ""):
                    nav = candidate
                    break
            nav = nav or nav_doc.find("nav")
            if nav is None:
                raise ValueError("EPUB3 nav document has no <nav>")
            nav_dir = posixpath.dirname(self.nav_href)

            def parse_list(list_tag: Tag) -> list[TocEntry]:
                entries = []
                for li in list_tag.find_all("li", recursive=False):
                    anchor = li.find("a", recursive=False) or li.find("a")
                    if not anchor:
                        continue
                    raw = unquote(str(anchor.get("href") or ""))
                    path, _, fragment = raw.partition("#")
                    href = (
                        posixpath.normpath(posixpath.join(nav_dir, path)) if path else ""
                    )
                    child_list = li.find(["ol", "ul"], recursive=False)
                    entries.append(
                        TocEntry(
                            label=anchor.get_text(strip=True),
                            href=href,
                            fragment=fragment,
                            children=parse_list(child_list) if child_list else [],
                        )
                    )
                return entries

            top = nav.find(["ol", "ul"], recursive=False) or nav.find(["ol", "ul"])
            return parse_list(top) if top else []

        if not self.ncx_href:
            return []
        ncx = self._parse(self._read(self._package_path(self.ncx_href)))
        nav_map = ncx.find(lambda tag: isinstance(tag, Tag) and local_name(tag) == "navmap")
        if not nav_map:
            return []
        ncx_dir = posixpath.dirname(self.ncx_href)

        def parse_point(nav_point: Tag) -> TocEntry:
            label_node = nav_point.find(
                lambda tag: isinstance(tag, Tag) and local_name(tag) == "navlabel",
                recursive=False,
            )
            text_node = (
                label_node.find(lambda tag: isinstance(tag, Tag) and local_name(tag) == "text")
                if label_node
                else None
            )
            content = nav_point.find(
                lambda tag: isinstance(tag, Tag) and local_name(tag) == "content",
                recursive=False,
            )
            raw = unquote(str(content.get("src") or "")) if content else ""
            path, _, fragment = raw.partition("#")
            href = posixpath.normpath(posixpath.join(ncx_dir, path)) if path else ""
            return TocEntry(
                label=text_node.get_text(strip=True) if text_node else "",
                href=href,
                fragment=fragment,
                children=[
                    parse_point(child)
                    for child in nav_point.find_all(
                        lambda tag: isinstance(tag, Tag) and local_name(tag) == "navpoint",
                        recursive=False,
                    )
                ],
            )

        return [
            parse_point(nav_point)
            for nav_point in nav_map.find_all(
                lambda tag: isinstance(tag, Tag) and local_name(tag) == "navpoint",
                recursive=False,
            )
        ]

    # ------------------------------------------------------------------ pass 1: survey

    def _plan_for(self, href: str) -> FilePlan:
        plan = self.plan.files.get(PurePosixPath(href).name)
        if plan is None:
            raise ValueError(f"linear spine document {href!r} has no preset plan entry")
        return plan

    def _survey(self) -> None:
        """Collect referenced ids, note bodies and note-target maps before copying."""
        for href in self.spine_hrefs:
            doc = self.docs[href]
            for anchor in doc.find_all("a", href=True):
                raw = str(anchor["href"])
                if EXTERNAL_LINK_RE.match(raw):
                    continue
                target_href, fragment = self._resolve_internal(href, raw)
                if fragment:
                    self.referenced_ids.setdefault(target_href, set()).add(fragment)

        note_index = 0
        selector = self.plan.note_body_selector
        for href in self.spine_hrefs:
            if not selector or not self._plan_for(href).notes:
                continue
            doc = self.docs[href]
            for block in doc.select(selector):
                note_index += 1
                note_id = f"note-{note_index:04d}"
                self.note_bodies.append((href, block, note_id))
                for element in [block, *block.find_all(id=True)]:
                    source_id = str(element.get("id") or "")
                    if source_id:
                        self.note_source_ids[(href, source_id)] = note_id
                block.extract()

    # ------------------------------------------------------------------ link rewriting

    def _resolve_internal(self, current_href: str, raw: str) -> tuple[str, str]:
        decoded = unquote(raw)
        path, separator, fragment = decoded.partition("#")
        if path:
            target = posixpath.normpath(
                posixpath.join(posixpath.dirname(current_href), path)
            )
        else:
            target = current_href
        return target, fragment if separator else ""

    def _mapped_id(self, href: str, source_id: str) -> str:
        return f"{PurePosixPath(href).stem}--{source_id}"

    def _rewrite_href(self, current_href: str, raw: str) -> tuple[str, bool]:
        """Return (href, broken)."""
        if EXTERNAL_LINK_RE.match(raw):
            return raw, False
        target_href, fragment = self._resolve_internal(current_href, raw)
        if fragment:
            note_target = self.note_source_ids.get((target_href, fragment))
            if note_target:
                return f"#{note_target}", False
            mapped = self.source_id_targets.get((target_href, fragment))
            if mapped:
                return f"#{mapped}", False
            return raw, True
        first_section = self.file_first_section.get(target_href)
        if first_section:
            return f"#{first_section}", False
        return raw, True

    # ------------------------------------------------------------------ assets

    def _copy_asset_data(self, data: bytes, basename: str) -> str:
        digest = sha256_bytes(data)
        output_name = basename
        existing = self.asset_records.get(output_name)
        if existing and existing["sha256"] != digest:
            stem, suffix = PurePosixPath(basename).stem, PurePosixPath(basename).suffix
            output_name = f"{stem}-{digest[:12]}{suffix}"
        assets_dir = self.output_dir / "assets"
        assets_dir.mkdir(parents=True, exist_ok=True)
        (assets_dir / output_name).write_bytes(data)
        record = self.asset_records.setdefault(
            output_name,
            {
                "path": f"assets/{output_name}",
                "sha256": digest,
                "size_bytes": len(data),
                "references": 0,
            },
        )
        record["references"] = int(record["references"]) + 1
        return f"assets/{output_name}"

    def _copy_asset(self, current_href: str, src: str) -> str:
        source_path, _, _ = unquote(src).partition("#")
        package_path = posixpath.normpath(
            posixpath.join(
                self.opf_dir, posixpath.dirname(current_href), source_path
            )
        )
        return self._copy_asset_data(self._read(package_path), PurePosixPath(source_path).name)

    def _copy_cover_asset(self) -> Optional[str]:
        candidates = [self.cover_href] if self.cover_href else []
        # producers sometimes declare a cover file that is absent from the
        # archive; fall back to any packaged image named like a cover
        candidates += [
            href
            for href, media_type, _ in sorted(self.manifest.values())
            if media_type.startswith("image/")
            and "cover" in PurePosixPath(href).name.lower()
        ]
        data: Optional[bytes] = None
        for candidate in candidates:
            try:
                data = self._read(self._package_path(candidate))
            except KeyError:
                continue
            self.cover_href = candidate
            break
        if data is None:
            return None
        output_name = PurePosixPath(self.cover_href).name
        digest = sha256_bytes(data)
        existing = self.asset_records.get(output_name)
        if existing:
            if existing["sha256"] == digest:
                return str(existing["path"])
            output_name = f"{PurePosixPath(output_name).stem}-{digest[:12]}{PurePosixPath(output_name).suffix}"
        assets_dir = self.output_dir / "assets"
        assets_dir.mkdir(parents=True, exist_ok=True)
        (assets_dir / output_name).write_bytes(data)
        self.asset_records[output_name] = {
            "path": f"assets/{output_name}",
            "sha256": digest,
            "size_bytes": len(data),
            "references": 0,
        }
        return f"assets/{output_name}"

    # ------------------------------------------------------------------ node copying

    def _new_tag(self, tag_name: str, **attrs: str) -> Tag:
        return self.soup.new_tag(tag_name, attrs=attrs)

    def _register_source_id(self, current_href: str, element: Tag, target: Tag) -> None:
        source_id = str(element.get("id") or "")
        if not source_id:
            return
        if (current_href, source_id) in self.note_source_ids:
            return  # note anchors are renumbered, never carried over
        if source_id not in self.referenced_ids.get(current_href, set()):
            return  # unreferenced source ids are dropped for cleanliness
        mapped = self._mapped_id(current_href, source_id)
        self.source_id_targets[(current_href, source_id)] = mapped
        target["id"] = mapped
        if self.current_section_id:
            self.section_source_ids.setdefault(self.current_section_id, set()).add(
                (current_href, source_id)
            )

    def _img_is_inline(self, source: Tag) -> bool:
        parent = source.parent
        if not isinstance(parent, Tag) or parent.name not in {"p", "span", "a", "code"}:
            return False
        text = "".join(
            str(child)
            for child in parent.children
            if isinstance(child, NavigableString)
        )
        if text.strip():
            return True
        return any(
            isinstance(child, Tag) and child is not source and has_visible_text(child)
            for child in parent.children
        )

    def _copy_img(self, source: Tag, current_href: str, *, force_figure: bool = False) -> Tag:
        attrs: dict[str, str] = {
            "src": self._copy_asset(current_href, str(source.get("src") or ""))
        }
        if source.has_attr("alt"):
            attrs["alt"] = str(source.get("alt") or "")
        img = self._new_tag("img", **attrs)
        if not force_figure and self._img_is_inline(source):
            return img
        self.figure_counter += 1
        figure = self._new_tag(
            "figure", **{"data-role": "figure", "id": f"fig-{self.figure_counter:03d}"}
        )
        figure.append(img)
        return figure

    def _copy_children_into(
        self, source: Tag, destination: Tag, current_href: str, *, in_note: bool = False
    ) -> None:
        for child in list(source.children):
            copied = self._copy_node(child, current_href, in_note=in_note)
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
        current_href: str,
        *,
        in_note: bool = False,
    ) -> NavigableString | Tag | list[NavigableString | Tag] | None:
        if isinstance(source, NavigableString):
            if source.parent and source.parent.name in {"script", "style"}:
                return None
            return NavigableString(str(source))
        name = local_name(source).lower()
        if name in DROP_TAGS:
            return None

        if name == "svg":
            # preset covers only: pull the raster image out of the svg wrapper
            image = source.find(lambda t: isinstance(t, Tag) and local_name(t) == "image")
            ref = str(image.get("xlink:href") or image.get("href") or "") if image else ""
            if ref:
                img = self._new_tag("img", src=self._copy_asset(current_href, ref))
                self.figure_counter += 1
                figure = self._new_tag(
                    "figure",
                    **{"data-role": "figure", "id": f"fig-{self.figure_counter:03d}"},
                )
                figure.append(img)
                return figure
            return None

        if name in {"b", "i"}:
            name = "strong" if name == "b" else "em"
        if name == "span":
            style = str(source.get("style") or "").lower()
            if "font-weight" in style and "bold" in style:
                name = "strong"
            elif "font-style" in style and "italic" in style:
                name = "em"

        if name == "img":
            return self._copy_img(source, current_href)

        if name == "hr":
            return self._new_tag("div", **{"data-role": "separator"})

        if name == "sup":
            # unwrap <sup> that only decorates a noteref anchor (§10.1)
            children = [c for c in source.children if not (isinstance(c, NavigableString) and not str(c).strip())]
            if len(children) == 1 and isinstance(children[0], Tag) and children[0].name == "a":
                inner = children[0]
                raw = str(inner.get("href") or "")
                if raw:
                    target_href, fragment = self._resolve_internal(current_href, raw)
                    if (target_href, fragment) in self.note_source_ids:
                        return self._copy_node(inner, current_href, in_note=in_note)

        if name == "a":
            raw = str(source.get("href") or "")
            source_id = str(source.get("id") or "")
            if raw:
                target_href, fragment = self._resolve_internal(current_href, raw)
                if EXTERNAL_LINK_RE.match(raw):
                    anchor = self._new_tag(
                        "a", href=raw, target="_blank", rel="noopener noreferrer"
                    )
                    self._copy_children_into(source, anchor, current_href, in_note=in_note)
                    return anchor
                note_target = (
                    self.note_source_ids.get((target_href, fragment)) if fragment else None
                )
                if note_target and not in_note:
                    self.ref_counter += 1
                    ref_id = f"ref-{self.ref_counter:05d}"
                    if source_id and (current_href, source_id) not in self.forward_ref_ids:
                        self.forward_ref_ids[(current_href, source_id)] = ref_id
                    anchor = self._new_tag(
                        "a",
                        **{
                            "data-role": "noteref",
                            "href": f"#{note_target}",
                            "id": ref_id,
                        },
                    )
                    self._copy_children_into(source, anchor, current_href, in_note=in_note)
                    return anchor
                if in_note and fragment:
                    ref_target = self.forward_ref_ids.get((target_href, fragment))
                    if ref_target:
                        anchor = self._new_tag(
                            "a", **{"data-role": "backref", "href": f"#{ref_target}"}
                        )
                        self._copy_children_into(source, anchor, current_href, in_note=in_note)
                        return anchor
                    if (target_href, fragment) in self.note_source_ids or (
                        current_href,
                        fragment,
                    ) in self.note_source_ids:
                        # intra-note plumbing anchor with no forward ref — drop shell
                        pieces: list[NavigableString | Tag] = []
                        for child in list(source.children):
                            copied = self._copy_node(child, current_href, in_note=in_note)
                            if isinstance(copied, list):
                                pieces.extend(copied)
                            elif copied is not None:
                                pieces.append(copied)
                        return pieces
                new_href, broken = self._rewrite_href(current_href, raw)
                attrs = {"href": new_href}
                if broken:
                    attrs["data-broken"] = "true"
                    self.broken_links += 1
                anchor = self._new_tag("a", **attrs)
                self._register_source_id(current_href, source, anchor)
                self._copy_children_into(source, anchor, current_href, in_note=in_note)
                if not has_visible_text(anchor) and not anchor.find("img"):
                    return None
                return anchor
            # anchor without href: keep only as an id trampoline
            if source_id and source_id in self.referenced_ids.get(current_href, set()) and (
                (current_href, source_id) not in self.note_source_ids
            ):
                span = self._new_tag("span")
                self._register_source_id(current_href, source, span)
                pieces: list[NavigableString | Tag] = [span]
                for child in list(source.children):
                    copied = self._copy_node(child, current_href, in_note=in_note)
                    if isinstance(copied, list):
                        pieces.extend(copied)
                    elif copied is not None:
                        pieces.append(copied)
                return pieces
            if not has_visible_text(source) and not source.find("img"):
                return None
            pieces = []
            for child in list(source.children):
                copied = self._copy_node(child, current_href, in_note=in_note)
                if isinstance(copied, list):
                    pieces.extend(copied)
                elif copied is not None:
                    pieces.append(copied)
            return pieces

        if name == "table":
            self.table_counter += 1
            table = self._new_tag(
                "table", **{"data-role": "table", "id": f"tbl-{self.table_counter:03d}"}
            )
            self._copy_children_into(source, table, current_href, in_note=in_note)
            if not table.find("tbody"):
                tbody = self._new_tag("tbody")
                for row in list(table.find_all("tr", recursive=False)):
                    tbody.append(row.extract())
                table.append(tbody)
            return table

        if name in {"div", "span"}:
            # potential unwrap: copy children, decide by surviving attributes
            keep_id = str(source.get("id") or "") in self.referenced_ids.get(
                current_href, set()
            ) and (current_href, str(source.get("id") or "")) not in self.note_source_ids
            pieces = []
            if keep_id:
                span = self._new_tag("span")
                self._register_source_id(current_href, source, span)
                pieces.append(span)
            for child in list(source.children):
                copied = self._copy_node(child, current_href, in_note=in_note)
                if isinstance(copied, list):
                    pieces.extend(copied)
                elif copied is not None:
                    pieces.append(copied)
            return pieces or None

        if name == "p":
            paragraph = self._new_tag("p")
            self._register_source_id(current_href, source, paragraph)
            self._copy_children_into(source, paragraph, current_href, in_note=in_note)
            if not has_visible_text(paragraph):
                media = paragraph.find(["img", "figure"])
                if media is None:
                    return None
                # image-only paragraph: promote the figure out of the <p>
                return [
                    child.extract()
                    for child in list(paragraph.children)
                    if isinstance(child, Tag) and child.name in {"figure", "img"}
                ]
            return self._split_paragraph_on_br_runs(paragraph)

        if name == "br":
            return self._new_tag("br")

        allowed_attrs: dict[str, tuple[str, ...]] = {
            "ol": ("start",),
            "td": ("rowspan", "colspan"),
            "th": ("rowspan", "colspan"),
        }
        if name in {
            "ul", "ol", "li", "dl", "dt", "dd", "blockquote", "figure", "figcaption",
            "caption", "thead", "tbody", "tfoot", "tr", "td", "th", "pre", "code",
            "strong", "em", "u", "s", "sup", "sub", "br", "cite", "q",
            "h1", "h2", "h3", "h4", "h5", "h6",
        }:
            attrs = {
                key: str(source.get(key))
                for key in allowed_attrs.get(name, ())
                if source.get(key) is not None
            }
            element = self._new_tag(name, **attrs)
            self._register_source_id(current_href, source, element)
            self._copy_children_into(source, element, current_href, in_note=in_note)
            if name == "blockquote":
                self._wrap_bare_text_in_paragraphs(element)
            if name not in {"br", "td", "th"} and not has_visible_text(element) and not element.find("img"):
                return None
            return element

        # unrecognized block: preserve content, flag provenance
        wrapper = self._new_tag(
            "div", **{"data-role": "unknown", "data-reason": f"unrecognized_tag_{name}"}
        )
        self._register_source_id(current_href, source, wrapper)
        self._copy_children_into(source, wrapper, current_href, in_note=in_note)
        if not has_visible_text(wrapper) and not wrapper.find("img"):
            return None
        return wrapper

    def _split_paragraph_on_br_runs(self, paragraph: Tag) -> Tag | list[Tag]:
        """§4.4: <br> line-break stacks inside one <p> simulate paragraph
        breaks (nb_linter flags any two <br> with no element between them, even
        across text). A paragraph with a single <br> is left alone; two or more
        split the paragraph at every <br>."""
        direct_brs = [
            child
            for child in paragraph.children
            if isinstance(child, Tag) and child.name == "br"
        ]
        if len(direct_brs) < 2:
            return paragraph
        segments: list[list[NavigableString | Tag]] = [[]]
        for child in list(paragraph.children):
            if isinstance(child, Tag) and child.name == "br":
                child.extract()
                segments.append([])
                continue
            segments[-1].append(child.extract())
        result: list[Tag] = []
        for index, nodes in enumerate(segments):
            target = paragraph if index == 0 else self._new_tag("p")
            for node in nodes:
                target.append(node)
            if has_visible_text(target) or target.find("img"):
                result.append(target)
        return result if result else paragraph

    def _wrap_bare_text_in_paragraphs(self, blockquote: Tag) -> None:
        for child in list(blockquote.children):
            if isinstance(child, NavigableString) and str(child).strip():
                paragraph = self._new_tag("p")
                child.replace_with(paragraph)
                paragraph.append(NavigableString(str(child)))

    # ------------------------------------------------------------------ structure

    def _next_id(self, dtype: str) -> str:
        prefixes = {"part": "part", "chapter": "ch"}
        self.type_counters[dtype] = self.type_counters.get(dtype, 0) + 1
        number = self.type_counters[dtype]
        if dtype in prefixes:
            return f"{prefixes[dtype]}-{number:03d}"
        return f"{dtype}-{number:02d}"

    def _open_section(
        self,
        parent: Tag,
        dtype: str,
        current_href: str,
        heading_source: Optional[Tag],
        depth: int,
        *,
        section_id: Optional[str] = None,
    ) -> Tag:
        sid = section_id or self._next_id(dtype)
        section = self._new_tag("section", **{"data-type": dtype, "id": sid})
        parent.append(section)
        self.current_section_id = sid
        self.section_source_ids.setdefault(sid, set())
        if current_href not in self.file_first_section:
            self.file_first_section[current_href] = sid
        if heading_source is not None:
            heading_id = str(heading_source.get("id") or "")
            if heading_id:
                # NCX/nav points straight at the heading anchor; let it resolve
                # to the section itself.
                self.source_id_targets[(current_href, heading_id)] = sid
                self.section_source_ids[sid].add((current_href, heading_id))
            for descendant in heading_source.find_all(id=True):
                inner_id = str(descendant.get("id") or "")
                if inner_id:
                    self.source_id_targets[(current_href, inner_id)] = sid
                    self.section_source_ids[sid].add((current_href, inner_id))
            heading = self._new_tag(f"h{min(depth, 6)}")
            self._copy_children_into(heading_source, heading, current_href)
            if not has_visible_text(heading):
                heading.append(NavigableString(""))
            section.append(heading)
        return section

    def _append_block(self, container: Tag, block: NavigableString | Tag, current_href: str) -> None:
        copied = self._copy_node(block, current_href)
        if copied is None:
            return
        if isinstance(copied, list):
            for item in copied:
                container.append(item)
        else:
            container.append(copied)

    def _top_blocks(self, root: Tag) -> Iterable[NavigableString | Tag]:
        for child in list(root.children):
            if isinstance(child, Tag) and child.name == "div" and child.find(HEADING_RE):
                yield from self._top_blocks(child)
            else:
                yield child

    def _shift_headings(self, section: Tag, source_first_level: int, depth: int) -> None:
        """Recompute the levels of headings *after* the section title (§4.2).

        The section title itself is emitted at h{depth} by _open_section; any
        further source headings keep their relative distance to the source
        title but are re-based onto the target depth.
        """
        delta = depth - source_first_level
        if delta == 0:
            return
        headings = section.find_all(HEADING_RE)
        for node in headings[1:]:
            node.name = f"h{max(1, min(6, int(node.name[1]) + delta))}"

    def _emit_cover(self, parent: Tag, current_href: str, dtype: str) -> None:
        doc = self.docs[current_href]
        body = doc.find("body") or doc
        section = self._open_section(parent, dtype, current_href, None, 1)
        for node in body.find_all(["img", "svg"]):
            if isinstance(node, Tag) and local_name(node) == "svg":
                copied = self._copy_node(node, current_href)
            elif isinstance(node, Tag) and node.name == "img":
                copied = self._copy_img(node, current_href, force_figure=True)
            else:
                continue
            if copied is None:
                continue
            section.append(copied if isinstance(copied, Tag) else copied[0])
            break
        # any stray visible text on the cover page still must survive
        for block in self._top_blocks(body):
            if isinstance(block, Tag) and block.find(["img", "svg"]):
                continue
            if has_visible_text(block):
                self._append_block(section, block, current_href)

    def _emit_single(self, parent: Tag, current_href: str, dtype: str, depth: int) -> None:
        doc = self.docs[current_href]
        body = doc.find("body") or doc
        blocks = list(self._top_blocks(body))
        heading_source: Optional[Tag] = None
        for block in blocks:
            if isinstance(block, Tag) and HEADING_RE.match(block.name or ""):
                heading_source = block
                break
        section = self._open_section(parent, dtype, current_href, heading_source, depth)
        for block in blocks:
            if block is heading_source:
                continue
            self._append_block(section, block, current_href)
        if heading_source is not None:
            self._shift_headings(section, int(heading_source.name[1]), depth)

    def _emit_h2split(self, parent: Tag, current_href: str, dtype: str) -> None:
        doc = self.docs[current_href]
        body = doc.find("body") or doc
        blocks = list(self._top_blocks(body))
        heading_source: Optional[Tag] = None
        for block in blocks:
            if isinstance(block, Tag) and HEADING_RE.match(block.name or ""):
                heading_source = block
                break
        chapter = self._open_section(parent, dtype, current_href, heading_source, 1)
        chapter_id = str(chapter["id"])
        pending: list[NavigableString | Tag] = []
        current: Tag = chapter
        sub_counter = 0
        seen_heading = heading_source is None
        for block in blocks:
            if block is heading_source:
                seen_heading = True
                # blocks stashed before the chapter title (head illustrations)
                for stashed in pending:
                    self._append_block(chapter, stashed, current_href)
                pending = []
                continue
            if not seen_heading:
                pending.append(block)
                continue
            if isinstance(block, Tag) and HEADING_RE.match(block.name or ""):
                sub_counter += 1
                current = self._open_section(
                    chapter,
                    "section",
                    current_href,
                    block,
                    2,
                    section_id=f"{chapter_id}-sec-{sub_counter:03d}",
                )
                continue
            self._append_block(current, block, current_href)
        for stashed in pending:
            self._append_block(chapter, stashed, current_href)

    def _emit_h1h2split(self, parent: Tag, hrefs: list[str]) -> None:
        current_part: Optional[Tag] = None
        current_chapter: Optional[Tag] = None
        for href in hrefs:
            doc = self.docs[href]
            body = doc.find("body") or doc
            first_in_file = True
            for block in self._top_blocks(body):
                if isinstance(block, Tag) and HEADING_RE.match(block.name or ""):
                    level = int(block.name[1])
                    if level == 1:
                        current_part = self._open_section(parent, "part", href, block, 1)
                        current_chapter = None
                        first_in_file = False
                        continue
                    section_parent = current_part if current_part is not None else parent
                    depth = 2 if current_part is not None else 1
                    current_chapter = self._open_section(
                        section_parent, "chapter", href, block, depth
                    )
                    first_in_file = False
                    continue
                target = current_chapter or current_part
                if target is None:
                    if not has_visible_text(block) and not (
                        isinstance(block, Tag) and block.find("img")
                    ):
                        continue
                    raise ValueError(
                        f"content before any heading in {href!r}; cannot place it"
                    )
                if first_in_file and self.file_first_section.get(href) is None:
                    pass
                self._append_block(target, block, href)
        # file-level fallbacks were registered by _open_section already

    # ------------------------------------------------------------------ notes & TOC

    def _emit_notes(self, book: Tag) -> None:
        if not self.note_bodies:
            return
        notes = self._new_tag("section", **{"data-role": "notes", "id": "book-notes"})
        book.append(notes)
        for href, block, note_id in self.note_bodies:
            self.current_section_id = None
            note = self._new_tag(
                "div",
                **{"data-role": "note", "id": note_id, "data-note-kind": "footnote"},
            )
            paragraph = self._new_tag("p")
            self._copy_children_into(block, paragraph, href, in_note=True)
            if not has_visible_text(paragraph):
                raise ValueError(f"note {note_id} from {href!r} lost its body text")
            note.append(paragraph)
            notes.append(note)

    def _toc_target(self, entry: TocEntry) -> Optional[str]:
        if entry.fragment == "toc" or (not entry.href and entry.fragment == "toc"):
            return "toc"
        if entry.href and entry.fragment:
            note_target = self.note_source_ids.get((entry.href, entry.fragment))
            if note_target:
                return note_target
            mapped = self.source_id_targets.get((entry.href, entry.fragment))
            if mapped:
                return mapped
        if entry.href:
            first = self.file_first_section.get(entry.href)
            if first:
                return first
        if not entry.href and entry.fragment:
            return entry.fragment if entry.fragment == "toc" else None
        return None

    def _emit_toc(self, book: Tag, entries: list[TocEntry]) -> int:
        if not entries:
            return 0
        nav = self._new_tag("nav", **{"data-role": "toc", "id": "toc"})
        emitted = 0

        def build(list_parent: Tag, items: list[TocEntry]) -> None:
            nonlocal emitted
            ordered = self._new_tag("ol")
            list_parent.append(ordered)
            for item in items:
                target = self._toc_target(item)
                if target is None:
                    continue
                li = self._new_tag("li")
                anchor = self._new_tag("a", href=f"#{target}")
                anchor.append(NavigableString(item.label))
                li.append(anchor)
                ordered.append(li)
                emitted += 1
                if item.children:
                    build(li, item.children)

        build(nav, entries)
        first_child = book.find(True, recursive=False)
        if first_child is not None:
            first_child.insert_before(nav)
        else:
            book.append(nav)
        return emitted

    # ------------------------------------------------------------------ main

    def normalize(self) -> dict[str, object]:
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self._survey()
        toc_entries = self._read_toc_entries()

        html = self._new_tag("html", lang=self.language or "und")
        self.soup.append(html)
        head = self._new_tag("head")
        html.append(head)
        head.append(self._new_tag("meta", charset="utf-8"))
        head.append(
            self._new_tag(
                "meta", name="viewport", content="width=device-width, initial-scale=1.0"
            )
        )
        title = self._new_tag("title")
        title.append(NavigableString(self.title))
        head.append(title)
        head.append(
            self._new_tag("meta", name="author", content="、".join(self.authors))
        )
        head.append(
            self._new_tag(
                "meta", name="generator", content="read-tailor/normalize_preset_epub"
            )
        )
        head.append(self._new_tag("meta", name="source-format", content="epub"))
        head.append(self._new_tag("meta", name="normalized-spec", content="nb-1.0"))
        body = self._new_tag("body")
        html.append(body)
        book = self._new_tag("main", **{"id": "book", "data-type": "book"})
        body.append(book)

        regions: dict[str, Tag] = {}

        def region(name: str) -> Tag:
            if name not in regions:
                section = self._new_tag(
                    "section",
                    **{
                        "data-role": name,
                        "id": name if name != "notes" else "book-notes",
                    },
                )
                book.append(section)
                regions[name] = section
            return regions[name]

        # group consecutive h1h2split files so parts can span files
        index = 0
        while index < len(self.spine_hrefs):
            href = self.spine_hrefs[index]
            plan = self._plan_for(href)
            if plan.mode == "h1h2split":
                group = []
                while index < len(self.spine_hrefs):
                    candidate = self.spine_hrefs[index]
                    if self._plan_for(candidate).mode != "h1h2split":
                        break
                    group.append(candidate)
                    index += 1
                self._emit_h1h2split(region(plan.region), group)
                continue
            if plan.mode == "cover":
                self._emit_cover(region(plan.region), href, plan.dtype or "titlepage")
            elif plan.mode == "single":
                if not plan.dtype:
                    raise ValueError(f"single mode requires dtype for {href!r}")
                self._emit_single(region(plan.region), href, plan.dtype, 1)
            elif plan.mode == "h2split":
                self._emit_h2split(region(plan.region), href, plan.dtype or "chapter")
            else:
                raise ValueError(f"unknown mode {plan.mode!r} for {href!r}")
            index += 1

        if BODY not in regions:
            raise ValueError("book produced no bodymatter")

        # region order per §3: nav, frontmatter, bodymatter, backmatter, notes
        for name in (FRONT, BODY, BACK):
            if name in regions:
                book.append(regions[name])
        self._emit_notes(book)
        toc_count = self._emit_toc(book, toc_entries)

        cover_path = self._copy_cover_asset()

        html_bytes = (
            "<!DOCTYPE html>\n" + self.soup.decode(formatter="html5")
        ).encode("utf-8")
        (self.output_dir / "book.normalized.html").write_bytes(html_bytes)

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
            stable_json(metadata), encoding="utf-8"
        )

        source_images = sum(
            len(self.docs[href].find_all("img", src=True)) for href in self.spine_hrefs
        )
        output_soup = BeautifulSoup(html_bytes, "html.parser")
        report: dict[str, object] = {
            "normalizer": "normalize_preset_epub.py",
            "normalized_spec": "nb-1.0",
            "plan": self.plan.key,
            "source": {
                "filename": self.input_epub.name,
                "sha256": sha256_bytes(self.input_epub.read_bytes()),
                "spine_documents": len(self.spine_hrefs),
                "toc_entries": _count_entries(toc_entries),
                "note_bodies": len(self.note_bodies),
                "image_references": source_images,
            },
            "output": {
                "html": "book.normalized.html",
                "html_sha256": sha256_bytes(html_bytes),
                "toc_entries": toc_count,
                "noterefs": len(output_soup.select('[data-role="noteref"]')),
                "backrefs": len(output_soup.select('[data-role="backref"]')),
                "broken_internal_links": len(output_soup.select('[data-broken="true"]')),
                "notes": len(output_soup.select('[data-role="note"]')),
                "image_references": len(output_soup.find_all("img")),
                "assets": [self.asset_records[name] for name in sorted(self.asset_records)],
            },
        }
        (self.output_dir / "normalization_report.json").write_text(
            stable_json(report), encoding="utf-8"
        )
        return report


def _count_entries(entries: list[TocEntry]) -> int:
    return sum(1 + _count_entries(entry.children) for entry in entries)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Normalize a supported preset EPUB to nb-1.0"
    )
    parser.add_argument("input_epub", type=Path)
    parser.add_argument("output_dir", type=Path)
    args = parser.parse_args()
    normalizer = PresetEpubNormalizer(args.input_epub, args.output_dir)
    report = normalizer.normalize()
    print(stable_json(report), end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
