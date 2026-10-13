import path from "node:path";
import os from "node:os";
import fs from "node:fs";

export const workspaceRoot = process.cwd();
export const publicDir = path.join(workspaceRoot, "public");
const reverseBridgeEnabled = process.env.CODEX_APP_SERVER_MODE === "reverse";
const bridgeToken = process.env.CODEX_BRIDGE_TOKEN || "";
const usesExternalAppServer = Boolean(process.env.CODEX_APP_SERVER_URL) && !reverseBridgeEnabled;
const appServerUrlValue = usesExternalAppServer
  ? process.env.CODEX_APP_SERVER_URL
  : `ws://127.0.0.1:${process.env.CODEX_APP_SERVER_PORT || 8899}`;
if (reverseBridgeEnabled && !bridgeToken) {
  throw new Error("CODEX_BRIDGE_TOKEN is required when CODEX_APP_SERVER_MODE=reverse");
}

function resolveAppServerToken() {
  if (process.env.CODEX_APP_SERVER_TOKEN) return process.env.CODEX_APP_SERVER_TOKEN;

  const tokenFile = process.env.CODEX_APP_SERVER_TOKEN_FILE
    || (!usesExternalAppServer ? path.join(os.homedir(), ".codex/app-server.token") : "");
  if (!tokenFile || !fs.existsSync(tokenFile)) return "";

  return fs.readFileSync(tokenFile, "utf8").trim();
}

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
  appServerToken: resolveAppServerToken(),
  reverseBridgeEnabled,
  bridgeToken,
  approvalPolicy: process.env.CODEX_APPROVAL_POLICY || "never",
  sandboxMode: process.env.CODEX_SANDBOX_MODE || "workspace-write",
  serviceName: "local-socket-codex-bridge",
  clientInfo: {
    name: "local-socket-codex-bridge",
    title: "Local Socket Codex Bridge",
    version: "0.1.0"
  }
};

config.appServerUrl = appServerUrlValue;
config.usesExternalAppServer = usesExternalAppServer;

const appServerUrl = new URL(config.appServerUrl);
if (appServerUrl.protocol !== "ws:" && appServerUrl.protocol !== "wss:") {
  throw new Error("CODEX_APP_SERVER_URL must use ws:// or wss://");
}
appServerUrl.protocol = appServerUrl.protocol === "wss:" ? "https:" : "http:";
appServerUrl.pathname = "/readyz";
appServerUrl.search = "";
appServerUrl.hash = "";
config.appServerReadyUrl = appServerUrl.toString();
