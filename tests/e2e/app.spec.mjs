import { test, expect } from "playwright/test";

const ORG_ID = "3edb17e6-236c-4d34-9e36-268051ca96c3";
const ROOT_ID = "11111111-1111-4111-8111-111111111111";
const DEPT_ID = "22222222-2222-4222-8222-222222222222";
const PERSON_ID = "33333333-3333-4333-8333-333333333333";

const baseNodes = [
  { id: ROOT_ID, organization_id: ORG_ID, parent_id: null, type: "company", name: "北泽五金", title: "", notes: "", sort_order: 0, version: 1, updated_at: "2026-08-29T00:00:00Z", updated_by_label: "系统", deleted_at: null, deleted_batch_id: null, deleted_by_label: null },
  { id: DEPT_ID, organization_id: ORG_ID, parent_id: ROOT_ID, type: "department", name: "品质部", title: "", notes: "", sort_order: 10, version: 1, updated_at: "2026-08-29T00:00:00Z", updated_by_label: "程兴宇", deleted_at: null, deleted_batch_id: null, deleted_by_label: null },
  { id: PERSON_ID, organization_id: ORG_ID, parent_id: DEPT_ID, type: "person", name: "张三", title: "QE", notes: "公开职责", sort_order: 10, version: 1, updated_at: "2026-08-29T00:00:00Z", updated_by_label: "程兴宇", deleted_at: null, deleted_batch_id: null, deleted_by_label: null },
];

function cloudify(nodes) {
  const idMap = new Map(nodes.map((node, index) => [String(node.id), `aaaaaaaa-aaaa-4aaa-8aaa-${String(index + 1).padStart(12, "0")}`]));
  return nodes.map((node, index) => ({
    id: idMap.get(String(node.id)),
    organization_id: ORG_ID,
    parent_id: node.parent_id ? idMap.get(String(node.parent_id)) : null,
    type: node.type,
    name: node.name,
    title: node.title ?? "",
    notes: node.notes ?? "",
    sort_order: node.sort_order ?? (index + 1) * 10,
    version: 1,
    updated_at: "2026-08-29T00:00:00Z",
    updated_by_label: "测试员",
    deleted_at: null,
    deleted_batch_id: null,
    deleted_by_label: null,
  }));
}

async function mockSupabase(page) {
  let serverNodes = structuredClone(baseNodes);
  const serverEdges = () => serverNodes
    .filter((node) => node.parent_id)
    .map((node, index) => ({
      id: `eeeeeeee-eeee-4eee-8eee-${String(index + 1).padStart(12, "0")}`,
      organization_id: ORG_ID,
      parent_id: node.parent_id,
      child_id: node.id,
      is_primary: true,
      sort_order: node.sort_order,
    }));
  await page.route("**/*.supabase.co/rest/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();
    const json = (body, status = 200) => route.fulfill({ status, contentType: "application/json", headers: { "content-range": `0-${Math.max(0, serverNodes.length - 1)}/${serverNodes.length}` }, body: JSON.stringify(body) });

    if (path.endsWith("/organizations")) return json([{ id: ORG_ID, name: "东莞市北泽五金制品有限公司", is_public: true }]);
    if (path.endsWith("/org_nodes") && method === "GET") return json(serverNodes);
    if (path.endsWith("/org_edges") && method === "GET") return json(serverEdges());
    if (path.endsWith("/rpc/begin_public_edit_session")) return json({ ok: true, token: "test-edit-token", editor_name: "测试员", expires_at: "2099-01-01T00:00:00Z" });
    if (path.endsWith("/rpc/verify_public_edit_session")) return json({ ok: true, editor_name: "测试员", expires_at: "2099-01-01T00:00:00Z" });
    if (path.endsWith("/rpc/end_public_edit_session")) return json(null);
    if (path.endsWith("/rpc/list_org_snapshots")) return json([{ id: "44444444-4444-4444-8444-444444444444", created_at: "2026-08-29T00:00:00Z", actor_label: "测试员", action_label: "测试快照", node_count: serverNodes.length }]);
    if (path.endsWith("/rpc/import_public_org_nodes")) {
      const body = route.request().postDataJSON();
      serverNodes = cloudify(body.p_nodes ?? []);
      return json({ ok: true, imported_count: serverNodes.length, backup_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" });
    }
    if (path.endsWith("/rpc/update_org_node")) return json({ ...serverNodes.find((node) => node.type === "person"), name: "张三", title: "QE" });
    if (path.endsWith("/rpc/create_org_node")) return json({ ...serverNodes.find((node) => node.type === "person"), id: "55555555-5555-4555-8555-555555555555", name: "李四" });
    if (path.includes("/rpc/")) return json(null);
    return json([]);
  });
}

async function boot(page, viewport) {
  await page.setViewportSize(viewport);
  await mockSupabase(page);
  await page.goto("/");
  await expect(page.locator(".node-card")).toHaveCount(3);
  await expect(page.locator("#sync-status")).toContainText("云端只读");
  await page.waitForFunction(() => Boolean(window.BeizeCanvas));
  if (viewport.width <= 700) await page.waitForFunction(() => document.querySelector("#tree-stage")?.dataset.initialFit === "done");
}

test("desktop viewer supports search, collapse, fit and root focus", async ({ page }) => {
  await boot(page, { width: 1440, height: 900 });
  await page.waitForFunction(() => document.querySelector("#zoom-value")?.textContent === "58%");
  const initiallyVisible = await page.evaluate(() => {
    const scroller = document.querySelector("#tree-scroller").getBoundingClientRect();
    const root = document.querySelector(".type-company").getBoundingClientRect();
    return root.top < scroller.bottom && root.bottom > scroller.top && root.left < scroller.right && root.right > scroller.left;
  });
  expect(initiallyVisible).toBeTruthy();
  await page.fill("#search-input", "张三");
  await expect(page.locator(".node-card.search-match .node-name")).toHaveText("张三");
  await page.fill("#search-input", "");
  await page.click("#collapse-all-button");
  await expect(page.locator(`[data-node-id="${PERSON_ID}"]`)).toBeHidden();
  await page.click("#expand-all-button");
  await expect(page.locator(`[data-node-id="${PERSON_ID}"]`)).toBeVisible();
  await page.click("#fit-button");
  const fitted = await page.evaluate(() => window.BeizeCanvas.getView());
  expect(fitted.zoom).toBeGreaterThan(0);
  await page.click("#root-button");
  const focused = await page.evaluate(() => window.BeizeCanvas.getView());
  expect(Number.isFinite(focused.x)).toBeTruthy();
});

for (const viewport of [
  { width: 390, height: 844 },
  { width: 430, height: 932 },
  { width: 997, height: 768 },
  { width: 1366, height: 768 },
  { width: 1510, height: 900 },
  { width: 1920, height: 1080 },
]) {
  test(`responsive shell stays contained and starts on the root at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await boot(page, viewport);
    if (viewport.width > 700) await page.waitForFunction(() => document.querySelector("#zoom-value")?.textContent === "58%");
    const result = await page.evaluate(() => {
      const root = document.querySelector(".type-company").getBoundingClientRect();
      const scroller = document.querySelector("#tree-scroller").getBoundingClientRect();
      const toolbar = document.querySelector(".canvas-toolbar").getBoundingClientRect();
      return {
        bodyWidth: document.body.scrollWidth,
        bodyHeight: document.body.scrollHeight,
        viewportWidth: innerWidth,
        viewportHeight: innerHeight,
        rootVisible: root.top < scroller.bottom && root.bottom > scroller.top && root.left < scroller.right && root.right > scroller.left,
        toolbarContained: toolbar.left >= 0 && toolbar.right <= innerWidth && toolbar.top >= 0 && toolbar.bottom <= innerHeight,
      };
    });
    expect(result.bodyWidth).toBe(result.viewportWidth);
    expect(result.bodyHeight).toBe(result.viewportHeight);
    expect(result.rootVisible).toBeTruthy();
    expect(result.toolbarContained).toBeTruthy();
  });
}

test("mobile touch drag and pinch are responsive and a real touch tap opens the bottom drawer", async ({ page }) => {
  await boot(page, { width: 390, height: 844 });
  const before = await page.evaluate(() => window.BeizeCanvas.getView());
  await page.dispatchEvent("#tree-scroller", "pointerdown", { pointerId: 1, pointerType: "touch", button: 0, clientX: 160, clientY: 430 });
  await page.dispatchEvent("#tree-scroller", "pointermove", { pointerId: 1, pointerType: "touch", button: 0, clientX: 260, clientY: 520 });
  await page.dispatchEvent("#tree-scroller", "pointerup", { pointerId: 1, pointerType: "touch", button: 0, clientX: 260, clientY: 520 });
  const afterDrag = await page.evaluate(() => window.BeizeCanvas.getView());
  const dragX = Math.abs(afterDrag.x - before.x);
  const dragY = Math.abs(afterDrag.y - before.y);
  expect(dragX).toBeGreaterThan(70);
  expect(dragY).toBeGreaterThan(60);
  expect(Math.hypot(dragX, dragY)).toBeGreaterThan(110);

  const zoomBefore = afterDrag.zoom;
  await page.dispatchEvent("#tree-scroller", "pointerdown", { pointerId: 11, pointerType: "touch", button: 0, clientX: 120, clientY: 420 });
  await page.dispatchEvent("#tree-scroller", "pointerdown", { pointerId: 12, pointerType: "touch", button: 0, clientX: 260, clientY: 420 });
  await page.dispatchEvent("#tree-scroller", "pointermove", { pointerId: 11, pointerType: "touch", button: 0, clientX: 80, clientY: 420 });
  await page.dispatchEvent("#tree-scroller", "pointermove", { pointerId: 12, pointerType: "touch", button: 0, clientX: 300, clientY: 420 });
  await page.dispatchEvent("#tree-scroller", "pointerup", { pointerId: 11, pointerType: "touch", button: 0, clientX: 80, clientY: 420 });
  await page.dispatchEvent("#tree-scroller", "pointerup", { pointerId: 12, pointerType: "touch", button: 0, clientX: 300, clientY: 420 });
  const afterPinch = await page.evaluate(() => window.BeizeCanvas.getView());
  expect(afterPinch.zoom).toBeGreaterThan(zoomBefore);

  const card = page.locator(`[data-node-id="${PERSON_ID}"]`);
  const box = await card.boundingBox();
  expect(box).not.toBeNull();
  const tapX = box.x + box.width / 2;
  const tapY = box.y + box.height / 2;
  await page.dispatchEvent(`[data-node-id="${PERSON_ID}"]`, "pointerdown", { pointerId: 21, pointerType: "touch", button: 0, clientX: tapX, clientY: tapY });
  await page.dispatchEvent(`[data-node-id="${PERSON_ID}"]`, "pointerup", { pointerId: 21, pointerType: "touch", button: 0, clientX: tapX, clientY: tapY });
  await expect(page.locator("#inspector")).toHaveClass(/open/);
  await expect(page.locator("#inspector-title")).toContainText("人员");
});

test("editor unlock uses a short token and never stores the password", async ({ page }) => {
  await boot(page, { width: 390, height: 844 });
  await page.click("#account-button");
  await page.fill('#modal-content input[autocomplete="name"]', "测试员");
  await page.fill('#modal-content input[type="password"]', "12346");
  await page.getByRole("button", { name: "解锁编辑" }).click();
  await expect(page.locator("#account-button")).toHaveText("编辑中");
  const storage = await page.evaluate(() => Object.values(sessionStorage));
  expect(storage.join(" ")).not.toContain("12346");
  expect(storage.join(" ")).toContain("test-edit-token");
  await expect(page.locator("#history-button")).toBeEnabled();
});

test("legacy browser draft is detected, migrated, reloaded and structurally verified", async ({ page }) => {
  const legacy = [
    { id: "old-root", parent_id: null, type: "company", name: "北泽五金", sort_order: 0 },
    { id: "old-gm", parent_id: "old-root", type: "person", name: "洪晓辉", title: "总经理", sort_order: 10 },
    { id: "old-quality", parent_id: "old-gm", type: "department", name: "品质中心", sort_order: 10 },
    { id: "old-qe", parent_id: "old-quality", type: "person", name: "测试旧架构人员", title: "QE", notes: "旧架构备注", sort_order: 10 },
  ];
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript((draft) => localStorage.setItem("beize-org-chart-draft-v1", JSON.stringify(draft)), legacy);
  await mockSupabase(page);
  await page.goto("/");
  await expect(page.locator(".node-card")).toHaveCount(3);
  await expect(page.getByRole("button", { name: "迁移本机旧架构" })).toBeVisible();

  await page.getByRole("button", { name: "迁移本机旧架构" }).click();
  await page.fill('#modal-content input[autocomplete="name"]', "测试员");
  await page.fill('#modal-content input[type="password"]', "12346");
  await page.getByRole("button", { name: "解锁编辑" }).click();
  await expect(page.locator("#modal-title")).toHaveText("迁移本机旧架构");
  await page.locator(".migration-confirm input").check();
  await page.getByRole("button", { name: "确认迁移" }).click();

  await expect(page.getByText("测试旧架构人员", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "迁移本机旧架构" })).toHaveCount(0);
  const completion = await page.evaluate(() => localStorage.getItem("beize-org-chart:local-import-completed:v2"));
  expect(completion).toContain("beize-org-chart-draft-v1");
});
