import { createClient } from "@supabase/supabase-js";
import "./styles.css";
import "./v1.css";
import {
  NODE_TYPES,
  buildForest,
  countByType,
  getDescendantIds,
  getSearchState,
  normalizeNode,
  sortNodes,
  structureFingerprint,
  validateNodeDraft,
} from "./core.js";

const CONFIG = Object.freeze({
  supabaseUrl: String(window.__BEIZE_CONFIG__?.SUPABASE_URL ?? "").trim(),
  supabaseAnonKey: String(window.__BEIZE_CONFIG__?.SUPABASE_ANON_KEY ?? "").trim(),
});
const CLOUD_ENABLED = /^https:\/\/.+\.supabase\.co$/i.test(CONFIG.supabaseUrl) && CONFIG.supabaseAnonKey.length > 40;
const SESSION_KEY = "beize-org-chart:editor-session:v1";
const CLIENT_ID_KEY = "beize-org-chart:client-id:v1";
const MIGRATION_DONE_KEY = "beize-org-chart:local-import-completed:v2";
const KNOWN_LOCAL_KEYS = [
  "beize-org-chart-draft-v1",
  "org-chart-draft-v1",
  "beize-org-chart:demo:v1",
  "beize-org-chart:draft:v1",
];
const SYSTEM_SAMPLE_NAMES = new Set([
  "北泽五金", "东莞市北泽五金制品有限公司", "总经办", "洪礼群", "洪晓辉", "销售部", "技术部", "生产部", "仓储部",
  "采购部", "财务部", "品质部", "程兴宇", "蔡晓霞", "吴宝玉", "王珍", "何陈妹", "杨巧", "贺家佳", "待招聘",
]);

const $ = (selector) => document.querySelector(selector);
const dom = {
  orgTitle: $("#org-title"),
  searchInput: $("#search-input"),
  syncStatus: $("#sync-status"),
  accountButton: $("#account-button"),
  offlineBanner: $("#offline-banner"),
  statDepartments: $("#stat-departments"),
  statPeople: $("#stat-people"),
  addRootButton: $("#add-root-button"),
  trashButton: $("#trash-button"),
  historyButton: $("#history-button"),
  compactAddRootButton: $("#compact-add-root-button"),
  compactTrashButton: $("#compact-trash-button"),
  rootButton: $("#root-button"),
  fitButton: $("#fit-button"),
  expandAllButton: $("#expand-all-button"),
  collapseAllButton: $("#collapse-all-button"),
  visibleCount: $("#visible-count"),
  filterLabel: $("#filter-label"),
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
  noteWarning: $("#note-warning"),
  updatedMeta: $("#updated-meta"),
  roleMeta: $("#role-meta"),
  saveNodeButton: $("#save-node-button"),
  addChildButton: $("#add-child-button"),
  moveUpButton: $("#move-up-button"),
  moveDownButton: $("#move-down-button"),
  deleteNodeButton: $("#delete-node-button"),
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
  publicClient: null,
  client: null,
  organization: null,
  nodes: [],
  selectedId: null,
  query: "",
  collapsed: new Set(),
  editing: false,
  editorName: "",
  editorToken: "",
  editorExpiresAt: null,
  channel: null,
  migrationCandidates: [],
  migrationButton: null,
  reloadTimer: null,
};

function getClientId() {
  let id = localStorage.getItem(CLIENT_ID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(CLIENT_ID_KEY, id);
  }
  return id;
}

function makeClient(token = "") {
  const options = {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    realtime: { params: { eventsPerSecond: 10 } },
    global: { headers: { "x-beize-client-id": getClientId() } },
  };
  if (token) options.global.headers["x-beize-edit-token"] = token;
  return createClient(CONFIG.supabaseUrl, CONFIG.supabaseAnonKey, options);
}

function makeElement(tag, className = "", text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function makeButton(label, className = "button-secondary", onClick) {
  const button = makeElement("button", `button ${className}`, label);
  button.type = "button";
  if (onClick) button.addEventListener("click", onClick);
  return button;
}

function showToast(message, actionLabel, action) {
  const toast = makeElement("div", "toast");
  toast.append(makeElement("span", "", message));
  if (actionLabel && action) {
    const button = makeElement("button", "", actionLabel);
    button.type = "button";
    button.addEventListener("click", async () => {
      button.disabled = true;
      try { await action(); } finally { toast.remove(); }
    });
    toast.append(button);
  }
  dom.toastRegion.append(toast);
  setTimeout(() => toast.remove(), actionLabel ? 12000 : 4500);
}

function setStatus(text, kind = "saved") {
  if (!dom.syncStatus) return;
  dom.syncStatus.className = `status-pill status-${kind}`;
  const textNode = dom.syncStatus.querySelector("span:last-child");
  if (textNode) textNode.textContent = text;
}

function friendlyError(error) {
  const message = String(error?.message ?? error ?? "操作失败");
  if (/version changed/i.test(message)) return "该节点刚被其他人修改，请刷新后再试";
  if (/permission|forbidden|editor/i.test(message)) return "编辑权限已失效，请重新输入密码";
  if (/network|fetch|failed to fetch/i.test(message)) return "网络不可用，请恢复网络后重试";
  if (/sensitive/i.test(message)) return "公开备注疑似包含敏感信息，请删除后再保存";
  return message.length > 180 ? "操作失败，请稍后重试" : message;
}

function openModal({ title, eyebrow = "操作", content, actions = [], wide = false }) {
  dom.modalTitle.textContent = title;
  dom.modalEyebrow.textContent = eyebrow;
  dom.modal.classList.toggle("wide", wide);
  dom.modalContent.replaceChildren(content);
  dom.modalActions.replaceChildren();
  for (const action of actions) {
    const button = makeButton(action.label, action.className ?? "button-secondary", async () => {
      if (action.close !== false) closeModal();
      await action.onClick?.(button);
    });
    dom.modalActions.append(button);
  }
  dom.modalBackdrop.classList.remove("hidden");
}

function closeModal() {
  dom.modalBackdrop.classList.add("hidden");
  dom.modal.classList.remove("wide");
  dom.modalContent.replaceChildren();
  dom.modalActions.replaceChildren();
}

function formatTime(value) {
  if (!value) return "尚未保存";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "尚未保存";
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date);
}

function activeNodes() {
  return state.nodes.filter((node) => !node.deleted_at);
}

function selectedNode() {
  return state.nodes.find((node) => node.id === state.selectedId && !node.deleted_at) ?? null;
}

function companyRoot() {
  return activeNodes().find((node) => node.type === "company") ?? activeNodes().find((node) => !node.parent_id) ?? null;
}

function sensitiveNoteReason(value) {
  const text = String(value ?? "");
  if (/1[3-9]\d{9}/.test(text)) return "手机号";
  if (/[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[0-9Xx]/.test(text)) return "身份证号";
  if (/(身份证|银行卡|工资|薪资|密码|口令)/.test(text)) return "敏感关键词";
  return "";
}

async function fetchOrganization() {
  const { data, error } = await state.publicClient
    .from("organizations")
    .select("id,name,is_public")
    .eq("is_public", true)
    .order("created_at")
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("未找到公开组织");
  state.organization = data;
  dom.orgTitle.textContent = data.name;
}

function readStoredEditorSession() {
  try {
    const session = JSON.parse(sessionStorage.getItem(SESSION_KEY));
    if (!session?.token || !session?.organizationId || session.organizationId !== state.organization?.id) return null;
    return session;
  } catch {
    return null;
  }
}

function storeEditorSession() {
  sessionStorage.setItem(SESSION_KEY, JSON.stringify({
    organizationId: state.organization.id,
    token: state.editorToken,
    editorName: state.editorName,
    expiresAt: state.editorExpiresAt,
  }));
}

function clearEditorSession() {
  sessionStorage.removeItem(SESSION_KEY);
  state.editing = false;
  state.editorName = "";
  state.editorToken = "";
  state.editorExpiresAt = null;
  state.client = state.publicClient;
}

async function restoreEditorSession() {
  const stored = readStoredEditorSession();
  if (!stored) return;
  const candidate = makeClient(stored.token);
  const { data, error } = await candidate.rpc("verify_public_edit_session", { p_organization_id: state.organization.id });
  if (error || !data?.ok) {
    clearEditorSession();
    return;
  }
  state.editing = true;
  state.editorToken = stored.token;
  state.editorName = data.editor_name || stored.editorName || "编辑者";
  state.editorExpiresAt = data.expires_at || stored.expiresAt || null;
  state.client = candidate;
  storeEditorSession();
}

async function loadNodes() {
  const columns = state.editing
    ? "id,organization_id,parent_id,type,name,title,notes,sort_order,version,updated_at,updated_by_label,deleted_at,deleted_batch_id,deleted_by_label"
    : "id,organization_id,parent_id,type,name,title,sort_order,version,updated_at,updated_by_label,deleted_at,deleted_batch_id,deleted_by_label";
  let query = state.client.from("org_nodes").select(columns).eq("organization_id", state.organization.id).order("sort_order");
  if (!state.editing) query = query.is("deleted_at", null);
  const { data, error } = await query;
  if (error) throw error;
  state.nodes = (data ?? []).map(normalizeNode);
  if (state.selectedId && !selectedNode()) state.selectedId = null;
}

function scheduleReload() {
  clearTimeout(state.reloadTimer);
  state.reloadTimer = setTimeout(async () => {
    try {
      await loadNodes();
      renderAll();
      setStatus(state.editing ? `编辑中 · ${state.editorName}` : "云端只读 · 实时同步", "saved");
    } catch (error) {
      setStatus("同步失败", "error");
      showToast(friendlyError(error));
    }
  }, 180);
}

async function subscribeRealtime() {
  if (state.channel) await state.publicClient.removeChannel(state.channel);
  state.channel = state.publicClient
    .channel(`org-${state.organization.id}`)
    .on("postgres_changes", { event: "*", schema: "public", table: "org_nodes", filter: `organization_id=eq.${state.organization.id}` }, scheduleReload)
    .subscribe();
}

function renderStats() {
  const counts = countByType(state.nodes);
  dom.statDepartments.textContent = String(counts.department);
  dom.statPeople.textContent = String(counts.person);
}

function renderToolbarState() {
  dom.accountButton.textContent = state.editing ? "编辑中" : "编辑";
  dom.accountButton.classList.toggle("editing", state.editing);
  for (const button of [dom.addRootButton, dom.trashButton, dom.historyButton, dom.compactAddRootButton, dom.compactTrashButton]) {
    if (button) button.disabled = !state.editing;
  }
  setStatus(state.editing ? `编辑中 · ${state.editorName}` : "云端只读 · 实时同步", "saved");
}

function makeNodeCard(node, hasChildren, isCollapsed, isMatch) {
  const card = makeElement("article", `node-card type-${node.type}`);
  card.dataset.nodeId = node.id;
  card.tabIndex = 0;
  card.setAttribute("role", "button");
  card.setAttribute("aria-label", `${NODE_TYPES[node.type]} ${node.name}`);
  if (node.id === state.selectedId) card.classList.add("selected");
  if (isMatch) card.classList.add("search-match");
  card.append(makeElement("div", "node-strip"));
  const body = makeElement("div", "node-body");
  body.append(makeElement("span", "node-type", NODE_TYPES[node.type]));
  body.append(makeElement("strong", "node-name", node.name));
  if (node.type === "person" && node.title) body.append(makeElement("span", "node-title", node.title));
  card.append(body);

  if (hasChildren) {
    const toggle = makeElement("button", "node-collapse-action", isCollapsed ? `展开` : `收起`);
    toggle.type = "button";
    toggle.setAttribute("aria-label", isCollapsed ? `展开 ${node.name} 的下级` : `收起 ${node.name} 的下级`);
    toggle.addEventListener("click", (event) => {
      event.stopPropagation();
      if (state.collapsed.has(node.id)) state.collapsed.delete(node.id); else state.collapsed.add(node.id);
      renderTree();
    });
    card.append(toggle);
  }

  const select = () => {
    state.selectedId = node.id;
    renderTree();
    renderInspector();
  };
  card.addEventListener("click", select);
  card.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      select();
    }
  });
  return card;
}

function renderTree() {
  const active = activeNodes();
  const forest = buildForest(active);
  const search = getSearchState(active, state.query);
  const matchSet = new Set(search.matches);
  const querying = Boolean(state.query.trim());
  const renderBranch = (node) => {
    if (!search.visible.has(node.id)) return null;
    const li = document.createElement("li");
    const visibleChildren = node.children.filter((child) => search.visible.has(child.id));
    const isCollapsed = !querying && state.collapsed.has(node.id);
    li.append(makeNodeCard(node, visibleChildren.length > 0, isCollapsed, matchSet.has(node.id)));
    if (visibleChildren.length && !isCollapsed) {
      const ul = document.createElement("ul");
      for (const child of visibleChildren) {
        const branch = renderBranch(child);
        if (branch) ul.append(branch);
      }
      if (ul.childElementCount) li.append(ul);
    }
    return li;
  };

  dom.treeStage.replaceChildren();
  const rootList = document.createElement("ul");
  rootList.className = "org-tree";
  for (const root of forest) {
    const branch = renderBranch(root);
    if (branch) rootList.append(branch);
  }
  if (!rootList.childElementCount) {
    const empty = makeElement("div", "tree-empty");
    empty.append(makeElement("strong", "", state.query ? "没有找到匹配节点" : "暂无组织架构"));
    empty.append(makeElement("span", "", state.query ? "换一个关键词试试。" : "进入编辑模式后添加部门或人员。"));
    dom.treeStage.append(empty);
  } else dom.treeStage.append(rootList);

  dom.visibleCount.textContent = `${search.visible.size} 个节点`;
  dom.filterLabel.textContent = state.query ? ` · 搜索“${state.query}”` : "";
}

function renderParentOptions(node) {
  dom.fieldParent.replaceChildren();
  if (node.type === "company") return;
  const descendants = getDescendantIds(activeNodes(), node.id);
  for (const candidate of sortNodes(activeNodes())) {
    if (candidate.id === node.id || descendants.has(candidate.id)) continue;
    const option = document.createElement("option");
    option.value = candidate.id;
    option.textContent = `${NODE_TYPES[candidate.type]} · ${candidate.name}${candidate.type === "person" && candidate.title ? `（${candidate.title}）` : ""}`;
    if (candidate.id === node.parent_id) option.selected = true;
    dom.fieldParent.append(option);
  }
}

function renderInspector() {
  const node = selectedNode();
  if (!node) {
    dom.inspector.classList.remove("open");
    dom.inspectorEmpty.classList.remove("hidden");
    dom.nodeForm.classList.add("hidden");
    return;
  }
  dom.inspector.classList.add("open");
  dom.inspectorEmpty.classList.add("hidden");
  dom.nodeForm.classList.remove("hidden");
  dom.inspectorTitle.textContent = node.type === "company" ? "公司" : `编辑${NODE_TYPES[node.type]}`;
  dom.fieldType.value = node.type;
  dom.fieldName.value = node.name;
  dom.fieldTitle.value = node.title;
  dom.fieldNotes.value = node.notes || "";
  renderParentOptions(node);

  const company = node.type === "company";
  dom.fieldType.disabled = !state.editing || company;
  dom.fieldName.disabled = !state.editing;
  dom.fieldTitle.disabled = !state.editing || company || node.type === "department";
  dom.fieldParent.disabled = !state.editing || company;
  dom.fieldNotes.disabled = !state.editing || company || node.type === "department";
  dom.fieldTitle.closest("label").classList.toggle("field-hidden", company || node.type === "department");
  dom.fieldParent.closest("label").classList.toggle("field-hidden", company);
  dom.fieldNotes.closest("label").classList.toggle("field-hidden", company || node.type === "department" || !state.editing);
  dom.noteWarning.classList.toggle("hidden", company || node.type === "department" || !state.editing);

  dom.updatedMeta.textContent = `${formatTime(node.updated_at)}${node.updated_by_label ? ` · ${node.updated_by_label}` : ""}`;
  dom.roleMeta.textContent = state.editing ? `编辑者：${state.editorName}` : "公开只读";
  for (const button of [dom.saveNodeButton, dom.addChildButton, dom.moveUpButton, dom.moveDownButton, dom.deleteNodeButton]) button.hidden = !state.editing;
  dom.deleteNodeButton.hidden = !state.editing || company;
}

function renderAll() {
  renderStats();
  renderToolbarState();
  renderTree();
  renderInspector();
}

async function withWriteStatus(task) {
  if (!state.editing) {
    await showEditDialog();
    return null;
  }
  if (!navigator.onLine) {
    showToast("当前网络不可用，云端编辑已暂停");
    return null;
  }
  setStatus("正在保存…", "saving");
  try {
    const result = await task();
    setStatus(`已保存 · ${state.editorName}`, "saved");
    return result;
  } catch (error) {
    setStatus("保存失败", "error");
    if (/permission|editor/i.test(String(error?.message ?? ""))) clearEditorSession();
    showToast(friendlyError(error));
    return null;
  }
}

async function saveSelectedNode() {
  const node = selectedNode();
  if (!node) return;
  const type = node.type === "company" ? "company" : dom.fieldType.value;
  const draft = {
    type,
    name: dom.fieldName.value.trim(),
    title: type === "person" ? dom.fieldTitle.value.trim() : "",
    notes: type === "person" ? dom.fieldNotes.value.trim() : "",
    parent_id: type === "company" ? null : (dom.fieldParent.value || null),
  };
  const errors = validateNodeDraft(draft, activeNodes(), node.id);
  if (errors.length) return showToast(errors[0]);
  const sensitive = sensitiveNoteReason(draft.notes);
  if (sensitive) return showToast(`公开备注疑似包含${sensitive}，请删除后再保存`);

  const updated = await withWriteStatus(async () => {
    const { data, error } = await state.client.rpc("update_org_node", {
      p_node_id: node.id,
      p_expected_version: node.version,
      p_patch: draft,
    });
    if (error) throw error;
    return data;
  });
  if (!updated) return;
  await loadNodes();
  renderAll();
  showToast("修改已保存");
}

function typeField(select) {
  const label = makeElement("label");
  label.append(makeElement("span", "", "类型"), select);
  return label;
}

function textField(labelText, input) {
  const label = makeElement("label");
  label.append(makeElement("span", "", labelText), input);
  return label;
}

async function showCreateNode(parentId = null) {
  if (!state.editing) return showEditDialog(() => showCreateNode(parentId));
  const parent = parentId ? activeNodes().find((node) => node.id === parentId) : companyRoot();
  if (!parent) return showToast("没有可用的上级节点");

  const form = makeElement("div", "create-node-form");
  const type = document.createElement("select");
  type.innerHTML = '<option value="department">部门</option><option value="person">人员</option>';
  const name = document.createElement("input");
  name.maxLength = 80;
  name.placeholder = "请输入部门名称";
  const title = document.createElement("input");
  title.maxLength = 120;
  title.placeholder = "请输入岗位";
  const notes = document.createElement("textarea");
  notes.rows = 4;
  notes.maxLength = 1000;
  notes.placeholder = "仅填写可公开的信息，不要填写手机号、薪资、身份证等";
  const titleLabel = textField("岗位", title);
  const notesLabel = textField("公开备注（可选）", notes);
  const parentInfo = makeElement("div", "create-parent-info", `上级：${NODE_TYPES[parent.type]} · ${parent.name}`);
  form.append(typeField(type), textField("部门名称", name), titleLabel, notesLabel, parentInfo);
  const nameLabel = name.closest("label");
  const applyType = () => {
    const person = type.value === "person";
    nameLabel.querySelector("span").textContent = person ? "人员姓名" : "部门名称";
    name.placeholder = person ? "请输入人员姓名" : "请输入部门名称";
    titleLabel.classList.toggle("field-hidden", !person);
    notesLabel.classList.toggle("field-hidden", !person);
  };
  type.addEventListener("change", applyType);
  applyType();

  openModal({
    title: "新增下级",
    eyebrow: "组织节点",
    content: form,
    actions: [
      { label: "取消", className: "button-secondary" },
      {
        label: "创建",
        className: "button-primary",
        close: false,
        onClick: async (button) => {
          const nodeType = type.value;
          const nodeName = name.value.trim();
          const nodeTitle = nodeType === "person" ? title.value.trim() : "";
          const nodeNotes = nodeType === "person" ? notes.value.trim() : "";
          if (!nodeName) return showToast(nodeType === "person" ? "请输入人员姓名" : "请输入部门名称");
          const sensitive = sensitiveNoteReason(nodeNotes);
          if (sensitive) return showToast(`公开备注疑似包含${sensitive}，请删除后再创建`);
          button.disabled = true;
          const created = await withWriteStatus(async () => {
            const { data, error } = await state.client.rpc("create_org_node", {
              p_organization_id: state.organization.id,
              p_parent_id: parent.id,
              p_type: nodeType,
              p_name: nodeName,
              p_title: nodeTitle,
              p_notes: nodeNotes,
            });
            if (error) throw error;
            return data;
          });
          button.disabled = false;
          if (!created) return;
          closeModal();
          await loadNodes();
          state.selectedId = created.id;
          renderAll();
          requestAnimationFrame(() => window.BeizeCanvas?.focusNode(created.id));
          showToast("节点已创建");
        },
      },
    ],
  });
  setTimeout(() => name.focus(), 0);
}

async function moveSelected(direction) {
  const node = selectedNode();
  if (!node || node.type === "company") return;
  const ok = await withWriteStatus(async () => {
    const { error } = await state.client.rpc("reorder_org_node", { p_node_id: node.id, p_direction: direction });
    if (error) throw error;
    return true;
  });
  if (!ok) return;
  await loadNodes();
  renderAll();
}

async function deleteSelected() {
  const node = selectedNode();
  if (!node || node.type === "company") return;
  const descendants = getDescendantIds(activeNodes(), node.id).size;
  const content = makeElement("div");
  content.append(makeElement("p", "modal-content-copy", descendants ? `将“${node.name}”及其 ${descendants} 个下级一起移入回收站。可在回收站恢复。` : `将“${node.name}”移入回收站。可恢复。`));
  openModal({
    title: "确认移入回收站",
    eyebrow: "可恢复删除",
    content,
    actions: [
      { label: "取消", className: "button-secondary" },
      {
        label: "移入回收站",
        className: "button-danger",
        onClick: async () => {
          const ok = await withWriteStatus(async () => {
            const { error } = await state.client.rpc("soft_delete_org_subtree", {
              p_root_node_id: node.id,
              p_mutation_id: crypto.randomUUID(),
            });
            if (error) throw error;
            return true;
          });
          if (!ok) return;
          state.selectedId = null;
          await loadNodes();
          renderAll();
          showToast("已移入回收站");
        },
      },
    ],
  });
}

function deletedRoots() {
  const deleted = state.nodes.filter((node) => node.deleted_at);
  const byId = new Map(deleted.map((node) => [node.id, node]));
  return sortNodes(deleted.filter((node) => {
    const parent = node.parent_id ? byId.get(node.parent_id) : null;
    return !parent || parent.deleted_batch_id !== node.deleted_batch_id;
  }));
}

async function showTrash() {
  if (!state.editing) return showEditDialog(showTrash);
  await loadNodes();
  const roots = deletedRoots();
  const content = makeElement("div");
  if (!roots.length) content.append(makeElement("p", "modal-content-copy", "回收站为空。"));
  else {
    const list = makeElement("ul", "modal-list");
    for (const node of roots) {
      const li = makeElement("li", "modal-list-item");
      const info = makeElement("div");
      info.append(makeElement("strong", "", node.name));
      info.append(makeElement("span", "", `${NODE_TYPES[node.type]} · ${formatTime(node.deleted_at)}${node.deleted_by_label ? ` · ${node.deleted_by_label}` : ""}`));
      const restore = makeButton("恢复", "button-secondary", async () => {
        restore.disabled = true;
        const ok = await withWriteStatus(async () => {
          const { error } = await state.client.rpc("restore_org_subtree", {
            p_root_node_id: node.id,
            p_expected_batch_id: node.deleted_batch_id,
            p_mutation_id: crypto.randomUUID(),
          });
          if (error) throw error;
          return true;
        });
        if (!ok) { restore.disabled = false; return; }
        await loadNodes();
        closeModal();
        renderAll();
        showToast("已恢复");
      });
      li.append(info, restore);
      list.append(li);
    }
    content.append(list);
  }
  openModal({ title: "回收站", eyebrow: "误删恢复", content, actions: [{ label: "关闭", className: "button-secondary" }], wide: true });
}

async function showHistory() {
  if (!state.editing) return showEditDialog(showHistory);
  const { data, error } = await state.client.rpc("list_org_snapshots", { p_organization_id: state.organization.id, p_limit: 60 });
  if (error) return showToast(friendlyError(error));
  const content = makeElement("div");
  const intro = makeElement("p", "modal-content-copy", "每次新增、修改、移动、删除、恢复和迁移都会自动生成版本。恢复历史前系统还会再自动备份当前版本。");
  content.append(intro);
  const list = makeElement("ul", "modal-list history-list");
  for (const snapshot of data ?? []) {
    const li = makeElement("li", "modal-list-item");
    const info = makeElement("div");
    info.append(makeElement("strong", "", snapshot.action_label));
    info.append(makeElement("span", "", `${formatTime(snapshot.created_at)} · ${snapshot.actor_label} · ${snapshot.node_count} 个节点`));
    const restore = makeButton("恢复此版本", "button-secondary", async () => {
      const confirm = makeElement("div");
      confirm.append(makeElement("p", "modal-content-copy", `确定恢复到 ${formatTime(snapshot.created_at)} 的版本吗？当前版本会先自动备份。`));
      openModal({
        title: "恢复历史版本",
        eyebrow: "版本恢复",
        content: confirm,
        actions: [
          { label: "取消", className: "button-secondary", onClick: showHistory },
          {
            label: "确认恢复",
            className: "button-danger",
            onClick: async () => {
              const result = await withWriteStatus(async () => {
                const { data: restored, error: restoreError } = await state.client.rpc("restore_org_snapshot", {
                  p_organization_id: state.organization.id,
                  p_snapshot_id: snapshot.id,
                });
                if (restoreError) throw restoreError;
                return restored;
              });
              if (!result) return;
              await loadNodes();
              state.selectedId = null;
              renderAll();
              window.BeizeCanvas?.fitToContent();
              showToast(`已恢复 ${result.restored_count ?? ""} 个节点`);
            },
          },
        ],
      });
    });
    li.append(info, restore);
    list.append(li);
  }
  content.append(list);
  openModal({ title: "历史版本", eyebrow: "自动快照", content, actions: [{ label: "关闭", className: "button-secondary" }], wide: true });
}

async function showEditDialog(afterUnlock) {
  if (state.editing) {
    const content = makeElement("div");
    content.append(makeElement("p", "modal-content-copy", `当前编辑者：${state.editorName}`));
    if (state.editorExpiresAt) content.append(makeElement("p", "modal-content-copy", `本次编辑权限有效至 ${formatTime(state.editorExpiresAt)}。关闭编辑后页面恢复为公开只读。`));
    openModal({
      title: "编辑模式",
      eyebrow: "当前会话",
      content,
      actions: [
        { label: "关闭", className: "button-secondary" },
        {
          label: "退出编辑",
          className: "button-danger",
          onClick: async () => {
            try { await state.client.rpc("end_public_edit_session", { p_organization_id: state.organization.id }); } catch {}
            clearEditorSession();
            await loadNodes();
            renderAll();
          },
        },
      ],
    });
    return;
  }

  const content = makeElement("div");
  content.append(makeElement("p", "modal-content-copy", "任何人都可以直接查看。需要修改时输入姓名/代号和编辑密码；密码只用于换取短期编辑令牌，不会保存在浏览器里。"));
  const name = document.createElement("input");
  name.maxLength = 30;
  name.autocomplete = "name";
  name.placeholder = "例如：程兴宇 / 品质部";
  const password = document.createElement("input");
  password.type = "password";
  password.autocomplete = "current-password";
  password.placeholder = "请输入编辑密码";
  content.append(textField("姓名 / 代号", name), textField("编辑密码", password));

  openModal({
    title: "进入编辑模式",
    eyebrow: "权限验证",
    content,
    actions: [
      { label: "取消", className: "button-secondary" },
      {
        label: "解锁编辑",
        className: "button-primary",
        close: false,
        onClick: async (button) => {
          const editorName = name.value.trim();
          const pwd = password.value;
          if (!editorName) return showToast("请输入姓名或代号");
          if (!pwd) return showToast("请输入编辑密码");
          button.disabled = true;
          const { data, error } = await state.publicClient.rpc("begin_public_edit_session", {
            p_organization_id: state.organization.id,
            p_password: pwd,
            p_editor_name: editorName,
            p_client_id: getClientId(),
          });
          password.value = "";
          button.disabled = false;
          if (error) return showToast(friendlyError(error));
          if (!data?.ok) {
            const suffix = data?.remaining_attempts !== undefined ? `（剩余 ${data.remaining_attempts} 次）` : "";
            return showToast(`${data?.error ?? "编辑密码错误"}${suffix}`);
          }
          state.editing = true;
          state.editorName = data.editor_name;
          state.editorToken = data.token;
          state.editorExpiresAt = data.expires_at;
          state.client = makeClient(data.token);
          storeEditorSession();
          closeModal();
          await loadNodes();
          renderAll();
          showToast(`已进入编辑模式 · ${state.editorName}`);
          await afterUnlock?.();
        },
      },
    ],
  });
  setTimeout(() => name.focus(), 0);
}

function mapLegacyType(value) {
  const text = String(value ?? "").trim();
  if (text === "公司") return "company";
  if (text === "部门") return "department";
  if (text === "人员") return "person";
  if (text === "position" || text === "岗位") return "person";
  return NODE_TYPES[text] ? text : null;
}

function extractLocalNodes(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object" && Array.isArray(value.nodes)) return value.nodes;
  return null;
}

function normalizeLocalCandidate(rawNodes) {
  if (!Array.isArray(rawNodes) || !rawNodes.length) return null;
  const nodes = rawNodes.filter((raw) => !raw?.deleted_at && !raw?.deletedAt).map((raw, index) => ({
    id: String(raw?.id ?? `legacy-${index}`).trim(),
    parent_id: raw?.parent_id ?? raw?.parentId ?? null,
    type: mapLegacyType(raw?.type),
    name: String(raw?.name ?? "").trim(),
    title: String(raw?.title ?? raw?.position ?? "").trim(),
    notes: String(raw?.notes ?? raw?.note ?? "").trim(),
    sort_order: Number.isFinite(Number(raw?.sort_order ?? raw?.sortOrder)) ? Number(raw?.sort_order ?? raw?.sortOrder) : (index + 1) * 10,
    updated_at: raw?.updated_at ?? raw?.updatedAt ?? null,
  })).map((node) => ({ ...node, parent_id: node.parent_id == null || node.parent_id === "" ? null : String(node.parent_id) }));
  if (nodes.some((node) => !node.id || !node.type || !node.name)) return null;
  if (new Set(nodes.map((node) => node.id)).size !== nodes.length) return null;
  const ids = new Set(nodes.map((node) => node.id));
  if (nodes.some((node) => node.parent_id && !ids.has(node.parent_id))) return null;
  const companies = nodes.filter((node) => node.type === "company");
  if (companies.length !== 1 || companies[0].parent_id) return null;
  const children = new Map();
  for (const node of nodes) {
    if (!node.parent_id) continue;
    if (!children.has(node.parent_id)) children.set(node.parent_id, []);
    children.get(node.parent_id).push(node.id);
  }
  const visited = new Set();
  const stack = [companies[0].id];
  while (stack.length) {
    const id = stack.pop();
    if (visited.has(id)) continue;
    visited.add(id);
    stack.push(...(children.get(id) ?? []));
  }
  if (visited.size !== nodes.length) return null;
  return nodes;
}

function candidateLooksSystemGenerated(nodes) {
  const matched = nodes.filter((node) => SYSTEM_SAMPLE_NAMES.has(node.name)).length;
  return nodes.length >= 15 && matched >= Math.min(14, nodes.length - 1);
}

function migrationFingerprint(nodes) {
  return structureFingerprint(nodes.map((node) => ({ ...node, notes: "" })));
}

function findLocalCandidates() {
  const keys = new Set(KNOWN_LOCAL_KEYS);
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (key && /(org[-:]?chart|beize)/i.test(key)) keys.add(key);
  }
  const excluded = /(seed-version|client-id|editor-session|import-completed|selected-org|pending)/i;
  const candidates = [];
  for (const key of keys) {
    if (!key || excluded.test(key)) continue;
    let parsed;
    try { parsed = JSON.parse(localStorage.getItem(key)); } catch { continue; }
    const nodes = normalizeLocalCandidate(extractLocalNodes(parsed));
    if (!nodes) continue;
    let latest = 0;
    for (const node of nodes) {
      const time = node.updated_at ? Date.parse(node.updated_at) : NaN;
      if (Number.isFinite(time)) latest = Math.max(latest, time);
    }
    candidates.push({
      key,
      nodes,
      latest,
      systemSample: candidateLooksSystemGenerated(nodes),
      fingerprint: migrationFingerprint(nodes),
      departments: nodes.filter((node) => node.type === "department").length,
      people: nodes.filter((node) => node.type === "person").length,
    });
  }
  const unique = [];
  const seen = new Set();
  for (const candidate of candidates.sort((a, b) => Number(a.systemSample) - Number(b.systemSample) || b.latest - a.latest || b.nodes.length - a.nodes.length)) {
    if (seen.has(candidate.fingerprint)) continue;
    seen.add(candidate.fingerprint);
    unique.push(candidate);
  }
  return unique;
}

function removeMigrationButton() {
  state.migrationButton?.remove();
  state.migrationButton = null;
}

function prepareMigrationPrompt() {
  removeMigrationButton();
  const completed = localStorage.getItem(MIGRATION_DONE_KEY);
  if (completed) return;
  const cloudFingerprint = migrationFingerprint(activeNodes());
  state.migrationCandidates = findLocalCandidates().filter((candidate) => candidate.fingerprint !== cloudFingerprint);
  if (!state.migrationCandidates.length) return;
  const button = makeButton("迁移本机旧架构", "button-warning migration-trigger", () => {
    if (!state.editing) return showEditDialog(showMigrationDialog);
    showMigrationDialog();
  });
  button.title = "检测到这台电脑仍有旧的本机组织架构数据";
  dom.syncStatus.parentElement?.insertBefore(button, dom.syncStatus);
  state.migrationButton = button;
  showToast("检测到这台电脑里还有旧组织架构数据", "检查并迁移", async () => {
    if (!state.editing) await showEditDialog(showMigrationDialog); else showMigrationDialog();
  });
}

function showMigrationDialog() {
  const candidates = findLocalCandidates().filter((candidate) => candidate.fingerprint !== migrationFingerprint(activeNodes()));
  if (!candidates.length) return showToast("没有发现需要迁移的旧架构");
  const content = makeElement("div");
  content.append(makeElement("p", "modal-content-copy", "系统会先备份当前云端，再导入你选择的本机旧架构，并在导入后重新比对节点结构。旧版常用的 beize-org-chart-draft-v1 也会被扫描。"));
  const list = makeElement("div", "migration-candidates");
  candidates.forEach((candidate, index) => {
    const label = makeElement("label", "migration-candidate");
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "migration-source";
    radio.value = String(index);
    if (index === 0) radio.checked = true;
    const info = makeElement("div");
    info.append(makeElement("strong", "", candidate.systemSample ? `候选 ${index + 1} · 可能是系统示例` : `候选 ${index + 1} · 本机旧架构`));
    info.append(makeElement("span", "", `${candidate.nodes.length} 个节点 · 部门 ${candidate.departments} · 人员 ${candidate.people} · 存储键：${candidate.key}`));
    if (candidate.systemSample) info.append(makeElement("em", "migration-warning", "这份数据和系统示例高度相似，请确认后再选。"));
    label.append(radio, info);
    list.append(label);
  });
  content.append(list);
  const confirmLabel = makeElement("label", "migration-confirm");
  const confirm = document.createElement("input");
  confirm.type = "checkbox";
  confirmLabel.append(confirm, makeElement("span", "", "我已核对节点数量，确认用选中的本机架构覆盖当前云端；当前云端会自动备份。"));
  content.append(confirmLabel);

  openModal({
    title: "迁移本机旧架构",
    eyebrow: "一次性数据迁移",
    content,
    wide: true,
    actions: [
      { label: "取消", className: "button-secondary" },
      {
        label: "确认迁移",
        className: "button-danger",
        close: false,
        onClick: async (button) => {
          if (!confirm.checked) return showToast("请先勾选迁移确认");
          const selected = content.querySelector('input[name="migration-source"]:checked');
          if (!selected) return showToast("请选择一份本机架构");
          const candidate = candidates[Number(selected.value)];
          button.disabled = true;
          const payload = candidate.nodes.map(({ id, parent_id, type, name, title, notes, sort_order }) => ({ id, parent_id, type, name, title, notes, sort_order }));
          const result = await withWriteStatus(async () => {
            const { data, error } = await state.client.rpc("import_public_org_nodes", { p_organization_id: state.organization.id, p_nodes: payload });
            if (error) throw error;
            return data;
          });
          button.disabled = false;
          if (!result) return;
          await loadNodes();
          const after = structureFingerprint(activeNodes());
          const expected = structureFingerprint(candidate.nodes);
          if (after !== expected) {
            showToast("迁移后结构校验不一致，未标记为完成，请联系管理员");
            return;
          }
          localStorage.setItem(MIGRATION_DONE_KEY, JSON.stringify({ sourceKey: candidate.key, nodeCount: candidate.nodes.length, completedAt: new Date().toISOString(), backupId: result.backup_id ?? null }));
          removeMigrationButton();
          closeModal();
          state.selectedId = null;
          renderAll();
          window.BeizeCanvas?.fitToContent();
          showToast(`迁移完成：${candidate.nodes.length} 个节点已写入云端并校验通过`);
        },
      },
    ],
  });
}

function collapseAll() {
  state.collapsed.clear();
  const childCounts = new Map();
  for (const node of activeNodes()) if (node.parent_id) childCounts.set(node.parent_id, (childCounts.get(node.parent_id) ?? 0) + 1);
  for (const node of activeNodes()) if (node.type !== "company" && childCounts.has(node.id)) state.collapsed.add(node.id);
  renderTree();
  window.BeizeCanvas?.focusNode(companyRoot()?.id);
}

function expandAll() {
  state.collapsed.clear();
  renderTree();
}

function bindEvents() {
  dom.accountButton.addEventListener("click", () => showEditDialog());
  dom.addRootButton.addEventListener("click", () => showCreateNode(companyRoot()?.id));
  dom.compactAddRootButton.addEventListener("click", () => showCreateNode(companyRoot()?.id));
  dom.trashButton.addEventListener("click", showTrash);
  dom.compactTrashButton.addEventListener("click", showTrash);
  dom.historyButton.addEventListener("click", showHistory);
  dom.saveNodeButton.addEventListener("click", saveSelectedNode);
  dom.addChildButton.addEventListener("click", () => selectedNode() && showCreateNode(selectedNode().id));
  dom.moveUpButton.addEventListener("click", () => moveSelected("up"));
  dom.moveDownButton.addEventListener("click", () => moveSelected("down"));
  dom.deleteNodeButton.addEventListener("click", deleteSelected);
  dom.closeInspector.addEventListener("click", () => {
    state.selectedId = null;
    renderTree();
    renderInspector();
  });
  dom.modalClose.addEventListener("click", closeModal);
  dom.modalBackdrop.addEventListener("click", (event) => { if (event.target === dom.modalBackdrop) closeModal(); });
  dom.searchInput.addEventListener("input", () => {
    state.query = dom.searchInput.value;
    renderTree();
    const { matches } = getSearchState(activeNodes(), state.query);
    if (matches[0]) requestAnimationFrame(() => window.BeizeCanvas?.focusNode(matches[0], { minZoom: 0.65 }));
  });
  dom.rootButton.addEventListener("click", () => window.BeizeCanvas?.focusNode(companyRoot()?.id, { minZoom: 0.75 }));
  dom.fitButton.addEventListener("click", () => window.BeizeCanvas?.fitToContent());
  dom.expandAllButton.addEventListener("click", expandAll);
  dom.collapseAllButton.addEventListener("click", collapseAll);
  window.addEventListener("online", () => {
    dom.offlineBanner.classList.add("hidden");
    setStatus(state.editing ? `编辑中 · ${state.editorName}` : "云端只读 · 实时同步", "saved");
    scheduleReload();
  });
  window.addEventListener("offline", () => {
    dom.offlineBanner.classList.remove("hidden");
    setStatus("离线 · 只读", "offline");
  });
}

async function boot() {
  if (!CLOUD_ENABLED) throw new Error("Supabase 云端配置缺失");
  bindEvents();
  state.publicClient = makeClient();
  state.client = state.publicClient;
  await fetchOrganization();
  await restoreEditorSession();
  await loadNodes();
  await subscribeRealtime();
  renderAll();
  prepareMigrationPrompt();
  if (!navigator.onLine) dom.offlineBanner.classList.remove("hidden");
  if (window.matchMedia("(max-width: 700px)").matches) setTimeout(() => window.BeizeCanvas?.fitToContent(), 120);
}

boot().catch((error) => {
  console.error(error);
  setStatus("加载失败", "error");
  showToast(friendlyError(error));
});
