# 北泽公司组织架构

这是一个面向桌面浏览器的共享组织架构网页。前端部署在 GitHub Pages，身份认证、组织数据、实时同步和权限控制由 Supabase 提供。用户可以维护公司、部门、岗位和人员节点，并以树状图查看层级关系。

> 当前仓库包含自动部署配置，但“存在工作流文件”不等于“已经上线”。只有完成 GitHub 仓库授权、Supabase 初始化和 Pages 首次成功部署后，线上地址才可用。

## 架构与安全边界

- GitHub 保存源代码，GitHub Actions 将 `dist/` 发布到 GitHub Pages。
- GitHub Pages 只托管静态文件，没有可信服务器端环境，因此本项目不需要、也不能在网页中使用 Supabase `service_role` 或 secret key。
- 浏览器通过 Supabase Auth 登录，并使用 publishable key（或旧项目的 `anon` key）访问数据。
- publishable/`anon` key 本来就是可公开的项目标识，不是密码。真正的数据隔离依赖数据库授权、Row Level Security（RLS）策略和登录用户的 JWT。
- `service_role`、`sb_secret_...`、GitHub Personal Access Token、数据库密码绝不能写入 `public/config.js`、`.env`、源代码、GitHub Actions 日志、Issue、截图或浏览器存储。它们会绕过或拥有高于 RLS 的权限。一旦泄露，立即在对应平台轮换，并清理 Git 历史；只删除当前文件不够。

官方参考：[GitHub Pages 自定义工作流](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)、[Supabase 数据安全](https://supabase.com/docs/guides/database/secure-data)、[Supabase API keys](https://supabase.com/docs/guides/getting-started/api-keys)。

## 1. 修复 GitHub App / 仓库授权

GitHub App 授权决定开发工具能否看到和修改仓库；Pages 部署则由仓库内的 GitHub Actions 使用临时 `GITHUB_TOKEN` 完成。两者不是同一项权限。

1. 使用仓库所有者或组织管理员账号登录 GitHub。
2. 个人仓库进入 **Settings → Applications → Installed GitHub Apps**；组织仓库进入组织 **Settings → GitHub Apps / Installed GitHub Apps**。
3. 找到当前连接 ChatGPT/Codex 的 GitHub App，选择 **Configure**。
4. 在 **Repository access** 中选择 **Only select repositories** 并勾选目标仓库，或按组织安全政策授予全部仓库访问。
5. 确认该 App 对仓库内容具有完成本项目所需的读写权限。若只能读取，工具可以检查代码，但不能提交；权限项由 App 安装配置或组织管理员控制。
6. 如果仓库属于组织并显示“等待批准”，必须由组织所有者批准。分支保护开启时，应通过分支和 Pull Request 合并，不能绕过保护直接写 `main`。

常见症状与原因：

| 症状 | 最可能的原因 | 处理 |
| --- | --- | --- |
| 目标仓库完全不可见 | App 没有安装到该账号/组织，或未选中仓库 | 重新配置 App 的 Repository access |
| 能浏览但不能提交 | App 只有 Contents 读取权限 | 由管理员补充写权限，或改走本地 Git + PR |
| `Resource not accessible by integration` | GitHub App / Actions token 权限不足 | 检查 App 权限、工作流 `permissions` 和组织策略 |
| 推送 `main` 被拒绝 | 分支保护或必需检查 | 新建分支并通过 PR 合并 |
| Actions 根本不运行 | Actions 被组织禁用或限制了第三方 Action | 在仓库/组织 Actions policy 中允许本工作流使用的 Action |

不要为了省事把个人 GitHub Token 放进网页配置。本项目的 Pages 工作流已经声明最小权限：读取代码、写 Pages、签发部署身份令牌。

## 2. 初始化 Supabase

建议为正式环境新建独立 Supabase 项目，不要与测试数据混用。

1. 在 [Supabase Dashboard](https://supabase.com/dashboard) 新建项目并记录项目 URL。
2. 打开 **SQL Editor**，新建查询，完整执行 `supabase/schema.sql`。
3. 执行后不要只看“成功”提示。至少确认：所需表已创建、RLS 已启用、授权策略存在、数据库函数/触发器存在，以及需要同步的表已加入 `supabase_realtime` publication。
4. 若脚本中途报错，先定位失败语句和已创建对象，不要在正式库中盲目重复执行整份脚本。首次部署使用空白项目最稳妥。
5. 打开 **Authentication → Providers → Email**，启用邮件登录。界面使用一次性登录链接（Magic Link），正式使用前应配置自有 SMTP；Supabase 默认邮件服务有发送限制，不适合作为公司长期登录通道。
6. 打开项目的 **Connect** 或 **Settings → API Keys**，复制 publishable key；旧项目可复制 legacy `anon` key。两者都属于浏览器端低权限 key。不要复制 secret 或 `service_role`。
7. 编辑 `public/config.js`：

```js
window.__BEIZE_CONFIG__ = {
  SUPABASE_URL: "https://YOUR_PROJECT.supabase.co",
  SUPABASE_ANON_KEY: "YOUR_PUBLISHABLE_OR_LEGACY_ANON_KEY",
  DEFAULT_ORG_NAME: "北泽公司",
};
```

`public/config.js` 会进入最终网页，任何访问者都能下载它，这是正常现象。安全前提是 `schema.sql` 中的 RLS 和最小权限授权正确。不要创建允许 `anon` 角色读取组织数据的宽泛策略。

### Auth redirect URL

假设仓库为 `OWNER/REPOSITORY`，默认 GitHub Pages 地址是：

```text
https://OWNER.github.io/REPOSITORY/
```

在 Supabase **Authentication → URL Configuration** 中设置：

- **Site URL**：填写上述正式地址，保留 `https://`、仓库路径和末尾 `/`。
- **Redirect URLs**：加入同一个正式地址。正式环境优先使用精确地址，不要用覆盖整个 `github.io` 的通配符。
- 本地开发时额外加入 `http://localhost:5173/`。如果实际启动端口不同，按终端显示的地址添加。

如果改用自定义域名，必须同时更新 Site URL 和 Redirect URLs。登录邮件跳回首页、跳到 `localhost` 或返回“redirect URL not allowed”，通常就是这里的协议、路径、端口或末尾斜杠不一致。参考：[Supabase Redirect URLs](https://supabase.com/docs/guides/auth/redirect-urls)。

登录成功不等于有权查看北泽公司的数据。公司成员身份仍应由 RLS 与成员表控制；不要用“只要能收邮件就能读全部组织数据”的策略替代权限模型。

## 3. 本地运行与检查

要求 Node.js 22 和 pnpm 11.19.0。仓库必须提交 `pnpm-lock.yaml`，部署工作流会使用冻结锁文件，防止 CI 静默安装不同版本依赖。

```bash
pnpm install --frozen-lockfile
pnpm test
pnpm dev
```

生产构建检查：

```bash
pnpm build
pnpm preview
```

不要把开发服务器当作共享部署。`pnpm dev` 只用于本机开发；所有电脑访问同一地址需要 GitHub Pages 成功发布。

## 4. 部署到 GitHub Pages

仓库已提供 `.github/workflows/pages.yml`。工作流在推送到 `main` 时运行，也可以在 Actions 页面手动触发；它会安装锁定依赖、运行测试、使用 pnpm 构建 `dist/`，再通过 GitHub 官方 Pages Action 发布。

首次部署步骤：

1. 把完整项目（包括 `pnpm-lock.yaml`、`supabase/schema.sql`、已填写的 `public/config.js` 和工作流）提交到目标 GitHub 仓库的 `main` 分支。若默认分支不是 `main`，先修改工作流中的触发分支。
2. 进入仓库 **Settings → Pages → Build and deployment**，把 **Source** 设为 **GitHub Actions**。
3. 进入 **Actions → Deploy GitHub Pages**。推送 `main` 会自动运行；也可选择 **Run workflow** 手动启动。
4. 等待 `build` 和 `deploy` 两个 job 都成功。最终地址以 `deploy` job 和仓库 Pages 设置显示的 URL 为准。
5. 用未登录浏览器窗口和另一台电脑打开最终地址。仅看到绿色工作流不等于功能可用，还必须验证登录、权限和数据库连接。

若 `pnpm install --frozen-lockfile` 失败，先在本地用同一 pnpm 主版本更新并提交 `pnpm-lock.yaml`，不要把工作流改成每次忽略锁文件。若构建成功但网页 404，检查 Pages Source、仓库可见性/套餐限制和最终 URL 中的仓库路径。

## 5. 多人编辑、冲突与回收站

Supabase Realtime 用于把数据库变化推送给其他已登录客户端，但 Realtime 本身不能防止“后保存的人覆盖先保存的人”。项目的数据模型使用节点 `version` 做乐观并发控制：所有更新都必须调用数据库的 `update_org_node` 函数，并携带用户开始编辑时看到的版本；数据库拒绝过期版本，网页再显示冲突供用户选择，不能静默覆盖。普通登录账号没有直接更新节点表的权限，因此旧版或错误客户端也不能绕过版本检查。

多人操作时遵守以下原则：

- 不同节点可以并行编辑；同一个节点同时编辑时，至少一方必须收到明确冲突提示。
- 收到冲突后先比较服务器最新内容，再决定重新编辑；不要用旧表单直接覆盖新数据。
- Realtime 断线时，界面应明确显示连接/保存异常。只有数据库确认成功后才能提示“已保存”。
- 离线队列按节点和操作时间保留顺序；删除、恢复以及重试请求携带唯一操作编号，延迟到达的旧请求不能重新删除或恢复较新的批次。
- 如果一台电脑看不到另一台的改动，先检查该表是否加入 `supabase_realtime` publication，再检查订阅用户是否被 RLS 允许读取该行。WebSocket 已连接不代表该用户有权收到数据。

删除操作采用软删除字段和删除批次记录，目的是让整棵子树可以进入回收站并恢复。回收站是误删防护，不是备份：

- 删除父节点前必须明确显示将受影响的子节点数量，并要求二次确认。
- 恢复时应恢复同一删除批次，并检查原父节点是否仍有效，避免产生孤儿或断裂层级。
- 正式使用前必须实际测试“删除部门及其岗位/人员 → 回收站可见 → 恢复后层级不变”。
- 不要在前端提供绕过确认的永久删除。确需清理时先导出或备份，再由受控的管理员流程执行。
- Supabase 备份/PITR、定期导出和恢复演练仍然必要；不能把回收站当作灾难恢复方案。

## 6. 上线验收清单

### 授权与安全

- [ ] GitHub App 能访问正确仓库；写入操作通过直接提交或受保护分支 PR 完成。
- [ ] 仓库中没有 `service_role`、`sb_secret_...`、GitHub Token、数据库密码或 SMTP 密码；同时检查 Git 历史，而不只检查当前文件。
- [ ] Supabase 所有业务表都启用 RLS，未登录用户不能读取组织数据。
- [ ] 两个不同组织/无成员关系的测试用户不能互相读取或修改数据。
- [ ] Magic Link 只能重定向到批准的正式地址和本地开发地址。

### 部署与桌面兼容

- [ ] GitHub Actions 的 `build`、`deploy` 均成功，Pages URL 从两台不同电脑可访问。
- [ ] 最新两个稳定版本的 Chrome、Edge、Firefox 和 Safari（如公司使用 macOS）可以登录、编辑、缩放和滚动树状图。
- [ ] 浏览器刷新后数据仍存在；清除缓存或换电脑后登录仍读取同一云端数据。
- [ ] 在 1366×768、1920×1080 和高分屏下，侧栏、表单、弹窗和树状图没有遮挡或无法操作的问题。
- [ ] 网络断开、Supabase 不可用、登录链接过期和权限拒绝时，都出现可理解的错误信息，不伪装成保存成功。

### 数据一致性与误删

- [ ] 能创建、修改部门、岗位和人员，树形层级与排序在刷新后保持一致。
- [ ] 两个浏览器同时登录：A 的修改能实时出现在 B；B 断线重连后能重新拉取完整最新数据。
- [ ] A、B 同时修改同一节点时，没有静默覆盖；过期版本收到冲突提示。
- [ ] 删除父节点会预告影响范围；子树进入回收站后可以整批恢复，恢复后没有孤儿节点或循环引用。
- [ ] 搜索、移动节点后刷新，数据库与界面结果一致。
- [ ] 已制定数据库备份、导出、恢复演练和管理员应急联系人，不依赖回收站承担备份职责。

## 运维原则

- 数据库结构变更先在独立测试项目验证，再安排正式环境备份和迁移窗口。
- 前端部署和数据库迁移是两件事。不要假设合并前端代码会自动执行 `schema.sql`。
- 每次上线后用普通成员账号做冒烟测试，管理员账号无法暴露普通用户的 RLS 问题。
- 遇到多人数据不一致时，保留发生时间、用户、节点 ID 和浏览器错误信息；不要先手工改库破坏证据。
- 定期检查 GitHub Actions、Pages 环境、Supabase Auth 邮件发送、Realtime publication、RLS 策略和备份状态。

