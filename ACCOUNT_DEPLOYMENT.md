# GitHub Pages 账号服务部署

## 当前状态

- GitHub Pages 只提供 HTML、JavaScript 和词库文件，不会运行 `server.js`。
- 本机注册的账号、密码校验数据和学习记录仍在 `data/accounts/`，本次修改没有更改或上传它们。
- 线上登录需要一台持续运行的 Node 服务和持久化存储。仅修改网页或重新发布 Pages 不能让本地账号自动上线。
- 网页已支持单独连接账号服务，配置在 `site-config.json`。空地址表示仅探测同源账号服务；不会向 GitHub Pages 提交密码，也不会自动连接访问者的 localhost。

## 建议方案：Pages + Render 账号服务

仓库中的 `render.yaml` 已准备好 Node 服务、健康检查和持久化磁盘。
它选择 Render 的 **starter 付费方案及 1 GB 磁盘**，费用以创建服务时平台展示为准。免费临时文件系统不能承担长期账号存储。
当前尚未创建任何云服务，也没有产生部署费用。

1. 在 Render 登录后选择 **New → Blueprint**，连接本仓库 `Moonite0307/Englishmurdermystery` 的 `main` 分支。
2. 检查 `render.yaml` 中的服务和磁盘费用，确认后创建。服务运行 `node server.js`，账号目录为 `/var/data/accounts`。
3. 等待服务就绪，打开平台分配的网址的 `/api/health`。必须返回 `{"service":"englishmurdermystery","accounts":true}`。
4. 暂时不要让真实用户在新服务注册；先按下节迁移原账号，避免同名账号冲突。
5. 将 `site-config.json` 改为 `{"accountApiBase":"https://实际分配的服务域名"}`，提交到 GitHub。这里必须填写真实 HTTPS 地址，不含 `/api` 后缀，不含密钥。
6. 等 Pages 发布后强制刷新，在 Pages 页面分别验证旧账号登录、新账号注册、学习记录同步、退出后再登录，以及手机访问。
7. 在 Render 执行一次重新部署，再验证账号和学习记录仍在，确认服务确实使用持久化磁盘。

账号服务独立于大模型接口，本方案不要求把模型密钥填进账号服务。剧本生成继续使用现有连接。
若希望整个网站也由 Node 服务托管，可直接使用服务网址，同源账号接口同样可用。

## 迁移原账号：只通过私密通道

1. 关闭原本运行 `server.js` 的窗口，避免迁移期间仍在写入。
2. 在电脑上另外复制一份完整的 `data/accounts/` 作为备份。不要删除原目录，不要上传 GitHub，也不要把内容粘贴到聊天或公开日志。
3. 按 Render 控制台 **Connect / SSH** 提供的连接方式，通过 SSH/SCP 或私密文件传输把目录内容送入服务的 `/var/data/accounts/`。应保持以下结构：

   ```text
   /var/data/accounts/users.json
   /var/data/accounts/tokens.json
   /var/data/accounts/states/<用户ID>.json
   ```

   不要多套一层 `accounts/accounts/`。如果目标已经有真实用户，先备份并合并两端数据，禁止直接覆盖；本站没有自动数据库合并工具。

4. 确认新服务中的目录只对运行服务的账号可读写，再使用原用户名和原密码登录。密码哈希格式保持不变，无需重设密码。
5. 验证旧账号里的词汇、闯关记录、剧本档案。原网站和新网站的浏览器缓存彼此独立，迁移的是服务端已保存的数据；仅存在浏览器中的记录需要先登录原服务并完成同步。
6. 验证成功后保留本机备份。正式切换后避免继续使用两台互不相连的服务写入同一账号，否则记录会分散。

## 其他 Node 托管平台

- Node.js 22，启动命令 `node server.js`。
- 平台提供 `PORT` 环境变量；程序会监听 `0.0.0.0`。
- `ACCOUNT_DATA_DIR` 必须指向持久化卷，例如 `/var/data/accounts`。默认不设置时仍使用原本的 `data/accounts/`。
- 提供有效 HTTPS 网址，允许 Pages 域名的跨域 GET/POST/OPTIONS 及 `Content-Type, Authorization` 请求头；当前服务已支持这些请求。
- 不把账号文件作为静态资源发布，不将私有账号文件或模型密钥加入 Git。

## 发布后的故障排查

- 页面提示“尚未连接账号服务”：检查 `site-config.json` 的服务地址、健康接口、HTTPS、网络和 CORS。
- `Unexpected token '<'`：旧页面或错误服务返回了 HTML。新版先检测服务能力，并显示可读错误，不会清空本机记录。
- 原账号密码不正确，但本地仍能登录：通常是账号文件未迁移到实际使用的持久化目录；检查目录结构，不要重复注册覆盖旧账号。
- 重启后账号消失：账号目录没有挂载持久化磁盘。先纠正挂载并从私密备份恢复，再开放注册。
