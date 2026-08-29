import { createClient } from "@supabase/supabase-js";
import "./graph-v2.css";
import { computeGraphVisibility, layoutDag, normalizeGraphEdges, wouldCreateCycle } from "./graph-layout.js";

const stage = document.querySelector("#tree-stage");
const searchInput = document.querySelector("#search-input");
const accountButton = document.querySelector("#account-button");
const SESSION_KEY = "beize-org-chart:editor-session:v1";
const CLIENT_ID_KEY = "beize-org-chart:client-id:v1";
const config = window.__BEIZE_CONFIG__ ?? {};
const enabled = Boolean(stage && /^https:\/\/.+\.supabase\.co$/i.test(String(config.SUPABASE_URL ?? "")) && String(config.SUPABASE_ANON_KEY ?? "").length > 40);

if (enabled) {
  const state = {
    organization: null,
    nodes: [],
    edges: [],
    collapsed: new Set(),
    connectSourceId: null,
    busy: false,
    channel: null,
    initialized: false,
    pendingFit: false,
    refreshTimer: null,
  };

  function clientId() {
    let id = localStorage.getItem(CLIENT_ID_KEY);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(CLIENT_ID_KEY, id);
    }
    return id;
  }

  function makeClient(token = "") {
    const headers = { "x-beize-client-id": clientId() };
    if (token) headers["x-beize-edit-token"] = token;
    return createClient(String(config.SUPABASE_URL), String(config.SUPABASE_ANON_KEY), {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      realtime: { params: { eventsPerSecond: 10 } },
      global: { headers },
    });
  }

  const publicClient = makeClient();

  function storedEditorSession() {
    try {
      const value = JSON.parse(sessionStorage.getItem(SESSION_KEY));
      if (!value?.token || !value?.organizationId || value.organizationId !== state.organization?.id) return null;
      return value;
    } catch {
      return null;
    }
  }

  function editingClient() {
    const session = storedEditorSession();
    return session ? makeClient(session.token) : null;
  }

  function isEditing() {
    return Boolean(storedEditorSession());
  }

  function toast(message) {
    const region = document.querySelector("#toast-region");
    if (!region) return;
    const item = document.createElement("div");
    item.className = "toast";
    item.textContent = message;
    region.append(item);
    setTimeout(() => item.remove(), 4200);
  }

  function nodeLabel(node) {
    if (!node) return "未知节点";
    return `${node.name}${node.type === "person" && node.title ? ` · ${node.title}` : ""}`;
  }

  function nodeById(id) {
    return state.nodes.find((node) => String(node.id) === String(id)) ?? null;
  }

  function showConnectTip(text) {
    let tip = document.querySelector("#graph-connect-tip");
    if (!text) {
      tip?.remove();
      return;
    }
    if (!tip) {
      tip = document.createElement("div");
      tip.id = "graph-connect-tip";
      tip.className = "graph-connect-tip";
      document.body.append(tip);
    }
    tip.textContent = text;
  }

  function syncConnectButton() {
    const button = document.querySelector("#graph-connect-button");
    if (!button) return;
    const active = Boolean(state.connectSourceId);
    button.classList.toggle("active", active);
    button.textContent = active ? "取消连线" : "＋ 连线";
    button.title = active ? "取消当前连线" : "先点上级节点，再点下级节点";
  }

  function cancelConnect() {
    state.connectSourceId = null;
    showConnectTip("");
    syncConnectButton();
    stage.querySelectorAll(".graph-connect-source").forEach((card) => card.classList.remove("graph-connect-source"));
    stage.querySelector(".org-graph")?.classList.remove("graph-connect-mode");
  }

  function startConnect(sourceId = null) {
    if (!isEditing()) {
      toast("请先点右上角“编辑”并输入密码，解锁后再连线");
      accountButton?.click();
      return;
    }
    if (state.connectSourceId) {
      cancelConnect();
      return;
    }
    state.connectSourceId = sourceId ? String(sourceId) : "__waiting_source__";
    syncConnectButton();
    stage.querySelector(".org-graph")?.classList.add("graph-connect-mode");
    if (sourceId) {
      stage.querySelector(`[data-node-id="${CSS.escape(String(sourceId))}"]`)?.classList.add("graph-connect-source");
      showConnectTip(`上级已选择：${nodeLabel(nodeById(sourceId))}。现在点需要连接的下级节点`);
    } else {
      showConnectTip("连线模式：先点一个上级节点，再点一个下级节点");
    }
  }

  function ensureToolbarButton() {
    if (document.querySelector("#graph-connect-button")) return;
    const host = document.querySelector(".canvas-toolbar-secondary") ?? document.querySelector(".canvas-toolbar-actions");
    if (!host) return;
    const button = document.createElement("button");
    button.id = "graph-connect-button";
    button.type = "button";
    button.className = "button button-ghost graph-connect-button";
    button.textContent = "＋ 连线";
    button.title = "先点上级节点，再点下级节点";
    button.addEventListener("click", () => startConnect());
    host.prepend(button);
  }

  async function refreshData({ fit = false } = {}) {
    if (!state.organization) {
      const { data: organization, error } = await publicClient
        .from("organizations")
        .select("id,name,is_public")
        .eq("is_public", true)
        .order("created_at")
        .limit(1)
        .maybeSingle();
      if (error || !organization) throw error ?? new Error("未找到公开组织");
      state.organization = organization;
    }

    const [{ data: nodes, error: nodeError }, { data: edges, error: edgeError }] = await Promise.all([
      publicClient.from("org_nodes").select("id,organization_id,parent_id,type,name,title,sort_order,deleted_at").eq("organization_id", state.organization.id).is("deleted_at", null).order("sort_order"),
      publicClient.from("org_edges").select("id,organization_id,parent_id,child_id,is_primary,sort_order").eq("organization_id", state.organization.id).order("sort_order"),
    ]);
    if (nodeError) throw nodeError;
    if (edgeError) throw edgeError;
    state.nodes = nodes ?? [];
    state.edges = normalizeGraphEdges(state.nodes, edges ?? []);
    if (fit) state.pendingFit = true;
    scheduleEnhance();
    renderRelationPanel();
  }

  function scheduleRefresh(options = {}) {
    clearTimeout(state.refreshTimer);
    state.refreshTimer = setTimeout(() => refreshData(options).catch((error) => toast(error?.message ?? "连接关系同步失败")), 120);
  }

  async function subscribe() {
    if (!state.organization) return;
    if (state.channel) await publicClient.removeChannel(state.channel);
    state.channel = publicClient
      .channel(`org-graph-${state.organization.id}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "org_edges", filter: `organization_id=eq.${state.organization.id}` }, () => scheduleRefresh())
      .on("postgres_changes", { event: "*", schema: "public", table: "org_nodes", filter: `organization_id=eq.${state.organization.id}` }, () => scheduleRefresh())
      .subscribe();
  }

  function graphVisibleNodes(cardIds) {
    const available = new Set(cardIds);
    const queryActive = Boolean(searchInput?.value.trim());
    const graphVisible = queryActive ? new Set(state.nodes.map((node) => String(node.id))) : computeGraphVisibility(state.nodes, state.edges, state.collapsed);
    return state.nodes.filter((node) => available.has(String(node.id)) && graphVisible.has(String(node.id)));
  }

  function ensureCollapseButtons(graph) {
    const outgoingCount = new Map();
    for (const edge of state.edges) outgoingCount.set(String(edge.parent_id), (outgoingCount.get(String(edge.parent_id)) ?? 0) + 1);
    for (const card of graph.querySelectorAll(".node-card")) {
      const id = String(card.dataset.nodeId ?? "");
      const hasChildren = (outgoingCount.get(id) ?? 0) > 0;
      let button = card.querySelector(".node-collapse-action");
      if (hasChildren && !button) {
        button = document.createElement("button");
        button.type = "button";
        button.className = "node-collapse-action graph-generated-collapse";
        card.append(button);
      }
      if (!hasChildren && button?.classList.contains("graph-generated-collapse")) button.remove();
      if (button && hasChildren) {
        const collapsed = state.collapsed.has(id);
        button.textContent = collapsed ? "展开" : "收起";
        button.setAttribute("aria-label", collapsed ? "展开下级" : "收起下级");
      }
    }
  }

  function drawGraph(graph) {
    const cards = [...graph.querySelectorAll(":scope > .node-card")];
    if (!cards.length) return;
    const cardIds = cards.map((card) => String(card.dataset.nodeId));
    const known = new Set(state.nodes.map((node) => String(node.id)));
    if (cardIds.some((id) => !known.has(id))) {
      scheduleRefresh();
      return;
    }

    ensureCollapseButtons(graph);
    const visibleNodes = graphVisibleNodes(cardIds);
    const visibleIds = new Set(visibleNodes.map((node) => String(node.id)));
    for (const card of cards) card.hidden = !visibleIds.has(String(card.dataset.nodeId));
    const visibleCards = cards.filter((card) => !card.hidden);
    if (!visibleCards.length) return;

    const cardWidth = Math.max(...visibleCards.map((card) => card.offsetWidth || 380));
    const cardHeight = Math.max(...visibleCards.map((card) => card.offsetHeight || 240));
    const mobile = window.matchMedia("(max-width: 640px)").matches;
    const visibleEdges = state.edges.filter((edge) => visibleIds.has(String(edge.parent_id)) && visibleIds.has(String(edge.child_id)));
    const layout = layoutDag(visibleNodes, visibleEdges, {
      cardWidth,
      cardHeight,
      horizontalGap: mobile ? 58 : 88,
      verticalGap: mobile ? 104 : 122,
      padding: mobile ? 38 : 58,
    });

    graph.style.width = `${layout.width}px`;
    graph.style.height = `${layout.height}px`;
    let svg = graph.querySelector(":scope > .graph-edges");
    if (!svg) {
      svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.classList.add("graph-edges");
      graph.prepend(svg);
    }
    svg.setAttribute("width", String(layout.width));
    svg.setAttribute("height", String(layout.height));
    svg.setAttribute("viewBox", `0 0 ${layout.width} ${layout.height}`);
    svg.replaceChildren();

    for (const card of visibleCards) {
      const position = layout.positions.get(String(card.dataset.nodeId));
      if (!position) continue;
      card.style.left = `${position.x}px`;
      card.style.top = `${position.y}px`;
      card.classList.toggle("graph-connect-source", String(card.dataset.nodeId) === String(state.connectSourceId));
    }

    for (const edge of visibleEdges) {
      const parent = layout.positions.get(String(edge.parent_id));
      const child = layout.positions.get(String(edge.child_id));
      if (!parent || !child) continue;
      const px = parent.x + cardWidth / 2;
      const py = parent.y + cardHeight;
      const cx = child.x + cardWidth / 2;
      const cy = child.y;
      const distance = Math.max(24, cy - py);
      const midY = py + Math.min(distance - 12, Math.max(34, distance * 0.48));
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.classList.add("graph-edge", edge.is_primary ? "is-primary" : "is-secondary");
      path.setAttribute("d", `M ${px} ${py} V ${midY} H ${cx} V ${cy}`);
      path.setAttribute("vector-effect", "non-scaling-stroke");
      path.dataset.edgeId = String(edge.id);
      svg.append(path);
    }

    graph.classList.toggle("graph-connect-mode", Boolean(state.connectSourceId));
    if (state.pendingFit) {
      state.pendingFit = false;
      requestAnimationFrame(() => window.BeizeCanvas?.fitToContent({ force: true, maxZoom: 1 }));
    }
  }

  function enhanceTree() {
    ensureToolbarButton();
    let graph = stage.querySelector(":scope > .org-graph");
    if (!graph) {
      const legacyTree = stage.querySelector(":scope > .org-tree");
      if (!legacyTree) {
        renderRelationPanel();
        return;
      }
      const cards = [...legacyTree.querySelectorAll(".node-card")];
      if (!cards.length) return;
      const known = new Set(state.nodes.map((node) => String(node.id)));
      if (cards.some((card) => !known.has(String(card.dataset.nodeId)))) {
        scheduleRefresh();
        return;
      }
      graph = document.createElement("div");
      graph.className = "org-tree org-graph";
      for (const card of cards) graph.append(card);
      stage.replaceChildren(graph);
      if (!state.initialized) {
        state.initialized = true;
        state.pendingFit = true;
      }
    }
    drawGraph(graph);
    renderRelationPanel();
  }

  let enhanceFrame = 0;
  function scheduleEnhance() {
    cancelAnimationFrame(enhanceFrame);
    enhanceFrame = requestAnimationFrame(enhanceTree);
  }

  function selectedId() {
    return stage.querySelector(".node-card.selected")?.dataset.nodeId ?? null;
  }

  function relationRow(edge, otherNode, direction) {
    const row = document.createElement("div");
    row.className = "graph-relation-row";
    const label = document.createElement("strong");
    label.textContent = nodeLabel(otherNode);
    row.append(label);
    if (edge.is_primary && direction === "up") {
      const badge = document.createElement("span");
      badge.className = "graph-relation-badge";
      badge.textContent = "主上级";
      row.append(badge);
    }
    if (isEditing()) {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "button button-danger graph-relation-remove";
      remove.textContent = "断开";
      remove.addEventListener("click", async () => {
        if (state.busy) return;
        const client = editingClient();
        if (!client) return toast("编辑权限已失效，请重新解锁");
        state.busy = true;
        remove.disabled = true;
        const { error } = await client.rpc("delete_org_edge", { p_edge_id: edge.id });
        state.busy = false;
        if (error) {
          remove.disabled = false;
          return toast(error.message ?? "断开连接失败");
        }
        toast("连接已断开");
        await refreshData({ fit: true });
      });
      row.append(remove);
    }
    return row;
  }

  function renderRelationPanel() {
    const form = document.querySelector("#node-form");
    if (!form) return;
    form.querySelector("#graph-relations")?.remove();
    const id = selectedId();
    if (!id) return;
    const node = nodeById(id);
    if (!node) return;

    const parentLabel = document.querySelector("#field-parent")?.closest("label")?.querySelector("span");
    if (parentLabel) parentLabel.textContent = "主要上级（布局参考）";

    const panel = document.createElement("section");
    panel.id = "graph-relations";
    panel.className = "graph-relation-panel";
    const title = document.createElement("h3");
    title.textContent = "连接关系";
    const help = document.createElement("p");
    help.textContent = "一个节点可以有多个上级。主上级用于兼容和排序，其他连线同样有效。";
    panel.append(title, help);

    const upstream = state.edges.filter((edge) => String(edge.child_id) === String(id));
    const downstream = state.edges.filter((edge) => String(edge.parent_id) === String(id));
    for (const [caption, list, direction] of [["上级连接", upstream, "up"], ["下级连接", downstream, "down"]]) {
      const group = document.createElement("div");
      group.className = "graph-relation-group";
      const groupTitle = document.createElement("span");
      groupTitle.className = "graph-relation-group-title";
      groupTitle.textContent = `${caption} · ${list.length}`;
      group.append(groupTitle);
      const rows = document.createElement("div");
      rows.className = "graph-relation-list";
      if (!list.length) {
        const empty = document.createElement("div");
        empty.className = "graph-relation-empty";
        empty.textContent = "暂无连接";
        rows.append(empty);
      } else {
        for (const edge of list) {
          const otherId = direction === "up" ? edge.parent_id : edge.child_id;
          rows.append(relationRow(edge, nodeById(otherId), direction));
        }
      }
      group.append(rows);
      panel.append(group);
    }

    if (isEditing() && node.type !== "company") {
      const actions = document.createElement("div");
      actions.className = "graph-relation-actions";
      const asParent = document.createElement("button");
      asParent.type = "button";
      asParent.className = "button button-primary";
      asParent.textContent = "从此节点开始连线";
      asParent.addEventListener("click", () => startConnect(id));
      actions.append(asParent);
      panel.append(actions);
    } else if (isEditing() && node.type === "company") {
      const actions = document.createElement("div");
      actions.className = "graph-relation-actions";
      const asParent = document.createElement("button");
      asParent.type = "button";
      asParent.className = "button button-primary";
      asParent.textContent = "从公司开始连线";
      asParent.addEventListener("click", () => startConnect(id));
      actions.append(asParent);
      panel.append(actions);
    }

    const deleteButton = document.querySelector("#delete-node-button");
    if (deleteButton?.parentElement === form) form.insertBefore(panel, deleteButton);
    else form.append(panel);
  }

  async function createConnection(parentId, childId) {
    const parent = nodeById(parentId);
    const child = nodeById(childId);
    if (!parent || !child) return toast("节点不存在，请刷新后重试");
    if (parentId === childId) return toast("不能把节点连接到自己");
    if (child.type === "company") return toast("公司根节点不能设置上级");
    if (state.edges.some((edge) => String(edge.parent_id) === String(parentId) && String(edge.child_id) === String(childId))) return toast("这两个节点已经连接");
    if (wouldCreateCycle(state.edges, parentId, childId)) return toast("这条连线会形成循环关系，系统已阻止");
    const client = editingClient();
    if (!client) {
      cancelConnect();
      toast("编辑权限已失效，请重新解锁");
      return accountButton?.click();
    }
    state.busy = true;
    const { error } = await client.rpc("create_org_edge", {
      p_organization_id: state.organization.id,
      p_parent_id: parentId,
      p_child_id: childId,
    });
    state.busy = false;
    if (error) {
      const message = /cycle/i.test(error.message ?? "") ? "这条连线会形成循环关系，系统已阻止" : /already|duplicate/i.test(error.message ?? "") ? "这两个节点已经连接" : (error.message ?? "创建连接失败");
      return toast(message);
    }
    cancelConnect();
    toast(`已连接：${parent.name} → ${child.name}`);
    await refreshData({ fit: true });
  }

  window.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;

    const graph = stage.querySelector(".org-graph");
    const card = target.closest(".node-card");
    if (graph && card && graph.contains(card) && state.connectSourceId && !target.closest("button")) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (state.busy) return;
      const id = String(card.dataset.nodeId);
      if (state.connectSourceId === "__waiting_source__") {
        state.connectSourceId = id;
        card.classList.add("graph-connect-source");
        showConnectTip(`上级已选择：${nodeLabel(nodeById(id))}。现在点需要连接的下级节点`);
        syncConnectButton();
        return;
      }
      if (id === String(state.connectSourceId)) return toast("请选择另一个节点作为下级");
      createConnection(String(state.connectSourceId), id);
      return;
    }

    const collapse = target.closest(".node-collapse-action");
    if (graph && collapse && graph.contains(collapse)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      const id = String(collapse.closest(".node-card")?.dataset.nodeId ?? "");
      if (!id) return;
      if (state.collapsed.has(id)) state.collapsed.delete(id); else state.collapsed.add(id);
      drawGraph(graph);
      return;
    }

    if (target.closest("#collapse-all-button")) {
      event.preventDefault();
      event.stopImmediatePropagation();
      for (const edge of state.edges) state.collapsed.add(String(edge.parent_id));
      if (graph) drawGraph(graph);
      return;
    }
    if (target.closest("#expand-all-button")) {
      event.preventDefault();
      event.stopImmediatePropagation();
      state.collapsed.clear();
      if (graph) drawGraph(graph);
    }
  }, true);

  const observer = new MutationObserver(() => scheduleEnhance());
  observer.observe(stage, { childList: true, subtree: true });
  const accountObserver = new MutationObserver(() => {
    syncConnectButton();
    renderRelationPanel();
  });
  if (accountButton) accountObserver.observe(accountButton, { attributes: true, childList: true, subtree: true });
  window.addEventListener("resize", scheduleEnhance);
  searchInput?.addEventListener("input", () => setTimeout(scheduleEnhance, 0));

  (async () => {
    try {
      await refreshData();
      await subscribe();
      ensureToolbarButton();
      scheduleEnhance();
    } catch (error) {
      console.error("Graph enhancement failed", error);
      toast("多重汇报关系加载失败，请刷新页面重试");
    }
  })();
}
