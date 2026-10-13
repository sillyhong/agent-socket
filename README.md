# Local Socket Codex Bridge

Browser chat UI + Node WebSocket server + Codex CLI `app-server` bridge.

## What it does

- beautiful local chat UI
- browser ↔ Node via WebSocket
- Node ↔ `codex app-server --listen ws://127.0.0.1:<port>` via JSON-RPC
- create sessions
- send tasks
- stream partial assistant output
- follow-up in same session
- resume existing Codex threads before reading or sending follow-up messages
- if another Codex client owns the thread writer, fork a history-preserving web branch before sending
- stop active turn
- reload and reopen old sessions from Codex thread history
- browse unarchived history across projects, grouped by working directory

## Run

```bash
npm install
npm start
```

Open:

```text
http://localhost:8787
```

The service also supports the `/agent-socket/` mount path for reverse proxies. With the current Nginx regex location, keep `proxy_pass http://127.0.0.1:8787;` without a trailing URI slash so the prefix is forwarded to this app. Both `/` and `/agent-socket/` remain available.

Run path handling tests with:

```bash
npm test
```

## Key env vars

```bash
PORT=8787
CODEX_COMMAND=codex
CODEX_CWD=/absolute/workspace/path
CODEX_APP_SERVER_PORT=8899
CODEX_APP_SERVER_URL=wss://codex.example.com
CODEX_APP_SERVER_TOKEN=your-app-server-token
CODEX_APP_SERVER_TOKEN_FILE=/absolute/path/to/app-server.token
CODEX_APP_SERVER_MODE=reverse
CODEX_BRIDGE_TOKEN=your-shared-bridge-secret
CODEX_APPROVAL_POLICY=never
CODEX_SANDBOX_MODE=workspace-write
```

By default, the bridge connects to a local app-server on `127.0.0.1:$CODEX_APP_SERVER_PORT`, starts one if needed, and reads `~/.codex/app-server.token` when that token file exists. Set `CODEX_APP_SERVER_URL` to connect to an existing app-server instead; when set, the bridge will not try to start another one. Provide its raw token using `CODEX_APP_SERVER_TOKEN` or `CODEX_APP_SERVER_TOKEN_FILE`; it is sent as an HTTP Bearer token during the WebSocket handshake. Use `wss://` for remote connections; the token is rejected for non-loopback `ws://` URLs.

For a Mac behind NAT/company Wi-Fi, use reverse mode on the cloud service. This does not change local development: running `npm run dev` on the Mac without `CODEX_APP_SERVER_MODE=reverse` still starts/uses the local Codex app-server as before. On the cloud Node service, set `CODEX_APP_SERVER_MODE=reverse`, `CODEX_BRIDGE_TOKEN`, and `CODEX_CWD` (the absolute workspace path on the Mac). Do not set `CODEX_APP_SERVER_URL` in reverse mode.

On the Mac, run this project and start its outbound connector:

```bash
CODEX_BRIDGE_URL=wss://xyglassaccessories.com/agent-socket/bridge \
CODEX_BRIDGE_TOKEN='<same-secret-as-cloud>' \
CODEX_CWD='/Users/liangweihong/Documents/project/agent-socket' \
npm run bridge:mac
```

The connector starts or reuses a loopback-only app-server, establishes an authenticated outbound WebSocket to the cloud Node service, and reconnects if the network drops. Local browser access continues using the Mac's local Node service; public browser access uses the cloud service and the Mac tunnel. Both may share the same local app-server. The token is server-side only and never sent to browser JavaScript.

## Notes

- backend depends on local `codex` command
- backend uses Codex app-server WebSocket JSON-RPC, not fragile TUI scraping
- the first message in a fresh page creates a new Codex thread; select a thread in the sidebar to continue it
- current UI does not implement explicit approval dialogs
- default config uses `approvalPolicy=never` for smoother local bridge flow
