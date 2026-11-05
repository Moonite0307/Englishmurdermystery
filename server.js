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
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

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

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > 2e6) req.destroy(); });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function serveStatic(req, res, urlPath) {
  /* 安全：只对外提供 index.html。
     config.json / server.js / .git / .workbuddy 等一律 404，
     防止部署到公网后密钥文件被直接下载。 */
  let filePath = urlPath === "/" ? "/index.html" : urlPath;
  filePath = path.normalize(decodeURIComponent(filePath)).replace(/^(\.\.[/\\])+/, "");
  const base = path.basename(filePath).toLowerCase();
  const blocked =
    base !== "index.html" ||                 /* 单文件应用，只放行 index.html */
    filePath.includes("..");
  if (blocked) { res.writeHead(404); res.end("Not Found"); return; }
  const abs = path.join(ROOT, filePath);
  fs.readFile(abs, (err, buf) => {
    if (err) { res.writeHead(404); res.end("Not Found"); return; }
    res.writeHead(200, { "Content-Type": MIME[".html"] });
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
        temperature: typeof payload.temperature === "number" ? payload.temperature : 0.8
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
      "Access-Control-Allow-Headers": "Content-Type"
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

  if (req.method === "POST" && urlPath === "/api/chat") {
    await handleChat(req, res);
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
