// Lightweight markdown parser for the short, AI-authored prose that flows through
// AssistanceContent (strategy summaries, trial guides, after-reading notes, note bodies).
// These strings routinely carry `**bold**`, bullet/numbered lists and the occasional
// heading, so we hand-roll the common subset rather than pull in a full markdown
// dependency. Parsing returns a plain AST so it can be unit-tested without a DOM or the
// React/JSX toolchain (mirroring reader/content.ts).

export type InlineToken =
  | { type: 'text'; value: string }
  | { type: 'strong'; children: InlineToken[] }
  | { type: 'em'; children: InlineToken[] }
  | { type: 'code'; value: string };

export type MarkdownBlock =
  | { type: 'paragraph'; content: InlineToken[] }
  | { type: 'heading'; level: number; content: InlineToken[] }
  | { type: 'list'; ordered: boolean; items: InlineToken[][] };

// Bold before italic so `**x**` is consumed as one strong span rather than two stray
// asterisks. Italic requires non-space just inside each `*` (CommonMark-style flanking) so
// prose/maths like `2 * 3 = 6` stays literal instead of italicising the middle. Italic and
// code stay on a single run, so an unmatched marker degrades to literal text rather than
// swallowing the rest of the block.
const INLINE_PATTERN = /\*\*([^]+?)\*\*|\*(\S|\S[^*\n]*?\S)\*|`([^`]+?)`/g;

export function parseInline(text: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  const pattern = new RegExp(INLINE_PATTERN.source, 'g');
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) tokens.push({ type: 'text', value: text.slice(last, match.index) });
    if (match[1] !== undefined) tokens.push({ type: 'strong', children: parseInline(match[1]) });
    else if (match[2] !== undefined) tokens.push({ type: 'em', children: parseInline(match[2]) });
    else tokens.push({ type: 'code', value: match[3]! });
    last = pattern.lastIndex;
  }
  if (last < text.length) tokens.push({ type: 'text', value: text.slice(last) });
  return tokens;
}

export function parseMarkdown(content: string): MarkdownBlock[] {
  const blocks = content.split(/\n{2,}/).map((block) => block.trim()).filter(Boolean);
  return blocks.map((block) => {
    const lines = block.split('\n').map((line) => line.trim()).filter(Boolean);
    // Headings and lists only fire on their canonical single/multi-line shapes; anything
    // ambiguous falls through to a paragraph so no content is dropped.
    const heading = /^(#{1,6})\s+(.*\S)\s*$/.exec(block);
    if (heading && lines.length === 1) {
      return { type: 'heading', level: heading[1]!.length, content: parseInline(heading[2]!) };
    }
    if (lines.length > 1 && lines.every((line) => /^[-*]\s+/.test(line))) {
      return { type: 'list', ordered: false, items: lines.map((line) => parseInline(line.replace(/^[-*]\s+/, ''))) };
    }
    if (lines.length > 1 && lines.every((line) => /^\d+\.\s+/.test(line))) {
      return { type: 'list', ordered: true, items: lines.map((line) => parseInline(line.replace(/^\d+\.\s+/, ''))) };
    }
    return { type: 'paragraph', content: parseInline(block) };
  });
}
