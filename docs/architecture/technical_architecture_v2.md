# 裁读 ReadTailor 技术方案 v2

**版本**：v2  
**日期**：2026-07-13  
**状态**：当前实现方案，已于 2026-07-13 按
[`implementation_baseline.md`](../project/implementation_baseline.md) 冻结

关联文档：

- [`product_prd.md`](../product/product_prd.md)：产品流程和验收标准
- [`agent_design.md`](agent_design.md)：Agent 分工和工具设计
- [`reading_contract.md`](../contracts/reading_contract.md)：阅读节点、block 和锚点契约
- [`normalized_book_spec.md`](../contracts/normalized_book_spec.md)：规范化书籍契约

本文面向产品的第一个可用版本。目标是在不破坏核心产品体验的前提下，尽快完成完整流程，
而不是提前建设成熟平台所需的全部可靠性、扩展性和治理能力。

旧版技术方案保留作为未来线上化和系统加固的参考，不作为当前开发的强制要求。

---

## 1. 当前目标

实现一个可以真实使用的网页产品：

1. 用户登录并建立长期阅读画像。
2. 用户上传无 DRM EPUB。
3. 系统通过 Agent 将 EPUB 规范化为统一书籍包。
4. 用户完成单本书访谈，并通过 `approveDraftForTrial` 批准草稿生成试读。
5. 系统生成三个试读片段。
6. 用户通过 `confirmStrategyAndStartReading` 正式采用后进入连续滚动阅读器。
7. 阅读器支持导读、裁读注、节后助读、划线、笔记和问 AI。
8. 用户可以在问 AI 中提出处理方式调整并查看效果。

当前优先级依次是：

1. 产品主流程完整。
2. 原文和阅读位置正确。
3. AI 失败时产品仍可继续使用。
4. 开发和调试简单。
5. 在真实使用后再补充复杂的线上保障。

---

## 2. 当前不做的架构建设

以下能力暂不进入当前实现：

- 覆盖所有异步对象的通用输入版本门禁和发布框架
- transactional outbox 和数据库/队列严格一致性协议
- 通用 workflow lease、跨领域 fencing token 和分布式锁平台
- 覆盖所有资源的通用多标签页、多实例并发协议
- 完整的业务事件、AI 调用和 Agent 工具审计平台
- 多地域、跨可用区和灾难恢复架构
- 跨境合规、大陆网络可达性和国内外双部署设计

这些事项只在真实问题出现、准备公开发布或用户规模增长时重新评估。

阅读准备长命令和访谈 active turn 已实现窄域数据库 lease：它们分别使用 operation/turn attempt、
过期时间和最终事务条件更新防止重复提交。该实现只服务当前流程，不扩展为通用工作流平台。

---

## 3. 保留的设计底线

轻量化不等于取消所有约束。以下几项如果做错，后续会直接破坏产品数据，因此仍然保留：

- PostgreSQL 保存用户、书籍、流程状态和当前结果。
- 规范化书籍包按源 EPUB SHA-256 和契约版本不可变。
- 规范化原文不可被个性化流程修改。
- AI 内容与原文分开保存和展示。
- 阅读节点、block 和 UTF-16 range 遵守 `reading_contract.md`。
- 规范化结果必须通过现有确定性校验后才能阅读。
- 用户未完成两次确认前不能进入正式阅读。
- AI 内容生成失败时仍然显示纯原文。
- Agent 不直接获得数据库连接、模型密钥或宿主机任意 shell。
- Pi Agent SDK 直接嵌入 API 或 Worker，不部署独立 Agent runtime。
- BullMQ 负责投递、并发和重试，业务流程状态仍保存在 PostgreSQL。

这里保留的是数据正确性和产品流程边界，不建设通用的平台级门禁系统。

---

## 4. 技术选型

| 领域 | 选择 |
|---|---|
| 语言 | TypeScript |
| 运行时 | Node.js LTS |
| 包管理 | pnpm workspace |
| Web | React、Vite、React Router |
| Web 数据请求 | TanStack Query |
| API | Fastify、TypeBox |
| 数据库 | PostgreSQL、Drizzle ORM |
| 后台任务 | Redis、BullMQ |
| Agent | Pi Agent SDK |
| 代码沙箱 | E2B |
| 对象存储 | `ObjectStorage` 适配器；本地使用 MinIO 或文件系统，部署使用 S3 兼容服务 |
| 实时响应 | Agent 对话使用流式 HTTP，后台进度使用 SSE |
| 日志 | Pino |
| 测试 | Vitest、Playwright、现有 Python 校验工具 |

不引入 GraphQL、微服务框架、事件流平台或工作流引擎。API 和 Worker 按模块化单体组织，通过少量
明确接口隔离对象存储、模型和代码沙箱，避免第三方 SDK 散落在业务代码中。

---

## 5. 总体架构

```text
Browser
  -> React Web
  -> Fastify API
       -> PostgreSQL
       -> Redis / BullMQ
       -> Object Storage
       -> Pi Agent / Model API

BullMQ
  -> Worker
       -> PostgreSQL
       -> Object Storage
       -> Pi Agent / Model API
       -> E2B
```

系统采用模块化单体：一个代码库、一个数据库、一个 API 应用和一个 Worker 应用。

API 和 Worker 可以使用同一个镜像，通过不同启动命令运行。当前不拆分微服务。

### 5.1 Web

Web 负责：

- 登录和长期画像
- 书架和上传
- 单本书访谈
- 处理方式确认
- 试读和反馈
- 连续滚动阅读器
- 划线、笔记和问 AI

阅读准备页面使用 `ProgressiveStrategyView` 和固定三槽 `ProgressiveTrialView`。strategy/trial query key
包含精确 draft/revision id，detail query 只保存 current pointer；迟到 GET/SSE 只能更新所属版本。
页面刷新后从 API 重新读取当前状态和 operation。前端不自行推断或推进服务端流程。

### 5.2 API

API 负责：

- 登录和用户资源归属检查
- 业务数据的查询和写入
- EPUB 上传和 SHA-256 计算
- 创建后台任务
- 运行访谈和问 AI 等交互式 Agent
- 流式返回 Agent 的用户可见文本
- 管理 reading setup operation 的 claim、续租、attempt fencing、resume 和最终事务
- 提供阅读节点、进度、划线和笔记接口

API 不执行耗时的 EPUB 规范化和节点内容生成。

### 5.3 Worker

Worker 负责：

- EPUB 规范化
- 规范化结果校验
- reading manifest 生成
- 书籍分析
- 试读内容生成
- 正式阅读节点内容生成
- 简单的过期文件清理

Worker 使用 BullMQ 自带的失败重试。任务失败后在数据库中保存错误摘要，前端允许用户重新发起。

### 5.4 PostgreSQL

PostgreSQL 保存产品当前需要恢复的业务数据。大型文件、完整书籍包和大型调试产物放在对象存储。

当前不建设通用事件库或完整审计库。关键 AI 结果只记录模型、输入对象、状态、耗时和错误摘要。

### 5.5 Redis 和 BullMQ

Redis/BullMQ 用于：

- 后台任务队列
- 并发控制
- 自动重试
- 任务优先级
- 短期进度信息

PostgreSQL 保存最终业务状态，BullMQ 保存任务运行状态。当前接受极少数情况下需要人工或用户重新
触发任务，不为队列和数据库之间的所有异常组合设计额外一致性协议。

### 5.6 对象存储

对象存储保存：

- 上传的源 EPUB
- 规范化 attempt 产物
- 发布后的规范化书籍包
- 图片和其他媒体
- 必要的校验报告和调试文件

业务代码通过一个简单的 storage 模块访问对象存储，不建设覆盖所有云厂商能力的通用 SDK。

---

## 6. 项目结构

```text
read-tailor/
  apps/
    web/
    api/
    worker/
  packages/
    contracts/
    domain/
    database/
    storage/
    queue/
    ai/
    agent-kit/
    normalized-book/
    reader-core/
    reader-react/
    observability/
    test-support/
  tools/
  docs/
```

包的边界以减少重复代码和控制依赖方向为目的：

- `contracts`：HTTP、Agent 输出和主要 JSON schema。
- `domain`：状态迁移和主要业务操作，不依赖 Fastify、BullMQ 或 Pi SDK。
- `database`：Drizzle schema、migration、repository 和 transaction helper。
- `storage`：对象存储和本地文件实现。
- `queue`：BullMQ queue、job payload 和 handler 注册。
- `ai`：模型配置、普通生成调用和 provider 错误映射。
- `agent-kit`：Pi Agent 初始化、模型配置和工具注册。
- `normalized-book`：规范化、manifest 和校验调用。
- `reader-core`：block、range 和阅读位置算法。
- `reader-react`：阅读器组件。
- `observability`：Pino logger、request/job id 和基础指标。

`contracts` 只保存跨进程 schema，不保存数据库 row 类型。`reader-core` 不依赖 React，确保 Node 和
浏览器使用同一套 block/range 逻辑。如果某段逻辑只被一个应用使用，仍然可以直接放在该应用中，
不为了形式上的分层提前抽象。

---

## 7. 核心数据

以下是逻辑表组，不在方案阶段冻结全部字段名。可变对象保留 `created_at`、`updated_at`，需要处理
用户重复提交的对象增加简单唯一约束或幂等键。

### 7.1 用户和画像

- `users`：用户主体、初始画像完成状态和停用状态。
- `auth_identities`：Google OAuth 等登录身份。
- `auth_sessions`：服务端 session、过期和撤销。
- `reader_profiles`：当前长期画像。
- `reader_profile_versions`：历史画像和变更来源。

长期画像保留当前版本和历史记录，但不建设通用版本框架。

### 7.2 共享书籍

- `source_uploads`：上传者、源对象、SHA-256、大小和上传状态。
- `shared_books`：按 EPUB SHA-256 复用的共享书籍主体。
- `book_packages`：不可变 package、契约版本、对象前缀和校验摘要。
- `normalization_runs`：一次完整规范化运行及当前步骤。
- `book_profiles`：与 package 对应的共享书籍分析。

关键约束：

- `shared_books.epub_sha256` 唯一。
- 同一 shared book 同时最多一个活动 normalization run。
- shared book 只有在 package 文件、manifest 和 book profile 都成功生成后才能进入 ready。
- package 发布后不覆盖；修复产生新的 package version。

### 7.3 用户书籍和个性化

- `user_books`：用户与共享书的关系、主流程状态、软删除和当前策略指针。
- `interview_sessions`：访谈阶段、已问数量和当前问题。
- `interview_answers`：每一题的幂等答案。
- `interview_messages`：用户可见的访谈消息。
- `book_reader_profile_versions`：本书用户画像历史版本。
- `strategy_draft_versions`：读前简报和待确认策略草稿。
- `strategy_versions`：用户最终采用的正式策略。
- `trial_revisions`：试读轮次、反馈计数和当前状态。
- `trial_segments`：三个片段的范围、生成状态和查看状态。
- `reading_setup_operations`：策略反馈、试读反馈和 `approveDraftForTrial` 的幂等键、request hash、base pointer、
  lease、attempt、终态和结果 pointer。

画像、草稿、正式策略和 trial revision 继续保留版本记录，因为产品需要回看旧结果、累计反馈和区分
当前试读；但当前实现不建立通用的跨对象版本门禁框架。

### 7.4 阅读

- `node_generations`：试读片段和正式节点的生成状态与结果。
- `reading_progress`：当前稳定位置、客户端观察时间和最近阅读时间。
- `read_nodes`：用户已读节点以及当时使用的策略。
- `highlights`：基于 manifest range 的划线。
- `notes`：与划线一一关联的笔记。
- `qa_sessions`、`qa_messages`：每个问题独立会话及追问。
- `strategy_change_proposals`：正式阅读中的待确认调整建议、修订和采用状态。

`node_generations` 的缓存/去重键至少包含用户、package、节点或片段范围、生成 scope、画像、策略、
prompt 和模型配置。首版可以在 service 中明确拼装该 key，不需要通用版本门禁系统。

`reading_progress` 至少保存：

```text
user_book_id
package_id
section_id
segment
block_index
offset
node_order
client_observed_at
updated_at
```

`highlights` 保存同一节点内的起止 block/offset、选中文本 hash 和创建时间。`notes.highlight_id` 唯一，
因此一个划线可以没有笔记或关联一条笔记，但不能创建不关联划线的独立笔记。首版不设计书签表。

### 7.5 阅读活动与统计

- `reading_sessions`：一次进入正式阅读器的会话。
- `reading_activity_slices`：经服务端接受的有效阅读时间区间，是阅读统计的原始数据。
- `reading_daily_book_stats`：按用户书籍和本地自然日聚合的统计。
- `book_reading_stats`：每本用户书籍的累计统计和个人速度缓存。
- `reading_daily_totals`：不关联具体书籍的用户每日总阅读时长。

`reading_sessions` 至少保存：

```text
id
user_id
user_book_id
client_session_id
started_at
ended_at
timezone
status
```

`reading_activity_slices` 至少保存：

```text
id
user_id
user_book_id
reading_session_id
client_session_id
sequence
started_at
ended_at
active_seconds
activity_kind
start_section_id + start_segment + start_block_index + start_offset
end_section_id + end_segment + end_block_index + end_offset
forward_character_count
local_date
created_at
```

唯一约束为：

```text
user_id + client_session_id + sequence
```

客户端重试同一个 slice 时返回原结果，不重复累计时长。

`activity_kind` 首版使用：

- `original_forward`：正常向前阅读原文。
- `original_reread`：回读原文。
- `original_jump`：目录跳转或明显不连续的位置变化。
- `assistance`：阅读导读、原书注、裁读注或节后助读。
- `stationary`：仍在正式阅读器中有效阅读，但原文位置没有推进。

所有非空闲 slice 的 `active_seconds` 都进入阅读时长统计。只有 `original_forward` 的
`active_seconds` 和 `forward_character_count` 进入该书个人阅读速度样本。回读、跳转、辅助内容和
停留时间不进入速度分子或分母。

`reading_daily_book_stats` 至少保存 `user_book_id + local_date + active_seconds +
speed_sample_seconds + forward_character_count`。`book_reading_stats` 保存累计值、当前个人阅读速度、
速度样本量和最近阅读时间。这两个表是查询缓存，可以从 activity slices 重建。

`reading_daily_totals` 只保存 `user_id + local_date + active_seconds`，用于今日、本周、累计时长和连续
阅读天数。它不保存 `user_book_id`，因此永久删除一本书后仍可保留历史全局统计，不泄露已删除书籍
的书名、位置、笔记或其他详情。

### 7.6 后台任务

- `jobs`：任务类型、目标对象、业务状态、优先级、最大重试和幂等键。
- `job_attempts`：每次执行的开始、结束、错误、worker 和 artifact 引用。
- `ai_runs`：模型、功能、token、耗时、状态和错误摘要。

不建设完整审计平台。Agent 工具调用默认写结构化日志；只有调试确实需要查询时，再增加独立
`agent_tool_calls` 表。

---

## 8. 核心状态

### 8.1 共享书籍

```text
uploaded -> fingerprinting -> queued -> normalizing -> validating
         -> indexing -> analyzing -> ready

normalizing | validating | indexing | analyzing -> failed
failed -> queued
```

这些状态直接服务上传进度、失败定位和用户重试，不增加更细的内部子状态。

### 8.2 用户书籍

```text
on_shelf -> interviewing -> strategy_review
         -> trial_generating -> trial_review -> active_reading

trial_generating -> trial_generation_failed -> trial_generating
```

删除使用 `deleted_at`，30 天内允许恢复。

策略修订和试读选段不增加 user book workflow 状态，运行态由 reading setup operation 表达：

```text
pending -> running -> completed
                   \-> failed
expired running -> running with attempt + 1
```

同一本 user book 最多一个 pending/running operation。最终提交同时校验 base draft/trial pointer、当前
workflow、lease id 和 attempt；迟到 attempt 不能覆盖新结果。

阅读准备流程的四层状态各自只有一个职责：

| 层 | 事实来源 | 职责 |
| --- | --- | --- |
| 业务阶段 | `user_books.workflow_status` | 决定用户当前阶段和路由，不表达任务执行细节 |
| 实体生命周期 | interview、draft、trial、strategy 表 | 保存版本历史、实体状态和领域不变量 |
| 长任务状态 | `reading_setup_operations` 与 interview turn lease | 处理幂等、恢复、lease、attempt 和 fencing |
| 临时展示态 | Web SSE reducer | 展示流式增量；可丢弃并从服务端 snapshot 重建，不是业务事实来源 |

### 8.3 内容生成

```text
pending -> generating -> ready
                     \-> failed
```

状态更新集中在对应 service 中，不额外建设通用状态机框架。

### 8.4 Job 与 attempt

```text
job: pending -> queued -> running -> succeeded
                              \-> retry_wait -> queued
                              \-> failed
                              \-> cancelled

attempt: running -> succeeded | failed | abandoned
```

一个 job 默认最多三个自动 attempt。Worker 进程退出、E2B 中断或模型调用中断后，下一次从数据库和
源文件重新运行，不恢复 Agent 的内存状态或 E2B 工作区。

普通 BullMQ job 当前依赖 stalled 检测和重试机制，不额外实现数据库 lease、fencing token 或完整的
崩溃接管协议。出现数据库 job 长时间停留在 running 的情况时，由简单维护任务标记失败并允许用户
重试；reading setup operation 和 interview turn 使用各自的窄域 lease，不适用本段。

### 8.5 失败分类

- `external_error`：模型、E2B、对象存储或网络错误。
- `invalid_input`：DRM、损坏 EPUB 或不支持的结构。
- `validation_failed`：规范化产物未通过确定性校验。
- `timeout`：Agent、模型或脚本超过限制。
- `cancelled`：用户删除、上游 revision 失效或主动取消。
- `internal_error`：其他程序错误。

分类用于决定是否自动重试和展示什么用户文案，不建设复杂错误继承体系。

### 8.6 任务优先级

从高到低：

1. 用户当前节点和跳转目标节点生成。
2. 试读片段。
3. 后续三个节点预生成。
4. 新书规范化和书籍分析。
5. 清理等维护任务。

不同任务类型可以使用独立 BullMQ queue 和并发限制。交互式访谈和问 AI 不进入后台队列。

### 8.7 队列执行方式

API 创建后台任务时：

1. 在 PostgreSQL 创建业务对象和 `jobs` 记录。
2. 事务提交后调用 BullMQ `add`。
3. 将 BullMQ job id 写回数据库。

Worker 收到任务后：

1. 按数据库 job id 读取当前任务和目标对象。
2. 已成功、取消或已被新任务替代时直接结束。
3. 创建 `job_attempts` 记录并把 job 改为 running。
4. 从数据库和对象存储重新装配输入。
5. 执行 handler，成功后保存结果并更新业务状态。
6. 失败时保存错误，根据 attempt 次数决定重试或 failed。

这里不使用 transactional outbox。API 在入队失败时返回错误或由简单扫描任务重新入队 pending job；
允许少量任务通过用户重试恢复，不为所有消息投递边界建立额外协议。

---

## 9. EPUB 处理流程

### 9.1 上传

1. API 校验扩展名、MIME、大小上限和用户配额。
2. 请求体流式写入临时对象，同时计算 SHA-256，不把整本 EPUB 放入内存。
3. 按 SHA-256 查询或创建 `shared_books`。
4. 如果已有同哈希的 ready package，直接复用。
5. 如果已有进行中的 normalization run，用户关联到同一 shared book 并查看相同进度。
6. 否则创建新的 normalization run 和 BullMQ job。
7. 用户书籍立即关联 shared book，前端通过 SSE 展示处理阶段。

未来如果改为对象存储直传，服务端仍需重新读取对象计算可信哈希，不能接受客户端声明的哈希。

### 9.2 规范化

每次规范化任务：

1. Worker 创建 E2B sandbox。
2. 上传源 EPUB、规范文档和校验工具。
3. Pi Agent 检查源文件并编写 `normalize.py`。
4. 在 E2B 中运行脚本。
5. 执行 `nb_linter.py` 和 `nb_check.py --baseline`。
6. Agent 根据校验错误有限迭代。
7. 达到 turn、时间或成本上限后停止。
8. Worker 在 Agent 完成后再次独立执行完整校验。

Sandbox 只接收当前任务文件；Pi SDK、数据库连接和模型密钥不进入 sandbox。Agent 只能通过受限工具
读源文件、写或 patch `normalize.py`、运行固定 normalizer 和校验命令。

### 9.3 Indexing 和书籍分析

规范化通过后，确定性程序：

1. 生成完整 `reading_manifest.json`。
2. 执行 block v1 枚举、标准文本和 UTF-16 映射检查。
3. 校验 outline、节点顺序和裁读资格。
4. 校验每个 `assets/...` 引用路径安全且文件存在。
5. 生成按节点切分的只读 fragment/index，供阅读 API 使用。

随后书籍分析 Agent 只读规范化内容和 manifest，生成 `book_profile.json`。程序检查 schema、试读候选
节点是否存在、是否具有裁读资格，以及是否复制了过多原文。

### 9.4 Package 发布

所有文件先写到新的不可变 package 前缀。确认必需文件存在后，数据库创建 `book_packages` 记录，
更新 `shared_books.current_package_id` 并把 shared book 改为 ready。

这只是避免用户读到半写入 package 的基本发布顺序，不执行跨画像、策略、prompt 等输入版本的发布
门禁。客户端只读取数据库当前指向的 package，不根据对象路径猜测最新版本。

建议对象 key：

```text
uploads/{upload_id}/source.epub
normalization/{run_id}/attempts/{attempt_no}/...
books/{epub_sha256}/packages/{package_version}/book.normalized.html
books/{epub_sha256}/packages/{package_version}/reading_manifest.json
books/{epub_sha256}/packages/{package_version}/book_profile.json
books/{epub_sha256}/packages/{package_version}/assets/...
```

规范化结果仍必须符合 `normalized_book_spec.md`。这里的校验是书籍格式正确性的必要检查，不扩展成
覆盖所有业务版本和状态的发布门禁系统。

### 9.5 失败

BullMQ 自动重试有限次数。仍然失败时：

- shared book 标记为 failed。
- 保存用户可理解的失败类型和内部错误摘要。
- 用户可以点击重试，创建一个新的任务。

每次自动重试创建全新 Agent 和 E2B 工作区，不实现 attempt 工作区续跑。产品层允许用户在自动重试
耗尽后再次发起新的 job。

---

## 10. 访谈、试读和正式阅读

### 10.1 访谈

访谈 Agent 在 API 请求中直接运行：

1. 保存用户答案。
2. 从数据库读取画像、book profile 和历史消息。
3. 创建新的 Pi Agent 并执行当前一轮。
4. 将用户可见文字流式返回。
5. 保存下一题、本书画像或策略草稿。

服务端检查问题数量和反馈次数，不依赖 prompt 自觉遵守。

### 10.2 交互式 Session Cache

API 进程内使用有容量上限的 LRU + TTL 缓存交互式 Agent snapshot，减少每轮都从完整历史重建的
成本。它只是读取优化，不是业务事实来源，也不要求负载均衡粘性。

缓存 key：

```text
agent_type + logical_session_id
```

缓存 entry 包含：

- 当前 `conversation_version`
- 可序列化的 Pi messages
- 上下文压缩摘要及其版本
- 最近使用时间和估算内存大小

不缓存 live Agent、数据库连接、工具闭包、HTTP stream、密钥、运行中的 tool call 或整本书内容。
缓存缺失或版本不一致时从 PostgreSQL 重建。API 重启只会造成 cache miss，不影响业务数据。

当前不实现分布式 session cache。访谈 active turn 使用 PostgreSQL 中的 turn lease 和
`conversation_version` fencing；API 副本崩溃或 lease 过期后可由 resume 接管新 attempt，缓存仍只是
可丢失的读取优化。

### 10.3 批准草稿并生成试读（`approveDraftForTrial`）

用户第一次确认策略后：

1. Web 创建稳定幂等键并调用 approve stream；页面立即切换为固定的三个 provisional 槽位。
2. Agent stream parser 在 fragment 原始 JSON 对象真实闭合后逐个发送片段，API 校验范围并切出
   `originalHtml`。
3. 三个片段全部合法后，operation 最终事务标记草稿 approved-for-trial，创建 `trial_revision`、三个
   segment 和 generation，并原子切换 current pointer。
4. Worker 分别把 segment 推进为 pending/generating/ready/failed；API 在单段 ready 后立即返回该段
   result，Web 在同一原文 stage 原地加入辅助内容。
5. 只有 3/3 ready 后 revision 才 published，user book 才进入 `trial_review` 并开放反馈和采用。

任一片段失败时整轮进入 `trial_generation_failed`，但三个原文和已完成段仍可查看。技术 retry 锁定
当前 failed revision，精确复制其三个 segment 创建新 revision，不重新运行选段 Agent，也不继承旧
revision 的缓存和页面局部状态。

策略页反馈和试读页反馈复用 `strategy_revision` operation。试读反馈期间旧 revision 保持 current；
只有新草稿最终事务成功后才 supersede 旧 trial 并增加调整次数，operation 失败时恢复旧试读。

### 10.4 确认正式策略并开始阅读（`confirmStrategyAndStartReading`）

用户最终确认三个试读片段后：

- 将已批准的草稿确认并创建正式 `strategy_version`。
- 用户书籍进入 `active_reading`。
- 创建第一个正式节点及后续三个可裁读节点的生成任务。

试读和正式阅读使用同一个内容生成器。输入范围不同，但 prompt、输出结构和锚点解析逻辑相同。

最终采用不要求 `Idempotency-Key`，而是使用业务状态幂等：事务检查当前 trial/draft pointer；若书籍已为
`active_reading`，直接返回现有 `strategy_version`。并发请求只能创建一个正式策略和一组正式生成记录。

### 10.5 正式节点生成

试读和正式阅读使用同一生成器：

- `generation_scope = trial` 输入节点内连续 block range，只允许使用已批准的策略草稿。
- `generation_scope = formal` 输入完整阅读节点，使用正式策略。

输出执行 TypeBox schema、Markdown 安全规则、quote 唯一匹配和 UTF-16 range 校验。当前节点生成
失败时原文仍然可读。用户跳转时确保目标节点任务存在并提高优先级；正常阅读时持续生成当前节点
之后三个可裁读节点。

### 10.6 策略调整

问 AI Agent 判断需要调整处理方式时，必须调用工具创建待确认 proposal。proposal 绑定当前问 AI
会话和触发它的 assistant message，前端紧跟该回复展示确认卡。工具调用和候选草稿都不能直接修改
当前正式策略。

用户可以直接确认，也可以在原会话中继续反馈。Agent 根据反馈修订同一个 proposal 并重新提交确认。
用户明确确认后创建新策略，当前节点立即切换并重新生成，后续未读节点按窗口懒生成；其他已读节点
继续使用其固定策略版本。

确认命令以 proposal revision、基础策略版本和幂等键做并发门禁。旧任务在 worker 开始执行和最终
写回前校验节点期望策略；读取时每个节点只选择一个期望策略版本。

---

## 11. 阅读器

### 11.1 内容

阅读 API 按 `section_id + segment` 返回：

- 原文 fragment
- block 元数据和标准文本 hash
- 当前节点的 AI 增强内容
- 原书注释
- manifest 位置和相邻节点
- 当前 block 的全书字符位置和书籍原文总字符数

原文先显示，AI 内容可以随后加载。

媒体通过稳定授权路由或短期签名 URL 加载。package 中继续保存逻辑 `assets/...` 路径，响应时解析为
实际资源地址，不修改不可变 package。

### 11.2 连续滚动

前端只保留当前节点前后有限窗口，接近边界时加载相邻节点。使用 IntersectionObserver 判断当前节点
和有效停留，并通过占位高度与 scroll anchoring 减少内容跳动。

窗口必须保证：

- 目录跳转正确。
- 原文顺序正确。
- 卸载远端节点后重新加载可以恢复位置。
- AI 内容迟到不会替换或删除原文。
- 纯原文先于增强内容展示。

窗口大小、预加载距离和占位策略配置化，在真实长书测试中逐步调整。

### 11.3 划线和笔记

划线和笔记使用 `reading_contract.md` 的 `section_id + segment + block range`。

`reader-core` 提供 block 枚举、标准文本和 UTF-16 offset 算法。前端负责把 DOM selection 转为 range，
API 保存前再次检查节点、block、offset 和选中文本 hash。

保存划线时先创建 `highlights`。用户输入笔记后创建或更新以 `highlight_id` 唯一的 `notes` 记录。删除
笔记只删除 note；删除划线同时删除当前 note，但保留已经由该划线发起的历史问 AI 会话及其原始
range 快照。

### 11.4 进度同步

客户端在固定间隔、页面隐藏和节点切换时上报：

```text
section_id + segment + block_index + offset + client_observed_at
```

API 使用客户端观察时间合并进度，明显过期的事件不覆盖更新位置。用户主动目录跳转可以更新当前
位置，但“已读”仍按 PRD 的有效停留和到达规则判定。进度只基于 manifest 原文位置，不计算 AI 内容。

Indexing 阶段额外生成可重建的 `reading_position_index`：

```text
book_total_characters
node_order -> node_absolute_start + node_character_count
section_id + segment + block_index -> block_absolute_start + block_utf16_length
```

它把 manifest 位置转换为全书绝对原文字符位置，用于进度百分比、连续移动判断、向前字符量和剩余
字符量计算。它是派生索引，不替代 `book.normalized.html` 和 `reading_manifest.json`。

### 11.5 阅读活动采集

用户进入正式阅读器时创建 `reading_sessions`。客户端在用户保持活动时周期性提交 slice，并在节点
切换、页面隐藏、空闲、返回书架和正常退出时立即结束当前 slice。

每次提交包含：

```text
client_session_id
sequence
slice_started_at
slice_ended_at
activity_kind
start_position
end_position
timezone
```

服务端负责：

1. 校验 session 属于当前用户和 user-book。
2. 使用 `client_session_id + sequence` 幂等写入。
3. 限制单个 slice 的最大时长，拒绝负数、未来时间和异常跨度。
4. 根据时区计算 `local_date`；跨本地午夜时，聚合阶段把有效秒数分别计入两个自然日。
5. 使用 `reading_position_index` 计算位置差。
6. 将明显不连续的移动标记为 `original_jump`，不把跳过的字符计入速度样本。
7. 在同一数据库事务中更新按书每日统计、按书累计统计和全局每日汇总。

页面后台、超过空闲阈值或不在正式阅读器时不产生有效 slice。试读页面、问 AI 独立视图、书架和
阅读统计页面不创建 reading activity。

### 11.6 阅读统计

统计查询直接读取聚合表：

```text
今日阅读时长 = reading_daily_totals[用户当前本地日期]
本周阅读时长 = 当前本地周内 reading_daily_totals 之和
累计阅读时长 = 该用户全部 reading_daily_totals 之和
连续阅读天数 = 从当前本地日期向前连续存在 active_seconds > 0 的日期数
按书累计时长 = book_reading_stats.active_seconds
```

`reading_daily_book_stats` 用于按日期查看某本书的数据和重建 `book_reading_stats`。全局统计不依赖
仍然存在的 user-book，因此永久删除一本书不会使累计时长和连续阅读天数倒退。

### 11.7 个人速度和剩余时间

个人速度按用户和书籍分别计算：

```text
book_speed = sum(original_forward.forward_character_count)
             / sum(original_forward.active_seconds)

remaining_characters = book_total_characters - current_absolute_character_position

estimated_remaining_seconds = remaining_characters / book_speed
```

只使用通过服务端校验的 `original_forward` slice。`original_reread`、`original_jump`、`assistance` 和
`stationary` 不进入速度样本。为避免一次异常快速滚动污染结果，服务端按配置的最小/最大速度和位置
跨度过滤异常 slice。

当 `speed_sample_seconds` 未达到配置阈值时，使用中文书籍默认阅读速度；达到阈值后改用该书个人
速度。响应同时返回 `estimate_source = default|personal`，前端统一展示为近似剩余时间。

剩余字符从当前稳定位置计算到书末，不尝试统计全书所有未读覆盖区间。用户目录跳转会改变当前位置
和剩余字符，但跳转跨过的字符不进入个人速度和已读字符统计。

### 11.8 删除与统计保留

软删除后的 30 天内保留全部阅读数据，以便恢复。永久清理 user-book 时删除：

- `reading_progress` 和 `read_nodes`
- `highlights` 和 `notes`
- `reading_sessions` 和 `reading_activity_slices`
- `reading_daily_book_stats` 和 `book_reading_stats`
- 其他本书画像、策略、试读、节点增强和问答数据

`reading_daily_totals` 不删除，也不保留 user-book 外键。这样全局累计时长和连续阅读天数保持不变，
同时无法从该表判断用户曾阅读哪本已删除书籍。

---

## 12. API 和实时响应

使用 REST JSON 处理普通查询和命令：

```text
/v1/auth/*
/v1/profile/*
/v1/books/*
/v1/user-books/*
/v1/user-books/:id/interview/*
/v1/user-books/:id/strategy/*
/v1/user-books/:id/trial/*
/v1/user-books/:id/reader/*
/v1/user-books/:id/qa/*
/v1/reading-stats/*
/v1/jobs/:id
/v1/events
```

阅读准备恢复和精确版本接口包括：

```text
GET  /v1/user-books/:id/reading-setup-operation/current
GET  /v1/user-books/:id/reading-setup-operation/:operationId
POST /v1/user-books/:id/reading-setup-operation/:operationId/resume
GET  /v1/user-books/:id/strategy/versions/:draftId
GET  /v1/user-books/:id/trial/revisions/:trialRevisionId
POST /v1/user-books/:id/strategy/feedback/stream
POST /v1/user-books/:id/trial/feedback/stream
POST /v1/user-books/:id/strategy/approve/stream
```

阅读器相关接口至少包括：

```text
GET    /v1/user-books/:id/reader/node
PUT    /v1/user-books/:id/reader/progress
POST   /v1/user-books/:id/reader/sessions
POST   /v1/user-books/:id/reader/sessions/:sessionId/slices
POST   /v1/user-books/:id/highlights
DELETE /v1/user-books/:id/highlights/:highlightId
PUT    /v1/user-books/:id/highlights/:highlightId/note
DELETE /v1/user-books/:id/highlights/:highlightId/note
GET    /v1/user-books/:id/reading-stats
GET    /v1/reading-stats/summary
```

提交 activity slice 时使用 `(client_session_id, sequence)` 幂等去重。按书统计响应至少返回累计有效
秒数、最近阅读时间、当前进度、预计剩余秒数和 `estimate_source`；全局统计响应返回今日、本周、
累计有效秒数和连续阅读天数。

大文件上传使用流式 multipart。访谈、策略反馈、试读反馈、`approveDraftForTrial` 和问 AI 的 POST
请求使用流式 HTTP/SSE 响应；流结束时发送 typed completion event，携带最终保存的业务结果或结果快照。

后台任务进度使用 SSE。SSE 事件包含递增 id、类型、资源 id、资源状态和产品化 payload。客户端断线
后重新连接并主动查询相关 user-book/job 快照；当前不建设持久化 business event 日志和完整事件回放。

SSE 不发送模型思维过程、原始工具参数或内部日志。阅读准备流连接中断或收到 `lease_lost` 时，客户端
保留 committed/provisional 内容并进入 recovering，通过 current/exact operation 和精确版本快照恢复；
只有 operation 明确 failed 后才开放新提交。

会创建可恢复长任务的阅读准备按钮请求携带幂等键，并校验 request hash；同键同输入返回同一
operation，同键不同输入返回 409。`confirmStrategyAndStartReading` 不创建 operation、也不要求幂等键，
由当前业务状态和数据库事务保证重复调用只返回同一正式策略。

统一错误格式：

```json
{
  "error": {
    "code": "TRIAL_GENERATION_FAILED",
    "message": "试读生成失败，请重试",
    "request_id": "...",
    "details": {}
  }
}
```

用户可见 message 使用稳定产品文案。模型 provider 的原始错误、堆栈和内部路径只进入脱敏日志。

---

## 13. Agent 和 AI 输出

### 13.1 Agent 运行

- 后台任务每次创建新的 Agent。
- 交互请求每轮创建新的 Agent。
- Pi `sessionId` 只用于 provider cache 或关联，不作为持久化执行状态。
- 工具默认顺序执行。
- Agent 工具由宿主注入，只能访问当前用户或当前书籍所需内容。
- 规范化 Agent 只能通过受控工具读文件、修改 `normalize.py` 和运行固定命令。
- 工具输出限制长度，避免把整本书无界放进上下文。
- `beforeToolCall` 检查 Agent 类型、资源归属、当前业务状态和调用配额。
- `afterToolCall` 截断并记录基础日志，识别 Agent 是否已经完成。
- 工具失败返回明确错误，不能用普通成功文本掩盖失败。

### 13.2 输出处理

结构化 AI 输出至少执行：

1. JSON/schema 解析。
2. 领域不变量检查，例如问题数量、试读片段数量和策略类型。
3. 节点、资源和 range 是否存在的检查。
4. Markdown 安全渲染。
5. 长度限制。
6. 保存结果。

当前不保存完整的输入版本快照，也不在发布前执行跨对象版本比较。发现真实的并发覆盖问题后，再为
对应流程增加局部版本检查。

### 13.3 模型配置

`ModelProvider` 模块统一普通生成调用和 Pi 所需模型对象。配置支持全局默认和按功能覆盖，至少包括：

- provider/base URL
- model id
- timeout 和 max output
- Agent 最大 turn、总时间和成本限制
- prompt/schema version

业务代码不直接依赖某个 provider 的私有请求格式。首版只实现实际使用的 OpenAI 兼容 provider；
需要第二个 provider 时再扩展 capability，不提前覆盖所有厂商特性。

### 13.4 运行限制

配置化限制至少包括上传大小、解压后大小、Agent turn/时间/成本、模型输出、工具输出、后台并发、
自动重试、日志截断和用户请求频率。达到限制时保存明确停止原因，不能无限运行。

---

## 14. 基础安全要求

### 14.1 认证和授权

- 使用服务端 httpOnly、secure、sameSite cookie session。
- API 执行 CSRF 防护、登录频率限制和 session 撤销。
- 首版使用 Google OAuth。
- 每次查询按 session 中的 `user_id` 约束，不接受客户端提供的 user id 作为授权依据。
- shared book 可以跨用户复用，但读取 package 前仍检查用户拥有对应 user-book。
- Agent 工具绑定当前资源 id，不允许模型任意选择其他用户或绝对路径。

### 14.2 EPUB、HTML 和 Sandbox

- 上传大小、解压大小和文件数量限制
- ZIP 路径穿越和 zip bomb 防护
- E2B 中的时间、CPU、内存和磁盘限制
- 不向 sandbox 提供数据库和模型密钥
- 清除 EPUB 中的脚本、事件属性、iframe 和危险 URL
- AI Markdown 禁止原始 HTML
- 对象存储资源不能逃出当前书籍目录
- 媒体响应使用正确 Content-Type、CSP 和 `nosniff`

### 14.3 日志和数据最小化

- 日志不记录密钥、OAuth token、完整宿主路径和不必要的整本原文。
- 发给模型的原文按任务范围截取，图片移除真实 src/base64。
- 大型 prompt/response 默认不持久化；调试时按环境开关保存并限制访问。

当前不处理跨境合规、国内访问和企业级数据治理。

---

## 15. 部署

### 15.1 本地开发

Web、API 和 Worker 在本机运行，连接独立的托管 PostgreSQL、Redis 和对象存储开发资源。
模型和 E2B 使用测试账号或 fake。当前不要求为中间件维护本地 Docker Compose。

### 15.2 首个可用部署

```text
Static Web Hosting
  -> API container
  -> Worker container
  -> PostgreSQL
  -> Redis
  -> Object Storage
  -> Model Provider / E2B
```

优先选择能最快部署的国外云平台或托管服务。初期可以只有一个 API 实例和一个 Worker 实例。

API 和 Worker 使用同一镜像版本但不同启动命令、权限和伸缩参数。normalization、content 等任务可以
从同一 Worker 代码启动为不同进程，以便分别设置 queue 和并发。数据库 migration 作为部署步骤运行，
不在应用启动时自动执行破坏性迁移。

### 15.3 外部服务接口

- `ObjectStorage`：put/get/head/delete/list、multipart 和 signed URL。
- `CodeSandbox`：create、upload、runFixedCommand、download、destroy。
- `ModelProvider`：model factory、usage 和错误映射。

这些接口只覆盖产品已经使用的能力，不以适配所有云厂商为目标。

---

## 16. 可观测性

所有请求、job、attempt 和 AI run 使用可关联 id。至少记录：

- HTTP 成功率、延迟、上传大小和错误码
- queue depth、等待时间、attempt 数和失败率
- 各 Agent turn/tool 数、耗时、token 和停止原因
- E2B 创建、执行和下载耗时
- normalization 各校验步骤通过率和失败规则分布
- 节点生成耗时、缓存命中率和锚点失败率
- SSE 连接数和重连次数
- `setup_stream.first_visible_delta_ms`、`setup_stream.duration_ms`
- `setup_operation.kind/source/status`、operation 时长和失败率
- `setup_operation.lease_renewed`、`setup_operation.lease_reclaimed`、
  `setup_operation.lease_lost`、attempt 数、disconnect/resume 数
- `trial_selection.first_fragment_ms`、`trial_selection.complete_ms`
- `trial_generation.segment_ready_ms`（按 ordinal）和 `trial_generation.all_ready_ms`
- activity slice 接受/拒绝数、重复提交数和有效阅读秒数
- 使用默认速度与个人速度的书籍数量、异常速度样本过滤数

首版使用 Pino 结构化日志和托管平台自带指标，不建设独立审计仓库、全链路追踪平台或自定义运营
后台。

### 16.1 阅读准备排障

排障按以下顺序进行，不能先手工改 pointer 或删除 operation：

1. 用 `user_book_id` 查询 `user_books.workflow_status`、当前 draft/trial pointer，以及最新
   `reading_setup_operations` 的 kind/source/status/attempt/lease expiry/result pointer。
2. `running` 且 lease 未过期：确认 API 日志中同一 `operation_id + attempt` 是否仍有续租；客户端应保持
   recovering，不重复提交。
3. `running` 且 lease 已过期：调用 operation resume 或让客户端恢复；确认 attempt 增加，旧 attempt 的
   SSE/最终提交被 fencing 拒绝。
4. `completed`：按 `result_strategy_draft_version_id` 或 `result_trial_revision_id` 查询精确快照，再检查
   user book current pointer。completed 重放不得改写后来版本 pointer。
5. `failed`：读取脱敏 `error_summary` 和 recoverable input 投影；确认 adjustment count、旧 draft/trial
   pointer 未被部分修改。
6. trial 长时间 generating：按 current revision 查询三个 `trial_segments` 及其 `node_generations`。单段
   ready 必须有非空 result；3/3 ready 但未 published 时检查 Worker 最终发布事务与 current pointer。
7. trial failed 后 retry：确认新 revision 的三个范围与旧 failed revision 按 ordinal 完全一致，旧 revision
   和 generation 只按精确 id supersede，没有影响同书历史 revision。

日志关联至少使用 request id、user book id、operation id、attempt、base draft/trial id 和 result pointer；
不得记录完整反馈、策略正文或原文。

---

## 17. 测试

测试围绕“主流程能否真实使用”展开。

### 17.1 单元和契约测试

- 主要状态迁移和禁止操作
- 幂等键和生成缓存键
- TypeBox schema 和错误映射
- normalized book 校验工具
- manifest、block 和 UTF-16 range 契约测试
- AI 输出 schema 和 quote 锚点测试
- 试读与正式阅读共用生成器测试
- 对象 key、资源路径安全和 package manifest
- Agent 工具权限和输出截断
- Session Cache 命中、TTL/LRU 淘汰和数据库重建
- activity slice 幂等键、时长边界和 activity kind 分类
- 全书绝对字符位置、当前位置到书末字符量和剩余时间计算
- 本地自然日、跨午夜拆分、本周范围和连续阅读天数
- 默认速度与个人速度切换

### 17.2 集成测试

使用真实 PostgreSQL、Redis 和 MinIO 验证：

- API 创建 job 并由 Worker 完成
- 重复 BullMQ 消息不会重复发布同一业务结果
- Worker 失败后 BullMQ 自动重试
- 第三次自动失败后稳定进入 failed
- 三个试读片段全部成功才进入 trial review
- 单段 ready 时 API/Web 可见该段结果，但采用仍要求 3/3 published
- reading setup 同键重放、hash 冲突、lease 过期接管和旧 attempt fencing
- trial retry 精确复制 failed revision 三段且不重新选段
- 访谈和问 AI 从 API 直接流式输出
- package 在文件完整写入前不会被用户读取
- AI 内容失败时阅读 API 仍返回纯原文
- 重复 heartbeat 不重复累计阅读时间
- 多设备 activity 可以正确合并到全局和按书统计
- 回读、目录跳转和辅助内容不进入个人速度样本
- 永久删除 user-book 后按书统计消失，但全局累计时长和连续天数不倒退

E2B 和模型使用 fake adapter；测试环境保留少量真实 provider smoke test。

### 17.3 代表性书籍和 golden tests

准备少量覆盖以下情况的 EPUB：

- 中文小说
- 英文书
- 多级目录
- 脚注较多
- 图片和表格
- 结构异常或无法处理的 EPUB

不追求首版覆盖所有 EPUB。无法可靠处理的文件明确失败，不通过大量启发式规则勉强接受。

每本 fixture 保存预期的 `nb_check`、manifest、block、资源和关键目录结果。算法或契约变化时显式更新
fixture，避免无意改变阅读位置。

### 17.4 Agent 评测

- 规范化 Agent 以确定性校验结果、资源守恒和最大迭代限制验收。
- 书籍分析以 schema、试读候选合法性和原文复制限制验收。
- 访谈以问题数量、两次确认和反馈次数验收。
- 问 AI 以工具权限、检索范围和策略建议不直接生效验收。

当前用固定样本和可重复脚本完成评测，不建设独立 Agent 评测平台。

### 17.5 浏览器端到端

Playwright 覆盖登录、上传、进度、访谈、试读、正式阅读、连续滚动、目录跳转、划线笔记、阅读统计、
剩余时间、问 AI、删除恢复和移动端布局。阅读器使用真实长书 fixture 检查滚动位置、延迟增强内容、
图片加载、页面后台停止计时和默认速度切换为个人速度。

### 17.6 暂不建设

- 大规模并发压测
- 多实例故障注入
- Redis 丢失后的自动恢复测试
- 跨地域灾难恢复演练
- 全组合状态机测试
- 多地域故障切换测试

---

## 18. 实施顺序

### 阶段 1：工程骨架

- pnpm workspace
- Web、API、Worker 入口
- PostgreSQL、Redis、MinIO 本地环境
- Drizzle migration、配置、secret 和结构化日志规范
- Web、API、Worker health check
- 测试 job 完成 API -> BullMQ -> Worker -> PostgreSQL 往返
- fake provider 完成交互请求 -> direct stream -> PostgreSQL 往返

### 阶段 2：EPUB 到 Ready

- 上传和 SHA-256
- E2B 规范化 Agent
- `nb_check` / `nb_linter`
- 完整 reading manifest、block/range 对账和派生 fragment
- package 对象 key 和不可变发布顺序
- book profile 和试读候选池
- 书籍处理进度和失败重试
- 使用多本 EPUB 验证成功、失败和重复上传

### 阶段 3：访谈和试读

- 长期画像
- Google OAuth、预置书和书架
- 单本书访谈、Session Cache 和刷新恢复
- 读前简报和策略草稿
- 三个试读片段
- 两次确认和反馈循环
- 反馈上限、旧 trial revision 隔离和整轮失败重试

### 阶段 4：阅读器

- 连续滚动
- 目录跳转
- 原文和 AI 内容分层
- 导读、裁读注、原书注和节后助读分层展示
- 进度、已读、划线、笔记和阅读设置
- reading session、activity slice、今日/本周/累计/连续天数统计
- 按书个人速度、默认速度回退和预计剩余时间
- 当前节点及后续三个可裁读节点预生成
- 长书、移动端、弱网和增强内容迟到测试

### 阶段 5：问 AI

- 划线和当前屏幕上下文
- 每问题独立会话
- 全书按需读取和搜索
- 长期画像更新
- 处理方式待确认建议、反馈修订和采用
- 验证放弃、失败和重复提交不会直接修改当前正式策略

### 阶段 6：实际使用后的修补

只根据真实使用中出现的问题补充：

- 并发冲突控制
- 更细任务恢复
- 性能缓存
- 更完整日志
- 数据迁移
- 部署可靠性

---

## 19. 当前完成标准

满足以下条件即可认为当前技术方案实现完成：

1. 用户能够登录并完成长期画像。
2. 代表性 EPUB 可以从上传处理到 ready。
3. 规范化产物通过确定性校验。
4. 用户可以完成访谈、两次确认和三个试读片段。
5. 用户可以连续滚动阅读原文和 AI 增强内容。
6. 节点增强失败时原文仍然可读。
7. 进度、划线和划线笔记可以保存并恢复；产品不提供书签或独立笔记。
8. 正式阅读器活动可以生成今日、本周、累计、连续天数和按书阅读统计。
9. 每本书可以根据当前位置、默认速度或个人速度返回预计剩余阅读时间。
10. 永久删除一本书后按书详情被清理，但全局累计时长和连续天数不倒退。
11. 用户可以划线或直接问 AI。
12. 用户可以查看、修订并采用一次处理方式待确认建议。
13. 主链路在桌面和移动端均可完成。

除此之外的可靠性、治理和规模化能力不作为当前版本完成条件。
