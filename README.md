# ReadTailor（裁读）

ReadTailor 是一个面向中文 EPUB 的个性化网页陪读产品。它先了解用户阅读某本书的目的、背景和阻碍，再生成本书专属的处理方式，并把导读、裁读注、节后助读和问 AI 作为原文之外的辅助层提供给读者。

产品的目标不是替用户摘要一本书，而是在不修改原文的前提下降低理解阻力，让用户更容易开始并持续读完一本原本难以读下去的书。

当前仓库已经包含可运行的 Web、API、Worker、数据库模型、EPUB 规范化工具和核心产品闭环。当前部署目标是少量用户自用版本，不是面向公众的大规模生产平台。

## 产品闭环

```text
注册 / 登录
  -> 完成长期阅读画像
  -> 从书架打开预置书，或上传中文 EPUB
  -> 完成本书访谈
  -> 查看读前简报和个性化处理方式
  -> 确认处理方式并生成三个试读片段
  -> 查看试读并最终采用
  -> 阅读原文与个性化辅助内容
  -> 划线、记录笔记或结合当前屏幕向 AI 提问
  -> 查看阅读统计，并在刷新或跨设备后恢复进度
```

核心原则：

- **原文不可变**：规范化 HTML 是原书事实来源，AI 内容、划线、笔记和问答均独立保存。
- **先理解用户，再生成内容**：长期画像不能代替每本书独立的访谈。
- **两次明确确认**：先确认文字处理方式，再查看试读并最终采用；系统不能替用户完成确认。
- **AI 失败不阻断阅读**：增强内容生成失败或尚未完成时，原文仍然可读。
- **程序保证正确性**：文件哈希、阅读位置、block、权限、状态迁移和发布校验由确定性程序负责。

## 当前功能

### 账户与画像

- 邮箱密码注册、登录和退出。
- 服务端数据库 session 与 httpOnly cookie，不把正式会话放在浏览器本地存储。
- 注册后固定问卷生成长期阅读画像。
- 后端已实现 Google OAuth 流程和身份存储。
- 本地开发可显式开启开发用户登录。
- 完成画像时，可将已标记为预置且已发布的书籍自动加入新用户书架。

### 书架与 EPUB 导入

- 展示用户书架、处理状态和阅读工作流状态。
- 上传最大 100 MB 的 EPUB 文件。
- 按源 EPUB SHA-256 复用共享书籍，避免相同文件重复规范化。
- 展示上传、指纹计算、排队、规范化、校验和发布进度。
- 处理失败后复用原始上传文件重新排队，无需再次上传。
- 通过文件系统或 S3 兼容对象存储保存源文件和不可变书籍包。

### 个性化处理流程

- 每本书独立访谈，回答通过 SSE 流式返回后续问题和选项。
- 基于长期画像、本书访谈和书籍画像生成读前简报与处理方式。
- 用户可以反馈并修订处理方式，确认后才进入试读生成。
- 为三个互不重叠的代表性片段生成试读内容。
- 三个片段全部就绪后统一发布，避免用户看到半成品试读。
- 用户查看试读、提交反馈并最终采用后，正式策略才生效。

### 阅读器

- 连续滚动阅读，支持目录和阅读节点导航。
- 在同一阅读流中展示原文、导读、裁读注和节后助读。
- 保存阅读焦点、已读节点和个人阅读设置。
- 通过稳定阅读位置恢复刷新前或其他设备上的阅读进度。
- 支持跨 block 划线、为划线记录一条笔记、编辑或删除笔记。
- 删除笔记保留划线；删除划线同时删除其当前笔记。
- 原书注与裁读注使用独立附加层，不改写规范化正文。

### 问 AI 与策略调整

- 可从划线原文或当前屏幕上下文发起问题。
- 支持追问、历史会话和 SSE 流式回答。
- 问答会保存原文 range 快照，不依赖后续仍然存在的划线记录。
- AI 可以基于明确证据更新长期画像，并向前端返回更新提示。
- AI 只能提出处理方式调整建议；必须经过用户确认才会创建新正式策略。

### 阅读统计

- 正式阅读器通过 heartbeat 和活动 slice 记录有效阅读活动。
- 提供个人总览、按日统计和按书统计。
- 只有正式阅读器内的有效活动计入阅读时长，书架、试读和统计页不计入。
- 阅读速度只使用正常、连续、向前阅读原文的有效样本。

## 技术架构

ReadTailor 是一个 pnpm monorepo，运行时由三个独立进程组成：

```mermaid
flowchart LR
    U["浏览器"] --> W["Web<br/>React + Vite"]
    W -->|"REST / SSE<br/>cookie session"| A["API<br/>Fastify"]
    A --> P[("PostgreSQL")]
    A --> O["对象存储<br/>Local FS / S3"]
    A --> R[("Redis / BullMQ")]
    A --> M["OpenAI-compatible<br/>模型服务"]
    R --> K["Worker"]
    K --> P
    K --> O
    K --> M
    K --> S["远程 Sandbox<br/>E2B / PPIO"]
    S --> T["Python 规范化与校验工具"]
```

### 运行组件

| 组件 | 职责 | 默认端口 |
| --- | --- | --- |
| Web | 登录、书架、上传、访谈、策略、试读、阅读器和统计界面 | `5173` |
| API | 认证、业务状态机、读写接口、SSE 流、上传入口和任务入队 | `3001` |
| Worker | 系统任务、EPUB 规范化、书籍分析和个性化内容生成 | `3002` |
| PostgreSQL | 用户、身份、书籍、策略、生成结果、阅读状态、问答和统计 | 外部服务 |
| Redis / BullMQ | 规范化与内容生成任务队列 | 外部服务 |
| 对象存储 | 源 EPUB、规范化 HTML、manifest、assets、书籍画像和校验报告 | 文件系统或 S3 |

API 和 Worker 共享数据库、Redis 和对象存储，但职责不同：API 负责同步业务规则、鉴权和入队；Worker 负责耗时、可重试的后台工作。远程 sandbox 只参与 EPUB 规范化，不接触数据库、对象存储凭据或模型密钥。

### 技术栈

| 层 | 主要技术 |
| --- | --- |
| Web | React 19、React Router 7、TanStack Query 5、Vite 6、TypeScript |
| API | Fastify 5、TypeBox、Pino、SSE、httpOnly cookie session |
| Worker | BullMQ、Pi Agent SDK、E2B / PPIO sandbox、Python 工具链 |
| 数据 | PostgreSQL、Drizzle ORM / Drizzle Kit |
| 存储 | 本地文件系统适配器、AWS SDK S3 兼容适配器 |
| 模型 | OpenAI-compatible chat completions，可按功能覆盖端点、密钥和模型 |
| 测试 | Vitest、happy-dom、Python unittest |
| CI | GitHub Actions、Node.js 24、pnpm 10、Python 3.12 |

## 核心数据边界

### 用户、共享书籍、用户书籍

系统把书籍分成三层，避免把共享内容与个人状态混在一起：

```text
user
  └── user_book                  某个用户书架中的一本书
        ├── 本书访谈与本书画像
        ├── 策略草稿、正式策略和试读版本
        ├── 个性化节点生成结果
        ├── 阅读位置、设置、划线笔记与统计
        └── 问 AI 会话和策略调整建议

shared_book                     按 EPUB SHA-256 复用的共享书籍
  └── immutable book_package    不可变规范化产物
        ├── book.normalized.html
        ├── reading_manifest.json
        ├── book_profile.json
        ├── validation_report.*
        └── assets/**
```

同一 EPUB 可以被多个用户复用同一个 `shared_book` 和不可变 package，但每个用户拥有独立的 `user_book`、策略、生成内容和阅读数据。

### 阅读位置契约

阅读节点使用 `section_id + segment` 标识；节点内范围使用 `block_index + UTF-16 offset`。这个坐标系同时服务于：

- 阅读进度与恢复；
- 试读片段定位；
- 裁读注锚点；
- 用户划线和笔记；
- 问 AI 的原文快照；
- 阅读速度与统计计算。

已有 package 固定 manifest 和 block 算法版本。改变算法时必须创建显式版本或迁移，不能静默重建已有位置。

## EPUB 处理流水线

用户上传 EPUB 后，正式处理流程如下：

```text
上传 EPUB
  -> 计算 SHA-256 并检查共享书籍复用
  -> 源文件不可变写入对象存储
  -> API 创建 normalization run 并写入 BullMQ
  -> Worker 为 attempt 创建全新 Agent session 和远程 sandbox
  -> Agent 编写 / 修订 normalize.py
  -> 固定工具生成规范化 HTML、assets 和 validation report
  -> 完整 nb-1.0 校验达到 0 blocking error
  -> Worker 下载候选产物并独立重跑校验
  -> 确定性生成 reading_manifest.json
  -> 只读 Book Analysis Agent 生成 book_profile.json
  -> 按对象回读并校验 SHA-256
  -> 数据库事务发布不可变 package，并将 shared_book 切换为 ready
```

一个自动 attempt 使用独立 sandbox；同一 attempt 内可以多轮修改脚本并复用 sandbox。Agent 只能读取当前源书与规范、修改规范化脚本、运行固定命令并检查输出。发布动作始终由 Worker 完成。

Worker 支持三个队列：

- `system`：基础异步任务与链路检查。
- `normalization`：远程 sandbox 中的 EPUB 规范化和书籍分析。
- `content-generation`：试读及正式阅读节点的个性化内容生成。

可以通过 `WORKER_QUEUES` 拆分专用 Worker 池，例如只运行 `content-generation`。规范化默认低并发，内容生成默认并发为 5。

## 仓库结构

```text
apps/
  web/                React Web 应用
  api/                Fastify API、认证和业务服务
  worker/             BullMQ consumers、规范化与内容生成

packages/
  agent-kit/          Pi Agent SDK 封装
  config/             环境变量和模型端点配置
  contracts/          前后端共享 schema 与业务契约
  database/           Drizzle schema、migration 和数据库连接
  model/              OpenAI-compatible / fake model engine
  normalized-book/    书籍包发布和候选产物校验
  observability/      日志、HTTP 与 Agent 调用记录
  queue/              BullMQ queue / worker 封装
  storage/            文件系统与 S3 对象存储适配器
  tailoring/          阅读节点裁读内容处理

docs/                 产品、数据契约、Agent 和架构文档
design/               设计系统、UI kits 和交互原型
tools/                EPUB 规范化、manifest 构建和校验工具
tests/                Python 工具与阅读契约测试
fixtures/             开发用 EPUB 和预置书籍样例
```

## 本地开发

### 前置条件

- Node.js `24.x`（仓库提供 `.nvmrc`）
- pnpm `10.13.1`
- Python `3.12` 或兼容的 Python 3 环境
- PostgreSQL
- Redis
- 本地文件目录或 S3 兼容对象存储
- 一个 OpenAI-compatible 模型端点
- 仅在测试正式 EPUB 自动规范化时需要 E2B 或 PPIO 账号

仓库不提供 Docker Compose。当前基线推荐本地进程连接独立的托管开发资源，也可以自行使用本地 PostgreSQL、Redis 和文件系统对象存储。

### 1. 安装依赖

```bash
corepack enable
pnpm install
python3 -m pip install -r requirements.txt
cp .env.example .env
```

CI 使用 `pnpm install --frozen-lockfile`。本地首次安装通常使用 `pnpm install` 即可。

### 2. 配置环境变量

完整变量及说明见 [`.env.example`](.env.example)。本地跑通完整产品至少需要：

```dotenv
DATABASE_URL=postgresql://user:password@host:5432/readtailor
REDIS_URL=redis://localhost:6379

# 本地对象存储。使用它时必须清空 OBJECT_STORAGE_BUCKET。
OBJECT_STORAGE_BUCKET=
OBJECT_STORAGE_LOCAL_ROOT=.data/object-storage

AUTH_COOKIE_SECRET=<使用 openssl rand -hex 32 生成>
AUTH_COOKIE_SECURE=false

# API 当前要求 Ask AI 使用真实模型；三项必须全部填写。
MODEL_API_BASE_URL=https://your-provider.example/v1
MODEL_API_KEY=<your-api-key>
MODEL_NAME=<model-name>

WEB_BASE_URL=http://localhost:5173
WEB_ORIGINS=http://localhost:5173,http://127.0.0.1:5173
VITE_API_BASE_URL=http://localhost:3001
```

注意：模型配置的 base URL、API key 和 model name 必须三项全部存在或全部为空，部分配置会使进程启动失败。当前 API 的问 AI 引擎是必需项，因此启动 API 时必须提供完整的全局 `MODEL_*`，或完整的 `QA_AI_MODEL_*` 覆盖配置。复制 `.env.example` 后，请替换示例 URL，不要保留“只有 URL、没有 key/model”的半配置状态。

对象存储只能二选一：

- 本地：设置 `OBJECT_STORAGE_LOCAL_ROOT`，清空 `OBJECT_STORAGE_BUCKET`。
- S3：设置 `OBJECT_STORAGE_BUCKET`，按服务需要设置 endpoint、region 和成对的 access key / secret key，并清空本地 root。

### 3. 运行数据库 migration

```bash
pnpm --filter @readtailor/database db:migrate
```

应用启动不会自动执行 migration。生成新 migration 使用：

```bash
pnpm --filter @readtailor/database db:generate
```

### 4. 启动三个进程

分别在三个终端运行：

```bash
pnpm dev:web
pnpm dev:api
pnpm dev:worker
```

启动后访问：

- Web：<http://localhost:5173>
- API health：<http://localhost:3001/v1/health>
- Worker health：<http://localhost:3002/health>

API 或 Worker 缺少数据库、Redis、对象存储等依赖时，部分能力会被禁用，health 可能返回 `503 degraded`。完整产品开发应确保三个服务均连接到相同的开发资源。

### 5. 本地登录

邮箱密码注册不需要额外 provider。密码使用带随机盐的 `scrypt` 摘要保存，当前不发送邮箱验证码，也不提供密码重置。

需要绕过注册流程时，可以仅在本地同时启用：

```dotenv
AUTH_DEVELOPMENT_ENABLED=true
VITE_AUTH_DEVELOPMENT_ENABLED=true
```

开发登录仍会创建正式用户、identity 和数据库 session。不要在线上启用。

Google OAuth 还需要：

```dotenv
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REDIRECT_URI=http://localhost:3001/v1/auth/google/callback
```

Google Cloud Console 中的 authorized redirect URI 必须与 `GOOGLE_REDIRECT_URI` 完全一致。当前后端流程已经实现，但 Web 登录页尚未提供 Google 登录按钮。

## 准备开发书籍

### 发布 fixture 书籍

下面的管理命令使用确定性本地规范化脚本发布开发 fixture，并把该共享书籍标记为预置书：

```bash
pnpm book:ingest:fixture
```

默认输入是 `fixtures/fixed_input.epub`，也可以传入其他路径：

```bash
pnpm book:ingest:fixture /absolute/path/to/book.epub
```

命令要求数据库 migration 已完成，并已配置对象存储。重复执行会校验不可变对象的 SHA-256；内容完全一致时返回 `reused: true`。

仓库也提供使用受控 normalizer 和审核后书籍画像发布书籍包的命令：

```bash
pnpm --filter @readtailor/worker ingest:preset \
  fixtures/preset/nahan.epub \
  tools/preset_profiles/nahan.book_profile.json
```

该命令当前只负责生成并发布书籍包，不会自动把 `shared_books.is_preset` 设为 `true`。只有数据库中已标记为预置的 ready book，才会在用户完成画像时自动加入书架。

### 正式 Agent 规范化

```bash
pnpm book:ingest:agent /absolute/path/to/book.epub
```

除数据库和对象存储外，还需要完整的规范化模型、书籍分析模型以及一个 sandbox provider：

```dotenv
NORMALIZATION_MODEL_API_BASE_URL=...
NORMALIZATION_MODEL_API_KEY=...
NORMALIZATION_MODEL_NAME=...

# BOOK_ANALYSIS_* 未配置时先继承 NORMALIZATION_*。
BOOK_ANALYSIS_MODEL_NAME=...

SANDBOX_PROVIDER=e2b
E2B_API_KEY=...

# 或者：
# SANDBOX_PROVIDER=ppio
# PPIO_API_KEY=...
```

详细的 Agent 工具、权限和校验边界见 [`docs/architecture/agent_design.md`](docs/architecture/agent_design.md)。

## 模型配置

模型服务使用 OpenAI-compatible chat completions 接口。全局默认值是：

```text
MODEL_API_BASE_URL
MODEL_API_KEY
MODEL_NAME
```

各功能可以通过以下前缀独立覆盖同名三项：

| 前缀 | 功能 | 运行位置 |
| --- | --- | --- |
| `SYSTEM_CHAT_*` | 系统诊断流式聊天 | API |
| `READING_SETUP_*` | 访谈、简报、策略和试读选择 | API |
| `QA_AI_*` | 阅读问 AI 和策略调整建议 | API |
| `CONTENT_GENERATION_*` | 试读与正式节点辅助内容生成 | Worker |
| `NORMALIZATION_*` | EPUB 规范化 Agent | Worker |
| `BOOK_ANALYSIS_*` | 共享书籍画像生成 | Worker |

未设置某个覆盖字段时，会逐字段回退到全局 `MODEL_*`。`BOOK_ANALYSIS_*` 还会先继承 `NORMALIZATION_*`。任何最终解析出的功能端点都必须同时具有 base URL、key 和 model name。

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `pnpm dev:web` | 启动 Web 开发服务器 |
| `pnpm dev:api` | 启动 API 并监听源码变化 |
| `pnpm dev:worker` | 启动 Worker 并监听源码变化 |
| `pnpm typecheck` | 检查所有 workspace TypeScript 类型 |
| `pnpm test:ts` | 运行 Vitest 测试 |
| `pnpm test:python` | 运行 Python unittest |
| `pnpm test` | 依次运行 TypeScript 和 Python 测试 |
| `pnpm build` | 构建所有可构建 workspace |
| `pnpm check` | 类型检查、全部测试和生产构建 |
| `pnpm book:ingest:fixture` | 发布开发 fixture 书籍包 |
| `pnpm book:ingest:agent <epub>` | 通过 Agent 和远程 sandbox 规范化 EPUB |

提交前运行：

```bash
pnpm check
```

## 生产部署

当前仓库没有绑定具体云厂商，也没有提供 Dockerfile 或平台部署清单。推荐拓扑是：

- `apps/web/dist` 部署到静态托管或 CDN。
- API 和 Worker 作为两个独立的 Node.js 进程部署。
- 使用托管 PostgreSQL、Redis 和 S3 兼容对象存储。
- migration 作为独立发布步骤执行。
- 根据负载通过 `WORKER_QUEUES` 拆分规范化池与内容生成池。

构建与启动命令：

```bash
pnpm build
pnpm --filter @readtailor/api start
pnpm --filter @readtailor/worker start
```

生产环境至少需要额外确认：

- `NODE_ENV=production`
- `AUTH_COOKIE_SECURE=true`
- Web 与 API 的域名和 cookie 策略可配合工作
- `WEB_ORIGINS`、`WEB_BASE_URL`、`VITE_API_BASE_URL` 和 `GOOGLE_REDIRECT_URI` 使用线上地址
- `AUTH_COOKIE_SECRET` 和 `SYSTEM_API_TOKEN` 使用独立高熵值
- 数据库有自动备份，失败任务和服务 health 有基本监控
- `VITE_*` 是构建时变量，必须在构建 Web 产物前设置

## 当前限制

- 当前版本主要面向中文 EPUB；不处理 PDF、Word、扫描件、MOBI 等格式。
- 当前 Web 登录页以邮箱密码和可选开发登录为主，Google OAuth 后端入口尚未接到页面按钮。
- 当前邮箱注册不验证邮箱，也没有密码重置和账户注销流程。
- 当前前端尚未提供书籍软删除与 30 天恢复入口。
- 阅读器剩余时间估算的前端接口仍待补齐。
- 没有支付、订阅、公开书库、运营后台、数据导出和大规模多租户能力。
- 当前目标用户不超过少量自用用户，尚未建设 staging、多地域、复杂灾备、完整审计、压力测试或严格多实例并发协议。

这些限制不放宽原文不可变、阅读位置稳定、权限隔离、用户确认和 AI 失败时原文可读等核心契约。

## 文档入口

建议按以下顺序阅读：

1. [`docs/product/product_prd.md`](docs/product/product_prd.md)：用户可见行为和 MVP 验收基线。
2. [`docs/contracts/reading_contract.md`](docs/contracts/reading_contract.md)：阅读节点、block、range、进度和统计契约。
3. [`docs/contracts/normalized_book_spec.md`](docs/contracts/normalized_book_spec.md)：规范化书籍 `nb-1.0` 契约。
4. [`docs/architecture/agent_design.md`](docs/architecture/agent_design.md)：Agent 职责、工具和权限。
5. [`docs/architecture/technical_architecture_v2.md`](docs/architecture/technical_architecture_v2.md)：当前 TypeScript 实现方案。
6. [`docs/project/implementation_baseline.md`](docs/project/implementation_baseline.md)：当前环境、可靠性和部署取舍。
7. [`docs/README.md`](docs/README.md)：完整文档目录和优先级。

设计与原型入口：

- [`design/README.md`](design/README.md)
- [`design/prototypes/readtailor-mvp.dc.html`](design/prototypes/readtailor-mvp.dc.html)
- [`design/design-system/README.md`](design/design-system/README.md)

产品行为以 PRD 为准，阅读位置和统计以 reading contract 为准，规范化产物以 normalized book spec 为准。设计原型用于表达布局和交互意图，不是生产运行时或业务数据依据。
