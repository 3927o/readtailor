import { stableStringify } from './serialization';
import { TailoringError, type TailoringGenerationInput } from './types';
import { validateGenerationInput } from './validation';

export const TAILORING_PROMPT_VERSION = 'tailoring-content-1.0';

const SYSTEM_INSTRUCTIONS = `你是 ReadTailor 的阅读内容生成器。你只处理输入给出的原文范围，不得补写、改写或复制大段原文。根据同一套质量标准生成导读、精确裁读注和节后助读；没有价值的项目返回 null 或空数组。严格遵循 strategy.value 中各段的 enabled 开关：guide.enabled 为 false 时 guide 必须为 null，annotations.enabled 为 false 时 annotations 必须为空数组，afterReading.enabled 为 false 时 after_reading 必须为 null；启用的段落按其 objectives / focuses / exclusions 组织内容。

只返回一个 JSON 对象，且只能包含 guide、annotations、after_reading 三个字段：
{"guide":null,"annotations":[],"after_reading":null}

guide 和 after_reading 必须是 Markdown 字符串或 null。annotations 必须是数组，每项只能包含 block_index、quote、content。quote 必须从指定 block 的标准文本中原样复制，且在该 block 中只出现一次。不要计算 offset。content 必须是 Markdown 字符串。所有内容只能描述本次提供的原文范围，不得把片段说成完整章节。`;

export function buildTailoringPrompt(input: TailoringGenerationInput): string {
  validateGenerationInput(input);

  const payload = {
    prompt_version: TAILORING_PROMPT_VERSION,
    generation_scope: input.generation_scope,
    node: {
      section_id: input.source.section_id,
      segment: input.source.segment,
      node_order: input.source.node_order,
      title: input.source.title,
      ancestor_titles: input.source.ancestor_titles,
    },
    generation_range: input.source.range,
    structured_html: input.source.structured_html,
    blocks: input.source.blocks,
    original_notes: input.source.original_notes,
    adjacent_context: {
      previous: input.source.previous_context,
      next: input.source.next_context,
    },
    profiles: input.profiles,
    strategy: input.strategy,
  };

  try {
    return `${SYSTEM_INSTRUCTIONS}\n\n输入数据：\n${stableStringify(payload)}`;
  } catch (error) {
    throw new TailoringError(
      'invalid_input',
      `generation input must be JSON-serializable: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  }
}
