# memos-api

基于 [jkjoy/cfmemos](https://github.com/jkjoy/cfmemos) 维护的 Cloudflare Memos，包含已在现有实例验证的 MoeMemos 兼容修改。React 页面和 Hono API 由同一个 Cloudflare Worker 提供，笔记存储在 D1，附件存储在 R2。

- 仓库：[minlonghuo-lab/memos-api](https://github.com/minlonghuo-lab/memos-api)
- 线上实例：<https://memos-api.minlonghuo.workers.dev>
- 部署说明：[Cloudflare Builds](docs/deployment.md)
- 日常维护、备份与兼容说明：[维护手册](docs/maintenance.md)

## 目录

```text
src/client/        React 客户端
src/server/        Hono API 和 MoeMemos 兼容逻辑
public/            静态资源
schema.sql         新数据库的初始结构
migrations/        历史迁移脚本，按需审查后手动执行
docs/              部署和维护文档
.github/workflows/ 构建检查，不发布到生产
wrangler.toml      当前生产 Worker、D1、R2 绑定
```

## 本地开发

使用 Node.js 22 和 npm，依赖版本以 `package-lock.json` 为准。

```bash
nvm use
npm ci
cp .dev.vars.example .dev.vars
# 将 .dev.vars 中 JWT_SECRET 的占位值替换为本地随机密钥
npm run db:local
npm run dev
```

访问 <http://localhost:8787>。本地 Wrangler 默认使用本地 D1/R2。修改客户端时，可以在另一个终端执行 `npm run dev:client`，Vite 会将 API 代理到 8787。

## 构建与发布

```bash
npm run build       # 构建客户端并验证 Worker 打包，不发布
npm run deploy      # 有 Cloudflare 权限时手动构建并发布
npm run tail        # 查看 Worker 日志
```

推荐在现有 `memos-api` Worker 的 **Settings > Builds** 中关联本仓库的 `main` 分支。构建命令为 `npm run build:client`，部署命令为 `npx wrangler deploy`，根目录为 `/`。关联步骤、密钥和首次部署检查见 [部署说明](docs/deployment.md)。

`JWT_SECRET` 保存在 Cloudflare Worker Secrets，本地使用未跟踪的 `.dev.vars`。数据库导出、笔记、附件、令牌和临时导入脚本不应提交到仓库。

## MoeMemos

在 MoeMemos 中填写实例根地址 `https://memos-api.minlonghuo.workers.dev`。当前适配沿用 Memos 0.21 风格的 `/api/v1` API，覆盖已验证的登录、笔记同步及附件上传流程，不代表实现了所有 Memos 版本的完整 API。具体字段和维护回归步骤见 [维护手册](docs/maintenance.md)。

## 上游来源

本仓库保留 cfmemos 的 Git 历史，便于比较和选择性合并上游更新。项目依赖及其许可证信息保留在源码和 npm 元数据中。
