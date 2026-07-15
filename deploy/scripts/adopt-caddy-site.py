#!/usr/bin/env python3

import argparse
import os
import shutil
import tempfile


def site_header_matches(line: str, domain: str) -> bool:
    stripped = line.strip()
    return stripped in {f"{domain} {{", f"https://{domain} {{", f"http://{domain} {{"}


def remove_site_block(lines: list[str], domain: str) -> list[str]:
    result: list[str] = []
    index = 0
    while index < len(lines):
        if not site_header_matches(lines[index], domain):
            result.append(lines[index])
            index += 1
            continue

        depth = 0
        while index < len(lines):
            depth += lines[index].count("{") - lines[index].count("}")
            index += 1
            if depth == 0:
                break
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
    directory = os.path.dirname(args.config)
    descriptor, temporary = tempfile.mkstemp(prefix=".Caddyfile.", dir=directory, text=True)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.writelines(updated)
        os.replace(temporary, args.config)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


if __name__ == "__main__":
    main()
