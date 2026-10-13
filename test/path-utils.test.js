import test from "node:test";
import assert from "node:assert/strict";
import { isSupportedWebSocketPath, normalizeAppPath } from "../server/path-utils.js";

test("keeps existing root routes unchanged", () => {
  assert.deepEqual(normalizeAppPath("/"), { pathname: "/", redirectTo: null });
  assert.deepEqual(normalizeAppPath("/styles.css"), {
    pathname: "/styles.css",
    redirectTo: null
  });
  assert.deepEqual(normalizeAppPath("/api/health"), {
    pathname: "/api/health",
    redirectTo: null
  });
});

test("normalizes the application prefix for HTTP routes", () => {
  assert.deepEqual(normalizeAppPath("/agent-socket"), {
    pathname: "/",
    redirectTo: "/agent-socket/"
  });
  assert.deepEqual(normalizeAppPath("/agent-socket/"), {
    pathname: "/",
    redirectTo: null
  });
  assert.deepEqual(normalizeAppPath("/agent-socket/styles.css"), {
    pathname: "/styles.css",
    redirectTo: null
  });
  assert.deepEqual(normalizeAppPath("/agent-socket/api/health"), {
    pathname: "/api/health",
    redirectTo: null
  });
  assert.deepEqual(normalizeAppPath("/agent-socket-extra"), {
    pathname: "/agent-socket-extra",
    redirectTo: null
  });
});

test("accepts root and prefixed websocket endpoints only", () => {
  assert.equal(isSupportedWebSocketPath("/ws"), true);
  assert.equal(isSupportedWebSocketPath("/agent-socket/ws"), true);
  assert.equal(isSupportedWebSocketPath("/agent-socket/other"), false);
  assert.equal(isSupportedWebSocketPath("/other/ws"), false);
});
