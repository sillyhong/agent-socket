import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import WebSocket, { WebSocketServer } from "ws";
import { CodexRpcClient } from "../server/codex-rpc-client.js";

test("connects to a direct app-server with a bearer token", async () => {
  const server = http.createServer((request, response) => {
    if (request.url === "/readyz") {
      response.writeHead(200).end("ready");
      return;
    }
    response.writeHead(404).end();
  });
  const websocketServer = new WebSocketServer({ server });
  let authorization;

  websocketServer.on("connection", (socket, request) => {
    authorization = request.headers.authorization;
    socket.on("message", (raw) => respond(socket, raw));
  });

  await listen(server);
  const client = new CodexRpcClient({
    usesExternalAppServer: true,
    appServerUrl: `ws://127.0.0.1:${server.address().port}`,
    appServerReadyUrl: `http://127.0.0.1:${server.address().port}/readyz`,
    appServerToken: "direct-test-token",
    clientInfo: { name: "test", title: "Test", version: "1" }
  });

  try {
    await client.start();
    assert.equal(authorization, "Bearer direct-test-token");
    assert.equal(client.ready, true);
    assert.equal(client.proc, null);
  } finally {
    client.stop();
    await close(websocketServer);
    await close(server);
  }
});

test("uses a Mac-initiated reverse socket and does not start cloud-local Codex", async () => {
  const server = http.createServer();
  const websocketServer = new WebSocketServer({ server });
  await listen(server);

  const tunnel = new WebSocket(`ws://127.0.0.1:${server.address().port}`, {
    headers: { Authorization: "Bearer reverse-test-token" }
  });
  tunnel.on("message", (raw) => respond(tunnel, raw));

  const acceptedSocket = await new Promise((resolve, reject) => {
    websocketServer.once("connection", (socket, request) => {
      assert.equal(request.headers.authorization, "Bearer reverse-test-token");
      resolve(socket);
    });
    tunnel.once("error", reject);
  });

  const client = new CodexRpcClient({
    reverseBridgeEnabled: true,
    clientInfo: { name: "test", title: "Test", version: "1" }
  });
  client.attachReverseSocket(acceptedSocket);

  try {
    await client.start();
    assert.equal(client.ready, true);
    assert.equal(client.proc, null);
    assert.equal(client.ownsAppServer, false);
  } finally {
    client.stop();
    tunnel.close();
    await close(websocketServer);
    await close(server);
  }
});

function respond(socket, raw) {
  const message = JSON.parse(raw.toString());
  socket.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }));
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function close(serverLike) {
  return new Promise((resolve) => serverLike.close(resolve));
}
