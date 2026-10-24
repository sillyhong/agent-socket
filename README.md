# Agent Socket：本地 Codex 与公网网页对话

本文说明如何在 Mac 本地使用对话页面，以及如何通过腾讯云网站从公网发起任务，让任务在 Mac 上的 Codex app-server 和工作区中执行。

## 1. 工作方式

```text
本地浏览器 → Mac Node 服务 :8787 → Mac Codex app-server :8899

手机/公网浏览器 → HTTPS/Nginx → 腾讯云 Node 服务 :8787
                                ↑
Mac 上的 bridge:mac ──主动建立 WSS 反向连接──┘
                                ↓
                         Mac Codex app-server
                         Mac 工作区 CODEX_CWD
```

公网方案使用**反向连接**：Mac 主动连接腾讯云，不要求云端能访问 Mac 公网 IP，也不需要在路由器或公司 Wi-Fi 上开放 Mac 的 8899 端口。网页浏览器不会收到 Codex token。

## 2. 凭据说明

- `~/.codex/app-server.token`：Mac 本地 app-server 的 capability token。Mac 端组合脚本用它启动/连接 app-server。
- `CODEX_BRIDGE_TOKEN`：反向通道共享密钥。腾讯云 Node 服务和 Mac `bridge:mac` 必须设置成完全相同的值。按下方简化步骤，它直接复用 `app-server.token` 的内容；腾讯云 PM2 的隐藏输入提示中粘贴同一内容即可。
- 两种 token 都不要提交到 Git、写入网页代码或发送到聊天中。

如需让桥接密钥与 app-server token 分离，可另生成一个随机 bridge token，并通过你自己的安全方式分别设置到 Mac 和腾讯云：

```bash
openssl rand -hex 32
```

## 3. Mac：本地运行与连接 Codex

以下命令在 Mac 项目目录执行：

```bash
cd /Users/liangweihong/Documents/project/agent-socket
npm install
```

### 3.1 启动 Codex app-server

在一个终端启动 app-server。反向通道只需要本机访问，因此建议监听 loopback：

```bash
test -s "$HOME/.codex/app-server.token" || { echo '找不到 ~/.codex/app-server.token'; exit 1; }
codex app-server \
  --listen ws://127.0.0.1:8899 \
  --ws-auth capability-token \
  --ws-token-file "$HOME/.codex/app-server.token"
```

你也可以让它监听所有网卡：

```bash
codex app-server \
  --listen ws://0.0.0.0:8899 \
  --ws-auth capability-token \
  --ws-token-file "$HOME/.codex/app-server.token"
```

反向通道不需要 `0.0.0.0`；只有确实要让其他机器直接连接 Mac 时才使用它，并确保网络/防火墙限制了 8899 入站。路径必须写成 `"$HOME/.codex/app-server.token"`；不要写成 `"~/.codex/app-server.token"`，后者不会展开 `~`。

### 3.2 启动本地网页

另开一个终端：

```bash
cd /Users/liangweihong/Documents/project/agent-socket
export CODEX_CWD='/Users/liangweihong/Documents/project/agent-socket'
npm run dev
```

在 Mac 浏览器打开：<http://localhost:8787/>。`CODEX_CWD` 是**任务实际执行的 Mac 工作目录**；若要操作其他仓库，将它改成那个仓库的绝对路径。可以从 Finder 将文件夹拖进终端获取路径。

如果不手动启动 app-server，单独运行 `npm run dev` 也会尝试在 `127.0.0.1:8899` 启动它。若已按 3.1 启动，就不要再启动第二个占用 8899 的 app-server。

## 4. 腾讯云：Node 服务与 PM2

先把本项目部署到腾讯云。以下路径请替换为服务器上的真实项目目录：

```bash
cd /www/wwwroot/agent-socket
git pull
npm ci
```

云端 Node 服务在反向模式运行。`CODEX_CWD` 仍然填写 **Mac 上的工作区路径**，不是腾讯云路径。不要在反向模式设置 `CODEX_APP_SERVER_URL`、`CODEX_APP_SERVER_TOKEN` 或 `CODEX_APP_SERVER_TOKEN_FILE`。

### 首次通过 PM2 启动

```bash
cd /project/agent-socket
export CODEX_APP_SERVER_MODE=reverse
export CODEX_CWD='/Users/liangweihong/Documents/project/agent-socket'
printf '输入共享 CODEX_BRIDGE_TOKEN: '
IFS= read -r -s CODEX_BRIDGE_TOKEN
printf '\n'
export CODEX_BRIDGE_TOKEN

pm2 start npm --name local-socket-codex-bridge -- start
pm2 save
unset CODEX_BRIDGE_TOKEN
```

### 已有 PM2 服务时更新环境并重启

`export` 不会修改已经运行中的进程；必须在设置变量后，用 `--update-env` 重启。先从 `pm2 list` 确认应用名或 ID：

```bash
cd /project/agent-socket
export CODEX_APP_SERVER_MODE=reverse
export CODEX_CWD='/Users/liangweihong/Documents/project/agent-socket'
printf '输入与 Mac 完全相同的 CODEX_BRIDGE_TOKEN: '
IFS= read -r -s CODEX_BRIDGE_TOKEN
printf '\n'
export CODEX_BRIDGE_TOKEN

pm2 restart local-socket-codex-bridge --update-env
pm2 save
unset CODEX_BRIDGE_TOKEN
```

若 PM2 中的应用名不是 `local-socket-codex-bridge`，替换为 `pm2 list` 显示的名称或 ID。确认环境时只检查非密钥字段：

```bash
pm2 env <应用ID> | grep -E 'CODEX_APP_SERVER_MODE|CODEX_CWD'
```

应看到 `CODEX_APP_SERVER_MODE=reverse`。不要运行或粘贴会显示 `CODEX_BRIDGE_TOKEN` 值的命令输出。PM2 应由同一个 Linux 用户管理；此前由 root 启动的服务，就用 root 执行这些命令。

## 5. Nginx：挂载 `/agent-socket`

在对外 HTTPS 的 `server {}` 中加入以下 location。此写法保留 `/agent-socket` 前缀交给应用处理，`proxy_pass` 后面不要添加 URI 斜杠：

```nginx
location ~ ^/agent-socket(?:/|$) {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;

    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Authorization $http_authorization;

    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";

    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
}
```

检查并重载 Nginx：

```bash
nginx -t && systemctl reload nginx
```

访问页面：<https://xyglassaccessories.com/agent-socket/>。健康检查：

```bash
curl -i https://xyglassaccessories.com/agent-socket/api/health
```

## 6. Mac：连接云端反向通道

远程执行时只需在 Mac 项目目录运行下面这一条命令；**不要先在另一个终端手动启动 `codex app-server`**：

```bash
cd /Users/liangweihong/Documents/project/agent-socket
npm run bridge:mac:all
```

组合脚本会自动读取 `~/.codex/app-server.token`，并用它同时启动带 capability-token 鉴权的 app-server 和 Mac bridge。默认值来自本项目部署配置：`CODEX_BRIDGE_URL=wss://xyglassaccessories.com/agent-socket/bridge`，`CODEX_CWD` 为当前项目目录。腾讯云 PM2 的 `CODEX_BRIDGE_TOKEN` 必须设置为 `cat "$HOME/.codex/app-server.token"` 显示的同一段内容。不要把 token 写进命令参数或提交到 Git。

Mac 默认优先使用桌面 App 自带的 Codex 二进制，与桌面 App 写入的历史格式保持一致。启动日志会打印二进制路径和版本。若要指定其他程序，可设置 `CODEX_COMMAND`；已有 8899 监听器的版本与所选二进制不一致时，脚本会拒绝复用，并提示先停止旧进程。

若 app-server 尚未运行，脚本会启动它并等待 `/readyz` 成功，再启动 `npm run bridge:mac`。启动参数等价于：

```bash
codex app-server \
  --listen ws://0.0.0.0:8899 \
  --ws-auth capability-token \
  --ws-token-file "$HOME/.codex/app-server.token"
```

脚本会先复用已就绪的本机 app-server；如果想让脚本统一管理进程，请不要预先手动启动 app-server。默认监听 `0.0.0.0` 并启用 capability-token；反向通道本身只需本机访问，更安全的做法是运行 `CODEX_APP_SERVER_LISTEN='ws://127.0.0.1:8899' npm run bridge:mac:all`。如果保留 `0.0.0.0`，请用 macOS/公司网络防火墙限制 8899 入站。

组合脚本中的 app-server 和 bridge 会同时保持运行。按 `Ctrl+C` 会停止 bridge 和本脚本启动的 app-server；若复用的是已有 app-server，则不会停止它。Mac 本地网页 `npm run dev` 是第三个独立服务，需要时才在另一个终端启动。

同一网站只能运行一条 Mac bridge。重复执行命令会显示“Mac bridge 已在运行（PID ...）”，不会再启动第二套。需要重启时，在原终端按 `Ctrl+C`，或对提示中的启动器 PID 执行 `kill -TERM <PID>`，等退出后重新启动。如果云端主动用另一台 Mac 的连接替换本连接，旧 bridge 会退出，避免自动重连后互相抢占。

成功后终端应显示：

```text
Local Codex app-server ready at ws://127.0.0.1:8899
Reverse tunnel established to xyglassaccessories.com
```

保持这个终端运行。按 `Ctrl+C` 会断开公网反向通道；Mac 本地页面仍可单独使用。Mac 睡眠、断网或终端关闭时，公网页面无法让 Mac 执行任务；网络恢复后 connector 会自动重连。

## 7. 验收顺序

1. 先启动云端 PM2 服务。Mac connector 未连接时，health 通常为 HTTP 200，返回 `{"ok":true,"ready":false,"error":null}`；这是等待反向连接的状态。
2. 在 Mac 项目目录只执行 `npm run bridge:mac:all`。确认出现 `Reverse tunnel established`。
3. 再查 health，应为 HTTP 200 且 `ready: true`。
4. 打开 <https://xyglassaccessories.com/agent-socket/>，发送一个简单任务，确认回复来自 Codex。
5. 同时检查 <http://localhost:8787/>，确认 Mac 本地对话仍可工作。

## 8. 常见问题

- **打开历史会话时报 `failed to deserialize stored thread item ... unknown variant completed`**：旧版 app-server 不认识桌面 App 写入的新子任务记录。停止原来的 Mac 桥接/app-server，再运行 `npm run bridge:mac:all`，确认日志选择桌面 App 自带的 Codex；若曾设置 `CODEX_COMMAND` 指向旧版 CLI，先 `unset CODEX_COMMAND`。不需要删除或修改历史数据库。
- **Health 返回 `Timed out waiting for Codex app-server readyz`**：云端进程没有以反向模式启动，或 PM2 环境未更新。检查 `pm2 env <ID>` 中的 `CODEX_APP_SERVER_MODE=reverse`，然后用相同 Linux 用户执行 `pm2 restart <应用名或ID> --update-env`。
- **Mac connector 返回 HTTP 401**：检查云端反向模式已启用，且 Mac 与 PM2 的 `CODEX_BRIDGE_TOKEN` 完全一致。Nginx 需转发 `Authorization` 请求头。
- **刚连上就反复出现 `Codex app-server WebSocket closed`**：检查是否重复启动了 `start-mac-bridge.js` 或 `reverse-agent.js`。两条 bridge 会在云端互相替换。新版本已增加单实例锁、记录关闭来源/关闭码，并在重连后重新初始化、清理旧会话运行缓存。修改 `server/codex-rpc-client.js`、`server/index.js` 后，也需要更新腾讯云代码并重启 PM2。
- **Health 是 `ready:false`，但 error 为 null**：云端在等 Mac connector；检查 Mac 终端和 WSS 地址。
- **本机 app-server WebSocket 401**：确认 app-server 使用 `--ws-auth capability-token`，token 文件存在且路径正确。`~` 应写成 `"$HOME/..."`，不要把带引号的 `"~..."` 当作展开后的路径。
- **端口 8899 已占用**：不要同时启动两个 app-server。检查本机现有服务，确保本地 Node 和 connector 都连接同一个 `127.0.0.1:8899`。
- **本地页面可用但公网不可用**：检查 Nginx 是否命中正确的 HTTPS `server`，PM2 是否监听 `127.0.0.1:8787`，以及 `/agent-socket` location 是否保留路径前缀。

## 9. 常用命令

```bash
# 本地自动化测试
npm test

# 腾讯云查看状态与日志
pm2 list
pm2 logs local-socket-codex-bridge --lines 100

# 腾讯云健康检查
curl -i https://xyglassaccessories.com/agent-socket/api/health
```
