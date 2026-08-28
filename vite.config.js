import { defineConfig } from "vite";

function publicPasswordModePatch() {
  return {
    name: "beize-public-password-mode",
    enforce: "pre",
    transform(code, id) {
      if (!id.replace(/\\/g, "/").endsWith("/src/main.js")) return null;

      let next = code;

      const accountReplacement = `function showAccount() {
  const content = makeElement("div");
  const editing = state.role === "editor" || state.role === "owner";
  content.append(makeElement("p", "modal-content-copy", editing
    ? "当前为编辑模式。关闭编辑模式后，页面恢复为公开只读。"
    : "任何人打开链接都可以直接查看。需要修改组织架构时，请输入编辑密码。"));

  if (!editing) {
    const label = makeElement("label");
    label.append(makeElement("span", "", "编辑密码"));
    const passwordInput = makeElement("input");
    passwordInput.type = "password";
    passwordInput.autocomplete = "current-password";
    passwordInput.placeholder = "请输入编辑密码";
    label.append(passwordInput);
    content.append(label);

    openModal({
      title: "进入编辑模式",
      eyebrow: "权限验证",
      content,
      actions: [
        { label: "取消", className: "button-secondary" },
        {
          label: "解锁编辑",
          className: "button-primary",
          close: false,
          onClick: async () => {
            const candidate = passwordInput.value.trim();
            if (!candidate) {
              showToast("请输入编辑密码");
              passwordInput.focus();
              return;
            }
            const testClient = makeCloudClient(candidate);
            const { data, error } = await testClient.rpc("verify_public_edit_access", { p_organization_id: state.organization.id });
            if (error || data !== true) {
              showToast("编辑密码错误");
              passwordInput.select();
              return;
            }
            if (state.channel) {
              await state.client.removeChannel(state.channel);
              state.channel = null;
            }
            state.client = testClient;
            sessionStorage.setItem(PUBLIC_EDIT_SESSION_KEY, candidate);
            state.role = "editor";
            state.user = { id: "password-editor", email: "编辑模式" };
            loadUserQueue();
            dom.accountButton.textContent = "编辑中";
            await loadNodes();
            subscribeRealtime();
            await flushQueue();
            closeModal();
            renderAll({ refreshForm: true });
            setStatus("云端编辑模式", "saved");
            showToast("已进入编辑模式");
          },
        },
      ],
    });
    window.setTimeout(() => passwordInput.focus(), 0);
    return;
  }

  openModal({
    title: "编辑模式",
    eyebrow: "当前会话",
    content,
    actions: [
      { label: "关闭", className: "button-secondary" },
      {
        label: "退出编辑",
        className: "button-danger",
        onClick: () => {
          sessionStorage.removeItem(PUBLIC_EDIT_SESSION_KEY);
          window.location.reload();
        },
      },
    ],
  });
}

async function loadNodes()`;

      next = next.replace(
        /function showAccount\(\) \{[\s\S]*?\n\}\n\nasync function loadNodes\(\)/,
        accountReplacement,
      );

      const bootReplacement = `const PUBLIC_EDIT_SESSION_KEY = "beize-org-chart:edit-session:v1";

function makeCloudClient(editPassword = "") {
  const options = {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    realtime: { params: { eventsPerSecond: 10 } },
  };
  if (editPassword) options.global = { headers: { "x-beize-edit-password": editPassword } };
  return createClient(CONFIG.supabaseUrl, CONFIG.supabaseAnonKey, options);
}

async function bootCloud() {
  let editPassword = sessionStorage.getItem(PUBLIC_EDIT_SESSION_KEY) ?? "";
  state.client = makeCloudClient(editPassword);

  const { data: organization, error: organizationError } = await state.client
    .from("organizations")
    .select("id,name,is_public")
    .eq("is_public", true)
    .order("created_at")
    .limit(1)
    .maybeSingle();
  if (organizationError) throw organizationError;
  if (!organization) throw new Error("未找到公开组织，请检查 Supabase 公开设置");

  let editing = false;
  if (editPassword) {
    const { data, error } = await state.client.rpc("verify_public_edit_access", { p_organization_id: organization.id });
    editing = !error && data === true;
    if (!editing) {
      sessionStorage.removeItem(PUBLIC_EDIT_SESSION_KEY);
      editPassword = "";
      state.client = makeCloudClient();
    }
  }

  state.organization = organization;
  state.role = editing ? "editor" : "viewer";
  state.user = { id: editing ? "password-editor" : "public-viewer", email: editing ? "编辑模式" : "公开查看" };
  state.selectedId = null;
  dom.orgTitle.textContent = organization.name;
  dom.accountButton.textContent = editing ? "编辑中" : "编辑";
  dom.membersButton.hidden = true;
  dom.authScreen.classList.add("hidden");
  loadUserQueue();
  await loadNodes();
  subscribeRealtime();
  if (editing) await flushQueue();
  setStatus(editing ? "云端编辑模式" : "云端只读 · 实时同步", "saved");
}

function bootDemo()`;

      next = next.replace(
        /async function bootCloud\(\) \{[\s\S]*?\n\}\n\nfunction bootDemo\(\)/,
        bootReplacement,
      );

      if (next === code) throw new Error("public password mode patch did not match src/main.js");
      return { code: next, map: null };
    },
  };
}

export default defineConfig({
  base: "./",
  plugins: [publicPasswordModePatch()],
  build: {
    target: "es2020",
    sourcemap: true,
  },
});
