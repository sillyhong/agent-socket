import crypto from "node:crypto";

export function createTitleFromText(text = "") {
  const clean = String(text).replace(/\s+/g, " ").trim();
  if (!clean) return "New session";
  return clean.slice(0, 40);
}

export function normalizeThreadSummary(thread, activeTurnId = null) {
  return {
    id: thread.id,
    sessionId: thread.sessionId,
    title: thread.name || thread.preview || "New session",
    preview: thread.preview || "",
    updatedAt: thread.updatedAt,
    createdAt: thread.createdAt,
    cwd: thread.cwd,
    status: normalizeStatus(thread.status),
    activeTurnId
  };
}

export function normalizeThreadSnapshot(thread, activeTurnId = null) {
  return {
    ...normalizeThreadSummary(thread, activeTurnId),
    messages: flattenThreadMessages(thread)
  };
}

export function flattenThreadMessages(thread) {
  const messages = [];
  const turns = Array.isArray(thread.turns) ? thread.turns : [];

  for (const turn of turns) {
    for (const item of turn.items || []) {
      if (item.type === "userMessage") {
        const text = extractUserMessageText(item.content);
        if (text) {
          messages.push({
            id: item.id,
            role: "user",
            phase: "final",
            text,
            turnId: turn.id,
            createdAt: turn.startedAt || turn.completedAt || thread.updatedAt
          });
        }
      }

      if (item.type === "agentMessage" && item.text?.trim()) {
        messages.push({
          id: item.id,
          role: "assistant",
          phase: item.phase || "final_answer",
          text: item.text,
          turnId: turn.id,
          createdAt: turn.completedAt || turn.startedAt || thread.updatedAt
        });
      }

      if (item.type === "plan" && item.text?.trim()) {
        messages.push({
          id: item.id,
          role: "plan",
          phase: "system",
          text: item.text,
          turnId: turn.id,
          createdAt: turn.startedAt || thread.updatedAt
        });
      }

      if (item.type === "reasoning" && item.summary?.length) {
        messages.push({
          id: item.id,
          role: "reasoning",
          phase: "system",
          text: item.summary.join("\n"),
          turnId: turn.id,
          createdAt: turn.startedAt || thread.updatedAt
        });
      }

      if (item.type === "commandExecution" && item.command?.trim()) {
        const output = item.aggregatedOutput ? `\n\n${item.aggregatedOutput}` : "";
        messages.push({
          id: item.id,
          role: "command",
          phase: "system",
          text: `$ ${item.command}${output}`,
          turnId: turn.id,
          createdAt: turn.startedAt || thread.updatedAt
        });
      }
    }
  }

  return messages;
}

export function extractResponseItemText(item) {
  if (!item || item.type !== "message" || !Array.isArray(item.content)) return "";
  return item.content
    .filter((content) => content.type === "output_text")
    .map((content) => content.text)
    .join("");
}

export function makeStreamingMessage({ threadId, itemId, delta }) {
  return {
    id: `${threadId}:${itemId}:${crypto.randomUUID()}`,
    role: "assistant",
    phase: "stream",
    text: delta,
    streaming: true
  };
}

function extractUserMessageText(content = []) {
  return content
    .filter((entry) => entry.type === "text")
    .map((entry) => entry.text)
    .join("\n")
    .trim();
}

function normalizeStatus(status) {
  if (!status) return "unknown";
  if (status.type === "active") return "active";
  if (status.type === "idle") return "idle";
  if (status.type === "notLoaded") return "notLoaded";
  if (status.type === "systemError") return "systemError";
  return status.type || "unknown";
}
