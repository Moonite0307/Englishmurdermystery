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
