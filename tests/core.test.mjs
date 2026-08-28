import test from "node:test";
import assert from "node:assert/strict";
import {
  buildForest,
  getDescendantIds,
  getVisibleIds,
  normalizeNode,
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

test("search preserves ancestors for tree context", () => {
  assert.deepEqual([...getVisibleIds(nodes, "张三")].sort(), ["a", "p", "root"]);
});

test("node validation catches blank names and illegal moves", () => {
  const errors = validateNodeDraft({ name: " ", type: "department", parent_id: "p" }, nodes, "a");
  assert.ok(errors.includes("名称不能为空"));
  assert.ok(errors.includes("不能把节点移动到自己的下级节点中"));
});

test("broken cycles are surfaced as roots instead of recursing forever", () => {
  const cyclic = [
    normalizeNode({ id: "x", parent_id: "y", name: "X" }),
    normalizeNode({ id: "y", parent_id: "x", name: "Y" }),
  ];
  const forest = buildForest(cyclic);
  assert.ok(forest.length >= 1);
});

