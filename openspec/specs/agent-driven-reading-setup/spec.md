# agent-driven-reading-setup Specification

## Purpose
定义由 AI Agent 自主编排的阅读准备能力，包括会话持久化、后台运行、工具交互、策略确认、试读确认及正式激活边界。

## Requirements

### Requirement: 独立的 AI 阅读准备入口
系统 SHALL 为当前用户拥有、未删除、共享书籍已经 ready 且 `workflowStatus=on_shelf` 的 user-book 提供独立 AI 阅读准备会话。入口 SHALL NOT 要求旧 setup pointers 为空，新会话 SHALL NOT 调用或依赖旧 interview、strategy review、trial 或 reading setup operation 编排服务。

#### Scenario: on_shelf 书籍进入 AI 会话
- **WHEN** 用户从书架打开一本属于自己、未删除、shared book ready 且 `workflowStatus=on_shelf` 的 user-book
- **THEN** 系统创建或恢复该书唯一的 AI 阅读准备 session，并展示单一会话页面

#### Scenario: 空白会话自动开始
- **WHEN** 创建或恢复的 AI 阅读准备 session 尚无任何已提交消息或用户 action
- **THEN** 系统以内部 `session_start` 输入条件启动唯一的后台 Agent run，并在 session snapshot 中返回可订阅的 active run；并发进入不得重复入队，内部启动输入不得呈现为用户消息

#### Scenario: 残留旧 pointer 不阻止进入
- **WHEN** user-book 为 `on_shelf` 但仍存在任意旧 setup pointer 或结构行
- **THEN** 系统仍允许创建或恢复 AI 阅读准备 session，且新会话不读取这些数据来决定下一步

#### Scenario: 非 on_shelf 状态不进入新会话
- **WHEN** user-book 的 workflow 已不是 `on_shelf`
- **THEN** 系统拒绝为其创建新的 AI 阅读准备 session，且不修改原有 workflow 数据

### Requirement: 完整持久化 Agent session
系统 MUST 以可序列化的应用级 DTO 保存可重建 Agent context 的完整 session state，包括系统提示词快照、模型配置标识、thinking level、用户和助手消息、reasoning/thinking content、工具调用名称与参数、工具结果、usage、时间戳和用户结构化动作。系统 MUST NOT 直接序列化模型对象、Tool 函数、运行态集合、AbortSignal、API key 或服务密钥。

#### Scenario: 完成一轮后恢复完整历史
- **WHEN** Agent run 成功完成并且用户刷新或重新打开会话
- **THEN** 系统从持久化 session state 恢复相同的用户消息、助手内容、工具调用和工具结果，而不是从旧 setup 表重新构造历史

#### Scenario: Agent 继续使用保存状态
- **WHEN** 用户在已存在 session 中提交下一条消息
- **THEN** 后台 Worker 重建模型与 Tool，从上一次成功提交的完整 state 启动，并能访问先前工具调用及其结果

### Requirement: 通用单写者 Agent run
系统 SHALL 通过通用 Agent Run Worker 执行 `{ agentType, sessionId, runId, input }` job，并 SHALL 把首次内部 `session_start`、每次用户消息或结构化动作触发的完整 Agent loop 建模为一个具有不可预测 UUID 的后台 run。同一 session 同时最多存在一个 active run；run SHALL NOT 表示访谈、策略或试读业务阶段，也 SHALL NOT 使用递增 version。本 change SHALL 只为该 Worker 注册 `reading_setup` handler，既有“问 AI”行为 SHALL 保持不变。

#### Scenario: 创建后台 run
- **WHEN** session 没有 active run 且用户提交有效输入
- **THEN** 系统条件设置新的 `activeRunId`、以该 ID 入队 Agent job，并返回可订阅的 run 标识

#### Scenario: 拒绝并行输入
- **WHEN** session 已有 active run 且用户再次提交消息或 action
- **THEN** 系统不创建第二个 run，并返回当前 active run 标识供客户端继续观察

#### Scenario: 过期 job 不能覆盖新状态
- **WHEN** 某个已失效 run 在 session 已指向其他 run 后尝试提交或清理
- **THEN** 条件写入不修改 `agentState`，也不清空当前 `activeRunId`

#### Scenario: 既有问 AI 不受影响
- **WHEN** 用户继续使用现有阅读中“问 AI”功能
- **THEN** 系统继续使用该功能当前的执行与响应协议，不要求它采用新 runId 或 SSE 协议

### Requirement: Run 执行与 SSE 连接解耦
系统 MUST 在持久后台队列中执行 Agent run，SSE 连接 SHALL 仅订阅运行事件。浏览器离开页面、主动中断 SSE 或 API 连接关闭 MUST NOT 向后台 Agent job 传播取消信号。

#### Scenario: 工具调用期间离开页面
- **WHEN** 用户在 `tool_call_started` 后关闭页面或中断 SSE
- **THEN** 后台 run 和当前工具调用继续执行，并在成功后提交完整 Agent state

#### Scenario: 完成后返回会话
- **WHEN** 用户在离开期间 run 已完成并重新打开会话
- **THEN** session snapshot 包含该 run 的完整助手消息、工具调用和工具结果，且系统不重复执行该 run

#### Scenario: 运行期间返回会话
- **WHEN** 用户在 run 尚未完成时重新打开会话
- **THEN** 系统返回当前 run display snapshot，并允许客户端订阅同一 run 的后续 SSE 事件

#### Scenario: API 进程重启
- **WHEN** SSE 所在 API 进程在后台 run 执行期间重启但队列和 Agent Worker 仍可用
- **THEN** run 继续执行，用户返回后仍能观察或读取其最终结果

### Requirement: 通用 SSE assistant 与工具事件
系统 SHALL 使用以下与业务阶段无关的事件：`run_snapshot`、`assistant_text_delta`、`tool_call_started`、`tool_call_arguments_delta`、`tool_call_finished`、`assistant_message_finished`、`tool_execution_started`、`tool_execution_progress`、`tool_execution_finished` 和 `run_finished`。所有增量事件 MUST 绑定 `runId` 和该 run 内单调递增的 `sequence`，Tool 事件 MUST 绑定 `toolCallId`；协议 MUST NOT 包含 setup phase、draft/trial pointer、operation attempt 或 speculative epoch。

#### Scenario: 渐进展示工具参数
- **WHEN** Agent 正在生成某个工具调用参数
- **THEN** 系统在 Tool 执行前发送 started 和原始 arguments delta，客户端按 `toolCallId` best-effort 渲染，并在 `tool_call_finished` 到达后以完整参数替换临时内容

#### Scenario: Tool 输出事件
- **WHEN** Tool 开始、报告部分结果并最终完成
- **THEN** 系统分别发送 `tool_execution_started`、可选 `tool_execution_progress` 与携带完整 result 和 `isError` 的 `tool_execution_finished`

#### Scenario: 重新连接时校正临时内容
- **WHEN** 客户端重新连接正在运行的 run 或 Worker 重试同一 run
- **THEN** 系统先发送含 `lastSequence` 的完整 `run_snapshot`，客户端替换本地临时运行状态后再消费 sequence 更大的事件，订阅建立前的动作以 snapshot 当前状态恢复

#### Scenario: 成功终止事件晚于提交
- **WHEN** Worker 完成 Agent loop
- **THEN** 系统仅在完整 Agent session 已成功提交后发送 `run_finished(status=completed)`

### Requirement: Agent 自主编排会话
系统 SHALL 在每次 run 中向 Agent 暴露相同的书籍读取、问题展示、独立产物发布、试读切片生成和 `complete_reading_setup` Tool。宿主 MUST NOT 根据旧 workflow 状态或显式 phase 决定 Agent 下一步。Tool SHALL 立即完成自身执行；若一个 assistant turn 中存在成功的 `present_question`、`publish_strategy`、`generate_trial_slice` 或 `complete_reading_setup`，Runner MUST 等该 turn 的全部 Tool 完成后结束 run，且 MUST NOT 要求该 Tool 是 turn 中唯一的 Tool。系统 SHALL NOT 强制收到 Trial confirmation 的 run 必须调用 complete。

#### Scenario: Agent 决定继续追问
- **WHEN** Agent 根据完整 session 和书籍上下文判断信息不足
- **THEN** Agent 可以调用 `present_question`，当前 turn 的全部 Tool 正常结束后 run 停止等待用户，而无需宿主进入 interviewing 状态

#### Scenario: Agent 根据结构化反馈重做产物
- **WHEN** 用户提交引用成功 `publish_strategy` 或 `generate_trial_slice` 的 `feedback` action
- **THEN** Agent 可以自行选择继续追问、重新发布单个产物或重新生成试读，而无需修改业务阶段或 supersede 旧工具结果

#### Scenario: 交互 Tool 与其他 Tool 共存
- **WHEN** 同一个 assistant turn 同时包含读取或发布 Tool 与任一成功的 `present_question`、`publish_strategy` 或 `generate_trial_slice`
- **THEN** 系统执行该 turn 的全部有效 Tool，并在整个 turn 完成后结束 run，不因等待用户动作的 Tool 不是唯一 Tool 而拒绝

#### Scenario: 用户回答启动下一 run
- **WHEN** 已提交 run 中的 question 卡片可操作，用户提交 `questionToolCallId`、selected option ids 和 free text
- **THEN** 系统保存该结构化 action 并以它作为下一次 Agent run 输入，而不是让前一个 Tool 跨进程等待

#### Scenario: 统一用户确认启动下一 run
- **WHEN** 用户提交 `{ type: 'confirmation', targetToolCallId }`，且目标是当前 session 中成功的 `publish_strategy` 或 `generate_trial_slice`
- **THEN** 服务端根据真实 Tool call 补充 `targetToolName`，以统一 confirmation 作为下一次 Agent run 输入，并在 run 成功后保存同一结构化 action

#### Scenario: 用户动作使用单一入口
- **WHEN** 用户提交 message、question answer、feedback 或 confirmation
- **THEN** 客户端统一调用 session actions 接口；`session_start` 仅可由宿主内部生成，旧 message、question answer、strategy confirmation 和 trial confirm 路由不可用

### Requirement: 有界且可继续读取的书籍 Tool
系统 SHALL 分离语义目录和 reading node 元数据：`get_book_outline` SHALL 只返回分页 outline，`list_reading_nodes` SHALL 返回分页节点元数据。正文读取与搜索 Tool MUST 设置服务端硬上限，并 MUST 返回足以继续读取的游标或截断信息。

#### Scenario: 目录不混入 reading nodes
- **WHEN** Agent 调用 `get_book_outline`
- **THEN** 结果只包含语义 outline 项、分页位置、总数和截断信息，不返回 reading node 列表或正文

#### Scenario: 分页列出 reading nodes
- **WHEN** Agent 调用 `list_reading_nodes` 并提供可选 section filter、offset 或 limit
- **THEN** 结果返回有限节点的稳定位置、顺序、标题路径、字符/块数量和 tailoring eligibility，以及下一页位置

#### Scenario: 正文带稳定切片坐标
- **WHEN** Agent 调用 `read_book_node`
- **THEN** 结果返回有限正文 blocks、每个 block 的 index/offset 边界、实际 page range、next start 和 truncated，使 Agent 能构造同节点内的 `BlockRange`

#### Scenario: 极端读取请求被限制
- **WHEN** Agent 请求超大目录页、节点正文页、搜索命中数或搜索 snippet
- **THEN** 系统将结果限制在服务端硬上限内，明确标记 truncated 或下一位置，且不返回无界全文

### Requirement: 产物由三个独立纯展示 Tool 发布
`publish_brief`、`publish_book_reader_profile` 和 `publish_strategy` SHALL 分别发布 brief、book reader profile 及 strategy。`publish_strategy` MUST 显式接收 `briefToolCallId`、`bookReaderProfileToolCallId`、strategy summary/core，并验证两个引用均为同 session 中对应类型的成功 Tool 调用。Tool SHALL 只校验并发布可渲染内容，SHALL NOT 在用户确认试读前写入相应业务行；成功结果 MUST 返回自身 `toolCallId`。系统 SHALL 允许同一 session 保留多个成功调用，且 SHALL NOT 自动选择 latest、创建 superseded 状态或递增产物 version。

#### Scenario: 三个产物独立发布
- **WHEN** Agent 分别调用三个 publish Tool 且参数有效
- **THEN** 系统把各自 Tool call/result 保存到 Agent session，并让前端按各 Tool 的展示规则渲染；strategy 结果保留本次使用的精确 brief/profile 引用

#### Scenario: Strategy 产物引用无效
- **WHEN** `publish_strategy` 引用不存在、失败、类型不符或不属于当前 session 的 brief/profile Tool call
- **THEN** Tool 返回错误，不发布可确认 strategy，且不自动替换为任意 latest 产物

#### Scenario: 卡片在参数生成时出现
- **WHEN** Agent 正在生成任一 publish Tool 的参数
- **THEN** 前端依据通用 Tool call arguments delta 渐进展示卡片内容，而不是等 Tool 执行结束后一次性出现

#### Scenario: 发布修订产物
- **WHEN** Agent 根据反馈再次调用任一 publish Tool
- **THEN** 新旧调用均保留，后续 Tool 必须显式引用具体 `toolCallId`

#### Scenario: 发布不写正式业务数据
- **WHEN** publish Tool 成功但用户尚未确认试读
- **THEN** 系统只在成功 run 提交时保存 Agent session，不创建 book reader profile、strategy draft 或 formal strategy 业务行

### Requirement: 单 reading node 连续切片试读
`generate_trial_slice` 每次调用 SHALL 只生成一个试读单元，入参 MUST 显式包含 `strategyToolCallId`、`sectionId`、`segment`、连续 `BlockRange` 和 reason。Tool MUST 使用被引用的同 session 成功 `publish_strategy`，并 MUST 验证 session 已保存引用该 Tool call 且 `targetToolName=publish_strategy` 的 confirmation action，或当前 run 的有效输入正是该 confirmation。Tool SHALL 沿 strategy 的明确引用取得 book reader profile，且 SHALL NOT 自动选择最新 strategy 或 profile。

#### Scenario: 成功生成一个试读切片
- **WHEN** Agent 引用用户已明确确认的成功 strategy call，并选择有效 `tailoringEligible` reading node 内的连续非空 range
- **THEN** Tool 对该 range 调用一次裁读生成，返回 source location/range、切片原文及完整 guide、annotations 和 afterReading，并把结果保存到成功 run 的 Agent session

#### Scenario: 未确认策略不能生成试读
- **WHEN** Agent 调用 `generate_trial_slice` 时引用的 strategy 尚无对应 confirmation
- **THEN** Tool 返回明确错误，不读取 latest strategy 代替、不生成试读，也不修改正式阅读数据

#### Scenario: 无效试读位置
- **WHEN** Agent 请求不存在、属于其他书籍、不可裁读、越界、非连续、为空或超过输入上限的 node/range
- **THEN** 工具返回明确错误，不生成试读结果，也不修改任何正式阅读数据

#### Scenario: 不创建 trial 业务数据
- **WHEN** `generate_trial_slice` 成功完成
- **THEN** 系统不创建 trial revision、trial segment、trial generation 或 reading setup operation 记录

### Requirement: 试读承担唯一用户确认界面
成功的 `generate_trial_slice` SHALL 同时提供试读内容和唯一一次用户确认入口。用户确认 SHALL 只保存对精确 Trial Tool call 的授权并启动下一次 Agent run；此时 MUST NOT 写入正式业务数据或激活 user-book。Agent 随后可调用无需用户再次操作的 `complete_reading_setup`。

#### Scenario: 试读完成后等待用户
- **WHEN** `generate_trial_slice` 成功并随 Agent run 一起提交
- **THEN** 客户端在同一 trial 组件内允许用户反馈或提交引用该 `trialToolCallId` 的 confirmation，而不渲染额外确认界面

#### Scenario: 未确认试读不激活
- **WHEN** 试读已经生成但用户尚未提交对应 `trialToolCallId`
- **THEN** user-book 保持 `on_shelf`，且系统不写入 brief、book reader profile 或 strategy 正式业务数据

#### Scenario: Run 完成不等于 setup 完成
- **WHEN** 生成试读的 Agent run 发送 `run_finished(status=completed)`
- **THEN** 该事件只表示本次 run 已提交，系统仍等待用户试读确认，不据此激活 user-book

### Requirement: Agent 完成 Reading Setup 并激活
`complete_reading_setup({ trialToolCallId })` SHALL 显式使用当前 session 中成功的 `generate_trial_slice`，并验证该精确 Trial 已由用户 confirmation、其 strategy 已由用户 confirmation、Trial result 与 arguments 引用同一 strategy，以及 strategy 显式引用成功的 brief 和 book reader profile。Tool SHALL 复用现有幂等激活事务写入正式数据并激活 user-book。被引用 trial SHALL 只作为确认前置证据，不写入 trial 业务表。为满足当前不可空外键与 `StrategySchema`，事务 SHALL 只补充必要结构外壳。

#### Scenario: Trial confirmation 不直接激活
- **WHEN** 用户确认成功的 Trial Tool call
- **THEN** 系统启动 Agent run，并仅在该 run 成功时保存 confirmation action；提交 action 本身不创建正式数据、不改变 user-book workflow

#### Scenario: Agent 调用 complete 后激活
- **WHEN** Agent 对已确认 Trial 调用 `complete_reading_setup`，Trial 引用链完整，shared book 可用且 user-book 仍为 `on_shelf`
- **THEN** 激活事务写入该引用图中的真实 profile、brief、strategy summary/core，创建 confirmed draft 与 formal strategy，更新 user-book pointers 与 `workflowStatus=active_reading`，保持 trial pointer 为空，并由成功 Tool result 保存完成结果

#### Scenario: 未确认 Trial 不能 complete
- **WHEN** `complete_reading_setup` 引用的 Trial 没有已保存 confirmation，且当前 run 输入也不是该 Trial 的有效 confirmation
- **THEN** Tool 返回明确错误，不自动选择其他 Trial，且不写入正式数据

#### Scenario: Agent 本轮未 complete
- **WHEN** Trial confirmation 触发的 Agent run 没有调用 `complete_reading_setup`
- **THEN** run 可以正常结束并保存 confirmation，user-book 保持 `on_shelf`，后续 run 仍可引用同一 Trial 完成 setup

#### Scenario: on_shelf 书存在旧结构残留
- **WHEN** 确认事务发现该 user-book 已有唯一 interview session 或既有 profile/draft/strategy versions
- **THEN** 系统复用并完成该 interview session，为本次真实 profile/draft/strategy 分配各表下一个 version，并原子把 pointers 切向本次数据

#### Scenario: 三个 trial candidates 仅为结构占位
- **WHEN** 事务构造当前 `StrategySchema` 要求的 `trialCandidates`
- **THEN** 系统从 manifest 确定性选择一个 `tailoringEligible` 节点并重复构造三个占位，且不把任何占位解释为或关联到本次真实试读

#### Scenario: 不创建真实 trial 或旧编排记录
- **WHEN** 用户确认并成功激活
- **THEN** 系统不创建 interview message、interview answer、trial revision、trial segment、trial generation、reading setup operation 或 formal generation 记录

#### Scenario: Complete 重放
- **WHEN** 相同 `trialToolCallId` 已成功完成 Reading Setup 后再次用于 complete
- **THEN** 系统返回既有激活结果，不重复插入正式数据或结构外壳

### Requirement: 极简单页验证 UI
首版 Web SHALL 在一个独立会话页面中渲染持久 session、可选 active run snapshot 和通用 SSE 事件，并 SHALL 按 Tool 名称选择 question、brief、book reader profile、strategy 和 trial slice renderer。Web MUST NOT 根据 Tool 顺序推断业务阶段或在旧 interview、strategy 和 trial 页面间跳转；`complete_reading_setup` 不提供第二个用户确认界面。

#### Scenario: 刷新已完成会话
- **WHEN** 用户刷新包含问题、独立产物和试读 Tool 结果的会话页
- **THEN** 页面仅根据 session snapshot 恢复相同消息与工具 UI，不请求旧 setup strategy 或 trial snapshot

#### Scenario: 验证实时卡片与交互
- **WHEN** Agent 流式生成 question、publish 或 trial 参数
- **THEN** 页面渐进显示字段，并在 run 成功提交后允许回答问题、反馈、确认 strategy 或在 trial 内提交唯一一次用户确认

#### Scenario: 未知工具安全降级
- **WHEN** session 或 SSE 包含当前 Web 未识别的工具名称
- **THEN** 页面显示通用工具状态/结果组件，且其余会话内容继续可用

#### Scenario: 激活后进入阅读器
- **WHEN** `complete_reading_setup` 成功且刷新后的 user-book 为 `active_reading`
- **THEN** 页面导航到现有 Reader，并由现有 Reader 按正式 profile/strategy pointers 加载原文与裁读生成窗口
