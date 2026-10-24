import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import WebSocket from "ws";
import { assertCompatibleCodexVersion, getCodexVersion, parseCodexVersion } from "./codex-runtime.js";

export class CodexRpcClient extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.proc = null;
    this.socket = null;
    this.nextId = 1;
    this.pending = new Map();
    this.ready = false;
    this.startPromise = null;
    this.ownsAppServer = false;
    this.reverseSocket = null;
    this.serverVersion = null;
  }

  async start() {
    if (this.ready && this.socket?.readyState === WebSocket.OPEN) return;
    if (this.startPromise) return this.startPromise;

    const startPromise = (async () => {
      if (!this.options.reverseBridgeEnabled) {
        const alreadyReady = await this.#isReady();
        if (!alreadyReady) {
          if (this.options.usesExternalAppServer) {
            throw new Error(`Configured Codex app-server is not ready at ${this.options.appServerReadyUrl}`);
          }
          await this.#spawnAppServer();
          await this.#waitForReady();
        }
      }

      await this.#connectSocket();
      const socket = this.socket;
      try {
        const serverInfo = await this.#requestRaw("initialize", {
          clientInfo: this.options.clientInfo,
          capabilities: {
            experimentalApi: true,
            requestAttestation: false
          }
        }, socket);
        if (this.socket !== socket) throw new Error("Codex bridge connection was replaced during initialization");
        if (!this.options.reverseBridgeEnabled && !this.options.usesExternalAppServer && this.options.codexCommand) {
          assertCompatibleCodexVersion(getCodexVersion(this.options.codexCommand), serverInfo);
        }
        this.serverVersion = parseCodexVersion(serverInfo.userAgent);
        this.#write({ method: "initialized", params: {} }, socket);
        this.ready = true;
        this.emit("ready", { version: this.serverVersion });
      } catch (error) {
        if (this.socket === socket) {
          this.#disconnectSocket(socket, error);
          socket.close();
        }
        throw error;
      }
    })();
    this.startPromise = startPromise;

    try {
      await startPromise;
    } finally {
      if (this.startPromise === startPromise) this.startPromise = null;
    }
  }

  async request(method, params) {
    await this.start();
    return this.#requestRaw(method, params);
  }

  async #requestRaw(method, params, socket = this.socket) {
    const id = this.nextId++;
    const message = { jsonrpc: "2.0", id, method, params };

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, socket });
      try {
        this.#write(message, socket);
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  async startThread(params) {
    return this.request("thread/start", params);
  }

  async listThreads(params) {
    return this.request("thread/list", params);
  }

  async listModels(params) {
    return this.request("model/list", params);
  }

  async readThread(params) {
    return this.request("thread/read", params);
  }

  async resumeThread(params) {
    return this.request("thread/resume", params);
  }

  async forkThread(params) {
    return this.request("thread/fork", params);
  }

  async setThreadName(params) {
    return this.request("thread/name/set", params);
  }

  async startTurn(params) {
    return this.request("turn/start", params);
  }

  async interruptTurn(params) {
    return this.request("turn/interrupt", params);
  }

  async deleteThread(params) {
    return this.request("thread/delete", params);
  }

  stop() {
    if (this.socket) {
      const socket = this.socket;
      this.#disconnectSocket(socket, new Error("Codex client stopped"));
      socket.close();
    }
    if (this.proc && this.ownsAppServer) this.proc.kill();
    this.proc = null;
    this.ready = false;
  }

  attachReverseSocket(socket) {
    if (!this.options.reverseBridgeEnabled) {
      socket.close(1008, "Reverse bridge mode is disabled");
      return;
    }

    if (this.socket === socket) return;
    const previous = this.socket;
    if (previous) {
      this.#disconnectSocket(previous, new Error("Codex bridge connection was replaced"));
    }

    this.ready = false;
    this.serverVersion = null;
    this.reverseSocket = socket;
    this.socket = socket;
    this.#bindSocket(socket);
    previous?.close(1012, "Replaced by a newer Mac bridge connection");
    this.emit("reverseSocket", socket);
    this.start().catch((error) => this.emit("protocolError", error));
  }

  #handleMessage(payload) {
    if (payload.id !== undefined && (payload.result !== undefined || payload.error !== undefined)) {
      const pending = this.pending.get(payload.id);
      if (!pending) return;
      this.pending.delete(payload.id);

      if (payload.error) {
        pending.reject(new Error(payload.error.message || "Unknown JSON-RPC error"));
        return;
      }

      pending.resolve(payload.result);
      return;
    }

    if (payload.method && payload.id !== undefined) {
      this.#write({
        jsonrpc: "2.0",
        id: payload.id,
        error: {
          code: -32601,
          message: `Client method not supported: ${payload.method}`
        }
      });
      this.emit("serverRequest", payload);
      return;
    }

    if (payload.method) {
      this.emit("notification", payload);
    }
  }

  #write(message, socket = this.socket) {
    if (!socket || socket !== this.socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("Codex app-server WebSocket not connected");
    }
    socket.send(JSON.stringify(message));
  }

  async #spawnAppServer() {
    if (this.options.reverseBridgeEnabled) {
      throw new Error("Cannot spawn a local app-server in reverse bridge mode");
    }
    if (this.proc) return;

    this.proc = spawn(
      this.options.codexCommand,
      ["app-server", "--listen", this.options.appServerUrl],
      {
        cwd: this.options.cwd,
        stdio: ["ignore", "pipe", "pipe"]
      }
    );

    this.ownsAppServer = true;

    this.proc.stdout.on("data", (chunk) => {
      this.emit("stdout", chunk.toString("utf8"));
    });

    this.proc.stderr.on("data", (chunk) => {
      this.emit("stderr", chunk.toString("utf8"));
    });

    this.proc.on("error", (error) => {
      for (const { reject } of this.pending.values()) reject(error);
      this.pending.clear();
      this.proc = null;
      this.ready = false;
      this.emit("processError", error);
    });

    this.proc.on("exit", (code, signal) => {
      const error = new Error(`Codex app-server exited. code=${code} signal=${signal}`);
      for (const { reject } of this.pending.values()) reject(error);
      this.pending.clear();
      this.proc = null;
      this.ready = false;
      this.emit("exit", { code, signal });
    });
  }

  async #connectSocket() {
    if (this.socket?.readyState === WebSocket.OPEN) return;

    if (this.options.reverseBridgeEnabled) {
      const socket = this.reverseSocket?.readyState === WebSocket.OPEN
        ? this.reverseSocket
        : await new Promise((resolve) => this.once("reverseSocket", resolve));
      this.socket = socket;
      return;
    }

    const endpoint = new URL(this.options.appServerUrl);
    const hostname = endpoint.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    const isLoopback = hostname === "localhost"
      || hostname === "::1"
      || /^127(?:\.\d{1,3}){3}$/.test(hostname);
    if (this.options.appServerToken && endpoint.protocol === "ws:" && !isLoopback) {
      throw new Error("Refusing to send CODEX_APP_SERVER_TOKEN over public ws://; use wss:// or a secure tunnel");
    }

    this.socket = await new Promise((resolve, reject) => {
      const headers = this.options.appServerToken
        ? { Authorization: `Bearer ${this.options.appServerToken}` }
        : undefined;
      const socket = new WebSocket(this.options.appServerUrl, { headers });

      socket.once("open", () => resolve(socket));
      socket.once("unexpected-response", (_request, response) => {
        response.resume();
        reject(new Error(`Codex app-server rejected WebSocket upgrade (HTTP ${response.statusCode})`));
      });
      socket.once("error", (error) => reject(error));
    });

    this.#bindSocket(this.socket);
  }

  #bindSocket(socket) {
    socket.on("message", (data) => {
      if (this.socket !== socket) return;
      try {
        const payload = JSON.parse(String(data));
        this.#handleMessage(payload);
      } catch (error) {
        this.emit("protocolError", error);
      }
    });

    socket.on("close", (code, reason) => {
      const detail = reason.toString();
      this.#disconnectSocket(socket, new Error(
        `Codex app-server WebSocket closed (code=${code}${detail ? `, reason=${detail}` : ""})`
      ));
    });
    socket.on("error", (error) => {
      this.#disconnectSocket(socket, error);
      socket.terminate();
    });
  }

  #disconnectSocket(socket, error) {
    if (this.socket !== socket) return;
    this.ready = false;
    this.serverVersion = null;
    this.socket = null;
    if (this.reverseSocket === socket) this.reverseSocket = null;
    this.startPromise = null;
    for (const [id, pending] of this.pending) {
      if (pending.socket !== socket) continue;
      this.pending.delete(id);
      pending.reject(error);
    }
    this.emit("socketClosed", error);
  }

  async #isReady() {
    try {
      const response = await fetch(this.options.appServerReadyUrl);
      return response.ok;
    } catch {
      return false;
    }
  }

  async #waitForReady() {
    const maxAttempts = 50;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (await this.#isReady()) return;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    throw new Error("Timed out waiting for Codex app-server readyz");
  }
}
