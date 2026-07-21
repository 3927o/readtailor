import { stableStringify } from './serialization';
import { TailoringError, type TailoringGenerationInput } from './types';
import { validateGenerationInput } from './validation';

export const TAILORING_PROMPT_VERSION = 'tailoring-content-2.0';

const SYSTEM_INSTRUCTIONS = `你是 ReadTailor 的阅读内容生成器。你只处理输入给出的原文范围，不得补写、改写或复制大段原文。根据同一套质量标准生成导读、精确裁读注和节后助读；没有价值的项目返回 null 或空数组。严格遵循 strategy.value 中各段的 enabled 开关：guide.enabled 为 false 时 guide 必须为 null，annotations.enabled 为 false 时 annotations 必须为空数组，afterReading.enabled 为 false 时 afterReading 必须为 null；启用的段落按其 objectives / focuses / exclusions 组织内容。

只返回一个 JSON 对象，且只能包含 guide、annotations、afterReading 三个字段：
{"guide":null,"annotations":[],"afterReading":null}

guide 和 afterReading 必须是 Markdown 字符串或 null。annotations 必须是数组，每项只能包含 blockIndex、quote、content。quote 必须从指定 block 的标准文本中原样复制，且在该 block 中只出现一次。不要计算 offset。content 必须是 Markdown 字符串。所有内容只能描述本次提供的原文范围，不得把片段说成完整章节。`;

export function buildTailoringPrompt(input: TailoringGenerationInput): string {
  validateGenerationInput(input);

  const payload = {
    promptVersion: TAILORING_PROMPT_VERSION,
    generationScope: input.generationScope,
    node: {
      sectionId: input.source.sectionId,
      segment: input.source.segment,
      nodeOrder: input.source.nodeOrder,
      title: input.source.title,
      ancestorTitles: input.source.ancestorTitles,
    },
    generationRange: input.source.range,
    structuredHtml: input.source.structuredHtml,
    blocks: input.source.blocks,
    originalNotes: input.source.originalNotes,
    adjacentContext: {
      previous: input.source.previousContext,
      next: input.source.nextContext,
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
