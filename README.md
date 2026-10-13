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
CODEX_APPROVAL_POLICY=never
CODEX_SANDBOX_MODE=workspace-write
```

## Notes

- backend depends on local `codex` command
- backend uses Codex app-server WebSocket JSON-RPC, not fragile TUI scraping
- the first message in a fresh page creates a new Codex thread; select a thread in the sidebar to continue it
- current UI does not implement explicit approval dialogs
- default config uses `approvalPolicy=never` for smoother local bridge flow
