# Codex CLI Local Socket Bridge Design

## 1. Goal

Build local app with:

- Node.js backend as WebSocket bridge
- local Codex CLI subprocess per chat session
- web UI for task submit, streaming output, follow-up interaction
- clean local-only setup, no auth in v1

Success criteria:

- user opens browser UI locally
- user creates session, submits task
- backend starts Codex CLI process for session
- Codex CLI output streams back to UI in near real time
- when Codex CLI asks follow-up question, user replies in same chat
- session can be stopped, cleared, recreated without backend restart

## 2. Scope

### In scope

- single local user
- WebSocket transport between browser and Node backend
- one active Codex CLI subprocess per session
- multiple sessions visible in UI
- modern chat UI with streaming assistant output
- reconnect handling for browser refresh / short disconnect
- local persistence for lightweight session metadata and message history

### Out of scope for v1

- remote multi-user access
- auth / RBAC
- file upload
- markdown attachment rendering beyond plain chat text
- tool call visualization
- resumable Codex CLI process after backend process restart

## 3. Recommended architecture

```text
React UI
  ↕ WebSocket
Node server
  ├─ session manager
  ├─ ws event gateway
  ├─ codex process manager
  ├─ output parser / normalizer
  └─ local store (JSON)
        ↕
     Codex CLI subprocess
```

Why this shape:

- WebSocket fits bidirectional streaming chat
- Node `child_process.spawn` fits Codex CLI bridge
- React/Vite gives fast local UI and easy polished chat UX
- lightweight JSON store keeps v1 simple

## 4. Project structure

```text
client/
  src/
    app/
    components/
    hooks/
    lib/
    styles/
server/
  src/
    index.ts
    config.ts
    types.ts
    ws/
    sessions/
    codex/
    store/
shared/
  protocol.ts
docs/
  superpowers/specs/
```

## 5. Runtime model

### Session lifecycle

1. UI asks `session.create`
2. backend creates session id, stores session record
3. user submits first task with `task.submit`
4. backend spawns Codex CLI subprocess for session if not running
5. backend writes prompt text to subprocess stdin
6. subprocess stdout/stderr streamed back as normalized events
7. if Codex asks follow-up, UI sends `user.reply`
8. backend writes reply to same subprocess stdin
9. process exits → backend emits final status

### Process model

- one Codex CLI child process per active session
- session process killed when user manually stops session
- backend auto-cleans exited processes
- backend stores pid only as runtime field, not durable recovery field

## 6. Codex CLI bridge design

### Spawn strategy

Backend uses `spawn` with:

- command configurable by env, default `codex`
- args configurable by env
- `cwd` configurable by env
- `stdio: pipe`

### Input strategy

All user messages sent to active Codex process stdin with newline framing.

### Output strategy

Backend reads:

- `stdout` as main assistant stream
- `stderr` as status/error stream

Because Codex CLI output shape may vary by mode, backend normalizes transport into app-level events instead of assuming strict CLI JSON protocol in v1.

### Normalization rules

- stdout chunks append into current assistant streaming message
- stderr chunks become `status` or `error` message depending on heuristics
- process close emits `assistant.final` if stream still open, then `status`

### v1 assumption

Codex CLI accepts stdin interactive flow in current local setup. If local CLI later requires structured TTY handling, bridge layer will be swapped behind same app protocol.

## 7. WebSocket protocol

Shared protocol uses JSON messages:

### Client → server

- `session.create`
- `session.list`
- `session.select`
- `task.submit`
- `user.reply`
- `session.stop`
- `session.delete`
- `ping`

### Server → client

- `session.created`
- `session.snapshot`
- `assistant.delta`
- `assistant.final`
- `status`
- `error`
- `pong`

### Example envelopes

```json
{
  "type": "task.submit",
  "sessionId": "sess_123",
  "payload": {
    "text": "帮我重构这个模块"
  }
}
```

```json
{
  "type": "assistant.delta",
  "sessionId": "sess_123",
  "payload": {
    "messageId": "msg_456",
    "delta": "正在分析代码..."
  }
}
```

## 8. Persistence model

Local JSON storage file:

- session id
- title
- createdAt
- updatedAt
- status
- message list

Message record:

- id
- role: `user | assistant | system | error`
- text
- createdAt
- streaming flag

Reason:

- enough for browser refresh recovery
- no DB dependency
- easy inspect/debug

## 9. UI design

### Layout

- left sidebar: sessions list, create chat button
- main header: current session title + connection/process status
- message area: grouped chat bubbles, streaming cursor, timestamps
- composer: multiline input, send button, stop button

### Visual style

- dark premium theme
- soft gradients
- glass-like panels
- rounded message cards
- clear status chips
- smooth streaming and hover motion

### Interaction behavior

- enter sends, shift+enter newline
- while streaming, input still available for interruption/follow-up
- stop button ends active process
- reconnect banner shown if ws drops
- auto-scroll sticks to bottom unless user scrolls up manually

## 10. Error handling

Cases:

- Codex CLI command missing
- spawn failure
- broken stdin write
- subprocess unexpected exit
- ws disconnect
- malformed message
- JSON store read/write failure

Handling:

- convert each into user-visible `error` or `status`
- never crash whole server from one bad session
- failed session isolated from others
- store corruption falls back to empty session state with console warning

## 11. Testing strategy

### Server

- protocol validation unit tests
- session manager unit tests
- output normalization tests
- child process adapter tests with mocked process

### Client

- message reducer/state tests
- UI render tests for streaming, stop, reconnect banner

### Manual smoke flow

1. open UI
2. create session
3. send task
4. observe streamed output
5. send follow-up reply
6. stop session
7. refresh browser and verify history remains

## 12. Implementation phases

### Phase 1

- backend ws server
- session store
- Codex subprocess bridge
- base React chat UI

### Phase 2

- richer parser for Codex output states
- reconnect restoration
- better titles/session metadata

### Phase 3

- optional file context
- export chat
- optional CLI JSON mode support if available

## 13. Key decisions

1. Use WebSocket, not raw TCP
   - easier browser integration
   - simpler full-duplex chat

2. Use subprocess bridge, not custom Codex plugin first
   - fastest path to working local tool
   - keeps Codex CLI as source of truth

3. Use JSON store, not DB
   - lower setup cost
   - enough for local MVP

4. Use React/Vite, not plain HTML
   - better UI quality
   - easier componentized chat interactions

## 14. Approved design baseline for implementation

Implementation should produce:

- Node + TypeScript backend
- React + TypeScript frontend
- shared protocol types
- single command dev startup
- local polished chat UI
- Codex CLI interactive bridge through WebSocket
