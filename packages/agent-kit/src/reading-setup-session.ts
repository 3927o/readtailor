/** Defines the reading-setup prompt, input mapping, and domain-specific Agent loop policy. */

import {
  runAgentLoop,
  type AgentEvent,
  type AgentMessage,
  type AgentTool,
} from '@earendil-works/pi-agent-core';
import type { Message, Model } from '@earendil-works/pi-ai';
import type {
  AgentRunInput,
  AgentSessionState,
} from '@readtailor/contracts';
import { restoreAgentContext, serializeAgentMessage } from './runtime/session';

export const READING_SETUP_AGENT_PROMPT_VERSION = 'agent-reading-setup-1.3';
export const READING_SETUP_AGENT_SYSTEM_PROMPT = `你是 ReadTailor 的阅读准备 Agent。你的目标是通过自然对话帮助用户理解这本书、澄清个人阅读目标，并形成可体验、可确认的个性化阅读方案。

每次运行都拥有同一组工具，你自行决定何时读书、追问、发布或修订产物、生成试读。不要假设宿主维护访谈、策略或试读阶段。

工作原则：
1. 先读取长期读者画像和书籍画像；按需要分页读取目录、reading nodes、正文和搜索结果。
2. 信息不足时调用 present_question。通常一次只问一个当前问题，selectionMode 始终使用 single；该工具会立即完成，用户回答会在下一次运行提供。
3. brief、book reader profile 和 strategy 必须分别通过三个 publish 工具发布。publish_strategy 必须显式引用本次策略使用的 brief 和 book reader profile。修订时再次发布并保留旧版本，不得假定 latest。
4. publish_strategy 后等待用户确认。只有收到 targetToolName=publish_strategy 的 confirmation，才可使用其中明确确认的 targetToolCallId 生成试读。
5. 收到 feedback 时必须结合 targetToolName 和 targetToolCallId 理解用户反馈的精确对象，再自行决定修订哪个产物。
6. 生成试读时只选一个 tailoringEligible reading node 内的连续非空 BlockRange。试读发布后等待用户反馈或确认。
7. 收到 targetToolName=generate_trial_slice 的 confirmation 后，自然收尾并调用 complete_reading_setup，显式传入同一个 targetToolCallId。该工具才会写入正式数据并激活书籍，不要要求用户再次确认。
8. 如果某一轮没有调用 complete_reading_setup，已确认的试读仍然有效；后续运行可以继续引用它完成。
9. 工具返回截断或游标时，按需要继续读取；不要请求或回显无界全文。
10. 工具报错时理解错误并修正参数，不要虚构成功结果。`;

const READING_SETUP_SESSION_START_PROMPT = `这是一个刚开始的阅读准备会话。请主动开始：先读取必要的长期读者画像和书籍信息，再自然地向用户开场；如果还需要了解用户，调用 present_question 提出当前最有价值的第一个问题。不要假装用户已经表达过任何尚未提供的信息。`;

export function runInputMessage(
  input: AgentRunInput,
  timestamp = Date.now(),
): AgentMessage {
  if (input.type === 'session_start') {
    return {
      role: 'user',
      content: READING_SETUP_SESSION_START_PROMPT,
      timestamp,
    };
  }
  if (input.type === 'message') {
    return { role: 'user', content: input.text.trim(), timestamp };
  }
  if (input.type === 'feedback') {
    return {
      role: 'user',
      content: JSON.stringify({
        action: 'feedback',
        targetToolCallId: input.targetToolCallId,
        targetToolName: input.targetToolName,
        message: input.message,
      }),
      timestamp,
    };
  }
  if (input.type === 'confirmation') {
    return {
      role: 'user',
      content: JSON.stringify({
        action: 'confirmation',
        targetToolCallId: input.targetToolCallId,
        targetToolName: input.targetToolName,
      }),
      timestamp,
    };
  }
  return {
    role: 'user',
    content: JSON.stringify({
      action: 'question_answer',
      questionToolCallId: input.questionToolCallId,
      selectedOptionIds: input.selectedOptionIds,
      freeText: input.freeText,
    }),
    timestamp,
  };
}

export async function runReadingSetupAgentLoop(options: {
  state: AgentSessionState;
  input: AgentRunInput;
  model: Model<any>;
  apiKey?: string;
  tools: AgentTool[];
  emit: (event: AgentEvent) => void | Promise<void>;
  streamFn?: Parameters<typeof runAgentLoop>[5];
}): Promise<AgentSessionState> {
  const timestamp = Date.now();
  const prompt = runInputMessage(options.input, timestamp);
  const context = restoreAgentContext(options.state, options.tools);
  const newMessages = await runAgentLoop(
    [prompt],
    context,
    {
      model: options.model,
      convertToLlm: async (messages) =>
        messages.filter(
          (message): message is Message =>
            message.role === 'user' ||
            message.role === 'assistant' ||
            message.role === 'toolResult',
        ),
      ...(options.state.thinkingLevel === 'off'
        ? {}
        : { reasoning: options.state.thinkingLevel }),
      ...(options.apiKey ? { apiKey: options.apiKey } : {}),
      toolExecution: 'parallel',
      shouldStopAfterTurn: ({ toolResults }) =>
        toolResults.some(
          (result) =>
            !result.isError &&
            (result.toolName === 'present_question' ||
              result.toolName === 'publish_strategy' ||
              result.toolName === 'generate_trial_slice' ||
              result.toolName === 'complete_reading_setup'),
        ),
    },
    options.emit,
    undefined,
    options.streamFn,
  );
  const committedMessages = options.input.type === 'session_start'
    ? newMessages.slice(1)
    : newMessages;

  return {
    ...options.state,
    messages: [
      ...options.state.messages,
      ...committedMessages.map(serializeAgentMessage),
    ],
    actions: [
      ...options.state.actions,
      ...(options.input.type === 'question_answer'
        ? [{
            type: 'question_answer' as const,
            questionToolCallId: options.input.questionToolCallId,
            selectedOptionIds: [...options.input.selectedOptionIds],
            freeText: options.input.freeText,
            submittedAt: new Date(timestamp).toISOString(),
          }]
        : options.input.type === 'feedback'
          ? [{
              type: 'feedback' as const,
              targetToolCallId: options.input.targetToolCallId,
              targetToolName: options.input.targetToolName,
              message: options.input.message,
              submittedAt: new Date(timestamp).toISOString(),
            }]
          : options.input.type === 'confirmation'
            ? [{
                type: 'confirmation' as const,
                targetToolCallId: options.input.targetToolCallId,
                targetToolName: options.input.targetToolName,
                submittedAt: new Date(timestamp).toISOString(),
              }]
            : []),
    ],
  };
}
