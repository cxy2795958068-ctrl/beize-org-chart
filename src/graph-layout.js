export function normalizeGraphEdges(nodes, edges = []) {
  const nodeMap = new Map(nodes.map((node) => [String(node.id), node]));
  const seen = new Set();
  const normalized = [];

  for (const raw of edges ?? []) {
    const parentId = String(raw?.parent_id ?? raw?.parentId ?? "").trim();
    const childId = String(raw?.child_id ?? raw?.childId ?? "").trim();
    if (!parentId || !childId || parentId === childId || !nodeMap.has(parentId) || !nodeMap.has(childId)) continue;
    const key = `${parentId}->${childId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push({
      id: String(raw?.id ?? key),
      organization_id: raw?.organization_id ?? raw?.organizationId ?? null,
      parent_id: parentId,
      child_id: childId,
      is_primary: Boolean(raw?.is_primary ?? raw?.isPrimary),
      sort_order: Number.isFinite(Number(raw?.sort_order ?? raw?.sortOrder)) ? Number(raw?.sort_order ?? raw?.sortOrder) : 0,
    });
  }

  // Keep legacy parent_id as a compatibility fallback. This also lets old
  // browser mocks and old snapshots render correctly before edge rows exist.
  for (const node of nodes) {
    const parentId = node?.parent_id == null || node?.parent_id === "" ? "" : String(node.parent_id);
    const childId = String(node.id);
    if (!parentId || !nodeMap.has(parentId)) continue;
    const key = `${parentId}->${childId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push({
      id: `legacy:${key}`,
      organization_id: node.organization_id ?? null,
      parent_id: parentId,
      child_id: childId,
      is_primary: true,
      sort_order: Number.isFinite(Number(node.sort_order)) ? Number(node.sort_order) : 0,
    });
  }

  return normalized;
}

export function wouldCreateCycle(edges, parentId, childId) {
  const parent = String(parentId);
  const child = String(childId);
  if (!parent || !child || parent === child) return true;
  const outgoing = new Map();
  for (const edge of edges ?? []) {
    const from = String(edge.parent_id);
    const to = String(edge.child_id);
    if (!outgoing.has(from)) outgoing.set(from, []);
    outgoing.get(from).push(to);
  }
  const stack = [child];
  const seen = new Set();
  while (stack.length) {
    const current = stack.pop();
    if (current === parent) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const next of outgoing.get(current) ?? []) stack.push(next);
  }
  return false;
}

function baseCompare(a, b) {
  const order = (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0);
  if (order) return order;
  return String(a.name ?? "").localeCompare(String(b.name ?? ""), "zh-CN");
}

function graphMaps(nodes, edges) {
  const ids = new Set(nodes.map((node) => String(node.id)));
  const incoming = new Map([...ids].map((id) => [id, []]));
  const outgoing = new Map([...ids].map((id) => [id, []]));
  for (const edge of edges) {
    const parentId = String(edge.parent_id);
    const childId = String(edge.child_id);
    if (!ids.has(parentId) || !ids.has(childId)) continue;
    outgoing.get(parentId).push(childId);
    incoming.get(childId).push(parentId);
  }
  return { incoming, outgoing };
}

export function computeGraphVisibility(nodes, edges, collapsedIds = new Set()) {
  const normalized = normalizeGraphEdges(nodes, edges);
  const { incoming, outgoing } = graphMaps(nodes, normalized);
  const nodeMap = new Map(nodes.map((node) => [String(node.id), node]));
  const indegree = new Map([...nodeMap.keys()].map((id) => [id, incoming.get(id).length]));
  const queue = [...nodeMap.values()].filter((node) => indegree.get(String(node.id)) === 0).sort(baseCompare).map((node) => String(node.id));
  const topo = [];
  while (queue.length) {
    const id = queue.shift();
    topo.push(id);
    for (const child of outgoing.get(id) ?? []) {
      indegree.set(child, indegree.get(child) - 1);
      if (indegree.get(child) === 0) queue.push(child);
    }
  }
  for (const id of nodeMap.keys()) if (!topo.includes(id)) topo.push(id);

  const visible = new Set();
  for (const id of topo) {
    const parents = incoming.get(id) ?? [];
    if (!parents.length) {
      visible.add(id);
      continue;
    }
    if (parents.some((parent) => visible.has(parent) && !collapsedIds.has(parent))) visible.add(id);
  }
  return visible;
}

function barycenter(ids, neighbors, ranks) {
  const values = ids.flatMap((id) => (neighbors.get(id) ?? []).map((neighbor) => ranks.get(neighbor)).filter(Number.isFinite));
  if (!values.length) return Number.POSITIVE_INFINITY;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function layoutDag(nodes, edges, options = {}) {
  const cardWidth = Number(options.cardWidth) || 380;
  const cardHeight = Number(options.cardHeight) || 240;
  const horizontalGap = Number(options.horizontalGap) || 72;
  const verticalGap = Number(options.verticalGap) || 118;
  const padding = Number(options.padding) || 56;
  const normalized = normalizeGraphEdges(nodes, edges);
  const nodeMap = new Map(nodes.map((node) => [String(node.id), node]));
  const { incoming, outgoing } = graphMaps(nodes, normalized);

  const indegree = new Map([...nodeMap.keys()].map((id) => [id, incoming.get(id).length]));
  const roots = [...nodeMap.values()].filter((node) => indegree.get(String(node.id)) === 0).sort(baseCompare);
  const queue = roots.map((node) => String(node.id));
  const topo = [];
  const level = new Map([...nodeMap.keys()].map((id) => [id, 0]));

  while (queue.length) {
    queue.sort((a, b) => baseCompare(nodeMap.get(a), nodeMap.get(b)));
    const id = queue.shift();
    topo.push(id);
    for (const child of outgoing.get(id) ?? []) {
      level.set(child, Math.max(level.get(child) ?? 0, (level.get(id) ?? 0) + 1));
      indegree.set(child, indegree.get(child) - 1);
      if (indegree.get(child) === 0) queue.push(child);
    }
  }

  // Backend prevents cycles, but keeping a deterministic fallback makes layout
  // robust against partially migrated local data.
  for (const id of nodeMap.keys()) {
    if (topo.includes(id)) continue;
    topo.push(id);
    const parentLevels = (incoming.get(id) ?? []).map((parent) => level.get(parent) ?? 0);
    level.set(id, parentLevels.length ? Math.max(...parentLevels) + 1 : 0);
  }

  const maxLevel = Math.max(0, ...level.values());
  const groups = Array.from({ length: maxLevel + 1 }, () => []);
  for (const id of topo) groups[level.get(id) ?? 0].push(nodeMap.get(id));
  for (const group of groups) group.sort(baseCompare);

  // Barycentric sweeps reduce crossings while keeping sort_order as the stable
  // tie-breaker. This is a compact Sugiyama-style ordering pass.
  for (let pass = 0; pass < 5; pass += 1) {
    let ranks = new Map();
    groups.forEach((group) => group.forEach((node, index) => ranks.set(String(node.id), index)));
    for (let i = 1; i < groups.length; i += 1) {
      groups[i].sort((a, b) => {
        const av = barycenter([String(a.id)], incoming, ranks);
        const bv = barycenter([String(b.id)], incoming, ranks);
        if (av !== bv) return av - bv;
        return baseCompare(a, b);
      });
    }
    ranks = new Map();
    groups.forEach((group) => group.forEach((node, index) => ranks.set(String(node.id), index)));
    for (let i = groups.length - 2; i >= 0; i -= 1) {
      groups[i].sort((a, b) => {
        const av = barycenter([String(a.id)], outgoing, ranks);
        const bv = barycenter([String(b.id)], outgoing, ranks);
        if (av !== bv) return av - bv;
        return baseCompare(a, b);
      });
    }
  }

  const widestCount = Math.max(1, ...groups.map((group) => group.length));
  const graphWidth = padding * 2 + widestCount * cardWidth + Math.max(0, widestCount - 1) * horizontalGap;
  const graphHeight = padding * 2 + groups.length * cardHeight + Math.max(0, groups.length - 1) * verticalGap;
  const positions = new Map();

  groups.forEach((group, row) => {
    const rowWidth = group.length * cardWidth + Math.max(0, group.length - 1) * horizontalGap;
    const startX = (graphWidth - rowWidth) / 2;
    group.forEach((node, index) => {
      positions.set(String(node.id), {
        x: startX + index * (cardWidth + horizontalGap),
        y: padding + row * (cardHeight + verticalGap),
        level: row,
        order: index,
      });
    });
  });

  return { positions, width: graphWidth, height: graphHeight, levels: groups, edges: normalized };
}
