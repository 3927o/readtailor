/** Defines the trial-slice generation tool and its tailoring-model adapter. */

import type { AgentTool } from '@earendil-works/pi-agent-core';
import {
  GenerateTrialSliceArgumentsSchema,
  type BookReaderProfile,
  type GenerateTrialSliceArguments,
  type GenerateTrialSliceResult,
  type ProposedStrategy,
} from '@readtailor/contracts';
import type { ModelEngine } from '@readtailor/model';
import {
  createManifestIndex,
  requireNode,
  validateRangeAgainstBlocks,
  type BlockRange,
} from '@readtailor/reader-core';
import {
  extractNodeSourceFromHtml,
  generateTailoredContent,
  sliceNodeSource,
  type JsonValue,
  type TailoringModelClient,
} from '@readtailor/tailoring';
import type { ReadingSetupAgentResources } from './reading-setup-resources';
import {
  asObject,
  compatibleSchema,
  defineTool,
  resultText,
  titlePath,
  type ReadingSetupToolHistory,
} from './reading-setup-tool-support';

const TRIAL_SOURCE_MAX = 12_000;

function createTailoringClient(engine: ModelEngine): TailoringModelClient {
  return {
    async generate(request) {
      if (engine.name === 'fake') {
        return JSON.stringify({
          guide: '先留意这一片段的核心问题与关键概念关系。',
          annotations: [],
          afterReading: '读完后，用一句话说明这一片段如何服务你的阅读目标。',
        });
      }
      let content = '';
      for await (const event of engine.streamChat(request.prompt, {
        maxTokens: 4096,
        responseFormat: request.responseFormat,
      })) {
        if (event.type === 'content') content += event.text;
      }
      return content;
    },
  };
}

export function createReadingSetupTrialTool(options: {
  history: ReadingSetupToolHistory;
  isStrategyConfirmed(strategyToolCallId: string): boolean;
  resources(): Promise<ReadingSetupAgentResources>;
  tailoringModel: ModelEngine;
}): AgentTool {
  return defineTool({
    name: 'generate_trial_slice',
    label: '生成试读切片',
    description: '用显式引用的 strategy 在一个 eligible node 的连续 BlockRange 上生成一次试读。',
    parameters: compatibleSchema<GenerateTrialSliceArguments>(
      GenerateTrialSliceArgumentsSchema,
    ),
    executionMode: 'sequential',
    execute: async (toolCallId, input) => {
      const strategyRecord = options.history.requireSuccessful(
        input.strategyToolCallId,
        'publish_strategy',
      );
      if (!options.isStrategyConfirmed(strategyRecord.toolCallId)) {
        throw new Error('生成试读前必须先由用户确认对应的 strategy');
      }
      const strategyArgs = asObject(strategyRecord.arguments);
      if (typeof strategyArgs.bookReaderProfileToolCallId !== 'string') {
        throw new Error('strategy 没有引用有效的 book reader profile');
      }
      const profileRecord = options.history.requireSuccessful(
        strategyArgs.bookReaderProfileToolCallId,
        'publish_book_reader_profile',
      );
      const loaded = await options.resources();
      const node = requireNode(createManifestIndex(loaded.manifest), input.sectionId, input.segment);
      if (!node.tailoringEligible) throw new Error('指定 reading node 不允许裁读');
      const fullSource = extractNodeSourceFromHtml(loaded.rawHtml, node.sectionId, node.segment);
      const range = input.range as BlockRange;
      validateRangeAgainstBlocks(range, fullSource.blocks);
      const selected = sliceNodeSource(fullSource, range);
      const sourceText = selected.blocks.map((block) => block.text).join('\n');
      if (!sourceText.trim()) throw new Error('试读 range 不能为空');
      if (sourceText.length > TRIAL_SOURCE_MAX) {
        throw new Error(`试读原文超过 ${TRIAL_SOURCE_MAX} 字符上限`);
      }
      const profileArgs = asObject(profileRecord.arguments);
      const strategy = strategyArgs.strategy as unknown as ProposedStrategy;
      const bookReaderProfile = profileArgs.profile as unknown as BookReaderProfile;
      const sourceTitlePath = titlePath(node, loaded.manifest);
      const generated = await generateTailoredContent(
        {
          generationScope: 'trial',
          fragmentRange: range,
          userId: loaded.userBook.userId,
          packageId: loaded.package.id,
          packageVersion: loaded.package.version,
          profiles: {
            book: { version: loaded.package.id, value: loaded.bookProfile },
            reader: {
              version: loaded.readerProfile?.id ?? 'none',
              value: (loaded.readerProfile?.profile ?? null) as JsonValue,
            },
            bookReader: {
              version: profileRecord.toolCallId,
              value: bookReaderProfile as unknown as JsonValue,
            },
          },
          source: {
            sectionId: node.sectionId,
            segment: node.segment,
            nodeOrder: node.order,
            title: node.title || null,
            ancestorTitles: sourceTitlePath,
            range,
            structuredHtml: selected.structuredHtml,
            blocks: selected.blocks,
            originalNotes: selected.originalNotes as JsonValue[],
            previousContext: null,
            nextContext: null,
          },
          model: {
            modelId: options.tailoringModel.name,
            configVersion: 'agent-trial-slice-1.0',
          },
          strategy: {
            kind: 'strategy_draft',
            version: strategyRecord.toolCallId,
            status: 'approved_for_trial',
            value: strategy as unknown as JsonValue,
          },
        },
        createTailoringClient(options.tailoringModel),
      );
      const result: GenerateTrialSliceResult = {
        toolCallId,
        strategyToolCallId: strategyRecord.toolCallId,
        source: {
          titlePath: sourceTitlePath,
          sectionId: node.sectionId,
          segment: node.segment,
          range,
          text: sourceText,
          blocks: selected.blocks.map((block) => ({
            blockIndex: block.blockIndex,
            kind: block.kind,
            text: block.text,
            sourceOffset: block.sourceOffset ?? 0,
          })),
        },
        guide: generated.guide,
        annotations: generated.annotations,
        afterReading: generated.afterReading,
      };
      return resultText('试读切片已生成。', result);
    },
  });
}
