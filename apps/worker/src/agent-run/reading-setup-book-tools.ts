/** Defines bounded profile, outline, node, source-reading, and search tools. */

import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from '@earendil-works/pi-ai';
import {
  createManifestIndex,
  requireNode,
  validateRangeAgainstBlocks,
  type BlockPoint,
} from '@readtailor/reader-core';
import {
  extractNodeSourceFromHtml,
  extractNodeTexts,
} from '@readtailor/tailoring';
import type { ReadingSetupAgentResources } from './reading-setup-resources';
import {
  boundedDetails,
  clamp,
  defineTool,
  resultText,
  titlePath,
} from './reading-setup-tool-support';

const OUTLINE_DEFAULT = 100;
const OUTLINE_HARD_MAX = 200;
const NODE_TEXT_DEFAULT = 6_000;
const NODE_TEXT_HARD_MAX = 12_000;
const SEARCH_DEFAULT = 20;
const SEARCH_HARD_MAX = 50;
const SEARCH_SNIPPET_MAX = 500;

export function createReadingSetupBookTools(options: {
  resources(): Promise<ReadingSetupAgentResources>;
}): AgentTool[] {
  return [
    defineTool({
      name: 'get_reader_profile',
      label: '读取长期读者画像',
      description: '读取当前用户的长期 reader profile；不存在时返回 null。',
      parameters: Type.Object({}),
      execute: async () => {
        const data = (await options.resources()).readerProfile?.profile ?? null;
        return resultText('已读取长期读者画像。', boundedDetails(data, 'reader profile'));
      },
    }),
    defineTool({
      name: 'get_book_profile',
      label: '读取书籍画像',
      description: '读取当前 shared book 的书籍画像，不包含用户信息。',
      parameters: Type.Object({}),
      execute: async () => {
        const data = (await options.resources()).bookProfile;
        return resultText('已读取书籍画像。', boundedDetails(data, 'book profile'));
      },
    }),
    defineTool({
      name: 'get_book_outline',
      label: '读取语义目录',
      description: '分页读取语义 outline；不返回 reading nodes 或正文。',
      parameters: Type.Object({
        offset: Type.Optional(Type.Integer({ minimum: 0 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: OUTLINE_HARD_MAX })),
      }),
      execute: async (_id, input) => {
        const { manifest } = await options.resources();
        const offset = input.offset ?? 0;
        const limit = clamp(input.limit, OUTLINE_DEFAULT, OUTLINE_HARD_MAX);
        const items = manifest.outline.slice(offset, offset + limit);
        const nextOffset = offset + items.length < manifest.outline.length
          ? offset + items.length
          : null;
        const data = boundedDetails({
          items,
          offset,
          total: manifest.outline.length,
          nextOffset,
          truncated: nextOffset !== null,
        }, 'outline');
        return resultText(`已读取 ${items.length} 个目录项。`, data);
      },
    }),
    defineTool({
      name: 'list_reading_nodes',
      label: '列出阅读节点',
      description: '分页读取 reading node 元数据，可按 sectionId 过滤，不返回正文。',
      parameters: Type.Object({
        sectionId: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
        offset: Type.Optional(Type.Integer({ minimum: 0 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: OUTLINE_HARD_MAX })),
      }),
      execute: async (_id, input) => {
        const { manifest } = await options.resources();
        const all = input.sectionId
          ? manifest.nodes.filter(
              (node) =>
                node.sectionId === input.sectionId ||
                node.parentSectionId === input.sectionId,
            )
          : manifest.nodes;
        const offset = input.offset ?? 0;
        const limit = clamp(input.limit, OUTLINE_DEFAULT, OUTLINE_HARD_MAX);
        const nodes = all.slice(offset, offset + limit).map((node) => ({
          sectionId: node.sectionId,
          segment: node.segment,
          order: node.order,
          title: node.title,
          titlePath: titlePath(node, manifest),
          characterCount: node.characterCount,
          blockCount: node.blockCount,
          tailoringEligible: node.tailoringEligible,
        }));
        const nextOffset = offset + nodes.length < all.length ? offset + nodes.length : null;
        const data = boundedDetails({
          nodes,
          offset,
          total: all.length,
          nextOffset,
          truncated: nextOffset !== null,
        }, 'reading nodes');
        return resultText(`已读取 ${nodes.length} 个 reading nodes。`, data);
      },
    }),
    defineTool({
      name: 'read_book_node',
      label: '读取节点正文',
      description: '从稳定 BlockPoint 开始分页读取一个 reading node 的有限正文。',
      parameters: Type.Object({
        sectionId: Type.String({ minLength: 1, maxLength: 500 }),
        segment: Type.Integer({ minimum: 1 }),
        start: Type.Optional(Type.Object({
          blockIndex: Type.Integer({ minimum: 1 }),
          offset: Type.Integer({ minimum: 0 }),
        })),
        maxCharacters: Type.Optional(
          Type.Integer({ minimum: 1, maximum: NODE_TEXT_HARD_MAX }),
        ),
      }),
      execute: async (_id, input) => {
        const loaded = await options.resources();
        const node = requireNode(createManifestIndex(loaded.manifest), input.sectionId, input.segment);
        const source = extractNodeSourceFromHtml(loaded.rawHtml, node.sectionId, node.segment);
        const first = source.blocks[0];
        if (!first) throw new Error('reading node 没有可读 blocks');
        const start: BlockPoint = input.start ?? { blockIndex: first.blockIndex, offset: 0 };
        validateRangeAgainstBlocks(
          {
            start,
            end: {
              blockIndex: source.blocks.at(-1)!.blockIndex,
              offset: source.blocks.at(-1)!.text.length,
            },
          },
          source.blocks,
        );
        let remaining = clamp(input.maxCharacters, NODE_TEXT_DEFAULT, NODE_TEXT_HARD_MAX);
        const blocks: Array<{
          blockIndex: number;
          kind: string;
          startOffset: number;
          endOffset: number;
          text: string;
        }> = [];
        let nextStart: BlockPoint | null = null;
        for (const block of source.blocks) {
          if (block.blockIndex < start.blockIndex) continue;
          const startOffset = block.blockIndex === start.blockIndex ? start.offset : 0;
          if (startOffset >= block.text.length) continue;
          const available = block.text.length - startOffset;
          const take = Math.min(available, remaining);
          blocks.push({
            blockIndex: block.blockIndex,
            kind: block.kind,
            startOffset,
            endOffset: startOffset + take,
            text: block.text.slice(startOffset, startOffset + take),
          });
          remaining -= take;
          if (take < available) {
            nextStart = { blockIndex: block.blockIndex, offset: startOffset + take };
            break;
          }
          if (remaining === 0) {
            const next = source.blocks.find((item) => item.blockIndex > block.blockIndex);
            nextStart = next ? { blockIndex: next.blockIndex, offset: 0 } : null;
            break;
          }
        }
        const last = blocks.at(-1);
        const pageRange = last
          ? {
              start,
              end: { blockIndex: last.blockIndex, offset: last.endOffset },
            }
          : { start, end: start };
        const data = boundedDetails({
          sectionId: node.sectionId,
          segment: node.segment,
          pageRange,
          blocks,
          nextStart,
          truncated: nextStart !== null,
        }, 'node page');
        return resultText(`已读取 ${blocks.length} 个正文 block。`, data);
      },
    }),
    defineTool({
      name: 'search_book',
      label: '搜索书籍',
      description: '在 reading nodes 中搜索有限命中，只返回位置、标题和短 snippet。',
      parameters: Type.Object({
        query: Type.String({ minLength: 1, maxLength: 200 }),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: SEARCH_HARD_MAX })),
      }),
      execute: async (_id, input) => {
        const loaded = await options.resources();
        const query = input.query.trim().toLocaleLowerCase();
        if (!query) throw new Error('搜索词不能为空');
        const limit = clamp(input.limit, SEARCH_DEFAULT, SEARCH_HARD_MAX);
        const matches = extractNodeTexts(loaded.rawHtml).filter((item) =>
          item.text.toLocaleLowerCase().includes(query),
        );
        const hits = matches.slice(0, limit).map((item) => {
          const lower = item.text.toLocaleLowerCase();
          const index = lower.indexOf(query);
          const start = Math.max(0, index - Math.floor((SEARCH_SNIPPET_MAX - query.length) / 2));
          const node = loaded.manifest.nodes.find(
            (candidate) =>
              candidate.sectionId === item.sectionId && candidate.segment === item.segment,
          );
          return {
            sectionId: item.sectionId,
            segment: item.segment,
            title: node?.title ?? '',
            titlePath: node ? titlePath(node, loaded.manifest) : [],
            snippet: item.text.slice(start, start + SEARCH_SNIPPET_MAX),
          };
        });
        const data = boundedDetails({
          query: input.query,
          hits,
          totalMatches: matches.length,
          truncated: matches.length > hits.length,
        }, 'search result');
        return resultText(`找到 ${hits.length} 个匹配 reading nodes。`, data);
      },
    }),
  ];
}
