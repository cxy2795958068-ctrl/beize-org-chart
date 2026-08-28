// 这是可公开的浏览器端配置，不要在这里放 service_role 密钥或 GitHub Token。
window.__BEIZE_CONFIG__ = {
  SUPABASE_URL: "",
  SUPABASE_ANON_KEY: "",
  DEFAULT_ORG_NAME: "东莞市北泽五金制品有限公司",
};

// 仅执行一次：强制旧本机测试数据重新初始化为当前北泽示例架构。
if (!localStorage.getItem("beize-org-chart:seed-fix-v1")) {
  localStorage.removeItem("beize-org-chart:demo-seed-version");
  localStorage.setItem("beize-org-chart:seed-fix-v1", "done");
}
