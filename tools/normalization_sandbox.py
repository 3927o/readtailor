"""Trusted helper commands for the restricted EPUB normalization sandbox.

The Worker controls the command name and all roots. Agent-provided values are read from
environment variables so they are never interpolated into a shell command.
"""

from __future__ import annotations

from collections import Counter
import hashlib
import json
import os
import posixpath
import re
import resource
import signal
import subprocess
import sys
import threading
import zipfile
from pathlib import Path
from urllib.parse import unquote, urlsplit

from bs4 import BeautifulSoup, FeatureNotFound

ROOT = Path(os.environ.get("READTAILOR_SANDBOX_ROOT", "/tmp/readtailor")).resolve()
SOURCE_ROOT = ROOT / "source" / "unpacked"
OUTPUT_ROOT = ROOT / "output" / "current"
WORK_ROOT = ROOT / "work"
SOURCE_EPUB = ROOT / "source" / "source.epub"
LOG_ROOT = ROOT / "normalizer-logs"
MAX_SOURCE_BYTES = 100 * 1024 * 1024
MAX_UNPACKED_BYTES = 1024 * 1024 * 1024
MAX_SOURCE_FILES = 20_000
MAX_OUTPUT_BYTES = 512 * 1024 * 1024
MAX_OUTPUT_FILES = 20_000
MAX_OUTPUT_FILE_BYTES = 128 * 1024 * 1024
MAX_LOG_BYTES = 2 * 1024 * 1024
MAX_SHELL_OUTPUT_BYTES = 256 * 1024
MAX_STRUCTURE_TEXT_BYTES = 8 * 1024 * 1024
MAX_STRUCTURE_SCAN_BYTES = 64 * 1024 * 1024
MAX_STRUCTURE_ROWS = 150
MAX_STRUCTURE_ISSUES = 100


def safe_files(root: Path):
    for path in sorted(
        root.rglob("*"),
        key=lambda item: item.relative_to(root).as_posix().encode("utf-8"),
    ):
        relative = path.relative_to(root).as_posix()
        if any(ord(character) < 0x20 for character in relative):
            raise RuntimeError(f"control character is forbidden in artifact path: {relative!r}")
        if path.is_symlink():
            raise RuntimeError(f"symbolic link is forbidden: {path.relative_to(root)}")
        if path.is_dir():
            continue
        if not path.is_file():
            raise RuntimeError(f"unsupported filesystem entry: {path.relative_to(root)}")
        yield path


def command_preflight() -> None:
    if SOURCE_EPUB.stat().st_size > MAX_SOURCE_BYTES:
        raise RuntimeError("source EPUB exceeds the 100 MB limit")
    with zipfile.ZipFile(SOURCE_EPUB) as archive:
        entries = archive.infolist()
        if len(entries) > MAX_SOURCE_FILES:
            raise RuntimeError("source EPUB contains too many files")
        total = 0
        for entry in entries:
            normalized = posixpath.normpath(entry.filename.replace("\\", "/"))
            if any(ord(character) < 0x20 for character in normalized):
                raise RuntimeError(f"control character in EPUB entry path: {entry.filename!r}")
            if normalized.startswith("/") or normalized == ".." or normalized.startswith("../"):
                raise RuntimeError(f"unsafe EPUB entry path: {entry.filename}")
            if entry.flag_bits & 0x1:
                raise RuntimeError("encrypted/DRM EPUB entries are not supported")
            total += entry.file_size
            if total > MAX_UNPACKED_BYTES:
                raise RuntimeError("source EPUB exceeds the 1 GB unpacked limit")
    print(json.dumps({"files": len(entries), "unpacked_bytes": total}))


def local_name(tag) -> str:
    name = getattr(tag, "name", "") or ""
    return name.rsplit(":", 1)[-1].lower()


def tags_named(node, name: str):
    expected = name.lower()
    return node.find_all(lambda tag: local_name(tag) == expected)


def first_tag(node, name: str):
    expected = name.lower()
    return node.find(lambda tag: local_name(tag) == expected)


def parse_markup(path: Path, warnings: list[str]) -> BeautifulSoup:
    if path.stat().st_size > MAX_STRUCTURE_TEXT_BYTES:
        raise RuntimeError(f"structure file exceeds 8 MB: {path.relative_to(SOURCE_ROOT)}")
    raw = path.read_bytes()
    try:
        return BeautifulSoup(raw, "xml")
    except FeatureNotFound:
        warnings.append("XML parser unavailable; using html.parser fallback")
        return BeautifulSoup(raw, "html.parser")


def clean_text(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip()


def limited(rows: list, limit: int = MAX_STRUCTURE_ROWS) -> dict:
    return {"items": rows[:limit], "total": len(rows), "truncated": len(rows) > limit}


def resolve_reference(base_path: str, reference: str) -> str | None:
    reference = reference.strip()
    if not reference or reference.startswith("#"):
        return None
    parsed = urlsplit(reference)
    if parsed.scheme or parsed.netloc or not parsed.path:
        return None
    decoded = unquote(parsed.path).replace("\\", "/")
    if decoded.startswith("/"):
        decoded = decoded.lstrip("/")
        base_directory = ""
    else:
        base_directory = posixpath.dirname(base_path)
    normalized = posixpath.normpath(posixpath.join(base_directory, decoded))
    if normalized == ".." or normalized.startswith("../"):
        return normalized
    return normalized.lstrip("./")


def resource_category(media_type: str, path: str) -> str:
    media_type = media_type.lower()
    suffix = posixpath.splitext(path.lower())[1]
    if media_type in {"application/xhtml+xml", "text/html"} or suffix in {".xhtml", ".html", ".htm"}:
        return "documents"
    if media_type == "text/css" or suffix == ".css":
        return "stylesheets"
    if media_type.startswith("image/") or suffix in {".jpg", ".jpeg", ".png", ".gif", ".svg", ".webp", ".avif"}:
        return "images"
    if media_type.startswith("font/") or suffix in {".otf", ".ttf", ".woff", ".woff2"}:
        return "fonts"
    if media_type.startswith("audio/"):
        return "audio"
    if media_type.startswith("video/"):
        return "video"
    if media_type in {"application/x-dtbncx+xml", "application/xml", "text/xml"} or suffix in {".xml", ".ncx"}:
        return "xml"
    return "other"


def markup_summary(path: Path, warnings: list[str]) -> tuple[dict, set[str]]:
    try:
        soup = parse_markup(path, warnings)
    except Exception as error:
        warnings.append(f"failed to parse {path.relative_to(SOURCE_ROOT)}: {error}")
        return {"parseError": str(error)}, set()
    title = first_tag(soup, "title")
    text = clean_text(soup.get_text(" ", strip=True))
    counts = Counter(local_name(tag) for tag in soup.find_all(True))
    note_count = 0
    for tag in soup.find_all(True):
        role = str(tag.get("role", "")).lower()
        epub_type = str(tag.get("epub:type", tag.get("type", ""))).lower().split()
        if role in {"doc-footnote", "doc-endnote", "note"} or any(
            value in {"footnote", "endnote", "note", "rearnote"} for value in epub_type
        ):
            note_count += 1
    references: set[str] = set()
    for tag in soup.find_all(True):
        for attribute in ("href", "src", "poster", "data", "xlink:href"):
            value = tag.get(attribute)
            if isinstance(value, str):
                references.add(value)
        srcset = tag.get("srcset")
        if isinstance(srcset, str):
            references.update(part.strip().split()[0] for part in srcset.split(",") if part.strip())
    return (
        {
            "title": clean_text(title.get_text(" ", strip=True)) if title else None,
            "characters": len(re.sub(r"\s", "", text)),
            "textUnits": len(re.findall(r"[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*|[\u3400-\u9fff]", text)),
            "headings": sum(counts[f"h{level}"] for level in range(1, 7)),
            "paragraphs": counts["p"],
            "images": counts["img"] + counts["image"],
            "links": counts["a"],
            "notes": note_count,
            "tables": counts["table"],
            "svg": counts["svg"],
            "mathml": counts["math"],
            "ruby": counts["ruby"],
        },
        references,
    )


def command_inspect_epub_structure() -> None:
    warnings: list[str] = []
    files = list(safe_files(SOURCE_ROOT))
    file_by_path = {path.relative_to(SOURCE_ROOT).as_posix(): path for path in files}
    casefold_paths: dict[str, list[str]] = {}
    for relative in file_by_path:
        casefold_paths.setdefault(relative.casefold(), []).append(relative)

    case_mismatches: list[dict] = []
    case_mismatch_seen: set[tuple[str, str]] = set()

    def locate(expected: str) -> tuple[str, Path] | None:
        if expected in file_by_path:
            return expected, file_by_path[expected]
        matches = casefold_paths.get(expected.casefold(), [])
        if len(matches) == 1:
            mismatch = (expected, matches[0])
            if mismatch not in case_mismatch_seen:
                case_mismatch_seen.add(mismatch)
                case_mismatches.append({"expected": expected, "actual": matches[0]})
            return matches[0], file_by_path[matches[0]]
        return None

    container_location = locate("META-INF/container.xml")
    rootfiles: list[dict] = []
    if container_location:
        _, container_path = container_location
        container = parse_markup(container_path, warnings)
        for rootfile in tags_named(container, "rootfile"):
            full_path = str(rootfile.get("full-path", "")).replace("\\", "/").lstrip("/")
            if full_path:
                rootfiles.append(
                    {"path": posixpath.normpath(full_path), "mediaType": rootfile.get("media-type")}
                )
    else:
        warnings.append("META-INF/container.xml is missing")
    if not rootfiles:
        rootfiles = [{"path": relative, "mediaType": None} for relative in file_by_path if relative.lower().endswith(".opf")]
        if rootfiles:
            warnings.append("using discovered OPF because container rootfile was unavailable")
    selected = next((row for row in rootfiles if locate(row["path"])), None)
    if not selected:
        raise RuntimeError("no readable OPF package document found")
    opf_location = locate(selected["path"])
    assert opf_location is not None
    opf_path_name, opf_path = opf_location
    package = parse_markup(opf_path, warnings)
    package_tag = first_tag(package, "package")
    if package_tag is None:
        raise RuntimeError(f"OPF has no package element: {opf_path_name}")

    metadata_tag = first_tag(package_tag, "metadata")

    def metadata_values(name: str) -> list[str]:
        if metadata_tag is None:
            return []
        return [clean_text(tag.get_text(" ", strip=True)) for tag in tags_named(metadata_tag, name) if clean_text(tag.get_text(" ", strip=True))]

    metadata = {
        "titles": metadata_values("title")[:20],
        "creators": metadata_values("creator")[:20],
        "languages": metadata_values("language")[:20],
        "identifiers": metadata_values("identifier")[:20],
        "publisher": metadata_values("publisher")[:10],
        "date": metadata_values("date")[:10],
        "rights": metadata_values("rights")[:10],
    }

    manifest: list[dict] = []
    manifest_by_id: dict[str, dict] = {}
    media_types = Counter()
    categories = Counter()
    extensions = Counter()
    missing_manifest_files: list[dict] = []
    manifest_tag = first_tag(package_tag, "manifest")
    if manifest_tag:
        for item in tags_named(manifest_tag, "item"):
            item_id = str(item.get("id", ""))
            href = str(item.get("href", ""))
            expected = resolve_reference(opf_path_name, href) if href else None
            location = locate(expected) if expected else None
            actual_path = location[0] if location else expected
            media_type = str(item.get("media-type", ""))
            properties = str(item.get("properties", "")).split()
            row = {
                "id": item_id,
                "href": href,
                "path": actual_path,
                "mediaType": media_type,
                "properties": properties,
                "fallback": item.get("fallback"),
                "mediaOverlay": item.get("media-overlay"),
                "bytes": location[1].stat().st_size if location else None,
            }
            manifest.append(row)
            if item_id:
                manifest_by_id[item_id] = row
            media_types[media_type or "(missing)"] += 1
            category = resource_category(media_type, actual_path or href)
            categories[category] += 1
            extensions[posixpath.splitext((actual_path or href).lower())[1] or "(none)"] += 1
            if expected and not location:
                missing_manifest_files.append({"id": item_id, "path": expected})

    spine_tag = first_tag(package_tag, "spine")
    spine_rows: list[dict] = []
    missing_spine_items: list[dict] = []
    aggregate_features = Counter()
    referenced_paths: set[str] = set()
    spine_paths: set[str] = set()
    if spine_tag:
        for index, itemref in enumerate(tags_named(spine_tag, "itemref")):
            item_id = str(itemref.get("idref", ""))
            item = manifest_by_id.get(item_id)
            if not item:
                missing_spine_items.append({"index": index, "idref": item_id})
                spine_rows.append({"index": index, "idref": item_id, "missingManifestItem": True})
                continue
            path_name = item.get("path")
            summary: dict = {}
            if isinstance(path_name, str) and path_name in file_by_path:
                spine_paths.add(path_name)
                summary, references = markup_summary(file_by_path[path_name], warnings)
                for reference in references:
                    resolved = resolve_reference(path_name, reference)
                    if resolved:
                        referenced_paths.add(resolved)
                for key in ("notes", "tables", "svg", "mathml", "ruby", "images"):
                    aggregate_features[key] += int(summary.get(key, 0) or 0)
            spine_rows.append(
                {
                    "index": index,
                    "idref": item_id,
                    "path": path_name,
                    "mediaType": item.get("mediaType"),
                    "linear": str(itemref.get("linear", "yes")).lower() != "no",
                    "properties": str(itemref.get("properties", "")).split(),
                    **summary,
                }
            )

    navigation = {"navDocuments": [], "ncxDocuments": [], "guideReferences": [], "navTypes": {}}
    nav_types = Counter()
    for item in manifest:
        path_name = item.get("path")
        if not isinstance(path_name, str) or path_name not in file_by_path:
            continue
        properties = item.get("properties", [])
        media_type = item.get("mediaType", "")
        if "nav" in properties:
            navigation["navDocuments"].append(path_name)
            try:
                nav_soup = parse_markup(file_by_path[path_name], warnings)
                for nav in tags_named(nav_soup, "nav"):
                    nav_type = str(nav.get("epub:type", nav.get("type", "unspecified"))).strip() or "unspecified"
                    nav_types[nav_type] += 1
            except Exception as error:
                warnings.append(f"failed to inspect nav document {path_name}: {error}")
        if media_type == "application/x-dtbncx+xml" or path_name.lower().endswith(".ncx"):
            row = {"path": path_name, "navPoints": 0, "pageTargets": 0}
            try:
                ncx = parse_markup(file_by_path[path_name], warnings)
                row["navPoints"] = len(tags_named(ncx, "navpoint"))
                row["pageTargets"] = len(tags_named(ncx, "pagetarget"))
            except Exception as error:
                warnings.append(f"failed to inspect NCX {path_name}: {error}")
            navigation["ncxDocuments"].append(row)
    navigation["navTypes"] = dict(sorted(nav_types.items()))
    guide_tag = first_tag(package_tag, "guide")
    if guide_tag:
        for reference in tags_named(guide_tag, "reference"):
            href = str(reference.get("href", ""))
            navigation["guideReferences"].append(
                {
                    "type": reference.get("type"),
                    "title": reference.get("title"),
                    "href": href,
                    "path": resolve_reference(opf_path_name, href),
                }
            )

    scanned_bytes = 0
    skipped_large_text_files: list[str] = []
    css_url_pattern = re.compile(r"url\(\s*(['\"]?)(.*?)\1\s*\)", re.IGNORECASE)
    for item in manifest:
        path_name = item.get("path")
        if not isinstance(path_name, str) or path_name not in file_by_path or path_name in spine_paths:
            continue
        path = file_by_path[path_name]
        category = resource_category(str(item.get("mediaType", "")), path_name)
        if category not in {"documents", "stylesheets", "xml"}:
            continue
        size = path.stat().st_size
        if size > MAX_STRUCTURE_TEXT_BYTES or scanned_bytes + size > MAX_STRUCTURE_SCAN_BYTES:
            skipped_large_text_files.append(path_name)
            continue
        scanned_bytes += size
        try:
            text = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError) as error:
            warnings.append(f"failed to read references from {path_name}: {error}")
            continue
        references: set[str]
        if category == "stylesheets":
            references = {match.group(2) for match in css_url_pattern.finditer(text)}
        else:
            _, references = markup_summary(path, warnings)
        for reference in references:
            resolved = resolve_reference(path_name, reference)
            if resolved:
                referenced_paths.add(resolved)

    missing_references: list[dict] = []
    for expected in sorted(referenced_paths):
        if locate(expected) is None:
            missing_references.append({"path": expected})

    structural_paths = {opf_path_name, *(row["path"] for row in rootfiles if row.get("path"))}
    structural_paths.update(navigation["navDocuments"])
    structural_paths.update(row["path"] for row in navigation["ncxDocuments"])
    orphaned_manifest = []
    for item in manifest:
        path_name = item.get("path")
        properties = set(item.get("properties", []))
        if (
            isinstance(path_name, str)
            and path_name not in spine_paths
            and path_name not in referenced_paths
            and path_name not in structural_paths
            and not properties.intersection({"nav", "cover-image"})
        ):
            orphaned_manifest.append({"id": item.get("id"), "path": path_name, "mediaType": item.get("mediaType")})

    encryption_rows = []
    encryption_location = locate("META-INF/encryption.xml")
    if encryption_location:
        try:
            encryption = parse_markup(encryption_location[1], warnings)
            methods = tags_named(encryption, "encryptionmethod")
            references = tags_named(encryption, "cipherreference")
            for index, reference in enumerate(references):
                method = methods[index] if index < len(methods) else None
                encryption_rows.append(
                    {
                        "uri": reference.get("URI", reference.get("uri")),
                        "algorithm": method.get("Algorithm", method.get("algorithm")) if method else None,
                    }
                )
        except Exception as error:
            warnings.append(f"failed to parse META-INF/encryption.xml: {error}")

    largest = sorted(
        ({"path": relative, "bytes": path.stat().st_size} for relative, path in file_by_path.items()),
        key=lambda row: row["bytes"],
        reverse=True,
    )[:20]
    paths_by_category: dict[str, list[str]] = {}
    property_items = []
    for item in manifest:
        category = resource_category(str(item.get("mediaType", "")), str(item.get("path", "")))
        path_name = item.get("path")
        if isinstance(path_name, str):
            paths_by_category.setdefault(category, []).append(path_name)
        if item.get("properties"):
            property_items.append(
                {"id": item.get("id"), "path": path_name, "properties": item.get("properties")}
            )
    spine_fields = [
        "index",
        "idref",
        "path",
        "linear",
        "title",
        "characters",
        "textUnits",
        "headings",
        "paragraphs",
        "images",
        "notes",
        "tables",
        "svg",
        "mathml",
        "ruby",
    ]
    compact_spine = [[row.get(field) for field in spine_fields] for row in spine_rows]
    report = {
        "version": "epub-structure-1.0",
        "container": {
            "path": container_location[0] if container_location else None,
            "rootfiles": rootfiles,
            "selectedRootfile": opf_path_name,
        },
        "package": {
            "version": package_tag.get("version"),
            "uniqueIdentifier": package_tag.get("unique-identifier"),
            "prefix": package_tag.get("prefix"),
            "metadata": metadata,
        },
        "manifest": {
            "itemCount": len(manifest),
            "byCategory": dict(sorted(categories.items())),
            "byMediaType": dict(sorted(media_types.items())),
            "byExtension": dict(sorted(extensions.items())),
            "pathsByCategory": {
                category: limited(paths, 100) for category, paths in sorted(paths_by_category.items())
            },
            "propertyItems": limited(property_items, 100),
        },
        "spine": {
            "toc": spine_tag.get("toc") if spine_tag else None,
            "pageProgressionDirection": spine_tag.get("page-progression-direction") if spine_tag else None,
            "entryFields": spine_fields,
            **limited(compact_spine),
        },
        "navigation": navigation,
        "features": dict(sorted(aggregate_features.items())),
        "resources": {
            "fileCount": len(files),
            "totalBytes": sum(path.stat().st_size for path in files),
            "largest": largest,
            "encrypted": encryption_rows,
        },
        "issues": {
            "missingManifestFiles": limited(missing_manifest_files, MAX_STRUCTURE_ISSUES),
            "missingSpineItems": limited(missing_spine_items, MAX_STRUCTURE_ISSUES),
            "missingReferences": limited(missing_references, MAX_STRUCTURE_ISSUES),
            "caseMismatches": limited(case_mismatches, MAX_STRUCTURE_ISSUES),
            "orphanedManifestItems": limited(orphaned_manifest, MAX_STRUCTURE_ISSUES),
            "skippedLargeTextFiles": limited(skipped_large_text_files, MAX_STRUCTURE_ISSUES),
            "warnings": limited(warnings, MAX_STRUCTURE_ISSUES),
        },
    }
    print(json.dumps(report, ensure_ascii=False, separators=(",", ":")))


def command_run_normalizer() -> None:
    stdout_path = LOG_ROOT / "normalizer.stdout"
    stderr_path = LOG_ROOT / "normalizer.stderr"
    process = subprocess.Popen(
        [sys.executable, str(ROOT / "normalize.py"), str(SOURCE_EPUB), str(OUTPUT_ROOT)],
        cwd=ROOT,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        start_new_session=True,
    )
    truncated = {"stdout": False, "stderr": False}

    def drain(stream, path: Path, name: str) -> None:
        written = 0
        with path.open("wb") as target:
            while True:
                chunk = stream.read(64 * 1024)
                if not chunk:
                    break
                remaining = MAX_LOG_BYTES - written
                if remaining > 0:
                    accepted = chunk[:remaining]
                    target.write(accepted)
                    written += len(accepted)
                if len(chunk) > max(remaining, 0):
                    truncated[name] = True

    threads = [
        threading.Thread(target=drain, args=(process.stdout, stdout_path, "stdout")),
        threading.Thread(target=drain, args=(process.stderr, stderr_path, "stderr")),
    ]
    for thread in threads:
        thread.start()
    exit_code = process.wait()
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    for thread in threads:
        thread.join()
    print(json.dumps({"exit_code": exit_code, "truncated": truncated}))


def command_run_shell() -> None:
    command = os.environ.get("SHELL_COMMAND", "")
    if not command or len(command) > 20_000 or "\0" in command:
        raise RuntimeError("shell command must contain 1 to 20000 non-NUL characters")
    timeout_seconds = min(max(int(os.environ.get("SHELL_TIMEOUT_SECONDS", "30")), 1), 120)
    WORK_ROOT.mkdir(parents=True, exist_ok=True)
    scratch_tmp = WORK_ROOT / "tmp"
    scratch_tmp.mkdir(exist_ok=True)
    child_env = {
        "HOME": str(WORK_ROOT),
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "PATH": "/usr/local/bin:/usr/bin:/bin",
        "TMPDIR": str(scratch_tmp),
    }

    def apply_limits() -> None:
        resource.setrlimit(resource.RLIMIT_CPU, (timeout_seconds + 5, timeout_seconds + 5))
        resource.setrlimit(resource.RLIMIT_FSIZE, (64 * 1024 * 1024, 64 * 1024 * 1024))
        resource.setrlimit(resource.RLIMIT_NOFILE, (256, 256))
        resource.setrlimit(resource.RLIMIT_AS, (2 * 1024 * 1024 * 1024, 2 * 1024 * 1024 * 1024))
        if sys.platform.startswith("linux"):
            resource.setrlimit(resource.RLIMIT_NPROC, (64, 64))

    process = subprocess.Popen(
        ["/bin/bash", "--noprofile", "--norc", "-lc", command],
        cwd=WORK_ROOT,
        env=child_env,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        start_new_session=True,
        preexec_fn=apply_limits if sys.platform.startswith("linux") else None,
    )
    captured = {"stdout": bytearray(), "stderr": bytearray()}
    truncated = {"stdout": False, "stderr": False}

    def drain(stream, name: str) -> None:
        while True:
            chunk = stream.read(64 * 1024)
            if not chunk:
                break
            remaining = MAX_SHELL_OUTPUT_BYTES - len(captured[name])
            if remaining > 0:
                captured[name].extend(chunk[:remaining])
            if len(chunk) > max(remaining, 0):
                truncated[name] = True

    threads = [
        threading.Thread(target=drain, args=(process.stdout, "stdout")),
        threading.Thread(target=drain, args=(process.stderr, "stderr")),
    ]
    for thread in threads:
        thread.start()
    timed_out = False
    try:
        exit_code = process.wait(timeout=timeout_seconds)
    except subprocess.TimeoutExpired:
        timed_out = True
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        exit_code = process.wait()
    finally:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    for thread in threads:
        thread.join()
    print(
        json.dumps(
            {
                "exit_code": exit_code,
                "timed_out": timed_out,
                "stdout": captured["stdout"].decode("utf-8", errors="replace"),
                "stderr": captured["stderr"].decode("utf-8", errors="replace"),
                "truncated": truncated,
            },
            ensure_ascii=False,
        )
    )


def command_inventory() -> None:
    rows = []
    total = 0
    for path in safe_files(OUTPUT_ROOT):
        size = path.stat().st_size
        if size > MAX_OUTPUT_FILE_BYTES:
            raise RuntimeError("normalized output contains a file larger than 128 MB")
        total += size
        if len(rows) >= MAX_OUTPUT_FILES:
            raise RuntimeError("normalized output contains too many files")
        if total > MAX_OUTPUT_BYTES:
            raise RuntimeError("normalized output exceeds the 512 MB limit")
        digest = hashlib.sha256()
        with path.open("rb") as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(chunk)
        rows.append(
            {
                "path": path.relative_to(OUTPUT_ROOT).as_posix(),
                "sha256": digest.hexdigest(),
                "byteSize": size,
            }
        )
    canonical = "artifact-inventory-1.0\n" + "".join(
        f"{row['path']}\0{row['byteSize']}\0{row['sha256']}\n" for row in rows
    )
    print(
        json.dumps(
            {
                "version": "artifact-inventory-1.0",
                "files": rows,
                "sha256": hashlib.sha256(canonical.encode()).hexdigest(),
            },
            ensure_ascii=False,
        )
    )


COMMANDS = {
    "preflight": command_preflight,
    "inspect-epub-structure": command_inspect_epub_structure,
    "run-normalizer": command_run_normalizer,
    "run-shell": command_run_shell,
    "inventory": command_inventory,
}


def main() -> int:
    if len(sys.argv) != 2 or sys.argv[1] not in COMMANDS:
        print("expected one of: " + ", ".join(sorted(COMMANDS)), file=sys.stderr)
        return 2
    COMMANDS[sys.argv[1]]()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
