# 维护手册

## 开发流程

从 `main` 创建功能分支，修改后运行 `npm ci` 和 `npm run build`。提交 Pull Request，通过 GitHub `Build` 检查后合入 `main`；关联完成后 Cloudflare Builds 会自动部署。

`npm run lint` 是上游保留的客户端检查命令，构建检查不代表所有历史代码均已通过 lint 或类型检查。涉及登录、权限、存储和 MoeMemos 响应结构的修改，需要另外做对应功能回归。

## MoeMemos 兼容约定

| 接口或字段 | 当前适配 |
| --- | --- |
| `GET /api/v1/user/me` | 当前用户，角色为 `HOST` / `ADMIN` / `USER`，状态为 `NORMAL` / `ARCHIVED` |
| Memo 响应 | 保留客户端需要的 `creatorID`、`parentID`，同时兼容现有 Web 字段 |
| Memo 创建 | 成功返回 HTTP 200，避免旧客户端将已写入的数据误判为失败 |
| `POST /api/v1/resource/blob` | multipart 文件上传 |
| `POST /api/v1/resource` | multipart 上传或 JSON 外链资源 |
| Resource 响应 | `creatorID`、秒级时间戳、`externalLink` 等兼容字段 |
| `PATCH/DELETE /api/v1/resource/:id` | 资源更新、关联及删除 |
| `GET/POST /api/v1/tag` | 标签列表为字符串数组，创建返回标签字符串 |
| Web 标签适配 | `src/client/grpcweb.ts` 将字符串标签转换为页面所需对象 |

兼容逻辑位于 `src/server/handlers/{users,memos,resources,tags}.js`。升级上游或客户端后，应检查旧客户端依赖的大小写、状态码、时间单位和字段是否仍然存在。

回归步骤：登录 MoeMemos；创建一条私人测试笔记；刷新 Web 确认服务端写入；附加一张图片并在另一端打开；修改内容后再次同步；最后删除测试笔记和测试附件。只测试登录不足以确认写入和附件同步正常。

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
