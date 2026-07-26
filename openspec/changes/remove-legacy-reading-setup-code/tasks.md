## 1. Backend Setup Removal

- [x] 1.1 将 Reader、问 AI和正式生成使用的 manifest/HTML 与长期画像加载能力从旧 Setup 服务中独立出来
- [x] 1.2 删除旧 Setup API 路由、Reading Setup Engine、状态机、operation、projection 与 service，并解除 `UserBookService` 的旧 Engine 依赖
- [x] 1.3 删除旧 Agent Kit Reading Setup runner、stream parser 及专属测试，同时保留 normalization、book analysis、问 AI和新 Session runtime

## 2. Formal Generation Boundary

- [x] 2.1 将内容生成 queue payload 和 API enqueuer 收窄为不含 scope 的 formal-only job
- [x] 2.2 删除 Worker 数据库 trial generation 分支和专属测试，保留正式生成及新 Setup 内存 trial slice

## 3. Web Cutover

- [x] 3.1 将 Reader 和新 Setup 使用的内容渲染组件及正式内容类型迁出旧流程模块
- [x] 3.2 删除旧 Setup 页面、controllers、SSE/operation 状态和路由，旧中间 workflow status 回退书架

## 4. Contracts And Verification

- [x] 4.1 删除无生产消费者的旧 HTTP/SSE contracts 与 query keys，保留数据库 schema 所需类型
- [x] 4.2 更新路由、新 Setup、Reader、问 AI、预置书与正式生成测试
- [ ] 4.3 运行 OpenSpec validation、类型检查、测试、数据库测试和生产构建并修复回归
