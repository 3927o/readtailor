# 核心链路重构方案（B：单 Agent · 连续会话 · 流式访谈）

> 本文件是一份**可独立执行的实施规范**。新会话拿到它即可开工，不依赖任何对话上下文。
> 行号锚点为审计当时状态，实现前请以实际代码为准（用符号名定位，行号仅辅助）。

## 0. 元信息

- **范围**：只重构核心链路 `书架 → 本书访谈 → 读前简报/处理方式确认 → 三个试读样章 → 采用 → 阅读器（原文+增强）`。**不含**非核心界面（登录/长期画像 onboarding/阅读统计/最近删除/全文搜索/笔记）——那些是另一批工作。
- **真源头优先级**（沿用 `docs/README.md`）：用户可见行为以 `product/product_prd.md` 为准；位置/统计以 `contracts/reading_contract.md`；Agent 边界以 `architecture/agent_design.md`；工程实现以 `architecture/technical_architecture_v2.md` + 本文件。原型 `design/prototypes/readtailor-mvp.dc.html` 定**交互形态**，数据契约仍以文档为准。
- **前置阅读**：`agent_design.md` §2/§3.3/§3.4/§6；`product_prd.md` §8/§9/§10/§11.3/§3.6；`reading_contract.md` §2.4/§2.5/§5/§6。
- **已锁定的决策**（本次讨论产出，不再重开）：
  1. 采用方案 **B**：把"访谈与处理方式"链路还原成**一个 Agent、一个 user-book 一条连续逻辑会话**，配齐 `agent_design §6.5` 的完整工具集。
  2. 访谈"信息充足度" = **Agent 自评**（问题里带 `sufficiency` 字段），不是客户端伪造。
  3. 访谈交互要**真流式**：acknowledgment 逐字、问题正文逐字、选项逐个弹出，全部由后端 token 级增量驱动。

---

## 1. 背景：现状为什么不对

核心链路后端状态机 ~85% 是对的、工程也扎实（见 §2 审计回执），"乱"主要来自：**agent 被拆成两个 + 试读选点被机械化 + 结构化策略被 fabricate + 前端再造一层假数据**。本次要收敛的正是这几处，其中多数**同时也是对文档的偏离**。

现状（要改掉的）：

- `packages/agent-kit/src/index.ts` 里有**两个**独立 agent：`runReadingSetupAgent`（访谈+完成，:566）和 `runStrategyRevisionAgent`（策略修订，:684）。两者都是 `new Agent({ …, messages: [] })` **空历史冷启动**——修订 agent 看不到访谈对话，只喂一坨 JSON context。
- `apps/api/src/reading-setup-engine.ts` 把它包成 `next` / `revise` 两个方法（:10-40），坐实了"两个 agent"。
- 试读片段的**范围**由宿主 `rangeForNode` 机械取节点前 6 个块（`user-books.ts:188-197`），Agent 只给了 3 个候选节点，没定范围 → 偏离 `PRD §10.2`。
- 结构化策略被 `mapStrategy`（`user-books.ts:152-175`）硬编造：`expressionPrinciples` 写死一句、所有 `enabled` 强制 `true`、无 in-object version；且这个残缺对象**直达生成器**（`worker/src/tailoring/job.ts:194-215` → `prompt.ts`）→ 偏离 `PRD §3.6`。
- `agent_design §6.5` 设想的四个工具 `save_reading_briefing / select_trial_fragments / request_trial_generation / publish_trial_revision` **代码里全不存在**。
- 访谈端点是纯 JSON（`POST /v1/user-books/:id/interview/answers` → `UserBookWorkflowResponse`），拿不到流式质感。

---

## 2. 核心链路对文档符合性审计（回执）

**先读这张表再动手。绿的别推倒重来（B 不会重造这些）；红/黄的才是活。**

| 环节 / 契约 | 判定 | 处置 |
|---|---|---|
| 访谈 ≤7 问、宿主侧硬卡、AI 判断充足 (§8.3) | ✅ 合规 | 保留（7 上限靠"`askedCount>=7` 不给提问工具" `agent-kit:583`）|
| 访谈同步在请求里跑、不进队列 (§10.1) | ✅ 合规 | 保留 |
| 访谈完成产物可恢复+幂等 (§8.4) | ✅ 工程可靠 | 保留（单事务 `user-books.ts:371-445` + 下次 `/workflow` 自愈 + `(userBook,version=1)` 唯一索引）|
| 简报/策略一状态、首次确认只生成试读不建正式策略 (§9.3) | ✅ 合规 | 保留 |
| adjustment_count 共用/上限5/初始不计/技术重试不+1 (§9.4,§10.5) | ✅ 合规 | 保留 |
| 采用六项原子校验+幂等 (§10.8) | ✅ 合规 | 保留 |
| 缓存键含 user_id+画像版本+策略版本+scope (§5,§7.4) | ✅ 合规 | 保留（`tailoring/cache.ts:6-28`）|
| 注释 quote→range 精确唯一匹配、越界整条拒绝重试 (§6) | ✅ 合规 | 保留（`tailoring/parser.ts:103-147`）|
| 原文永在、AI 失败仍可读 (§14.3) | ✅ 合规 | 保留 |
| 试读&正式共用同一生成器、只差 scope (§10.3) | ✅ 合规 | 保留 |
| **一个"访谈与处理方式 Agent"、一条连续会话 (§2,§3.3,§6)** | ❌ 偏离 | **§3 修**（拆成了两个冷 agent）|
| **前后端 block 枚举同一实现 (§2.4)** | ❌ 偏离·静默 | **§6.1 修**（各写一套且不一致，静默错位/丢注释）|
| **正式阅读懒加载窗口：当前+后续3个可裁读节点、跳转提权 (§11.3)** | ❌ 未实现 | **§6.2 修**（全书只增强前4节点，且 PRD 验收 :1467 本就没打勾）|
| 试读片段范围由 Agent 选、够独立上下文 (§10.2) | ⚠️ 部分 | **§3.5 修**（节点是 Agent 选的，范围机械取前6块）|
| 结构化策略保真度 (§3.6) | ⚠️ 部分 | **§3.4 修**（mapStrategy 造假、直达生成器）|
| 试读 all-or-nothing、不展示部分成功 (§10.5) | 🐛 工程 + ⚠️部分 | **§6.3 修**（发布竞态 + API 未发布就吐单片段 result）|
| 试读反馈退回策略、整轮 supersede (§10.7) | 🐛 工程 | **§6.4 修**（跨两个事务不原子）|
| approve/adopt idempotencyKey、feedback 幂等、workflowStatus 守卫 | ⚠️ 部分 | **§6.5 修** |

---

## 3. B 主体：统一"访谈与处理方式 Agent"

### 3.1 一个 Agent、一条连续逻辑会话

**目标形态**（`agent_design §2 表 :67`、§3.3 :131）：每个 `user_book` 一条逻辑业务会话，覆盖 `访谈 → 简报/策略确认 → 选试读 → 反馈修订`。Pi session 只活在单次请求内（§3.3 :135），所以**每轮都从数据库重建 agent 的 `messages`**，而不是 `messages: []`。

**实现**：

- 在 `packages/agent-kit/src/index.ts` 用**一个** `runReadingSetupAgent` 承载全部阶段，删除 `runStrategyRevisionAgent`。
- 新增一个从业务数据重建对话历史的函数（放 `agent-kit` 或 `user-books.ts` 皆可），把持久化产物翻译成 `AgentMessage[]`：
  - `interview_messages`（kind=`question`）→ assistant 消息（含当时的 present_interview_question 工具调用）
  - `interview_messages`（kind=`answer`）/ `interview_answers` → user 消息
  - `interview_messages`（kind=`feedback`）→ user 消息（策略/试读反馈原文）
  - 已产出的 `strategy_draft_versions`（含 briefing / userFacingSummary / strategy）→ assistant 的历史工具调用结果
  - 长期画像 `reader_profiles` + `book_profile.json` 通过 system prompt 或首条 context 注入
- `reading-setup-engine.ts`：把 `next` / `revise` 二分**收敛成一个** `runTurn(input)`，输入携带 `phase`（`interviewing | strategy_review`）与重建好的历史；由 phase 决定暴露哪些工具（见 §3.2）。删掉 `createFakeReadingSetupEngine` 里 `next/revise` 的双份 fake，改成单份 `runTurn` 的 fake。

> 收益：修订轮次是"暖"的——能看到访谈全程与历次草稿，符合 §3.3 的连续会话意图；`agent_type` 从两个收敛成一个，`agent_design §3.4` 的 session-cache key `agent_type + logical_session_id` 也对得上了。

### 3.2 工具集（按 phase 状态化暴露）

以 `agent_design §6.4/§6.5` 为准。每轮只装配当前 phase 需要的工具（最小权限，§1.3）。

| phase | 暴露的工具 | 说明 |
|---|---|---|
| 访谈中 | `get_reader_profile` `get_book_profile` | 只读长期画像 / 书籍画像（§6.4）|
| 访谈中 | `present_interview_question`（`askedCount<7` 时）| 提下一题，见 §3.3 输出契约 |
| 访谈中 | `finish_interview`（`askedCount>0` 时）| 提交本书画像+简报+公开策略+结构化策略 |
| 策略确认/修订 | `save_strategy_draft` | 吸收反馈产出新草稿（结构化策略见 §3.4）|
| 选试读（approve 后）| `read_book_node` `get_book_outline` `search_book` | 让 agent 读到真实节点内容再定片段 |
| 选试读 | `select_trial_fragments` | Agent 定 3 个片段的 `section_id+segment+block range`，见 §3.5 |

> `request_trial_generation` / `publish_trial_revision`（§6.5 也列了）**不做成会阻塞流程的 agent 工具**：试读的实际生成、all-or-nothing 发布、状态推进仍由**确定性宿主+worker**拥有（审计证明这套已经工程正确，别搬进 agent）。Agent 的职责止于"选片段"；`select_trial_fragments` 落库后由宿主 `createTrialRevision` 建 revision/segments/generations 并入队，worker 生成并发布。**这是本方案对 §6.5 的务实取舍，见 §10 开放问题**。

### 3.3 `present_interview_question` 输出契约（决策2 + 决策3 落点）

字段**按此顺序**产出，方便流式"先致谢、再问题、后选项、末充足度"：

```ts
// packages/agent-kit —— present_interview_question 入参
Type.Object({
  acknowledgment: Type.String({ minLength: 1, maxLength: 200 }), // 对上一答的真实回应（逐字流）；首问可为空串
  prompt:         Type.String({ minLength: 1, maxLength: 400 }), // 问题正文（逐字流）
  options:        Type.Array(Type.Object({
                    id:    Type.String(),
                    label: Type.String(),
                  }), { minItems: 2, maxItems: 5 }),             // 逐个弹出
  allow_text:     Type.Literal(true),
  sufficiency:    Type.Integer({ minimum: 0, maximum: 100 }),    // Agent 自评（决策1）
})
```

- `sufficiency` 是 agent 每轮的**自评估计**，可非单调（agent 反悔就回落）。UI 直接显示该值；不要客户端再攒分。
- 契约层同步：`packages/contracts/src/index.ts` 的 `InterviewQuestion` 增加 `acknowledgment`、`sufficiency`；`InterviewStateResponse` 增加 `sufficiency`（非流式回退时也能显示）。
- 持久化：问题落 `interview_messages(kind='question')` 时把整个 payload（含 acknowledgment/sufficiency）存进 `payload` jsonb。`acknowledgment` 是**一次性流式点缀**，历史回看不需要重放（原型历史区只显示 Q+A）。

### 3.4 `finish_interview` 与结构化策略扩宽（修 §3.6）

`ReadingStrategySchema`（现 `agent-kit:537-551`）比 `PRD §3.6 / agent_design §6.5` 窄，导致 `mapStrategy` 造假。**把缺的字段让 agent 真产出，删掉 mapStrategy 的 fabricate**。

目标结构化策略（camelCase 存 `strategy_draft_versions.strategy` / `strategy_versions.strategy` jsonb，agent 侧对应 snake_case）：

```ts
{
  goals:                string[],          // 处理目标
  expressionPrinciples: string[],          // ← 现在写死一句，改为 agent 产出（§3.6 要求）
  guide:        { enabled: boolean, objectives: string[] },              // ← enabled 由 agent 决定，不再强制 true
  annotations:  { enabled: boolean, focuses: string[], exclusions: string[] },
  afterReading: { enabled: boolean, objectives: string[] },
  // trialCandidates 从这里移除或保留为"候选池提示"；最终片段以 select_trial_fragments 为准（§3.5）
}
```

- 更新 `agent-kit` 的 `ReadingStrategySchema` 及 `finish_interview` / `save_strategy_draft` 的入参，让模型直接产出上述结构（含 `expression_principles`、各段 `enabled`）。System prompt 相应说明。
- 删除 `user-books.ts:152-175` `mapStrategy` 的编造逻辑；若仍需 snake→camel 转换，做**无损**字段映射即可。
- 验证：`worker/src/tailoring/job.ts` 传给 `buildTailoringPrompt` 的 `strategy.value` 必须是这份忠实结构（`prompt.ts` 里 `strategy: input.strategy` 原样嵌入，无需改）。`enabled:false` 的段落生成器要跳过（`tailoring/validation.ts` / `prompt.ts` 按 enabled 决定是否产 guide/annotations/afterReading）。

### 3.5 `select_trial_fragments`：Agent 定片段范围（修 §10.2）

现状：Agent 只给 3 个候选**节点**，范围由 `rangeForNode` 机械取前 6 块 → 命中不了"最难/最能体现价值"的中段内容。

目标（`PRD §10.2` + `agent_design §6.5`）：Agent 读节点内容后，选**恰好 3 个不重叠片段**，每个给出 `section_id + segment + 连续 block range`，覆盖"进入门槛 / 典型内容 / 较高难度"，且每个片段够独立阅读。

```ts
// select_trial_fragments 入参
Type.Object({
  fragments: Type.Array(Type.Object({
    section_id: Type.String(),
    segment:    Type.Integer(),
    tag:        Type.Union([Type.Literal('threshold'), Type.Literal('typical'), Type.Literal('hardest')]),
    range:      TextRangeSchema,          // { start:{block_index,offset}, end:{block_index,offset} }
    reason:     Type.String(),
  }), { minItems: 3, maxItems: 3 }),
})
```

- 触发时机：**approve（首次确认）后**跑一轮 agent（带 `read_book_node` 等只读工具）来选片段。这也正好对上原型试读屏的"挑点动画"（门槛/典型/最难逐个揭示）。
- 校验（保留现有宿主校验并扩展，`user-books.ts:591-603`）：3 个节点 `tailoring_eligible=true`、在 `book_profile` 候选池内、互不重叠、range 落在各自节点内、非 TOC/版权/纯图。
- **删除 `rangeForNode`**（`user-books.ts:188-197`），`createTrialRevision` 改用 agent 给的 range 建 `trial_segments`。
- `TrialCandidateSchema`（`contracts:292-296`）与相关类型随之扩展带 range/tag。

### 3.6 本节要删除/替换的清单

- 删 `runStrategyRevisionAgent`（`agent-kit:684`）→ 合入 `runReadingSetupAgent` 的修订 phase。
- 删 `mapStrategy` 编造（`user-books.ts:152-175`）→ 无损映射或直接存。
- 删 `rangeForNode`（`user-books.ts:188-197`）→ `select_trial_fragments`。
- 收敛 `reading-setup-engine.ts` 的 `next/revise` → 单 `runTurn`。
- `mapQuestion`（`user-books.ts:119`）/`mapBookReaderProfile`（:135）随契约扩展做无损化。

---

## 4. 流式访谈端点（SSE）

SDK 已确认支持 token 级增量：高层 `Agent` 的 `message_update` 事件带 `assistantMessageEvent`，底层类型含 `text_delta` / `thinking_delta` / `toolcall_delta`（`@earendil-works/pi-agent-core` `dist/proxy.d.ts:18-44`、`dist/types.d.ts` 的 `message_update`）。**无需换 SDK。**

### 4.1 端点形态

`POST /v1/user-books/:id/interview/answers` 改为 `Content-Type: text/event-stream`（Fastify 原生可写 SSE）。同一请求内：

1. 事务提交这条回答（与现状一致，先落库，保证幂等恢复）。
2. 跑统一 agent 这一轮，`agent.subscribe((e)=>…)` 监听 `message_update`。
3. 累积 `toolcall_delta.delta`（`present_interview_question` 的入参 JSON 片段）到 buffer；用**容错 partial-JSON 解析**（如 `best-effort-json-parser` / 自写）解出当前部分对象，与上次 diff，推干净语义事件。
4. 工具落地（`tool_execution_start` / `turn_end`）→ 把结构化问题**持久化**到 `interview_messages` → 推 `question_final`。

### 4.2 事件协议（服务端 → 前端）

```
event: ack_delta       data: {"chars":"好，记下"}          # acknowledgment 增量
event: prompt_delta    data: {"chars":"你更希望从哪一"}     # 问题正文增量
event: option_added    data: {"id":"opt_a","label":"建立整体地图"}   # 冒出一个完整选项推一个
event: sufficiency     data: {"value":72}                  # Agent 自评，出现即推
event: question_final  data: {"questionId":"…","options":[…],"allowText":true,"sufficiency":72}
# 或者这一轮 agent 改调 finish_interview：
event: concluding      data: {}                            # 前端切"正在生成读前简报"态
event: done            data: {"workflowStatus":"strategy_review"}   # 完成后前端导航去简报屏
```

- `thinking_delta` 可用来驱动首个 delta 到达前的 typing 点（可选）。
- 若检测到工具是 `finish_interview` 而非 `present_interview_question`：简报/策略**不需要**逐字流（下一屏才显示），推 `concluding` 即可；完成态复用已验证的可恢复提交。

### 4.3 前端映射（质感）

`apps/web/src/user-books/InterviewPage.tsx` 重写为消费 SSE：

- `ack_delta` → 致谢句逐字浮现（累加渲染，非 CSS 动画）。
- `prompt_delta` → 问题标题逐字浮现。
- `option_added` → 选项一个一个 stagger 弹入。
- `sufficiency` → 信息充足度条走到该值（用 `<ProgressBar>` / 设计系统）。
- `question_final` → 用权威结构化问题（含真实 option id）对齐/收尾，作为提交答案的依据。

### 4.4 健壮性（流式只是增强层）

- **真源头是数据库**：问题一旦被工具产出即落库。流断/超时/刷新 → 前端退回 `GET /v1/user-books/:id/interview` 一次性取当前问题，降级但不丢状态。
- **可恢复**：这一轮 agent 若崩在提交前，下次进入 `/workflow` / `/interview` 重跑一轮拿问题即可（现有幂等恢复，`user-books.ts:372-382` 的 session-status 守卫保证不重复）。
- `GET /interview`、`GET /workflow` 保留为非流式 JSON，作为流式的回退与轮询面。

---

## 5. 前端去 fabricate + 契约说真话 + 清死代码

`apps/web/src/user-books/api.ts` 现在在编造后端没返回的数据；后端契约扩展后，删掉这层：

- 删 `mapStrategy` 里 `split(/\n{2,}/)` 拆段、硬编码标题、`adjustmentLimit:5`、`revisedFromTrial=version>1` 等推断；改用后端字段。
- 删 `mapTrial.draftVersion:0` 占位；`mapShelfItem` 的 `language:'und'`、`estimatedRemainingSeconds:null` 等（进度/剩余时间属非核心，可留 TODO 但别假装有值）。
- 删死代码：`retryInterview` / `retryStrategy` 只是 `get` 的别名（不真重试）；`StrategyPage` 里永不触发的 `generating`/`failed` 分支与其 `refetchInterval`；`InterviewPage` 的 hint 渲染。
- 后端 `reader` 端点补 contract：`app.ts:434` 现在是 `Type.Unknown()`，为 `ReaderBootstrap`（`user-books.ts:86`）定义正式 schema。

---

## 6. 相邻核心链路修复（非 agent，但属"按文档正确 + 工程正确"）

这些不在 B 主体里，但属于"核心链路是否正确实现"。按 §8 排期。

### 6.1 §2.4 block 枚举统一（静默红线，建议最先做）

**问题**：前端 `apps/web/src/reader/content.ts`（`annotationBlocks` :209-227、`boundaryAt` :234-266）与后端 `packages/tailoring/src/source.ts`（`extractBlocks` :58-107）是**两套独立实现**，且不一致。典型触发：`normalized_book_spec §4.5` 规定 `<hr>` → 空 `<div data-role="separator">`；后端不算作 block，前端**算**（`content.ts:223-226` 无文本/媒体守卫）→ 正式注释锚点静默错位一格甚至消失（`content.ts:281` 位置回退 + `:287` 找不到边界 `continue`）。这踩了 `implementation_baseline §5` 明令"暂缓也不许破"的**位置稳定性**。

**修**：把 block 枚举 + 标准文本投影（UTF-16、`<br>`→`\n`、内联标签只取 innerText、不做 unicode 规范化/trim/whitespace 合并，`reading_contract §2.4/§2.5`）抽成**一份版本化共享实现**，前端 DOM 侧与后端 cheerio 侧都用它；或后端在渲染用 HTML 上带 `data-block-index`/`data-source-offset` 供前端直接定位。附带统一 `mediaNames`（`source.ts:8` 有 `math`、`content.ts:5` 无）。加前后端一致性测试（含 separator/嵌套列表尾随文本用例）。

### 6.2 §11.3 正式阅读懒加载窗口（最大功能缺口）

**问题**：唯一建 formal `node_generations` 的地方是 `adoptTrial` 的 `.slice(0,4)`（`user-books.ts:1095`）；`enqueuePendingFormalGenerations`（:754）只重入队已有行、不新建。全书永远只增强前 4 个可裁读节点，往后翻只剩纯原文，且无任何补生成机制。

**修**（`PRD §11.3`）：

- 采用时建的 first node + next 3（≈4 个）是**初始窗口**，合规；缺的是**持续窗口**。
- 新增"按阅读位置驱动生成"：读者当前节点 + 后续 3 个 `tailoring_eligible` 节点（计算"后续三个"时**跳过**不可裁读节点，但其原文照常展示）始终处于 ready/generating/queued。
- 跳转到任意节点 → 立即显示纯原文 + **提高目标节点及其后 3 个的优先级**（BullMQ job priority，`tech_arch_v2 §8.6` 的优先级序）。
- 需要一个 reader 侧上报当前位置 / 目标位置的端点（或在 `GET /reader` 带上 focus node），由宿主按需**创建**缺失的 formal `node_generations` 并入队。注意保持采用/reader 的幂等与"不改变当前滚动位置"（`PRD §11.3`）。

### 6.3 §10.5 试读发布竞态 + API 不泄露部分结果

- **发布丢更新竞态**（`worker/src/tailoring/job.ts:287-298`）：三个片段 job 并发完成时，"三个都 ready 才发布"用的是无锁 `SELECT`，最后两个可能互相看不到对方 ready → 谁都不发布 → revision 永卡 `trial_generating`，无 reconciler、`retryTrial` 只肯碰 `failed`（:983）→ 用户无法自救。默认 `WORKER_CONCURRENCY=1` 掩盖，>1 或多 worker 必现。**修**：发布前对 `trial_revisions` 行 `SELECT … FOR UPDATE`（或对 segment 集）再做 all-ready 判定；或加一个把长期卡 `generating` 的 revision 判失败的维护任务。
- **API 泄露部分结果**：`trialState` 无条件把每个片段 `result` 返回（`user-books.ts:736`），`workflow()` 在 `trial_generating` 期也返回 trial 块 → 违反 §10.5"不允许展示部分成功结果"的服务端保证（`canAdopt` 门是对的，但服务端应在 `revision.status!=='published'` 时不吐 `result`）。**修**：未发布时服务端不返回逐片段 `result`。

### 6.4 §10.7 试读反馈跨事务原子性

`submitTrialFeedback`（`user-books.ts:1043`）把 supersede 整轮+退回 strategy_review 放一个事务，`+1` 和新草稿在委托的 `submitStrategyFeedback` 的**另一个**事务，中间还夹 `setupEngine.revise` 的 LLM 调用。中途崩：试读已作废、书停 strategy_review、count 没加、新草稿没生成，再发同一反馈 409（`trialState` 因 `currentTrialRevisionId` 为 null 抛 `当前试读不存在` :703）→ 半卡死。**修**：让"作废整轮 + 退回 + 计数 + 新草稿"落在一个可恢复的单元里（重构 revise 为先算后一次性提交，或引入幂等重放让二次调用能补齐）。

### 6.5 其它工程补漏

- `approveStrategy` / `adoptTrial` 收了 `idempotencyKey` 但**没用**（`contracts:359,479` 定义了，handler 从不读）→ 要么用它做去重，要么从契约删掉，别留死参数。
- 策略/试读反馈幂等靠 `feedbackAlreadyApplied` 对 `interview_messages.payload` 做 jsonb 全扫（`user-books.ts:546-558`）且在事务外 → 用真唯一约束或索引化的幂等键替代。
- 若干 `workflowStatus` 写入 WHERE 只 `eq(id)` 无状态守卫（`createTrialRevision` :669、`saveSetupOutcome` :436、`ensureInterview` :460、入队失败 :690）——当前靠上游乐观锁串行化，属防御纵深缺口，补各自的状态守卫。

---

## 7. 文件改动地图

| 文件 | 改动 |
|---|---|
| `packages/agent-kit/src/index.ts` | 合并两 agent 为一；`ReadingStrategySchema` 扩宽（§3.4）；`present_interview_question` 加 ack/sufficiency（§3.3）；新增 `select_trial_fragments`（§3.5）；新增会话历史重建；system prompt 更新 |
| `apps/api/src/reading-setup-engine.ts` | `next/revise` → 单 `runTurn`；fake 引擎同步 |
| `apps/api/src/user-books.ts` | 删 `mapStrategy` 造假 / `rangeForNode`；接 `select_trial_fragments`；无损化 `mapQuestion`/`mapBookReaderProfile`；§6.3/§6.4/§6.5 事务与守卫；§6.2 懒加载窗口宿主逻辑 |
| `apps/api/src/app.ts` | `POST …/interview/answers` 改 SSE；`reader` 端点补 contract；（§6.2）位置驱动生成端点 |
| `packages/contracts/src/index.ts` | `InterviewQuestion`+ack/sufficiency；`Strategy` 扩宽；`TrialCandidate`+range/tag；`ReaderBootstrap` schema |
| `apps/worker/src/tailoring/job.ts` | §6.3 发布 `FOR UPDATE`；按 `enabled` 跳过段落生成；`TailoringGenerationInput` 传忠实策略 |
| `packages/tailoring/src/source.ts` + `apps/web/src/reader/content.ts` | §6.1 统一 block 枚举为共享实现 |
| `apps/web/src/user-books/InterviewPage.tsx` | 消费 SSE，逐字/逐选项质感（§4.3）|
| `apps/web/src/user-books/api.ts` | 删 fabricate 层与死代码（§5）|
| `apps/web/src/user-books/StrategyPage.tsx` / `TrialPage.tsx` | 对齐扩宽后的契约；删死分支 |
| `packages/database/schema.ts` | 如需：幂等键唯一索引（§6.5）；trial 卡死维护标记（§6.3）|

---

## 8. 建议实施顺序

分期落，每期可独立验收、可回滚。

1. **P1 · §6.1 block 枚举统一**——静默、踩位置稳定性红线、爆炸半径小，先修最安全。
2. **P2 · B 主体（§3）**——合并 agent + 连续会话 + 结构化策略扩宽（修 §3.6）+ `select_trial_fragments`（修 §10.2）+ 去前端 fabricate（§5）。核心链路"按文档正确"的主体。
3. **P3 · §4 SSE 流式访谈**——在 P2 的统一 agent 上加流式层与前端质感。
4. **P4 · §6.2 懒加载窗口**——补最大功能缺口，让增强覆盖全书。
5. **P5 · §6.3/§6.4/§6.5 工程加固**——发布竞态、反馈原子性、幂等/守卫补漏。

> 顺序可调：若优先要"能读到全书增强"的产品价值，P4 可提前到 P2 之后；但 P1 建议始终最先。

---

## 9. 验收标准（对着 doc 条款）

- **P1**：构造含场景分隔（`<hr>`→separator）与"嵌套列表+尾随文本"的节点，后端锚定的 formal 注释在前端**精确命中、无错位、无丢失**；前后端 block 枚举一致性测试通过（`reading_contract §2.4/§2.5`）。
- **P2**：只有一个 `agent_type`；修订轮次的 prompt/上下文包含访谈历史与历次草稿；`strategy_draft_versions.strategy` 含 agent 产出的 `expressionPrinciples` 且各段 `enabled` 非恒真；`buildTailoringPrompt` 收到的是这份忠实策略；试读片段 range 由 agent 给出、可命中中段内容、3 个不重叠且各自 eligible（`§3.6/§6.5/§10.2`）；前端不再有 fabricate 常量。
- **P3**：一次答题后，前端依次出现 acknowledgment 逐字、问题逐字、选项逐个、充足度条到 agent 自评值；流断后 `GET /interview` 能恢复当前问题；崩溃后重进能自愈（`§8.4/§10.1`）。
- **P4**：读到第 5+ 个可裁读节点时其增强已 ready 或在生成；跳转任意节点立即显示原文并提升该节点及后 3 个优先级；附加层就绪不改变滚动位置（`§11.3`）。
- **P5**：`WORKER_CONCURRENCY>1` 下并发完成三个片段，revision 必定发布、不卡死；未发布时 API 不返回逐片段 `result`；试读反馈中途失败可恢复、不半卡死、不重复计数（`§10.5/§10.7`）。

---

## 10. 开放问题（需要确认，不阻塞开工）

1. **`request_trial_generation` / `publish_trial_revision` 的归属**：本方案让 agent 只负责 `select_trial_fragments`，实际生成/发布仍由确定性宿主+worker 拥有（审计证明这套工程正确）。若坚持 `agent_design §6.5` 把这两个也做成 agent 工具，需重新评估——但不建议，会把已经正确的确定性逻辑重新塞进 agent。
2. **`sufficiency` 非单调**：允许回落（诚实）还是 UI 端做钳制不回退（观感稳）？建议允许回落。
3. **SSE 基础设施**：确认部署链路（反代/超时）对 `text/event-stream` 与分钟级长连接的支持；否则 P3 需降级为"整轮 typing + 落地一次性渲染"。
4. **选片段时机**：本方案定在 approve 后跑一轮 agent 选片段（对上原型挑点动画）。若想省一次 agent 调用，可让 `finish_interview` 时就带 range——但那时 agent 尚未针对确认后的策略读节点，质量更差，不建议。
