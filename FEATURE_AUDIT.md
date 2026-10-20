# 扩展功能验收

本次已实现并验证此前列出的扩展能力。功能边界与真实供应商配置状态如下。

| 扩展 | 交付状态 | 验收证据 |
|---|---|---|
| 本地二维码 | 已完成 | `qrcode` 浏览器 bundle，浏览器生成 320×320 PNG Blob |
| PNG 星球海报 | 已完成 | 浏览器生成 1080×1440 PNG Blob，含当前词球、统计、二维码和 URL |
| 日/周/历史趋势 | 已完成 | `/analytics?days=7|30|90`，UTC 每日补零，前后周期热度 delta，浏览器 SVG 图表+表格 |
| 词语关系图 | 已完成 | `/relations`，同一匿名访客 30 分钟共现，节点/边上限，浏览器 SVG 网络图+表格 |
| PWA | 已完成 | manifest、Service Worker、PNG/SVG icon、公共 shell allowlist 缓存；后台/API 不缓存 |
| 离线待提交队列 | 已完成 | IndexedDB、稳定 requestId、IDB 跨标签租约、429/网络退避、Service Worker Background Sync、发送箱编辑/删除 |
| 请求幂等 | 已完成 | SQLite `(planet, visitor_hash, request_id)` 唯一索引；响应丢失重试不重复计数 |
| 待审核流程 | 已完成 | reviewMode、pending/approved/rejected、只审核一次、审计 actor、公开端只显示 approved |
| 第三方语义审核适配 | 已完成适配器 | OpenAI-compatible `results[].flagged` 和自有网关 decision 协议；超时/5xx/非法响应故障闭合为 pending |
| Redis 跨实例广播 | 已完成 | `realtime.js` Redis Pub/Sub；两 Node 进程和 Docker 两副本共享 SQLite、SSE 实测跨实例广播 |
| 多角色管理员 | 已完成 | owner/moderator/viewer、房间范围、scrypt 密码、12h HttpOnly 会话、登录限流、最后 owner 保护 |
| CSV 导出 | 已完成 | RFC 风格引号/逗号处理，公式前缀注入防护，浏览器下载接口 |
| CSV 导入 | 已完成 | word/frequency/hidden 校验、限制、事务、公式前缀还原 |
| JSON 导入合并 | 已完成 | sourceKey 去重、词频取最大、审计导入、事务回滚 |
| JSON 替换恢复 | 已完成 | slug 二次确认、事务清空并恢复词库/历史，管理员和密钥不删除 |
| 审核/导入审计 | 已完成 | moderation_log actor、设置/屏蔽/审核/导入记录 |

## 验收命令与结果

```text
npm run build                 PASS
npm run check                 PASS
npm audit --omit=dev         0 vulnerabilities
docker compose build         PASS
```

临时集成测试已覆盖：

- 语义供应商：通过、标记、直接拒绝、HTTP 500、超时
- 人工审核通过/驳回、重复审批冲突
- requestId 幂等
- analytics / relations
- owner/moderator/viewer 角色、房间范围、会话吊销、最后 owner 保护
- JSON merge/replace、错误输入事务不改变版本、CSV roundtrip 和公式注入防护
- 两个 Node 实例 / 两个 Docker 副本通过 Redis Pub/Sub 广播 SSE
- PWA shell 缓存 allowlist、无 API/admin 缓存
- 浏览器二维码 PNG、海报 PNG、趋势图、关系图、离线发送箱和断网后自动重试

## 第三方审核的必要外部条件

代码已提供第三方适配器，但真实供应商请求必须由部署者设置：

```dotenv
MODERATION_URL=https://api.openai.com/v1/moderations
MODERATION_API_KEY=...
MODERATION_MODEL=omni-moderation-latest
```

本仓库不包含任何真实密钥，也不能在没有用户账户/endpoint/key 的情况下声称已完成真实供应商网络验收。未配置时仅遵循房间的人工预审设置（默认关闭）；配置后按上表协议运行。

第三方适配器保留但当前未启用。按用户最新选择，新房间及当前运行房间默认关闭人工预审，提交直接公开；管理员仍可在后台单独开启预审。

## 明确边界

- Redis Pub/Sub 是跨实例实时广播，不是历史消息队列；断线依靠 SSE 快照和前端轮询校准。
- SQLite 共享卷适用于单机/同一 Docker 主机多进程；多主机需 PostgreSQL 或专门数据库，不应把 WAL 文件放网络文件系统。
- 词语关系是匿名共现统计，不是语义相似度、身份关系或推荐结论。
- PWA 发送箱是本设备队列，不是跨设备云端草稿；清理浏览器数据会删除队列。
