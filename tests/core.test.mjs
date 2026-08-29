import test from "node:test";
import assert from "node:assert/strict";
import {
  buildForest,
  countByType,
  getDescendantIds,
  getSearchState,
  normalizeNode,
  structureFingerprint,
  validateNodeDraft,
  wouldCreateCycle,
} from "../src/core.js";

const nodes = [
  normalizeNode({ id: "root", type: "company", name: "北泽", sort_order: 0 }),
  normalizeNode({ id: "b", parent_id: "root", type: "department", name: "财务部", sort_order: 20 }),
  normalizeNode({ id: "a", parent_id: "root", type: "department", name: "运营部", sort_order: 10 }),
  normalizeNode({ id: "p", parent_id: "a", type: "person", name: "张三", title: "主管", sort_order: 0 }),
];

test("buildForest creates a sorted tree", () => {
  const forest = buildForest(nodes);
  assert.equal(forest.length, 1);
  assert.deepEqual(forest[0].children.map((node) => node.id), ["a", "b"]);
  assert.equal(forest[0].children[0].children[0].id, "p");
});

test("cycle detection rejects self and descendants", () => {
  assert.equal(wouldCreateCycle(nodes, "a", "p"), true);
  assert.equal(wouldCreateCycle(nodes, "a", "a"), true);
  assert.equal(wouldCreateCycle(nodes, "a", "b"), false);
});

test("descendant lookup is complete", () => {
  assert.deepEqual([...getDescendantIds(nodes, "root")].sort(), ["a", "b", "p"]);
});

test("search preserves ancestors and returns direct matches", () => {
  const result = getSearchState(nodes, "张三");
  assert.deepEqual([...result.visible].sort(), ["a", "p", "root"]);
  assert.deepEqual(result.matches, ["p"]);
});

test("node validation catches blank names and illegal moves", () => {
  const errors = validateNodeDraft({ name: " ", type: "department", parent_id: "p" }, nodes, "a");
  assert.ok(errors.includes("名称不能为空"));
  assert.ok(errors.includes("不能把节点移动到自己的下级节点中"));
});

test("legacy position nodes normalize to people", () => {
  const node = normalizeNode({ id: "legacy", type: "position", name: "QE", position: "工程师" });
  assert.equal(node.type, "person");
  assert.equal(node.title, "工程师");
});

test("type counts ignore deleted nodes", () => {
  const counts = countByType([...nodes, normalizeNode({ id: "gone", type: "person", name: "删除", deleted_at: new Date().toISOString() })]);
  assert.deepEqual(counts, { company: 1, department: 2, person: 1 });
});

test("structure fingerprint is id-independent and hierarchy-sensitive", () => {
  const renamedIds = nodes.map((node, index) => ({ ...node, id: `n${index}`, parent_id: node.parent_id === "root" ? "n0" : node.parent_id === "a" ? "n2" : null }));
  assert.equal(structureFingerprint(nodes), structureFingerprint(renamedIds));
  const changed = nodes.map((node) => node.id === "p" ? { ...node, title: "经理" } : node);
  assert.notEqual(structureFingerprint(nodes), structureFingerprint(changed));
});

test("broken cycles are surfaced as roots instead of recursing forever", () => {
  const cyclic = [
    normalizeNode({ id: "x", parent_id: "y", name: "X" }),
    normalizeNode({ id: "y", parent_id: "x", name: "Y" }),
  ];
  const forest = buildForest(cyclic);
  assert.ok(forest.length >= 1);
});
