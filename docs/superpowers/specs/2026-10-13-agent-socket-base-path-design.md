# Agent Socket 子路径支持设计

## 背景与目标

当前 Node 服务监听 `8787`，静态资源以根路径提供，HTTP 健康检查固定为 `/api/health`，WebSocket 固定为 `/ws`。前端 HTML 也使用 `/styles.css`、`/app.js` 绝对路径，因此直接通过 `/agent-socket` 访问时，应用资源与 WebSocket 路径无法跟随子路径。

腾讯云 Nginx 的现有规则使用正则 `location ~ ^/agent-socket(?:/|$)` 和不带 URI 部分的 `proxy_pass http://127.0.0.1:8787`，会将 `/agent-socket/...` 原样传给 Node。目标是在不改变该代理行为的前提下，让以下入口都可用：

- 本地根路径：`http://localhost:8787/`
- 子路径：`https://www.xyglassaccessories.com/agent-socket/`

## 方案

由 Node 应用自身兼容双路径，而不是要求 Nginx 去掉子路径前缀。HTTP 路由在处理资源前识别 `/agent-socket`，将其规范化到现有静态资源和健康检查路由；裸路径 `/agent-socket` 重定向到 `/agent-socket/`，确保相对资源 URL 正确解析。根路径请求保持原行为。

前端静态资源使用相对 URL，使根路径和带尾斜杠的子路径均可加载。WebSocket URL 根据当前页面路径计算：根页面连接 `/ws`，子路径页面连接 `/agent-socket/ws`。Node 的 upgrade 处理接受这两种路径，并将它们交给同一个 WebSocketServer。

## 请求路径

| 浏览器请求 | Node 处理 |
| --- | --- |
| `/` | 返回 `index.html` |
| `/styles.css`、`/app.js` | 返回静态资源 |
| `/api/health` | 返回健康状态 |
| `/agent-socket` | 重定向到 `/agent-socket/` |
| `/agent-socket/`、`/agent-socket/styles.css`、`/agent-socket/app.js` | 剥离应用前缀后按根路径处理 |
| `/agent-socket/api/health` | 剥离应用前缀后执行健康检查 |
| `/agent-socket/ws` | WebSocket upgrade，和 `/ws` 使用同一连接处理逻辑 |

## 错误处理与兼容性

- 不属于根路径或 `/agent-socket` 前缀的静态资源请求继续返回 404。
- WebSocket 仅接受 `/ws` 和 `/agent-socket/ws`；其他 upgrade 路径继续关闭连接。
- 保持已有根路径访问与本地 `npm run dev` 行为，不改变 Codex RPC、session 或消息协议。
- Nginx 保留 `/agent-socket` 前缀转发；部署 URL 的尾斜杠规范化由 Node 处理。

## 验收与测试

1. 根路径 `/`、`/styles.css`、`/app.js` 和 `/api/health` 行为不回归。
2. `/agent-socket` 返回重定向到 `/agent-socket/`。
3. 子路径页面、CSS、JS 和 `/agent-socket/api/health` 可正常加载。
4. 根路径 `/ws` 与子路径 `/agent-socket/ws` 均可完成 WebSocket upgrade；非法 upgrade 路径仍被拒绝。
5. 在现有 Nginx 正则代理配置下，浏览器访问 `https://www.xyglassaccessories.com/agent-socket` 可加载页面并连接 WebSocket。
