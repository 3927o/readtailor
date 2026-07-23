## Why

现有单本书阅读准备虽然由 Agent 参与生成问题、简报、策略和试读，但流程控制仍分散在多阶段 workflow、版本指针、长操作、试读 revision 及其恢复逻辑中。需要新增一条独立、以完整 Agent 会话为事实来源的阅读准备路径，让处于 `on_shelf` 的 user-book 可以在同一个 AI 对话中完成访谈、简报、书籍读者画像、策略、一次片段试读和最终确认，并进入正式阅读。

## What Changes

- 为 `on_shelf` 的 user-book 新增独立 AI 阅读准备入口；除通用的归属、未删除及共享书籍可用性检查外，不再依据旧 setup 指针判断是否可进入。
- 新流程不调用或复用旧 interview、strategy、trial、reading-setup-operation 编排代码，也不引入由服务端控制的阶段状态机。
- 完整持久化 Agent session state，包括系统提示词快照、模型配置标识、用户与助手消息、工具调用参数、工具结果和用户结构化动作，使每次 Agent run 都能从保存状态继续。
- 新建或恢复尚未开始的空白 session 时，由服务端自动触发唯一的内部 `session_start` Agent run；后续每次用户输入或结构化用户动作继续触发独立 run。所有 run 均放入后台 Worker，SSE 仅订阅运行事件，连接中断不取消 Agent 或 Tool，返回会话时可恢复已提交历史和进行中运行的最新快照。
- 提供通用 SSE 协议，分别表达助手文本、Tool 参数的流式生成、Tool 执行进度与结果、运行结束；发布卡片和交互卡片可随 Tool 参数增量实时渲染。
- 始终向 Agent 暴露同一组能力，由 Agent 自主决定何时读取书籍、追问、发布 brief、book reader profile 与 strategy、生成或重做试读切片，以及发起最终确认。
- `get_book_outline` 仅返回语义目录；阅读节点通过独立工具分页读取。目录、节点正文和搜索结果均设置宽松默认限制、硬上限及截断/游标信息，避免极端输出。
- 试读仅生成一个 `tailoringEligible` 阅读节点内的连续 `BlockRange` 切片。真实试读内容只保存在 Agent 会话及实时 UI 中，不创建 trial revision、segment、generation 或 operation 数据。
- brief、book reader profile、strategy 的发布 Tool 以及最终确认卡片均为纯展示动作；在用户点击最终确认之前，不写入这些正式业务数据。
- 最终确认 Tool 必须明确引用 brief、book reader profile、strategy 和一次使用该 strategy 成功生成的试读切片。用户确认后，服务端在一个幂等事务中写入前三者的真实正式数据并将 user-book 切换为 `active_reading`；被引用试读只用于证明用户确认的是实际体验过的 strategy，不写入 trial 业务表。事务仅为满足现有不可空关系和 `StrategySchema` 的三个候选硬约束补充隔离的结构占位。
- 新功能不引入递增 session/plan/trial version，也不设置中间业务 workflow 状态；仅保留用于后台单写入控制和运行恢复的 active run 标识。
- 首版只提供完整 Agent/Worker/API 能力和极简验证界面；正式前端交互与视觉实现待流程验证后另行规划。

## Capabilities

### New Capabilities

- `agent-driven-reading-setup`: 定义完整持久化的 AI 阅读准备会话、后台 Agent run、通用 SSE Tool 流、单切片试读、会话恢复、用户交互以及最终确认激活行为。

### Modified Capabilities

无。

## Impact

- API：新增 AI 阅读准备 session、消息/action 提交、session snapshot 和运行事件订阅端点。
- 数据库：新增最小 Agent session 持久化；不新增 Agent 业务阶段、plan/trial 版本表或新业务状态机。
- Agent：新增独立 runner 和始终可用的阅读准备工具集，不依赖现有 reading setup engine。
- Worker/队列：新增可脱离 SSE 连接运行的 Agent run job，以及运行中进度发布/查询能力。
- Web：首版新增极简会话验证界面、通用 SSE reducer 和按 Tool 名分发的基础 renderer；最终激活后进入现有 Reader。
- 现有正式读取数据：最终确认事务继续写入 `book_reader_profile_versions`、`strategy_draft_versions`、`strategy_versions` 和 `user_books`；其中 brief、profile 与 strategy 为正式业务数据。`interview_sessions` 及三个 trial candidate 仅作为当前 schema 的结构占位，待旧 setup 约束删除后移除。
- 既有功能：旧 setup 与“问 AI”行为在本次变更中保持不变。
