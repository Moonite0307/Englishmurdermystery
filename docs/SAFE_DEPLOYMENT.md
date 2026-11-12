# 词境寻真：公开源码与私密模型服务

玩家可直接打开或转发 https://englishmurdermystery-mobile.pages.dev/ ，电脑、手机共用同一响应式页面。GitHub Pages 源码站也可通过 site-config.json 中的公开服务地址连接模型与账号；网页链接不是 API 密钥。

## 密钥的唯一位置

- 本地开发：根目录 config.json，已被 Git 忽略，服务只读取、不对外提供。
- 线上：Cloudflare Pages 生产环境的加密 Secret `MODEL_API_KEY`。浏览器、HTML、GitHub 源码、构建产物均不携带供应商密钥。模型名称也可通过 Secret `MODEL_NAME` 配置。
- 不把密钥写进 HTML、site-config.json、wrangler 配置、普通环境变量配置文件、截图、提示词或提交说明。不把私密文件放进构建目录。
- 更新 Pages 时保留已有 Secret 和 D1 绑定；部署脚本不会把现有生产配置整体覆盖成普通变量。

服务端只向固定 DeepSeek 地址转发，只发送服务端配置的模型，限制输入大小和最大输出，过滤上游错误、响应头及输出中意外回显的密钥。浏览器携带的账号或游玩凭证只用于本站，不是供应商密钥。

## 游客与账号

游客通过 `/api/play-session` 获得两小时有效且绑定客户端 IP 的短期凭证，仅保存在当前页面内存；刷新重新申请，不保存游客学习记录。登录用户使用原有账号会话，学习记录仍同步到原有 D1 数据库。手机网络改变时，可刷新或登录后继续。

默认上限：每 IP 每分钟 12 次模型请求、每 IP 每天 100 次、每位玩家每天 80 次、全站每天 200 次。游客凭证每 IP 每小时最多申请 20 次。超过上限返回说明，不再调用付费模型。请求次数上限不等同于精确人民币预算；实际成本与上下文长度、输出量和供应商价格有关。

管理员可在服务端配置 `MODEL_DAILY_REQUEST_LIMIT`、`MODEL_IP_DAILY_LIMIT`、`MODEL_PLAYER_DAILY_LIMIT`，无需修改前端。上限分别封顶为 2000/1000/1000 次；更高额度需另行审阅实现。不要靠扩大额度排查生成失败。

## 构建与协作

`node scripts/build-mobile-site.cjs` 仅把 HTML、运行词库、本地中文字体、公开配置和 Worker 打包到被忽略的 `.cloudflare-private/mobile-site`。禁止直接上传整个项目文件夹。Cloudflare schema 只新增会话和计数表，不替换账号数据。

本地检查：`npm test`、`npm run test:ui`、`npm run test:cloudflare`。模型测试均使用模拟响应，不消耗真实接口余额。

GitHub 历史里曾公开过的旧密钥仍需在供应商平台撤销；新增 Secret 不能使旧凭证失效。此文档和仓库均不记载任何实际密钥值。
