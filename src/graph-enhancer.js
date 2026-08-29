import { createClient } from "@supabase/supabase-js";
import "./graph-v2.css";
import { computeGraphVisibility, layoutDag, normalizeGraphEdges, wouldCreateCycle } from "./graph-layout.js";

const stage = document.querySelector("#tree-stage");
const searchInput = document.querySelector("#search-input");
const accountButton = document.querySelector("#account-button");
const SESSION_KEY = "beize-org-chart:editor-session:v1";
const CLIENT_ID_KEY = "beize-org-chart:client-id:v1";
const cfg = window.__BEIZE_CONFIG__ ?? {};
const enabled = Boolean(stage && /^https:\/\/.+\.supabase\.co$/i.test(String(cfg.SUPABASE_URL ?? "")) && String(cfg.SUPABASE_ANON_KEY ?? "").length > 40);

if (enabled) {
  const state = { org: null, nodes: [], edges: [], collapsed: new Set(), source: null, busy: false, channel: null, firstLayout: true, fitNext: false, refreshTimer: 0 };

  function getClientId() {
    let id = localStorage.getItem(CLIENT_ID_KEY);
    if (!id) { id = crypto.randomUUID(); localStorage.setItem(CLIENT_ID_KEY, id); }
    return id;
  }

  function makeClient(token = "") {
    const headers = { "x-beize-client-id": getClientId() };
    if (token) headers["x-beize-edit-token"] = token;
    return createClient(String(cfg.SUPABASE_URL), String(cfg.SUPABASE_ANON_KEY), {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      realtime: { params: { eventsPerSecond: 10 } },
      global: { headers },
    });
  }

  const publicClient = makeClient();

  function editorSession() {
    try {
      const value = JSON.parse(sessionStorage.getItem(SESSION_KEY));
      return value?.token && value?.organizationId === state.org?.id ? value : null;
    } catch { return null; }
  }
  const isEditing = () => Boolean(editorSession());
  const editClient = () => editorSession() ? makeClient(editorSession().token) : null;
  const nodeById = (id) => state.nodes.find((node) => String(node.id) === String(id)) ?? null;
  const label = (node) => node ? `${node.name}${node.type === "person" && node.title ? ` · ${node.title}` : ""}` : "未知节点";

  function toast(message) {
    const region = document.querySelector("#toast-region");
    if (!region) return;
    const item = document.createElement("div");
    item.className = "toast";
    item.textContent = message;
    region.append(item);
    setTimeout(() => item.remove(), 4200);
  }

  function tip(message = "") {
    let el = document.querySelector("#graph-connect-tip");
    if (!message) { el?.remove(); return; }
    if (!el) { el = document.createElement("div"); el.id = "graph-connect-tip"; el.className = "graph-connect-tip"; document.body.append(el); }
    el.textContent = message;
  }

  function ensureConnectButton() {
    if (document.querySelector("#graph-connect-button")) return;
    const host = document.querySelector(".canvas-toolbar-secondary") ?? document.querySelector(".canvas-toolbar-actions");
    if (!host) return;
    const button = document.createElement("button");
    button.id = "graph-connect-button";
    button.type = "button";
    button.className = "button button-ghost graph-connect-button";
    button.addEventListener("click", () => state.source ? cancelConnect() : beginConnect());
    host.prepend(button);
    syncConnectUi();
  }

  function syncConnectUi() {
    const button = document.querySelector("#graph-connect-button");
    if (button) {
      button.textContent = state.source ? "取消连线" : "＋ 连线";
      button.classList.toggle("active", Boolean(state.source));
      button.title = state.source ? "取消当前连线" : "先点上级节点，再点下级节点";
    }
    const graph = stage.querySelector(".org-graph");
    graph?.classList.toggle("graph-connect-mode", Boolean(state.source));
    graph?.querySelectorAll(".node-card").forEach((card) => card.classList.toggle("graph-connect-source", state.source !== "__pick_source__" && String(card.dataset.nodeId) === String(state.source)));
  }

  function beginConnect(sourceId = null) {
    if (!isEditing()) {
      toast("请先点右上角“编辑”解锁，再进行连线");
      accountButton?.click();
      return;
    }
    state.source = sourceId ? String(sourceId) : "__pick_source__";
    syncConnectUi();
    tip(sourceId ? `上级已选择：${label(nodeById(sourceId))}。现在点下级节点` : "连线模式：先点上级节点，再点下级节点");
  }

  function cancelConnect() {
    state.source = null;
    tip();
    syncConnectUi();
  }

  async function loadData({ fit = false } = {}) {
    if (!state.org) {
      const { data, error } = await publicClient.from("organizations").select("id,name,is_public").eq("is_public", true).order("created_at").limit(1).maybeSingle();
      if (error || !data) throw error ?? new Error("未找到公开组织");
      state.org = data;
    }
    const [nodesResult, edgesResult] = await Promise.all([
      publicClient.from("org_nodes").select("id,organization_id,parent_id,type,name,title,sort_order,deleted_at").eq("organization_id", state.org.id).is("deleted_at", null).order("sort_order"),
      publicClient.from("org_edges").select("id,organization_id,parent_id,child_id,is_primary,sort_order").eq("organization_id", state.org.id).order("sort_order"),
    ]);
    if (nodesResult.error) throw nodesResult.error;
    if (edgesResult.error) throw edgesResult.error;
    state.nodes = nodesResult.data ?? [];
    state.edges = normalizeGraphEdges(state.nodes, edgesResult.data ?? []);
    state.fitNext ||= fit;
    scheduleEnhance();
    renderRelations();
  }

  function scheduleRefresh(options = {}) {
    clearTimeout(state.refreshTimer);
    state.refreshTimer = setTimeout(() => loadData(options).catch((error) => toast(error?.message ?? "连接关系同步失败")), 120);
  }

  async function subscribe() {
    if (!state.org) return;
    if (state.channel) await publicClient.removeChannel(state.channel);
    state.channel = publicClient.channel(`org-graph-${state.org.id}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "org_edges", filter: `organization_id=eq.${state.org.id}` }, () => scheduleRefresh())
      .on("postgres_changes", { event: "*", schema: "public", table: "org_nodes", filter: `organization_id=eq.${state.org.id}` }, () => scheduleRefresh())
      .subscribe();
  }

  function ensureCollapseButtons(graph) {
    const counts = new Map();
    state.edges.forEach((edge) => counts.set(String(edge.parent_id), (counts.get(String(edge.parent_id)) ?? 0) + 1));
    graph.querySelectorAll(".node-card").forEach((card) => {
      const id = String(card.dataset.nodeId);
      const hasChildren = (counts.get(id) ?? 0) > 0;
      let button = card.querySelector(".node-collapse-action");
      if (hasChildren && !button) {
        button = document.createElement("button");
        button.type = "button";
        button.className = "node-collapse-action graph-generated-collapse";
        card.append(button);
      }
      if (!hasChildren && button?.classList.contains("graph-generated-collapse")) button.remove();
      if (button && hasChildren) button.textContent = state.collapsed.has(id) ? "展开" : "收起";
    });
  }

  function draw(graph) {
    const cards = [...graph.querySelectorAll(":scope > .node-card")];
    if (!cards.length) return;
    const knownIds = new Set(state.nodes.map((node) => String(node.id)));
    if (cards.some((card) => !knownIds.has(String(card.dataset.nodeId)))) return scheduleRefresh();

    ensureCollapseButtons(graph);
    const cardIds = new Set(cards.map((card) => String(card.dataset.nodeId)));
    const visibleGraph = searchInput?.value.trim() ? new Set(state.nodes.map((node) => String(node.id))) : computeGraphVisibility(state.nodes, state.edges, state.collapsed);
    const visibleNodes = state.nodes.filter((node) => cardIds.has(String(node.id)) && visibleGraph.has(String(node.id)));
    const visibleIds = new Set(visibleNodes.map((node) => String(node.id)));
    cards.forEach((card) => { card.hidden = !visibleIds.has(String(card.dataset.nodeId)); });
    const visibleCards = cards.filter((card) => !card.hidden);
    if (!visibleCards.length) return;

    const cardWidth = Math.max(...visibleCards.map((card) => card.offsetWidth || 380));
    const cardHeight = Math.max(...visibleCards.map((card) => card.offsetHeight || 240));
    const mobile = matchMedia("(max-width: 640px)").matches;
    const visibleEdges = state.edges.filter((edge) => visibleIds.has(String(edge.parent_id)) && visibleIds.has(String(edge.child_id)));
    const layout = layoutDag(visibleNodes, visibleEdges, { cardWidth, cardHeight, horizontalGap: mobile ? 58 : 88, verticalGap: mobile ? 104 : 122, padding: mobile ? 38 : 58 });

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

    visibleCards.forEach((card) => {
      const pos = layout.positions.get(String(card.dataset.nodeId));
      if (!pos) return;
      card.style.left = `${pos.x}px`;
      card.style.top = `${pos.y}px`;
    });

    visibleEdges.forEach((edge) => {
      const p = layout.positions.get(String(edge.parent_id));
      const c = layout.positions.get(String(edge.child_id));
      if (!p || !c) return;
      const px = p.x + cardWidth / 2, py = p.y + cardHeight, cx = c.x + cardWidth / 2, cy = c.y;
      const gap = Math.max(24, cy - py);
      const midY = py + Math.min(gap - 12, Math.max(34, gap * 0.48));
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.classList.add("graph-edge", edge.is_primary ? "is-primary" : "is-secondary");
      path.setAttribute("d", `M ${px} ${py} V ${midY} H ${cx} V ${cy}`);
      path.setAttribute("vector-effect", "non-scaling-stroke");
      path.dataset.edgeId = String(edge.id);
      svg.append(path);
    });

    syncConnectUi();
    if (state.firstLayout || state.fitNext) {
      state.firstLayout = false;
      state.fitNext = false;
      requestAnimationFrame(() => window.BeizeCanvas?.fitToContent({ force: true, maxZoom: 1 }));
    }
  }

  function enhance() {
    ensureConnectButton();
    let graph = stage.querySelector(":scope > .org-graph");
    if (!graph) {
      const tree = stage.querySelector(":scope > .org-tree");
      if (!tree) return renderRelations();
      const cards = [...tree.querySelectorAll(".node-card")];
      if (!cards.length) return;
      const knownIds = new Set(state.nodes.map((node) => String(node.id)));
      if (cards.some((card) => !knownIds.has(String(card.dataset.nodeId)))) return scheduleRefresh();
      graph = document.createElement("div");
      graph.className = "org-tree org-graph";
      cards.forEach((card) => graph.append(card));
      stage.replaceChildren(graph);
    }
    draw(graph);
    renderRelations();
  }

  let frame = 0;
  function scheduleEnhance() { cancelAnimationFrame(frame); frame = requestAnimationFrame(enhance); }
  const selectedId = () => stage.querySelector(".node-card.selected")?.dataset.nodeId ?? null;

  function relationRow(edge, otherNode, upstream) {
    const row = document.createElement("div");
    row.className = "graph-relation-row";
    const text = document.createElement("strong");
    text.textContent = label(otherNode);
    row.append(text);
    if (upstream && edge.is_primary) {
      const badge = document.createElement("span"); badge.className = "graph-relation-badge"; badge.textContent = "主上级"; row.append(badge);
    }
    if (isEditing()) {
      const remove = document.createElement("button");
      remove.type = "button"; remove.className = "button button-danger graph-relation-remove"; remove.textContent = "断开";
      remove.addEventListener("click", async () => {
        if (state.busy) return;
        const client = editClient();
        if (!client) return toast("编辑权限已失效，请重新解锁");
        state.busy = true; remove.disabled = true;
        const { error } = await client.rpc("delete_org_edge", { p_edge_id: edge.id });
        state.busy = false;
        if (error) { remove.disabled = false; return toast(error.message ?? "断开连接失败"); }
        toast("连接已断开");
        await loadData({ fit: true });
      });
      row.append(remove);
    }
    return row;
  }

  function renderRelations() {
    const form = document.querySelector("#node-form");
    if (!form) return;
    form.querySelector("#graph-relations")?.remove();
    const id = selectedId();
    if (!id || !nodeById(id)) return;
    const parentLabel = document.querySelector("#field-parent")?.closest("label")?.querySelector("span");
    if (parentLabel) parentLabel.textContent = "主要上级（布局参考）";

    const panel = document.createElement("section"); panel.id = "graph-relations"; panel.className = "graph-relation-panel";
    const h = document.createElement("h3"); h.textContent = "连接关系";
    const help = document.createElement("p"); help.textContent = "可同时连接多个上级。主上级只用于兼容和排序，其他连线同样有效。";
    panel.append(h, help);
    const groups = [
      ["上级连接", state.edges.filter((edge) => String(edge.child_id) === String(id)), true],
      ["下级连接", state.edges.filter((edge) => String(edge.parent_id) === String(id)), false],
    ];
    groups.forEach(([caption, list, upstream]) => {
      const group = document.createElement("div"); group.className = "graph-relation-group";
      const title = document.createElement("span"); title.className = "graph-relation-group-title"; title.textContent = `${caption} · ${list.length}`; group.append(title);
      const rows = document.createElement("div"); rows.className = "graph-relation-list";
      if (!list.length) { const empty = document.createElement("div"); empty.className = "graph-relation-empty"; empty.textContent = "暂无连接"; rows.append(empty); }
      list.forEach((edge) => rows.append(relationRow(edge, nodeById(upstream ? edge.parent_id : edge.child_id), upstream)));
      group.append(rows); panel.append(group);
    });
    if (isEditing()) {
      const actions = document.createElement("div"); actions.className = "graph-relation-actions";
      const start = document.createElement("button"); start.type = "button"; start.className = "button button-primary"; start.textContent = "从此节点开始连线"; start.addEventListener("click", () => beginConnect(id));
      actions.append(start); panel.append(actions);
    }
    const deleteButton = document.querySelector("#delete-node-button");
    deleteButton?.parentElement === form ? form.insertBefore(panel, deleteButton) : form.append(panel);
  }

  async function createConnection(parentId, childId) {
    const parent = nodeById(parentId), child = nodeById(childId);
    if (!parent || !child) return toast("节点不存在，请刷新后重试");
    if (parentId === childId) return toast("不能连接到自己");
    if (child.type === "company") return toast("公司根节点不能设置上级");
    if (state.edges.some((edge) => String(edge.parent_id) === parentId && String(edge.child_id) === childId)) return toast("这两个节点已经连接");
    if (wouldCreateCycle(state.edges, parentId, childId)) return toast("这条连线会形成循环关系，系统已阻止");
    const client = editClient();
    if (!client) { cancelConnect(); toast("编辑权限已失效，请重新解锁"); return accountButton?.click(); }
    state.busy = true;
    const { error } = await client.rpc("create_org_edge", { p_organization_id: state.org.id, p_parent_id: parentId, p_child_id: childId });
    state.busy = false;
    if (error) return toast(/cycle/i.test(error.message ?? "") ? "这条连线会形成循环关系，系统已阻止" : /already|duplicate/i.test(error.message ?? "") ? "这两个节点已经连接" : (error.message ?? "创建连接失败"));
    cancelConnect();
    toast(`已连接：${parent.name} → ${child.name}`);
    await loadData({ fit: true });
  }

  window.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    const graph = stage.querySelector(".org-graph");
    const card = target.closest(".node-card");
    if (graph && card && graph.contains(card) && state.source && !target.closest("button")) {
      event.preventDefault(); event.stopImmediatePropagation();
      if (state.busy) return;
      const id = String(card.dataset.nodeId);
      if (state.source === "__pick_source__") {
        state.source = id; syncConnectUi(); tip(`上级已选择：${label(nodeById(id))}。现在点下级节点`); return;
      }
      if (id === String(state.source)) return toast("请选择另一个节点作为下级");
      createConnection(String(state.source), id); return;
    }
    const collapse = target.closest(".node-collapse-action");
    if (graph && collapse && graph.contains(collapse)) {
      event.preventDefault(); event.stopImmediatePropagation();
      const id = String(collapse.closest(".node-card")?.dataset.nodeId ?? "");
      if (!id) return;
      state.collapsed.has(id) ? state.collapsed.delete(id) : state.collapsed.add(id);
      draw(graph); return;
    }
    if (target.closest("#collapse-all-button")) {
      event.preventDefault(); event.stopImmediatePropagation();
      state.edges.forEach((edge) => state.collapsed.add(String(edge.parent_id)));
      if (graph) draw(graph); return;
    }
    if (target.closest("#expand-all-button")) {
      event.preventDefault(); event.stopImmediatePropagation();
      state.collapsed.clear(); if (graph) draw(graph);
    }
  }, true);

  // Only direct stage child replacement means the main app rebuilt the tree.
  // Observing the whole subtree would retrigger on every SVG path redraw.
  new MutationObserver(scheduleEnhance).observe(stage, { childList: true });
  if (accountButton) new MutationObserver(() => { syncConnectUi(); renderRelations(); }).observe(accountButton, { attributes: true, childList: true, subtree: true });
  addEventListener("resize", scheduleEnhance);
  searchInput?.addEventListener("input", () => setTimeout(scheduleEnhance, 0));

  (async () => {
    try {
      await loadData();
      await subscribe();
      ensureConnectButton();
      scheduleEnhance();
    } catch (error) {
      console.error("Graph enhancement failed", error);
      toast("多重汇报关系加载失败，请刷新页面重试");
    }
  })();
}
