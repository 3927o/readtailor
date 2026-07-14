# 阶段 6：问 AI 与策略调整完整落地方案

> 本文件是阶段 6 后续实现的执行基线。当前代码已经完成只读问答闭环；本文从现状继续，不重写已稳定的 agent/toolbox、SSE、消息持久化和全书检索。

> 实施状态（2026-07-15）：本方案已落地。契约、迁移、真实模型接线、上下文 range、proposal revision/命令、当前节点重生成、多版本读取、worker 门禁和前端闭环均已实现。

## 0. 本轮开始前状态与目标

本轮开始前已落地：

- `runAskAiAgent`、8 个工具、问答历史重建和流式回答。
- `qa_sessions`、`qa_messages`、`strategy_change_proposals` 三张业务表；实际迁移为 `0023`，不重命名历史 migration。
- `POST /v1/user-books/:id/qa`、`GET /v1/user-books/:id/qa/:sessionId`。
- 阅读器问 AI 面板、提问、追问、长期画像更新提示和只读 proposal 卡。
- proposal 只保存为 `pending`，不会创建正式策略或触发节点重生成。

本轮目标：

1. 把提问上下文升级为可恢复的划线 range 或当前屏幕 block range。
2. 删除问 AI 的生产 fake engine，模型配置缺失时明确失败。
3. 完成 proposal 的反馈、修订、拒绝、确认和幂等恢复。
4. 确认后创建新正式策略；当前节点和未读节点使用新策略，其他已读节点保留原策略。
5. 阅读器按节点选择唯一策略版本，任何问答、确认或生成失败都不影响原文阅读。

## 1. 已锁定决策

1. **当前屏幕允许可控近似**：只截取“当前阅读节点”中与阅读容器可视区域相交的连续 block range；屏幕同时跨多个节点时不拼接跨节点 range。采集失败回退当前节点原文。
2. **上下文在打开入口时冻结**：工具栏打开问 AI 时立即采集屏幕 range；划线工具栏打开时立即采集 selection range。不能等用户输入后再读 live selection，避免面板打开导致 selection 丢失。
3. **服务端重建原文**：前端提交 range 和 quote snapshot，API 用规范化 HTML 与统一 block 算法校验并重建文本；snapshot 只作为显示和漂移回退，不作为原书事实来源。
4. **不提供生产 fake**：保留 `AskAiEngine` 依赖注入接口供单测使用 stub；删除 `createFakeAskAiEngine` 及运行时 fake fallback。`QA_AI_MODEL_*` 仍可回退全局 `MODEL_*`，两者都缺失时 API 启动失败并给出明确配置错误。
5. **proposal 不直接生效**：Agent 只能提交完整候选策略和说明。回答、proposal revision、候选策略草稿及画像 patch 在回答成功后统一提交；模型调用失败不留下业务副作用。
6. **当前节点采用新策略**：确认时，以服务端最新 `reader_states` 为准确定当前节点；当前节点即使已读也切换到新策略并重新生成。其他已读节点继续使用它们被标记已读时的策略版本。
7. **未读节点懒生成**：确认后立即创建并提权“当前节点 + 后续 3 个可裁读节点”的新策略任务；其余未读节点在进入正式生成窗口时按新策略创建。这里的“安排未读节点”指确定新策略归属，不一次性排队整本书。
8. **不复用试读确认流程**：正式阅读调整不生成节点预览，也不计入读前 `adjustment_count`。候选 `strategy_draft_version` 只承担版本来源和审计，不进入 trial revision。
9. **原文始终可读**：新增强处于 queued/generating/failed 时展示原文及状态，不回退展示已失效策略的增强内容。

## 2. 提问上下文与返回原文

### 2.1 契约

`QaQuestionContext` 调整为判别联合：

```ts
type QaQuestionContext =
  | {
      anchor: 'highlight';
      precision: 'exact';
      nodeOrder: number;
      sectionId: string;
      segment: number;
      range: TextRange;
      quoteSnapshot: string;
      manifestVersion?: string;
    }
  | {
      anchor: 'screen';
      precision: 'approximate';
      nodeOrder: number;
      sectionId: string;
      segment: number;
      focus: TextPosition;
      range?: TextRange;
      quoteSnapshot: string;
      manifestVersion?: string;
    };
```

- `highlight`：`range` 是用户实际 selection，`quoteSnapshot` 是选中文字。
- `screen`：`focus` 是阅读位置锚线落点；`range` 是该节点中屏幕顶部和底部探针得到的近似可见范围。探针失效时允许只提交 focus。
- 历史会话永久保存首次提问的 context；追问不改变锚点。
- 兼容已有 session：缺少 `range` 的旧 JSON 按 `sectionId + segment` 回退整节点读取，响应中标记 `contextPrecision: 'node'`。

### 2.2 Web 采集

复用阅读器已有的 `readingBlocks`、selection range、DOM anchor probe 和统一 UTF-16 offset 算法：

1. 工具栏“问 AI”复用位置持久化所用的 `nearestReaderAnchor`，以阅读锚线落点决定 node 和 focus；不能继续使用参考线不同的 `currentOrderRef`。
2. 在 focus 所在的同一个 `.reader-original` 内对可读 viewport 顶部和底部执行 anchor probe，形成近似 range；屏幕跨节点时不拼接另一个节点。
3. 只枚举 `.reader-original` 中的 `readingBlocks`，排除导读、裁读注、节后助读、标题及面板内容。
4. selection 工具栏新增“问 AI”命令，直接复用现有划线 selection → `TextRange` 转换；节点身份从 selection 所在 `.reader-original` 获取，不能和 `currentOrderRef` 拼接。
5. 采集完成后再打开面板，面板在整个 session 内持有冻结 context。

屏幕采集无可见 block 时，使用当前 anchor 所在 block；仍失败则提交当前节点首个有效 block。API 最终仍保留整节点回退。

### 2.3 API 校验与 Agent 上下文

- 校验 user-book、`nodeOrder ↔ sectionId/segment`、manifest 版本、range 顺序、block 边界和 UTF-16 offset。
- 用 `extractNodeSourceFromHtml` 的 blocks 截取标准文本，不能直接信任客户端 snapshot。
- `get_question_context` 返回：锚点类型、节点标题与位置、range、range 原文、所在 block/段落原文；必要时附当前节点截断文本。
- exact range 无效时拒绝新请求；approximate range 允许把轻微越界 offset clamp 到 block 标准文本长度，并在 range 失效时按 focus 读取当前及相邻 blocks。focus 也失效才降级受限整节点。旧 session 始终允许降级并记录结构化 warning。

### 2.4 返回原文

- 问 AI 面板展示可折叠的原文上下文和“返回原文”动作。
- 动作先关闭面板，再按 `sectionId + segment + range.start` 定位；复用现有 range/恢复坐标算法。
- 划线问题返回精确 selection 起点；屏幕问题返回原屏幕 range 的首 block。
- 找不到精确 block 时按既有恢复链降级到节点，再降级到邻近 `nodeOrder`，不阻塞阅读。

## 3. 去除问 AI Fake Engine

### 3.1 生产接线

- 删除 `apps/api/src/ask-ai-engine.ts` 中的 `createFakeAskAiEngine`。
- `server.ts` 只创建 `createAgentAskAiEngine`；`requireCompleteModelEndpoint(config.askAiModel, 'ask-ai')` 返回空时直接抛出配置错误。
- 继续支持 `QA_AI_MODEL_API_BASE_URL / QA_AI_MODEL_API_KEY / QA_AI_MODEL_NAME`，缺省回退全局 `MODEL_*`。
- 不用固定回答、静默成功或 200 假数据作为降级。模型运行失败走现有 SSE `error`，用户问题保留并允许使用同一幂等键重试。

### 3.2 测试

- 单测和 API 路由测试直接注入实现 `AskAiEngine` 的 deterministic stub。
- stub 放在测试文件或测试 helper，不从生产模块导出，不参与 server runtime 分支。
- agent-kit 用 stub toolbox 测真实 `runAskAiAgent` 的工具循环、proposal 和 staged profile patch。

## 4. Proposal 与画像的数据模型

### 4.1 Proposal 主体与 revision

`strategy_change_proposals` 保留为逻辑建议主体，新增：

- `revision`：当前 revision 号，从 1 开始。
- `current_revision_id`：当前可确认 revision。
- `current_strategy_draft_version_id`：当前候选策略草稿。
- `base_strategy_version_id`：创建或最近一次修订时所基于的正式策略；确认时必须仍等于 user-book 当前正式策略。
- `origin_section_id + origin_segment`：创建建议时的位置快照。
- `resulting_strategy_version_id` 保持 nullable，但增加唯一索引，确保一个正式策略版本只由一次确认产生。

新增 `strategy_change_proposal_revisions`：

```text
id
proposal_id
revision
triggering_message_id
strategy_draft_version_id
public_summary
changed_fields jsonb
reason
evidence
created_at
unique(proposal_id, revision)
```

规则：

- 第一次 `propose_strategy_change` 创建 proposal、revision 1 和候选策略草稿。
- 用户反馈后，Agent 再次调用工具时仍修订同一个 proposal：旧候选草稿置 `superseded`，创建下一版草稿和 revision，更新 proposal 当前指针。
- 修订前若该书正式策略已经变化，旧 proposal 置 `superseded`，Agent 必须基于新正式策略另建建议，不能把旧差异覆盖到新版本上。
- 每个 revision 绑定触发它的 assistant answer，因此历史卡片能稳定显示在对应回复后；只有当前 pending revision 显示操作按钮。
- 同一 user-book 仍只允许一个 `pending` proposal。新的独立建议会把旧 pending proposal 置 `superseded`。
- 现有 proposal 行迁移为 revision 1；历史 migration 文件不改名、不重写。

新增轻量 `strategy_change_proposal_actions` 记录 feedback/confirm/reject 命令及 `idempotency_key`，并建立 `unique(proposal_id, idempotency_key)`。重复请求读取已保存 action 结果；同一 key 携带不同动作或 payload 时返回冲突。

### 4.2 候选策略草稿

每个 revision 创建一个 `strategy_draft_versions`：

- `bookReaderProfileVersionId` 使用当时本书画像版本。
- `readingBriefing` 复制当前正式策略来源草稿；正式阅读调整不重写读前简报。
- `strategy` 使用 Agent 提交的 `ProposedStrategy` core，并沿用当前正式策略的 `trialCandidates` 以满足现有持久化 schema；这些候选不会进入试读。
- 增加可选 `sourceQaMessageId` 或等价来源字段，不能把 QA message 塞进只指向 interview message 的 `sourceMessageId`。

确认时提升当前候选草稿，避免把 `strategy_versions.sourceDraftVersionId` 改成多态来源。

### 4.3 长期画像来源

`update_reader_profile` 改为 staged tool：工具只在本轮 outcome 中累计 patch、reason 和 evidence，不立即写数据库。

回答成功保存时，在同一事务内：

- union-dedup 合并 patch 并创建新的 `reader_profile_versions`。
- 保存 `sourceQaSessionId`、`sourceQaMessageId` 和 `changeReason`；字段允许 null 以兼容历史版本。
- 更新 `reader_profiles.currentVersionId`。

回答生成或保存失败时，不更新画像、不创建 proposal revision 或候选草稿。

## 5. API 与事务边界

### 5.1 问答流

保留 `POST /v1/user-books/:id/qa`，但调整 proposal 事件时机：

1. 问题先以 CAS + idempotency key 落库。
2. Agent 流式输出 `answer_delta`；工具调用只在内存中形成 staged outcome。
3. 回答、画像 patch、候选草稿、proposal/revision 在一个事务中保存。
4. 事务成功后发送带稳定 ID 的 `proposal`、`profile_updated` 和 `done`。
5. 不再在工具调用瞬间向前端展示尚未持久化的可确认卡，避免后续失败留下幽灵 proposal。

`proposal` 事件至少包含 `proposalId`、`revisionId`、`revision`、`triggeringMessageId`、`publicSummary` 和 `status`。

### 5.2 会话与历史

- 扩展现有 session GET，使每个 answer 返回其 proposal revision；不再只返回线程末尾的一张最新卡。
- 新增 `GET /v1/user-books/:id/qa?cursor=&limit=`，返回该书问答 session 摘要，用于关闭面板后恢复和跨设备历史。
- session 仍以“一个初始问题 + 追问”为边界，不建设一本书的无限聊天。

### 5.3 Proposal 命令

新增：

```text
POST /v1/user-books/:id/qa/proposals/:proposalId/feedback
POST /v1/user-books/:id/qa/proposals/:proposalId/confirm
POST /v1/user-books/:id/qa/proposals/:proposalId/reject
```

三个请求都带 `idempotencyKey`。反馈还带 `revisionId + feedback`，确认带 `revisionId`，防止旧卡操作当前 proposal。

- `feedback`：验证当前 pending revision，保存反馈；前端随后在原 session 发送这条反馈作为追问，Agent 必须再次调用工具才产生新 revision。
- `reject`：把当前 pending proposal 标为 `rejected`，正式策略与节点内容不变。
- `confirm`：执行 §6 的原子升级；重复确认返回同一个 resulting strategy version。

## 6. 正式策略确认与节点版本解析

### 6.1 已读节点记录策略版本

给 `reader_read_nodes` 增加 `strategy_version_id`：

- 新标记已读时写入当时 `user_books.current_strategy_version_id`。
- 历史数据用迁移时该书当前正式策略回填，再设为 `NOT NULL`。
- 聚焦一个以前已读的节点时，该节点成为“当前节点”，更新它的策略归属为当前正式策略并触发所需生成；离开后它按新策略继续被视为已读节点。

### 6.2 确认事务

在单个数据库事务中：

1. 锁定或条件更新 user-book 和 proposal，校验归属、`active_reading`、`pending`、当前 revision/draft 未变化，并且 `proposal.baseStrategyVersionId === userBook.currentStrategyVersionId`。
2. 读取最新 `reader_states`；缺失时回退 proposal origin，再回退 manifest 首个节点。
3. 当前候选 draft 从 `draft` 变为 `confirmed`；同书其他未采用候选 draft 保持或变为 `superseded`。
4. 以 `max(strategy_versions.version) + 1` 创建正式策略版本。
5. 更新 `user_books.currentStrategyVersionId` 和 `currentStrategyDraftVersionId`。
6. 如果当前节点已在 `reader_read_nodes`，把该行的 `strategyVersionId` 更新为新策略；其他已读节点不变。
7. 把“当前节点 + 未读节点”中旧策略的 queued/retrying/generating 任务置 `superseded`，但不处理其他已读节点的旧任务。
8. 为当前节点及新窗口创建幂等的 formal `node_generations` queued 行。
9. proposal 标为 `confirmed`，写入 `confirmedAt` 和 `resultingStrategyVersionId`。

并发确认依赖 pending 状态、current revision 和 user-book 当前策略指针的条件更新；只有一个事务能创建下一版本。唯一索引负责最后防线，冲突请求读取胜者结果后按幂等成功返回。

### 6.3 事务后入队与恢复

- BullMQ 入队在事务提交后执行，当前节点优先级最高，后续窗口依次降低。
- 入队失败不回滚已确认策略；queued 行由 `reader()`、`reportReaderFocus()` 和现有 pending enqueue 恢复。
- `enqueuePendingFormalGenerations` 必须按节点期望策略过滤，不能继续唤醒已经失效的旧策略未读任务。
- worker 在 formal job 开始和最终写回前检查 generation 状态与节点期望策略；不符合当前节点 pin 的任务置 `superseded` 并直接退出，最终 ready/failed CAS 不能把它改回终态。formal 唯一索引只覆盖非 `superseded` 行，因此节点以后重新切到该策略时可以创建新 generation，同时保留旧行的审计记录。

### 6.4 Bootstrap 唯一版本选择

`buildReaderBootstrap` 不再返回某书全部 formal generations。先计算每个节点的期望策略：

```text
当前节点                         -> user_book.current_strategy_version_id
已读且不是当前节点               -> reader_read_nodes.strategy_version_id
未读节点                         -> user_book.current_strategy_version_id
```

随后只返回 `(sectionId, segment, expectedStrategyVersionId)` 对应的唯一 generation：

- 新版本 ready：返回新增强。
- 新版本 queued/generating/retrying：返回对应状态和原文。
- 新版本 failed：返回失败状态和原文。
- 没有任务：不返回 enhancement；进入生成窗口时补建。
- 旧版本结果完整保留用于历史和已读节点，但不能与新版本同节点一起进入 `enhancements[]`。

bootstrap 顶层增加 `strategyVersionId + strategyVersion`，每条 enhancement 增加 `strategyVersionId`。前端合并轮询、focus 和 confirm 响应时拒绝策略版本倒退，防止迟到的旧 bootstrap 覆盖刚确认的新版本。

确认响应后前端立即 invalidate reader bootstrap；当前节点新增强迟到时，复用现有 layout-anchor 补偿保持正在阅读的段落位置稳定。

## 7. 前端完整交互

问 AI 面板需要完成：

- 工具栏当前屏幕入口、selection 工具栏划线入口。
- 可折叠原文上下文、返回原文动作。
- session 列表、恢复历史 session、追问和失败重试。
- proposal revision 紧跟触发回答展示，不在线程末尾漂移。
- 当前 revision 提供“确认调整”“反馈”“取消建议”；旧 revision 只显示历史状态。
- 反馈点击后聚焦原会话输入框；提交时先记录 feedback，再以同一文本发起追问。
- 确认中、确认成功、已失效、生成排队和失败状态；成功后提示“处理方式已更新，当前及后续内容将按新方式生成”。
- 确认成功后刷新 reader bootstrap，但不关闭问答历史；用户可立即返回原文。

## 8. 实施顺序

1. **契约与 migration**：range context、proposal revision、候选 draft 指针、画像来源、read-node strategy pin、命令请求/响应。
2. **当前屏幕与返回原文**：前端冻结 context，API 重建原文，兼容旧 node-only session。
3. **副作用暂存**：画像和 proposal 从 tool-time 写入改为 answer commit-time 统一事务。
4. **移除 fake**：生产模型配置必需，测试改用注入 stub。
5. **proposal 生命周期**：反馈、修订、拒绝、消息绑定、历史读取。
6. **确认与多版本读取**：原子创建正式策略、当前节点切换、read-node pin、bootstrap 去重和懒生成恢复。
7. **前端闭环**：历史、卡片操作、状态刷新、错误与重试。
8. **文档同步**：更新 PRD、reading contract、agent design、technical architecture v2 和 implementation baseline 中“当前节点保留”的旧结论。

每一步独立提交；migration 与依赖它的代码放在同一个 requirement commit，避免出现代码先读不存在字段的中间状态。

## 9. 验证

### 9.1 自动检查

- contracts/schema 单测：新旧 question context、proposal revision、命令契约。
- Web 单测：可见 block range、selection range、跨节点屏幕近似、返回原文降级。
- agent-kit 单测：无终止工具、staged profile/proposal、多次工具调用只提交最终合法 outcome。
- API 单测：问题幂等、失败无副作用、proposal 与 answer 原子保存、revision 绑定、反馈/拒绝/确认幂等与并发冲突。
- 数据库测试：candidate draft 提升、策略 version 递增、read-node pin、每节点唯一 generation 解析。
- Worker/API 集成测试：确认后当前节点优先入队、后续窗口按新策略、旧任务完成后不被读取、入队失败可恢复。
- 生产构建和 typecheck；测试不得依赖真实模型或生产 fake。

### 9.2 项目所有者手工验收

实现完成后由项目所有者验证以下流程：

1. 当前屏幕提问、划线提问、追问、关闭后恢复 session、返回原文。
2. AI 提出调整后，卡片位于对应回答下；反馈后同一 proposal 出现新 revision。
3. 拒绝、模型失败、保存失败和旧卡确认均不改变正式策略。
4. 确认后当前节点进入重新生成，其他已读节点仍显示原增强，未读节点按新策略生成。
5. 当前节点新增强迟到时阅读位置不跳；生成失败时原文始终可读。

## 10. 完成条件

- 生产运行路径不存在问 AI fake engine 或静默假回答。
- 划线和当前屏幕问题都保存可恢复 range，并能返回原文。
- proposal 必须经过用户确认才能创建新正式策略；反馈修订、拒绝和重复提交行为确定。
- 当前节点与未读节点使用新策略，其他已读节点保留其记录的策略版本；bootstrap 每节点最多返回一个 generation。
- 问答、画像更新、proposal、确认和异步生成任一环节失败时，当前正式策略指针保持事务一致，原文阅读不受影响。
