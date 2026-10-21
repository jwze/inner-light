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

## Docker 单实例部署（供用户自行执行）

以下教程仅作部署参考。用户当前明确禁止代理在其本机执行任何 Docker 相关操作，包括只读查询、配置校验、容器或守护进程交互；任务结束后也不得启动 Docker，除非用户明确更改这一约束。允许按需编辑 Dockerfile、Compose 和教程文本，不代表授权运行其中命令。

```bash
docker compose up -d --build
docker compose ps
docker compose logs -f
# 停止服务，保留数据卷
docker compose down
```

应用：<http://localhost:3001/>，管理后台：<http://localhost:3001/admin>。可通过 `.env` 的 `DOCKER_PORT` 修改端口；默认仅绑定本机。SQLite 数据继续使用原有的 `planet-data` 命名卷，升级时保持原 Compose 项目名，避免另建空卷。不要使用 `docker compose down -v`，该选项会删除数据卷。

部署只运行一个 Node.js 实例。SSE 在该进程内向当前连接的客户端推送更新，断线后通过重连快照和轮询校准。之前的双实例方案没有负载均衡器，两个端口需要分别访问；现已移除第二实例和 Redis 服务、配置、依赖，统一使用单实例入口。此配置不支持多副本间广播，也不是多服务器数据库复制；SQLite WAL 文件应保存在本机磁盘。

Compose 转发审核服务及超时、提交限流、`TRUST_PROXY` 和 `COOKIE_SECURE` 设置。通过 HTTPS 反向代理公开服务时，设置 `COOKIE_SECURE=1`；只有代理确实覆盖 `X-Forwarded-For` 时才开启 `TRUST_PROXY=1`。原双实例部署升级前先停止旧 `replica` 和 `redis` 容器，再使用新配置启动；可用 `docker compose up -d --build --remove-orphans` 清理旧项目容器。旧 `redis-data` 卷不会自动删除，也不再使用。

## 公开页面扩展

发送时词球保持正常旋转，已有词语不会因发射、新增或移除词语、实时同步、轮询、发送失败或离线排队而重新排列或重置位置。新公开词语从正面的随机落点加入，随后随词球继续旋转，发射轨迹和落点反馈跟随该位置。

再次发送已有词语时，原词保留原位，以短暂的私人正面文字和脉冲反馈帮助辨认；不会为此复制公开词条或改变真实计数规则。发送不会自动转动整个球来聚焦，也不会暂停等待；拖动和方向键始终可以接管视角。待审核、驳回、发送失败和离线排队只提供私人反馈，不提前加入公开词球或增加共鸣数。

### 二维码与 PNG 海报

点击“二维码与海报”，本地生成当前 URL 的二维码和 **1080×1440** 星球快照海报，包含当前角度的词球、星球名、真实共鸣统计和二维码。可分别下载 PNG、复制链接或调用系统分享。没有第三方截图上传。

分享弹窗使用简洁的单层布局，以大幅海报为主、二维码为辅；手机默认展示海报，可切换二维码。所有弹窗统一标题、字体和按钮。二维码、海报、趋势图、词语共现图及后台趋势图可点击或使用 Enter/空格进入全屏预览，支持缩放、拖动与双指缩放，按 Esc 或关闭按钮返回原界面。预览采用内容快照，海报生成内容保持不变。

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

后台“所有提交先审核”可配置房间预审（新房间默认关闭，提交直接公开；管理员可手动开启）：`pending → approved/rejected`。待审和驳回不会进入公开词球、趋势或真实共鸣数。审核通过只计数一次；重复审批返回冲突。屏蔽保留词频，阻止再提交；可恢复。操作记录包含操作者。

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

未配置外部 URL 时仅按房间人工预审设置工作，健康接口报告 `moderation:manual-only`。真实供应商调用需要你自己的账户、endpoint 和 API key；未配置凭据不等于已启用第三方服务，具体协议及故障路径需在目标环境验证。

## 多角色后台

1. 首次在 `/admin` 输入 `.env` 中的 ADMIN_TOKEN，加载星球，以引导所有者身份创建正式账户。
2. 普通管理员用用户名/密码登录，12 小时 HttpOnly、SameSite=Strict 会话；密码 scrypt 加盐保存，登录每 IP 每分钟最多 5 次。
3. 可创建、禁用、启用、变更角色和房间范围；权限变更使旧会话失效；最后一个账户所有者不能被禁用或降级。

| 角色 | 权限 |
|---|---|
| owner | 账户管理、设置、导入恢复、批量屏蔽及所有读/审核操作 |
| moderator | 指定房间读取、通过/驳回、屏蔽/恢复；不能导入、改设置或管理账户 |
| viewer | 指定房间只读 |

房间范围为逗号分隔 slug 或 `*`。非默认房间仅由 owner 显式创建，最多 100 个；加载或切换一个不存在的 slug 不会创建房间。后台的创建入口与现有星球切换入口分开，创建接口见下方说明。

ADMIN_TOKEN 仍是紧急引导凭据，设置高熵值或在创建 owner 后移除。默认本机绑定；公开部署必须 HTTPS、强密码、可信代理和备份。读角色可读取其房间的管理导出（含匿名关联标签），请只授权可信人员。

## 后台管理能力

后台已实现深绿侧栏与浅色卡片的分区管理台，以下入口接通管理接口；此前已通过 13 组管理接口检查，弹窗、图表预览及主要管理操作已完成桌面和手机浏览器检查，具体范围见 FEATURE_AUDIT.md：

- 总览：累计与今日共鸣、公开词语、待审数量、七天趋势、访客、热门词及最近提交；运行状态仅向 owner 展示。
- 星球：显式创建和切换现有星球；创建时填写 slug、名称、描述、主题、预审开关和是否加入示例词（`seed`）。设置支持编辑描述。
- 词库：创建词条并指定词频，编辑已有词频，勾选多项批量屏蔽或恢复。
- 审核：勾选多条待审提交，批量通过或驳回，并显示操作结果。
- 历史与审计：支持搜索、分页，保留操作者和审核结果，便于追踪变更。
- 账户：由 owner 重置账户密码，并使旧会话失效。
- 备份：提供 JSON/CSV 导出、导入与恢复入口；完整数据库灾备仍按下文说明操作。

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
POST /api/admin/planet?planet=default {name,description,theme,reviewMode}
```

后台还提供以下接口；房间级词库操作通过 `?planet=<slug>` 指定目标星球，并沿用角色和房间范围校验：

```text
POST /api/admin/planets {slug,name,description,theme,reviewMode,seed}
POST /api/admin/words?planet=default {word,frequency}
POST /api/admin/words/batch?planet=default {words,action:"hide"|"restore"}
POST /api/admin/reviews/batch?planet=default {ids,decision:"approved"|"rejected"}
GET  /api/admin/system  # 仅 owner
```

创建星球需要 owner 权限。`GET /api/admin/planets` 只列出现有且有权访问的星球；显式创建使用 `POST`。后台同时支持描述设置、词频编辑、历史/审计搜索分页及密码重置。

管理接口使用登录 Cookie，或引导令牌 `X-Admin-Token`。`analytics?days=7|30|90`，`recent?limit=1..50`。

## 检查与升级

```bash
npm ci
npm run build
npm run check
npm audit --omit=dev
git diff --check
```

`npm run check` 是保留的语法与 manifest 检查工具，`npm run build` 用于资源构建；它们不替代业务或浏览器验收。此前使用的管理接口与词球临时检查脚本已在验证后按清理约定删除，不作为长期 npm 命令。当前禁止代理执行任何本机 Docker 检查或操作。

启动时兼容旧 SQLite 表，保留原数据；旧 JSON `planet.json` / `planets/*.json` 首次迁移并保留源文件。部署升级前先备份 SQLite。旧 JSON 的历史缺失和累计基数无法凭空恢复。

验收范围见 [FEATURE_AUDIT.md](FEATURE_AUDIT.md)。
