#!/usr/bin/env python3

import argparse
import os
import shutil
import stat
import tempfile


def site_header_matches(line: str, domain: str) -> bool:
    stripped = line.strip()
    return stripped in {f"{domain} {{", f"https://{domain} {{", f"http://{domain} {{"}


def structural_brace_deltas(lines: list[str]) -> list[int]:
    deltas: list[int] = []
    quote: str | None = None
    heredoc_marker: str | None = None
    escaped = False

    for line in lines:
        if heredoc_marker:
            if line.strip() == heredoc_marker:
                heredoc_marker = None
            deltas.append(0)
            continue

        tokens: list[str] = []
        token: list[str] = []
        pending_heredoc: str | None = None

        def finish_token() -> None:
            nonlocal pending_heredoc
            if not token:
                return
            value = "".join(token)
            tokens.append(value)
            token.clear()
            if value.startswith("<<") and len(value) > 2:
                pending_heredoc = value[2:]

        for character in line:
            if escaped:
                token.append(character)
                escaped = False
                continue
            if quote == '"' and character == "\\":
                token.append(character)
                escaped = True
                continue
            if quote:
                token.append(character)
                if character == quote:
                    quote = None
                continue
            if character in {'"', "'", "`"}:
                quote = character
                token.append(character)
                continue
            if character.isspace():
                finish_token()
                continue
            if character == "#" and not token:
                break
            token.append(character)

        finish_token()
        deltas.append(tokens.count("{") - tokens.count("}"))
        if pending_heredoc:
            heredoc_marker = pending_heredoc

    if quote:
        raise ValueError("invalid Caddyfile: unterminated quoted token")
    if heredoc_marker:
        raise ValueError("invalid Caddyfile: unterminated heredoc")
    return deltas


def remove_site_block(lines: list[str], domain: str) -> list[str]:
    result: list[str] = []
    brace_deltas = structural_brace_deltas(lines)
    index = 0
    matched = False
    while index < len(lines):
        if not site_header_matches(lines[index], domain):
            result.append(lines[index])
            index += 1
            continue
        if matched:
            raise ValueError(f"multiple Caddy site blocks found for {domain}")
        matched = True

        depth = 0
        while index < len(lines):
            depth += brace_deltas[index]
            index += 1
            if depth == 0:
                break
            if depth < 0:
                raise ValueError(f"invalid Caddyfile while removing {domain}: unmatched closing brace")
        if depth != 0:
            raise ValueError(f"invalid Caddyfile while removing {domain}: unterminated site block")
        while index < len(lines) and not lines[index].strip():
            index += 1
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("--domain", required=True)
    parser.add_argument("--import-path", required=True)
    args = parser.parse_args()

    with open(args.config, encoding="utf-8") as handle:
        lines = handle.readlines()

    import_line = f"import {args.import_path}\n"
    updated = remove_site_block(lines, args.domain)
    if not any(line.strip() == import_line.strip() for line in updated):
        if updated and updated[-1].strip():
            updated.append("\n")
        updated.append(import_line)

    backup = f"{args.config}.readtailor-backup"
    shutil.copy2(args.config, backup)
    source_stat = os.stat(args.config)
    directory = os.path.dirname(args.config)
    descriptor, temporary = tempfile.mkstemp(prefix=".Caddyfile.", dir=directory, text=True)
    try:
        os.fchown(descriptor, source_stat.st_uid, source_stat.st_gid)
        os.fchmod(descriptor, stat.S_IMODE(source_stat.st_mode))
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.writelines(updated)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, args.config)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


if __name__ == "__main__":
    main()
