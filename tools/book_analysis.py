"""Read-only helper for the shared Book Analysis Agent."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from bs4 import BeautifulSoup

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_reading_nodes import ReadingNodeBuilder  # noqa: E402


def load_nodes(path: Path):
    soup = BeautifulSoup(path.read_text(encoding="utf-8"), "html.parser")
    return ReadingNodeBuilder(soup).build()


def standard_text(html: str) -> str:
    return BeautifulSoup(html, "html.parser").get_text("", strip=False)


def node_key(node) -> tuple[str, int]:
    return node.section_id, node.segment


def command_read(args: argparse.Namespace) -> None:
    nodes = load_nodes(args.html)
    for index, node in enumerate(nodes):
        if node_key(node) != (args.section_id, args.segment):
            continue
        text = standard_text(node.content_html)
        print(
            json.dumps(
                {
                    "section_id": node.section_id,
                    "segment": node.segment,
                    "title": node.title,
                    "region": node.region,
                    "data_type": node.data_type,
                    "previous": node_key(nodes[index - 1]) if index > 0 else None,
                    "next": node_key(nodes[index + 1]) if index + 1 < len(nodes) else None,
                    "text": text[: args.max_characters],
                    "truncated": len(text) > args.max_characters,
                    "total_characters": len(text),
                },
                ensure_ascii=False,
            )
        )
        return
    raise ValueError("reading node not found")


def command_search(args: argparse.Namespace) -> None:
    matches = []
    folded_query = args.query.casefold()
    for node in load_nodes(args.html):
        text = standard_text(node.content_html)
        offset = text.casefold().find(folded_query)
        if offset < 0:
            continue
        matches.append(
            {
                "section_id": node.section_id,
                "segment": node.segment,
                "title": node.title,
                "context": text[max(0, offset - 160) : offset + len(args.query) + 160],
            }
        )
        if len(matches) >= args.limit:
            break
    print(json.dumps({"matches": matches}, ensure_ascii=False))


def command_stats(args: argparse.Namespace) -> None:
    for node in load_nodes(args.html):
        if node_key(node) != (args.section_id, args.segment):
            continue
        soup = BeautifulSoup(node.content_html, "html.parser")
        print(
            json.dumps(
                {
                    "section_id": node.section_id,
                    "segment": node.segment,
                    "character_count": node.character_count,
                    "block_count": node.block_count,
                    "images": len(soup.find_all("img")),
                    "notes": len(soup.select('[data-role="note"]')),
                    "tables": len(soup.find_all("table")),
                },
                ensure_ascii=False,
            )
        )
        return
    raise ValueError("reading node not found")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("read", "search", "stats"))
    parser.add_argument("html", type=Path)
    parser.add_argument("--section-id")
    parser.add_argument("--segment", type=int, default=0)
    parser.add_argument("--max-characters", type=int, default=6000)
    parser.add_argument("--query")
    parser.add_argument("--limit", type=int, default=20)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.command in {"read", "stats"} and not args.section_id:
        raise ValueError("--section-id is required")
    if args.command == "search" and not args.query:
        raise ValueError("--query is required")
    {"read": command_read, "search": command_search, "stats": command_stats}[args.command](args)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
