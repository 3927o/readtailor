## Why

新的 Agent-driven Reading Setup 已经成为唯一的阅读准备入口，但旧访谈、策略审核、试读编排仍保留完整的 Web、API、Agent 和队列执行代码，持续扩大维护面并模糊新旧系统边界。项目尚未上线，可以直接移除旧运行路径，同时保留当前数据库结构，避免把数据模型重构与代码清理耦合在同一次 change 中。

## What Changes

- **BREAKING** 删除旧 `/interview*`、`/strategy*`、`/trial*`、`/reading-setup-operation*` HTTP/SSE 接口及对应 Web 路由。
- 删除旧 Reading Setup Agent、状态机、operation、projection 和数据库队列式 trial generation 实现。
- Reader 路由直接挂载，Reader、新 Setup 和问 AI 继续使用的内容加载、画像加载、渲染组件及类型从旧流程模块中独立出来。
- 正式内容生成队列只接受 formal generation；新 Setup 的内存 trial slice 生成保持不变。
- 保留全部旧表、字段、迁移、数据库类型以及新 Setup 激活和预置书初始化的兼容写入。
- 不迁移旧 Setup 中间状态数据；旧中间 workflow status 在 Web 中只回退到书架。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `agent-driven-reading-setup`: 明确新 Setup 是唯一阅读准备入口，旧 HTTP/Web 编排入口不可用，且清理不得改变新 Session、激活兼容写入或 Reader 接续行为。

## Impact

- Web：删除旧 Setup 页面、controllers、SSE 状态和路由，迁移共享阅读内容组件与类型。
- API：删除旧路由和服务依赖，保留书架、Reader、问 AI、新 Setup 与正式生成窗口。
- Agent/Worker：删除旧 API 内 Reading Setup Agent 和队列式 trial 分支，保留通用 Agent Run Reading Setup handler 与内存 trial 工具。
- Contracts/Queue：删除仅服务旧 HTTP/SSE 的契约，正式生成 job 不再携带 scope。
- Database：schema、migrations、旧表和兼容写入均不变。
