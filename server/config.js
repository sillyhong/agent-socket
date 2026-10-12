import path from "node:path";
import os from "node:os";
import fs from "node:fs";

export const workspaceRoot = process.cwd();
export const publicDir = path.join(workspaceRoot, "public");

function resolveCodexCommand() {
  const candidates = [
    process.env.CODEX_COMMAND,
    path.join(os.homedir(), ".local/bin/codex"),
    "/Applications/ChatGPT.app/Contents/Resources/codex",
    "codex"
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (candidate === "codex") return candidate;
    if (fs.existsSync(candidate)) return candidate;
  }

  return "codex";
}

export const config = {
  port: Number(process.env.PORT || 8787),
  codexCommand: resolveCodexCommand(),
  cwd: process.env.CODEX_CWD || workspaceRoot,
  appServerPort: Number(process.env.CODEX_APP_SERVER_PORT || 8899),
  approvalPolicy: process.env.CODEX_APPROVAL_POLICY || "never",
  sandboxMode: process.env.CODEX_SANDBOX_MODE || "workspace-write",
  serviceName: "local-socket-codex-bridge",
  clientInfo: {
    name: "local-socket-codex-bridge",
    title: "Local Socket Codex Bridge",
    version: "0.1.0"
  }
};

config.appServerUrl = `ws://127.0.0.1:${config.appServerPort}`;
config.appServerReadyUrl = `http://127.0.0.1:${config.appServerPort}/readyz`;
