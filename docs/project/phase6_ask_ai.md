# 阶段6 问 AI 与策略调整 · 实现方案

**状态**：**「问 AI」只读闭环已交付**。已完成步骤 1（agent-kit `runAskAiAgent` 模块）、步骤 2（三张表 + 迁移 `0017`）、步骤 3（host `AskAiToolbox` 8 工具 + `POST /v1/user-books/:id/qa` SSE 端点 + `GET …/qa/:sessionId` 转录 + `QA_AI_*` 模型接线）、以及最小前端入口（阅读器「问 AI」面板：提问/追问、流式回答、只读展示 proposal 卡）。`propose_strategy_change` 只创建 **pending** proposal，**不落地**（不产生新 strategyVersion、不触发重生成）。**「策略调整」的确认/重生成（步骤 4）暂缓**——见下方「⚠️ 步骤 4 暂缓」。

> **落地要点（步骤 3 实现记录）**：读工具复用 [`extractNodeSourceFromHtml`](../../packages/tailoring/src/source.ts:135)；`search_book` 走新增的单次解析 [`extractNodeTexts`](../../packages/tailoring/src/source.ts) 建每请求惰性索引。`update_reader_profile` 用 union-dedup 写新 `reader_profile_versions`（`changeSource='question_answer'`）。会话/消息落 `qa_sessions`/`qa_messages`：问题与回答都用 **CAS-first** 抢占 `conversation_version+1` 作为 `sequence`（避免并发两个 INSERT 撞唯一索引，冲突则重试）；问题按 `idempotencyKey` 幂等。**回答不用 `questionSequence+1` 定位**，而是把所答问题的 sequence 记进 `payload.q` 建显式链接——这样同一会话里插入第二个问题不会把别的问题的答案错认/挤掉；保存前按 `payload.q` 查重做幂等。proposal 在回答成功后与答案**同一事务**落 `strategy_change_proposals`（pending；同书旧 pending 置 `superseded`），失败不留孤儿。
**关联**：[`agent_design.md`](../architecture/agent_design.md) §8、[`implementation_baseline.md`](./implementation_baseline.md) 阶段6、[`core_flow_refactor.md`](./core_flow_refactor.md)（交互式 agent 的重建/流式先例）

> **⚠️ 步骤 4（确认/重生成）暂缓的原因**：阅读器目前是**单策略版本**假设——`strategy_versions.version` 在唯一插入点（`adoptTrial`，[user-books.ts:1635](../../apps/api/src/user-books.ts:1635)）硬编码为 `1`；`buildReaderBootstrap`（[user-books.ts:1326](../../apps/api/src/user-books.ts:1326)）把某 user_book 的**所有** formal `node_generations` **不按 strategyVersionId 过滤、不按节点去重**地塞进 `enhancements[]`。QA 确认会产生第二个 strategyVersion，导致当前节点新旧两条并存、已读节点版本解析未定义。故「确认→重生成」需先设计**阅读器多版本内容解析**（去重/版本过滤，可能连前端），另需处理 `sourceDraftVersionId` NOT NULL UNIQUE（合成 draft 或放宽列）与 `Strategy` 的 3 个 `trialCandidates`（沿用当前策略填充）。作为独立一件事另行设计。

本方案先实现 `runAskAiAgent` 纯模块（问答 + 提出策略调整），再补 host 侧的确认流。模块可独立用 stub toolbox 单测，不依赖 host 落地。

## 1. 关键决策（已锁定）

1. **问 AI 是对话式 agent，交付物是流式回答文本，不是某个工具调用**。因此它**没有终止工具**——8 个工具全非终止；模型不再调工具、吐出最终文本即成功。不沿用现有三个 agent 的 `if (!outcome) throw` 守卫（[index.ts:1050](../../packages/agent-kit/src/index.ts:1050)），改为循环结束后取最后一条 assistant 文本作为答案。
2. **持久化与现有 agent 同构：业务行是事实来源，每轮从业务行重建 `AgentMessage[]` 并拍平成纯文本**。全仓库没有任何地方存 Pi 原生 session（§3.4 的进程内缓存也未实现），QA 不做例外。参照 [`reconstructReadingSetupHistory`](../../packages/agent-kit/src/index.ts:816)。
3. **`propose_strategy_change` 是非终止的副作用工具**，agent 答题过程中可调可不调；被调用的一刻在同一条流上发 `strategy_proposal` 事件，前端据此自动展示确认卡（§8.2「在该回复之后展示确认卡」）。
4. **确认/反馈非阻塞（不挂 live agent）**：走独立端点，只**更新 proposal 业务行**（`pending → confirmed` + 反馈）。下一轮重建时把该行的**当前状态**渲染进 agent 看到的历史——这就是「更改对应消息的返回」的落法，无需存/改 Pi 消息。
5. **确认后重生成集合 = 未读节点 +「当前阅读进度所在节点」**，其余已读节点保留旧版本。**有意覆盖** `agent_design.md` §7.4/§8.2 与基线阶段6「当前节点保留」，落地须同步改那三处文档。原文/锚点不可变，重生成只换导读/裁读注/节后助读，不影响阅读位置。

## 2. `runAskAiAgent` 模块（packages/agent-kit）

### 2.1 签名

```text
runAskAiAgent(options: {
  apiBaseUrl, apiKey, modelName, sessionId,
  context: Record<string, unknown>,   // 由 host 从业务行装配（见 §2.4）
  toolbox: AskAiToolbox,
  maxTurns?, timeoutMs?,
  onAnswerDelta?: (chars: string) => void,        // text_delta → 回答正文
  onProposal?: (payload: StrategyChangeProposal) => void,  // 工具触发 → 前端挂卡
  onTrace?,
}): Promise<AskAiOutcome>
```

```text
AskAiOutcome = {
  answer: string,                       // 最后一条 assistant 文本
  proposedStrategyChange?: StrategyChangeProposal,
  patchedProfile: boolean,
  turns, toolCalls,
}
```

### 2.2 8 个工具（全部非终止）

| 工具 | 类型 | 说明 / 复用 |
|---|---|---|
| `get_question_context` | 读 | 划线文本+所在段 或 当前屏幕原文；当前 `section_id+segment`+位置 |
| `get_book_outline` | 读 | 复用 [`BookAnalysisToolbox`](../../packages/agent-kit/src/index.ts:1057) 同名逻辑 |
| `read_book_node` | 读 | 同上；可命中未读节点，无防剧透 |
| `search_book` | 读 | 同上 |
| `get_original_notes` | 读 | 当前/指定位置的原书脚注、尾注 |
| `get_reader_context` | 读 | 长期画像 + 本书画像 + 当前**已确认**策略 |
| `update_reader_profile` | 写副作用 | 复用 [`ReaderProfilePatchSchema`](../../packages/agent-kit/src/index.ts:690)；无需确认，须有对话证据 |
| `propose_strategy_change` | 写副作用 | 创建/修订 pending proposal；调 `toolbox.proposeStrategyChange`，并经 host 触发 `onProposal` |

工具返回给模型的都是普通结果（含 `propose_strategy_change`，返回 `{status:'pending'}` 之类），**均不带 `terminate`**。

### 2.3 proposal 入参 schema

```text
StrategyChangeProposal = {
  public_summary: string,        // 确认卡正文：改什么、为什么
  strategy: ProposedStrategy,    // 确认后 host 直接提升为新 strategyVersion，无需再跑 agent
}
```

`ProposedStrategy` = [`ReadingStrategySchema`](../../packages/agent-kit/src/index.ts:707) 去掉 `trial_candidates`（阅读期改策略与试读无关，那个 `minItems:3` 约束不适用）。实现时抽出公共 core 或另定一个 schema，二选一。

### 2.4 上下文重建 `reconstructAskAiHistory(context)`

同 `reconstructReadingSetupHistory` 的思路，**从业务行拍平成文本**：

1. 初始问题上下文 → user 消息（划线/屏幕 + 当前节点）。
2. 本问题会话的历史逐条回放（question=user，answer=assistant 文本）。
3. 若本会话有 proposal，追加一条 assistant 文本「我建议这样调整…（已提交为处理方式调整建议）」，再按 proposal 行**当前状态**追加一行：
   - `pending` → 「（等待你确认）」
   - `confirmed` → 「用户已确认此调整。」
   - 有反馈 → 「用户未确认，反馈：…」

agent 由此知道上一条建议的结局，决定是改同一个 proposal 再提，还是往下说。

### 2.5 流式

订阅 `message_update` 的 `assistantMessageEvent`：`text_delta` → `onAnswerDelta`（`thinking_delta` 丢弃或只做「思考中」指示）。比访谈简单，不需要容错 JSON 解析。`propose_strategy_change` 的 `execute` 里捕获入参后触发 `onProposal`。

### 2.6 Fake engine

仿 [`createFakeReadingSetupEngine`](../../apps/api/src/reading-setup-engine.ts:203)，本地/测试无需真模型即可跑通问答与 proposal 事件路径。

## 3. 数据模型（host）

- **`qa_sessions`**：一个问题一条（同问题追问复用）；`user_book_id`、`status`、`conversation_version`（乐观锁）、初始问题上下文锚点、时间戳。
- **`qa_messages`**：`qa_session_id`、`sequence`、`role`、`kind`、`content`(文本)、`payload`(jsonb)、`idempotency_key`。字段沿用 [`interview_messages`](../../packages/database/src/schema.ts:596) 的形状。
- **`strategy_change_proposals`**：`user_book_id`、`qa_session_id`、`triggering_message_id`、`status`(`pending`/`confirmed`/`rejected`/`superseded`)、`public_summary`、`proposed_strategy`(jsonb)、`feedback`、时间戳。**一个 user_book 同时只允许一个活动 proposal**（partial unique index，参照 [`trial_revisions_one_active_per_book`](../../packages/database/src/schema.ts:792)）。

## 4. Host 接线（API）

- **读工具**实现复用 book-analysis 的 outline/read_node/search 逻辑；`get_reader_context` / `update_reader_profile` 复用画像机制。
- **问答 SSE 端点**（发起提问 + 追问）：在当前请求内跑 `runAskAiAgent`，经 [`createStreamBridge`](../../apps/api/src/user-books.ts:317) 同时推 `text_delta` 与 `strategy_proposal` 两类事件；结束后把回答与（可能的）proposal 落业务行。
- **确认 / 反馈端点**（独立事务）：
  - 反馈 → 更新 proposal 行为待修订 + 记 `feedback`；用户下条消息触发 agent 修订同一 proposal。
  - 确认 → 事务内：把 `proposed_strategy` 提升为新 `strategyVersion` → 调度重生成**未读节点 + 当前阅读节点**（[`ensureFormalWindow`](../../apps/api/src/user-books.ts:1205) 锚定当前位置且**不再特判排除当前节点**；当前节点从 [`readerStates`](../../packages/database/src/schema.ts:950) 取，已读节点从 [`readerReadNodes`](../../packages/database/src/schema.ts:987) 判定保留）→ 标 proposal `confirmed`。
  - 拒绝/取消/失败 → 当前策略与节点内容不变。

## 5. 模型配置

按仓库既有约定用 `readModelEndpoint(env, 'QA_AI')`：读 `QA_AI_MODEL_API_BASE_URL / QA_AI_MODEL_API_KEY / QA_AI_MODEL_NAME`，三者缺失回落全局 `MODEL_API_BASE_URL / MODEL_API_KEY / MODEL_NAME`；全空则用 fake 引擎（[config.ts](../../apps/api/src/config.ts:26)、[server.ts](../../apps/api/src/server.ts)）。复用 agent-kit 的 [openai 兼容 `createModel`](../../packages/agent-kit/src/index.ts:376)。

## 6. 实现顺序

1. ✅ **agent-kit**：schemas + `AskAiToolbox` 接口 + `runAskAiAgent`（非终止循环、双事件流）+ `reconstructAskAiHistory` + fake engine + 单测（stub toolbox）。
2. ✅ **database**：`qa_sessions` / `qa_messages` / `strategy_change_proposals` migration（`0017`）。
3. ✅ **API**：host toolbox 实现 + 问答 SSE 端点（`POST …/qa`）+ 转录（`GET …/qa/:sessionId`）+ `QA_AI_*` 接线 + 端点测试（fake 引擎）。
4. ⏸️ **API**：确认/反馈端点（含新 strategyVersion + 重生成未读及当前节点）。**暂缓**——见「⚠️ 步骤 4 暂缓」。
5. ⏸️ **docs**：同步改 `agent_design.md` §7.4/§8.2、`implementation_baseline.md` 阶段6 的「当前节点保留」。随步骤 4 一起做。
6. ✅ **web**：阅读器「问 AI」入口 + 流式回答 + 只读 proposal 卡（确认交互随步骤 4）。

## 7. 不做 / 暂缓

- §3.4 进程内 session cache（DB 重建即正确，指标证明有必要再引入）。
- 回答的可点击引用（首发不强制）。
- 默认防剧透限制（按设计不做）。

## 8. 验收要点（对齐 agent_design §11）

- [ ] 每个问题独立 session；划线与当前屏幕两种上下文都可用
- [ ] 可检索后续/未读内容
- [ ] `update_reader_profile` 无需确认但须有对话证据
- [ ] 本书策略只能创建**待确认** proposal；确认卡归属触发它的那条回复
- [ ] 反馈修订同一个 proposal；未经确认不生效
- [ ] 工具失败/取消/拒绝不影响当前正式策略与阅读内容
- [ ] 确认后重生成含**当前阅读节点**，其余已读节点保留（并已同步改文档）
