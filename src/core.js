export const NODE_TYPES = Object.freeze({
  company: "公司",
  department: "部门",
  person: "人员",
});

export function normalizeNode(raw) {
  const rawType = String(raw?.type ?? "department");
  const type = rawType === "position" ? "person" : (NODE_TYPES[rawType] ? rawType : "department");
  return {
    id: String(raw?.id ?? ""),
    organization_id: raw?.organization_id ?? null,
    parent_id: raw?.parent_id ? String(raw.parent_id) : null,
    type,
    name: String(raw?.name ?? "").trim(),
    title: String(raw?.title ?? raw?.position ?? "").trim(),
    notes: String(raw?.notes ?? raw?.note ?? "").trim(),
    sort_order: Number.isFinite(Number(raw?.sort_order)) ? Number(raw.sort_order) : 0,
    version: Number.isFinite(Number(raw?.version)) ? Number(raw.version) : 1,
    updated_at: raw?.updated_at ?? null,
    updated_by_label: raw?.updated_by_label ?? null,
    deleted_at: raw?.deleted_at ?? null,
    deleted_batch_id: raw?.deleted_batch_id ?? null,
    deleted_by_label: raw?.deleted_by_label ?? null,
  };
}

export function sortNodes(nodes) {
  return [...nodes].sort((a, b) => {
    const order = Number(a.sort_order ?? 0) - Number(b.sort_order ?? 0);
    if (order !== 0) return order;
    return String(a.name ?? "").localeCompare(String(b.name ?? ""), "zh-CN");
  });
}

export function buildForest(nodes) {
  const active = sortNodes(nodes.filter((node) => !node.deleted_at));
  const byId = new Map(active.map((node) => [node.id, { ...node, children: [] }]));
  const roots = [];
  for (const node of byId.values()) {
    if (node.parent_id && byId.has(node.parent_id) && node.parent_id !== node.id) byId.get(node.parent_id).children.push(node);
    else roots.push(node);
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
  for (const root of roots) if (visit(root)) safeRoots.push(root);
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

export function getSearchState(nodes, query) {
  const text = String(query ?? "").trim().toLocaleLowerCase("zh-CN");
  const active = nodes.filter((node) => !node.deleted_at);
  if (!text) return { visible: new Set(active.map((node) => node.id)), matches: [] };
  const byId = new Map(active.map((node) => [node.id, node]));
  const visible = new Set();
  const matches = [];
  for (const node of active) {
    const haystack = `${node.name} ${node.title} ${node.notes}`.toLocaleLowerCase("zh-CN");
    if (!haystack.includes(text)) continue;
    matches.push(node.id);
    visible.add(node.id);
    let parentId = node.parent_id;
    const seen = new Set();
    while (parentId && byId.has(parentId) && !seen.has(parentId)) {
      visible.add(parentId);
      seen.add(parentId);
      parentId = byId.get(parentId).parent_id;
    }
  }
  return { visible, matches };
}

export function validateNodeDraft(draft, nodes, nodeId = null) {
  const errors = [];
  const name = String(draft?.name ?? "").trim();
  if (!name) errors.push("名称不能为空");
  if (name.length > 80) errors.push("名称不能超过 80 个字符");
  if (!NODE_TYPES[draft?.type]) errors.push("节点类型无效");
  if (String(draft?.title ?? "").length > 120) errors.push("岗位不能超过 120 个字符");
  if (String(draft?.notes ?? "").length > 1000) errors.push("公开备注不能超过 1000 个字符");
  if (nodeId && wouldCreateCycle(nodes, nodeId, draft?.parent_id || null)) errors.push("不能把节点移动到自己的下级节点中");
  return errors;
}

export function countByType(nodes) {
  const counts = { company: 0, department: 0, person: 0 };
  for (const node of nodes) if (!node.deleted_at && counts[node.type] !== undefined) counts[node.type] += 1;
  return counts;
}

export function structureFingerprint(nodes) {
  const active = nodes.filter((node) => !node.deleted_at);
  const byId = new Map(active.map((node) => [String(node.id), node]));
  const children = new Map();
  for (const node of active) {
    const parent = node.parent_id && byId.has(String(node.parent_id)) ? String(node.parent_id) : "__root__";
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(node);
  }
  const serialize = (node) => {
    const kids = sortNodes(children.get(String(node.id)) ?? []).map(serialize);
    return [node.type, String(node.name ?? "").trim(), String(node.title ?? "").trim(), String(node.notes ?? "").trim(), kids];
  };
  return JSON.stringify(sortNodes(children.get("__root__") ?? []).map(serialize));
}
