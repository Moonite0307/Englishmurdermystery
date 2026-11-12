import { createHash, randomBytes } from 'node:crypto';

const hash = value => createHash('sha256').update(value).digest('hex');
const ipId = request => hash(request.headers.get('cf-connecting-ip') || 'unknown');
const bounded = (value, fallback, maximum) => Number.isInteger(Number(value)) && Number(value) > 0 ? Math.min(Number(value), maximum) : fallback;
const configured = env => !!env.MODEL_API_KEY;
async function count(db, bucket, limit, expiry) {
  const row = await db.prepare('INSERT INTO model_limits(bucket,hits,expires_at) VALUES(?,1,?) ON CONFLICT(bucket) DO UPDATE SET hits=hits+1 WHERE hits<? RETURNING hits')
    .bind(bucket, expiry, limit).first();
  return !!row;
}

// Only application sessions can spend model credits. Guest sessions are short-lived,
// bound to Cloudflare's client IP and kept in browser memory, never localStorage.
export async function modelRoute(request, env, { json, readBody, sessionUser, headers }) {
  const pathname = new URL(request.url).pathname;
  if (pathname === '/api/config' && request.method === 'GET') return json(200, { configured: configured(env), modelAuth: 'play-session' });
  if (!['/api/chat', '/api/play-session'].includes(pathname)) return null;
  if (request.method !== 'POST') return json(405, { error: '请求方式不支持' });
  if (!configured(env)) return json(503, { error: 'AI 服务尚未配置，请联系管理员。' });
  const now = Date.now(), minute = Math.floor(now / 60000), day = Math.floor(now / 86400000);
  const ip = ipId(request), db = env.DB;
  try {
    if (pathname === '/api/play-session') {
      if (!await count(db, 'lease:' + ip + ':' + Math.floor(now / 3600000), 20, now + 3600000)) return json(429, { error: '进入游戏过于频繁，请稍后重试。' });
      const token = 'play_' + randomBytes(32).toString('hex'), expiresAt = now + 7200000;
      await db.prepare('INSERT INTO play_sessions(token_hash,ip_hash,expires_at) VALUES(?,?,?)').bind(hash(token), ip, expiresAt).run();
      return json(200, { token, expiresAt });
    }
    const bearer = /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization') || '')?.[1] || '';
    let identity = '';
    if (/^play_[a-f0-9]{64}$/.test(bearer)) {
      const guest = await db.prepare('SELECT ip_hash FROM play_sessions WHERE token_hash=? AND expires_at>?').bind(hash(bearer), now).first();
      if (guest?.ip_hash === ip) identity = 'guest:' + ip;
    } else {
      const user = await sessionUser(request, db);
      if (user) identity = 'user:' + user.id;
    }
    if (!identity) return json(401, { error: '游玩会话已失效，请刷新页面或重新登录。' });
    const body = await readBody(request), messages = body.messages;
    if (!Array.isArray(messages) || !messages.length || messages.length > 160 || messages.some(m => !m || !['system', 'user', 'assistant'].includes(m.role) || typeof m.content !== 'string')) return json(400, { error: '对话格式不正确。' });
    const cleanMessages = messages.map(({ role, content }) => ({ role, content }));
    if (new TextEncoder().encode(JSON.stringify(cleanMessages)).byteLength > 240000) return json(413, { error: '本局对话过长，请先保留进度，再开启新剧本。' });
    const globalLimit = bounded(env.MODEL_DAILY_REQUEST_LIMIT, 200, 2000);
    const ipLimit = bounded(env.MODEL_IP_DAILY_LIMIT, 100, 1000);
    const userLimit = bounded(env.MODEL_PLAYER_DAILY_LIMIT, 80, 1000);
    if (!await count(db, 'minute:' + ip + ':' + minute, 12, (minute + 1) * 60000) ||
        !await count(db, 'player:' + identity + ':' + day, userLimit, (day + 1) * 86400000) ||
        !await count(db, 'ip:' + ip + ':' + day, ipLimit, (day + 1) * 86400000) ||
        !await count(db, 'global:' + day, globalLimit, (day + 1) * 86400000)) return json(429, { error: '已达到当前游玩用量上限，请稍后或明天再来。已有进度可以保留。' });
    // The caller cannot choose the upstream, model, API key, tools or token ceiling.
    const payload = { model: env.MODEL_NAME || 'deepseek-chat', messages: cleanMessages, stream: true,
      max_tokens: bounded(body.max_tokens, 4096, 8192), temperature: Number.isFinite(body.temperature) ? Math.max(0, Math.min(body.temperature, 1)) : 0.8 };
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 180000);
    let upstream;
    try {
      upstream = await fetch('https://api.deepseek.com/chat/completions', { method: 'POST', signal: abort.signal, redirect: 'manual',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + env.MODEL_API_KEY }, body: JSON.stringify(payload) });
    } catch (_) { clearTimeout(timer); return json(502, { error: 'AI 服务连接暂时失败，请稍后重试。' }); }
    if (!upstream.ok) {
      await upstream.body?.cancel(); clearTimeout(timer);
      return json(502, { error: [401, 402, 403].includes(upstream.status) ? 'AI 服务配置或额度暂时不可用，请联系管理员。' : 'AI 服务繁忙，请稍后重试。' });
    }
    // Rebuild SSE frames rather than forwarding provider error bodies or headers.
    // Hold a small suffix so even a credential split across deltas is redacted.
    const secret = String(env.MODEL_API_KEY), reader = upstream.body.getReader();
    const encoder = new TextEncoder(), decoder = new TextDecoder();
    let pending = '', buffered = '', completed = false, bytes = 0;
    const stream = new ReadableStream({
      async start(controller) {
        const event = data => controller.enqueue(encoder.encode('data: ' + JSON.stringify(data) + '\n\n'));
        const text = (value, flush = false) => {
          pending = (pending + value).split(secret).join('[redacted]');
          const end = flush ? pending.length : Math.max(0, pending.length - secret.length + 1);
          if (end) { event({ choices: [{ delta: { content: pending.slice(0, end) } }] }); pending = pending.slice(end); }
        };
        const line = value => {
          if (!value.startsWith('data:')) return;
          const data = value.slice(5).trim();
          if (data === '[DONE]') return;
          let parsed; try { parsed = JSON.parse(data); } catch (_) { return; }
          if (parsed.error) throw new Error('UPSTREAM');
          const choice = parsed.choices?.[0];
          const content = choice?.delta?.content || choice?.message?.content;
          if (typeof content === 'string') text(content);
          if (choice?.finish_reason) { text('', true); event({ choices: [{ delta: {}, finish_reason: choice.finish_reason }] }); completed = true; }
        };
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.byteLength;
            if (bytes > 2000000) throw new Error('STREAM_LIMIT');
            buffered += decoder.decode(value, { stream: true });
            const lines = buffered.split('\n'); buffered = lines.pop();
            for (const item of lines) line(item.trim());
          }
          buffered += decoder.decode(); if (buffered.trim()) line(buffered.trim());
          text('', true);
          if (!completed) throw new Error('INCOMPLETE_STREAM');
          controller.enqueue(encoder.encode('data: [DONE]\n\n')); controller.close();
        } catch (_) {
          try { event({ error: { message: '模型生成中断，请稍后重试。' } }); controller.close(); } catch (_) {}
          abort.abort();
        } finally { clearTimeout(timer); await reader.cancel().catch(() => {}); }
      },
      cancel() { clearTimeout(timer); abort.abort(); return reader.cancel().catch(() => {}); }
    });
    return new Response(stream, { headers: { ...headers, 'Content-Type': 'text/event-stream; charset=utf-8', 'X-Content-Type-Options': 'nosniff' } });
  } catch (_) { return json(503, { error: '游玩服务暂时不可用，请稍后重试。' }); }
}
