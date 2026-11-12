# 词境寻真 · Englishmurdermystery
英语学习剧本杀工具：一名真人玩家，AI 扮演其他角色并兼任主持人。

手机试玩入口：https://englishmurdermystery-mobile.pages.dev

## 协作与本地运行

**接口安全：**公共前端不包含共享 API Key。线上模型通过 Cloudflare 服务端转发，供应商密钥仅存加密 Secret；游客使用短期游玩会话，账号沿用原有登录，服务端设有频率与每日调用上限。此前公开过的旧 Key 仍须在供应商平台撤销。不要将新 Key 写回 HTML 或提交 Git。详见 [安全部署说明](docs/SAFE_DEPLOYMENT.md)。

1. 克隆仓库并进入目录：`git clone https://github.com/Moonite0307/Englishmurdermystery.git`，然后 `cd Englishmurdermystery`。
2. 安装 Node.js 18 或以上版本；Windows 双击 `启动.bat`，或运行 `npm start`，打开 `http://127.0.0.1:8787/`。保持服务窗口开启；更新后请关闭旧服务再启动。
3. 需要本地模型代理时，将 `config.example.json` 复制为 `config.json` 并填写自己的配置。真实配置不提交；不要把账号数据或 Cloudflare 授权文件放入仓库。
4. 修改前先同步最新代码，建议在个人分支开发并通过 Pull Request 合并，避免覆盖彼此改动。

主要文件：`index.html` 包含界面与剧本交互；`server.js` 是本地服务；`data/daily/` 保存运行词库和场景；`cloudflare/` 与 `scripts/deploy-mobile-site.cjs` 负责线上账号及手机入口。界面设计与交互约定见 [docs/UI_DESIGN.md](docs/UI_DESIGN.md)。

当前版本包含金米色明暗主题、手机布局、角色本、主动保存续玩、词卡自测，以及英文选项 / 自由对话两种回答模式。游客记录只在当前页面内存中存在，刷新或重新进入即清空；登录后才保留与同步学习记录。

音标文件 `data/daily/pronunciations.json` 已随仓库提供，日常运行不必重新下载。需要重建时运行 `node scripts/build-pronunciations.cjs`；来源及许可见同目录的 `pronunciation-LICENSE.txt`。英式与美式数据分别保存，缺失项不冒充另一种口音。

## 验证修改

先运行 `npm ci` 安装开发依赖。核心逻辑与启动检查：`npm test`。

浏览器回归需安装 `npm install --no-save playwright`，并在电脑安装 Microsoft Edge，然后运行 `npm run test:ui`。此命令会自动启动临时静态服务，用模拟模型及临时账号数据测试，不调用付费模型、不修改真实账号。

手机静态资源构建：`node scripts/build-mobile-site.cjs`；线上更新：`npm run deploy:mobile`。部署需要项目所有者授权及本机 `.cloudflare-private/wrangler.json`，不会随 Git 上传。协作者只做页面开发无需部署凭据；可由所有者统一发布。GitHub 提交与 Cloudflare 发布是两步操作。

## 账号（可选）
登录后可把闯关记录、生词本、复习队列同步到账号。后端接口（`server.js`）：

- `POST /api/auth/register` `{username, password}`
- `POST /api/auth/login` `{username, password}` → `{token, username}`
- `GET /api/state` 需 `Authorization: Bearer <token>`，返回该账号的学习数据
- `POST /api/state` `{state:{campaign, vocabBook, learningVocab}}`，覆盖保存

账号数据落在 `data/accounts/`（密码只存 scrypt 派生值，token 为 32 字节随机串、30 天有效），
该目录不在静态白名单内，并已在 `.gitignore` 中排除，不会被直接下载或提交。

注意：页面需通过 HTTP/HTTPS 打开才能读取词库。请使用启动文件或已部署的网址，不要直接双击 `index.html`。

## GitHub Pages 与线上账号

GitHub Pages 不会运行账号后端。静态页面通过 `site-config.json` 的 `accountApiBase` 连接 HTTPS 账号服务；Cloudflare 手机入口使用同源账号服务。未接通时显示说明，不把游客记录当作已保存的账号记录。

免费部署使用 Cloudflare Workers Free + D1。双击 `免费部署账号.bat`，按浏览器提示登录授权即可开始；不需要 Visa、购买域名或开通付费套餐。操作与迁移说明见 [ACCOUNT_DEPLOYMENT.md](ACCOUNT_DEPLOYMENT.md)。
