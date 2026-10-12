import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { WebSocketServer } from "ws";
import { config, publicDir, workspaceRoot } from "./config.js";
import { CodexRpcClient } from "./codex-rpc-client.js";
import {
  createTitleFromText,
  extractResponseItemText,
  makeStreamingMessage,
  normalizeThreadSnapshot,
  normalizeThreadSummary
} from "./session-mapper.js";

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

const codex = new CodexRpcClient(config);
const wss = new WebSocketServer({ noServer: true });
const clients = new Set();
const threadRuntime = new Map();
const streamState = new Map();
const resumedThreads = new Map();
let availableModelsPromise = null;

let bootstrapError = null;

boot().catch((error) => {
  bootstrapError = error;
  console.error(error);
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === "/api/health") {
    const payload = {
      ok: !bootstrapError,
      ready: codex.ready,
      error: bootstrapError?.message || null
    };
    res.writeHead(payload.ok ? 200 : 500, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(payload));
    return;
  }

  serveStatic(url.pathname, res);
});

server.on("upgrade", (req, socket, head) => {
  if (req.url !== "/ws") {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

wss.on("connection", async (ws) => {
  clients.add(ws);

  ws.on("close", () => {
    clients.delete(ws);
  });

  ws.on("message", async (raw) => {
    try {
      const message = JSON.parse(raw.toString("utf8"));
      await handleClientMessage(ws, message);
    } catch (error) {
      send(ws, "error", { message: error.message || "Bad client message" });
    }
  });

  await sendBootstrap(ws);
});

server.listen(config.port, () => {
  console.log(`Local Socket Codex Bridge listening on http://localhost:${config.port}`);
});

async function boot() {
  wireCodexNotifications();
  await codex.start();
}

function wireCodexNotifications() {
  codex.on("stderr", (text) => {
    broadcast("status", { level: "stderr", message: text.trim() });
  });

  codex.on("protocolError", (error) => {
    broadcast("error", { message: error.message });
  });

  codex.on("exit", ({ code, signal }) => {
    broadcast("error", {
      message: `Codex app-server exited. code=${code} signal=${signal}`
    });
  });

  codex.on("notification", async ({ method, params }) => {
    try {
      if (method === "thread/status/changed") {
        const runtime = ensureThreadRuntime(params.threadId);
        runtime.status = params.status?.type || "unknown";
        broadcast("session.status", {
          sessionId: params.threadId,
          status: runtime.status
        });
      }

      if (method === "turn/started") {
        const runtime = ensureThreadRuntime(params.threadId);
        runtime.activeTurnId = params.turn.id;
        runtime.status = "active";

        broadcast("session.status", {
          sessionId: params.threadId,
          status: "active",
          turnId: params.turn.id
        });
      }

      if (method === "item/agentMessage/delta") {
        const key = `${params.threadId}:${params.itemId}`;
        let current = streamState.get(key);

        if (!current) {
          current = makeStreamingMessage({
            threadId: params.threadId,
            itemId: params.itemId,
            delta: ""
          });
          streamState.set(key, current);
        }

        current.text += params.delta;

        broadcast("assistant.delta", {
          sessionId: params.threadId,
          messageId: current.id,
          delta: params.delta
        });
      }

      if (method === "rawResponseItem/completed") {
        const text = extractResponseItemText(params.item);
        if (!text) return;

        const key = `${params.threadId}:${params.item.id || params.turnId}`;
        const current = streamState.get(key);

        if (current) {
          current.text = text;
          broadcast("assistant.final", {
            sessionId: params.threadId,
            messageId: current.id,
            text,
            phase: params.item.phase || "final_answer"
          });
          streamState.delete(key);
          return;
        }

        broadcast("assistant.final", {
          sessionId: params.threadId,
          messageId: `${params.threadId}:${params.turnId}:${crypto.randomUUID()}`,
          text,
          phase: params.item.phase || "final_answer"
        });
      }

      if (method === "turn/completed") {
        const runtime = ensureThreadRuntime(params.threadId);
        runtime.activeTurnId = null;
        runtime.status = params.turn.status || "idle";

        await pushThreadSnapshot(params.threadId);
      }

      if (method === "error") {
        broadcast("error", {
          sessionId: params.threadId,
          turnId: params.turnId,
          message: params.error?.message || "Thread error"
        });
      }
    } catch (error) {
      broadcast("error", { message: error.message || "Notification handling failed" });
    }
  });
}

async function handleClientMessage(ws, message) {
  switch (message.type) {
    case "session.list": {
      const { sessions, error } = await listSessions();
      send(ws, "sessions", { sessions });
      if (error) send(ws, "error", { message: error });
      return;
    }

    case "session.create": {
      const defaultModel = await getSupportedDefaultModel();
      const thread = await codex.startThread({
        cwd: config.cwd,
        approvalPolicy: config.approvalPolicy,
        sandbox: config.sandboxMode,
        model: defaultModel,
        serviceName: config.serviceName
      });
      resumedThreads.set(thread.thread.id, Promise.resolve(thread));

      const title = message.title?.trim() || "New session";
      await codex.setThreadName({ threadId: thread.thread.id, name: title });

      await pushThreadSnapshot(thread.thread.id, ws);
      await pushSessions(ws);
      return;
    }

    case "session.open": {
      await pushThreadSnapshot(message.sessionId, ws);
      return;
    }

    case "message.send": {
      const text = String(message.text || "").trim();
      if (!text) return;

      const defaultModel = await getSupportedDefaultModel();
      let threadId = message.sessionId;
      let modelOverride = null;
      if (!threadId) {
        const thread = await codex.startThread({
          cwd: config.cwd,
          approvalPolicy: config.approvalPolicy,
          sandbox: config.sandboxMode,
          model: defaultModel,
          serviceName: config.serviceName
        });
        threadId = thread.thread.id;
        resumedThreads.set(threadId, Promise.resolve(thread));
        await codex.setThreadName({
          threadId,
          name: createTitleFromText(text)
        });
        await pushSessions();
      } else {
        const resumed = await resumeOrForkThread(threadId, ws, defaultModel);
        threadId = resumed.threadId;
        modelOverride = resumed.modelOverride;
      }

      if (modelOverride) {
        send(ws, "status", {
          level: "info",
          message: `此会话模型与网页账户不兼容，网页已切换到 ${modelOverride}。`
        });
      }

      send(ws, "user.echo", {
        sessionId: threadId,
        message: {
          id: `user:${crypto.randomUUID()}`,
          role: "user",
          text,
          phase: "final",
          createdAt: Math.floor(Date.now() / 1000)
        }
      });

      const turnParams = {
        threadId,
        clientUserMessageId: `user-${crypto.randomUUID()}`,
        input: [
          {
            type: "text",
            text,
            text_elements: []
          }
        ]
      };

      try {
        await codex.startTurn({ ...turnParams, ...(modelOverride ? { model: modelOverride } : {}) });
      } catch (error) {
        if (modelOverride || !isUnsupportedModelError(error)) throw error;
        await codex.startTurn({ ...turnParams, model: defaultModel });
        send(ws, "status", {
          level: "info",
          message: `当前会话模型与网页账户不兼容，已切换到 ${defaultModel}。`
        });
      }

      await pushSessions();
      return;
    }

    case "session.interrupt": {
      const runtime = ensureThreadRuntime(message.sessionId);
      if (!runtime.activeTurnId) return;

      await codex.interruptTurn({
        threadId: message.sessionId,
        turnId: runtime.activeTurnId
      });

      return;
    }

    case "session.delete": {
      await codex.deleteThread({ threadId: message.sessionId });
      threadRuntime.delete(message.sessionId);
      send(ws, "session.deleted", { sessionId: message.sessionId });
      await pushSessions();
      return;
    }

    default: {
      send(ws, "error", { message: `Unsupported message type: ${message.type}` });
    }
  }
}

async function sendBootstrap(ws) {
  if (bootstrapError) {
    send(ws, "bootstrap", {
      ready: false,
      workspaceRoot,
      error: bootstrapError.message,
      sessions: []
    });
    return;
  }

  try {
    const { sessions, error } = await listSessions();
    send(ws, "bootstrap", {
      ready: codex.ready,
      workspaceRoot,
      sessions,
      error
    });
  } catch (error) {
    send(ws, "bootstrap", {
      ready: codex.ready,
      workspaceRoot,
      sessions: null,
      error: error.message || "Failed to load conversation history"
    });
  }
}

async function pushSessions(targetWs = null) {
  const { sessions, error } = await listSessions();
  if (targetWs) {
    send(targetWs, "sessions", { sessions });
    if (error) send(targetWs, "error", { message: error });
    return;
  }
  broadcast("sessions", { sessions });
  if (error) broadcast("error", { message: error });
}

async function listSessions() {
  const threads = [];
  const seenCursors = new Set();
  let cursor = null;
  let error = null;

  while (true) {
    if (cursor && seenCursors.has(cursor)) {
      error = "Conversation history pagination returned a repeated cursor";
      break;
    }
    if (cursor) seenCursors.add(cursor);

    let response;
    try {
      response = await codex.listThreads({
        archived: false,
        limit: 100,
        ...(cursor ? { cursor } : {})
      });
    } catch (requestError) {
      if (!threads.length) throw requestError;
      error = requestError.message || "Failed to load the next conversation history page";
      break;
    }

    if (!Array.isArray(response.data)) {
      const responseError = new Error("Conversation history response did not include a data list");
      if (!threads.length) throw responseError;
      error = responseError.message;
      break;
    }

    threads.push(...response.data);
    cursor = response.nextCursor || null;
    if (!cursor) break;
  }

  const sessions = threads.map((thread) => {
    const runtime = ensureThreadRuntime(thread.id);
    return normalizeThreadSummary(thread, runtime.activeTurnId);
  });

  return { sessions, error };
}

async function pushThreadSnapshot(threadId, targetWs = null) {
  const response = await codex.readThread({
    threadId,
    includeTurns: true
  });

  const runtime = ensureThreadRuntime(threadId);
  const snapshot = normalizeThreadSnapshot(response.thread, runtime.activeTurnId);

  if (targetWs) {
    send(targetWs, "session.snapshot", snapshot);
  } else {
    broadcast("session.snapshot", snapshot);
  }
}

async function resumeThread(threadId) {
  let resumePromise = resumedThreads.get(threadId);
  if (!resumePromise) {
    resumePromise = codex.resumeThread({ threadId });
    resumedThreads.set(threadId, resumePromise);
    resumePromise.catch(() => {
      if (resumedThreads.get(threadId) === resumePromise) {
        resumedThreads.delete(threadId);
      }
    });
  }
  return resumePromise;
}

async function getSupportedDefaultModel() {
  if (!availableModelsPromise) {
    availableModelsPromise = codex.listModels({ limit: 100 }).then((response) => {
      const models = Array.isArray(response.data) ? response.data.filter((model) => model.model && !model.hidden) : [];
      console.log("🚀 ~ getSupportedDefaultModel ~ models:", models)
      const selected = models.find((model) => model.model === "gpt-5.6-luna")
        || models.find((model) => model.isDefault)
        || models[0];
      if (!selected) throw new Error("Codex 当前账户没有可用模型");
      return { name: selected.model, models: new Set(models.map((model) => model.model)) };
    }).catch((error) => {
      availableModelsPromise = null;
      throw error;
    });
  }

  const { name } = await availableModelsPromise;
  return name;
}

async function getAvailableModelNames() {
  if (!availableModelsPromise) await getSupportedDefaultModel();
  return (await availableModelsPromise).models;
}

async function resumeOrForkThread(threadId, targetWs, defaultModel) {
  try {
    const resumed = await resumeThread(threadId);
    const availableModels = await getAvailableModelNames();
    return {
      threadId,
      modelOverride: resumed.model && !availableModels.has(resumed.model) ? defaultModel : null
    };
  } catch (error) {
    if (isUnsupportedModelError(error)) {
      const resumed = await codex.resumeThread({ threadId, model: defaultModel });
      resumedThreads.set(threadId, Promise.resolve(resumed));
      return { threadId, modelOverride: defaultModel };
    }
    if (!isActiveWriterError(error)) throw error;

    const sourceThread = await codex.readThread({
      threadId,
      includeTurns: false
    });
    const sourceTitle = sourceThread.thread?.name || sourceThread.thread?.preview || "历史会话";
    const fork = await codex.forkThread({
      threadId,
      threadSource: config.serviceName,
      model: defaultModel
    });
    const forkedThreadId = fork.thread?.id;
    if (!forkedThreadId) {
      throw new Error("原会话被其他 Codex 客户端占用，且无法创建网页分支");
    }

    resumedThreads.set(forkedThreadId, Promise.resolve(fork));
    await codex.setThreadName({
      threadId: forkedThreadId,
      name: `${sourceTitle} · 网页分支`.slice(0, 80)
    });

    send(targetWs, "session.redirected", {
      fromSessionId: threadId,
      sessionId: forkedThreadId,
      reason: "active_writer",
      message: "原会话正在 Mac Codex 中使用，已创建保留历史的网页分支。"
    });
    await pushThreadSnapshot(forkedThreadId, targetWs);
    await pushSessions(targetWs);
    return { threadId: forkedThreadId, modelOverride: defaultModel };
  }
}

function isActiveWriterError(error) {
  const message = String(error?.message || error || "").toLowerCase();
  return message.includes("active writer") || message.includes("already has an active writer");
}

function isUnsupportedModelError(error) {
  const message = String(error?.message || error || "").toLowerCase();
  return message.includes("model is not supported") || message.includes("not supported when using codex with a chatgpt account");
}

function ensureThreadRuntime(threadId) {
  if (!threadRuntime.has(threadId)) {
    threadRuntime.set(threadId, {
      activeTurnId: null,
      status: "idle"
    });
  }
  return threadRuntime.get(threadId);
}

function send(ws, type, payload) {
  if (ws.readyState !== 1) return;
  ws.send(JSON.stringify({ type, payload }));
}

function broadcast(type, payload) {
  for (const ws of clients) send(ws, type, payload);
}

function serveStatic(pathname, res) {
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.join(publicDir, safePath);

  if (!filePath.startsWith(publicDir) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }

  const ext = path.extname(filePath);
  const mimeType = mimeTypes[ext] || "application/octet-stream";
  res.writeHead(200, { "Content-Type": mimeType });
  fs.createReadStream(filePath).pipe(res);
}
