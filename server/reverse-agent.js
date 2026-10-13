import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import WebSocket from "ws";

const bridgeUrl = process.env.CODEX_BRIDGE_URL;
const bridgeToken = process.env.CODEX_BRIDGE_TOKEN;
const appServerPort = Number(process.env.CODEX_APP_SERVER_PORT || 8899);
const localAppServerUrl = process.env.CODEX_LOCAL_APP_SERVER_URL || `ws://127.0.0.1:${appServerPort}`;
const localAppServerToken = resolveLocalAppServerToken();
const codexCommand = process.env.CODEX_COMMAND || "codex";
const cwd = process.env.CODEX_CWD || process.cwd();

if (!bridgeUrl || !bridgeToken) {
  throw new Error("Set CODEX_BRIDGE_URL and CODEX_BRIDGE_TOKEN before starting the Mac bridge");
}

const bridgeEndpoint = new URL(bridgeUrl);
if (!["ws:", "wss:"].includes(bridgeEndpoint.protocol)) {
  throw new Error("CODEX_BRIDGE_URL must use ws:// or wss://");
}

const localEndpoint = new URL(localAppServerUrl);
const localHost = localEndpoint.hostname.replace(/^\[|\]$/g, "").toLowerCase();
if (localEndpoint.protocol !== "ws:" || ![
  "127.0.0.1", "localhost", "::1"
].includes(localHost)) {
  throw new Error("CODEX_LOCAL_APP_SERVER_URL must use ws:// and point to localhost");
}

let appServerProcess = null;
let activeLocalSocket = null;
let activeBridgeSocket = null;
let stopping = false;

process.on("SIGINT", stop);
process.on("SIGTERM", stop);

await ensureLocalAppServer();
console.log(`Local Codex app-server ready at ${localAppServerUrl}`);

while (!stopping) {
  try {
    await connectBridgeOnce();
  } catch (error) {
    if (!stopping) console.error(`Reverse bridge disconnected: ${error.message}`);
  }
  if (!stopping) await delay(2000);
}

function stop() {
  stopping = true;
  activeLocalSocket?.close();
  activeBridgeSocket?.close();
  appServerProcess?.kill("SIGTERM");
}

function resolveLocalAppServerToken() {
  if (process.env.CODEX_LOCAL_APP_SERVER_TOKEN) return process.env.CODEX_LOCAL_APP_SERVER_TOKEN;
  if (process.env.CODEX_APP_SERVER_TOKEN) return process.env.CODEX_APP_SERVER_TOKEN;

  const tokenFile = process.env.CODEX_APP_SERVER_TOKEN_FILE
    || path.join(os.homedir(), ".codex/app-server.token");
  return fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, "utf8").trim() : "";
}

async function ensureLocalAppServer() {
  const readyUrl = `http://${localEndpoint.host}/readyz`;
  if (!(await isReady(readyUrl))) {
    appServerProcess = spawn(codexCommand, ["app-server", "--listen", localAppServerUrl], {
      cwd,
      stdio: ["ignore", "inherit", "inherit"]
    });
    appServerProcess.on("error", (error) => {
      console.error(`Failed to start local Codex app-server: ${error.message}`);
    });
    appServerProcess.on("exit", (code) => {
      if (!stopping) console.error(`Local Codex app-server exited with code ${code}`);
    });
  }

  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (stopping) throw new Error("Bridge startup cancelled");
    if (await isReady(readyUrl)) return;
    await delay(500);
  }

  throw new Error(`Timed out waiting for local Codex app-server at ${readyUrl}`);
}

async function isReady(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
    return response.ok;
  } catch {
    return false;
  }
}

function connectBridgeOnce() {
  const local = new WebSocket(localAppServerUrl, {
    headers: localAppServerToken ? { Authorization: `Bearer ${localAppServerToken}` } : undefined
  });
  activeLocalSocket = local;
  let bridge;

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      local.close();
      bridge?.close();
      if (activeLocalSocket === local) activeLocalSocket = null;
      if (activeBridgeSocket === bridge) activeBridgeSocket = null;
      if (error) reject(error);
      else resolve();
    };

    local.once("open", () => {
      bridge = new WebSocket(bridgeUrl, {
        headers: { Authorization: `Bearer ${bridgeToken}` }
      });
      activeBridgeSocket = bridge;

      bridge.once("open", () => {
        console.log(`Reverse tunnel established to ${bridgeEndpoint.host}`);
        local.on("message", (data, isBinary) => {
          if (bridge.readyState === WebSocket.OPEN) bridge.send(data, { binary: isBinary });
        });
        bridge.on("message", (data, isBinary) => {
          if (local.readyState === WebSocket.OPEN) local.send(data, { binary: isBinary });
        });
        local.once("close", () => finish());
        bridge.once("close", () => finish());
        local.once("error", finish);
        bridge.once("error", finish);
      });

      bridge.once("error", finish);
    });

    local.once("error", finish);
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
