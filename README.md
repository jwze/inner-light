# 心光 · INNER LIGHT

公共旋转文字星球，Node.js 24 + SQLite + 原生浏览器前端。所有人共享房间词频，匿名发送；支持审核、PWA 离线发送、分享海报、趋势关系图和管理员分权。

## 本机运行

```bash
cp .env.example .env
# 编辑 .env，为 ADMIN_TOKEN 设置长随机值
npm ci
npm start
```

首页 <http://localhost:3000/>，后台 <http://localhost:3000/admin>。`npm start` 自动构建本地二维码组件和 PWA PNG 图标；无需 CDN。Node 内置 SQLite 当前会打印 ExperimentalWarning。

数据：`data/inner-light.sqlite`（WAL 模式）。`.env`、`data/`、`node_modules/`、生成的 `vendor/` 不提交 Git。

## Docker / Redis / 双实例

```bash
docker compose up -d --build
# 可选：启动共享本机 SQLite 卷的第二实例
docker compose --profile replica up -d --build
```

- 主实例：<http://localhost:3001/>
- 第二实例：<http://localhost:3002/>
- 管理后台：相应实例的 `/admin`
- Redis：Compose 内部网络，不公开端口
- SQLite 卷：`planet-data`；Redis 卷：`redis-data`

```bash
docker compose --profile replica ps
docker compose logs -f
docker compose --profile replica down
```

两个实例共享**同一台机器的** SQLite 卷，通过 Redis Pub/Sub 立即向其他实例的 SSE 客户端广播。不是多服务器数据库复制，不应把 WAL SQLite 放到网络文件系统。启动顺序由 Compose 保证先主实例完成迁移。Redis 故障时仍能提交 SQLite，客户端通过重连快照/15 秒轮询校准；Pub/Sub 不承诺历史消息重放。

## 公开页面扩展

### 二维码与 PNG 海报

点击“二维码与海报”，本地生成当前 URL 的二维码和 **1080×1440** 星球快照海报，包含当前角度的词球、星球名、真实共鸣统计和二维码。可分别下载 PNG、复制链接或调用系统分享。没有第三方截图上传。

二维码分享的是当前 URL。要让其他设备访问，应部署到可达的域名/局域网地址；`localhost` 二维码只适用于本机。

### 趋势与词语关系

“星球洞察”支持 7/30/90 天（UTC）的每日趋势、本期/上期热度增减及关系网络，附可访问的数据表。关系定义：同一匿名访客在 30 分钟内共同提交的词语，计算最近 3000 条已通过记录，最多 30 个节点/60 条边；**不是 AI 语义相似或个人关系推断**。公共接口不输出访客标识。

### PWA 和离线发送

安装支持的浏览器会显示“安装应用”。Service Worker 缓存公开应用壳，**不缓存后台或 API 响应**。最近公共数据另存本机缓存。离线打开、输入和发送会先写入 IndexedDB；恢复网络自动排队发送。

- 每项带稳定 `requestId`，服务端按星球+匿名访客+请求编号去重，避免响应丢失后重复计数。
- 页面/多标签/Service Worker 用 IDB 租约协调，不依赖单标签内存队列。
- 429、网络和 5xx 保留并退避；4xx 永久拒绝标为“需要处理”。
- “发送箱”可查看状态；被拒绝项可编辑/原文重试（新请求编号）或删除。
- 201 已通过、202 待审核/驳回都视为已送达，不反复重发。
- Background Sync 支持时可在页面关闭后重试；不支持时由下次打开/联网/定时器继续。
- 清浏览器数据会删除队列；清 Cookie 或更换设备会改变身份。请勿把此队列当作跨设备备份。
- 安装、Service Worker、剪贴板需要 HTTPS 或 localhost 安全上下文。

## 审核流程与第三方语义审核

后台“所有提交先审核”可配置房间预审（新房间默认开启）：`pending → approved/rejected`。待审和驳回不会进入公开词球、趋势或真实共鸣数。审核通过只计数一次；重复审批返回冲突。屏蔽保留词频，阻止再提交；可恢复。操作记录包含操作者。

环境配置支持 OpenAI-compatible moderation API：

```dotenv
MODERATION_URL=https://api.openai.com/v1/moderations
MODERATION_API_KEY=<通过本机环境或 .env 配置，不要提交>
MODERATION_MODEL=omni-moderation-latest
MODERATION_TIMEOUT_MS=5000
```

适配协议：

```text
POST MODERATION_URL
Authorization: Bearer MODERATION_API_KEY
{ "input": "提交文本", "model": "..." }
```

接受 `{results:[{flagged:boolean}]}`；标记为风险时转人工待审。也可接自有网关 `{decision:"approved"|"pending"|"rejected",reason:"..."}`。超时、5xx、格式错误**一律转待审**，不静默放行。房间预审开启时，即便语义服务通过也仍需人工审核。

未配置外部 URL 时仅按房间人工预审设置工作，健康接口报告 `moderation:manual-only`。代码适配及协议故障路径已验证；真实供应商调用需要你自己的账户、endpoint 和 API key，未配置凭据不等于已启用第三方服务。

## 多角色后台

1. 首次在 `/admin` 输入 `.env` 中的 ADMIN_TOKEN，加载星球，以引导所有者身份创建正式账户。
2. 普通管理员用用户名/密码登录，12 小时 HttpOnly、SameSite=Strict 会话；密码 scrypt 加盐保存，登录每 IP 每分钟最多 5 次。
3. 可创建、禁用、启用、变更角色和房间范围；权限变更使旧会话失效；最后一个账户所有者不能被禁用或降级。

| 角色 | 权限 |
|---|---|
| owner | 账户管理、设置、导入恢复、批量屏蔽及所有读/审核操作 |
| moderator | 指定房间读取、通过/驳回、屏蔽/恢复；不能导入、改设置或管理账户 |
| viewer | 指定房间只读 |

房间范围为逗号分隔 slug 或 `*`。非默认房间只有 owner 可创建（后台输入新 slug 后加载），最多 100 个。

ADMIN_TOKEN 仍是紧急引导凭据，设置高熵值或在创建 owner 后移除。默认本机绑定；公开部署必须 HTTPS、强密码、可信代理和备份。读角色可读取其房间的管理导出（含匿名关联标签），请只授权可信人员。

## CSV / JSON 导入恢复

后台支持：

- JSON 备份：词频、状态、完整提交历史（含审核状态）、星球设置和审核记录。
- CSV 词库：`word,frequency,hidden`，支持逗号/引号转义和 BOM；公式前缀安全转义并可往返导入。
- 合并：相同词频取最大值，历史按 sourceKey 去重，不重复累加；hidden/示例标识按导入值更新。
- 替换：必须输入 slug 确认；清空当前词库和提交历史后恢复，管理员账户/密钥/访客表不删除，管理审计链保留。
- 全量校验+SQLite 事务：错误文件不产生部分写入。单次最多 5MB、10000 条历史、160 个公开词。

CSV 只包含词库，不恢复历史统计。完整 JSON 导出可大于单次导入上限，大规模数据应使用 SQLite 备份。完整数据库灾备（含账户和密钥）请使用 SQLite Backup API 或停止服务后复制数据文件；不能只拷贝正在写入的主文件而忽略 WAL。

## 主要接口

```text
GET  /api/health
GET  /api/planets/:slug/words|recent|stats|events|analytics|relations
POST /api/planets/:slug/words {word,requestId}
POST /api/auth/login {name,password}
POST /api/auth/logout
GET  /api/auth/me
GET  /api/admin/planets
GET/POST /api/admin/users
POST /api/admin/users/:id
GET  /api/admin/export?planet=default
GET  /api/admin/export.csv?planet=default
POST /api/admin/import?planet=default {format:"json"|"csv",mode:"merge"|"replace",data?,content?,confirm?}
GET  /api/admin/reviews?planet=default
POST /api/admin/reviews/:id?planet=default {decision:"approved"|"rejected"}
DELETE /api/admin/words/:word?planet=default
POST /api/admin/words/:word/restore?planet=default
POST /api/admin/clear?planet=default
POST /api/admin/planet?planet=default {name,theme,reviewMode}
```

管理接口使用登录 Cookie，或引导令牌 `X-Admin-Token`。`analytics?days=7|30|90`，`recent?limit=1..50`。

## 检查与升级

```bash
npm ci
npm run build
npm run check
npm audit --omit=dev
git diff --check
```

启动时兼容旧 SQLite 表，保留原数据；旧 JSON `planet.json` / `planets/*.json` 首次迁移并保留源文件。部署升级前先备份 SQLite。旧 JSON 的历史缺失和累计基数无法凭空恢复。

验收范围见 [FEATURE_AUDIT.md](FEATURE_AUDIT.md)。
