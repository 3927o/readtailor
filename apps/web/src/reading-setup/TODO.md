# 正式 Reading Setup 前端：任务上下文与 TODO

更新时间：2026-07-24

## 任务目标

为 Agent 驱动的读前准备实现一个正式前端。它在用户感受上是一份由双方一起持续生成的“读前准备稿”，在系统原理上仍然是后端 Agent 对话流及 Tool 调用的 UI 投影。

本任务必须按小步推进：

1. 确认架构。
2. 写框架。
3. 写流式组件，数据可以使用 mock。
4. 将组件拼装成页面，交给项目 owner 验收 UI/UX。
5. 最后连接后端。

当前进度：正式页面已经完成后端 HTTP/SSE 接入并通过技术检查，`reading-setup`
路由现由真实 Session、持久消息/action 和活动 Run 驱动，等待项目 owner 手动验收完整
UI/UX 与真实数据链路。

## 已确认的产品与交互原则

- 旧静态原型已删除；正式实现位于 `apps/web/src/reading-setup/`。
- `apps/web/src/agent-driven-reading-setup/` 是旧 API 验证页，也不能作为正式 UI 组件层继续扩写。
- 前端不维护 `interview / brief / strategy / trial` 业务状态机，不推断 Agent 下一步应该做什么。
- Agent 消息、Tool 调用、Action 和当前 Run 是事实来源；前端只把它们投影成有序 UI 条目。
- 前端可以维护必要的短期界面状态：选项、输入内容、裁读注展开、请求 pending、SSE 展示快照和提交后的乐观回显。这些不是业务流程状态。
- 页面不是聊天气泡列表，而是一份边聊边形成的连续读前准备稿；视觉边界要克制，避免大量分隔线和卡片。
- 整体语气应像和一个朋友交流。
- 不使用全局聊天输入框。
- 只有问题回答和内容反馈以用户消息形式展示；用户消息不显示“你”，字号不能过小。
- 问答沿用旧 setup 的交互方向。
- 问题选项当前只支持单选，点击选项即提交；箭头按钮只提交自由输入，不承担选项的二次确认。
- 查询 Tool 只在执行期间显示一行安静的小字，完成后不保留 UI。
- `publish_brief` 正常展示，但不提供反馈入口。
- `publish_book_reader_profile` 完全不显示。
- `publish_strategy` 正常展示，提供下划线式反馈入口和确认操作。
- 策略确认不显示成用户消息；确认后后端启动下一轮 Agent Run，由 Agent 生成试读。
- Trial 提供下划线式反馈入口和唯一一次用户确认操作；确认本身不显示成 UserEntry。
- 最新决策重新区分“用户确认 Trial”和“完成 Reading Setup”：用户仍只在 Trial 组件中确认一次，之后由 Agent 调用无须用户再次操作的 `complete_reading_setup`。
- 正式数据入库与 user-book 激活发生在 `complete_reading_setup` 阶段，不发生在用户提交 Trial confirmation 的阶段。
- 前端收到 `complete_reading_setup` 的 `tool_execution_started` 后显示安静的完成中加载状态；收到该 Tool 的 `tool_execution_finished(isError=false)` 后，正式数据与 `active_reading` 状态已经写入，前端立即刷新 user-book 查询并进入正式阅读页。
- `run_finished` 是每一轮 Agent Run 的通用结束事件，不是 Reading Setup 完成或进入 Reader 的业务信号。普通 Run 仍在该事件后刷新 Session；complete Tool 成功后不等待 `run_finished`、不再刷新 Reading Setup Session，页面跳转卸载后可以自然终止或忽略后续 SSE。
- 流式组件接收不断变化的 props，并根据 `streaming / working / ready / failed` 改变内容与样式；组件不自行判断业务阶段。

## 已确认的架构

依赖方向：

```text
ReadingSetupPage
  └── Session controller
        ├── API transport port
        ├── connection/run view state
        └── Transcript projector
              └── ordered Transcript View Model
                    └── presentation components
```

目录现状：

```text
reading-setup/
├── ReadingSetupPage.tsx
├── api/
│   └── readingSetupApi.ts
├── session/
│   ├── types.ts
│   ├── runConnection.ts
│   ├── runConnection.test.ts
│   └── useReadingSetupSession.ts
├── transcript/
│   ├── types.ts
│   ├── projectTranscript.ts
│   └── projectTranscript.test.ts
├── components/
│   ├── entries/
│   │   ├── AssistantEntry.tsx
│   │   ├── BriefEntry.tsx
│   │   ├── NoticeEntry.tsx
│   │   ├── QuestionEntry.tsx
│   │   ├── QueryActivityEntry.tsx
│   │   ├── StrategyEntry.tsx
│   │   ├── TrialEntry.tsx
│   │   └── UserEntry.tsx
│   ├── primitives/
│   │   ├── InlineFeedback.tsx
│   │   └── StreamingCursor.tsx
│   ├── ReadingSetupSessionFrame.tsx
│   └── ReadingSetupTranscript.tsx
├── mocks/
│   └── readingSetupMock.ts
├── reading-setup.css
└── index.ts
```

模块职责：

- `ReadingSetupPage.tsx`：正式页面装配入口，已经挂载 Frame、Transcript renderer 和增量追加时的温和跟随。
- `api/readingSetupApi.ts`：正式 Session controller 使用的传输端口及真实 HTTP/SSE adapter。
- `session/`：页面级 View Model、统一用户动作、React Query、Run 观察和连接状态。
- `transcript/`：后端无关的有序渲染条目，以及持久条目、乐观条目、Live Run 条目的组合边界。
- `components/`：纯展示与交互组件，不读取后端 DTO，不调用 HTTP。
- `mocks/`：组件开发和页面装配期间使用的临时数据；接后端时不应渗入真实投影逻辑。

## 当前已经完成

- 建立新的正式模块，使用独立 `rss-*` CSS 命名空间。
- 定义 Assistant、User、Question、Query、Brief、Strategy、Trial、Notice 的 Transcript View Model。
- 定义组件渲染状态和策略/试读确认状态。
- 定义问题回答、反馈、策略确认、试读确认等页面命令接口。
- 定义后端传输端口，覆盖 Session、消息、问答、策略确认、试读确认和 Run SSE。
- 建立网络连接状态 reducer；它只描述传输连接，不描述阅读准备流程。
- 建立 `persisted → optimistic → live` 的有序 Transcript 组合边界。
- 建立 mock 驱动的临时 Session controller。
- 建立页面 Frame，包括 LibraryChrome、书籍上下文和连续文稿画布。
- 建立正式 `ReadingSetupPage`，完成 Transcript renderer 与 mock session 装配。

## 下一步 TODO

### A. 组件阶段：第一小批已完成并确认

先只实现以下组件，不一次完成全部组件：

- `ReadingSetupTranscript`：按照 `entry.kind` 做纯分发，不推断流程。
- `AssistantEntry`：普通正文和流式光标。
- `UserEntry`：右对齐、较大字号、不显示“你”，支持 sending/failed 的轻量反馈。
- `QuestionEntry`：单选和自由文本、提交后收起表单，并由独立 UserEntry 展示答案。

要求：

- 组件只接收 Transcript View Model 和 Session commands。
- 使用当前 mock controller 验证交互。
- 不连接后端。
- 不修改旧静态原型。
- 完成这一小批后停下来，由项目 owner 看结构和交互方向，再继续其他组件。

实现结果：

- 组件位于 `components/`，dispatcher 对尚未实现的事件暂不显示。
- Question 只维护选择、输入、请求 pending 等短期 UI 值；是否回答由 `entry.answer` 决定。
- 当前 mock controller 已验证：回答后问题表单收起，答案作为独立 UserEntry 出现在原位置之后。
- 选项立即提交、自由输入 trim、Assistant 流式光标和 User sending 提示均有组件测试。
- 项目 owner 已确认继续，第二批已在同一组件边界内完成。

### B. 组件阶段：第二小批已完成

第一小批确认后再实现：

- `QueryActivityEntry`
- `BriefEntry`
- 隐藏 profile 的 dispatcher 规则
- `StrategyEntry`
- `TrialEntry`
- `InlineFeedback`
- `NoticeEntry`

关键规则：

- Brief 无反馈。
- Strategy/Trial 的反馈入口只是下划线文本，展开行内输入，不出现额外聊天框。
- Strategy/Trial 确认不生成 UserEntry。
- Query 完成后由投影层移除。
- Trial 的确认完成态仍在 Trial 组件内部展示，不新增 finish 组件。

实现结果：

- Query 只在 `streaming / working` 时显示一行查询提示；失败不留下查询 UI。
- Profile 作为显式隐藏条目进入 dispatcher 后返回 `null`。
- Question 可以用可选的 `streamingPart` 精确移动光标；缺少该提示时会根据已到达的 prompt、hint 和 options 自行推断，组件外壳和已出现选项不会替换。
- Brief 可以用可选的 `streamingField` 标记当前字段；缺少该提示时以最后一个已解析字段为当前字段，字段文本增长及后续字段出现都发生在同一个组件内，不渲染反馈入口。
- Strategy 可以用可选的 `streamingSection` 标记当前段落；缺少该提示时以最后一个已有内容的段落为当前段落，已有列表项使用稳定 index 保留 DOM，新项逐条追加。
- Strategy/Trial 的反馈都使用共享下划线原语，展开后仍是当前文稿内的行内输入。
- Strategy/Trial 确认状态完全来自 `entry.confirmation`；本地只防止一次请求被重复提交。
- Trial 不做字段级流式：执行期间保持加载状态，结果一次性进入；随后支持裁读注展开，并在同一组件中展示最终完成状态。
- Notice 只有在 View Model 显式提供 retry action 时才显示重连入口，不从文案或 tone 推断。
- `components/entries/`、`components/primitives/` 和根级装配组件已分层；StreamingCursor 不再与业务事件组件并列。

### C. 页面拼装已完成，等待 UI/UX 验收

- 将 `ReadingSetupTranscript` 接入 `ReadingSetupPage` 的 `rss-transcript-mount`。
- 补全 mock，使它能覆盖：
  - Assistant 文本流式增长。
  - 未回答和已回答问题。
  - 查询中。
  - Brief 参数逐字段生成。
  - Strategy 生成中、可反馈、确认中、已确认。
  - Trial 执行中、完成、注释展开、反馈、最终确认。
  - 用户反馈的 sending/sent/failed。
  - Run/连接失败提示。
- 页面拼装完成后才考虑将 `/user-books/:id/reading-setup` 临时指向新页面，供项目 owner 手动验收。
- 不用浏览器自动化或截图做 UI 验收；由项目 owner 手动验收。

实现结果：

- `ReadingSetupPage` 已挂载正式 Transcript renderer，并临时接管 `/user-books/:id/reading-setup`。
- mock source 独立位于 `mocks/`；正式 session controller 只做 transcript 投影，不包含业务阶段枚举或前端流程状态机。
- 页面从已有回答与当前问题自然开始；用户回答后会连续生成 Assistant、查询提示、Brief、Strategy 和 Trial。
- Strategy/Trial feedback 会作为 UserEntry 出现在连续文稿中，随后模拟 Agent 生成新版本；旧版本只标记为 `superseded`，不再可确认。
- Strategy 确认模拟启动下一轮 Agent Run 并生成 Trial；Trial 确认只更新同一个 Trial 的完成状态。
- 页面没有场景切换器；失败状态由组件测试覆盖，不混入正常阅读体验。
- 页面刷新后会先自动播放一段约 3 秒的增量生成：Assistant 文本、Question prompt、hint 和 options 依次进入同一组件，完成后才开放回答。
- 新条目追加时，只有用户仍在页面底部附近才会温和跟随；用户向上阅读后不会被流式更新拉走。
- 本地验收地址：`http://localhost:5173/user-books/<真实 userBookId>/reading-setup`。

### D. 后端接入已完成

实现要求：

- 为 `ReadingSetupApi` 实现真实 HTTP 和 SSE adapter。
- 使用现有 `GET /v1/user-books/:id` 获取书名、作者和路由所需的书籍状态。
- 使用 React Query 获取或恢复 Session。
- 使用 `@readtailor/agent-state` 的 reducer 合并 Run SSE。
- 后端保留 `present_question.selectionMode` 的兼容契约；Agent system prompt 和 Tool 描述只引导生成 `single`，正式前端统一按单选投影，偶发的 `multiple` 也只提交一个选项。
- 将持久 `agentState.messages/actions` 转成 Transcript entries。
- Live projector 使用现有 partial JSON 解析能力把 `argumentsBuffer` 投影为 Question/Brief/Strategy 的部分 props。`streamingPart`、`streamingField`、`streamingSection` 只是可选的展示提示，后端不需要提供，组件在缺少它们时也能从已到达内容推断。
- 隐藏后端为 `question_answer`、`feedback` 和 `confirmation` 生成的结构化 JSON 用户输入。
- Question action 应在对应问题后投影成 UserEntry。
- 普通 feedback/message 应按真实消息顺序投影成 UserEntry。
- Strategy/Trial confirmation action 只更新对应组件，不生成 UserEntry；Trial confirmation 后等待 Agent complete，不直接把 UI 置为正式阅读完成。
- 用户提交问题或反馈后立即生成乐观 UserEntry；Session 落盘后再与服务端事实对齐。
- 对没有成功执行 `complete_reading_setup` 的普通 Run，在 `run_finished` 后刷新 Session，用持久消息替换 Live Run 和乐观条目。
- SSE 断线应重连；`run_snapshot` 是重连后的权威快照。
- 收到 `complete_reading_setup` 的 `tool_execution_started` 后显示完成中的加载状态；收到该 Tool 的 `tool_execution_finished(isError=false)` 后立即使 user-book 查询失效并跳转 `/user-books/:id/read`，不等待随后可能到达的 `run_finished`，也不再刷新 Reading Setup Session。

当前后端接口（统一 action 与 Agent complete 语义已落地）：

```text
GET  /v1/user-books/:id
POST /v1/user-books/:id/reading-setup/session
GET  /v1/reading-setup/sessions/:sessionId
POST /v1/reading-setup/sessions/:sessionId/actions
GET  /v1/reading-setup/sessions/:sessionId/runs/:runId/events
```

其中 `/actions` 已统一 message、question answer、feedback 和 confirmation；旧 `/confirm`
已删除。Trial confirmation 启动 Agent Run，由 `complete_reading_setup` 完成激活。

实现结果：

- `ReadingSetupApi` 已实现真实 Session HTTP 与 Run SSE；SSE 非终态 EOF 会交给 controller
  自动重连。
- user-book 与 Session 分别通过 React Query 获取；非 `on_shelf` 书籍按后端状态进入其
  canonical route。
- 持久 projector 按 `messages + actions` 恢复 Assistant、User、Question、Brief、
  Strategy 和 Trial；结构化 action JSON 不进入 UI，confirmation 只更新目标组件。
- 问题与 feedback 提交使用乐观 UserEntry；confirmation 只显示目标组件的提交状态。
  普通 Run 在 `run_finished` 后通过 `GET session` 与服务端事实对齐。
- Live Run 使用通用 reducer 合并 snapshot 与增量事件；首次及重连 snapshot 接受近似
  顺序，订阅后的 Assistant/Tool 内容保留真实 SSE 交错顺序。
- partial Tool arguments 会渐进投影 Question、Brief 和 Strategy；查询 Tool 完成后移除，
  profile 显式隐藏，未知 Tool 使用通用状态降级。
- Trial 直接使用后端 `titlePath + blocks + sourceOffset + BlockRange` 生成原文段落和
  annotation 锚点，不重新读取整本书。
- `complete_reading_setup` 开始时显示安静的完成状态；成功事件会先更新并刷新
  user-book 查询，然后立即进入 Reader，不等待 `run_finished`。
- Trial confirmation 与 Reading Setup complete 保持两个事实；若 Agent 未 complete，
  页面恢复后显示 Trial 已确认，不重复要求用户确认，也不误报为已经激活。

### E. 展示契约处理结果

1. **Live Run 顺序：第一版接受活动快照降级**

   当前 `AgentRunDisplaySnapshot` 主要是合并后的 `assistantText` 和独立 `tools` 数组。它不能在断线重连后准确恢复多轮 Assistant 文本与 Tool 调用的交错顺序。

   第一版不修改通用 Snapshot 契约：订阅建立后的内容按 SSE 事件顺序投影；首次活动 Snapshot 使用现有近似顺序；普通 Run 在 `run_finished` 后刷新 Session，并用有序的持久消息替换整个 Live Run。`complete_reading_setup` 成功是例外：前端在 Tool 成功事件后直接进入 Reader，不等待 Run 结束或重投影 Session。只有后续产品要求活动 Run 在任意刷新点都严格保持交错顺序时，再升级通用 Snapshot。

2. **Trial 原文与注释锚点：后端展示数据已补齐**

   Trial Tool result 保留兼容用的 `source.text`，并新增 `source.titlePath`、`source.blocks`。每个 block 包含 `blockIndex`、`kind`、`text` 和 `sourceOffset`，可将 annotation 的原始 BlockRange 稳定映射到试读片段；正式前端不需要重新读取整本书或复制 Reader 的切片业务。

### F. 后端用户动作与完成语义重构：压缩后优先处理

这一节记录 2026-07-24 在前端接入前确认并已实施的后端方向。它覆盖本文前面“Trial 确认直接激活、不再存在 finish Tool”的旧结论；OpenSpec main spec 已同步。

#### F1. 把所有外部用户动作统一到一个接口

目标是让前端只通过一个 Reading Setup 用户动作入口提交会启动下一轮 Agent Run 的输入，避免分别维护 message、question answer、strategy confirmation、trial confirmation、feedback 等多个 POST 接口。

建议目标形态：

```text
POST /v1/reading-setup/sessions/:sessionId/actions
```

路由名称仍可在实现时比较 `/actions` 与 `/turns`，但请求体必须是严格的判别联合，不能使用 `type: string + payload: any`。`session_start` 仍是宿主内部输入，不能由客户端提交。

需要覆盖的动作至少包括：

```ts
type ReadingSetupUserAction =
  | { type: 'message'; text: string }
  | {
      type: 'question_answer';
      questionToolCallId: string;
      selectedOptionIds: string[];
      freeText: string | null;
    }
  | {
      type: 'feedback';
      targetToolCallId: string;
      message: string;
    }
  | {
      type: 'confirmation';
      targetToolCallId: string;
    };
```

除了最终由 Agent 调用的 complete Tool，上述用户动作都通过同一入口做 session ownership、当前 active Run fence、目标校验、Run claim 与 enqueue，并统一返回 `StartAgentRunResponse`。Route 只负责判别与分发；各动作的业务校验仍应由独立 handler/service 完成，不能把全部逻辑堆到一个 switch 路由里。

旧接口在目标实现完成后应删除或仅在明确需要兼容时保留：

```text
POST /messages
POST /question-answers
POST /strategy-confirmations
POST /confirm
```

当前正式前端尚未连接这些旧接口，因此这是统一契约的合适时机。旧 API 验证页不构成新架构的兼容约束。

实现进度（2026-07-24）：

- 已新增严格判别联合 `SubmitReadingSetupActionRequest`，覆盖 `message`、
  `question_answer`、`feedback` 和 `confirmation`。
- 已新增单一 `POST /v1/reading-setup/sessions/:sessionId/actions`，并删除上述三种
  动作各自的旧 POST 路由。
- API route 只调用 `submitAction`；消息、问答和策略确认仍由 service 内部独立
  handler 负责归一化与业务校验，共享既有 Run admission。
- 旧 API 验证页和正式前端 transport port 已切换到统一 action 契约，但正式前端
  仍未连接真实后端。
- Strategy/Trial confirmation 已统一为
  `{ type: 'confirmation', targetToolCallId }`；服务端根据成功 Tool call 补充
  `targetToolName` 后启动 Run，旧 `/confirm` 已删除。

#### F2. 增加结构化 feedback 和 Trial confirmation；评估统一 confirmation action

Feedback 不再降级为缺少目标信息的普通 message。它必须显式携带 `targetToolCallId`，后端验证目标是当前 session 中成功且仍可反馈的 `publish_strategy` 或 `generate_trial_slice`，并把目标信息提供给 Agent。前端仍把反馈正文投影为 UserEntry，但不显示结构化 JSON。

Strategy confirmation 和 Trial confirmation 都是“用户确认一个 Agent 产物”的动作。项目 owner 倾向在合适时统一为：

```ts
{ type: 'confirmation', targetToolCallId: string }
```

最终设计决定：

- 服务端根据被引用 Tool 的真实名称只接受 `publish_strategy` 或
  `generate_trial_slice`，并向 Agent Run input 补充 `targetToolName`。
- Run 成功后沿用现有提交逻辑持久化同结构 confirmation；不提前持久化，不增加暂停
  Tool、恢复 Run 或额外状态。

无论采用哪种请求命名，行为保持：

- Strategy confirmation 引用成功的 `publish_strategy`，启动下一轮 Agent Run，允许 Agent 生成使用该精确 strategy 的 Trial。
- Trial confirmation 引用成功的 `generate_trial_slice`，只记录用户已经认可该 Trial 并启动下一轮 Agent Run；此时不得写入正式 profile/brief/strategy，也不得激活 user-book。
- Confirmation 不显示成 UserEntry。
- Confirmation 与其他结构化 action 一样，只在 Agent Run 成功提交时持久化；Run 失败时
  不产生已确认事实。

实现结果：

- `feedback` 显式携带 `targetToolCallId`，API 校验目标并补充 `targetToolName`。
- Strategy/Trial 共用 `confirmation` 请求、Run input 与持久 action。
- 两类动作都只允许引用当前 session 中成功的 `publish_strategy` 或
  `generate_trial_slice`。

#### F3. 重新拆分 Trial confirmation 与 complete

旧实现把 `POST /confirm`、`trial_confirmation` action、正式数据写入和 user-book 激活合并在一个事务中。新语义将它们拆开：

```text
用户在 Trial 组件确认
  → 统一 action 接口持久化 Trial confirmation
  → 启动 Agent Run
  → Agent 自然收尾并调用 complete_reading_setup({ trialToolCallId })
  → 宿主硬校验该 Trial 已被用户确认
  → 复用现有激活事务写入正式数据并激活 user-book
  → 前端收到 complete Tool 成功事件
  → 立即刷新 user-book 查询并进入 Reader，不等待 run_finished
```

`complete_reading_setup` 是 Agent Tool，不是第二个用户确认界面。UI 不渲染额外确认按钮；Tool 开始执行后只投影安静的完成中加载状态，执行成功后直接进入 Reader。后续 `run_finished` 仍可由通用 SSE 层接收，但完成页面已经卸载，不需要再用它刷新 Reading Setup Session。命名上不要再叫“最终确认”，以免把用户授权和宿主完成混为一谈。

Complete 必须：

- 显式接收并使用 `trialToolCallId`，不得自动选择 latest。
- 要求该 Trial 是当前 session 中成功的 `generate_trial_slice`。
- 要求 session 中已经存在用户提交的、引用同一 `trialToolCallId` 的 Trial confirmation。
- 继续验证 Trial → confirmed Strategy → Brief/Profile 的完整显式引用链。
- 在 complete 阶段复用现有 `agent-driven-reading-setup-activation.ts` 的幂等事务，写入真实 profile、brief、confirmed draft、formal strategy，更新 pointers 和 `workflowStatus=active_reading`。
- 将“用户确认 Trial”与“Reading Setup 完成结果”建模为两个事实：前者是持久
  `confirmation` action，后者是持久 `complete_reading_setup` Tool result。
- 对同一已完成 Trial 的重放返回既有激活结果，不重复写正式数据。

现有激活事务已迁移到 Worker 的 `complete_reading_setup` Tool：事务要求
`activeRunId` 与当前 Run 一致，复用原正式数据写入，并由既有 Run commit 随后持久化
confirmation 和 complete Tool result。不增加新的 Session 状态或提交协议。

实现结果：

- 新增 `complete_reading_setup({ trialToolCallId })`，显式校验 Trial、Strategy、
  Brief/Profile 引用链及对应 confirmation。
- Tool 复用原幂等激活事务，成功后 user-book 进入 `active_reading`。
- 旧 API activation service 与 `/confirm` 路由已删除。
- Trial confirmation Run 未调用 complete 时仍可正常结束，不增加强制后置条件。

#### F4. 明确暂不增加 Finish 强制后置条件

本轮决定不实现“收到 Trial confirmation 的 Run 必须调用 complete，否则整个 Run 失败”的强制 gate，也不新增 handler postcondition。

第一版只通过 Agent system prompt 和 Tool 说明引导 Agent 在收到 Trial confirmation 后调用 `complete_reading_setup`。如果 Agent 没有调用：

- 本轮允许正常结束。
- 已持久化的 Trial confirmation 仍然保留，用户不需要再次确认。
- user-book 保持 `on_shelf`，正式数据不入库。
- 后续 Run 仍可引用同一个已确认 Trial 调用 complete。

这会留下一个“已确认但尚未 complete”的可恢复状态。正式前端与 Session 恢复投影必须能展示该事实；具体自动恢复、重试入口或 Agent 后续唤醒策略暂不在本轮设计，不能偷偷重新要求用户确认。

#### F5. 预计影响模块与实施顺序

预计涉及：

- `packages/contracts`：统一 User Action request schema；feedback/confirmation/trial confirmation；拆分 completion action/result；complete Tool arguments/result。
- `apps/api`：统一 action route；各动作验证与 Run admission；现有 activation service 改为 complete 阶段调用。
- `packages/database`：若确认事实需要在入队前持久化，扩展 session store 的原子 action/Run claim 能力。
- `packages/agent-kit`：新增 Trial confirmation 输入映射、complete Tool 语义与 prompt；保留“无强制 finish gate”的决定。
- `apps/worker`：新增 `complete_reading_setup` Tool、已确认 Trial 校验、与激活事务/Run commit 的安全协作。
- `apps/web/src/reading-setup`：API port 改为统一 action；乐观 UserEntry 与确认状态投影；Trial 确认后进入 Agent Run；仅在 complete 激活成功后跳转 Reader。
- OpenSpec main spec：当前仍明确写着“Trial 直接确认并激活、没有 finish Tool”，实现代码前后必须改成这里的新语义。

建议实施顺序：

1. 先更新 contracts 和 spec，明确 action/completion 两类事实。
2. 实现统一 action route 与独立动作校验。
3. 让 Trial confirmation 可在 Agent Run 失败时仍可靠恢复。
4. 将现有激活事务迁移到 complete 阶段，解决 active Run 与 Session commit 一致性。
5. 增加 complete Tool 和 Agent prompt，不增加强制后置条件。
6. 覆盖幂等、错误目标、未确认 Trial、Agent 未 complete、complete 重放和激活事务测试。
7. 最后再接正式前端 adapter/projector，并调整 mock 的 Trial 确认后续行为。

## 当前后端语义

- 策略和 Trial 确认统一输入为 `confirmation { targetToolCallId }`；API 根据真实 Tool
  补充 `targetToolName` 并启动下一轮 Agent Run。
- Feedback 是显式引用目标 Tool 的结构化 action，不再降级为普通 message。
- `publish_strategy` 显式引用对应 brief 和 book reader profile。
- `generate_trial_slice` 只能使用已确认的精确 strategy。
- Agent 在成功的 question、strategy、trial 或 complete Tool 后停止本轮。
- Trial 仍是唯一用户确认面；确认后 Agent 调用无须再次操作的
  `complete_reading_setup`。
- 正式数据写入和 user-book 激活只发生在 complete Tool，不发生在 confirmation action。
- complete Tool 开始执行后前端显示完成中的加载状态；Tool 成功且 user book 进入
  `active_reading` 后，前端立即跳转 Reader，不等待 `run_finished` 或刷新 Setup Session。

相关后端变更已经提交：

```text
6782639 feat: confirm reading setup from trial
```

## 验证与工作区状态

已经通过：

- 正式模块定向测试：8 个测试文件、24 个测试。
- 完整 Web 测试：41 个测试文件、213 个测试。
- contracts、agent-state、agent-kit、API route 和 Worker 非数据库定向测试：
  6 个测试文件、18 个测试。
- Web 完整 TypeScript 检查。
- Web 生产构建。
- `git diff --check`。

生产构建只有既有的单 chunk 大于 500 kB 警告，不影响本次构建产物。
数据库集成测试仍需要 `TEST_DATABASE_URL`，本次未重复运行。

工作区仍包含本任务开始前已有的后端重构、静态原型和正式前端未提交修改；本次没有替用户
创建 commit。后续提交仍须按需求拆分，避免把旧静态原型与正式前端无意混为一个提交。

## 后续手动验收

1. 用一本文档已 ready、user-book 为 `on_shelf` 的真实书进入 Reading Setup。
2. 验收首次恢复、问题单选/自由输入、feedback、新 Strategy/Trial 和页面刷新恢复。
3. 在 Agent Run 期间断开并恢复网络，确认 snapshot 校正与后续实时内容连续。
4. 确认 Trial 后观察完成中状态；complete Tool 成功应直接进入 Reader。
5. 验证已确认 Trial 但 Agent 未 complete 的恢复状态不会再次要求确认。
