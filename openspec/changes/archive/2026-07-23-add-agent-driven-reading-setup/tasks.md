## 1. 会话契约与持久化

- [x] 1.1 在 contracts 中定义可序列化 Agent state DTO、session snapshot、active run、run display snapshot、十种通用 SSE 事件、消息/问题回答/最终确认请求及响应，不引入旧 setup phase 或 Agent state version
- [x] 1.2 为 `ai_reading_setup_sessions` 增加数据库 migration 与 Drizzle schema，仅包含唯一 user-book 绑定、完整 agentState JSON、可空 activeRunId 和时间戳，不增加递增 version 或中间 workflow 状态
- [x] 1.3 实现独立 session store：按所有权创建/读取 session、条件 claim activeRunId、按 runId 条件提交完整 Agent state、按 runId 条件失败清理，并覆盖并行 claim 与过期 run 不得覆盖的单元/数据库测试
- [x] 1.4 实现并测试应用 DTO 的 JSON round-trip 及 SDK context 重建，覆盖 system prompt、model config、thinking level、完整 messages/tool results/usage/actions，并验证模型对象、函数、运行态集合和密钥不会进入持久化 JSON
- [x] 1.5 为 session state、读取结果、Tool 参数和 Tool result 设置有界大小限制及明确错误，防止无界书籍内容进入单行 JSON

## 2. 通用 Agent Run Worker 与实时事件

- [x] 2.1 在 queue、API 和 Worker 中实现通用 `{ agentType, sessionId, runId, input }` job、enqueue、状态/progress 查询与事件订阅，使用 runId 作为 job id
- [x] 2.2 实现 Agent handler 注册表及首个 `reading_setup` handler，让通用层负责 session/队列/提交，让 handler 负责 prompt、model、Tool 和资源访问；不迁移既有“问 AI”
- [x] 2.3 使用 SDK `runAgentLoop` 执行多 turn 循环，并通过 `shouldStopAfterTurn` 在成功 `present_question` 或 `offer_final_confirmation` 所在 turn 的全部 Tool 完成后停止；覆盖它们与其他 Tool 共存及多个交互 Tool 不被硬拒绝的测试
- [x] 2.4 实现 SDK 到通用 SSE 的事件映射，分别发布 Tool 参数 start/delta/finished、assistant message finished、Tool execution start/progress/finished 和 run finished
- [x] 2.5 维护含 lastSequence 的可查询 run display snapshot；SSE 端先订阅并缓冲，再读取/发送 snapshot 和更大 sequence 事件，避免首次订阅与重连缺口
- [x] 2.6 实现 Worker 成功提交、失败保留旧 state、整 run 重试及 activeRunId 条件清理；确保浏览器/API AbortSignal 不传给 job，并测试断线、API 订阅进程退出、Worker 重试和过期 job

## 3. 独立 Agent 与工具集

- [x] 3.1 新建不导入 reading-setup-engine 或旧 interview/strategy/trial service 的 AI 阅读准备 Agent 模块，定义系统提示词并在每次 run 暴露相同工具集
- [x] 3.2 实现 `get_reader_profile` 与 `get_book_profile`，只读取长期画像和 shared book profile，不读取旧 setup 会话或产物
- [x] 3.3 实现分离的 `get_book_outline`、`list_reading_nodes`、`read_book_node` 和 `search_book`：目录不含 nodes、正文返回 block 坐标与续读游标、全部结果有默认限制/硬上限/truncated
- [x] 3.4 实现 `present_question` 参数契约与结果，支持选项单选、多选和自由文本；用户回答由引用 questionToolCallId 的下一 run action 处理，Tool 本身不跨进程等待
- [x] 3.5 分别实现 `publish_brief`、`publish_book_reader_profile` 和 `publish_strategy`，只校验/返回可渲染内容和自身 toolCallId，不写正式业务行、不计算 latest/version
- [x] 3.6 实现 `generate_trial_slice`：显式解析 strategyToolCallId，校验同节点连续 BlockRange 与输入上限，调用一次独立裁读并返回 source slice/guide/annotations/afterReading，不写 trial/generation/operation 业务行
- [x] 3.7 实现 `offer_final_confirmation`：显式校验 brief/profile/strategy/trial 四个 toolCallId，要求 trial 是使用被确认 strategy 成功生成的同 session 试读，只发布确认卡片、不选 latest、不写业务数据
- [x] 3.8 增加 Agent 与 Tool 测试，覆盖自主追问、多 turn/多 Tool、独立产物修订历史、参数实时流、显式引用错误、读取上限、无效 range、单切片试读及 Agent 无权激活 user-book

## 4. API 与用户确认激活

- [x] 4.1 新增创建/读取 AI 阅读准备 session snapshot 的 API，校验所有权、未删除、shared book ready 和 `workflowStatus=on_shelf`，但不检查旧 setup pointers 是否为空
- [x] 4.2 新增统一消息/action 提交 API：条件 claim activeRunId、以用户输入为 job payload 入队、已有 active run 时返回其标识、入队失败时不遗留 activeRunId
- [x] 4.3 新增 run SSE 订阅 API，首次连接/重连发送权威 snapshot 后只发送更大 sequence；连接关闭只取消订阅，`run_finished(completed)` 仅在 session 提交后发送
- [x] 4.4 新增 question answer action API，校验 question Tool 已执行成功且所属 run 已提交，再以明确 toolCallId、选项和自由文本启动下一 run
- [x] 4.5 实现用户最终确认事务：解析 offer 明确引用的 publish calls 和 trial slice call，验证 trial 使用的正是被确认 strategy，再写入真实 BookReaderProfile、Briefing、strategy summary/core、confirmed draft、formal strategy 和 active user-book pointers，并把 action/result 写回 Agent session
- [x] 4.6 在确认事务中创建或复用 completed interview shell，为 profile/draft/strategy 分配各表下一个 version，并从 manifest 确定性选择一个 eligible node 重复补齐三个结构占位 trialCandidates；保持 currentTrialRevisionId 为空
- [x] 4.7 确保确认事务不创建 interview messages/answers、trial revisions/segments/generations、setup operations 或 formal generations，并为相同 offerToolCallId 实现幂等重放
- [x] 4.8 增加 API/数据库测试，覆盖 pointer 残留但 on_shelf 仍可进入、并行提交、SSE snapshot/sequence、确认前无正式数据、缺少 trial 或 trial/strategy 引用不一致时拒绝确认、旧 session/versions 残留、确认原子性、结构占位、确认重放及现有 Reader bootstrap 可读取激活结果
- [x] 4.9 新建或恢复空白 session 时以内部 `session_start` 幂等启动唯一后台 run，返回 active run 供 Web 自动订阅，且不把内部启动输入保存或呈现为用户消息

## 5. 极简 Web 验证页面

- [x] 5.1 新增 Web API client、query keys 和类型映射，用于 session snapshot、消息/action 提交、active run snapshot、SSE 订阅和最终确认
- [x] 5.2 实现通用 run reducer：按 runId/toolCallId/sequence 合并 assistant、Tool arguments 和 execution 事件，以 run snapshot 完整替换临时状态，不引入旧 phase/pointer/operation reducer
- [x] 5.3 实现极简单页，渲染持久 Agent history、可选 active run、输入 composer、问题回答、错误/重试和最终确认；刷新时不请求旧 setup endpoints
- [x] 5.4 实现基础 renderer：question、brief、book reader profile、strategy、trial slice、final confirmation 和未知 Tool；publish/question/offer 卡片从 arguments delta 开始渐进显示
- [x] 5.5 只有在完整 arguments、Tool 执行成功且 run 已提交后启用问题回答/最终确认；实现断线重连和完成后从 session 恢复
- [x] 5.6 新增独立路由和 `on_shelf` 书架入口，激活后导航现有 Reader；不修改旧 setup 中、active reading 或“问 AI”路径
- [x] 5.7 增加技术测试，覆盖实时参数、权威替换、Tool 输出、snapshot 恢复、多个产物/试读历史、未知 Tool、按钮门禁和激活导航；不把正式视觉验收纳入本 change

## 6. 验证与交付

- [x] 6.1 使用 fake Agent/model 完成 API 到 Worker 的全链路测试：访谈、分别发布 brief/profile/strategy、生成一个 reading node 内切片、用户反馈后重做、展示确认、用户点击确认并打开 Reader
- [x] 6.2 增加既有“问 AI”回归测试，确认新通用 Worker、runId 和 SSE contract 未改变其当前行为
- [x] 6.3 运行受影响包的 typecheck、单元测试、数据库测试和生产构建，并修复新增契约、队列、Tool 和路由问题
- [x] 6.4 启动本地 API、Worker 和 Web，提供项目 owner 可访问的 URL，并列出需人工验收的入口、自由对话、实时卡片、问题回答、离开/返回、试读反馈、最终确认、刷新和失败重试；不以浏览器自动化或截图代替 owner 验收
- [x] 6.5 核查 import 与数据库写入边界，确认最终确认事务之外不引用旧 setup engine/service 写路径、不创建 trial 业务行，也不新增 Agent 状态 version
