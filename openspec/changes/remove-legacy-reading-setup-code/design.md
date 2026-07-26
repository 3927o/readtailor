## Context

系统目前同时存在两套 Reading Setup：新流程由 `reading_setup_sessions`、通用 Agent Run Worker 和单页会话驱动；旧流程由 API 内同步 Agent、访谈/策略/试读状态机、operation 恢复以及数据库队列式 trial generation 驱动。两套流程共享 `user_books` 指针、正式策略、Reader 内容生成、预置书初始化和部分 Web 渲染代码，因此不能按目录整块删除。

本次只做运行代码切换。数据库 schema、迁移和旧表必须保留，新 Setup 激活、Reader、问 AI和预置书仍按现有数据关系工作。

## Goals / Non-Goals

**Goals:**

- 让 Agent-driven Reading Setup 成为唯一可执行的阅读准备流程。
- 删除旧 Web、API、Agent、operation 和队列式 trial generation 代码。
- 把 Reader、新 Setup 与问 AI仍使用的通用能力从旧流程模块中分离。
- 保持新 Setup 激活、正式阅读生成、问 AI和预置书行为不变。

**Non-Goals:**

- 不删除或重命名旧表、字段、约束、迁移和历史指针。
- 不重构 brief、profile、strategy 的独立正式数据模型。
- 不迁移旧中间 workflow 数据，也不提供旧流程恢复兼容层。
- 不把现有问 AI改为通用 Agent Run Session。

## Decisions

1. **按可执行入口和依赖图删除，不按旧表名删除。** 旧路由、服务和状态机整体移除；新 Setup 激活和预置书初始化即使写入旧表也保留，因为它们仍是当前业务路径。

2. **从 `UserBookService` 中拆出共享加载能力。** Reader、正式生成和问 AI仍需要 manifest/HTML、长期画像和正式策略上下文。这些能力改为中性 helper，不再通过 trial service 或 setup context service 间接获得。

3. **正式生成队列不再表达 trial scope。** Queue payload 只携带 generation identity；API 只创建并入队 formal generation，Worker 在读取数据库行后拒绝非 formal 任务。tailoring 包的 `generationScope='trial'` 保留，供新 Setup 的内存 `generate_trial_slice` 使用。

4. **数据库兼容类型与 HTTP 契约分开处理。** 旧表 schema 所需的 status、payload、scope 类型继续保留；只删除旧路由、SSE 和页面专属请求响应类型。

5. **旧中间 workflow 状态不恢复。** 因项目尚未上线，不增加迁移或兼容实现。Web 遇到这些保留值时返回书架，开发和测试环境按需重建数据库与 Redis。

6. **共享 Web 组件迁出旧流程边界。** Reader 和新 Setup 使用的正文辅助渲染、Brief 卡片及正式内容类型移动到中性组件/Reader 模块；`user-books` 目录只保留书架详情 HTTP、query key 和新路由决策。

## Risks / Trade-offs

- [开发库存在旧中间状态记录] → 不提供继续入口，统一回退书架并明确要求按需重建本地数据。
- [误删旧目录中被 Reader/问 AI复用的 helper] → 先迁移共享能力，再删除旧服务，并用新 Setup、Reader、问 AI和预置书回归测试覆盖。
- [Redis 中残留 trial generation job] → 项目未上线，不兼容旧队列；Worker 明确拒绝非 formal generation，开发环境按需清理 Redis。
- [契约清理影响数据库类型] → 保留所有被 database schema 或 tailoring 输入引用的类型，只删除无生产消费者的 HTTP/SSE surface。
