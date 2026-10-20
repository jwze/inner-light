# 心光 · INNER LIGHT

一个公开的互动文字星球：访客匿名提交念头，所有人的共鸣会聚合在同一颗公共星球中。前端保留原有的 3D 词球和彗星动画，服务端使用 SQLite 持久化。

## 运行要求

- Node.js 24+（使用内置 `node:sqlite`，不需要安装原生 npm 数据库依赖）
- Docker Desktop（可选）

## 本机单机运行

```bash
cp .env.example .env
# 编辑 .env，至少设置 ADMIN_TOKEN
npm start
```

打开：<http://localhost:3000>

管理后台：<http://localhost:3000/admin>

SQLite 文件默认位置：

```text
data/inner-light.sqlite
data/inner-light.sqlite-wal
data/inner-light.sqlite-shm
```

这些运行时文件不会提交到 Git。

## Docker 运行

```bash
cp .env.example .env
docker compose up -d --build
```

默认打开：<http://localhost:3001>

查看状态和日志：

```bash
docker compose ps
docker compose logs -f
```

停止服务：

```bash
docker compose down
```

Docker 使用 named volume `planet-data` 保存 SQLite 数据，容器重建或重启不会丢失数据。

## 配置

```dotenv
PORT=3000
HOST=127.0.0.1
DATA_DIR=./data
DOCKER_PORT=3001
ADMIN_TOKEN=replace-with-a-long-random-token
MAX_SUBMISSIONS_PER_MINUTE=20
MAX_SUBMISSIONS_PER_HOUR=200
MODERATION_WORDS=
TRUST_PROXY=0
```

- `ADMIN_TOKEN` 为空时，管理接口关闭。
- `MODERATION_WORDS` 是逗号分隔的精确禁词列表。
- 只有在前置代理会覆盖 `X-Forwarded-For` 时才设置 `TRUST_PROXY=1`。
- 生产环境建议通过 HTTPS、反向代理和安全的随机管理员令牌部署。

## 公共 API

```text
GET  /api/health
GET  /api/planets/:slug/words
POST /api/planets/:slug/words       { "word": "旅行" }
GET  /api/planets/:slug/recent?limit=20
GET  /api/planets/:slug/stats
GET  /api/planets/:slug/events      SSE
```

不同 slug 对应独立 SQLite 星球，例如：

```text
http://localhost:3000/?planet=default
http://localhost:3000/?planet=summer-night
```

默认星球启动时创建；其他星球需管理员在后台输入 slug 并加载创建，匿名访问不会创建房间。最多 100 个星球。

## 管理 API 和后台

管理后台地址：`/admin`。请求必须携带：

```text
X-Admin-Token: <ADMIN_TOKEN>
```

接口：

```text
GET    /api/admin/export?planet=default
GET    /api/admin/words?planet=default
DELETE /api/admin/words/:word?planet=default
POST   /api/admin/words/:word/restore?planet=default
POST   /api/admin/clear?planet=default
POST   /api/admin/planet?planet=default
       { "name": "海洋星球", "theme": "ocean" }
```

管理后台支持：

- 查看真实提交总数、今日提交数、活跃访客和独立访客
- 搜索词语
- 屏蔽/恢复词语
- 屏蔽整颗星球
- 修改星球名称和主题（星云、海洋、森林）
- 查看管理操作记录
- 导出完整 JSON，包括词语、提交历史和审核记录

## 已实现能力

- 公共聚合词球，频率由服务端 SQLite 事务维护
- 105+ 并发提交下的原子频率递增
- 完整提交历史和准确的今日统计，不再截断为最近 100 条
- 匿名 HttpOnly Cookie 和 HMAC 标识
- IP + 访客双维度分钟/小时限流
- 服务端输入校验、请求体限制、同源写请求保护
- SQLite WAL、事务、重启持久化和旧 JSON 数据一次性迁移
- SSE 初始快照、心跳、自动重连后重新校准
- 15 秒轮询兜底，避免 SSE 断线遗漏数据
- 前端乐观动画、失败后权威数据校准、离线只读模式
- 公共最近抵达列表、统计显示和主题应用
- 分享按钮和 `?planet=` 分享链接
- 管理员屏蔽、恢复、批量屏蔽、主题设置、审计记录和完整导出
- Docker 健康检查和 named volume 持久化

## 数据库表

SQLite 中包含：

- `planets`：星球元数据、版本号
- `words`：公共词语、频率、隐藏状态、示例标识
- `submissions`：完整提交事件历史
- `visitors`：匿名访客首次/最近访问
- `rate_events`：持久化限流窗口
- `moderation_log`：屏蔽、恢复和批量操作记录
- `settings`：身份密钥和迁移标记

## 旧版本迁移

如果 `DATA_DIR` 下存在旧版本的：

```text
planet.json
planets/*.json
```

首次启动会将词语、提交记录、星球设置和版本信息迁移到 `inner-light.sqlite`。旧 JSON 文件不会自动删除，确认 SQLite 正常后可以手动归档。

## 检查

```bash
npm run check
git diff --check
```

注意：Node 24 的 `node:sqlite` 当前会显示 ExperimentalWarning，这是运行时提示，不影响功能。