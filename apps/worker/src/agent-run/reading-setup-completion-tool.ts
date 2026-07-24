/** Defines the Agent-only completion tool that activates an explicitly confirmed trial. */

import type { AgentTool } from '@earendil-works/pi-agent-core';
import {
  CompleteReadingSetupArgumentsSchema,
  type CompleteReadingSetupArguments,
  type CompleteReadingSetupResult,
} from '@readtailor/contracts';
import {
  compatibleSchema,
  defineTool,
  resultText,
  type ReadingSetupToolHistory,
} from './reading-setup-tool-support';

export function createReadingSetupCompletionTool(options: {
  history: ReadingSetupToolHistory;
  complete(
    toolCallId: string,
    trialToolCallId: string,
  ): Promise<CompleteReadingSetupResult>;
}): AgentTool {
  return defineTool({
    name: 'complete_reading_setup',
    label: '完成阅读准备',
    description:
      '仅在用户已经确认明确的 generate_trial_slice 后调用。显式传入该 trialToolCallId，校验完整引用链并激活正式阅读数据；不要自动选择最新试读。',
    parameters: compatibleSchema<CompleteReadingSetupArguments>(
      CompleteReadingSetupArgumentsSchema,
    ),
    executionMode: 'sequential',
    execute: async (toolCallId, input) => {
      options.history.requireSuccessful(
        input.trialToolCallId,
        'generate_trial_slice',
      );
      const result = await options.complete(toolCallId, input.trialToolCallId);
      return resultText('阅读准备已完成，书籍已进入正式阅读。', result);
    },
  });
}
