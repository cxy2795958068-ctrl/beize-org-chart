import { createClient } from "@supabase/supabase-js";
import "./styles.css";
import {
  NODE_TYPES,
  buildForest,
  countByType,
  getDescendantIds,
  getVisibleIds,
  makeDemoNodes,
  normalizeNode,
  validateNodeDraft,
} from "./core.js";

const CONFIG = Object.freeze({
  supabaseUrl: String(window.__BEIZE_CONFIG__?.SUPABASE_URL ?? "").trim(),
  supabaseAnonKey: String(window.__BEIZE_CONFIG__?.SUPABASE_ANON_KEY ?? "").trim(),
  defaultOrgName: String(window.__BEIZE_CONFIG__?.DEFAULT_ORG_NAME ?? "北泽公司").trim() || "北泽公司",
});

const DEMO_STORAGE_KEY = "beize-org-chart:demo:v1";
const QUEUE_STORAGE_KEY = "beize-org-chart:pending:v1";
const CLOUD_ENABLED = /^https:\/\/.+\.supabase\.co$/i.test(CONFIG.supabaseUrl) && CONFIG.supabaseAnonKey.length > 40;
const EDITABLE_ROLES = new Set(["owner", "editor"]);

const $ = (selector) => document.querySelector(selector);
const dom = {
  app: $("#app"),
  orgTitle: $("#org-title"),
  searchInput: $("#search-input"),
  membersButton: $("#members-button"),
  syncStatus: $("#sync-status"),
  accountButton: $("#account-button"),
  offlineBanner: $("#offline-banner"),
  statDepartments: $("#stat-departments"),
  statPositions: $("#stat-positions"),
  statPeople: $("#stat-people"),
  addRootButton: $("#add-root-button"),
  trashButton: $("#trash-button"),
  visibleCount: $("#visible-count"),
  filterLabel: $("#filter-label"),
  zoomOut: $("#zoom-out"),
  zoomReset: $("#zoom-reset"),
  zoomIn: $("#zoom-in"),
  zoomValue: $("#zoom-value"),
  treeScroller: $("#tree-scroller"),
  treeStage: $("#tree-stage"),
  inspector: $("#inspector"),
  inspectorEmpty: $("#inspector-empty"),
  nodeForm: $("#node-form"),
  inspectorTitle: $("#inspector-title"),
  closeInspector: $("#close-inspector"),
  fieldType: $("#field-type"),
  fieldName: $("#field-name"),
  fieldTitle: $("#field-title"),
  fieldParent: $("#field-parent"),
  fieldNotes: $("#field-notes"),
  updatedMeta: $("#updated-meta"),
  roleMeta: $("#role-meta"),
  addChildButton: $("#add-child-button"),
  moveUpButton: $("#move-up-button"),
  moveDownButton: $("#move-down-button"),
  deleteNodeButton: $("#delete-node-button"),
  authScreen: $("#auth-screen"),
  authDescription: $("#auth-description"),
  authForm: $("#auth-form"),
  authEmail: $("#auth-email"),
  createOrgForm: $("#create-org-form"),
  createOrgName: $("#create-org-name"),
  authFeedback: $("#auth-feedback"),
  modalBackdrop: $("#modal-backdrop"),
  modal: $("#modal"),
  modalEyebrow: $("#modal-eyebrow"),
  modalTitle: $("#modal-title"),
  modalClose: $("#modal-close"),
  modalContent: $("#modal-content"),
  modalActions: $("#modal-actions"),
  toastRegion: $("#toast-region"),
};

const state = {
  client: null,
  user: null,
  organization: null,
  memberships: [],
  role: "viewer",
  nodes: [],
  selectedId: null,
  query: "",
  zoom: 1,
  channel: null,
  saveTimers: new Map(),
  editSequences: new Map(),
  dirty: new Set(),
  remotePending: new Map(),
  creating: new Set(),
  queue: [],
  queueRetryTimer: null,
  flushing: false,
  inflightWrites: 0,
  booted: false,
};

function readJson(key, fallback) {
  try {
    const parsed = JSON.parse(localStorage.getItem(key));
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function queueStorageKey() {
  if (!CLOUD_ENABLED || !state.user) return null;
  const projectHost = new URL(CONFIG.supabaseUrl).hostname.replace(/[^a-z0-9.-]/gi, "_");
  return `${QUEUE_STORAGE_KEY}:${projectHost}:${state.user.id}`;
}

function loadUserQueue() {
  const key = queueStorageKey();
  state.queue = key ? readJson(key, []) : [];
}

function saveUserQueue() {
  const key = queueStorageKey();
  if (key) writeJson(key, state.queue);
}

function selectedOrgStorageKey() {
  if (!CLOUD_ENABLED || !state.user) return null;
  return `beize-org-chart:selected-org:${new URL(CONFIG.supabaseUrl).hostname}:${state.user.id}`;
}

function makeElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function makeButton(label, className, onClick) {
  const button = makeElement("button", `button ${className}`, label);
  button.type = "button";
  button.addEventListener("click", onClick);
  return button;
}

function canEdit() {
  return !CLOUD_ENABLED || EDITABLE_ROLES.has(state.role);
}

function canManageMembers() {
  return CLOUD_ENABLED && state.role === "owner";
}

async function trackedWrite(task) {
  state.inflightWrites += 1;
  try {
    return await task();
  } finally {
    state.inflightWrites = Math.max(0, state.inflightWrites - 1);
  }
}

function isNetworkError(error) {
  const message = String(error?.message ?? error ?? "");
  return !navigator.onLine || /fetch|network|failed to fetch|load failed/i.test(message);
}

function isConflictError(error) {
  return error?.code === "40001" || /version changed|deletion batch changed|reload and retry/i.test(String(error?.message ?? ""));
}

function rpcRow(data) {
  return Array.isArray(data) ? (data[0] ?? null) : data;
}

function friendlyError(error) {
  const message = String(error?.message ?? error ?? "操作失败");
  if (/row-level security|permission|not allowed|forbidden/i.test(message)) return "当前账号没有执行此操作的权限";
  if (/duplicate key/i.test(message)) return "相同数据已经存在，请刷新后重试";
  if (isNetworkError(error)) return "网络不可用，修改已保存在本机等待同步";
  return message.length > 160 ? "操作失败，请稍后重试" : message;
}

function formatTime(value) {
  if (!value) return "尚未保存";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "尚未保存";
  return `更新于 ${new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date)}`;
}

function initials(value) {
  const text = String(value ?? "").trim();
  if (!text) return "用户";
  if (text.includes("@")) return text.slice(0, 2).toUpperCase();
  return text.slice(0, 2);
}

function setStatus(text, kind = "local") {
  dom.syncStatus.className = `status-pill status-${kind}`;
  dom.syncStatus.querySelector("span:last-child").textContent = text;
}

function showToast(message, actionLabel, action) {
  const toast = makeElement("div", "toast");
  toast.append(makeElement("span", "", message));
  if (actionLabel && action) {
    const button = makeElement("button", "", actionLabel);
    button.type = "button";
    button.addEventListener("click", async () => {
      button.disabled = true;
      await action();
      toast.remove();
    });
    toast.append(button);
  }
  dom.toastRegion.append(toast);
  window.setTimeout(() => toast.remove(), actionLabel ? 10000 : 4500);
}

function openModal({ title, eyebrow = "操作", content, actions = [], wide = false }) {
  dom.modalTitle.textContent = title;
  dom.modalEyebrow.textContent = eyebrow;
  dom.modal.classList.toggle("wide", wide);
  dom.modalContent.replaceChildren(content);
  dom.modalActions.replaceChildren();
  for (const action of actions) {
    dom.modalActions.append(
      makeButton(action.label, action.className ?? "button-secondary", async () => {
        if (action.close !== false) closeModal();
        await action.onClick?.();
      }),
    );
  }
  dom.modalBackdrop.classList.remove("hidden");
}

function closeModal() {
  dom.modalBackdrop.classList.add("hidden");
  dom.modal.classList.remove("wide");
  dom.modalContent.replaceChildren();
  dom.modalActions.replaceChildren();
}

function activeNodes() {
  return state.nodes.filter((node) => !node.deleted_at);
}

function selectedNode() {
  return state.nodes.find((node) => node.id === state.selectedId && !node.deleted_at) ?? null;
}

function replaceNode(nextNode, { preserveDraft = false } = {}) {
  const normalized = normalizeNode(nextNode);
  const index = state.nodes.findIndex((node) => node.id === normalized.id);
  if (index < 0) {
    state.nodes.push(normalized);
    return;
  }
  if (preserveDraft) {
    const current = state.nodes[index];
    state.nodes[index] = normalizeNode({ ...normalized, name: current.name, title: current.title, notes: current.notes, parent_id: current.parent_id, type: current.type });
  } else {
    state.nodes[index] = normalized;
  }
}

function renderAll({ refreshForm = false } = {}) {
  renderStats();
  renderTree();
  renderInspector(refreshForm);
  applyPermissions();
}

function renderStats() {
  const counts = countByType(state.nodes);
  dom.statDepartments.textContent = String(counts.department);
  dom.statPositions.textContent = String(counts.position);
  dom.statPeople.textContent = String(counts.person);
}

function nodeMatches(node) {
  const query = state.query.trim().toLocaleLowerCase("zh-CN");
  if (!query) return false;
  return `${node.name} ${node.title} ${node.notes}`.toLocaleLowerCase("zh-CN").includes(query);
}

function renderTree() {
  dom.treeStage.replaceChildren();
  dom.treeStage.style.transform = `scale(${state.zoom})`;
  dom.zoomValue.textContent = `${Math.round(state.zoom * 100)}%`;

  const visible = getVisibleIds(state.nodes, state.query);
  const forest = buildForest(state.nodes);
  const visibleNodes = activeNodes().filter((node) => visible.has(node.id));
  dom.visibleCount.textContent = `${visibleNodes.length} 个节点`;
  dom.filterLabel.textContent = state.query ? ` · 匹配“${state.query}”` : "";

  if (!forest.length) {
    const empty = makeElement("div", "tree-empty");
    empty.append(makeElement("strong", "", "组织架构还是空的"));
    empty.append(makeElement("span", "", canEdit() ? "从新增顶级部门开始搭建。" : "请联系管理员添加组织节点。"));
    dom.treeStage.append(empty);
    return;
  }
  if (!visibleNodes.length) {
    const empty = makeElement("div", "tree-empty");
    empty.append(makeElement("strong", "", "没有找到匹配节点"));
    empty.append(makeElement("span", "", "换一个名称、岗位或人员关键词试试。"));
    dom.treeStage.append(empty);
    return;
  }

  const rootList = makeElement("ul", "org-tree");
  for (const root of forest) {
    const branch = renderBranch(root, visible);
    if (branch) rootList.append(branch);
  }
  dom.treeStage.append(rootList);
}

function renderBranch(node, visible) {
  if (!visible.has(node.id)) return null;
  const item = makeElement("li");
  const card = makeElement("button", `node-card type-${node.type}`);
  card.type = "button";
  card.dataset.nodeId = node.id;
  card.setAttribute("aria-label", `编辑${NODE_TYPES[node.type]}：${node.name || "未命名"}`);
  if (node.id === state.selectedId) card.classList.add("selected");
  if (nodeMatches(node)) card.classList.add("search-match");
  card.append(makeElement("span", "node-strip"));
  const body = makeElement("span", "node-body");
  body.append(makeElement("span", "node-type", NODE_TYPES[node.type]));
  body.append(makeElement("span", "node-name", node.name || "未命名"));
  if (node.title) body.append(makeElement("span", "node-title", node.title));
  card.append(body);
  card.addEventListener("click", () => selectNode(node.id));
  item.append(card);

  const children = node.children.map((child) => renderBranch(child, visible)).filter(Boolean);
  if (children.length) {
    const list = makeElement("ul");
    list.append(...children);
    item.append(list);
  }
  return item;
}

function selectNode(id) {
  state.selectedId = id;
  renderTree();
  renderInspector(true);
  dom.inspector.classList.add("open");
}

function clearSelection() {
  state.selectedId = null;
  dom.inspector.classList.remove("open");
  renderTree();
  renderInspector(true);
}

function parentLabel(node) {
  return `${NODE_TYPES[node.type]} · ${node.name || "未命名"}`;
}

function renderInspector(force = false) {
  const node = selectedNode();
  dom.inspectorEmpty.classList.toggle("hidden", Boolean(node));
  dom.nodeForm.classList.toggle("hidden", !node);
  if (!node) return;
  if (!force && state.dirty.has(node.id)) return;

  dom.inspectorTitle.textContent = node.name || "未命名节点";
  dom.fieldType.value = node.type;
  dom.fieldName.value = node.name;
  dom.fieldTitle.value = node.title;
  dom.fieldNotes.value = node.notes;
  dom.updatedMeta.textContent = formatTime(node.updated_at);
  dom.roleMeta.textContent = CLOUD_ENABLED ? `权限：${state.role}` : "本机草稿模式";

  const excluded = getDescendantIds(state.nodes, node.id);
  excluded.add(node.id);
  dom.fieldParent.replaceChildren();
  const rootOption = makeElement("option", "", "无上级（顶级节点）");
  rootOption.value = "";
  dom.fieldParent.append(rootOption);
  for (const candidate of activeNodes().filter((item) => !excluded.has(item.id)).sort((a, b) => a.name.localeCompare(b.name, "zh-CN"))) {
    const option = makeElement("option", "", parentLabel(candidate));
    option.value = candidate.id;
    dom.fieldParent.append(option);
  }
  dom.fieldParent.value = node.parent_id ?? "";
}

function applyPermissions() {
  const editable = canEdit();
  for (const element of [dom.fieldType, dom.fieldName, dom.fieldTitle, dom.fieldParent, dom.fieldNotes, dom.addChildButton, dom.moveUpButton, dom.moveDownButton, dom.deleteNodeButton, dom.addRootButton]) {
    element.disabled = !editable;
  }
  dom.membersButton.textContent = canManageMembers() ? "协作成员" : "成员列表";
}

function draftFromForm() {
  return {
    type: dom.fieldType.value,
    name: dom.fieldName.value.trim(),
    title: dom.fieldTitle.value.trim(),
    parent_id: dom.fieldParent.value || null,
    notes: dom.fieldNotes.value.trim(),
  };
}

function handleFormEdit() {
  const node = selectedNode();
  if (!node || !canEdit()) return;
  const draft = draftFromForm();
  const errors = validateNodeDraft(draft, state.nodes, node.id);
  replaceNode({ ...node, ...draft });
  state.dirty.add(node.id);
  dom.inspectorTitle.textContent = draft.name || "未命名节点";
  renderTree();
  renderStats();
  if (errors.length) {
    setStatus("等待补全", "error");
    return;
  }
  scheduleSave(node.id);
}

function scheduleSave(id, delay = 650) {
  const previous = state.saveTimers.get(id);
  if (previous) window.clearTimeout(previous);
  const sequence = (state.editSequences.get(id) ?? 0) + 1;
  state.editSequences.set(id, sequence);
  state.saveTimers.set(id, window.setTimeout(() => persistNode(id, sequence), delay));
  setStatus(CLOUD_ENABLED ? "正在保存" : "保存到本机", "saving");
}

async function persistNode(id, sequence) {
  state.saveTimers.delete(id);
  const node = state.nodes.find((item) => item.id === id);
  if (!node || node.deleted_at) return;
  if (state.creating.has(id)) return;
  const payload = { type: node.type, name: node.name, title: node.title, notes: node.notes, parent_id: node.parent_id };
  const errors = validateNodeDraft(payload, state.nodes, id);
  if (errors.length) return;

  if (!CLOUD_ENABLED) {
    replaceNode({ ...node, version: node.version + 1, updated_at: new Date().toISOString() });
    persistDemo();
    state.dirty.delete(id);
    renderAll({ refreshForm: true });
    setStatus("已保存到本机", "local");
    return;
  }

  const expectedVersion = node.version;
  try {
    const { data: rawData, error } = await state.client.rpc("update_org_node", {
      p_node_id: id,
      p_expected_version: expectedVersion,
      p_patch: payload,
    });
    if (error && isConflictError(error)) {
      await resolveConflict(id, payload);
      return;
    }
    if (error) throw error;
    const data = rpcRow(rawData);
    if (!data) throw new Error("云端未返回已保存的节点");

    const stillCurrent = state.editSequences.get(id) === sequence;
    replaceNode(data, { preserveDraft: !stillCurrent });
    state.remotePending.delete(id);
    if (stillCurrent) {
      state.dirty.delete(id);
      setStatus("云端已保存", "saved");
      renderAll({ refreshForm: true });
    } else {
      scheduleSave(id, 80);
    }
  } catch (error) {
    if (isNetworkError(error)) {
      queueMutation({ kind: "update", id, organization_id: state.organization.id, payload, expectedVersion });
      state.dirty.delete(id);
      setStatus("等待联网同步", "offline");
      showToast("网络不可用，修改已暂存在这台电脑");
      return;
    }
    setStatus("保存失败", "error");
    showToast(friendlyError(error));
  }
}

async function resolveConflict(id, localPayload, { queueId = null } = {}) {
  const { data: remote, error } = await state.client.from("org_nodes").select("*").eq("id", id).single();
  if (error || !remote) {
    if (queueId) {
      if (isNetworkError(error)) scheduleQueueRetry(8000);
      else {
        blockQueuedMutation(queueId, "云端节点不存在或当前账号已无权访问");
        scheduleQueueRetry(500);
      }
    }
    setStatus("需要刷新", "error");
    showToast("节点已被删除或权限发生变化，请刷新页面");
    return;
  }
  if (remote.deleted_at) {
    const content = makeElement("div");
    content.append(makeElement("p", "modal-content-copy", "另一位成员已经把这个节点移入回收站。为避免在用户不知情时复活整棵子树，本次本地修改不能直接覆盖删除操作。需要继续编辑时，请先从回收站恢复节点。"));
    setStatus("节点已被其他成员删除", "error");
    openModal({
      title: "节点已进入回收站",
      eyebrow: "删除冲突保护",
      content,
      actions: [
        {
          label: "接受云端状态",
          className: "button-primary",
          onClick: () => {
            discardQueuedMutation(queueId);
            replaceNode(remote);
            state.dirty.delete(id);
            state.remotePending.delete(id);
            if (state.selectedId === id) state.selectedId = null;
          renderAll({ refreshForm: true });
          setStatus("已同步回收站状态", "saved");
          flushQueue();
          },
        },
      ],
    });
    return;
  }
  const local = state.nodes.find((node) => node.id === id);
  const content = makeElement("div");
  content.append(makeElement("p", "modal-content-copy", "你编辑期间，另一位成员已经修改了同一节点。请选择保留哪一版，系统不会自动覆盖。"));
  const grid = makeElement("div", "conflict-grid");
  grid.append(makeConflictCard("你的版本", { ...local, ...localPayload }), makeConflictCard("云端最新版本", remote));
  content.append(grid);
  setStatus("发现版本冲突", "error");
  openModal({
    title: "检测到同时修改",
    eyebrow: "数据一致性保护",
    content,
    wide: true,
    actions: [
      {
        label: "采用云端版本",
        className: "button-secondary",
        onClick: () => {
          discardQueuedMutation(queueId);
          replaceNode(remote);
          state.dirty.delete(id);
          state.remotePending.delete(id);
          renderAll({ refreshForm: true });
          setStatus("已采用云端版本", "saved");
          flushQueue();
        },
      },
      {
        label: "保留我的版本",
        className: "button-primary",
        onClick: () => {
          discardQueuedMutation(queueId);
          replaceNode({ ...remote, ...localPayload, version: remote.version });
          state.dirty.add(id);
          state.remotePending.delete(id);
          renderAll({ refreshForm: true });
          scheduleSave(id, 50);
          scheduleQueueRetry(1000);
        },
      },
    ],
  });
}

function makeConflictCard(label, node) {
  const card = makeElement("div", "conflict-card");
  card.append(makeElement("strong", "", label));
  const list = makeElement("dl");
  for (const [term, value] of [["名称", node.name], ["岗位/副标题", node.title || "—"], ["备注", node.notes || "—"]]) {
    list.append(makeElement("dt", "", term), makeElement("dd", "", value));
  }
  card.append(list);
  return card;
}

function persistDemo() {
  writeJson(DEMO_STORAGE_KEY, state.nodes);
}

function queueMutation(mutation) {
  const entry = {
    ...mutation,
    queue_id: crypto.randomUUID(),
    queued_at: new Date().toISOString(),
    queued_by: state.user?.id ?? null,
    project_host: new URL(CONFIG.supabaseUrl).hostname,
  };
  if (entry.kind === "update") {
    let lastForNode = -1;
    for (let index = state.queue.length - 1; index >= 0; index -= 1) {
      if (mutationEntityId(state.queue[index]) === entry.id && state.queue[index].organization_id === entry.organization_id) {
        lastForNode = index;
        break;
      }
    }
    if (lastForNode >= 0 && state.queue[lastForNode].kind === "update" && !state.queue[lastForNode].blocked) {
      state.queue[lastForNode] = { ...entry, queue_id: state.queue[lastForNode].queue_id };
    } else state.queue.push(entry);
  } else if (entry.kind === "create") {
    const existing = state.queue.findIndex((item) => item.kind === "create" && item.id === entry.id && item.organization_id === entry.organization_id);
    if (existing >= 0) state.queue[existing] = { ...entry, queue_id: state.queue[existing].queue_id };
    else state.queue.push(entry);
  } else {
    // Delete and restore are ordered state transitions. Replacing an earlier
    // same-kind entry can cross the opposite operation and invert server state.
    state.queue.push(entry);
  }
  saveUserQueue();
  scheduleQueueRetry();
}

function mutationEntityId(item) {
  return item?.id ?? item?.node?.id ?? null;
}

function hasPendingNodeMutation(id) {
  return state.queue.some((item) => queueEntryMatchesCurrentContext(item, { includeBlocked: true }) && mutationEntityId(item) === id);
}

function discardQueuedMutation(queueId) {
  if (!queueId) return;
  const index = state.queue.findIndex((item) => item.queue_id === queueId);
  if (index >= 0) {
    state.queue.splice(index, 1);
    saveUserQueue();
  }
}

function blockQueuedMutation(queueId, reason) {
  const index = state.queue.findIndex((item) => item.queue_id === queueId);
  if (index < 0) return;
  state.queue[index] = { ...state.queue[index], blocked: true, blocked_reason: reason, blocked_at: new Date().toISOString() };
  saveUserQueue();
}

function queueEntryMatchesCurrentContext(item, { includeBlocked = false } = {}) {
  if (!state.organization || !state.user) return false;
  return (
    item.organization_id === state.organization.id &&
    item.queued_by === state.user.id &&
    item.project_host === new URL(CONFIG.supabaseUrl).hostname &&
    (includeBlocked || !item.blocked)
  );
}

function scheduleQueueRetry(delay = 12000) {
  if (!CLOUD_ENABLED || !navigator.onLine || !state.user) return;
  if (state.queueRetryTimer) window.clearTimeout(state.queueRetryTimer);
  state.queueRetryTimer = window.setTimeout(() => {
    state.queueRetryTimer = null;
    flushQueue();
  }, delay);
}

function nextReadyQueueIndex() {
  for (let index = 0; index < state.queue.length; index += 1) {
    const item = state.queue[index];
    if (!queueEntryMatchesCurrentContext(item)) continue;
    const entityId = mutationEntityId(item);
    const hasBlockedPredecessor = state.queue.slice(0, index).some(
      (prior) => queueEntryMatchesCurrentContext(prior, { includeBlocked: true }) && prior.blocked && mutationEntityId(prior) === entityId,
    );
    if (!hasBlockedPredecessor) return index;
  }
  return -1;
}

async function flushQueue() {
  if (!CLOUD_ENABLED || !navigator.onLine || state.flushing || !state.organization || !state.queue.length) return;
  const initialCount = state.queue.filter((item) => queueEntryMatchesCurrentContext(item)).length;
  const blockedCount = state.queue.filter((item) => queueEntryMatchesCurrentContext(item, { includeBlocked: true }) && item.blocked).length;
  if (!initialCount) {
    if (blockedCount) setStatus(`${blockedCount} 项修改需要处理`, "error");
    return;
  }
  if (state.queueRetryTimer) {
    window.clearTimeout(state.queueRetryTimer);
    state.queueRetryTimer = null;
  }
  state.flushing = true;
  setStatus(`同步 ${initialCount} 项修改`, "saving");
  let currentMutation = null;
  let currentQueueIndex = -1;
  try {
    while (true) {
      currentQueueIndex = nextReadyQueueIndex();
      if (currentQueueIndex < 0) break;
      currentMutation = state.queue[currentQueueIndex];
      let result;
      if (currentMutation.kind === "create") {
        result = await state.client.from("org_nodes").upsert(currentMutation.node, { onConflict: "id", ignoreDuplicates: true });
      } else if (currentMutation.kind === "update") {
        result = await state.client.rpc("update_org_node", {
          p_node_id: currentMutation.id,
          p_expected_version: currentMutation.expectedVersion,
          p_patch: currentMutation.payload,
        });
        if (result.error && isConflictError(result.error)) {
          await resolveConflict(currentMutation.id, currentMutation.payload, { queueId: currentMutation.queue_id });
          return;
        }
      } else if (currentMutation.kind === "delete") {
        result = await state.client.rpc("soft_delete_org_subtree", {
          p_root_node_id: currentMutation.id,
          p_mutation_id: currentMutation.mutation_id,
        });
      } else if (currentMutation.kind === "restore") {
        result = await state.client.rpc("restore_org_subtree", {
          p_root_node_id: currentMutation.id,
          p_expected_batch_id: currentMutation.expected_batch_id,
          p_mutation_id: currentMutation.mutation_id,
        });
      }
      if (result?.error) throw result.error;
      state.queue.splice(currentQueueIndex, 1);
      saveUserQueue();
    }
    const waitingBehindFailure = state.queue.some((item) => queueEntryMatchesCurrentContext(item));
    if (waitingBehindFailure) setStatus("有修改等待前序问题处理", "error");
    else {
      await loadNodes();
      setStatus("云端已同步", "saved");
    }
  } catch (error) {
    if (isNetworkError(error)) {
      setStatus("等待联网同步", "offline");
      scheduleQueueRetry(15000);
    } else if (currentMutation && currentQueueIndex >= 0) {
      const reason = friendlyError(error);
      blockQueuedMutation(currentMutation.queue_id, reason);
      const entityId = mutationEntityId(currentMutation);
      for (let index = currentQueueIndex + 1; index < state.queue.length; index += 1) {
        const dependent = state.queue[index];
        if (mutationEntityId(dependent) === entityId && dependent.organization_id === currentMutation.organization_id) {
          blockQueuedMutation(dependent.queue_id, "前序操作尚未成功，已暂停以保护操作顺序");
        }
      }
      setStatus("有修改需要人工处理", "error");
      showToast(`一项离线修改已暂停：${reason}`);
      scheduleQueueRetry(500);
    }
  } finally {
    state.flushing = false;
  }
}

function defaultChildType(parent) {
  if (!parent || parent.type === "company") return "department";
  if (parent.type === "department") return "position";
  return "person";
}

function showCreateNodeModal(parentId = null) {
  if (!canEdit()) return;
  const parent = state.nodes.find((node) => node.id === parentId) ?? null;
  const content = makeElement("form");
  const typeLabel = makeElement("label");
  typeLabel.append(makeElement("span", "", "类型"));
  const typeSelect = makeElement("select");
  for (const [value, label] of Object.entries(NODE_TYPES)) {
    if (value === "company" && activeNodes().some((node) => node.type === "company")) continue;
    const option = makeElement("option", "", label);
    option.value = value;
    typeSelect.append(option);
  }
  typeSelect.value = defaultChildType(parent);
  typeLabel.append(typeSelect);
  const nameLabel = makeElement("label");
  nameLabel.append(makeElement("span", "", "名称"));
  const nameInput = makeElement("input");
  nameInput.maxLength = 80;
  nameInput.required = true;
  nameInput.placeholder = typeSelect.value === "person" ? "输入人员姓名" : "输入部门或岗位名称";
  nameLabel.append(nameInput);
  const titleLabel = makeElement("label");
  titleLabel.append(makeElement("span", "", "岗位 / 副标题（可选）"));
  const titleInput = makeElement("input");
  titleInput.maxLength = 120;
  titleLabel.append(titleInput);
  content.append(typeLabel, nameLabel, titleLabel);

  openModal({
    title: parent ? `添加到「${parent.name}」` : "新增顶级节点",
    eyebrow: "组织节点",
    content,
    actions: [
      { label: "取消", className: "button-secondary" },
      {
        label: "创建节点",
        className: "button-primary",
        close: false,
        onClick: async () => {
          const draft = { type: typeSelect.value, name: nameInput.value.trim(), title: titleInput.value.trim(), notes: "", parent_id: parentId };
          const errors = validateNodeDraft(draft, state.nodes);
          if (errors.length) {
            showToast(errors[0]);
            nameInput.focus();
            return;
          }
          closeModal();
          await createNode(draft);
        },
      },
    ],
  });
  window.setTimeout(() => nameInput.focus(), 0);
}

async function createNode(draft) {
  const siblings = activeNodes().filter((node) => node.parent_id === draft.parent_id);
  const node = normalizeNode({
    ...draft,
    id: crypto.randomUUID(),
    organization_id: state.organization?.id ?? "demo-org",
    sort_order: Math.max(0, ...siblings.map((item) => item.sort_order)) + 10,
    version: 1,
    updated_at: new Date().toISOString(),
  });
  state.nodes.push(node);
  state.selectedId = node.id;
  renderAll({ refreshForm: true });
  dom.inspector.classList.add("open");

  if (!CLOUD_ENABLED) {
    persistDemo();
    setStatus("已保存到本机", "local");
    return;
  }
  state.creating.add(node.id);
  try {
    const payload = { id: node.id, organization_id: state.organization.id, parent_id: node.parent_id, type: node.type, name: node.name, title: node.title, notes: node.notes, sort_order: node.sort_order };
    const { data, error } = await state.client.from("org_nodes").insert(payload).select("*").single();
    if (error) throw error;
    const editedDuringCreate = state.dirty.has(node.id);
    state.creating.delete(node.id);
    replaceNode(data, { preserveDraft: editedDuringCreate });
    renderAll({ refreshForm: !editedDuringCreate });
    if (editedDuringCreate) scheduleSave(node.id, 50);
    else setStatus("云端已保存", "saved");
  } catch (error) {
    state.creating.delete(node.id);
    if (isNetworkError(error)) {
      const editedDuringCreate = state.dirty.has(node.id);
      const timer = state.saveTimers.get(node.id);
      if (timer) window.clearTimeout(timer);
      state.saveTimers.delete(node.id);
      const latestNode = state.nodes.find((item) => item.id === node.id) ?? node;
      state.dirty.delete(node.id);
      queueMutation({ kind: "create", id: latestNode.id, organization_id: state.organization.id, node: latestNode });
      if (editedDuringCreate) {
        queueMutation({
          kind: "update",
          id: latestNode.id,
          organization_id: state.organization.id,
          expectedVersion: 1,
          payload: {
            type: latestNode.type,
            name: latestNode.name,
            title: latestNode.title,
            notes: latestNode.notes,
            parent_id: latestNode.parent_id,
          },
        });
      }
      setStatus("等待联网同步", "offline");
      showToast("节点已保存在本机，联网后自动同步");
    } else {
      state.nodes = state.nodes.filter((item) => item.id !== node.id);
      clearSelection();
      showToast(friendlyError(error));
    }
  }
}

function applyLocalDelete(rootId, batchId = crypto.randomUUID()) {
  const ids = getDescendantIds(state.nodes, rootId);
  ids.add(rootId);
  const deletedAt = new Date().toISOString();
  state.nodes = state.nodes.map((node) => (ids.has(node.id) ? normalizeNode({ ...node, deleted_at: deletedAt, deleted_batch_id: batchId }) : node));
  return ids.size;
}

function applyLocalRestore(rootId) {
  const root = state.nodes.find((node) => node.id === rootId);
  if (!root) return 0;
  const batch = root.deleted_batch_id;
  let count = 0;
  state.nodes = state.nodes.map((node) => {
    if (node.id === rootId || (batch && node.deleted_batch_id === batch)) {
      count += 1;
      return normalizeNode({ ...node, deleted_at: null, deleted_batch_id: null });
    }
    return node;
  });
  return count;
}

function confirmDeleteSelected() {
  const node = selectedNode();
  if (!node || !canEdit()) return;
  const count = getDescendantIds(state.nodes, node.id).size + 1;
  const content = makeElement("div");
  content.append(makeElement("p", "modal-content-copy", `「${node.name}」及其 ${count - 1} 个下级节点将进入回收站。它们不会被立即永久删除，可以恢复。`));
  openModal({
    title: `移除 ${count} 个节点？`,
    eyebrow: "误删保护",
    content,
    actions: [
      { label: "取消", className: "button-secondary" },
      { label: "移入回收站", className: "button-danger", onClick: () => deleteSubtree(node.id) },
    ],
  });
}

async function deleteSubtree(id) {
  const snapshot = state.nodes.map((node) => ({ ...node }));
  const mutationId = crypto.randomUUID();
  const hadPendingMutation = CLOUD_ENABLED && hasPendingNodeMutation(id);
  const count = applyLocalDelete(id, mutationId);
  clearSelection();
  renderAll({ refreshForm: true });
  if (!CLOUD_ENABLED) {
    persistDemo();
    setStatus("已移入本机回收站", "local");
    showToast(`已移除 ${count} 个节点`, "撤销", () => restoreSubtree(id));
    return;
  }
  if (hadPendingMutation || !navigator.onLine) {
    queueMutation({ kind: "delete", id, organization_id: state.organization.id, mutation_id: mutationId });
    setStatus("等待联网同步", "offline");
    showToast("删除操作已按顺序保存在本机，联网后同步", "撤销", () => restoreSubtree(id));
    return;
  }
  try {
    setStatus("正在保存", "saving");
    const { error } = await trackedWrite(() => state.client.rpc("soft_delete_org_subtree", {
      p_root_node_id: id,
      p_mutation_id: mutationId,
    }));
    if (error) throw error;
    await loadNodes();
    setStatus("云端已保存", "saved");
    showToast(`已移入回收站，共 ${count} 个节点`, "撤销", () => restoreSubtree(id));
  } catch (error) {
    if (isNetworkError(error)) {
      queueMutation({ kind: "delete", id, organization_id: state.organization.id, mutation_id: mutationId });
      setStatus("等待联网同步", "offline");
      showToast("删除操作已暂存在本机，联网后同步", "撤销", () => restoreSubtree(id));
    } else {
      state.nodes = snapshot.map(normalizeNode);
      renderAll({ refreshForm: true });
      showToast(friendlyError(error));
    }
  }
}

async function restoreSubtree(id) {
  const root = state.nodes.find((node) => node.id === id);
  const expectedBatchId = root?.deleted_batch_id ?? null;
  if (!expectedBatchId) {
    showToast("该节点当前不在回收站中");
    return;
  }
  const mutationId = crypto.randomUUID();
  const hadPendingMutation = CLOUD_ENABLED && hasPendingNodeMutation(id);
  applyLocalRestore(id);
  renderAll({ refreshForm: true });
  if (!CLOUD_ENABLED) {
    persistDemo();
    setStatus("已从回收站恢复", "local");
    return;
  }
  if (hadPendingMutation || !navigator.onLine) {
    queueMutation({
      kind: "restore",
      id,
      organization_id: state.organization.id,
      expected_batch_id: expectedBatchId,
      mutation_id: mutationId,
    });
    setStatus("等待联网同步", "offline");
    return;
  }
  try {
    setStatus("正在保存", "saving");
    const { error } = await trackedWrite(() => state.client.rpc("restore_org_subtree", {
      p_root_node_id: id,
      p_expected_batch_id: expectedBatchId,
      p_mutation_id: mutationId,
    }));
    if (error) throw error;
    await loadNodes();
    setStatus("已从回收站恢复", "saved");
  } catch (error) {
    if (isNetworkError(error)) {
      queueMutation({
        kind: "restore",
        id,
        organization_id: state.organization.id,
        expected_batch_id: expectedBatchId,
        mutation_id: mutationId,
      });
      setStatus("等待联网同步", "offline");
    } else {
      await loadNodes();
      showToast(friendlyError(error));
    }
  }
}

function showTrash() {
  const deleted = state.nodes.filter((node) => node.deleted_at).sort((a, b) => String(b.deleted_at).localeCompare(String(a.deleted_at)));
  const content = makeElement("div");
  if (!deleted.length) {
    content.append(makeElement("p", "modal-content-copy", "回收站是空的。被删除的节点会在这里保留，数据库可按策略定期清理。"));
  } else {
    content.append(makeElement("p", "modal-content-copy", `当前有 ${deleted.length} 个已删除节点。恢复父节点时，只恢复与它同一批删除的下级，避免复活更早删除的数据。`));
    const list = makeElement("ul", "modal-list");
    for (const node of deleted.filter((item) => !deleted.some((candidate) => candidate.id === item.parent_id && candidate.deleted_batch_id === item.deleted_batch_id))) {
      const item = makeElement("li", "modal-list-item");
      const copy = makeElement("div");
      copy.append(makeElement("strong", "", node.name || "未命名节点"));
      copy.append(makeElement("span", "", `${NODE_TYPES[node.type]} · ${formatTime(node.deleted_at).replace("更新于", "删除于")}`));
      const restore = makeButton("恢复", "button-secondary", async () => {
        await restoreSubtree(node.id);
        closeModal();
      });
      restore.disabled = !canEdit();
      item.append(copy, restore);
      list.append(item);
    }
    content.append(list);
  }
  openModal({ title: "回收站", eyebrow: "误删保护", content, wide: true, actions: [{ label: "关闭", className: "button-secondary" }] });
}

async function reorderSelected(direction) {
  const node = selectedNode();
  if (!node || !canEdit()) return;
  if (!CLOUD_ENABLED) {
    const siblings = activeNodes().filter((item) => item.parent_id === node.parent_id).sort((a, b) => a.sort_order - b.sort_order);
    const index = siblings.findIndex((item) => item.id === node.id);
    const targetIndex = direction === "up" ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= siblings.length) return;
    const target = siblings[targetIndex];
    const oldOrder = node.sort_order;
    node.sort_order = target.sort_order;
    target.sort_order = oldOrder;
    persistDemo();
    renderTree();
    setStatus("顺序已保存到本机", "local");
    return;
  }
  try {
    setStatus("正在调整顺序", "saving");
    const { error } = await trackedWrite(() => state.client.rpc("reorder_org_node", { p_node_id: node.id, p_direction: direction }));
    if (error) throw error;
    await loadNodes();
    setStatus("顺序已保存", "saved");
  } catch (error) {
    setStatus("调整失败", "error");
    showToast(friendlyError(error));
  }
}

async function showMembers() {
  if (!CLOUD_ENABLED || !state.organization) {
    const content = makeElement("p", "modal-content-copy", "当前是本机草稿模式。配置 Supabase 后，才能邀请成员并进行多电脑实时协作。");
    openModal({ title: "协作成员", eyebrow: "云端未配置", content, actions: [{ label: "知道了", className: "button-secondary" }] });
    return;
  }
  const [{ data: members, error: membersError }, { data: invitations, error: invitationsError }] = await Promise.all([
    state.client.from("org_memberships").select("user_id,member_email,role,created_at").eq("organization_id", state.organization.id).order("created_at"),
    state.client.from("org_invitations").select("id,email,role,created_at").eq("organization_id", state.organization.id).order("created_at"),
  ]);
  if (membersError || invitationsError) {
    showToast(friendlyError(membersError || invitationsError));
    return;
  }
  const content = makeElement("div");
  const list = makeElement("ul", "modal-list");
  for (const member of members ?? []) {
    const item = makeElement("li", "modal-list-item");
    const copy = makeElement("div");
    copy.append(makeElement("strong", "", member.member_email || member.user_id));
    copy.append(makeElement("span", "", `已加入 · ${member.role}`));
    item.append(copy);
    list.append(item);
  }
  for (const invitation of invitations ?? []) {
    const item = makeElement("li", "modal-list-item");
    const copy = makeElement("div");
    copy.append(makeElement("strong", "", invitation.email));
    copy.append(makeElement("span", "", `等待对方登录 · ${invitation.role}`));
    item.append(copy);
    list.append(item);
  }
  content.append(list);

  if (canManageMembers()) {
    const inviteForm = makeElement("form");
    const emailLabel = makeElement("label");
    emailLabel.append(makeElement("span", "", "邀请成员邮箱"));
    const emailInput = makeElement("input");
    emailInput.type = "email";
    emailInput.required = true;
    emailInput.placeholder = "name@company.com";
    emailLabel.append(emailInput);
    const roleLabel = makeElement("label");
    roleLabel.append(makeElement("span", "", "权限"));
    const roleSelect = makeElement("select");
    for (const [value, label] of [["editor", "编辑者（可修改架构）"], ["viewer", "查看者（只读）"]]) {
      const option = makeElement("option", "", label);
      option.value = value;
      roleSelect.append(option);
    }
    roleLabel.append(roleSelect);
    inviteForm.append(emailLabel, roleLabel);
    content.append(inviteForm);
    openModal({
      title: "协作成员",
      eyebrow: "权限管理",
      content,
      wide: true,
      actions: [
        { label: "关闭", className: "button-secondary" },
        {
          label: "添加成员",
          className: "button-primary",
          close: false,
          onClick: async () => {
            if (!emailInput.reportValidity()) return;
            const { error } = await state.client.rpc("invite_org_member", { p_organization_id: state.organization.id, p_email: emailInput.value.trim(), p_role: roleSelect.value });
            if (error) {
              showToast(friendlyError(error));
              return;
            }
            closeModal();
            showToast("成员权限已登记。对方使用该邮箱登录后即可加入。");
          },
        },
      ],
    });
  } else {
    openModal({ title: "协作成员", eyebrow: "成员列表", content, wide: true, actions: [{ label: "关闭", className: "button-secondary" }] });
  }
}

function showAccount() {
  const content = makeElement("div");
  content.append(makeElement("p", "modal-content-copy", CLOUD_ENABLED ? `${state.user?.email ?? "已登录"}\n当前角色：${state.role}` : "当前未连接云端，数据只保存在这台电脑的浏览器中。"));
  if (CLOUD_ENABLED && state.organization) {
    const pending = state.queue.filter((item) => queueEntryMatchesCurrentContext(item)).length;
    const blocked = state.queue.filter((item) => queueEntryMatchesCurrentContext(item, { includeBlocked: true }) && item.blocked).length;
    if (pending || blocked) content.append(makeElement("p", "modal-content-copy", `离线队列：${pending} 项等待同步，${blocked} 项已暂停。重新编辑相应节点会生成新的同步尝试；原始失败记录仍保留在本机。`));
  }
  const actions = [{ label: "关闭", className: "button-secondary" }];
  if (CLOUD_ENABLED && state.memberships.length > 1) {
    const label = makeElement("label");
    label.append(makeElement("span", "", "当前组织"));
    const organizationSelect = makeElement("select");
    for (const membership of state.memberships) {
      const option = makeElement("option", "", `${membership.organizations.name} · ${membership.role}`);
      option.value = membership.organization_id;
      organizationSelect.append(option);
    }
    organizationSelect.value = state.organization.id;
    label.append(organizationSelect);
    content.append(label);
    actions.push({
      label: "切换并重新载入",
      className: "button-primary",
      close: false,
      onClick: () => {
        if (organizationSelect.value === state.organization.id) {
          closeModal();
          return;
        }
        if (state.dirty.size || state.saveTimers.size || state.creating.size || state.flushing || state.inflightWrites) {
          showToast("仍有修改正在保存，请等顶部显示“已保存”后再切换组织");
          return;
        }
        const preferenceKey = selectedOrgStorageKey();
        if (preferenceKey) localStorage.setItem(preferenceKey, organizationSelect.value);
        // A full reload keeps timers, requests and Realtime events from the old
        // organization from ever mutating the newly selected organization.
        window.location.reload();
      },
    });
  }
  if (CLOUD_ENABLED && state.user) {
    actions.push({
      label: "退出登录",
      className: "button-danger",
      onClick: async () => {
        await state.client.auth.signOut();
        window.location.reload();
      },
    });
  }
  openModal({ title: CLOUD_ENABLED ? "账户" : "本机草稿模式", eyebrow: "当前会话", content, actions });
}

async function loadNodes() {
  if (!CLOUD_ENABLED || !state.organization) return;
  const { data, error } = await state.client.from("org_nodes").select("*").eq("organization_id", state.organization.id).order("sort_order");
  if (error) throw error;
  state.nodes = (data ?? []).map(normalizeNode);
  if (state.selectedId && !selectedNode()) state.selectedId = null;
  renderAll({ refreshForm: true });
}

function subscribeRealtime() {
  if (state.channel) state.client.removeChannel(state.channel);
  state.channel = state.client
    .channel(`org-nodes:${state.organization.id}`)
    .on("postgres_changes", { event: "*", schema: "public", table: "org_nodes", filter: `organization_id=eq.${state.organization.id}` }, (payload) => {
      const incoming = payload.new?.id ? normalizeNode(payload.new) : null;
      const removedId = payload.old?.id;
      const incomingWasDirty = Boolean(incoming && state.dirty.has(incoming.id));
      const isOwnChange = Boolean(incoming && incoming.updated_by === state.user?.id);
      if (payload.eventType === "DELETE" && removedId) {
        state.nodes = state.nodes.filter((node) => node.id !== removedId);
      } else if (incoming) {
        if (state.dirty.has(incoming.id)) {
          state.remotePending.set(incoming.id, incoming);
          if (!isOwnChange) setStatus("检测到同时修改", "error");
        } else {
          replaceNode(incoming);
        }
      }
      if (state.selectedId && !selectedNode()) state.selectedId = null;
      renderAll({ refreshForm: !state.dirty.has(state.selectedId) });
      if (!isOwnChange && !incomingWasDirty) setStatus("已同步其他成员修改", "saved");
    })
    .subscribe((status) => {
      if (status === "SUBSCRIBED") {
        const pending = state.queue.filter((item) => queueEntryMatchesCurrentContext(item)).length;
        const blocked = state.queue.filter((item) => queueEntryMatchesCurrentContext(item, { includeBlocked: true }) && item.blocked).length;
        if (state.dirty.size) setStatus("正在保存", "saving");
        else if (blocked) setStatus(`${blocked} 项修改需要处理`, "error");
        else setStatus(pending ? "有待同步修改" : "实时同步已连接", pending ? "saving" : "saved");
      }
      if (["CHANNEL_ERROR", "TIMED_OUT"].includes(status)) setStatus("实时连接中断", "error");
    });
}

async function loadOrganization() {
  await state.client.rpc("accept_my_invitations");
  const { data, error } = await state.client
    .from("org_memberships")
    .select("organization_id,role,organizations(id,name)")
    .order("created_at");
  if (error) throw error;
  state.memberships = data ?? [];
  if (!state.memberships.length) {
    dom.authScreen.classList.remove("hidden");
    dom.authForm.classList.add("hidden");
    dom.createOrgForm.classList.remove("hidden");
    dom.authDescription.textContent = "这个账号还没有加入组织。创建北泽公司，或让现有管理员先邀请你的登录邮箱。";
    dom.createOrgName.value = CONFIG.defaultOrgName;
    return false;
  }
  const preferenceKey = selectedOrgStorageKey();
  const preferredId = preferenceKey ? localStorage.getItem(preferenceKey) : null;
  const membership =
    state.memberships.find((item) => item.organization_id === preferredId) ??
    state.memberships.find((item) => item.organizations.name === CONFIG.defaultOrgName) ??
    state.memberships[0];
  await activateMembership(membership);
  dom.authScreen.classList.add("hidden");
  return true;
}

async function activateMembership(membership) {
  if (state.channel) {
    await state.client.removeChannel(state.channel);
    state.channel = null;
  }
  state.organization = membership.organizations;
  state.role = membership.role;
  state.selectedId = null;
  const preferenceKey = selectedOrgStorageKey();
  if (preferenceKey) localStorage.setItem(preferenceKey, state.organization.id);
  dom.orgTitle.textContent = state.organization.name;
  dom.accountButton.textContent = initials(state.user.email);
  await loadNodes();
  subscribeRealtime();
  await flushQueue();
}

async function bootCloud() {
  state.client = createClient(CONFIG.supabaseUrl, CONFIG.supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    realtime: { params: { eventsPerSecond: 10 } },
  });
  const { data: { session }, error } = await state.client.auth.getSession();
  if (error) throw error;
  if (!session) {
    dom.authScreen.classList.remove("hidden");
    dom.authForm.classList.remove("hidden");
    dom.createOrgForm.classList.add("hidden");
    setStatus("需要登录", "local");
  } else {
    state.user = session.user;
    loadUserQueue();
    await loadOrganization();
  }
  state.client.auth.onAuthStateChange((event, nextSession) => {
    if (event === "SIGNED_IN" && nextSession && nextSession.user.id !== state.user?.id) {
      window.setTimeout(async () => {
        state.user = nextSession.user;
        loadUserQueue();
        await loadOrganization();
      }, 0);
    }
  });
}

function bootDemo() {
  const saved = readJson(DEMO_STORAGE_KEY, null);
  state.nodes = Array.isArray(saved) && saved.length ? saved.map(normalizeNode) : makeDemoNodes();
  state.organization = { id: "demo-org", name: CONFIG.defaultOrgName };
  state.role = "owner";
  dom.orgTitle.textContent = CONFIG.defaultOrgName;
  dom.accountButton.textContent = "本机";
  dom.authScreen.classList.add("hidden");
  renderAll({ refreshForm: true });
  setStatus("本机草稿", "local");
  showToast("当前未配置云端。你可以试用编辑功能，但换电脑后看不到这些草稿。");
}

async function initialize() {
  bindEvents();
  try {
    if (CLOUD_ENABLED) await bootCloud();
    else bootDemo();
    state.booted = true;
  } catch (error) {
    setStatus("初始化失败", "error");
    showToast(friendlyError(error));
    dom.authScreen.classList.remove("hidden");
    dom.authDescription.textContent = "云端连接失败。请检查 config.js 和 Supabase 数据库初始化。";
  }
}

function bindEvents() {
  dom.searchInput.addEventListener("input", () => {
    state.query = dom.searchInput.value;
    renderTree();
  });
  dom.nodeForm.addEventListener("input", handleFormEdit);
  dom.nodeForm.addEventListener("change", handleFormEdit);
  dom.nodeForm.addEventListener("submit", (event) => event.preventDefault());
  dom.nodeForm.addEventListener("focusout", () => {
    const node = selectedNode();
    if (node && state.dirty.has(node.id)) scheduleSave(node.id, 80);
  });
  dom.addRootButton.addEventListener("click", () => {
    const company = activeNodes().find((node) => node.type === "company");
    showCreateNodeModal(company?.id ?? null);
  });
  dom.addChildButton.addEventListener("click", () => showCreateNodeModal(state.selectedId));
  dom.deleteNodeButton.addEventListener("click", confirmDeleteSelected);
  dom.trashButton.addEventListener("click", showTrash);
  dom.moveUpButton.addEventListener("click", () => reorderSelected("up"));
  dom.moveDownButton.addEventListener("click", () => reorderSelected("down"));
  dom.closeInspector.addEventListener("click", clearSelection);
  dom.membersButton.addEventListener("click", showMembers);
  dom.accountButton.addEventListener("click", showAccount);
  dom.zoomOut.addEventListener("click", () => setZoom(state.zoom - 0.1));
  dom.zoomIn.addEventListener("click", () => setZoom(state.zoom + 0.1));
  dom.zoomReset.addEventListener("click", () => setZoom(1));
  dom.modalClose.addEventListener("click", closeModal);
  dom.modalBackdrop.addEventListener("click", (event) => {
    if (event.target === dom.modalBackdrop) closeModal();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeModal();
  });
  window.addEventListener("offline", () => {
    dom.offlineBanner.classList.remove("hidden");
    setStatus("网络已断开", "offline");
  });
  window.addEventListener("online", () => {
    dom.offlineBanner.classList.add("hidden");
    flushQueue();
  });
  dom.authForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const email = dom.authEmail.value.trim();
    dom.authFeedback.textContent = "正在发送登录链接…";
    const redirectTo = `${window.location.origin}${window.location.pathname}`;
    const { error } = await state.client.auth.signInWithOtp({ email, options: { emailRedirectTo: redirectTo, shouldCreateUser: true } });
    dom.authFeedback.textContent = error ? friendlyError(error) : "登录链接已发送，请在同一台设备打开邮件完成登录。";
  });
  dom.createOrgForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    dom.authFeedback.textContent = "正在创建组织…";
    const { data: organizationId, error } = await state.client.rpc("create_organization", { p_name: dom.createOrgName.value.trim() });
    if (error) {
      dom.authFeedback.textContent = friendlyError(error);
      return;
    }
    const preferenceKey = selectedOrgStorageKey();
    if (preferenceKey && organizationId) localStorage.setItem(preferenceKey, organizationId);
    dom.authFeedback.textContent = "创建完成，正在加载…";
    await loadOrganization();
  });
}

function setZoom(value) {
  state.zoom = Math.max(0.5, Math.min(1.5, Math.round(value * 10) / 10));
  renderTree();
}

initialize();

