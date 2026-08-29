import test from "node:test";
import assert from "node:assert/strict";
import { computeGraphSearch, computeGraphVisibility, getExclusiveDescendantIds, layoutDag, normalizeGraphEdges, wouldCreateCycle } from "../src/graph-layout.js";

const nodes = [
  { id: "company", parent_id: null, name: "公司", type: "company", sort_order: 0 },
  { id: "gm1", parent_id: "company", name: "总经理甲", type: "person", sort_order: 10 },
  { id: "gm2", parent_id: "company", name: "总经理乙", type: "person", sort_order: 20 },
  { id: "eng", parent_id: "gm1", name: "工程部", type: "department", sort_order: 10 },
  { id: "sales", parent_id: "gm1", name: "业务部", type: "department", sort_order: 20 },
];

const edges = normalizeGraphEdges(nodes, [
  { id: "e1", parent_id: "company", child_id: "gm1", is_primary: true },
  { id: "e2", parent_id: "company", child_id: "gm2", is_primary: true },
  { id: "e3", parent_id: "gm1", child_id: "eng", is_primary: true },
  { id: "e4", parent_id: "gm2", child_id: "eng", is_primary: false },
  { id: "e5", parent_id: "gm1", child_id: "sales", is_primary: true },
  { id: "e6", parent_id: "gm2", child_id: "sales", is_primary: false },
]);

test("multi-parent child is placed below both managers without overlap", () => {
  const layout = layoutDag(nodes, edges, { cardWidth: 380, cardHeight: 240, horizontalGap: 80, verticalGap: 120 });
  const gm1 = layout.positions.get("gm1");
  const gm2 = layout.positions.get("gm2");
  const eng = layout.positions.get("eng");
  const sales = layout.positions.get("sales");
  assert.equal(gm1.level, 1);
  assert.equal(gm2.level, 1);
  assert.equal(eng.level, 2);
  assert.equal(sales.level, 2);
  assert.ok(Math.abs(gm1.x - gm2.x) >= 380);
  assert.ok(Math.abs(eng.x - sales.x) >= 380);
  assert.equal(edges.filter((edge) => edge.child_id === "eng").length, 2);
});

test("collapsing one of two parents keeps shared child visible", () => {
  const oneCollapsed = computeGraphVisibility(nodes, edges, new Set(["gm1"]));
  assert.ok(oneCollapsed.has("eng"));
  assert.ok(oneCollapsed.has("sales"));
  const bothCollapsed = computeGraphVisibility(nodes, edges, new Set(["gm1", "gm2"]));
  assert.equal(bothCollapsed.has("eng"), false);
  assert.equal(bothCollapsed.has("sales"), false);
});

test("duplicate legacy parent relation is de-duplicated", () => {
  const normalized = normalizeGraphEdges(nodes, edges);
  const pairs = normalized.map((edge) => `${edge.parent_id}->${edge.child_id}`);
  assert.equal(new Set(pairs).size, pairs.length);
});

test("cycle detection blocks reverse connection and self loop", () => {
  assert.equal(wouldCreateCycle(edges, "eng", "company"), true);
  assert.equal(wouldCreateCycle(edges, "gm1", "gm1"), true);
  assert.equal(wouldCreateCycle(edges, "eng", "sales"), false);
});

test("search includes every upstream path for a multi-parent match", () => {
  const edges = normalizeGraphEdges(nodes, [
    { parent_id: "company", child_id: "gm1", is_primary: true },
    { parent_id: "company", child_id: "gm2", is_primary: true },
    { parent_id: "gm1", child_id: "eng", is_primary: true },
    { parent_id: "gm2", child_id: "eng", is_primary: false },
  ]);
  const result = computeGraphSearch(nodes, edges, "工程");
  assert.deepEqual([...result.matches], ["eng"]);
  assert.deepEqual([...result.visible].sort(), ["company", "eng", "gm1", "gm2"]);
});

test("deleting one manager preserves descendants shared with another manager", () => {
  const deleteNodes = nodes.map((node) => node.id === "sales" ? { ...node, parent_id: "eng" } : node);
  const edges = normalizeGraphEdges(deleteNodes, [
    { parent_id: "company", child_id: "gm1", is_primary: true },
    { parent_id: "company", child_id: "gm2", is_primary: true },
    { parent_id: "gm1", child_id: "eng", is_primary: true },
    { parent_id: "gm2", child_id: "eng", is_primary: false },
    { parent_id: "eng", child_id: "sales", is_primary: true },
  ]);
  assert.deepEqual([...getExclusiveDescendantIds(deleteNodes, edges, "gm1")], []);
  assert.deepEqual([...getExclusiveDescendantIds(deleteNodes, edges, "gm2")], []);
  assert.deepEqual([...getExclusiveDescendantIds(deleteNodes, edges, "eng")], ["sales"]);
});
