import { test, expect } from "@playwright/test";

const ORG = "3edb17e6-236c-4d34-9e36-268051ca96c3";
const COMPANY = "10000000-0000-4000-8000-000000000001";
const GM1 = "10000000-0000-4000-8000-000000000002";
const GM2 = "10000000-0000-4000-8000-000000000003";
const ENG = "10000000-0000-4000-8000-000000000004";
const SALES = "10000000-0000-4000-8000-000000000005";

const nodes = [
  { id: COMPANY, organization_id: ORG, parent_id: null, type: "company", name: "北泽五金", title: "", notes: "", sort_order: 0, version: 1, updated_at: "2026-08-29T00:00:00Z", updated_by_label: "系统", deleted_at: null, deleted_batch_id: null, deleted_by_label: null },
  { id: GM1, organization_id: ORG, parent_id: COMPANY, type: "person", name: "洪礼群", title: "总经理", notes: "", sort_order: 10, version: 1, updated_at: "2026-08-29T00:00:00Z", updated_by_label: "系统", deleted_at: null, deleted_batch_id: null, deleted_by_label: null },
  { id: GM2, organization_id: ORG, parent_id: COMPANY, type: "person", name: "洪晓辉", title: "总经理", notes: "", sort_order: 20, version: 1, updated_at: "2026-08-29T00:00:00Z", updated_by_label: "系统", deleted_at: null, deleted_batch_id: null, deleted_by_label: null },
  { id: ENG, organization_id: ORG, parent_id: GM1, type: "department", name: "工程部", title: "", notes: "", sort_order: 10, version: 1, updated_at: "2026-08-29T00:00:00Z", updated_by_label: "系统", deleted_at: null, deleted_batch_id: null, deleted_by_label: null },
  { id: SALES, organization_id: ORG, parent_id: GM1, type: "department", name: "业务部", title: "", notes: "", sort_order: 20, version: 1, updated_at: "2026-08-29T00:00:00Z", updated_by_label: "系统", deleted_at: null, deleted_batch_id: null, deleted_by_label: null },
];

async function mock(page) {
  let edges = [
    { id: "20000000-0000-4000-8000-000000000001", organization_id: ORG, parent_id: COMPANY, child_id: GM1, is_primary: true, sort_order: 10 },
    { id: "20000000-0000-4000-8000-000000000002", organization_id: ORG, parent_id: COMPANY, child_id: GM2, is_primary: true, sort_order: 20 },
    { id: "20000000-0000-4000-8000-000000000003", organization_id: ORG, parent_id: GM1, child_id: ENG, is_primary: true, sort_order: 10 },
    { id: "20000000-0000-4000-8000-000000000004", organization_id: ORG, parent_id: GM2, child_id: ENG, is_primary: false, sort_order: 10 },
    { id: "20000000-0000-4000-8000-000000000005", organization_id: ORG, parent_id: GM1, child_id: SALES, is_primary: true, sort_order: 20 },
  ];

  await page.route("**/*.supabase.co/rest/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();
    const json = (body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

    if (path.endsWith("/organizations")) return json([{ id: ORG, name: "东莞市北泽五金制品有限公司", is_public: true }]);
    if (path.endsWith("/org_nodes") && method === "GET") return json(nodes);
    if (path.endsWith("/org_edges") && method === "GET") return json(edges);
    if (path.endsWith("/rpc/begin_public_edit_session")) return json({ ok: true, token: "graph-test-token", editor_name: "测试员", expires_at: "2099-01-01T00:00:00Z" });
    if (path.endsWith("/rpc/verify_public_edit_session")) return json({ ok: true, editor_name: "测试员", expires_at: "2099-01-01T00:00:00Z" });

    if (path.endsWith("/rpc/create_org_edge")) {
      const body = route.request().postDataJSON();
      const duplicate = edges.some((edge) => edge.parent_id === body.p_parent_id && edge.child_id === body.p_child_id);
      if (duplicate) return json({ message: "Connection already exists" }, 409);
      const edge = {
        id: `30000000-0000-4000-8000-${String(edges.length + 1).padStart(12, "0")}`,
        organization_id: ORG,
        parent_id: body.p_parent_id,
        child_id: body.p_child_id,
        is_primary: false,
        sort_order: 30,
      };
      edges = [...edges, edge];
      return json(edge);
    }

    if (path.endsWith("/rpc/delete_org_edge")) {
      const body = route.request().postDataJSON();
      edges = edges.filter((edge) => edge.id !== body.p_edge_id);
      return json(null);
    }

    if (path.includes("/rpc/")) return json(null);
    return json([]);
  });
}

async function boot(page, viewport = { width: 1440, height: 900 }) {
  await page.setViewportSize(viewport);
  await mock(page);
  await page.goto("/");
  await expect(page.locator(".node-card")).toHaveCount(5);
  await expect(page.locator(".org-graph")).toBeVisible();
  await expect(page.locator(".graph-edge")).toHaveCount(5);
}

async function unlock(page) {
  await page.click("#account-button");
  await page.fill('#modal-content input[autocomplete="name"]', "测试员");
  await page.fill('#modal-content input[type="password"]', "12346");
  await page.getByRole("button", { name: "解锁编辑" }).click();
  await expect(page.locator("#account-button")).toHaveText("编辑中");
  await expect(page.locator(".org-graph")).toHaveClass(/graph-port-editing/);
}

const outPort = (page, id) => page.locator(`[data-node-id="${id}"] > .graph-port-out`);
const inPort = (page, id) => page.locator(`[data-node-id="${id}"] > .graph-port-in`);

test("two managers can jointly manage the same department and layout stays layered", async ({ page }) => {
  await boot(page);
  const positions = await page.evaluate(({ GM1, GM2, ENG }) => {
    const box = (id) => {
      const el = document.querySelector(`[data-node-id="${id}"]`);
      return { left: parseFloat(el.style.left), top: parseFloat(el.style.top), width: el.offsetWidth };
    };
    return { gm1: box(GM1), gm2: box(GM2), eng: box(ENG) };
  }, { GM1, GM2, ENG });
  expect(positions.gm1.top).toBe(positions.gm2.top);
  expect(positions.eng.top).toBeGreaterThan(positions.gm1.top);
  expect(Math.abs(positions.gm1.left - positions.gm2.left)).toBeGreaterThanOrEqual(positions.gm1.width);

  const primary = page.locator(`.graph-edge[data-edge-id="20000000-0000-4000-8000-000000000003"]`);
  const secondary = page.locator(`.graph-edge[data-edge-id="20000000-0000-4000-8000-000000000004"]`);
  await expect(primary).toHaveCount(1);
  await expect(secondary).toHaveCount(1);
  expect(await primary.getAttribute("d")).toMatch(/^M /);
  expect(await secondary.getAttribute("d")).toMatch(/^M /);
  const stroke = await secondary.evaluate((element) => ({ width: getComputedStyle(element).strokeWidth, stroke: getComputedStyle(element).stroke }));
  expect(parseFloat(stroke.width)).toBeGreaterThanOrEqual(3);
  expect(stroke.stroke).not.toBe("none");
});

test("editor connects two cards by clicking their connection points and relations update automatically", async ({ page }) => {
  await boot(page);
  await unlock(page);
  await expect(page.locator("#graph-connect-button")).toHaveCount(0);

  await outPort(page, GM2).click();
  await expect(outPort(page, GM2)).toHaveClass(/selected/);
  await expect(page.locator("#graph-connect-tip")).toContainText("再点目标节点顶部圆点");
  await inPort(page, SALES).click();

  await expect(page.locator(".graph-edge")).toHaveCount(6);
  await expect(page.locator("#graph-connect-tip")).toHaveCount(0);
  await expect(page.locator("#toast-region")).toContainText("已连接");

  await page.locator(`[data-node-id="${SALES}"]`).click();
  await expect(page.locator("#graph-relations")).toContainText("上级连接 · 2");
  await expect(page.locator("#graph-relations")).toContainText("洪晓辉");
});

test("clicking the same connected pair toggles the connection off", async ({ page }) => {
  await boot(page);
  await unlock(page);

  await outPort(page, GM2).click();
  await inPort(page, ENG).click();

  await expect(page.locator(".graph-edge")).toHaveCount(4);
  await expect(page.locator("#toast-region")).toContainText("已断开");
});

test("true graph cycles are blocked when two ports are clicked", async ({ page }) => {
  await boot(page);
  await unlock(page);

  await outPort(page, ENG).click();
  await inPort(page, GM1).click();

  await expect(page.locator("#toast-region")).toContainText("循环关系");
  await expect(page.locator(".graph-edge")).toHaveCount(5);
});

test("mobile view exposes touch-sized direct connection points", async ({ page }) => {
  await boot(page, { width: 390, height: 844 });
  await unlock(page);

  const port = outPort(page, GM2);
  await expect(port).toBeVisible();
  const box = await port.boundingBox();
  expect(box.height).toBeGreaterThanOrEqual(36);
  expect(box.width).toBeGreaterThanOrEqual(36);

  await port.click();
  await expect(page.locator("#graph-connect-tip")).toContainText("顶部圆点");
  await expect(inPort(page, SALES)).toHaveClass(/compatible/);
});
