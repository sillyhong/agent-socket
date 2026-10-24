import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function acquireBridgeLock(bridgeUrl, {
  ownerPid = null,
  directory = os.tmpdir()
} = {}) {
  const endpoint = new URL(bridgeUrl);
  const key = crypto.createHash("sha256")
    .update(`${endpoint.origin}${endpoint.pathname.replace(/\/+$/, "")}${endpoint.search}`)
    .digest("hex").slice(0, 24);
  const lockPath = path.join(directory, `agent-socket-bridge-${process.getuid?.() ?? "user"}-${key}.lock`);

  if (ownerPid) {
    const owner = readOwner(lockPath);
    if (owner?.pid !== Number(ownerPid) || !processExists(owner.pid)) {
      throw new Error("桥接启动器的进程锁已失效，请重新运行 npm run bridge:mac:all");
    }
    return { ownerPid: owner.pid, release() {} };
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let descriptor;
    try {
      descriptor = fs.openSync(lockPath, "wx", 0o600);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const owner = readOwner(lockPath);
      if (owner?.pid && !processExists(owner.pid)) {
        try { fs.unlinkSync(lockPath); } catch (unlinkError) {
          if (unlinkError.code !== "ENOENT") throw unlinkError;
        }
        continue;
      }
      const duplicate = new Error(
        `该网站的 Mac bridge 已在运行${owner?.pid ? `（PID ${owner.pid}）` : "或正在启动"}，无需重复启动。`
      );
      duplicate.code = "BRIDGE_ALREADY_RUNNING";
      throw duplicate;
    }

    try {
      fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid }));
    } finally {
      fs.closeSync(descriptor);
    }
    return {
      ownerPid: process.pid,
      release() {
        if (readOwner(lockPath)?.pid === process.pid) {
          try { fs.unlinkSync(lockPath); } catch (error) {
            if (error.code !== "ENOENT") throw error;
          }
        }
      }
    };
  }
  throw new Error("无法获取 Mac bridge 进程锁，请稍后重试");
}

function readOwner(lockPath) {
  try {
    const owner = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    return Number.isSafeInteger(owner.pid) && owner.pid > 0 ? owner : null;
  }
  catch { return null; }
}

function processExists(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === "EPERM"; }
}
