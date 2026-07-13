# ReadTailor Handoff

生成日期：2026-07-13

> 当前仓库已由交接包初始化。实现时先阅读
> [`docs/project/implementation_baseline.md`](docs/project/implementation_baseline.md)，其中冻结了当前自用上线目标、
> 云服务取舍和实施顺序。

## 当前工程

项目使用 Node.js 22 LTS 和 pnpm 10。首次安装：

```bash
pnpm install
cp .env.example .env
```

本地分别启动三个进程：

```bash
pnpm dev:web
pnpm dev:api
pnpm dev:worker
```

默认地址：Web `http://localhost:5173`，API health `http://localhost:3001/v1/health`，
Worker health `http://localhost:3002/health`。Worker 未配置 `REDIS_URL` 时会正常启动，但 health
状态为 `degraded`。

提交前执行：

```bash
pnpm check
```

这是 ReadTailor 新 TypeScript 网页产品的实现交接包。源仓库中的 Rust CLI、历史实验目录和大型输出
不属于新产品架构依据，未包含在本包中。

## 从这里开始

按以下顺序阅读，不要先从旧技术方案或设计原型反推产品行为：

1. `docs/README.md`：文档分类、阅读顺序和优先级。
2. `docs/project/implementation_baseline.md`：本仓库当前已冻结的实施范围和顺序。
3. `docs/product/product_prd.md`：用户可见行为和 MVP 验收基线。
4. `docs/contracts/reading_contract.md`：阅读节点、block、UTF-16 range、进度、活动和统计契约。
5. `docs/contracts/normalized_book_spec.md`：规范化书籍 `nb-1.0` 契约。
6. `docs/architecture/agent_design.md`：Agent 职责、工具和权限。
7. `docs/architecture/technical_architecture_v2.md`：当前快速实现方案。
8. `docs/architecture/technical_architecture.md`：未来线上化与系统加固参考，不是当前实现要求。

设计入口：

- `design/README.md`
- `design/prototypes/readtailor-mvp.dc.html`：完整响应式 MVP 原型。
- `design/prototypes/readtailor-mobile.dc.html`：移动端独立原型。
- `design/design-system/README.md`：视觉规则、tokens、组件和 UI kits。
- `design/design-system/ui_kits/reader/`：正式阅读器界面参考。

原型通过相对路径引用 `design-system` 和 `support.js`，不要拆散 `design/` 内的目录关系。

## 设计与原型迁移

当前原型是 Design Canvas 可交互原型：主原型覆盖完整响应式流程，移动原型补充窄屏交互。它们用于
表达页面结构、操作节奏、桌面/移动布局和品牌气质，不是可以直接放进 Vite 的生产应用。

`design-system/` 是迁移的主要视觉来源，已经包含颜色、字体、间距、动效、阅读主题、React 组件和
阅读器 UI kit。现有组件可以作为正式实现的起点，但 Design Canvas 的 `x-dc`、`sc-if`、`x-import`、
全局 bundle、mock 数据、定时器和 localStorage 状态只属于原型运行机制。

迁移心法：

- 迁移视觉与交互意图，不迁移原型运行时。
- 先复用 tokens 和组件语言，再用正常 React、路由和服务端状态重建页面。
- 桌面与移动端使用同一套功能和业务组件，通过响应式布局改变工具栏、抽屉和 bottom sheet 的呈现。
- 原型中的 mock 进度、计时、生成和问答逻辑不能成为业务实现依据；数据行为以 PRD、阅读契约和技术
  方案为准。
- 原型与 PRD 都没有明确的功能细节，在实现对应交互前向产品方确认，不从 mock 内容自行推导需求。
- 用桌面和移动端截图持续对照原型，保持安静纸张、窄正文、松绿强调、弱阴影和克制动效的整体气质。

## 当前产品取舍

- 这是完全新的 TypeScript 网页产品，不使用旧 Rust CLI 作为架构证据。
- 优先尽快完成真实可用的产品闭环，不提前建设成熟平台能力。
- 当前不做异步输入版本/发布门禁、transactional outbox、lease/fencing、复杂并发协议、完整审计、
  灾备、多地域和跨境设计。
- 保留 PostgreSQL、Redis/BullMQ、API/Worker 分工、对象存储适配器、Pi Agent SDK、E2B、确定性
  书籍校验和阅读位置契约。
- 不做书签，也不做独立笔记。用户先划线，再选择只保存划线或为该划线记录一条笔记。
- 删除笔记保留划线；删除划线删除当前笔记，但保留历史问 AI 会话中的 range 快照。
- 只有正式阅读器中的活动计入阅读时间；试读、书架、统计页和独立问 AI 视图不计入。
- 正式阅读器内阅读原文和辅助内容的有效活动都计入阅读时长。
- 个人阅读速度只使用正常连续向前阅读原文的时间和字符推进量。
- 剩余时间按书计算，表示从当前稳定位置到书末；样本不足时使用中文默认速度。

## 实现方向

新产品应建立独立项目和 Git 历史，建议目录名为 `read-tailor`。不要直接改造旧 CLI 仓库。

第一条纵向闭环必须有真实网页：

```text
打开一本已准备好的预置书
  -> 完成本书访谈
  -> 查看并确认处理方式
  -> 生成并查看三个试读片段
  -> 最终采用
  -> 进入正式阅读器阅读原文和辅助内容
```

功能范围可以窄，但核心结构必须真实：React、Fastify、PostgreSQL、Drizzle migration、Worker、模型
调用、正式 API、稳定业务 id、工作流状态、不可变书籍包和统一阅读位置契约。

第一条闭环可以使用开发用户、本地存储和一本文档包已准备好的书，但这些必须走正式接口：

- 开发用户仍是数据库中的正式 user。
- Seed 书仍创建正式 shared book、package 和 user book。
- 本地文件仍通过 ObjectStorage 接口读取。
- 试读和正式阅读必须共用同一个生成实现。
- 前端不能硬编码书籍正文、用户、试读结果或工作流状态。
- 持久业务状态不能只保存在浏览器 localStorage 或进程内存。

先实现这条闭环，再补 EPUB 上传、完整阅读器、划线笔记、阅读统计、问 AI、OAuth、删除恢复和上线
准备。后续依赖应通过上述稳定契约接入，不需要现在一次性创建全部数据库表。

## 数据和依赖提醒

以下基础即使首个页面暂时用不到，也不能用临时替代方案绕过：

- user、shared book、user book 三层身份关系。
- package、manifest、node、block 和全书绝对原文位置。
- 长期画像与本书画像分离。
- strategy draft、正式 strategy、trial revision 和 node generation 的明确归属。
- AI 内容与不可变原文分开保存。
- range 使用 `section_id + segment + block_index + UTF-16 offset`。

`tools/build_reading_nodes.py` 是现有生成器原型，不是完整生产实现。它尚未覆盖阅读契约要求的完整
outline、裁读资格和全书位置索引。接手者必须按 `docs/contracts/reading_contract.md` 补齐，而不是把当前脚本输出
直接认定为 ready package。

## 包内容

```text
docs/       当前产品、Agent、书籍、阅读和技术文档
design/     当前原型与 design system 源码
tools/      规范化校验、linter 和 reading node 原型
tests/      与上述工具和阅读契约直接相关的测试
fixtures/   一个小型 EPUB 输入样例，不是已完成的 ready package
```

未包含：源仓库 `.git`、设计仓库 `.git`、环境变量、密钥、旧 Rust CLI、历史 Python 产品实验、
大型 `dist/`、62 MB 研究测试目录和其他书籍文件。

## 源工作区状态

本包按生成时的工作区内容制作，包含尚未提交的当前版本：

- 产品源：`docs/architecture/agent_design.md`、`docs/product/product_prd.md`、
  `docs/contracts/reading_contract.md` 有修改；两版技术
  方案文件尚未跟踪。
- 设计源：`prototypes/readtailor-mobile.dc.html`、`prototypes/readtailor-mvp.dc.html` 有未提交修改。

这些当前文件有意被包含，不应退回对应仓库的旧提交版本。
