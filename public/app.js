const state = {
  ws: null,
  connected: false,
  ready: false,
  workspaceRoot: "",
  sessions: [],
  collapsedProjects: new Set(),
  knownProjectPaths: new Set(),
  projectGroupsInitialized: false,
  currentSessionId: null,
  messages: new Map(),
  activeStatus: new Map(),
  renderedSessionId: null,
  activeAnchorId: null
};

const appShellEl = document.querySelector(".app-shell");
const sessionListEl = document.querySelector("#sessionList");
const collapsedProjectListEl = document.querySelector("#collapsedProjectList");
const sessionTitleEl = document.querySelector("#sessionTitle");
const workspaceRootEl = document.querySelector("#workspaceRoot");
const messageListEl = document.querySelector("#messageList");
const emptyStateEl = document.querySelector("#emptyState");
const connectionBadgeEl = document.querySelector("#connectionBadge");
const sessionBadgeEl = document.querySelector("#sessionBadge");
const bannerEl = document.querySelector("#banner");
const inputEl = document.querySelector("#composerInput");
const sendBtnEl = document.querySelector("#sendBtn");
const newSessionBtnEl = document.querySelector("#newSessionBtn");
const interruptBtnEl = document.querySelector("#interruptBtn");
const deleteBtnEl = document.querySelector("#deleteBtn");
const viewportEl = document.querySelector("#messageViewport");
const anchorListEl = document.querySelector("#historyAnchorList");
const backToLatestBtnEl = document.querySelector("#backToLatestBtn");
const drawerBackdropEl = document.querySelector("#drawerBackdrop");

sendBtnEl.addEventListener("click", sendMessage);
newSessionBtnEl.addEventListener("click", createSession);
interruptBtnEl.addEventListener("click", interruptSession);
deleteBtnEl.addEventListener("click", deleteSession);
document.querySelector("#toggleSidebarBtn").addEventListener("click", toggleSidebar);
document.querySelector("#toggleOutlineBtn").addEventListener("click", toggleOutline);
document.querySelector("#mobileProjectsBtn").addEventListener("click", () => {
  appShellEl.classList.remove("mobile-outline-open");
  const isOpen = appShellEl.classList.toggle("mobile-sidebar-open");
  document.querySelector("#mobileProjectsBtn").setAttribute("aria-expanded", String(isOpen));
  updateDrawerBackdrop();
});
document.querySelector("#mobileOutlineBtn").addEventListener("click", () => {
  appShellEl.classList.remove("mobile-sidebar-open");
  const isOpen = appShellEl.classList.toggle("mobile-outline-open");
  document.querySelector("#mobileOutlineBtn").setAttribute("aria-expanded", String(isOpen));
  updateDrawerBackdrop();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    appShellEl.classList.remove("mobile-sidebar-open", "mobile-outline-open");
    document.querySelector("#mobileProjectsBtn").setAttribute("aria-expanded", "false");
    document.querySelector("#mobileOutlineBtn").setAttribute("aria-expanded", "false");
    updateDrawerBackdrop();
  }
});
drawerBackdropEl.addEventListener("click", closeMobileDrawers);
backToLatestBtnEl.addEventListener("click", () => {
  scrollToBottom(true);
  backToLatestBtnEl.classList.add("hidden");
});
viewportEl.addEventListener("scroll", updateViewportState, { passive: true });
anchorListEl.addEventListener("click", (event) => {
  const anchor = event.target.closest("[data-anchor-target]");
  if (!anchor) return;

  const target = messageListEl.querySelector(`[data-anchor-id="${CSS.escape(anchor.dataset.anchorTarget)}"]`);
  if (!target) return;

  const viewportRect = viewportEl.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  const topInset = 16;
  viewportEl.scrollTo({
    top: viewportEl.scrollTop + targetRect.top - viewportRect.top - topInset,
    behavior: "smooth"
  });
  state.activeAnchorId = anchor.dataset.anchorTarget;
  renderActiveAnchor();
  backToLatestBtnEl.classList.remove("hidden");
  closeMobileDrawers();
});

inputEl.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    sendMessage();
  }
});

connect();

function connect() {
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  const pagePath = location.pathname.replace(/\/+$/, "");
  const basePath = pagePath === "/agent-socket" ? pagePath : "";
  state.ws = new WebSocket(`${protocol}://${location.host}${basePath}/ws`);

  state.ws.addEventListener("open", () => {
    state.connected = true;
    renderConnection();
    hideBanner();
  });

  state.ws.addEventListener("close", () => {
    state.connected = false;
    renderConnection();
    showBanner("连接已断开，正在重连...");
    setTimeout(connect, 1200);
  });

  state.ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    onServerMessage(message);
  });
}

function onServerMessage(message) {
  const { type, payload } = message;

  if (type === "bootstrap") {
    state.ready = payload.ready;
    state.workspaceRoot = payload.workspaceRoot;
    if (Array.isArray(payload.sessions)) state.sessions = payload.sessions;
    workspaceRootEl.textContent = payload.workspaceRoot || "未知";
    if (payload.error) showBanner(payload.error);
    if (state.currentSessionId) {
      send({ type: "session.open", sessionId: state.currentSessionId });
    }
    renderSessions();
    renderConnection();
    return;
  }

  if (type === "sessions") {
    state.sessions = payload.sessions || [];
    renderSessions();
    return;
  }

  if (type === "connection.status") {
    state.ready = payload.ready;
    renderConnection();
    if (payload.ready) {
      hideBanner();
      send({ type: "session.list" });
      if (state.currentSessionId) send({ type: "session.open", sessionId: state.currentSessionId });
    } else {
      showBanner("Mac 执行通道已断开，等待重连...");
    }
    return;
  }

  if (type === "session.snapshot") {
    state.messages.set(payload.id, payload.messages || []);
    state.activeStatus.set(payload.id, payload.status || "idle");
    upsertSession(payload);
    if (!state.currentSessionId) state.currentSessionId = payload.id;
    if (state.currentSessionId === payload.id) {
      renderCurrentSession();
    }
    renderSessions();
    return;
  }

  if (type === "session.redirected") {
    state.currentSessionId = payload.sessionId;
    state.activeAnchorId = null;
    showBanner(payload.message || "已切换到网页分支");
    renderSessions();
    renderCurrentSession({ forceBottom: true });
    return;
  }

  if (type === "user.echo") {
    appendMessage(payload.sessionId, payload.message);
    if (!state.currentSessionId) state.currentSessionId = payload.sessionId;
    if (state.currentSessionId === payload.sessionId) renderCurrentSession({ forceBottom: true });
    return;
  }

  if (type === "assistant.delta") {
    appendStreamingDelta(payload.sessionId, payload.messageId, payload.delta);
    if (!state.currentSessionId) state.currentSessionId = payload.sessionId;
    if (state.currentSessionId === payload.sessionId) renderCurrentSession();
    return;
  }

  if (type === "assistant.final") {
    finalizeStreamingMessage(payload.sessionId, payload.messageId, payload.text, payload.phase);
    if (state.currentSessionId === payload.sessionId) renderCurrentSession();
    return;
  }

  if (type === "session.status") {
    state.activeStatus.set(payload.sessionId, payload.status);
    if (payload.sessionId === state.currentSessionId) renderCurrentSessionHeader();
    renderSessions();
    return;
  }

  if (type === "session.deleted") {
    state.sessions = state.sessions.filter((session) => session.id !== payload.sessionId);
    state.messages.delete(payload.sessionId);
    if (state.currentSessionId === payload.sessionId) {
      state.currentSessionId = state.sessions[0]?.id || null;
      if (state.currentSessionId) openSession(state.currentSessionId);
    }
    renderSessions();
    renderCurrentSession();
    return;
  }

  if (type === "status") {
    if (payload?.message) showBanner(payload.message);
    return;
  }

  if (type === "error") {
    showBanner(payload?.message || "未知错误");
  }
}

function createSession() {
  closeMobileDrawers();
  state.currentSessionId = null;
  renderSessions();
  renderCurrentSession({ forceBottom: true });
  inputEl.focus();
}

function openSession(sessionId) {
  closeMobileDrawers();
  state.currentSessionId = sessionId;
  state.activeAnchorId = null;
  const selectedSession = state.sessions.find((session) => session.id === sessionId);
  if (selectedSession?.cwd) state.collapsedProjects.delete(selectedSession.cwd);
  renderSessions();
  renderCurrentSession({ forceBottom: true });
  send({ type: "session.open", sessionId });
}

function sendMessage() {
  const text = inputEl.value.trim();
  if (!text) return;

  send({
    type: "message.send",
    sessionId: state.currentSessionId,
    text
  });

  backToLatestBtnEl.classList.add("hidden");
  inputEl.value = "";
  inputEl.focus();
}

function interruptSession() {
  if (!state.currentSessionId) return;
  send({ type: "session.interrupt", sessionId: state.currentSessionId });
}

function deleteSession() {
  if (!state.currentSessionId) return;

  const confirmed = window.confirm("确认删除当前会话？");
  if (!confirmed) return;

  send({ type: "session.delete", sessionId: state.currentSessionId });
}

function appendMessage(sessionId, message) {
  const messages = state.messages.get(sessionId) || [];
  messages.push(message);
  state.messages.set(sessionId, messages);
}

function appendStreamingDelta(sessionId, messageId, delta) {
  const messages = state.messages.get(sessionId) || [];
  let target = messages.find((message) => message.id === messageId);

  if (!target) {
    target = {
      id: messageId,
      role: "assistant",
      text: "",
      phase: "stream",
      streaming: true
    };
    messages.push(target);
  }

  target.text += delta;
  target.streaming = true;
  state.messages.set(sessionId, messages);
}

function finalizeStreamingMessage(sessionId, messageId, text, phase) {
  const messages = state.messages.get(sessionId) || [];
  let target = messages.find((message) => message.id === messageId);

  if (!target) {
    target = {
      id: messageId,
      role: "assistant",
      text: "",
      phase: phase || "final_answer"
    };
    messages.push(target);
  }

  target.text = text;
  target.phase = phase || "final_answer";
  target.streaming = false;
  state.messages.set(sessionId, messages);
}

function upsertSession(snapshot) {
  const next = {
    id: snapshot.id,
    title: snapshot.title,
    preview: snapshot.preview,
    updatedAt: snapshot.updatedAt,
    cwd: snapshot.cwd,
    status: snapshot.status,
    activeTurnId: snapshot.activeTurnId
  };

  const index = state.sessions.findIndex((session) => session.id === snapshot.id);
  if (index === -1) state.sessions.unshift(next);
  else state.sessions.splice(index, 1, { ...state.sessions[index], ...next });
}

function renderSessions() {
  sessionListEl.innerHTML = "";
  collapsedProjectListEl.innerHTML = "";

  const projects = new Map();

  for (const session of state.sessions) {
    const cwd = typeof session.cwd === "string" ? session.cwd : "";
    if (!projects.has(cwd)) {
      projects.set(cwd, { cwd, sessions: [], updatedAt: 0 });
    }
    const project = projects.get(cwd);
    project.sessions.push(session);
    project.updatedAt = Math.max(project.updatedAt, timestampValue(session.updatedAt));
  }

  const sortedProjects = [...projects.values()].sort((a, b) => {
    return b.updatedAt - a.updatedAt || projectDisplayName(a.cwd).localeCompare(projectDisplayName(b.cwd));
  });

  const initializeProjectGroups = sortedProjects.length > 0 && !state.projectGroupsInitialized;
  if (initializeProjectGroups) {
    for (const project of sortedProjects) state.collapsedProjects.add(project.cwd);
    const selectedSession = state.sessions.find((session) => session.id === state.currentSessionId);
    const initialProjectPath = selectedSession?.cwd || state.workspaceRoot;
    if (initialProjectPath) state.collapsedProjects.delete(initialProjectPath);
    state.projectGroupsInitialized = true;
  }

  for (const project of sortedProjects) {
    project.sessions.sort((a, b) => timestampValue(b.updatedAt) - timestampValue(a.updatedAt));
    if (!state.knownProjectPaths.has(project.cwd)) {
      if (!initializeProjectGroups && state.projectGroupsInitialized) state.collapsedProjects.add(project.cwd);
      state.knownProjectPaths.add(project.cwd);
    }

    const currentSession = state.sessions.find((session) => session.id === state.currentSessionId);
    const projectShortcut = document.createElement("button");
    projectShortcut.type = "button";
    projectShortcut.className = `collapsed-project-shortcut ${currentSession?.cwd === project.cwd ? "active" : ""}`;
    projectShortcut.title = `${projectDisplayName(project.cwd)} · ${project.cwd} · ${project.sessions.length} 个会话`;
    projectShortcut.setAttribute("aria-label", projectShortcut.title);
    projectShortcut.textContent = projectDisplayName(project.cwd).slice(0, 2).toUpperCase();
    projectShortcut.addEventListener("click", () => openProjectFromRail(project.cwd));
    collapsedProjectListEl.appendChild(projectShortcut);

    const group = document.createElement("details");
    group.className = "project-group";
    group.dataset.projectPath = project.cwd;
    group.open = !state.collapsedProjects.has(project.cwd);
    group.addEventListener("toggle", () => {
      if (group.open) state.collapsedProjects.delete(project.cwd);
      else state.collapsedProjects.add(project.cwd);
    });

    const heading = document.createElement("summary");
    heading.className = "project-header";

    const projectInfo = document.createElement("span");
    projectInfo.className = "project-info";

    const projectName = document.createElement("span");
    projectName.className = "project-name";
    projectName.textContent = projectDisplayName(project.cwd);

    const projectPath = document.createElement("span");
    projectPath.className = "project-path";
    projectPath.textContent = project.cwd || "工作目录未知";

    const projectCount = document.createElement("span");
    projectCount.className = "project-count";
    projectCount.textContent = String(project.sessions.length);

    projectInfo.append(projectName, projectPath);
    heading.append(projectInfo, projectCount);
    group.appendChild(heading);

    const projectSessions = document.createElement("div");
    projectSessions.className = "project-sessions";
    for (const session of project.sessions) {
      projectSessions.appendChild(createSessionItem(session));
    }
    group.appendChild(projectSessions);
    sessionListEl.appendChild(group);
  }
}

function createSessionItem(session) {
  const item = document.createElement("button");
  item.className = `session-item ${session.id === state.currentSessionId ? "active" : ""}`;
  item.innerHTML = `
    <div class="session-title-row">
      <span class="session-title">${escapeHtml(session.title || "New session")}</span>
      <span class="session-status ${statusClass(session)}"></span>
    </div>
    <div class="session-preview">${escapeHtml(session.preview || "空会话")}</div>
  `;
  item.querySelector(".session-status").title = statusLabel(state.activeStatus.get(session.id) || session.status);
  item.addEventListener("click", () => openSession(session.id));
  return item;
}

function projectDisplayName(cwd) {
  if (!cwd) return "未知项目";
  const normalized = cwd.replace(/[\\/]+$/, "");
  return normalized.split(/[\\/]/).pop() || cwd;
}

function timestampValue(value) {
  if (typeof value === "number") return value;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function renderCurrentSession({ forceBottom = false } = {}) {
  const sessionChanged = state.renderedSessionId !== state.currentSessionId;
  const wasAtBottom = isNearBottom();
  const previousScrollTop = viewportEl.scrollTop;
  const session = state.sessions.find((item) => item.id === state.currentSessionId);
  sessionTitleEl.textContent = session?.title || "新会话";

  const messages = state.currentSessionId ? state.messages.get(state.currentSessionId) || [] : [];

  messageListEl.innerHTML = "";
  emptyStateEl.classList.toggle("hidden", Boolean(messages.length));

  anchorListEl.innerHTML = "";

  for (const [index, message] of messages.entries()) {
    const card = document.createElement("article");
    card.className = `message-card role-${message.role}`;
    card.dataset.messageIndex = String(index);
    if (message.role === "user") card.dataset.anchorId = `user-${index}`;

    const label = labelForRole(message.role, message.phase);
    if (message.role === "command") {
      const [command, ...output] = String(message.text || "").split(/\r?\n/);
      card.innerHTML = `
        <details class="tool-output">
          <summary><span class="message-meta">${label}</span><code>${escapeHtml(command || "命令")}</code></summary>
          <pre><code>${escapeHtml(output.join("\n").trim() || "无输出")}</code></pre>
        </details>
      `;
    } else {
      card.innerHTML = `
        <div class="message-meta">${label}</div>
        <div class="message-text">${renderText(message.role === "user" ? displayUserMessage(message.text) : message.text, Boolean(message.streaming))}</div>
      `;
    }

    messageListEl.appendChild(card);

    if (message.role === "user") {
      const anchor = document.createElement("button");
      anchor.type = "button";
      anchor.className = "history-anchor";
      anchor.dataset.anchorTarget = `user-${index}`;
      const anchorIndex = document.createElement("span");
      anchorIndex.className = "anchor-index";
      anchorIndex.textContent = String(anchorListEl.childElementCount + 1).padStart(2, "0");
      const anchorText = document.createElement("span");
      anchorText.className = "anchor-text";
      const anchorSummary = summarizeMessage(displayUserMessage(message.text));
      anchorText.textContent = anchorSummary;
      anchor.title = anchorSummary;
      anchor.append(anchorIndex, anchorText);
      anchorListEl.appendChild(anchor);
    }
  }

  state.renderedSessionId = state.currentSessionId;
  renderCurrentSessionHeader();
  if (forceBottom || sessionChanged || wasAtBottom) {
    scrollToBottom();
    backToLatestBtnEl.classList.add("hidden");
  } else {
    viewportEl.scrollTop = previousScrollTop;
    backToLatestBtnEl.classList.remove("hidden");
  }
  updateActiveAnchor();
}

function renderCurrentSessionHeader() {
  const session = state.sessions.find((item) => item.id === state.currentSessionId);
  const runtimeStatus = state.activeStatus.get(state.currentSessionId) || session?.status || "idle";
  sessionBadgeEl.textContent = statusLabel(runtimeStatus);
  sessionBadgeEl.title = runtimeStatus;
  sessionBadgeEl.className = `badge ${runtimeStatus === "active" ? "badge-live" : ""}`;
}

function statusLabel(status) {
  const labels = {
    active: "进行中",
    idle: "空闲",
    notLoaded: "历史会话",
    systemError: "异常",
    unknown: "未知状态"
  };
  return labels[status] || status || "未知状态";
}

function renderConnection() {
  if (state.connected && state.ready) {
    connectionBadgeEl.textContent = "已连接";
    connectionBadgeEl.className = "badge badge-ok";
    return;
  }

  if (state.connected) {
    connectionBadgeEl.textContent = "初始化中";
    connectionBadgeEl.className = "badge badge-warn";
    return;
  }

  connectionBadgeEl.textContent = "已断开";
  connectionBadgeEl.className = "badge badge-danger";
}

function send(message) {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    showBanner("Socket 未连接");
    return;
  }

  state.ws.send(JSON.stringify(message));
}

function showBanner(text) {
  bannerEl.textContent = text;
  bannerEl.classList.remove("hidden");
}

function hideBanner() {
  bannerEl.classList.add("hidden");
}

function scrollToBottom(smooth = false) {
  viewportEl.scrollTo({
    top: viewportEl.scrollHeight,
    behavior: smooth ? "smooth" : "auto"
  });
}

function isNearBottom() {
  return viewportEl.scrollHeight - viewportEl.clientHeight - viewportEl.scrollTop < 100;
}

function updateViewportState() {
  updateActiveAnchor();
  backToLatestBtnEl.classList.toggle("hidden", isNearBottom());
}

function updateActiveAnchor() {
  const userCards = [...messageListEl.querySelectorAll("[data-anchor-id]")];
  if (!userCards.length) {
    state.activeAnchorId = null;
    renderActiveAnchor();
    return;
  }

  const viewportTop = viewportEl.getBoundingClientRect().top + 48;
  const currentCard = userCards.filter((card) => card.getBoundingClientRect().top <= viewportTop).at(-1)
    || userCards.find((card) => card.getBoundingClientRect().bottom > viewportTop)
    || userCards[0];
  state.activeAnchorId = currentCard.dataset.anchorId;
  renderActiveAnchor();
}

function renderActiveAnchor() {
  let activeAnchor = null;
  for (const anchor of anchorListEl.querySelectorAll("[data-anchor-target]")) {
    const active = anchor.dataset.anchorTarget === state.activeAnchorId;
    anchor.classList.toggle("active", active);
    if (active) {
      anchor.setAttribute("aria-current", "location");
      activeAnchor = anchor;
    } else anchor.removeAttribute("aria-current");
  }
  activeAnchor?.scrollIntoView({ block: "nearest" });
}

function summarizeMessage(text) {
  const summary = String(text || "用户消息").replace(/\s+/g, " ").trim();
  return summary.length > 64 ? `${summary.slice(0, 64)}…` : summary;
}

function displayUserMessage(text) {
  let displayText = String(text || "");
  displayText = displayText.replace(/<in-app-browser-context\b[^>]*>[\s\S]*?<\/in-app-browser-context>/gi, "").trim();
  displayText = displayText.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");

  const requestMarker = "## My request:";
  const requestIndex = displayText.lastIndexOf(requestMarker);
  if (requestIndex >= 0) displayText = displayText.slice(requestIndex + requestMarker.length).trim();

  const replyMarker = "<send_user_message_question_reply>";
  const replyIndex = displayText.indexOf(replyMarker);
  if (replyIndex >= 0) {
    const jsonText = displayText.slice(replyIndex + replyMarker.length).split("</send_user_message_question_reply>")[0].trim();
    try {
      const replies = JSON.parse(jsonText);
      const answer = replies?.[0]?.answer;
      if (typeof answer === "string" && answer.trim()) displayText = answer.trim();
    } catch {
      displayText = displayText.slice(0, replyIndex).trim();
    }
  }
  return displayText || "用户消息";
}

function openProjectFromRail(projectPath) {
  state.collapsedProjects.delete(projectPath);
  if (isMobileLayout()) {
    appShellEl.classList.add("mobile-sidebar-open");
    appShellEl.classList.remove("mobile-outline-open");
    document.querySelector("#mobileProjectsBtn").setAttribute("aria-expanded", "true");
    document.querySelector("#mobileOutlineBtn").setAttribute("aria-expanded", "false");
    updateDrawerBackdrop();
  } else {
    appShellEl.classList.remove("is-sidebar-collapsed");
    const button = document.querySelector("#toggleSidebarBtn");
    button.textContent = "‹";
    button.title = "收起项目列表";
    button.setAttribute("aria-label", button.title);
    button.setAttribute("aria-expanded", "true");
  }

  renderSessions();
  requestAnimationFrame(() => {
    const group = [...sessionListEl.querySelectorAll(".project-group")]
      .find((item) => item.dataset.projectPath === projectPath);
    group?.scrollIntoView({ block: "nearest" });
  });
}

function closeMobileDrawers() {
  appShellEl.classList.remove("mobile-sidebar-open", "mobile-outline-open");
  document.querySelector("#mobileProjectsBtn").setAttribute("aria-expanded", "false");
  document.querySelector("#mobileOutlineBtn").setAttribute("aria-expanded", "false");
  updateDrawerBackdrop();
}

function isMobileLayout() {
  return window.matchMedia("(max-width: 1100px), (max-device-width: 1100px), (hover: none) and (pointer: coarse)").matches;
}

function updateDrawerBackdrop() {
  const drawerOpen = appShellEl.classList.contains("mobile-sidebar-open")
    || appShellEl.classList.contains("mobile-outline-open");
  drawerBackdropEl.classList.toggle("hidden", !drawerOpen);
}

function toggleSidebar() {
  if (isMobileLayout()) {
    closeMobileDrawers();
    return;
  }

  const collapsed = appShellEl.classList.toggle("is-sidebar-collapsed");
  const button = document.querySelector("#toggleSidebarBtn");
  button.textContent = collapsed ? "›" : "‹";
  button.title = collapsed ? "展开项目列表" : "收起项目列表";
  button.setAttribute("aria-label", button.title);
  button.setAttribute("aria-expanded", String(!collapsed));
}

function toggleOutline() {
  if (isMobileLayout()) {
    closeMobileDrawers();
    return;
  }

  const collapsed = appShellEl.classList.toggle("is-outline-collapsed");
  const button = document.querySelector("#toggleOutlineBtn");
  button.textContent = collapsed ? "‹" : "›";
  button.title = collapsed ? "展开对话目录" : "收起对话目录";
  button.setAttribute("aria-label", button.title);
  button.setAttribute("aria-expanded", String(!collapsed));
}

function labelForRole(role, phase) {
  if (role === "user") return "你";
  if (role === "assistant") return phase === "commentary" ? "Codex · 进度" : "Codex";
  if (role === "plan") return "计划";
  if (role === "reasoning") return "推理摘要";
  if (role === "command") return "命令";
  return "系统";
}

function renderText(text, streaming) {
  const lines = escapeHtml(text || "").split(/\r?\n/);
  const blocks = [];
  let paragraph = [];
  let listItems = [];
  let listType = "";
  let codeLines = [];
  let inCode = false;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    blocks.push(`<p>${paragraph.map(renderInlineMarkdown).join("<br>")}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (!listItems.length) return;
    blocks.push(`<${listType}>${listItems.map((item) => `<li>${renderInlineMarkdown(item)}</li>`).join("")}</${listType}>`);
    listItems = [];
    listType = "";
  };
  const flushTextBlocks = () => {
    flushParagraph();
    flushList();
  };

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      flushTextBlocks();
      if (inCode) {
        blocks.push(`<pre><code>${codeLines.join("\n")}</code></pre>`);
        codeLines = [];
      }
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      codeLines.push(line);
      continue;
    }
    if (!line.trim()) {
      flushTextBlocks();
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      flushTextBlocks();
      const level = heading[1].length;
      blocks.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }

    const unorderedItem = line.match(/^\s*[-*+]\s+(.+)$/);
    const orderedItem = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (unorderedItem || orderedItem) {
      flushParagraph();
      const nextListType = unorderedItem ? "ul" : "ol";
      if (listType && listType !== nextListType) flushList();
      listType = nextListType;
      listItems.push((unorderedItem || orderedItem)[1]);
      continue;
    }

    const quote = line.match(/^\s*&gt;\s?(.*)$/);
    if (quote) {
      flushTextBlocks();
      blocks.push(`<blockquote>${renderInlineMarkdown(quote[1])}</blockquote>`);
      continue;
    }

    flushList();
    paragraph.push(line);
  }

  flushTextBlocks();
  if (inCode) blocks.push(`<pre><code>${codeLines.join("\n")}</code></pre>`);
  const rendered = blocks.join("");
  return streaming ? `${rendered}<span class="cursor"></span>` : rendered;
}

function renderInlineMarkdown(text) {
  return text
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/__(.+?)__/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, "$1<em>$2</em>");
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function statusClass(session) {
  const status = state.activeStatus.get(session.id) || session.status;
  if (status === "active") return "live";
  if (status === "systemError") return "error";
  return "idle";
}
