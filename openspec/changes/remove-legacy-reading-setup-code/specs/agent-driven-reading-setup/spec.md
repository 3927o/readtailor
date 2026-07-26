## ADDED Requirements

### Requirement: Agent-driven Setup 是唯一可执行入口
系统 SHALL 只通过 Agent-driven Reading Setup 会话启动和完成阅读准备。旧 interview、strategy review、trial review 与 reading setup operation 的 HTTP、SSE 和 Web 路由 MUST NOT 注册，旧流程实现 MUST NOT 作为 `UserBookService` 的运行依赖。

#### Scenario: 用户从书架开始阅读准备
- **WHEN** 用户打开 `workflowStatus=on_shelf` 的 ready user-book
- **THEN** 系统只进入 `/reading-setup` 单页会话并使用通用 Agent Run Worker

#### Scenario: 请求旧 Setup 接口
- **WHEN** 客户端请求旧 interview、strategy、trial 或 reading setup operation 路径
- **THEN** 系统返回路由不存在，且不执行旧状态机或写入旧 operation 数据

#### Scenario: 旧中间状态出现在书架
- **WHEN** Web 收到保留的 `interviewing`、`strategy_review` 或 `trial_*` workflow status
- **THEN** Web 回退到书架，不进入旧页面，也不尝试恢复旧流程

### Requirement: 清理保持当前正式阅读数据兼容
系统 MUST 保留现有数据库 schema、迁移和兼容写入。新 Setup 激活、预置书初始化、Reader 与问 AI SHALL 继续通过现有正式 profile、strategy draft、strategy version 和 user-book pointers 工作。

#### Scenario: 新 Setup 完成激活
- **WHEN** Agent 对已确认 Trial 成功调用 `complete_reading_setup`
- **THEN** 系统继续执行现有幂等兼容事务并把 user-book 更新为 `active_reading`

#### Scenario: 预置书进入正式阅读
- **WHEN** 用户 onboarding 绑定带模板的预置书
- **THEN** 系统继续生成现有兼容行和正式 generation，并允许该书直接进入 Reader

#### Scenario: 问 AI使用现有正式上下文
- **WHEN** active user-book 发起问 AI请求或处理策略建议
- **THEN** 系统继续读取和更新现有问 AI数据及正式策略关系，不要求新的数据模型

### Requirement: 数据库内容生成队列仅执行正式生成
内容生成队列 SHALL 只创建和执行 formal generation。队列 job MUST 由 generation identity 定位数据库记录，Worker MUST 拒绝执行 `generationScope` 不是 `formal` 的记录；新 Setup 的试读切片 SHALL 继续在 Agent Tool 内以内存 tailoring 输入生成，不进入数据库内容生成队列。

#### Scenario: Reader 创建正式生成窗口
- **WHEN** Reader 打开 active user-book 或报告新的阅读焦点
- **THEN** API 创建或复用 formal node generation，并将不含 trial scope 的 generation job 入队

#### Scenario: Worker 收到非正式 generation
- **WHEN** 内容生成 Worker 读取到 `generationScope` 不是 `formal` 的记录
- **THEN** Worker 拒绝执行该记录，不进入旧 trial revision 或 trial segment 状态机

#### Scenario: 新 Setup 生成试读
- **WHEN** Agent 调用 `generate_trial_slice`
- **THEN** Worker 使用 tailoring 包的 trial 输入直接返回单个试读结果，不创建或入队数据库 trial generation
