# 维护手册

## 开发流程

从 `main` 创建功能分支，修改后运行 `npm ci`、`npm test` 和 `npm run build`。提交 Pull Request，通过 GitHub `Build` 检查后合入 `main`；关联完成后 Cloudflare Builds 会自动部署。

`npm run lint` 是上游保留的客户端检查命令，构建检查不代表所有历史代码均已通过 lint 或类型检查。涉及登录、权限、存储和 MoeMemos 响应结构的修改，需要另外做对应功能回归。

## MoeMemos 兼容约定

| 接口或字段 | 当前适配 |
| --- | --- |
| `GET /api/v1/user/me` | 当前用户，角色为 `HOST` / `ADMIN` / `USER`，状态为 `NORMAL` / `ARCHIVED` |
| Memo 响应 | 保留客户端需要的 `creatorID`、`parentID`，同时兼容现有 Web 字段 |
| Memo 创建 | 成功返回 HTTP 200，避免旧客户端将已写入的数据误判为失败 |
| 个人完整同步 | 登录后 `GET /api/v1/memo?rowStatus=NORMAL` / `ARCHIVED` 未指定 `limit` 时返回当前用户的完整列表；不能静默截断为 20 条，否则 MoeMemos 2.0.7 会误判服务端删除 |
| 显式分页 | `limit` / `offset` 按笔记计数，先分页再关联附件；相同时间戳以 ID 稳定排序 |
| Memo 置顶 | `POST /api/v1/memo/:id/organizer` 返回完整 Memo，包括 `id`、`createdTs`、`content`；简短成功消息会导致 MoeMemos 解码失败 |
| Memo 附件编辑 | `PATCH` 的 `resourceIdList` 替换完整关联集合，`[]` 表示全部移除；省略表示保留 |
| 离线时间戳 | 创建保留 `createdTs`，修改支持 `updatedTs`，避免同步后改写客户端时间 |
| 读取认证 | 有凭证时统一验证 JWT、session、API Token；失效凭证返回 401，不能返回不完整的公开列表 |
| 资源完整列表 | 已登录 `GET /api/v1/resource` 未指定 `limit` 时返回当前用户全部资源 |
| `POST /api/v1/resource/blob` | multipart 文件上传 |
| `POST /api/v1/resource` | multipart 上传或 JSON 外链资源 |
| Resource 响应 | `creatorID`、秒级时间戳、`externalLink` 等兼容字段 |
| `PATCH/DELETE /api/v1/resource/:id` | 资源更新、关联及删除 |
| `GET/POST /api/v1/tag` | 标签列表为字符串数组，创建返回标签字符串 |
| Web 标签适配 | `src/client/grpcweb.ts` 将字符串标签转换为页面所需对象 |

兼容逻辑位于 `src/server/handlers/{users,memos,resources,tags}.js`。升级上游或客户端后，应检查旧客户端依赖的大小写、状态码、时间单位和字段是否仍然存在。

回归步骤：登录 MoeMemos；创建一条私人测试笔记；刷新 Web 确认服务端写入；附加一张图片并在另一端打开；修改内容后再次同步；最后删除测试笔记和测试附件。只测试登录不足以确认写入和附件同步正常。

`npm test` 使用 Miniflare 的隔离 D1/R2，不访问生产。覆盖超过 20 条的普通及归档同步、多账户权限、JWT/API Token、附件分页及替换、置顶响应、离线时间戳和超过单批参数数量的元数据读取。

已有异常数据不要按正文自动去重：同正文可能对应不同附件或手机端冲突副本。部署兼容修复前先保留手机未同步内容；部署后先只读核对完整列表与 D1 数量，再进行手机同步。不要直接卸载客户端或清空本地数据库。

## 数据和密钥

GitHub 保存源码及配置，D1 保存用户和笔记等记录，R2 保存附件。仓库不是数据备份。

修改数据库结构前，将导出写到仓库忽略的目录：

```bash
mkdir -p backups
npx wrangler d1 export memos_db --remote --output backups/memos-db-before-change.sql
```

导出可能包含私人笔记、账户及令牌信息，应保存在受控位置；R2 需要另行备份，D1 导出不包含附件文件。`migrations/` 中是历史脚本，有些脚本包含表重建，不是可以对生产库逐个重放的迁移队列。

确需迁移时，先检查当前表结构、审查对应 SQL，再显式执行选定的文件：

```bash
npx wrangler d1 execute memos_db --remote --file migrations/REVIEWED_MIGRATION.sql
```

上面的文件名是占位符。当前部署流程不自动迁移，之前的一次性数据导入接口和导入密钥也不属于本仓库。

## 跟进上游

在本地将 `https://github.com/jkjoy/cfmemos.git` 配置为 `upstream`，在独立分支比较更新。上游当前基线为 `f3f8175eb94687fe689b36abe693e6c829650a06`。优先审查登录、资源、标签和部署配置的差异，避免覆盖此实例的 MoeMemos 适配及 D1 绑定。
