# ReadTailor 单机部署

目标拓扑：Caddy 提供 Web 静态文件并将 `/v1/*` 反代到 API；API 和 Worker 由 systemd 各运行一个
Node.js 进程。PostgreSQL、Redis、对象存储、模型和 sandbox 都使用外部服务。

默认目标已经按当前服务器设置：

- SSH：`ali`
- 域名：`readtailor.narcissus.life`
- 发布根目录：`/opt/readtailor`
- 运行用户：`readtailor`
- Caddy：复用服务器现有实例，不覆盖其他站点

systemd 默认通过 `/usr/bin/node` 启动。若 Node 24 安装在其他系统级路径，先在 `deploy/deploy.env` 中
设置 `NODE_BIN`；不要使用只有 root 登录 shell 才能访问的 nvm 路径。

## 首次初始化

```bash
cp deploy/deploy.env.example deploy/deploy.env
deploy/scripts/bootstrap.sh
```

先由服务器管理员安装 Node.js 24。初始化脚本只检查 Node 主版本，不会配置 Node 软件源或升级 Node；
随后固定 pnpm 10.13.1，并创建运行用户、Python venv、发布目录和 systemd unit。它不会启动应用，也
不会修改当前 Caddy 站点。

然后填写线上密钥：

```bash
ssh ali
vi /etc/readtailor/readtailor.env
```

环境文件不得保留 `<...>` 占位符。至少需要配置 PostgreSQL、Redis、对象存储、全局模型、PPIO/E2B、
Cookie secret 和 system API token。`AUTH_DEVELOPMENT_ENABLED` 必须保持 `false`。

## 发布

```bash
deploy/scripts/preflight.sh
deploy/scripts/deploy.sh
```

本地 Node.js 为 24 时直接本地构建；否则脚本使用 `node:24-bookworm-slim` Docker 镜像构建。生产运行时
同样严格要求 Node.js 24。可以在 `deploy/deploy.env` 中用 `BUILD_MODE=local|docker`
固定构建方式，或用 `NODE_BUILD_IMAGE` 替换镜像源。服务器只安装 production dependencies，不在
2 GiB 机器上运行 TypeScript/Vite 构建。

发布顺序：上传新 release、安装依赖、安装 Python requirements、执行数据库 migration、原子切换
`current`、依次重启 API 和 Worker、检查健康状态、接管当前 ReadTailor Caddy 站点。失败时自动恢复
上一版应用软链。数据库 migration 是前向操作，不会自动回滚。

## 日常操作

```bash
deploy/scripts/status.sh
deploy/scripts/rollback.sh
deploy/scripts/rollback.sh 20260715090000-abcdef0
journalctl -u readtailor-api -f
journalctl -u readtailor-worker -f
```

默认只保留最近 5 个 release。Caddy 将上传限制设为 50 MB，这是针对当前约 1.6 GiB 实际内存的保护；
大书导入前应先升级到至少 4 GiB，或显式调整 `deploy/caddy/readtailor.caddy.template`。
