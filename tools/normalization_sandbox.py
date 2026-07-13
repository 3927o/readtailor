"""Trusted helper commands for the restricted EPUB normalization sandbox.

The Worker controls the command name and all roots. Agent-provided values are read from
environment variables so they are never interpolated into a shell command.
"""

from __future__ import annotations

import fnmatch
import hashlib
import json
import os
import posixpath
import signal
import subprocess
import sys
import threading
import zipfile
from pathlib import Path

from bs4 import BeautifulSoup

ROOT = Path(os.environ.get("READTAILOR_SANDBOX_ROOT", "/tmp/readtailor")).resolve()
SOURCE_ROOT = ROOT / "source" / "unpacked"
OUTPUT_ROOT = ROOT / "output" / "current"
SOURCE_EPUB = ROOT / "source" / "source.epub"
LOG_ROOT = ROOT / "normalizer-logs"
MAX_SOURCE_BYTES = 100 * 1024 * 1024
MAX_UNPACKED_BYTES = 1024 * 1024 * 1024
MAX_SOURCE_FILES = 20_000
MAX_OUTPUT_BYTES = 512 * 1024 * 1024
MAX_OUTPUT_FILES = 20_000
MAX_OUTPUT_FILE_BYTES = 128 * 1024 * 1024
MAX_LOG_BYTES = 2 * 1024 * 1024


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


def command_list() -> None:
    directory = os.environ.get("DIRECTORY", "").strip().strip("/")
    pattern = os.environ.get("GLOB", "*") or "*"
    limit = min(max(int(os.environ.get("LIMIT", "200")), 1), 500)
    candidate = (SOURCE_ROOT / directory).resolve()
    if candidate != SOURCE_ROOT and SOURCE_ROOT not in candidate.parents:
        raise RuntimeError("source directory escapes the EPUB root")
    rows = []
    for path in safe_files(candidate):
        relative = path.relative_to(SOURCE_ROOT).as_posix()
        if fnmatch.fnmatch(relative, pattern) or fnmatch.fnmatch(path.name, pattern):
            rows.append({"path": relative, "bytes": path.stat().st_size})
            if len(rows) >= limit:
                break
    print(json.dumps({"files": rows, "truncated": len(rows) >= limit}, ensure_ascii=False))


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


def command_search() -> None:
    query = os.environ["QUERY"]
    pattern = os.environ.get("GLOB", "*") or "*"
    limit = min(max(int(os.environ.get("LIMIT", "50")), 1), 200)
    rows = []
    bytes_read = 0
    for path in safe_files(SOURCE_ROOT):
        relative = path.relative_to(SOURCE_ROOT).as_posix()
        if not (fnmatch.fnmatch(relative, pattern) or fnmatch.fnmatch(path.name, pattern)):
            continue
        if path.stat().st_size > 2_000_000:
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        bytes_read += len(text.encode("utf-8"))
        if bytes_read > 20_000_000:
            break
        for line_no, line in enumerate(text.splitlines(), 1):
            index = line.casefold().find(query.casefold())
            if index < 0:
                continue
            rows.append(
                {
                    "path": relative,
                    "line": line_no,
                    "context": line[max(0, index - 120) : index + len(query) + 120],
                }
            )
            if len(rows) >= limit:
                print(json.dumps({"matches": rows, "truncated": True}, ensure_ascii=False))
                return
    print(json.dumps({"matches": rows, "truncated": False}, ensure_ascii=False))


def command_inspect() -> None:
    html_path = OUTPUT_ROOT / "book.normalized.html"
    text = html_path.read_text(encoding="utf-8")
    soup = BeautifulSoup(text, "html.parser")
    selector = os.environ.get("SELECTOR", "").strip()
    limit = min(max(int(os.environ.get("LIMIT", "20")), 1), 100)
    stats = {
        "sections": len(soup.select("section[data-type]")),
        "notes": len(soup.select('[data-role="note"]')),
        "images": len(soup.find_all("img")),
        "links": len(soup.find_all("a")),
        "characters": len(soup.get_text()),
    }
    nodes = soup.select(selector)[:limit] if selector else [soup.head, soup.body]
    snippets = [str(node)[:4000] for node in nodes if node is not None]
    print(json.dumps({"stats": stats, "snippets": snippets}, ensure_ascii=False))


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
    "run-normalizer": command_run_normalizer,
    "list": command_list,
    "search": command_search,
    "inspect": command_inspect,
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
