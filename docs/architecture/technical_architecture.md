# 裁读 ReadTailor 技术方案

**版本**：v0.2  
**日期**：2026-07-13  
**状态**：待评审  

关联文档：

- [`product_prd.md`](../product/product_prd.md)：产品行为与最终验收标准
- [`agent_design.md`](agent_design.md)：Agent 职责、工具和权限边界
- [`reading_contract.md`](../contracts/reading_contract.md)：阅读节点、block 和锚点契约
- [`normalized_book_spec.md`](../contracts/normalized_book_spec.md)：规范化书籍契约

本文定义新 TypeScript 产品的系统边界、模块职责、数据模型、异步执行、接口约定、部署方式、
测试策略和实施顺序。它不替代上述产品与数据契约；实现冲突时，产品行为以 PRD 为准，书籍和
阅读位置以对应版本化契约为准。

---

## 1. 目标、约束与非目标

### 1.1 目标

- 从新 TypeScript 项目实现完整网页产品，不以旧 Rust CLI 作为生产后端。
- Agent 和成熟阅读器均作为正式核心模块开发，不建设后续必须推翻的临时原型。
- 支持上传任意无 DRM EPUB，经 Agent 规范化、确定性校验和书籍分析后发布为共享书籍包。
- 支持用户画像、每本书访谈、两次确认、试读、连续滚动阅读、划线笔记和问 AI 的完整闭环。
- 所有异步任务可以重试、审计和恢复业务状态；后台 Agent 崩溃后完整重跑，最多三次。
- 允许使用境外模型、E2B 等服务，同时保证大陆客户端不直接依赖这些服务的可达性。

### 1.2 硬约束

- PostgreSQL 是业务事实的唯一来源。
- 规范化书籍包按源 EPUB SHA-256 和契约版本不可变。
- 原文与 AI 内容分层存储，任何个性化流程不得修改原文。
- Pi Agent SDK 直接嵌入 Node.js Worker，不部署独立 Pi runtime。
- 不使用 Temporal 或类似持久化工作流引擎。
- 队列只负责投递和并发，不决定业务状态。
- 所有 AI 产物发布前必须执行 schema、权限、状态和输入版本门禁。

### 1.3 本方案不提前决定

- 阿里云、腾讯云、AWS 或其他具体云厂商
- 正式模型供应商和每类任务使用的模型
- E2B 的生产替代品
- 日志、指标和告警的具体托管平台
- 超出首发 PRD 的社交、推荐、书城和商业化能力

---

## 2. 技术选型

| 领域 | 选择 | 说明 |
|---|---|---|
| 语言与运行时 | TypeScript、Node.js LTS | API、Worker 和共享内核使用同一类型系统 |
| 项目组织 | pnpm workspace | 独立应用，共享 contracts 和内核包 |
| Web | React、Vite、React Router | SPA；服务端业务状态仍由 API 决定 |
| 数据获取 | TanStack Query | 请求缓存、重试、失效和 optimistic update |
| API | Fastify、TypeBox | runtime schema 与 TypeScript 类型同源 |
| 数据库 | PostgreSQL、Drizzle ORM | 事务、唯一约束、显式迁移和类型化查询 |
| 后台队列 | BullMQ、Redis | 投递、并发、优先级、延迟和 stalled 检测 |
| Agent | Pi Agent SDK | 直接运行在 Worker 进程内 |
| 代码沙箱 | E2B | 只执行生成的 `normalize.py`，经适配器隔离 |
| 对象存储 | `ObjectStorage` 适配器 | 支持 OSS、COS、S3、R2 和本地实现 |
| 实时进度 | SSE | 后台进度与交互式命令的单向增量；命令仍由 HTTP POST 发起 |
| 日志 | Pino 结构化日志 | trace、job、AI run 和业务对象统一关联 |
| 测试 | Vitest、Playwright | 单元/集成测试与浏览器端到端测试 |

不引入 GraphQL、微服务框架、事件流平台或工作流引擎。首发按模块化单体组织 API 和 Worker，
通过清晰的包边界保留未来拆分能力。

---

## 3. 总体架构

```text
Browser
  -> Web static assets
  -> Fastify API
       -> PostgreSQL
       -> ObjectStorage
       -> Redis/BullMQ
       -> interactive Pi Agent
            -> model provider
            -> host-provided read/write tools
       -> direct response stream
       -> background SSE event stream

BullMQ
  -> Node Worker
       -> PostgreSQL
       -> ObjectStorage
       -> Pi Agent SDK
            -> model provider
            -> host-provided tools
                 -> E2B CodeSandbox
                 -> normalized-book validators
```

### 3.1 Web

负责登录、画像、书架、上传、访谈、策略确认、试读、阅读器、划线笔记和问 AI 界面。

Web 只访问 API 和由 API 授权的媒体地址，不持有数据库、Redis、对象存储、模型或 E2B 密钥。
页面路由只表达界面位置，不能自行推进业务状态。刷新、跨设备和多标签页恢复均以 API 返回的
当前状态和版本为准。

### 3.2 API

Fastify API 负责：

- 身份认证、session 和用户资源归属校验
- 同步命令、查询、TypeBox schema 校验
- 数据库事务、状态迁移和 optimistic concurrency control
- 在同一事务中创建业务记录、job 和 outbox event
- EPUB 流式上传、哈希计算和对象存储写入
- 节点原文、阅读进度、划线笔记和问答接口
- 在请求进程内直接运行访谈和问 AI Agent，并把两类 Agent 的用户可见输出直接流式返回
- 维护可丢失、可重建的交互式 Agent session cache
- 把业务事件映射为 SSE 进度事件

API 请求进程不运行 EPUB 规范化、书籍分析、试读/节点生成等后台任务。交互式 Agent 的模型
调用和工具主要是异步 I/O，由 API 直接执行；它们使用独立并发限制和请求总超时。

### 3.3 Worker

Worker 根据数据库 job id 执行后台任务：

- EPUB 规范化 Agent
- reading manifest 和派生阅读索引生成
- 包级校验
- 共享书籍分析 Agent
- 试读片段及正式阅读节点内容生成
- 策略调整的完整节点预览生成
- outbox 投递、过期数据清理和维护任务

每个 handler 必须先读取数据库中的 job、目标对象和输入版本，再决定执行、跳过或标记过期。
BullMQ payload 只保存稳定 id，不复制完整业务输入。

### 3.4 PostgreSQL

PostgreSQL 保存所有业务事实、版本指针、任务状态、审计记录和可查询的小型结构化 AI 产物。
大文件和大日志放入对象存储，数据库只保存哈希、大小、MIME、版本和 artifact reference。

### 3.5 Redis 与 BullMQ

Redis/BullMQ 只负责：

- 后台任务投递、并发和优先级
- 延迟任务和有限重试
- Worker heartbeat 和 stalled job 检测
- 短期频率限制和非事实型缓存

Redis 数据丢失后，可以根据 PostgreSQL 中未完成 job 和 outbox 重建队列。

### 3.6 对象存储

对象存储保存源 EPUB、attempt 工作产物、不可变发布包、可重建阅读索引和大型日志。业务代码只
依赖 `ObjectStorage`，provider SDK 不能散落在 domain、API 或 Agent 工具中。

### 3.7 境外服务边界

允许使用 E2B 和境外模型。后台调用由 Worker 发起，交互式模型调用由 API 发起：

- 浏览器不直接访问 E2B 或模型 API。
- API 和 Worker 分别配置连接、读取、执行和总超时；后台任务按 attempt 重试，交互请求失败后
  保留用户输入并允许重试当前 turn。
- 每个 provider 必须有健康检查、错误分类、成本记录和可替换配置。
- 传出 EPUB 内容或用户文本前，应在产品条款和隐私说明中明确第三方处理范围。
- 大陆生产环境需要固定受控出口；外部服务不可达不能破坏数据库的一致性。

---

## 4. Monorepo 与模块边界

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
  infrastructure/
    local/
    deploy/
  docs/
```

### 4.1 依赖方向

```text
contracts <- web
contracts <- api -> domain -> database
contracts <- worker -> domain -> database

api/worker -> storage, queue, ai, observability
worker -> agent-kit -> ai
worker -> normalized-book
web -> reader-react -> reader-core
normalized-book -> reader-core
```

约束：

- `domain` 不依赖 Fastify、BullMQ、云 SDK 或 Pi SDK。
- `contracts` 只放跨进程 schema，不放数据库 row 类型。
- `database` 实现 repository 和 transaction boundary，不保存 UI 逻辑。
- `agent-kit` 只封装 Pi、模型、工具拦截和事件映射，不决定业务状态。
- `reader-core` 保存 block、range、进度和节点窗口等与 React 无关的算法。
- `reader-react` 只负责渲染、选择映射、滚动观察和交互组件。

### 4.2 共享契约

TypeBox schema 用于：

- HTTP 请求和响应
- SSE 事件 payload
- BullMQ job payload
- Agent 工具参数和结果
- AI 结构化输出
- `book_profile`、画像、策略和节点增强等 JSON 产物

数据库迁移和外部 JSON 文件仍有独立版本，不能把 TypeScript 类型检查当作运行时校验。

---

## 5. 核心数据模型

以下是逻辑表组，不在本阶段冻结全部字段名。所有业务主键使用 UUID；所有可变业务对象包含
`created_at`、`updated_at`，需要并发保护的对象包含单调递增 `version`。

### 5.1 身份和画像

| 表组 | 作用 |
|---|---|
| `users` | 用户主体、初始画像完成状态、停用状态 |
| `auth_identities` | 登录方式、provider subject、验证状态 |
| `auth_sessions` | 服务端 session、过期和撤销 |
| `reader_profiles` | 当前长期画像指针 |
| `reader_profile_versions` | 不可变画像版本和变更来源 |

登录不能只依赖 Google。面向中国大陆用户时，首发至少提供邮箱验证码或 magic link；Google OAuth
可以作为可选方式。认证实现放在 `AuthProvider` 接口后，最终供应商在认证模块开始前确认。

### 5.2 共享书籍

| 表组 | 作用 |
|---|---|
| `source_uploads` | 上传者、临时对象、SHA-256、大小和状态 |
| `shared_books` | 按 EPUB SHA-256 唯一的共享书籍主体和当前状态 |
| `book_packages` | 不可变 package 版本、契约版本、对象前缀和校验摘要 |
| `normalization_runs` | 一次完整规范化业务 run |
| `book_profiles` | 与 package 一一对应的不可变共享分析 |

关键约束：

- `shared_books.epub_sha256` 唯一。
- 同一 shared book 同时最多一个活动 normalization run。
- `ready` 必须指向一个通过全部门禁的 package。
- package 发布后内容不可覆盖；修复产生新 package version。

### 5.3 用户书籍与个性化

| 表组 | 作用 |
|---|---|
| `user_books` | 用户与共享书的关系、主工作流、软删除信息和当前版本指针 |
| `interview_sessions` | 访谈状态、已问数量和当前问题 |
| `interview_answers` | 幂等保存每一题答案 |
| `book_reader_profile_versions` | 不可变本书画像版本 |
| `strategy_draft_versions` | 待确认策略草稿和读前简报 |
| `strategy_versions` | 已采用的正式策略版本 |
| `trial_revisions` | 试读轮次、反馈计数、对应草稿版本和状态 |
| `trial_segments` | 三个片段的范围、生成任务和查看状态 |
| `reading_setup_operations` | 策略反馈、试读反馈和策略确认的幂等、lease、attempt、终态和结果 pointer |

`user_books` 只保存当前指针；历史版本保留用于冲突检测、审计和解释既有已读节点内容。

### 5.4 阅读与问答

| 表组 | 作用 |
|---|---|
| `node_generations` | 节点/片段生成范围、输入版本、状态和产物 |
| `reading_progress` | 当前稳定位置和客户端事件时间 |
| `read_nodes` | 用户已读节点及其生效策略版本 |
| `highlights` | 基于 manifest range 的划线 |
| `notes` | 关联划线或位置的用户笔记 |
| `qa_sessions`、`qa_messages` | 每个问题独立会话及追问 |
| `strategy_change_proposals` | 正式阅读中的调整建议、预览和采用状态 |

`node_generations` 的唯一业务键至少包含：

```text
user_id + shared_book_id + package_version
+ section_id + segment + generation_scope + generation_range
+ reader_profile_version + book_reader_profile_version
+ strategy_draft_version|strategy_version
+ prompt_version + model_config_version
```

### 5.5 任务、事件和 AI 审计

| 表组 | 作用 |
|---|---|
| `jobs` | 业务任务、目标对象、状态、优先级、最大 attempt 和幂等键 |
| `job_attempts` | 每次完整执行的起止、错误、worker 和 artifact |
| `outbox_events` | 事务内待投递事件 |
| `business_events` | 面向产品进度和审计的稳定事件 |
| `ai_runs` | provider、模型、token、成本、输入版本和输出状态 |
| `agent_tool_calls` | 工具、脱敏参数、耗时、错误和状态变化 |

---

## 6. 状态机与版本门禁

状态迁移全部由 `domain` 中的显式命令处理。API 路由、Worker handler 和 Agent 工具不能直接写
任意状态值。

### 6.1 共享书籍

```text
uploaded -> fingerprinting -> queued -> normalizing -> validating
         -> indexing -> analyzing -> ready

normalizing | validating | indexing | analyzing -> failed
failed -> queued
```

`uploaded` 和 `fingerprinting` 是由 `source_uploads` 投影出的用户可见阶段；只有计算出可信 SHA-256
后才创建或复用 `shared_books`，其持久化处理状态从 `queued` 开始。API 对外仍可返回 PRD 定义的
完整进度链。

进入下一状态时保存阶段完成产物。重试创建新 run/job/attempt，不覆盖失败 attempt。

### 6.2 用户书籍

```text
on_shelf -> interviewing -> strategy_review -> trial_generating
         -> trial_review -> active_reading

trial_generating -> trial_generation_failed -> trial_generating
```

`deleted_at` 覆盖主状态但不改写它，恢复后回到删除前状态。任何状态依赖的后台 job 若已失效，
恢复时重新创建；不能把旧的 cancelled job 直接恢复为成功。

### 6.3 Job 与 attempt

```text
job: pending -> queued -> running -> succeeded
                              \-> retry_wait -> queued
                              \-> failed
                              \-> cancelled

attempt: running -> succeeded | failed | abandoned
```

一个 job 最多三个 attempt。Worker 进程退出、E2B 中断、模型连接中断或工具未完成均结束当前
attempt；下次从源输入、数据库版本和全新工作区完整重跑，不恢复 Pi Agent 的内存 session。

### 6.4 发布门禁

每个 AI 或异步结果都保存输入快照：

- 目标对象 id 和当前数据库 version
- package、manifest 和 tailoring eligibility 版本
- reader profile、book reader profile 版本
- strategy draft 或正式 strategy 版本
- trial revision 或 strategy proposal 版本
- prompt、schema、算法和模型配置版本

发布事务重新读取当前指针并逐项比较。任何不一致都把结果标记为 `stale` 或 `superseded`，
保留 artifact 但不改变当前状态，也不发送“完成”事件。

---

## 7. 异步任务与幂等实现

### 7.1 Transactional outbox

API 在同一 PostgreSQL 事务中：

1. 校验状态和 expected version。
2. 写业务变更。
3. 以唯一 `idempotency_key` 创建或复用 job。
4. 写入 outbox event。

独立 dispatcher 读取未投递 outbox，以 `job.id` 作为 BullMQ `jobId` 投递。投递成功后记录时间。
dispatcher 崩溃可能造成重复投递，因此 Worker 仍必须依赖数据库幂等。

### 7.2 Worker 领取

Worker 收到消息后：

1. 按 job id 读取数据库。
2. 如果 job 已成功、失败、取消或输入过期，直接 ACK。
3. 使用条件更新把 job 从 `queued/retry_wait` 改为 `running` 并创建 attempt。
4. 装配本次不可变输入快照和隔离工作区。
5. 执行 handler。
6. 在事务中重新执行发布门禁并提交结果。

BullMQ 的锁是投递层优化，数据库条件更新才是并发领取门禁。

### 7.3 失败分类

- `retryable_external`：模型、E2B、对象存储或网络暂时错误。
- `retryable_internal`：Worker 崩溃、超时或可恢复内部错误。
- `invalid_input`：DRM、损坏 EPUB、契约不支持；完整重跑仍保留三次上限，但可以提前确定失败。
- `validation_failed`：Agent 产物未通过确定性门禁。
- `stale_input`：业务版本变化，不计作用户可见失败，不继续重试旧任务。
- `cancelled`：用户删除、上游 revision 失效或管理员取消。

attempt 的退避由 BullMQ 配置，业务最大次数由数据库控制。第三次失败后 job 进入 `failed`。

### 7.4 优先级

从高到低：

1. 用户跳转目标节点和当前节点生成
2. 试读三个片段和策略调整预览
3. 后续三个节点预生成
4. 新书规范化和分析
5. 清理、索引重建等维护任务

不同后台任务类型使用独立 BullMQ queue 和并发限制。交互式 Agent 不进入这些队列，由 API
使用独立 semaphore/rate limit 控制并发，避免后台规范化影响用户对话。

---

## 8. EPUB 上传到 Ready 的详细实现

### 8.1 上传与复用

1. API 校验扩展名、MIME、大小上限和用户配额。
2. 请求体流式写入临时对象，同时计算 SHA-256；不把整本 EPUB 放入内存。
3. 事务内按 SHA-256 查询或创建 `shared_books`。
4. 已有 `ready` package 时复用；已有活动 run 时关联该 run；否则创建 normalization job。
5. 用户书籍立即关联 shared book，并根据共享状态展示进度。

初期通过 API 流式上传以保证哈希和权限实现简单。未来改为对象存储 multipart direct upload 时，
必须由后台重新读取对象计算可信哈希，不能接受客户端声明的哈希。

### 8.2 规范化 Agent attempt

每次 attempt：

1. 创建全新 E2B sandbox 和宿主 attempt 目录。
2. 将源 EPUB、只读规范、校验工具和必要运行依赖准备到工作区。
3. Worker 内创建新的 Pi `Agent`，配置 sequential tool execution。
4. Agent 通过受限读工具检查 EPUB，只能写/patch `normalize.py`。
5. `run_normalizer` 以固定参数在 E2B 中运行脚本，Agent 没有任意 shell。
6. `validate_normalized_book` 执行结构和保真检查并返回结构化错误。
7. Agent 根据错误迭代，直到调用 `finish_normalization` 或达到 turn/时间/成本上限。
8. 宿主再次独立运行全部门禁，不信任 Agent 的完成声明。

沙箱必须禁网，只接收当前任务文件；Pi SDK、数据库和密钥均不进入 sandbox。如果 E2B 当前产品
能力不能可靠执行网络隔离，则它只能用于开发验证，生产前必须增加可验证的隔离措施或替换实现。

### 8.3 Indexing 与书籍分析

规范化通过后，确定性程序：

1. 生成完整 `reading_manifest.json`。
2. 执行 block v1 枚举、标准文本和 UTF-16 映射检查。
3. 校验 manifest outline、裁读资格和 node 顺序。
4. 校验 HTML 中每个 `assets/...` 引用安全且文件存在。
5. 可选生成按节点切分的只读派生 fragment/index，供阅读 API 高效读取。

fragment/index 是可重建缓存，`book.normalized.html` 和 manifest 仍是事实来源。

随后书籍分析 Agent 只读规范化内容和 manifest，输出 `book_profile.json`。程序校验 schema、候选
节点存在、裁读资格和原文复制上限。

### 8.4 原子发布

对象存储没有通用的原子目录 rename，因此发布边界是数据库事务：

1. 所有文件写到不可变 `packages/{package_version}/` 前缀。
2. 逐文件校验哈希、大小和必需文件。
3. 写 package manifest，记录所有对象及其 hash。
4. 数据库事务创建 `book_packages`，把 `shared_books.current_package_id` 指向它并改为 `ready`。
5. 事务提交后发送 ready 业务事件。

任何客户端只能读取数据库当前指向的 package，不根据对象前缀猜测“最新版本”。

建议对象 key：

```text
uploads/{upload_id}/source.epub
normalization/{run_id}/attempts/{attempt_no}/...
books/{epub_sha256}/packages/{package_version}/book.normalized.html
books/{epub_sha256}/packages/{package_version}/reading_manifest.json
books/{epub_sha256}/packages/{package_version}/book_profile.json
books/{epub_sha256}/packages/{package_version}/assets/...
```

---

## 9. 个性化、试读和正式阅读流程

### 9.1 访谈与策略草稿

每次用户回答通过 API 幂等保存。API 获取当前逻辑会话的执行锁，在请求进程内创建 Pi Agent，
读取当前 session snapshot、已提交答案、画像版本和 book profile，并直接运行本轮。Agent 产生
的下一题、本书画像或策略草稿先通过 schema 和状态门禁，再以新版本提交。最多 7 问和累计
5 次反馈由数据库计数与唯一约束保证，不依赖 prompt。

交互式 Agent 不恢复 JavaScript 调用栈。数据库保存用户和 assistant 的产品化消息、结构化业务
产物及当前阶段；session cache 命中时从缓存构造新 Agent，未命中时从数据库重建。

策略反馈和试读反馈使用持久化 strategy revision operation。HTTP/SSE 只负责转发临时事件，最终草稿、
调整次数和 current pointer 在持有有效 lease/attempt 的单一事务中提交。连接断开后客户端查询
operation 和精确 draft snapshot，不重新创建命令。

### 9.2 试读 revision

用户第一次确认策略草稿后，事务内：

1. 创建或复用 trial selection operation，Agent 在三个候选阅读节点内流式返回精确 fragment。
2. 每个闭合 fragment 经范围校验后可作为 provisional 原文显示，但不提前修改业务 pointer。
3. 三个 fragment 全部合法后，最终事务将草稿标记为 approved-for-trial，创建新的
   `trial_revision`、三个 segment 和生成 job，并切换 current pointer。

三个任务可以并行执行。单段 ready 后 API 和 Web 立即暴露该段完整结果；只有全部成功且版本门禁
一致时，事务才发布 revision 并开放反馈/采用。任一任务耗尽重试后整轮 failed，但保留原文和已完成
段。技术 retry 精确复制 failed revision 的三个 segment 创建新 revision，不重新选段。

### 9.3 正式采用

用户查看三个片段并最终确认时，API 在一个事务中：

- 校验三个片段均已查看。
- 校验 trial revision 和 strategy draft 均为当前版本。
- 创建不可变正式 strategy version。
- 把用户书籍状态改为 `active_reading`。
- 创建第一个正式节点及后续三个可裁读节点的生成 job。

重复提交使用同一 idempotency key，只能得到同一个正式 strategy version。

### 9.4 正式节点生成

试读和正式阅读使用同一生成器。差异只在 `generation_scope`、原文范围和允许的策略版本。
输出经过 TypeBox schema、Markdown 安全规则、quote 唯一匹配和 UTF-16 range 校验。

节点失败时原文仍可读。用户跳转时，API 确保目标节点任务存在并提高优先级；Worker 保持当前
节点及后三个可裁读节点处于 ready 或 generating。已读节点固定记录当时使用的策略版本。

### 9.5 正式阅读中的策略调整

问 AI Agent 只能创建 proposal。候选策略和完整节点预览写入独立 namespace，不覆盖正式结果。
采用时使用单一事务：创建新 strategy version、提升预览节点结果、把未读旧结果标记 stale、
创建新的预生成任务。任何一步失败均保持旧策略完整生效。

---

## 10. 阅读器技术设计

### 10.1 内容获取

阅读 API 按 `section_id + segment` 返回：

- 经过服务端再次安全检查的原文 fragment
- block 元数据和标准文本 hash
- 当前用户可见的节点增强版本
- 原书注释索引
- manifest 位置和相邻节点

媒体通过稳定受权路由或短期签名 URL 加载。HTML 中继续保留逻辑 `assets/...`，响应阶段再解析，
不修改不可变 package。

### 10.2 连续滚动与窗口

Web 只保留当前节点前后有限窗口，使用 IntersectionObserver 判断当前节点和有效停留。向前或
向后接近窗口边界时加载相邻节点，同时以固定占位高度和 scroll anchoring 避免内容跳动。

窗口算法和缓存参数配置化，但必须满足：

- 任意目录跳转可定位到 manifest node。
- AI 内容迟到不能改变原文位置模型。
- 卸载远端节点后重新加载能恢复阅读位置。
- 纯原文先于增强内容展示。

### 10.3 Block 与 Range

`reader-core` 实现唯一版本的 block v1 和 UTF-16 range 算法，构建期或测试期同时运行在 Node 和
浏览器环境，使用契约 fixture 验证一致结果。前端把 DOM selection 转成 manifest range；服务端
再次校验节点、block、offset 和选中文本 hash 后保存。

### 10.4 进度同步

客户端周期性、页面隐藏和节点切换时上报稳定位置：

```text
section_id + segment + block_index + offset + client_observed_at
```

API 使用 idempotency key 和版本规则合并。明显过期的客户端事件不覆盖更新位置；用户主动目录
跳转可以更新当前位置，但“已读”必须满足 PRD 的有效停留/到达规则。

---

## 11. HTTP、SSE 与错误契约

### 11.1 API 形式

- REST JSON 用于资源查询和业务命令。
- 大文件上传使用流式 multipart。
- 访谈、阅读准备命令和问 AI 的 POST 请求使用流式 HTTP/SSE 响应，用户可见增量由 API 直接写回浏览器。
- 每个交互流最后发送 typed completion event，携带经过 schema 和业务门禁校验的最终产物。
- SSE 用于 job 和用户书籍等后台业务事件。
- 媒体使用受控二进制路由或签名 URL。

路由按领域组织：

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
/v1/jobs/:id
/v1/events
```

### 11.2 命令请求

会创建版本、任务或副作用的请求必须包含：

- `Idempotency-Key`
- body 中的 `expected_version` 或资源 ETag
- request id

成功响应返回稳定 resource/job id 和新的 version。版本冲突返回 `409 conflict` 与当前资源摘要，
客户端刷新当前状态，不静默覆盖。

阅读准备命令当前把 `idempotencyKey` 放在 TypeBox body contract 中，并额外保存 request hash。收到
`operationId` 后，网络重连、重复传输和 resume 均复用同一 operation，不重新生成键。

### 11.3 错误结构

```json
{
  "error": {
    "code": "STALE_VERSION",
    "message": "内容已在其他页面更新",
    "request_id": "...",
    "details": {}
  }
}
```

用户可见 message 使用稳定产品文案；内部 provider 错误和堆栈只进入脱敏日志。

### 11.4 SSE

后台业务事件先持久化到 `business_events`，SSE 按用户权限读取并映射。事件包含递增 id、类型、资源
id、资源 version 和产品化 payload。客户端使用 `Last-Event-ID` 断线续传；无法补齐时重新查询
资源快照。SSE 不是业务事实来源，也不传输模型思维过程或内部工具日志。

交互式 Agent 和阅读准备的 token/文本/fragment 增量不写入 `business_events`，而是由处理该请求的
API 实例直接返回。完整结构化产物只在通过发布门禁后写入 PostgreSQL。阅读准备连接中断不取消已
取得 lease 的 operation；客户端进入 recovering，通过 operation 终态和精确版本快照恢复。

API 只转发产品允许展示的 assistant text delta，不转发模型推理、原始工具参数或内部事件。
访谈流结束时发送 `interview.question.completed`、`interview.strategy.completed` 等结构化事件；
问 AI 流结束时发送 `qa.answer.completed`。前端以 completion event 为本轮可提交结果。

---

## 12. Agent 与模型运行规范

### 12.1 Pi Agent

- 每个后台 attempt 创建新的 core `Agent`。
- 每个交互 turn 也创建新的 core `Agent`，其 messages 来自 session cache 或数据库重建结果。
- `sessionId` 只用于 provider cache/关联，不视为持久化执行状态。
- 工具顺序默认为 `sequential`。
- `beforeToolCall` 校验 Agent 类型、资源归属、业务状态、版本和调用配额。
- `afterToolCall` 脱敏、截断、记录审计和识别完成条件。
- 工具失败抛出明确错误；不能以普通成功文本掩盖失败。

### 12.2 交互式 Session Cache

`SessionCache` 位于 API 进程内，首版使用有容量上限的 LRU + TTL。它是读取优化，不是分布式
session store，也不要求负载均衡粘性。

缓存 key：

```text
agent_type + logical_session_id
```

缓存 entry 至少包含：

- 对应数据库 `conversation_version`
- 可序列化的 Pi messages
- 已生成的上下文压缩摘要及其版本
- 最近一次使用时间和估算内存大小

不缓存 live Agent 实例、数据库连接、工具闭包、HTTP stream、运行中的 tool call、密钥或整本书
内容。每轮仍重新装配模型和工具，避免缓存对象绑定过期权限或业务版本。

读取规则：

1. API 获取该逻辑会话的数据库执行锁并读取稳定版本 `V`。
2. 只有缓存 entry 的 `conversation_version = V` 时才命中；否则从数据库产品消息和结构化状态
   重建 snapshot。
3. 以 `expected_version = V` 保存用户消息，数据库推进到 `V+1`，同时把消息追加到 snapshot。
4. Agent 完成本轮后，以 `expected_version = V+1` 保存回复和业务产物。
5. 最终事务提交后，使用新的稳定 conversation version 更新缓存。
6. 请求失败、事务回滚、其他实例推进版本或用户删除会话时，旧 entry 直接失效。

API 重启或请求落到其他副本只会造成 cache miss，不影响正确性。只有监控证明数据库重建成本或
多副本命中率成为瓶颈时，才考虑增加 Redis 二级 snapshot cache。

### 12.3 交互式执行与并发

同一逻辑会话同时只能有一个 active turn。访谈使用带过期时间的 turn lease 和 conversation version；
策略反馈、试读反馈和试读选段使用 reading setup operation lease、attempt fencing 和每本书一个 active
operation 约束。API 进程崩溃后，新请求只能在 lease 过期后接管新 attempt，旧 attempt 不能提交结果。

交互式 Agent 不做后台三次完整重跑。provider 的瞬时连接错误可以在当前请求内有限重试；本轮
仍失败时保留用户消息和明确错误状态，由用户重试。需要长时间生成的试读、节点内容和策略
预览仍创建后台 job。

### 12.4 Provider 适配

`ModelProvider` 接口统一普通生成和 Pi 所需模型对象。配置支持全局默认和按功能覆盖，至少记录：

- provider/base URL 标识
- model id 和模型配置版本
- timeout、max output、最大 turn 和成本限制
- prompt/schema version

业务代码不得依赖 DeepSeek、OpenAI 或其他 provider 的私有请求格式。确需 provider 特性的能力
在适配层显式声明 capability，不能静默降级。

### 12.5 输出处理

AI 自然语言不能直接写数据库状态。所有结构化输出依次经过：

1. JSON/schema 解析。
2. 领域不变量检查。
3. 引用资源、节点和 range 检查。
4. 输入版本门禁。
5. 安全渲染和长度限制。
6. 事务发布。

---

## 13. 安全、认证与隐私

### 13.1 认证

使用服务端 httpOnly、secure、sameSite cookie session。API 执行 CSRF 防护、登录频率限制和 session
撤销。登录 provider 经适配器接入：

- 大陆可用方式：邮箱验证码/magic link，正式供应商待选。
- 可选方式：Google OAuth。

因此需要同步修订 PRD 中“只能通过 Google OAuth 登录”的要求；在修订前不得把 Google-only
实现视为最终验收目标。

### 13.2 授权

- 每次查询按 `user_id` 约束，不接受客户端提供的 user id 作为授权依据。
- shared book 可跨用户复用，但访问 package 仍需验证用户拥有该 user-book 或管理权限。
- Agent 工具由宿主注入已绑定的资源 id，不允许模型任意选择用户或绝对路径。

### 13.3 EPUB 和 HTML

- 上传限制大小、压缩比、文件数量和解压后总量，防止 zip bomb 和路径穿越。
- E2B 中规范化脚本禁网、限时、限 CPU/内存/磁盘。
- 清除脚本、事件属性、iframe、object、危险 URL 和不受控样式。
- AI Markdown 使用 allowlist renderer，禁止原始 HTML。
- 媒体响应使用正确 Content-Type、CSP 和 `nosniff`。

### 13.4 数据最小化

日志不保存密钥、OAuth token、完整宿主路径或不必要的整本原文。发送给模型的原文按任务范围
截取；图片移除真实 src/base64。大型 prompt/response 若为诊断必须保存，则加密存储、限制访问
并设置保留期。

---

## 14. 部署拓扑

### 14.1 环境

- `local`：Docker Compose 启动 PostgreSQL、Redis 和 MinIO；模型和 E2B 可使用真实测试账号或 fake。
- `staging`：与生产相同容器和迁移流程，使用隔离数据库、bucket、Redis 和 provider key。
- `production`：中国大陆区域部署 Web、API、Worker 和主要数据服务；境外服务由 API/Worker
  的受控出口访问。

### 14.2 生产组件

```text
Domestic CDN / ingress
  -> Web assets
  -> API replicas

API/Worker private network
  -> managed PostgreSQL
  -> managed Redis
  -> object storage
  -> controlled outbound gateway
       -> E2B
       -> model providers
       -> optional Google OAuth endpoints
```

API 和 Worker 使用同一镜像版本但不同启动命令、权限和伸缩策略。normalization、content 等
Worker 可以从同一代码库启动为不同进程，分别设置 queue 和并发。API 独立设置交互式 Agent
并发、请求超时和 session cache 内存上限。数据库迁移作为一次性发布步骤运行，应用启动时不
自动执行破坏性迁移。

### 14.3 可移植接口

- `ObjectStorage`：put/get/head/delete/list、multipart 和 signed URL。
- `CodeSandbox`：create、upload、runFixedCommand、download、destroy。
- `ModelProvider`：model factory、capabilities、usage 和错误映射。
- `EmailAuthProvider`：send code/link、verify 和限流标识。

PostgreSQL 和 Redis 虽然 API 基本可移植，仍通过标准连接和迁移管理，避免使用某个云厂商的
专有 serverless 限制作为核心假设。

### 14.4 备份与灾难恢复

- PostgreSQL 开启 PITR，并定期验证恢复。
- 发布 package 不可变，开启对象版本或跨可用区冗余。
- Redis 不作为事实来源，不要求从 Redis 备份恢复业务。
- 定期任务扫描 `running` 超时 job、未投递 outbox 和无引用 staging artifact。

---

## 15. 可观测性与运行限制

所有请求、job、attempt、AI run、tool call 和 business event 使用可关联 id。至少提供：

- HTTP 成功率、延迟、上传大小和错误码
- queue depth、等待时间、attempt 数、stalled 和失败率
- 各 Agent turn/tool 数、耗时、token、成本和停止原因
- E2B 创建/执行/下载耗时与错误分类
- normalization 各门禁通过率和失败规则分布
- 节点生成命中率、过期结果率和锚点失败率
- SSE 连接数、重连和事件积压
- reading setup operation 时长/失败率、lease renew/reclaim/lost、attempt 和 resume
- 首个策略增量、首个 fragment、单段 ready 和 3/3 published 延迟

配置化限制至少包括上传大小、解压大小、Agent turn/时间/成本、模型输出、工具输出、并发、重试、
日志截断和用户速率限制。达到限制必须产生明确停止原因，不能无限运行。

---

## 16. 测试策略

### 16.1 单元与契约测试

- 状态机所有允许和禁止迁移
- 版本门禁、幂等键和缓存键
- TypeBox schema 和错误映射
- manifest、block v1、UTF-16 range 和 quote 匹配
- 对象 key、路径安全和 package manifest
- Agent 工具 preflight 与 result hook
- session cache 的命中、TTL/LRU 淘汰、版本失效和数据库重建

### 16.2 集成测试

使用真实 PostgreSQL、Redis 和 MinIO 验证：

- API 事务与 outbox 不丢任务
- 访谈和问 AI 均不经过 BullMQ，且能从当前 API 请求直接流式输出
- 多标签页并发 turn 只有一个能按 expected version 提交
- 重复 BullMQ 消息不重复发布
- Worker 崩溃后新 attempt 完整重跑
- 第三次失败后稳定进入 failed
- 版本变化后旧结果成为 stale
- package 在数据库切换前不可见

E2B 和模型均提供 fake adapter；staging 另有少量真实 provider smoke test。

### 16.3 书籍 golden tests

维护一组覆盖中英文、复杂目录、脚注、图片、表格、列表、诗歌和异常 EPUB 的脱敏/可授权 fixture。
每本书保存预期 nb_check、manifest、block 和资源结果。算法版本变化必须显式更新 fixture 和迁移说明。

### 16.4 Agent 评测

Agent 测试不只断言自然语言：

- 规范化以确定性校验结果、资源守恒和最大迭代限制验收。
- 书籍分析以 schema、候选合法性和原文复制限制验收。
- 访谈以问题数量、状态门禁和版本产物验收。
- 问 AI 以工具权限、检索范围和 proposal 不直接生效验收。

### 16.5 浏览器端到端

Playwright 覆盖 PRD 主链路、多标签页版本冲突、刷新恢复、上传进度、试读失败、纯原文降级、
连续滚动、目录跳转、划线笔记、问 AI、删除恢复和移动端布局。阅读器还需使用真实长书 fixture
检查滚动位置、延迟增强内容和图片加载不会造成不可接受的布局跳动。

---

## 17. 分阶段实施与完成条件

阶段划分用于控制开发顺序，不降低最终产品标准。每个阶段交付永久模块、自动测试和文档，
通过后再组装下一阶段；最终验收仍以完整 PRD 为准。

### 阶段 0：技术方案确认

- 本文的系统边界、数据模型、状态机、部署边界和实施顺序获得确认。
- 修订 Google-only 登录与大陆可用性冲突。
- 明确所有剩余待定项的最迟决策阶段。

### 阶段 1：工程与基础设施骨架

- monorepo、TypeScript、lint、format、test、build 和 CI 可运行。
- Web、API、Worker 有独立入口和 health/readiness check。
- 本地 PostgreSQL、Redis、MinIO 一键启动。
- migration、config、secret 和结构化日志规范建立。
- 测试 job 完成 API -> outbox -> BullMQ -> Worker -> PostgreSQL 往返且重复投递幂等。
- 测试交互请求完成 API -> Pi fake provider -> direct stream -> PostgreSQL 往返，并验证 session
  cache 命中、版本失效和进程重启后重建。

### 阶段 2：书籍与阅读位置内核

- 把现有 Python 校验工具作为外部契约接入测试，不急于重写已验证逻辑。
- 完成 manifest v0.2 已知缺失字段、包级资源校验和 golden fixtures。
- 实现 TypeScript `reader-core` 的 block/range 算法并与 Python/fixture 对账。
- 定义不可变 package、对象 key 和原子发布实现。

### 阶段 3：EPUB 到 Ready 流水线

- 完成上传、SHA-256 复用、共享状态和进度事件。
- 完成 E2B adapter、Pi 规范化 Agent、三次完整重跑和确定性门禁。
- 完成 indexing、book analysis 和原子发布。
- 使用多本代表性 EPUB 验证成功、失败、重复上传和 Worker 崩溃路径。

### 阶段 4：账户、书架与个性化流程

- 完成大陆可用登录、初始画像、预置书和书架。
- 完成 API 内直跑的访谈 Agent、session cache、画像版本、策略草稿、两次确认、累计反馈上限和
  刷新恢复。
- 完成试读选择、同一内容生成器、整轮发布和过期 revision 隔离。

### 阶段 5：成熟阅读器

- 完成连续滚动、目录跳转、节点窗口、纯原文优先和后续三个节点预生成。
- 完成导读、裁读注、原书注、助读的分层展示。
- 完成进度、已读、划线、笔记、跨设备恢复和阅读设置。
- 对长书、移动端、弱网和增强内容迟到执行性能与视觉验收。

### 阶段 6：问 AI 与正式策略调整

- 完成 API 内直跑的问 AI、直接流式响应、划线/屏幕上下文、每问题独立会话和全书按需检索。
- 完成长期画像更新提示。
- 完成 proposal -> 完整节点预览 -> 用户采用的原子策略升级流程。
- 验证拒绝、失败、版本冲突均不改变当前正式阅读内容。

### 阶段 7：生产加固与最终验收

- 完成安全、配额、成本、可观测性、备份恢复和数据清理。
- 在 staging 执行真实 E2B/模型、跨境故障和容量测试。
- 跑完 PRD 页面级、Agent、数据契约和端到端验收清单。
- 处理所有阻断问题后才进入正式发布。

---

## 18. 待确认与最迟决策点

| 决策 | 当前建议 | 最迟确认阶段 |
|---|---|---|
| 大陆主登录方式 | 邮箱验证码/magic link，Google 可选 | 阶段 4 前 |
| Web 状态/组件库 | 在阶段 1 根据现有设计方向选择 | 阶段 1 |
| 国内云厂商 | 保持 provider-neutral，部署前选择 | 阶段 7 前 |
| 生产沙箱 | 先用 E2B，保留替换接口 | 阶段 7 前 |
| 默认模型组合 | 按 Agent/生成任务评测后选择 | 阶段 3/4 |
| 全书搜索 | PostgreSQL FTS 起步，质量不足再加向量检索 | 阶段 6 |
| 原文 fragment 缓存 | 索引期生成可重建派生文件 | 阶段 2 |
| 日志与指标平台 | 使用 OpenTelemetry/Pino 可导出格式后再选平台 | 阶段 7 前 |

除登录冲突外，上述决定不阻塞技术方案确认和阶段 1。任何后续决定都不得破坏本文定义的事实
来源、版本门禁、不可变书籍包、Agent 权限和完整重跑原则。
