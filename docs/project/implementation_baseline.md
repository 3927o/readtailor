# ReadTailor 实施基线

**冻结日期**：2026-07-13  
**状态**：当前实现依据

本文记录 handoff 进入新项目后的实施取舍。它不改变 `../product/product_prd.md` 中的用户可见行为、
`../contracts/reading_contract.md` 中的阅读位置契约或 `../contracts/normalized_book_spec.md` 中的规范化要求。

## 1. 文档优先级

出现冲突时按以下顺序处理：

1. `../product/product_prd.md`：用户可见行为和验收规则。
2. `../contracts/reading_contract.md`：阅读节点、block、range、进度和统计。
3. `../contracts/normalized_book_spec.md`：规范化书籍产物。
4. `../architecture/agent_design.md`：Agent 职责、工具和权限。
5. `../architecture/technical_architecture_v2.md`：当前实现方案。
6. `../product/product_mvp_plan.md`：产品方向和背景说明。
7. `../architecture/technical_architecture.md`：未来加固参考。

## 2. 当前目标

当前目标不是面向公众正式发布，而是让项目所有者可以通过线上环境正常、顺畅地使用完整产品。
预计用户不超过 5 人。只实现支持这个目标所需的可靠性，不提前建设规模化平台能力。

当前只有两个环境：

- 本地测试环境：应用在本机运行，可以连接独立的云端开发资源或 provider 测试资源。
- 线上环境：部署可实际使用的 Web、API 和 Worker，并连接线上托管中间件。

不单独建设 staging 环境。

## 3. 基础设施取舍

- PostgreSQL、Redis 和对象存储优先使用托管云服务，本地不要求运行 Docker Compose 中间件。
- API 与 Worker 保持独立进程，但可以使用同一镜像或同一部署项目的不同启动命令。
- CI/CD 只做最低限度：安装、类型检查、关键测试、构建和部署。
- 暂不建设多地域、复杂灾备、完整审计、故障注入、压力测试和运营后台。
- 线上仍需保留最小健康检查、错误日志、数据库自动备份和失败任务重试，否则无法支持日常自用。
- OAuth、字体 CDN、公开发布合规和大陆网络可达性暂不作为当前阻塞项。

具体云供应商在项目初始化时按现有账号和部署便利性选择，并通过环境变量和小型适配器隔离。

## 4. 实施顺序

### 阶段 1：项目骨架与云资源

- 初始化 pnpm workspace、Web、API、Worker 和共享包。
- 配置托管 PostgreSQL、Redis 和对象存储。
- 建立 Drizzle migration、配置校验、日志和 health check。
- 打通 API -> BullMQ -> Worker -> PostgreSQL 的最小任务往返。
- 打通 fake model -> 流式 API -> PostgreSQL 的最小交互往返。

完成条件：本地可以连接云端开发资源运行三个应用，线上可以部署空骨架。

### 阶段 2：第一本 EPUB 到 ready package

当前没有可复用的 ready package，因此先从 handoff 的 `fixtures/fixed_input.epub` 开始：

- 上传或管理脚本写入源 EPUB，计算 SHA-256。
- 解包并运行最小规范化流程。
- 生成 `book.normalized.html`、assets 和校验报告。
- 补齐完整 `reading_manifest.json`，包括 outline、nodes、blocks、裁读资格和全书位置。
- 运行 `nb_check.py --baseline`、`nb_linter.py` 和 package 资源检查。
- 生成最小 `book_profile.json`。
- 发布不可变 package，并创建正式 shared book 记录。

Coding Agent 和 E2B 可以在此阶段逐步接入。为了先验证数据链路，允许先为第一本 fixture 编写人工
确定的 `normalize.py`，但产物必须走与未来 Agent 相同的校验和发布接口，不能手工伪造 ready 状态。

完成条件：第一本书可以从对象存储和数据库通过正式 API 读取，且能确定性重建 manifest。

### 阶段 3：唯一一次纵向产品闭环

使用阶段 2 生成的 ready book，一次性实现：

```text
书架 -> 本书访谈 -> 简报和策略确认 -> 三个试读片段
     -> 最终采用 -> 连续滚动阅读器 -> 原文和增强内容
```

- 访谈最多 7 问并支持刷新恢复。
- 保存长期画像、本书画像、策略草稿、trial revision 和正式策略。
- 三个试读片段必须非重叠、可精确定位并全部成功后发布。
- 试读和正式节点使用同一内容生成器、schema、锚点校验和缓存逻辑。
- 阅读器在增强内容失败或未完成时始终返回纯原文。

这一步已经包含访谈与试读，不再安排第二个重复的“完成访谈与试读”阶段。

完成条件：项目所有者可以在线上从书架进入一本 ready book，完成两次确认并实际开始阅读。

### 阶段 4：补齐日常阅读能力

- 目录、连续滚动、阅读设置和位置恢复。
- 原书注、裁读注、划线和划线笔记。
- 阅读 session、有效活动、基础统计和预计剩余时间。
- 当前节点和后续三个可裁读节点的生成调度。

完成条件：跨刷新和跨设备恢复正确，可以持续阅读而不是只能演示主流程。

### 阶段 5：用户上传与自动规范化

- 把阶段 2 的管理脚本入口接到网页上传。
- 加入 SHA-256 复用、处理进度、失败重试和错误展示。
- 接入受限 Coding Agent、E2B 和多轮校验修复。
- 使用额外 EPUB 验证结构差异，不要求大规模兼容性覆盖。

完成条件：项目所有者可以自行上传至少几本真实中文 EPUB，并获得可读的 ready package。

### 阶段 6：问 AI 与策略调整

- 支持划线和当前屏幕发起问题、追问和返回原文位置。
- 支持只读全书检索和长期画像更新。
- 处理方式调整只创建待确认 proposal；用户确认后才创建新正式策略。
- 当前节点切换到新策略并重新生成；其他已读节点保留其已读时的策略版本，未读节点按新策略懒生成。
- 问答回答、长期画像 patch、候选草稿和 proposal revision 在回答成功后统一提交；生产环境不提供 fake Ask AI engine。

完成条件：问答和策略调整失败不会破坏当前阅读流程。

### 阶段 7：线上自用收尾

- 加入最小访问控制、速率限制、上传限制和 HTML 清理。
- 配置错误日志、任务失败提示、数据库备份和模型费用上限。
- 执行关键路径 smoke test：上传、ready、访谈、试读、阅读、问 AI。
- 部署线上 Web、API 和 Worker，运行 migration 并创建第一个真实用户。

完成条件：线上连续使用数天没有阻塞主流程的问题，即视为当前版本完成。

## 5. 暂缓事项

- 完整 CI/CD、staging 环境和发布审批流程。
- 大规模自动化 E2E、压力测试、故障注入和全组合状态机测试。
- 多实例严格一致性、transactional outbox、lease/fencing 和复杂任务恢复平台。
- 面向公开用户的合规、客服、运营、计费和账户全生命周期建设。
- 为未知规模提前优化的缓存、微服务拆分和多地域部署。

暂缓不等于允许破坏原文不可变、位置稳定、用户确认、资源权限和 AI 失败时原文可读等核心契约。

## 6. Handoff 来源

原始交接包：`readtailor-handoff-2026-07-13.zip`  
SHA-256：`de6e54481f4b8d6cd97e6dff93d2a97489cc753f23567da3b73695a19843c7d3`

交接包未包含旧仓库 `.git`。本目录使用新的 Git 历史，旧 Rust CLI 和实验代码不进入新产品仓库。
