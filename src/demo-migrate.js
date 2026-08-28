const DEMO_SEED_VERSION_KEY = "beize-org-chart:demo-seed-version";
const CURRENT_DEMO_SEED_VERSION = "3";

if (localStorage.getItem(DEMO_SEED_VERSION_KEY) !== CURRENT_DEMO_SEED_VERSION) {
  // 仅在本次示例架构升级时清除旧的本机测试草稿。
  // 新示例加载后会立刻写回本机；之后用户自己的修改继续保留，不会每次刷新重置。
  localStorage.removeItem("beize-org-chart:demo:v1");
  localStorage.setItem(DEMO_SEED_VERSION_KEY, CURRENT_DEMO_SEED_VERSION);
}
