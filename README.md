# Cloudflare Memos

基于 Cloudflare Workers、D1、R2、Hono 和 React 的单体备忘录应用。整个仓库只有一个 Node.js 工程、一个依赖目录和一个部署入口。

## 目录结构

```text
src/client/  React 客户端源码
src/server/  Hono 服务端源码
migrations/  D1 数据库迁移
public/      公共静态资源
```

## 本地开发

需要 Node.js 22+ 和 Cloudflare Wrangler 登录状态。

```bash
npm ci
copy .dev.vars.example .dev.vars
npm run db:local
npm run dev
```

`npm run dev` 会先构建 React，再启动统一应用，默认访问 `http://localhost:8787`。只开发页面时可运行 `npm run dev:client`，Vite 会把 API 请求代理到 8787 端口。

## 部署

先在根目录 `wrangler.toml` 填写自己的 D1 数据库和 R2 存储桶，再配置密钥：

```bash
npx wrangler secret put JWT_SECRET
npm run db:init
npm run deploy
```

`npm run deploy` 会构建客户端并将完整应用一次性发布到 `memos-api` Worker。GitHub Actions 使用相同流程，只需配置 `CLOUDFLARE_API_TOKEN` 和 `CLOUDFLARE_ACCOUNT_ID`。

## 常用命令

```bash
npm run build       # 构建客户端并验证 Worker 打包
npm run dev         # 启动一体化本地服务
npm run dev:client  # 启动客户端热更新服务
npm run deploy      # 构建并部署完整应用
npm run db:local    # 初始化本地 D1
npm run db:init     # 初始化远程 D1
```
