export const NODE_TYPES = Object.freeze({
  company: "公司",
  department: "部门",
  position: "岗位",
  person: "人员",
});

export function normalizeNode(raw) {
  return {
    id: String(raw.id),
    organization_id: raw.organization_id ?? null,
    parent_id: raw.parent_id ? String(raw.parent_id) : null,
    type: NODE_TYPES[raw.type] ? raw.type : "department",
    name: String(raw.name ?? "").trim(),
    title: String(raw.title ?? "").trim(),
    notes: String(raw.notes ?? "").trim(),
    sort_order: Number.isFinite(Number(raw.sort_order)) ? Number(raw.sort_order) : 0,
    version: Number.isFinite(Number(raw.version)) ? Number(raw.version) : 1,
    updated_at: raw.updated_at ?? null,
    updated_by: raw.updated_by ?? null,
    deleted_at: raw.deleted_at ?? null,
    deleted_batch_id: raw.deleted_batch_id ?? null,
  };
}

export function sortNodes(nodes) {
  return [...nodes].sort((a, b) => {
    const order = a.sort_order - b.sort_order;
    if (order !== 0) return order;
    return a.name.localeCompare(b.name, "zh-CN");
  });
}

export function buildForest(nodes) {
  const active = sortNodes(nodes.filter((node) => !node.deleted_at));
  const byId = new Map(active.map((node) => [node.id, { ...node, children: [] }]));
  const roots = [];

  for (const node of byId.values()) {
    if (node.parent_id && byId.has(node.parent_id) && node.parent_id !== node.id) {
      byId.get(node.parent_id).children.push(node);
    } else {
      roots.push(node);
    }
  }

  const visiting = new Set();
  const visited = new Set();
  const safeRoots = [];

  function visit(node) {
    if (visiting.has(node.id)) return false;
    if (visited.has(node.id)) return true;
    visiting.add(node.id);
    node.children = sortNodes(node.children).filter(visit);
    visiting.delete(node.id);
    visited.add(node.id);
    return true;
  }

  for (const root of roots) {
    if (visit(root)) safeRoots.push(root);
  }
  for (const node of byId.values()) {
    if (!visited.has(node.id)) {
      node.parent_id = null;
      if (visit(node)) safeRoots.push(node);
    }
  }

  return sortNodes(safeRoots);
}

export function getDescendantIds(nodes, rootId) {
  const children = new Map();
  for (const node of nodes) {
    if (!node.parent_id) continue;
    if (!children.has(node.parent_id)) children.set(node.parent_id, []);
    children.get(node.parent_id).push(node.id);
  }

  const result = new Set();
  const stack = [...(children.get(rootId) ?? [])];
  while (stack.length) {
    const id = stack.pop();
    if (result.has(id)) continue;
    result.add(id);
    stack.push(...(children.get(id) ?? []));
  }
  return result;
}

export function wouldCreateCycle(nodes, nodeId, nextParentId) {
  if (!nextParentId) return false;
  if (nodeId === nextParentId) return true;
  return getDescendantIds(nodes, nodeId).has(nextParentId);
}

export function getVisibleIds(nodes, query) {
  const text = String(query ?? "").trim().toLocaleLowerCase("zh-CN");
  if (!text) return new Set(nodes.filter((node) => !node.deleted_at).map((node) => node.id));

  const byId = new Map(nodes.map((node) => [node.id, node]));
  const visible = new Set();
  for (const node of nodes) {
    if (node.deleted_at) continue;
    const haystack = `${node.name} ${node.title} ${node.notes}`.toLocaleLowerCase("zh-CN");
    if (!haystack.includes(text)) continue;
    visible.add(node.id);
    let parentId = node.parent_id;
    const seen = new Set();
    while (parentId && byId.has(parentId) && !seen.has(parentId)) {
      visible.add(parentId);
      seen.add(parentId);
      parentId = byId.get(parentId).parent_id;
    }
  }
  return visible;
}

export function validateNodeDraft(draft, nodes, nodeId = null) {
  const errors = [];
  const name = String(draft.name ?? "").trim();
  if (!name) errors.push("名称不能为空");
  if (name.length > 80) errors.push("名称不能超过 80 个字符");
  if (!NODE_TYPES[draft.type]) errors.push("节点类型无效");
  if (String(draft.title ?? "").length > 120) errors.push("岗位或副标题不能超过 120 个字符");
  if (String(draft.notes ?? "").length > 1000) errors.push("备注不能超过 1000 个字符");
  if (nodeId && wouldCreateCycle(nodes, nodeId, draft.parent_id || null)) errors.push("不能把节点移动到自己的下级节点中");
  return errors;
}

export function countByType(nodes) {
  const counts = { company: 0, department: 0, position: 0, person: 0 };
  for (const node of nodes) {
    if (!node.deleted_at && counts[node.type] !== undefined) counts[node.type] += 1;
  }
  return counts;
}

export function makeDemoNodes() {
  const now = new Date().toISOString();
  return [
    { id: "demo-company", parent_id: null, type: "company", name: "北泽公司", title: "组织中心", sort_order: 0 },
    { id: "demo-ops", parent_id: "demo-company", type: "department", name: "运营管理部", title: "经营协同", sort_order: 10 },
    { id: "demo-market", parent_id: "demo-company", type: "department", name: "市场发展部", title: "品牌与增长", sort_order: 20 },
    { id: "demo-finance", parent_id: "demo-company", type: "department", name: "财务部", title: "财务与风控", sort_order: 30 },
    { id: "demo-gm", parent_id: "demo-ops", type: "position", name: "运营负责人", title: "负责人", sort_order: 10 },
    { id: "demo-person", parent_id: "demo-gm", type: "person", name: "待填写", title: "运营负责人", sort_order: 10 },
  ].map((node) => normalizeNode({ ...node, version: 1, updated_at: now }));
}

