import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import WebSocket from "ws";

export function resolveCodexCommand({
  env = process.env,
  homeDir = os.homedir(),
  isExecutable = executableExists
} = {}) {
  if (env.CODEX_COMMAND) return env.CODEX_COMMAND;

  // Desktop and standalone CLI can have incompatible persisted-history schemas.
  const bundledPaths = [
    "ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
    "Codex.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
    "Codex.app/Contents/Resources/codex",
    "ChatGPT.app/Contents/Resources/codex"
  ];
  const candidates = [
    env.CODEX_CLI_PATH,
    ...bundledPaths.map((relativePath) => path.join("/Applications", relativePath)),
    ...bundledPaths.map((relativePath) => path.join(homeDir, "Applications", relativePath)),
    path.join(homeDir, ".local/bin/codex")
  ].filter(Boolean);

  return candidates.find(isExecutable) || "codex";
}

export function parseCodexVersion(value) {
  return String(value || "").match(/\b\d+\.\d+\.\d+(?:-[\w.-]+)?/)?.[0] || null;
}

export function getCodexVersion(command) {
  const output = execFileSync(command, ["--version"], {
    encoding: "utf8",
    timeout: 5000,
    stdio: ["ignore", "pipe", "pipe"]
  });
  return parseCodexVersion(output);
}

export function assertCompatibleCodexVersion(expectedVersion, serverInfo) {
  const serverVersion = parseCodexVersion(serverInfo?.userAgent);
  if (expectedVersion && serverVersion && expectedVersion !== serverVersion) {
    throw new Error(
      `本机端口仍运行 Codex ${serverVersion}，当前选择的是 ${expectedVersion}。`
      + "历史会话格式可能不兼容。请停止旧 app-server/旧桥接进程，再执行 npm run bridge:mac:all。"
    );
  }
  return serverVersion;
}

export function checkLocalAppServerVersion({ command, url, token }) {
  const expectedVersion = getCodexVersion(command);

  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      handshakeTimeout: 5000
    });
    const timeout = setTimeout(() => finish(new Error("检查本机 Codex app-server 版本超时")), 5000);
    let settled = false;

    function finish(error, version) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (socket.readyState === WebSocket.OPEN) socket.close();
      else if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
      if (error) reject(error);
      else resolve(version);
    }

    socket.once("open", () => {
      socket.send(JSON.stringify({
        id: 1,
        method: "initialize",
        params: { clientInfo: { name: "agent_socket_version_check", version: "0.1.0" } }
      }));
    });
    socket.on("message", (raw) => {
      try {
        const message = JSON.parse(raw.toString());
        if (message.id !== 1) return;
        if (message.error) throw new Error(message.error.message || "Codex 初始化失败");
        const version = assertCompatibleCodexVersion(expectedVersion, message.result);
        socket.send(JSON.stringify({ method: "initialized", params: {} }));
        finish(null, version);
      } catch (error) {
        finish(error);
      }
    });
    socket.once("error", (error) => finish(error));
    socket.once("close", () => finish(new Error("检查 Codex 版本时连接已关闭")));
  });
}

function executableExists(candidate) {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
