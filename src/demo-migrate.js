const DEMO_SEED_VERSION_KEY = "beize-org-chart:demo-seed-version";
const CURRENT_DEMO_SEED_VERSION = "2";

if (localStorage.getItem(DEMO_SEED_VERSION_KEY) !== CURRENT_DEMO_SEED_VERSION) {
  // 只在这一版首次加载时清掉旧测试草稿，让新的北泽示例架构显示出来。
  // 旧数据仍保存在浏览器历史版本逻辑之外，不会影响未来云端数据。
  localStorage.removeItem("beize-org-chart:demo:v1");
  localStorage.setItem(DEMO_SEED_VERSION_KEY, CURRENT_DEMO_SEED_VERSION);
}
