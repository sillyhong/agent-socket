import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { resolveCodexCommand, getCodexVersion, checkLocalAppServerVersion } from "./codex-runtime.js";
import { acquireBridgeLock } from "./bridge-lock.js";

const appServerPort = Number(process.env.CODEX_APP_SERVER_PORT || 8899);
if (!Number.isInteger(appServerPort) || appServerPort < 1 || appServerPort > 65535) {
  throw new Error("CODEX_APP_SERVER_PORT must be a valid TCP port");
}

const workspace = path.resolve(process.env.CODEX_CWD || process.cwd());
if (!fs.existsSync(workspace) || !fs.statSync(workspace).isDirectory()) {
  throw new Error(`CODEX_CWD must be an existing directory: ${workspace}`);
}

const bridgeUrlValue = process.env.CODEX_BRIDGE_URL
  || "wss://xyglassaccessories.com/agent-socket/bridge";
const bridgeUrl = new URL(bridgeUrlValue);
if (!["ws:", "wss:"].includes(bridgeUrl.protocol)) {
  throw new Error("CODEX_BRIDGE_URL must use ws:// or wss://");
}

let bridgeLock;
try {
  bridgeLock = acquireBridgeLock(bridgeUrlValue);
} catch (error) {
  if (error.code !== "BRIDGE_ALREADY_RUNNING") throw error;
  console.log(error.message);
  process.exit(0);
}
process.once("exit", () => bridgeLock.release());

const localAppServerUrl = process.env.CODEX_LOCAL_APP_SERVER_URL
  || `ws://127.0.0.1:${appServerPort}`;
const localAppServerEndpoint = new URL(localAppServerUrl);
const localHostname = localAppServerEndpoint.hostname.replace(/^\[|\]$/g, "").toLowerCase();
if (localAppServerEndpoint.protocol !== "ws:" || !["127.0.0.1", "localhost", "::1"].includes(localHostname)) {
  throw new Error("CODEX_LOCAL_APP_SERVER_URL must use ws:// and point to localhost");
}

const port = Number(localAppServerEndpoint.port || appServerPort);
const readyUrl = `http://${localAppServerEndpoint.host}/readyz`;
const listenUrl = process.env.CODEX_APP_SERVER_LISTEN || `ws://0.0.0.0:${port}`;
const tokenFile = expandHome(
  process.env.CODEX_APP_SERVER_TOKEN_FILE || path.join(os.homedir(), ".codex/app-server.token")
);
if (!fs.existsSync(tokenFile) || !fs.statSync(tokenFile).isFile()) {
  throw new Error(`Codex app-server token file not found: ${tokenFile}`);
}
const bridgeToken = process.env.CODEX_BRIDGE_TOKEN?.trim()
  || fs.readFileSync(tokenFile, "utf8").trim();
if (!bridgeToken) {
  throw new Error(`Codex app-server token file is empty: ${tokenFile}`);
}
const codexCommand = resolveCodexCommand();
const projectRoot = process.cwd();
console.log(`Using Codex ${getCodexVersion(codexCommand)}: ${codexCommand}`);

let appServerProcess = null;
let bridgeProcess = null;
let stopping = false;

process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));

if (await isReady(readyUrl)) {
  await checkLocalAppServerVersion({
    command: codexCommand,
    url: localAppServerUrl,
    token: fs.readFileSync(tokenFile, "utf8").trim()
  });
  console.log(`Reusing Codex app-server at ${localAppServerUrl}`);
} else {
  console.log(`Starting Codex app-server at ${listenUrl}`);
  appServerProcess = spawn(codexCommand, [
    "app-server",
    "--listen", listenUrl,
    "--ws-auth", "capability-token",
    "--ws-token-file", tokenFile
  ], {
    cwd: workspace,
    stdio: "inherit",
    env: process.env
  });

  await waitForReady(readyUrl, appServerProcess);
  console.log(`Codex app-server ready at ${localAppServerUrl}`);
}

const bridgeEnvironment = {
  ...process.env,
  CODEX_BRIDGE_URL: bridgeUrlValue,
  CODEX_BRIDGE_TOKEN: bridgeToken,
  CODEX_CWD: workspace,
  CODEX_COMMAND: codexCommand,
  CODEX_BRIDGE_LOCK_OWNER_PID: String(bridgeLock.ownerPid),
  CODEX_LOCAL_APP_SERVER_URL: localAppServerUrl,
  CODEX_APP_SERVER_TOKEN_FILE: tokenFile
};
delete bridgeEnvironment.CODEX_APP_SERVER_TOKEN;
delete bridgeEnvironment.CODEX_LOCAL_APP_SERVER_TOKEN;

bridgeProcess = spawn("npm", ["run", "bridge:mac"], {
  cwd: projectRoot,
  stdio: "inherit",
  env: bridgeEnvironment
});

console.log("Started npm run bridge:mac; both processes are running.");

const bridgeExit = waitForExit(bridgeProcess);
const appServerExit = appServerProcess
  ? waitForExit(appServerProcess)
  : new Promise(() => {});
const result = await Promise.race([
  bridgeExit.then((exit) => ({ processName: "bridge", exit })),
  appServerExit.then((exit) => ({ processName: "app-server", exit }))
]);

if (!stopping) {
  stopping = true;
  if (result.processName === "bridge") {
    console.error(`Mac bridge exited (code=${result.exit.code}, signal=${result.exit.signal})`);
    appServerProcess?.kill("SIGTERM");
  } else {
    console.error(`Codex app-server exited (code=${result.exit.code}, signal=${result.exit.signal})`);
    bridgeProcess.kill("SIGTERM");
  }
  process.exitCode = result.exit.code ?? 1;
}

function expandHome(value) {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return path.resolve(value);
}

async function isReady(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(800) });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForReady(url, child) {
  const deadline = Date.now() + 30_000;
  const childExit = waitForExit(child);

  while (!stopping && Date.now() < deadline) {
    if (await isReady(url)) return;

    const result = await Promise.race([
      delay(300).then(() => null),
      childExit.then((exit) => ({ exit }))
    ]);
    if (result?.exit) {
      throw new Error(`Codex app-server exited before ready (code=${result.exit.code}, signal=${result.exit.signal})`);
    }
  }

  child.kill("SIGTERM");
  throw new Error(`Timed out waiting for Codex app-server readyz at ${url}`);
}

function waitForExit(child) {
  return new Promise((resolve) => {
    child.once("error", (error) => resolve({ code: 1, signal: error.message }));
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

function stop(signal) {
  if (stopping) return;
  stopping = true;
  bridgeProcess?.kill(signal);
  appServerProcess?.kill(signal);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
