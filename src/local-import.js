import { createClient } from "@supabase/supabase-js";

const CONFIG = Object.freeze({
  supabaseUrl: String(window.__BEIZE_CONFIG__?.SUPABASE_URL ?? "").trim(),
  supabaseAnonKey: String(window.__BEIZE_CONFIG__?.SUPABASE_ANON_KEY ?? "").trim(),
});

const COMPLETED_KEY = "beize-org-chart:local-import-completed:v1";
const EDIT_SESSION_KEY = "beize-org-chart:edit-session:v1";
const VALID_TYPES = new Set(["company", "department", "position", "person"]);
const EXCLUDED_KEY_PARTS = ["pending", "selected-org", "seed-version", "import-completed", "edit-session"];
const SYSTEM_SAMPLE_NAMES = new Set([
  "北泽五金", "总经办", "洪礼群", "洪晓辉", "销售部", "技术部", "生产部", "仓储部", "采购部", "财务部",
  "品质部", "程兴宇", "蔡晓霞", "吴宝玉", "王珍", "何陈妹", "杨巧", "贺家佳", "待招聘",
]);

function isCloudConfigured() {
  return /^https:\/\/.+\.supabase\.co$/i.test(CONFIG.supabaseUrl) && CONFIG.supabaseAnonKey.length > 40;
}

function safeParse(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function extractArray(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object" && Array.isArray(value.nodes)) return value.nodes;
  return null;
}

function normalizeCandidateNodes(rawNodes) {
  if (!Array.isArray(rawNodes) || !rawNodes.length) return null;
  const all = rawNodes.map((raw) => ({
    id: String(raw?.id ?? "").trim(),
    parent_id: raw?.parent_id == null || raw?.parent_id === "" ? null : String(raw.parent_id),
    type: String(raw?.type ?? "").trim(),
    name: String(raw?.name ?? "").trim(),
    title: String(raw?.title ?? "").trim(),
    notes: String(raw?.notes ?? "").trim(),
    sort_order: Number.isFinite(Number(raw?.sort_order)) ? Number(raw.sort_order) : 0,
    updated_at: raw?.updated_at ?? null,
    deleted_at: raw?.deleted_at ?? null,
  }));

  if (all.some((node) => !node.id || !VALID_TYPES.has(node.type) || !node.name)) return null;
  if (new Set(all.map((node) => node.id)).size !== all.length) return null;

  const allIds = new Set(all.map((node) => node.id));
  if (all.some((node) => node.parent_id && !allIds.has(node.parent_id))) return null;

  const active = all.filter((node) => !node.deleted_at);
  if (!active.length) return null;
  const activeIds = new Set(active.map((node) => node.id));
  const normalized = active.map((node) => ({
    ...node,
    parent_id: node.parent_id && activeIds.has(node.parent_id) ? node.parent_id : null,
  }));

  const children = new Map();
  for (const node of normalized) {
    if (!node.parent_id) continue;
    if (!children.has(node.parent_id)) children.set(node.parent_id, []);
    children.get(node.parent_id).push(node.id);
  }
  const roots = normalized.filter((node) => !node.parent_id);
  const visited = new Set();
  const stack = roots.map((node) => node.id);
  while (stack.length) {
    const id = stack.pop();
    if (visited.has(id)) continue;
    visited.add(id);
    stack.push(...(children.get(id) ?? []));
  }
  if (visited.size !== normalized.length) return null;

  return normalized;
}

function looksLikeSystemSample(nodes) {
  if (nodes.length < 18 || nodes.length > 22) return false;
  const names = nodes.map((node) => node.name);
  const matched = names.filter((name) => SYSTEM_SAMPLE_NAMES.has(name)).length;
  return matched >= Math.min(17, nodes.length - 1);
}

function summarizeCandidate(key, nodes) {
  const counts = { company: 0, department: 0, position: 0, person: 0 };
  let latest = null;
  for (const node of nodes) {
    if (counts[node.type] !== undefined) counts[node.type] += 1;
    const time = node.updated_at ? Date.parse(node.updated_at) : NaN;
    if (Number.isFinite(time) && (!latest || time > latest)) latest = time;
  }
  const roots = nodes.filter((node) => !node.parent_id).map((node) => node.name);
  return {
    key,
    nodes,
    counts,
    roots,
    latest,
    isSystemSample: looksLikeSystemSample(nodes),
  };
}

function findCandidates() {
  const candidates = [];
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (!key || !key.startsWith("beize-org-chart:")) continue;
    if (EXCLUDED_KEY_PARTS.some((part) => key.includes(part))) continue;
    const parsed = safeParse(localStorage.getItem(key));
    const rawNodes = extractArray(parsed);
    const nodes = normalizeCandidateNodes(rawNodes);
    if (!nodes) continue;
    candidates.push(summarizeCandidate(key, nodes));
  }
  candidates.sort((a, b) => {
    if (a.isSystemSample !== b.isSystemSample) return a.isSystemSample ? 1 : -1;
    return (b.latest ?? 0) - (a.latest ?? 0) || b.nodes.length - a.nodes.length;
  });
  return candidates;
}

function formatDate(timestamp) {
  if (!timestamp) return "无时间记录";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).format(new Date(timestamp));
}

function ensureStyles() {
  if (document.querySelector("#local-import-styles")) return;
  const style = document.createElement("style");
  style.id = "local-import-styles";
  style.textContent = `
    .local-import-button { white-space: nowrap; }
    .local-import-overlay { position: fixed; inset: 0; z-index: 9999; background: rgba(17,24,39,.45); display: grid; place-items: center; padding: 24px; }
    .local-import-dialog { width: min(720px, 96vw); max-height: 88vh; overflow: auto; background: #fff; border-radius: 18px; box-shadow: 0 24px 80px rgba(15,23,42,.24); padding: 26px; color: #111827; }
    .local-import-dialog h2 { margin: 4px 0 8px; font-size: 24px; }
    .local-import-dialog p { margin: 0 0 14px; line-height: 1.6; color: #4b5563; }
    .local-import-candidate { display: block; border: 1px solid #dbe3ec; border-radius: 14px; padding: 14px 16px; margin: 10px 0; cursor: pointer; background: #f9fbfd; }
    .local-import-candidate:has(input:checked) { border-color: #2563eb; box-shadow: 0 0 0 2px rgba(37,99,235,.10); background: #f5f9ff; }
    .local-import-candidate strong { display: block; font-size: 16px; margin-bottom: 5px; }
    .local-import-meta { font-size: 13px; color: #64748b; line-height: 1.6; }
    .local-import-warning { margin-top: 8px; color: #b42318; font-weight: 700; font-size: 13px; }
    .local-import-password { display: block; margin-top: 16px; }
    .local-import-password span { display: block; font-weight: 700; margin-bottom: 6px; }
    .local-import-password input { width: 100%; box-sizing: border-box; padding: 11px 12px; border: 1px solid #cbd5e1; border-radius: 10px; font-size: 16px; }
    .local-import-confirm { display: flex; gap: 9px; align-items: flex-start; margin-top: 14px; line-height: 1.5; }
    .local-import-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 22px; }
    .local-import-actions button { min-width: 110px; }
    .local-import-result { margin-top: 12px; padding: 10px 12px; border-radius: 10px; background: #f8fafc; font-size: 14px; }
  `;
  document.head.append(style);
}

function button(label, className = "button button-secondary") {
  const element = document.createElement("button");
  element.type = "button";
  element.className = className;
  element.textContent = label;
  return element;
}

function closeOverlay(overlay) {
  overlay?.remove();
}

async function getPublicOrganization(client) {
  const { data, error } = await client
    .from("organizations")
    .select("id,name")
    .eq("is_public", true)
    .order("created_at")
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("未找到公开组织");
  return data;
}

function openMigrationDialog(candidates, trigger) {
  ensureStyles();
  const overlay = document.createElement("div");
  overlay.className = "local-import-overlay";
  const dialog = document.createElement("section");
  dialog.className = "local-import-dialog";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");

  const eyebrow = document.createElement("div");
  eyebrow.className = "eyebrow";
  eyebrow.textContent = "一次性迁移";
  const title = document.createElement("h2");
  title.textContent = "把这台电脑的旧架构上传到云端";
  const intro = document.createElement("p");
  intro.textContent = "先确认下面哪一份是你之前自己填写的架构。确认后系统会先备份当前云端，再用选中的本机架构覆盖云端。整个覆盖在一个数据库事务内完成，失败会自动回滚。";
  dialog.append(eyebrow, title, intro);

  const list = document.createElement("div");
  candidates.forEach((candidate, index) => {
    const label = document.createElement("label");
    label.className = "local-import-candidate";
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "local-import-source";
    radio.value = String(index);
    radio.checked = index === 0 && !candidate.isSystemSample;
    const heading = document.createElement("strong");
    heading.textContent = candidate.isSystemSample ? `候选 ${index + 1} · 可能是系统示例` : `候选 ${index + 1} · 本机旧架构`;
    const meta = document.createElement("div");
    meta.className = "local-import-meta";
    meta.textContent = `${candidate.nodes.length} 个节点 · 部门 ${candidate.counts.department} · 人员 ${candidate.counts.person} · 根节点：${candidate.roots.join("、") || "无"} · ${formatDate(candidate.latest)} · 存储：${candidate.key}`;
    label.append(radio, heading, meta);
    if (candidate.isSystemSample) {
      const warning = document.createElement("div");
      warning.className = "local-import-warning";
      warning.textContent = "这份数据和之前系统生成的北泽示例高度一致。除非你确认这就是你要的，否则不要选它。";
      label.append(warning);
    }
    list.append(label);
  });
  dialog.append(list);

  const passwordLabel = document.createElement("label");
  passwordLabel.className = "local-import-password";
  const passwordTitle = document.createElement("span");
  passwordTitle.textContent = "编辑密码";
  const passwordInput = document.createElement("input");
  passwordInput.type = "password";
  passwordInput.autocomplete = "current-password";
  passwordInput.placeholder = "输入编辑密码后执行迁移";
  passwordLabel.append(passwordTitle, passwordInput);
  dialog.append(passwordLabel);

  const confirmLabel = document.createElement("label");
  confirmLabel.className = "local-import-confirm";
  const confirm = document.createElement("input");
  confirm.type = "checkbox";
  const confirmText = document.createElement("span");
  confirmText.textContent = "我已经看过节点数量和根节点，确认用选中的本机架构覆盖当前云端。云端现有数据会先自动备份。";
  confirmLabel.append(confirm, confirmText);
  dialog.append(confirmLabel);

  const result = document.createElement("div");
  result.className = "local-import-result";
  result.hidden = true;
  dialog.append(result);

  const actions = document.createElement("div");
  actions.className = "local-import-actions";
  const cancel = button("取消");
  const submit = button("确认迁移", "button button-primary");
  actions.append(cancel, submit);
  dialog.append(actions);
  overlay.append(dialog);
  document.body.append(overlay);

  cancel.addEventListener("click", () => closeOverlay(overlay));
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay && !submit.disabled) closeOverlay(overlay);
  });

  submit.addEventListener("click", async () => {
    const selected = dialog.querySelector('input[name="local-import-source"]:checked');
    if (!selected) {
      result.hidden = false;
      result.textContent = "请先选择一份本机架构。";
      return;
    }
    const candidate = candidates[Number(selected.value)];
    if (!candidate || candidate.isSystemSample) {
      result.hidden = false;
      result.textContent = "当前选中的是系统示例候选。请再次核对；如果这不是你自己填写的架构，不要执行覆盖。";
      return;
    }
    if (!passwordInput.value.trim()) {
      result.hidden = false;
      result.textContent = "请输入编辑密码。";
      passwordInput.focus();
      return;
    }
    if (!confirm.checked) {
      result.hidden = false;
      result.textContent = "请勾选覆盖确认。";
      return;
    }

    submit.disabled = true;
    cancel.disabled = true;
    result.hidden = false;
    result.textContent = "正在备份云端并迁移，请不要关闭页面…";

    try {
      const password = passwordInput.value.trim();
      const client = createClient(CONFIG.supabaseUrl, CONFIG.supabaseAnonKey, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        global: { headers: { "x-beize-edit-password": password } },
      });
      const organization = await getPublicOrganization(client);
      const { data: verified, error: verifyError } = await client.rpc("verify_public_edit_access", { p_organization_id: organization.id });
      if (verifyError || verified !== true) throw new Error("编辑密码错误");

      const payload = candidate.nodes.map(({ id, parent_id, type, name, title, notes, sort_order }) => ({
        id, parent_id, type, name, title, notes, sort_order,
      }));
      const { data: imported, error: importError } = await client.rpc("import_public_org_nodes", {
        p_organization_id: organization.id,
        p_nodes: payload,
      });
      if (importError) throw importError;

      const { data: cloudNodes, error: loadError } = await client
        .from("org_nodes")
        .select("id,parent_id,type,name,title,notes,sort_order,deleted_at")
        .eq("organization_id", organization.id)
        .is("deleted_at", null)
        .order("sort_order");
      if (loadError) throw loadError;
      if ((cloudNodes?.length ?? 0) !== candidate.nodes.length) throw new Error("迁移后节点数量校验失败，已停止自动完成标记");

      const importedCount = Number(imported?.imported_count ?? candidate.nodes.length);
      localStorage.setItem(COMPLETED_KEY, JSON.stringify({
        source_key: candidate.key,
        source_count: candidate.nodes.length,
        imported_count: importedCount,
        backup_id: imported?.backup_id ?? null,
        completed_at: new Date().toISOString(),
      }));
      sessionStorage.setItem(EDIT_SESSION_KEY, password);
      result.textContent = `迁移完成并校验通过：${importedCount} 个节点已写入云端。当前示例云端已自动备份。页面即将重新载入。`;
      trigger.hidden = true;
      window.setTimeout(() => window.location.reload(), 1200);
    } catch (error) {
      submit.disabled = false;
      cancel.disabled = false;
      result.textContent = `迁移未完成：${String(error?.message ?? error ?? "未知错误")}`;
    }
  });
}

function initializeLocalImport() {
  if (!isCloudConfigured()) return;
  if (localStorage.getItem(COMPLETED_KEY)) return;
  const candidates = findCandidates();
  if (!candidates.length) return;

  ensureStyles();
  const trigger = button("迁移本机旧架构", "button button-secondary local-import-button");
  trigger.title = "检测到这台电脑仍有旧的本机组织架构数据";
  const anchor = document.querySelector("#sync-status");
  if (anchor?.parentElement) anchor.parentElement.insertBefore(trigger, anchor);
  else document.querySelector(".topbar-actions")?.append(trigger);
  trigger.addEventListener("click", () => openMigrationDialog(findCandidates(), trigger));
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initializeLocalImport, { once: true });
} else {
  initializeLocalImport();
}
