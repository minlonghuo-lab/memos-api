# Cloudflare 仓库自动部署

## 现有生产资源

| 项目 | 值 |
| --- | --- |
| Worker | `memos-api` |
| 生产分支 | `main` |
| D1 绑定 / 数据库 | `DB` / `memos_db` |
| D1 ID | `5ee1cb8f-0f6e-46ec-9f46-c2cfaec645e1` |
| R2 绑定 / 存储桶 | `BUCKET` / `memos` |
| 静态资源绑定 | `ASSETS` / `dist` |
| 时区 | `Asia/Shanghai` |
| 运行时密钥 | `JWT_SECRET` |

`wrangler.toml` 是此实例的部署配置。资源 ID 不是访问密钥。部署使用现有资源，已有数据和 Worker 域名设置应继续沿用。

## 首次关联仓库

1. 打开 [Workers & Pages](https://dash.cloudflare.com/?to=/:account/workers-and-pages)，进入已有的 `memos-api`，选择 **Settings > Builds > Connect**。
2. 连接 GitHub 账号 `minlonghuo-lab`，授权 Cloudflare Workers & Pages GitHub App 访问 `memos-api` 仓库。若列表中找不到仓库，检查 GitHub App 的仓库授权范围。
3. 选择 `minlonghuo-lab/memos-api`，生产分支设为 `main`。
4. 使用以下构建设置，然后保存并触发首次构建。

| 设置 | 值 |
| --- | --- |
| Worker 名称 | `memos-api`，必须与 wrangler.toml 一致 |
| Root directory | `/`，仓库根目录 |
| Build command | `npm run build:client` |
| Deploy command | `npx wrangler deploy` |
| Build variable | `NODE_VERSION=22` |
| 非生产分支自动构建 | 初始关闭，单独配置测试资源后再启用 |

Cloudflare 自动安装 npm 依赖，使用仓库锁定的 Wrangler 版本。可以使用 Cloudflare 在 Builds 中创建的部署 API Token；若平台提示资源访问权限不足，再按错误补充本账号所需的权限。

`JWT_SECRET` 已存在于当前 Worker 的 **Settings > Variables and Secrets** 中，关联 Git 不需要更换它，也不要把它添加到构建变量或仓库。更换签名密钥可能使已有令牌失效。

不要在构建或部署命令中添加 `npm run db:init` 或数据库迁移。普通发布只更新代码和静态资源。

## 发布验证

在 **Deployments / Build history** 中确认构建成功，部署来源的提交 SHA 与 GitHub `main` 一致，然后检查：

```bash
curl --fail https://memos-api.minlonghuo.workers.dev/api/v1/ping
# 预期：{"status":"ok"}
```

打开网页确认已有笔记和附件可访问，再按维护手册验证 MoeMemos 同步。GitHub 的 `Build` 工作流只验证编译；它成功不等于 Cloudflare 已经发布成功。Cloudflare Builds 独立响应分支推送，建议在功能分支通过检查后再合入 `main`。

## 手动发布和回滚

有需要时可在本地登录 Cloudflare 并发布：

```bash
npx wrangler login
npm ci
npm run build
npm run deploy
```

优先通过 Git revert 创建回退提交，让 Cloudflare 从 `main` 重新部署。紧急时可在 Cloudflare Deployments 中回滚到确认正常的版本，随后同步修正 Git 分支，避免下次推送再次发布问题代码。

代码回滚不会回滚 D1 数据或 R2 附件。数据库变更必须事先备份，并单独准备恢复方案。

## 部署到其他账号

只有部署全新实例时，才需要创建新的 D1 和 R2、更新 `wrangler.toml`、设置新的 `JWT_SECRET` 并执行 `npm run db:init`。不要对当前生产实例重复这一初始化流程。

参考：[Cloudflare Builds](https://developers.cloudflare.com/workers/ci-cd/builds/) · [构建配置](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)
