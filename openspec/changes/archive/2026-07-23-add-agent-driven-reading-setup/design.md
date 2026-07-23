## Context

现有阅读准备把访谈、策略草稿、三段试读和最终采用建模为多个数据库实体、workflow 状态和 operation。新功能采用相反边界：一个完整保存的 Agent 会话负责对话编排，宿主只提供资源读取、产物展示、一次试读切片生成、用户交互和最终确认能力。

本设计中的 Agent session 是用户与一本书之间的完整长期对话；Agent run 由首次内部 `session_start`、用户消息或结构化动作触发，经过任意多个 LLM/Tool turn，直到 Agent 自然结束或需要再次等待用户的后台执行。Run 不是业务阶段，也不是版本。

当前代码有四项不可忽略的约束：

- `book_reader_profile_versions.interview_session_id` 不可空；
- `strategy_versions.source_draft_version_id` 不可空；
- `StrategySchema.trialCandidates` 目前强制恰好三个；
- Reader 及“问 AI”会读取当前 profile、draft 和正式 strategy。

因此，最终激活仍需写入真实 brief、book reader profile 和 strategy，并为上述旧结构补最小外壳；这不代表新 Agent 流程依赖旧 setup 编排。旧 setup 删除后，正式数据保留，只有外壳约束可被删除。

当前 `@earendil-works/pi-agent-core@0.80.6` 已提供完整消息记录、Tool 参数增量、`tool_execution_start/update/end`、低层 `runAgentLoop` 和 `shouldStopAfterTurn`。这些能力足以实现同一 assistant turn 内多个 Tool 执行完毕后再停止等待用户，不需要把交互 Tool 限制为该 turn 的唯一 Tool。

## Goals / Non-Goals

**Goals:**

- 让 `on_shelf` 的 user-book 通过一个 AI 会话完成访谈、brief、book reader profile、strategy、一次试读切片和最终确认。
- 保存可重建 Agent SDK context 的完整应用级 session snapshot，而不是序列化含模型、函数和运行态集合的原始 `agent.state`。
- 让 Agent run 和工具执行脱离 SSE 连接；离开页面、断网或 API 连接关闭只取消订阅，不取消后台执行。
- 分离 Tool 参数生成与 Tool 执行事件，使 publish、question 和 confirmation 卡片可在参数生成时实时出现。
- 让 Agent 使用始终可用的工具自主决定追问、发布或修订产物、生成或重做试读，以及何时提供最终确认。
- 只生成一个 `tailoringEligible` reading node 内的连续 `BlockRange` 试读切片。
- 用户点击确认后才在一个幂等事务中写入正式业务数据并切换到 `active_reading`。
- 首版以完整后端能力和极简验证页面验证 Agent 行为、流式卡片、断线恢复和最终激活。

**Non-Goals:**

- 不修改或删除现有 setup 实现；删除旧实现属于后续 change。
- 不修改既有“问 AI”的运行方式或事件协议；将其迁移到通用 Worker 属于后续 change。
- 不把旧 setup 的 phase、调整次数、trial revision、trial generation 或 operation 搬到新会话中。
- 不把多个 reading node 拼成试读章节，也不保存真实试读业务行。
- 不保证恢复模型调用中途的最后一个 token；后台 run 可以在 Worker 崩溃后从该 run 的输入和已提交 session state 整轮重试。
- 不在本 change 中制作正式产品级前端，也不重构正式策略、正式生成或中途“问 AI”策略调整的数据模型。

## Decisions

### 1. 以可序列化 Agent session snapshot 作为事实来源

新增 `ai_reading_setup_sessions`，最小字段为：

```text
id              uuid primary key
user_book_id    uuid not null unique
agent_state     jsonb not null
active_run_id   uuid null
created_at      timestamptz not null
updated_at      timestamptz not null
```

`agent_state` 使用应用自有 DTO，保存：

```text
systemPrompt
modelConfigId
thinkingLevel
messages        # user / assistant / toolResult，含 thinking、usage、timestamp
actions         # 回答问题、最终确认及其结果
```

模型对象、Tool 函数、API key、`pendingToolCalls`、AbortSignal 等运行态不进入 JSON。Worker 每次依据 `agentType` 和服务端注册表重建模型与 Tool，再把已保存 messages 交给 SDK。

新功能不创建 plan、artifact version、trial 或 message 业务表。brief、book reader profile、strategy、试读和最终确认分别表现为完整 Tool call/result；多次发布自然保留在消息历史中。

相比 session + message + artifact 多表，单 JSON snapshot 更符合该会话短生命周期、单写者和完整 SDK 恢复需求。若未来需要跨会话检索或永久逐事件审计，再单独提出事件表变更。

### 2. `active_run_id` 只做单写入门禁，不做版本

系统不新增 `state_version` 或递增乐观锁。`active_run_id` 既是后台 job 标识，也是单写者门禁。创建 run 时条件设置 `active_run_id`；提交或失败时仅匹配该 run id 的 Worker 可以写入或清空。因此旧 job 不能覆盖或释放后来 job。

最终激活时现有 profile/draft/strategy 表仍必须填写其既有 `version` 列；这是当前正式数据表的约束，不是新 Agent session 的状态版本。

### 3. 通用 Agent Run Worker 承担后台执行

队列 job 使用通用载荷：

```text
agentType
sessionId
runId
input
```

通用层负责队列、session 读取、单写入、事件标准化、progress snapshot、重试和提交；handler 注册表负责为具体 `agentType` 提供 system prompt、模型配置、Tool 和资源访问。本 change 只注册 `reading_setup`，不迁移既有“问 AI”。

新建或恢复空白 session 时，API 使用只允许 `messages` 和 `actions` 均为空的原子条件 claim 启动一次内部 `session_start` run；并发入口返回同一 active run，已提交过历史的 session 不再自动启动。该内部输入只触发模型开始读取信息和自然开场，不作为用户发言写入持久消息。后续消息提交端点完成归属与输入检查后：

1. 生成不可预测的 `runId`，条件设置 `active_run_id=runId`；已有 active run 时拒绝并返回其标识。
2. 以 `runId` 为 job id 将用户输入或结构化 action 入队；入队失败时条件清空该 run id。
3. Worker 读取已提交 `agent_state`，重建 handler，把本次输入加入工作副本，通过 SDK `runAgentLoop` 执行完整循环。
4. Worker 将 assistant/Tool 增量发布到运行通道，并持续更新可查询的 run display snapshot。
5. Run 成功后在同一数据库事务中写入新的完整 `agent_state` 并条件清空 `active_run_id`。
6. Run 失败时保持上一次已提交 `agent_state`，发布可重试错误并条件清空 `active_run_id`。

浏览器 AbortSignal 不传递给 Agent job。API SSE 断开只移除订阅。Worker 崩溃时队列从上一次已提交 session snapshot 和同一 run input 整轮重试；失败 attempt 的临时 UI 由新 snapshot 覆盖。Agent Tool 在最终确认前不写正式业务状态，所以重试不会重复激活或产生孤立 trial 行，但可能重复模型和试读生成成本。

相比在 API 进程启动 detached Promise，持久队列才能为离开页面和进程重启提供可验证保证。相比为每个工具建立 operation，run job 是通用执行边界，不表达任何 setup 阶段。

### 4. 交互 Tool 执行完成后，run 在 turn 边界等待用户

`present_question` 和 `offer_final_confirmation` 都是立即返回成功结果的普通 Tool，不跨进程等待用户，也不使用 `terminate: true`。Runner 的 `shouldStopAfterTurn` 在当前 assistant turn 的全部 Tool 完成后检查结果：只要该 turn 有成功的上述交互 Tool，就在下一次 LLM 请求前正常结束 run。

因此读取、发布和交互 Tool 可以共存于同一 assistant turn，也不硬性拒绝多个交互 Tool。每个交互卡片用自己的 `toolCallId` 接收用户动作。系统提示词仍要求通常一次只提出一个当前问题，但这不是宿主状态机。

用户回答问题时提交：

```text
questionToolCallId
selectedOptionIds
freeText
```

该 action 在引用的 run 成功提交后才可操作，并作为下一次 Agent run 输入。最终确认按钮提交 `offerToolCallId`，直接执行确定性确认事务，不再启动 LLM run。

### 5. SSE 明确区分 Tool 参数生成与 Tool 执行

实时协议以 `runId`、`toolCallId` 和每个 run 单调递增的 `sequence` 关联事件，包含：

```text
run_snapshot
assistant_text_delta
tool_call_started
tool_call_arguments_delta
tool_call_finished
assistant_message_finished
tool_execution_started
tool_execution_progress
tool_execution_finished
run_finished
```

`tool_call_started/arguments_delta/finished` 来自 provider 的 `toolcall_start/delta/end`，表示模型正在构造调用；`tool_execution_started/progress/finished` 来自 SDK 执行事件，表示服务端已经开始执行并给出部分或最终结果。`tool_execution_finished` 携带完整 result 与 `isError`，因此不再另设 `tool_result` 事件；run 级失败由 `run_finished(status=failed)` 表达。

`run_snapshot` 不是业务事件，而是当前 run 临时 UI 的完整替换帧，包含 `lastSequence`。订阅端先建立事件监听并缓冲新事件，再读取 snapshot，发送 snapshot 后只转发 sequence 更大的缓冲和后续事件，从而不存在“订阅前动作无法恢复”的窗口。过去的动作以当前状态恢复，不重播动画；已完成 run 从持久化 `agent_state` 渲染。

`tool_call_arguments_delta` 携带原始 JSON 字符。前端可复用现有 `completeJson` 做 best-effort 渲染；`tool_call_finished` 的完整参数是权威值。用户操作按钮必须等 Tool 参数完成、Tool 执行成功且整个 run 已提交后才启用。

### 6. Tool 契约和执行边界

每次 run 向 Agent 暴露同一组 Tool。

#### 读取 Tool

| Tool | 入参 | 输出与执行 |
|---|---|---|
| `get_reader_profile` | `{}` | 当前用户长期 reader profile；不存在时返回 `null`。 |
| `get_book_profile` | `{}` | 当前 shared book 的已保存 book profile，不含用户信息。 |
| `get_book_outline` | `{ offset?, limit? }` | 只分页返回 manifest `outline` 项、total、nextOffset 和 truncated，不混入 reading nodes。 |
| `list_reading_nodes` | `{ sectionId?, offset?, limit? }` | 返回节点的 sectionId、segment、order、title/path、characterCount、blockCount 和 tailoringEligible，不返回正文。 |
| `read_book_node` | `{ sectionId, segment, start?, maxCharacters? }` | 从可选 `BlockPoint` 开始读取节点正文，返回 pageRange、带 blockIndex/offset 边界的正文 blocks、nextStart 和 truncated，使 Agent 能构造有效 `BlockRange`。 |
| `search_book` | `{ query, limit? }` | 返回有限命中，每项只含位置、标题和短 snippet，并给出 truncated。 |

所有读取结果都有服务端硬上限，Agent 参数只能在上限内缩小结果。首版配置从现有能力附近起步：outline/nodes 默认 100、硬上限 200、单次序列化约 50 KB；node page 默认 6,000 字符、硬上限 12,000；search 默认 20、硬上限 50，并另设 snippet 和总响应上限。这些数值是可调实现配置，不写入产品需求。

#### 发布与交互 Tool

`present_question`：

```text
{
  prompt,
  hint?,
  options: [{ id, label }],
  selectionMode: "single" | "multiple",
  allowFreeText
}
```

`publish_brief({ brief })`、`publish_book_reader_profile({ profile })` 和 `publish_strategy({ summary, strategy })` 分别接收现有 `Briefing`、`BookReaderProfile` 和不含 `trialCandidates` 的 strategy core。它们只校验并发布卡片，不写 brief/profile/strategy 业务行。每个成功结果回传自身 `toolCallId`，供 Agent 在后续 turn 显式引用；多次发布不计算 latest 或 version。

`generate_trial_slice`：

```text
{
  strategyToolCallId,
  sectionId,
  segment,
  range: BlockRange,
  reason
}
```

工具只接受同 session 中明确引用且已成功的 `publish_strategy`。它验证节点存在且 `tailoringEligible`、range 位于该节点 blocks 内、连续非空且未超过试读输入上限，然后对该切片调用一次独立裁读生成。结果包含 source location/range、切片原文及 guide/annotations/afterReading；结果只进入 Agent session 和 UI，不创建任何 trial 业务数据。

`offer_final_confirmation`：

```text
{
  briefToolCallId,
  bookReaderProfileToolCallId,
  strategyToolCallId,
  trialToolCallId,
  summary
}
```

工具验证前三个 id 均指向同 session 内相应的成功 publish call，`trialToolCallId` 指向同 session 内成功的 `generate_trial_slice`，且该试读调用引用的 `strategyToolCallId` 与本次确认完全一致，然后发布确认卡片。它不自动选择最新产物，也不写业务数据。

### 7. 用户确认事务写真实正式数据与最小结构外壳

最终确认是独立的确定性 action，而不是 Agent 可自行执行的工具副作用。服务端验证：

- session 与 user-book 属于当前用户；
- user-book 仍为 `on_shelf` 且 shared book 可用；
- action 引用 session 中成功的 `offer_final_confirmation`；
- 该 offer 明确引用的 brief、book reader profile 与 strategy publish calls 以及 trial slice call 均成功且来自同一 session；
- trial slice call 引用的 strategy call 与 offer 引用的 strategy call 完全一致；
- 当前没有 active run。

验证后，一个数据库事务直接写入：

1. 创建或复用该 user-book 唯一的 `interview_sessions`，将其置为 completed，作为 profile 非空外键所需的结构外壳；
2. 从 `publish_book_reader_profile` 写入真实 `book_reader_profile_versions`；
3. 从 `publish_brief` 和 `publish_strategy` 写入 confirmed `strategy_draft_versions`；
4. 写入指向该 draft 的真实 `strategy_versions`；
5. 更新 `user_books` 的 interview/profile/draft/strategy pointers 和 `workflowStatus=active_reading`，并令 trial pointer 为空；
6. 把用户确认 action 与激活结果加入 Agent state。

由于入口只要求 `on_shelf`，不能假设旧表完全为空：现有访谈初始化在插 session 与更新 user-book 之间并非一个事务，故可能残留 session。确认事务复用该唯一 session，并为 profile/draft/strategy 分配各表当前下一个 version，而不是固定 version 1。这里没有新增 Agent 状态版本。

正式 strategy 的 core 与 summary 是真实数据。仅因当前 `StrategySchema` 强制三个 `trialCandidates`，事务从 manifest 选取一个确定性的 `tailoringEligible` 节点并重复构造三个结构占位；占位不代表本次真实试读，也不创建 trial 行。该补齐逻辑必须隔离，待 schema 删除旧 trial 候选要求时移除。

事务不创建 interview message/answer、trial revision/segment/generation、setup operation 或 formal generation。现有 Reader bootstrap 会按当前逻辑确保 formal generation window。相同 `offerToolCallId` 的确认重放返回既有激活结果，不重复插入。

### 8. 首版 Web 只承担验证

新增独立于旧 `ReadingSetupRoute` 的极简会话页。页面只维护持久 session、可选 active run snapshot、composer 和 SSE reducer，并提供：

- assistant 文本；
- question、brief、profile、strategy、trial slice、confirmation 的基础 renderer；
- Tool 参数实时填充与执行状态；
- 问题回答、普通文本输入和最终确认；
- 刷新及断线重连后的恢复。

页面不从 Tool 顺序推断阶段，也不在旧 interview/strategy/trial 页面间跳转。正式布局、动画、视觉和产品级错误体验留给后续 change，由项目 owner 对首版交互进行人工验收。

## Risks / Trade-offs

- [单行 JSON snapshot 随会话增长而变大] → 设置 session 总大小、单 Tool result 和读取分页上限；达到上限时要求 Agent 收敛或重新开始会话。
- [完整 Tool result 含书籍原文] → 只返回受限正文/切片，所有读取校验书籍归属，正文不进入日志或 telemetry。
- [Worker 重试会重复模型调用并产生不同试读] → 只在完整 run 成功后提交 session state；失败 attempt 的临时 progress 可被新的 `run_snapshot` 替换，正式激活不在 Agent run 内执行。
- [arguments delta 是未闭合 JSON] → 只做 best-effort 展示；完整 arguments 到达后替换，临时参数不能启用用户动作。
- [AI 可能过早尝试最终确认] → system prompt 明确访谈到试读再确认的目标；宿主不重新引入 phase gate，但 `offer_final_confirmation` 硬校验三个正式产物和一次使用同一 strategy 成功生成的试读，条件不足时返回 Tool error 让 Agent 继续处理。
- [旧结构占位可能被误认为真实试读] → 新 UI 和 Agent session 不把占位作为试读事实；补齐逻辑集中隔离，并在旧 schema 约束删除时移除。
- [`on_shelf` 书可能残留旧行] → 复用唯一 interview session、给正式表分配下一个 version，并始终把 user-book 指针原子切向本次新数据。
- [队列或 Redis 不可用时无法启动 run] → 不设置 active run 残留；向用户返回可重试错误，已提交 Agent state 保持不变。

## Migration Plan

1. 新增 Agent session 表、通用 run queue/handler、独立 API 和事件协议，不改变旧 setup 与“问 AI”。
2. 实现读取、发布、交互和试读 Tool，以及用户确认事务。
3. 新增极简验证页，在受控入口验证多轮对话、实时卡片、刷新/断线恢复、Worker 重试和最终激活。
4. 验证通过后开放 `on_shelf` 入口；正式前端另建 change。
5. 回滚只需关闭新入口；未确认会话不影响 user-book，已激活书拥有现有 Reader 可读取的正式数据。
6. 删除旧 setup 时，另建 change 移除 interview shell、三个 trial candidate 占位及相关旧 schema 约束。

## Open Questions

- 读取 Tool 的默认数值在首版验证中调优，但“所有输出有硬上限、可分页并显式返回截断信息”的契约不变。
