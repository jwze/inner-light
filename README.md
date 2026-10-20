# 心光 · INNER LIGHT

一个公开的互动文字星球：访客匿名提交念头，所有人的共鸣会聚合在同一颗公共星球中。

## 本地运行

需要 Node.js 18+：

```bash
npm start
```

打开 <http://localhost:3000>。

数据默认保存在 `data/planet.json`，该目录已加入 `.gitignore`，适合本地开发和小规模部署。可通过环境变量调整：

```bash
PORT=3000 DATA_DIR=./data ADMIN_TOKEN=change-me npm start
```

## 已实现能力

- 公共星球聚合数据，词语频率由服务端维护
- 服务端词语校验、最大词数限制和原子化的单进程写入队列
- 匿名 IP 哈希限流：每分钟和每小时两个窗口
- SSE 实时同步：其他访客提交时，词球会播放抵达动画
- 公共词球、最近抵达、总共鸣数和今日共鸣数
- 网络失败时回退到示例星球，并提供明确状态提示
- 分享按钮：支持 Web Share，不支持时复制当前链接
- `?planet=default` 预留主题星球入口
- 管理后台：`/admin`，使用 `X-Admin-Token` 访问导出和移除接口
- HTML、CSS、JavaScript 零第三方运行时依赖

## API

```text
GET  /api/planets/default/words
POST /api/planets/default/words       { "word": "旅行" }
GET  /api/planets/default/recent
GET  /api/planets/default/stats
GET  /api/planets/default/events      SSE
GET  /api/admin/export                X-Admin-Token
DELETE /api/admin/words/:word         X-Admin-Token
```

## 生产部署建议

当前实现使用 JSON 文件，优点是零依赖、易启动，适合单实例小型活动。正式多人生产环境建议将 `server.js` 的数据层替换为 PostgreSQL：

1. 用 `planet_words(planet_id, normalized_word, frequency)` 唯一索引保存聚合词语。
2. 用 `submissions` 表保存每次提交事件。
3. 使用 `INSERT ... ON CONFLICT DO UPDATE` 原子递增频率。
4. 使用 Redis 维护跨实例限流和发布订阅。
5. 使用反向代理配置 HTTPS、压缩、日志与备份。

当前管理员令牌必须通过环境变量设置；不要把它写进前端源码或提交到仓库。
