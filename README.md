# Englishmurdermystery
英语学习剧本杀工具

## 账号（可选）
登录后可把闯关记录、生词本、复习队列同步到账号。后端接口（`server.js`）：

- `POST /api/auth/register` `{username, password}`
- `POST /api/auth/login` `{username, password}` → `{token, username}`
- `GET /api/state` 需 `Authorization: Bearer <token>`，返回该账号的学习数据
- `POST /api/state` `{state:{campaign, vocabBook, learningVocab}}`，覆盖保存

账号数据落在 `data/accounts/`（密码只存 scrypt 派生值，token 为 32 字节随机串、30 天有效），
该目录不在静态白名单内，并已在 `.gitignore` 中排除，不会被直接下载或提交。

注意：账号功能依赖后端，需通过 `启动.bat`（`http://127.0.0.1:8787`）打开页面；直接双击 `index.html`（file://）时只有本地记录可用。

## GitHub Pages 与线上账号

GitHub Pages 不会运行账号后端。静态页面通过 `site-config.json` 的 `accountApiBase` 连接独立 HTTPS 账号服务；未接通服务时会显示说明，并保留本机记录。

免费部署使用 Cloudflare Workers Free + D1。双击 `免费部署账号.bat`，按浏览器提示登录授权即可开始；不需要 Visa、购买域名或开通付费套餐。操作与迁移说明见 [ACCOUNT_DEPLOYMENT.md](ACCOUNT_DEPLOYMENT.md)。
