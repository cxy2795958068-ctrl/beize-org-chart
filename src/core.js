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
    { id: "demo-company", parent_id: null, type: "company", name: "东莞市北泽五金制品有限公司", title: "组织架构示例", sort_order: 0 },

    { id: "dept-gm", parent_id: "demo-company", type: "department", name: "总经办", title: "", sort_order: 10 },
    { id: "person-hlq", parent_id: "dept-gm", type: "person", name: "洪礼群", title: "总经理", notes: "公司经营管理", sort_order: 10 },
    { id: "person-hxh", parent_id: "dept-gm", type: "person", name: "洪晓辉", title: "总经理", notes: "公司经营管理", sort_order: 20 },

    { id: "dept-quality", parent_id: "demo-company", type: "department", name: "品质部", title: "", sort_order: 20 },
    { id: "person-qe", parent_id: "dept-quality", type: "person", name: "程兴宇", title: "QE / 品质负责人", notes: "品质体系、客诉、供应商质量、异常改善", sort_order: 10 },
    { id: "person-qa", parent_id: "dept-quality", type: "person", name: "蔡晓霞", title: "QA（规划）", notes: "后续岗位规划", sort_order: 20 },
    { id: "person-data", parent_id: "dept-quality", type: "person", name: "吴宝玉", title: "品质数据员", notes: "品质数据、资料与异常履历", sort_order: 30 },
    { id: "person-iqc1", parent_id: "dept-quality", type: "person", name: "王珍", title: "IQC", notes: "来料检验", sort_order: 40 },
    { id: "person-iqc2", parent_id: "dept-quality", type: "person", name: "何陈妹", title: "IQC", notes: "来料检验", sort_order: 50 },
    { id: "person-oqc1", parent_id: "dept-quality", type: "person", name: "杨巧", title: "OQC", notes: "出货检验", sort_order: 60 },
    { id: "person-oqc2", parent_id: "dept-quality", type: "person", name: "贺家佳", title: "OQC", notes: "出货检验", sort_order: 70 },
    { id: "person-ipqc", parent_id: "dept-quality", type: "person", name: "待招聘", title: "IPQC", notes: "制程巡检岗位规划", sort_order: 80 },
    { id: "person-lab", parent_id: "dept-quality", type: "person", name: "待招聘", title: "实验室测试员", notes: "后续实验室岗位规划", sort_order: 90 },

    { id: "dept-sales", parent_id: "demo-company", type: "department", name: "销售部", title: "", sort_order: 30 },
    { id: "dept-tech", parent_id: "demo-company", type: "department", name: "技术部", title: "", sort_order: 40 },
    { id: "dept-production", parent_id: "demo-company", type: "department", name: "生产部", title: "", sort_order: 50 },
    { id: "dept-warehouse", parent_id: "demo-company", type: "department", name: "仓储部", title: "", sort_order: 60 },
    { id: "dept-purchase", parent_id: "demo-company", type: "department", name: "采购部", title: "", sort_order: 70 },
    { id: "dept-finance", parent_id: "demo-company", type: "department", name: "财务部", title: "", sort_order: 80 },
  ].map((node) => normalizeNode({ ...node, version: 1, updated_at: now }));
}
