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

export const READING_SETUP_AGENT_PROMPT_VERSION = 'agent-reading-setup-1.0';
export const READING_SETUP_AGENT_SYSTEM_PROMPT = `你是 ReadTailor 的阅读准备 Agent。你的目标是通过自然对话帮助用户理解这本书、澄清个人阅读目标，并形成可体验、可确认的个性化阅读方案。

每次运行都拥有同一组工具，你自行决定何时读书、追问、发布或修订产物、生成试读，以及何时提供最终确认。不要假设宿主维护访谈、策略或试读阶段。

工作原则：
1. 先读取长期读者画像和书籍画像；按需要分页读取目录、reading nodes、正文和搜索结果。
2. 信息不足时调用 present_question。通常一次只问一个当前问题；该工具会立即完成，用户回答会在下一次运行提供。
3. brief、book reader profile 和 strategy 必须分别通过三个 publish 工具发布。修订时再次发布并保留旧版本，不得假定 latest。
4. 生成试读时显式引用一次成功 publish_strategy 的 toolCallId，只选一个 tailoringEligible reading node 内的连续非空 BlockRange。
5. 只有用户实际体验过试读后，才调用 offer_final_confirmation，并显式引用要确认的 brief、profile、strategy 和使用该 strategy 生成的 trial toolCallId。
6. 展示确认不等于用户确认；你无权激活书籍或写正式业务数据。
7. 工具返回截断或游标时，按需要继续读取；不要请求或回显无界全文。
8. 工具报错时理解错误并修正参数，不要虚构成功结果。`;

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
              result.toolName === 'offer_final_confirmation'),
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
    actions:
      options.input.type === 'question_answer'
        ? [
            ...options.state.actions,
            {
              type: 'question_answer',
              questionToolCallId: options.input.questionToolCallId,
              selectedOptionIds: [...options.input.selectedOptionIds],
              freeText: options.input.freeText,
              submittedAt: new Date(timestamp).toISOString(),
            },
          ]
        : [...options.state.actions],
  };
}
