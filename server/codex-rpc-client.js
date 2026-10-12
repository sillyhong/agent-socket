import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";

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
  }

  async start() {
    if (this.ready && this.socket?.readyState === WebSocket.OPEN) return;
    if (this.startPromise) return this.startPromise;

    this.startPromise = (async () => {
      const alreadyReady = await this.#isReady();
      if (!alreadyReady) {
        await this.#spawnAppServer();
        await this.#waitForReady();
      }

      await this.#connectSocket();
      await this.#requestRaw("initialize", {
        clientInfo: this.options.clientInfo,
        capabilities: {
          experimentalApi: true,
          requestAttestation: false
        }
      });

      this.ready = true;
    })();

    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async request(method, params) {
    await this.start();
    return this.#requestRaw(method, params);
  }

  async #requestRaw(method, params) {
    const id = this.nextId++;
    const message = { jsonrpc: "2.0", id, method, params };

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.#write(message);
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
      this.socket.close();
      this.socket = null;
    }
    if (!this.proc) return;
    if (this.ownsAppServer) this.proc.kill();
    this.proc = null;
    this.ready = false;
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

  #write(message) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("Codex app-server WebSocket not connected");
    }
    this.socket.send(JSON.stringify(message));
  }

  async #spawnAppServer() {
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

    this.socket = await new Promise((resolve, reject) => {
      const socket = new WebSocket(this.options.appServerUrl);

      socket.addEventListener("open", () => resolve(socket), { once: true });
      socket.addEventListener(
        "error",
        (event) => reject(new Error(event.message || "Failed to connect to Codex app-server")),
        { once: true }
      );
    });

    this.socket.addEventListener("message", (event) => {
      try {
        const payload = JSON.parse(String(event.data));
        this.#handleMessage(payload);
      } catch (error) {
        this.emit("protocolError", error);
      }
    });

    this.socket.addEventListener("close", () => {
      this.ready = false;
      this.socket = null;
      this.emit("socketClosed");
    });
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
