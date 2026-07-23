/** Defines pure presentation and interaction tools backed by the session transcript. */

import type { AgentTool } from '@earendil-works/pi-agent-core';
import {
  PresentQuestionArgumentsSchema,
  PublishBookReaderProfileArgumentsSchema,
  PublishBriefArgumentsSchema,
  PublishStrategyArgumentsSchema,
  type PresentQuestionArguments,
  type PublishBookReaderProfileArguments,
  type PublishBriefArguments,
  type PublishStrategyArguments,
} from '@readtailor/contracts';
import {
  compatibleSchema,
  defineTool,
  resultText,
  type ReadingSetupToolHistory,
} from './reading-setup-tool-support';

export function createReadingSetupPresentationTools(options: {
  history: ReadingSetupToolHistory;
}): AgentTool[] {
  return [
    defineTool({
      name: 'present_question',
      label: '向用户提问',
      description: '展示支持单选、多选和自由文本的当前问题；立即完成，不等待用户回答。',
      parameters: compatibleSchema<PresentQuestionArguments>(PresentQuestionArgumentsSchema),
      execute: async (toolCallId, input) =>
        resultText('问题已展示，等待用户在下一次运行中回答。', { toolCallId, ...input }),
    }),
    defineTool({
      name: 'publish_brief',
      label: '发布阅读简报',
      description: '只校验并发布可渲染 brief，不写正式业务数据。',
      parameters: compatibleSchema<PublishBriefArguments>(PublishBriefArgumentsSchema),
      execute: async (toolCallId, input) =>
        resultText('阅读简报已发布。', { toolCallId, ...input }),
    }),
    defineTool({
      name: 'publish_book_reader_profile',
      label: '发布书籍读者画像',
      description: '只校验并发布 book reader profile，不写正式业务数据。',
      parameters: compatibleSchema<PublishBookReaderProfileArguments>(
        PublishBookReaderProfileArgumentsSchema,
      ),
      execute: async (toolCallId, input) =>
        resultText('书籍读者画像已发布。', { toolCallId, ...input }),
    }),
    defineTool({
      name: 'publish_strategy',
      label: '发布阅读策略',
      description: '引用明确的 brief/profile，只校验并发布 strategy summary/core，不写正式业务数据。',
      parameters: compatibleSchema<PublishStrategyArguments>(PublishStrategyArgumentsSchema),
      executionMode: 'sequential',
      execute: async (toolCallId, input) => {
        options.history.requireSuccessful(input.briefToolCallId, 'publish_brief');
        options.history.requireSuccessful(
          input.bookReaderProfileToolCallId,
          'publish_book_reader_profile',
        );
        return resultText('阅读策略已发布，等待用户确认。', { toolCallId, ...input });
      },
    }),
  ];
}
