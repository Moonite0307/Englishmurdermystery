/**
 * 沉浸式 AI 剧本杀语言学习助手 — 后端（本地 / 云托管通用）
 * 零依赖（Node.js 18+ 内置 fetch），职责：
 *   1. 托管静态文件（仅 index.html，config.json 等敏感文件一律不对外提供）
 *   2. 读取 API 密钥配置，代理转发大模型请求（SSE 流式透传）
 * 密钥来源（按优先级）：
 *   1. 项目根目录 config.json（本地开发）
 *   2. /etc/secrets/config.json（Render 私密文件）
 *   3. 环境变量 API_BASE / API_KEY / MODEL（其他云平台）
 * 前端代码不包含任何 Key。
 */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { exec } = require("child_process");

const IS_CLOUD = !!process.env.PORT;            // 云平台（Render/Railway 等）会注入 PORT
const PORT = Number(process.env.PORT) || 8787;
const HOST = IS_CLOUD ? "0.0.0.0" : "127.0.0.1";
const ROOT = __dirname;
const CONFIG_PATH = path.join(ROOT, "config.json");
const SECRET_PATH = "/etc/secrets/config.json"; // Render Secret Files 挂载路径

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jsonl": "application/x-ndjson; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

/* 前端需要读取的只读数据文件白名单（日常场景资料）。
   只有列在这里的文件会被提供，其余一律 404：
   包括 config.json / server.js / data/daily 下的审核与补丁文件等内部资料。 */
const PUBLIC_FILES = new Set([
  "/index.html",
  "/site-config.json",
  "/data/daily/scenes.jsonl",
  "/data/daily/scene_catalog.json",
  "/data/daily/vocabulary.json",
  "/data/daily/sources.json",
  "/data/daily/exam_lexicon.json",
  "/data/daily/cet_core.json",
  "/data/daily/pronunciations.json",
  "/data/daily/pronunciation-LICENSE.txt"
]);

function loadConfig() {
  /* 每次请求实时读取，改完配置立即生效 */
  for (const p of [CONFIG_PATH, SECRET_PATH]) {
    try {
      const c = JSON.parse(fs.readFileSync(p, "utf8"));
      if (c.apiKey) {
        return {
          apiBase: String(c.apiBase || "").replace(/\/+$/, ""),
          apiKey: String(c.apiKey || ""),
          model: String(c.model || "gpt-4o-mini")
        };
      }
    } catch (e) { /* 文件不存在或格式错误，尝试下一个来源 */ }
  }
  /* 环境变量兜底（Render/Railway 等平台的环境变量配置） */
  return {
    apiBase: String(process.env.API_BASE || "").replace(/\/+$/, ""),
    apiKey: String(process.env.API_KEY || ""),
    model: String(process.env.MODEL || "gpt-4o-mini")
  };
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*"
  });
  res.end(body);
}

function readBody(req, limit = 2e6) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > limit) { reject(new Error("payload too large")); req.destroy(); } });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

/* ================= 账号系统（零依赖：JSON 文件 + scrypt 哈希 + 随机 token） =================
   存放位置 data/accounts/，该目录不在 PUBLIC_FILES 白名单内，外部无法直接下载。
   密码只保存 scrypt 派生值，token 是 32 字节随机串，30 天有效。 */
const ACCOUNTS_DIR = process.env.ACCOUNT_DATA_DIR
  ? path.resolve(process.env.ACCOUNT_DATA_DIR)
  : path.join(ROOT, "data", "accounts");
const USERS_PATH = path.join(ACCOUNTS_DIR, "users.json");
const TOKENS_PATH = path.join(ACCOUNTS_DIR, "tokens.json");
const STATES_DIR = path.join(ACCOUNTS_DIR, "states");
const TOKEN_TTL_MS = 30 * 24 * 3600 * 1000;
const USERNAME_RE = /^[A-Za-z0-9_\u4e00-\u9fa5]{2,20}$/;

function ensureDir(p) { try { fs.mkdirSync(p, { recursive: true }); } catch (_) {} }
function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (_) { return fallback; }
}
function writeJson(p, obj) {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, JSON.stringify(obj), "utf8");
}
function userIdOf(username) {
  return crypto.createHash("sha256").update(String(username).toLowerCase()).digest("hex").slice(0, 32);
}
function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 64, { N: 16384 }).toString("hex");
}
function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}
function issueToken(user) {
  const tokens = readJson(TOKENS_PATH, {});
  const now = Date.now();
  for (const [t, info] of Object.entries(tokens)) {
    if (!info || info.exp < now) delete tokens[t];
  }
  const token = crypto.randomBytes(32).toString("hex");
  tokens[token] = { user: user, exp: now + TOKEN_TTL_MS };
  writeJson(TOKENS_PATH, tokens);
  return token;
}
function userFromToken(req) {
  const h = String(req.headers["authorization"] || "");
  const m = /^Bearer\s+([a-f0-9]{16,128})$/i.exec(h.trim());
  if (!m) return null;
  const tokens = readJson(TOKENS_PATH, {});
  const info = tokens[m[1]];
  if (!info || info.exp < Date.now()) return null;
  const users = readJson(USERS_PATH, {});
  if (!users[info.user]) return null;
  return info.user;
}
function statePathOf(user) { return path.join(STATES_DIR, user + ".json"); }
function readUserState(user) {
  const raw = readJson(statePathOf(user), null);
  if (!raw || typeof raw !== "object") return {};
  /* 落盘格式是 {state, savedAt}，对外只返回里面的 state */
  return (raw.state && typeof raw.state === "object") ? raw.state : raw;
}

async function handleRegister(req, res) {
  let body;
  try { body = JSON.parse(await readBody(req, 4e5)); } catch (_) { sendJson(res, 400, { error: "请求格式不正确" }); return; }
  const username = String(body.username || "").trim();
  const password = String(body.password || "");
  if (!USERNAME_RE.test(username)) { sendJson(res, 400, { error: "用户名需 2–20 位，只能用中英文、数字或下划线" }); return; }
  if (password.length < 6) { sendJson(res, 400, { error: "密码至少 6 位" }); return; }
  const key = userIdOf(username);
  const users = readJson(USERS_PATH, {});
  if (users[key]) { sendJson(res, 409, { error: "这个用户名已经被注册了，换个名字或直接登录" }); return; }
  const salt = crypto.randomBytes(16).toString("hex");
  users[key] = { username, salt, hash: hashPassword(password, salt), createdAt: new Date().toISOString() };
  writeJson(USERS_PATH, users);
  sendJson(res, 200, { token: issueToken(key), username });
}

async function handleLogin(req, res) {
  let body;
  try { body = JSON.parse(await readBody(req, 4e5)); } catch (_) { sendJson(res, 400, { error: "请求格式不正确" }); return; }
  const username = String(body.username || "").trim();
  const password = String(body.password || "");
  const users = readJson(USERS_PATH, {});
  const user = users[userIdOf(username)];
  if (!user || !safeEqual(hashPassword(password, user.salt), user.hash)) {
    sendJson(res, 401, { error: "用户名或密码不正确" });
    return;
  }
  sendJson(res, 200, { token: issueToken(userIdOf(username)), username: user.username });
}

async function handleSaveState(req, res) {
  const user = userFromToken(req);
  if (!user) { sendJson(res, 401, { error: "登录已失效，请重新登录" }); return; }
  let body;
  try { body = JSON.parse(await readBody(req, 8e6)); } catch (_) { sendJson(res, 400, { error: "请求体过大或格式不正确" }); return; }
  const state = (body && typeof body.state === "object" && body.state) || {};
  writeJson(statePathOf(user), { state, savedAt: new Date().toISOString() });
  const users = readJson(USERS_PATH, {});
  sendJson(res, 200, { ok: true, savedAt: new Date().toISOString(), username: (users[user] && users[user].username) || "" });
}

function serveStatic(req, res, urlPath) {
  /* 安全：只对外提供白名单内的文件。
     config.json / server.js / .git / 审核补丁等一律 404，
     防止部署到公网后密钥或内部资料被直接下载。 */
  let filePath = urlPath === "/" ? "/index.html" : decodeURIComponent(urlPath);
  filePath = path.posix.normalize(filePath.replace(/\\/g, "/"));
  if (filePath.includes("..")) { res.writeHead(404); res.end("Not Found"); return; }
  const rel = filePath.startsWith("/") ? filePath : "/" + filePath;
  if (!PUBLIC_FILES.has(rel)) { res.writeHead(404); res.end("Not Found"); return; }
  const abs = path.join(ROOT, rel);
  const ext = path.extname(rel).toLowerCase();
  fs.readFile(abs, (err, buf) => {
    if (err) { res.writeHead(404); res.end("Not Found"); return; }
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(buf);
  });
}

async function handleChat(req, res) {
  const cfg = loadConfig();
  if (!cfg.apiBase || !cfg.apiKey || cfg.apiKey.includes("在此填入")) {
    sendJson(res, 500, { error: "后端未配置有效的 API 密钥，请编辑 config.json 填入 apiKey（保存后立即生效，无需重启）。" });
    return;
  }

  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch (e) {
    sendJson(res, 400, { error: "请求体不是合法 JSON" });
    return;
  }
  if (!Array.isArray(payload.messages)) {
    sendJson(res, 400, { error: "缺少 messages 字段" });
    return;
  }

  let upstream;
  try {
    upstream = await fetch(cfg.apiBase + "/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + cfg.apiKey
      },
      body: JSON.stringify({
        model: cfg.model,
        messages: payload.messages,
        stream: true,
        temperature: typeof payload.temperature === "number" ? payload.temperature : 0.8,
        ...(Number.isInteger(payload.max_tokens) && payload.max_tokens > 0
          ? { max_tokens: Math.min(payload.max_tokens, 8192) } : {})
      })
    });
  } catch (err) {
    sendJson(res, 502, { error: "无法连接上游大模型接口：" + err.message });
    return;
  }

  if (!upstream.ok) {
    const t = await upstream.text().catch(() => "");
    sendJson(res, upstream.status, { error: "上游接口返回错误 " + upstream.status + "：" + t.slice(0, 300) });
    return;
  }

  /* SSE 流式透传 */
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "Access-Control-Allow-Origin": "*"
  });
  try {
    for await (const chunk of upstream.body) {
      res.write(Buffer.from(chunk));
    }
  } catch (e) { /* 上游中断，直接结束 */ }
  res.end();
}

const server = http.createServer(async (req, res) => {
  const urlPath = req.url.split("?")[0];

  /* CORS 预检（兼容非同源调试场景） */
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,Authorization"
    });
    res.end();
    return;
  }

  if (req.method === "GET" && urlPath === "/api/config") {
    const cfg = loadConfig();
    sendJson(res, 200, {
      configured: !!(cfg.apiBase && cfg.apiKey && !cfg.apiKey.includes("在此填入")),
      model: cfg.model,
      apiBase: cfg.apiBase
    });
    return;
  }

  // 不读取或返回任何账号资料；即使没有大模型密钥也可验证账号服务已上线。
  if (req.method === "GET" && urlPath === "/api/health") {
    sendJson(res, 200, { service: "englishmurdermystery", accounts: true });
    return;
  }

  if (req.method === "POST" && urlPath === "/api/chat") {
    await handleChat(req, res);
    return;
  }

  /* ===== 账号与云端学习数据 ===== */
  if (req.method === "POST" && urlPath === "/api/auth/register") { await handleRegister(req, res); return; }
  if (req.method === "POST" && urlPath === "/api/auth/login") { await handleLogin(req, res); return; }
  if (urlPath === "/api/state") {
    const user = userFromToken(req);
    if (!user) { sendJson(res, 401, { error: "登录已失效，请重新登录" }); return; }
    if (req.method === "GET") {
      const users = readJson(USERS_PATH, {});
      sendJson(res, 200, { username: (users[user] && users[user].username) || "", state: readUserState(user) });
      return;
    }
    if (req.method === "POST") { await handleSaveState(req, res); return; }
    res.writeHead(405); res.end("Method Not Allowed");
    return;
  }

  if (req.method === "GET") {
    serveStatic(req, res, urlPath);
    return;
  }

  res.writeHead(405); res.end("Method Not Allowed");
});

server.listen(PORT, HOST, () => {
  console.log("===============================================");
  console.log("  沉浸式 AI 剧本杀语言学习助手 · 后端已启动");
  console.log("  模式: " + (IS_CLOUD ? "云托管（监听 0.0.0.0:" + PORT + "）" : "本地（http://127.0.0.1:" + PORT + "）"));
  console.log("  密钥配置: config.json / /etc/secrets/config.json / 环境变量");
  console.log("===============================================");
  /* 本地 Windows 启动时自动打开浏览器 */
  if (!IS_CLOUD && process.platform === "win32") exec('start "" "http://127.0.0.1:' + PORT + '"');
});
