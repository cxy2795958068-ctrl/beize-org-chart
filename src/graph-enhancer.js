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
  const state = {
    org: null,
    nodes: [],
    edges: [],
    collapsed: new Set(),
    port: null,
    busy: false,
    channel: null,
    firstLayout: true,
    fitNext: false,
    refreshTimer: 0,
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
    } catch {
      return null;
    }
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
    if (!message) {
      el?.remove();
      return;
    }
    if (!el) {
      el = document.createElement("div");
      el.id = "graph-connect-tip";
      el.className = "graph-connect-tip";
      document.body.append(el);
    }
    el.textContent = message;
  }

  function removeLegacyConnectButton() {
    document.querySelector("#graph-connect-button")?.remove();
  }

  function resetPortSelection() {
    state.port = null;
    tip();
    syncPortUi();
  }

  function syncPortUi() {
    removeLegacyConnectButton();
    const graph = stage.querySelector(".org-graph");
    if (!graph) return;
    const editing = isEditing();
    if (!editing && state.port) state.port = null;
    graph.classList.toggle("graph-port-editing", editing);

    graph.querySelectorAll(".graph-port").forEach((port) => {
      const nodeId = String(port.dataset.portNodeId ?? "");
      const kind = String(port.dataset.portKind ?? "");
      const active = Boolean(state.port && String(state.port.nodeId) === nodeId && state.port.kind === kind);
      const compatible = Boolean(state.port && String(state.port.nodeId) !== nodeId && state.port.kind !== kind);
      const unavailable = Boolean(state.port && !active && !compatible);
      port.classList.toggle("selected", active);
      port.classList.toggle("compatible", compatible);
      port.classList.toggle("unavailable", unavailable);
      port.setAttribute("aria-pressed", active ? "true" : "false");
    });
  }

  function ensurePorts(graph) {
    graph.querySelectorAll(":scope > .node-card").forEach((card) => {
      const nodeId = String(card.dataset.nodeId ?? "");
      const node = nodeById(nodeId);
      if (!node) return;

      let output = card.querySelector(":scope > .graph-port-out");
      if (!output) {
        output = document.createElement("button");
        output.type = "button";
        output.className = "graph-port graph-port-out";
        output.dataset.portKind = "out";
        card.append(output);
      }
      output.dataset.portNodeId = nodeId;
      output.setAttribute("aria-label", `${label(node)} 向下连接点`);
      output.title = "向下连接";

      let input = card.querySelector(":scope > .graph-port-in");
      if (node.type === "company") {
        input?.remove();
      } else {
        if (!input) {
          input = document.createElement("button");
          input.type = "button";
          input.className = "graph-port graph-port-in";
          input.dataset.portKind = "in";
          card.append(input);
        }
        input.dataset.portNodeId = nodeId;
        input.setAttribute("aria-label", `${label(node)} 上级连接点`);
        input.title = "接收上级连接";
      }
    });
    syncPortUi();
  }

  async function loadData({ fit = false } = {}) {
    if (!state.org) {
      const { data, error } = await publicClient
        .from("organizations")
        .select("id,name,is_public")
        .eq("is_public", true)
        .order("created_at")
        .limit(1)
        .maybeSingle();
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
    ensurePorts(graph);

    const cardIds = new Set(cards.map((card) => String(card.dataset.nodeId)));
    const visibleGraph = searchInput?.value.trim()
      ? new Set(state.nodes.map((node) => String(node.id)))
      : computeGraphVisibility(state.nodes, state.edges, state.collapsed);
    const visibleNodes = state.nodes.filter((node) => cardIds.has(String(node.id)) && visibleGraph.has(String(node.id)));
    const visibleIds = new Set(visibleNodes.map((node) => String(node.id)));
    cards.forEach((card) => { card.hidden = !visibleIds.has(String(card.dataset.nodeId)); });
    const visibleCards = cards.filter((card) => !card.hidden);
    if (!visibleCards.length) return;

    const cardWidth = Math.max(...visibleCards.map((card) => card.offsetWidth || 380));
    const cardHeight = Math.max(...visibleCards.map((card) => card.offsetHeight || 240));
    const mobile = matchMedia("(max-width: 640px)").matches;
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
      const px = p.x + cardWidth / 2;
      const py = p.y + cardHeight;
      const cx = c.x + cardWidth / 2;
      const cy = c.y;
      const gap = Math.max(24, cy - py);
      const midY = py + Math.min(gap - 12, Math.max(34, gap * 0.48));
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.classList.add("graph-edge", edge.is_primary ? "is-primary" : "is-secondary");
      path.setAttribute("d", `M ${px} ${py} V ${midY} H ${cx} V ${cy}`);
      path.setAttribute("vector-effect", "non-scaling-stroke");
      path.dataset.edgeId = String(edge.id);
      svg.append(path);
    });

    syncPortUi();
    if (state.firstLayout || state.fitNext) {
      state.firstLayout = false;
      state.fitNext = false;
      requestAnimationFrame(() => window.BeizeCanvas?.fitToContent({ force: true, maxZoom: 1 }));
    }
  }

  function enhance() {
    removeLegacyConnectButton();
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
  function scheduleEnhance() {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(enhance);
  }

  const selectedId = () => stage.querySelector(".node-card.selected")?.dataset.nodeId ?? null;

  function relationRow(edge, otherNode, upstream) {
    const row = document.createElement("div");
    row.className = "graph-relation-row";
    const text = document.createElement("strong");
    text.textContent = label(otherNode);
    row.append(text);

    if (upstream && edge.is_primary) {
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
        const client = editClient();
        if (!client) return toast("编辑权限已失效，请重新解锁");
        state.busy = true;
        remove.disabled = true;
        const { error } = await client.rpc("delete_org_edge", { p_edge_id: edge.id });
        state.busy = false;
        if (error) {
          remove.disabled = false;
          return toast(error.message ?? "断开连接失败");
        }
        resetPortSelection();
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
    if (parentLabel) parentLabel.textContent = "主要上级（由连线自动同步）";

    const panel = document.createElement("section");
    panel.id = "graph-relations";
    panel.className = "graph-relation-panel";
    const h = document.createElement("h3");
    h.textContent = "连接关系";
    const help = document.createElement("p");
    help.textContent = "连接关系由卡片顶部/底部的小圆点自动生成；这里仅用于查看，必要时也可直接断开。";
    panel.append(h, help);

    const groups = [
      ["上级连接", state.edges.filter((edge) => String(edge.child_id) === String(id)), true],
      ["下级连接", state.edges.filter((edge) => String(edge.parent_id) === String(id)), false],
    ];

    groups.forEach(([caption, list, upstream]) => {
      const group = document.createElement("div");
      group.className = "graph-relation-group";
      const title = document.createElement("span");
      title.className = "graph-relation-group-title";
      title.textContent = `${caption} · ${list.length}`;
      group.append(title);
      const rows = document.createElement("div");
      rows.className = "graph-relation-list";
      if (!list.length) {
        const empty = document.createElement("div");
        empty.className = "graph-relation-empty";
        empty.textContent = "暂无连接";
        rows.append(empty);
      }
      list.forEach((edge) => rows.append(relationRow(edge, nodeById(upstream ? edge.parent_id : edge.child_id), upstream)));
      group.append(rows);
      panel.append(group);
    });

    const deleteButton = document.querySelector("#delete-node-button");
    deleteButton?.parentElement === form ? form.insertBefore(panel, deleteButton) : form.append(panel);
  }

  async function createConnection(parentId, childId) {
    const parent = nodeById(parentId);
    const child = nodeById(childId);
    if (!parent || !child) return toast("节点不存在，请刷新后重试");
    if (parentId === childId) return toast("不能连接到自己");
    if (child.type === "company") return toast("公司根节点不能设置上级");
    if (wouldCreateCycle(state.edges, parentId, childId)) return toast("这条连线会形成循环关系，系统已阻止");

    const client = editClient();
    if (!client) {
      resetPortSelection();
      toast("编辑权限已失效，请重新解锁");
      return accountButton?.click();
    }

    state.busy = true;
    syncPortUi();
    const { error } = await client.rpc("create_org_edge", {
      p_organization_id: state.org.id,
      p_parent_id: parentId,
      p_child_id: childId,
    });
    state.busy = false;
    resetPortSelection();
    if (error) {
      return toast(/cycle/i.test(error.message ?? "")
        ? "这条连线会形成循环关系，系统已阻止"
        : /already|duplicate/i.test(error.message ?? "")
          ? "这两个节点已经连接"
          : (error.message ?? "创建连接失败"));
    }
    toast(`已连接：${parent.name} → ${child.name}`);
    await loadData({ fit: true });
  }

  async function deleteConnection(edge) {
    const parent = nodeById(edge.parent_id);
    const child = nodeById(edge.child_id);
    const client = editClient();
    if (!client) {
      resetPortSelection();
      toast("编辑权限已失效，请重新解锁");
      return accountButton?.click();
    }

    state.busy = true;
    syncPortUi();
    const { error } = await client.rpc("delete_org_edge", { p_edge_id: edge.id });
    state.busy = false;
    resetPortSelection();
    if (error) return toast(error.message ?? "断开连接失败");
    toast(`已断开：${parent?.name ?? "上级"} → ${child?.name ?? "下级"}`);
    await loadData({ fit: true });
  }

  async function toggleConnection(parentId, childId) {
    if (state.busy) return;
    const existing = state.edges.find((edge) => String(edge.parent_id) === String(parentId) && String(edge.child_id) === String(childId));
    if (existing) return deleteConnection(existing);
    return createConnection(String(parentId), String(childId));
  }

  function selectPort(nodeId, kind) {
    if (!isEditing()) {
      toast("请先点右上角“编辑”解锁");
      return accountButton?.click();
    }
    if (state.busy) return;

    const current = state.port;
    if (!current) {
      state.port = { nodeId: String(nodeId), kind };
      syncPortUi();
      const node = nodeById(nodeId);
      tip(kind === "out"
        ? `已选：${label(node)} 的下方连接点。再点目标节点顶部圆点即可连线`
        : `已选：${label(node)} 的顶部连接点。再点上级节点底部圆点即可连线`);
      return;
    }

    if (String(current.nodeId) === String(nodeId) && current.kind === kind) {
      resetPortSelection();
      return;
    }

    if (current.kind === kind) {
      state.port = { nodeId: String(nodeId), kind };
      syncPortUi();
      const node = nodeById(nodeId);
      tip(kind === "out"
        ? `已改选：${label(node)}。现在点下级节点顶部圆点`
        : `已改选：${label(node)}。现在点上级节点底部圆点`);
      return;
    }

    const parentId = current.kind === "out" ? String(current.nodeId) : String(nodeId);
    const childId = current.kind === "in" ? String(current.nodeId) : String(nodeId);
    toggleConnection(parentId, childId);
  }

  window.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    const graph = stage.querySelector(".org-graph");

    const port = target.closest(".graph-port");
    if (graph && port && graph.contains(port)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      selectPort(String(port.dataset.portNodeId ?? ""), String(port.dataset.portKind ?? ""));
      return;
    }

    const collapse = target.closest(".node-collapse-action");
    if (graph && collapse && graph.contains(collapse)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      const id = String(collapse.closest(".node-card")?.dataset.nodeId ?? "");
      if (!id) return;
      state.collapsed.has(id) ? state.collapsed.delete(id) : state.collapsed.add(id);
      draw(graph);
      return;
    }

    if (target.closest("#collapse-all-button")) {
      event.preventDefault();
      event.stopImmediatePropagation();
      state.edges.forEach((edge) => state.collapsed.add(String(edge.parent_id)));
      if (graph) draw(graph);
      return;
    }

    if (target.closest("#expand-all-button")) {
      event.preventDefault();
      event.stopImmediatePropagation();
      state.collapsed.clear();
      if (graph) draw(graph);
      return;
    }

    const card = target.closest(".node-card");
    if (graph && card && graph.contains(card) && !target.closest("button")) {
      setTimeout(renderRelations, 0);
    }
  }, true);

  // Only direct stage child replacement means the main app rebuilt the tree.
  // Observing the whole subtree would retrigger on every SVG path or port redraw.
  new MutationObserver(scheduleEnhance).observe(stage, { childList: true });
  if (accountButton) {
    new MutationObserver(() => {
      if (!isEditing()) resetPortSelection();
      else syncPortUi();
      renderRelations();
    }).observe(accountButton, { attributes: true, childList: true, subtree: true });
  }
  addEventListener("resize", scheduleEnhance);
  searchInput?.addEventListener("input", () => setTimeout(scheduleEnhance, 0));

  (async () => {
    try {
      await loadData();
      await subscribe();
      removeLegacyConnectButton();
      scheduleEnhance();
    } catch (error) {
      console.error("Graph enhancement failed", error);
      toast("多重汇报关系加载失败，请刷新页面重试");
    }
  })();
}
