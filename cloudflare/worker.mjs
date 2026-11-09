import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(scrypt);
const TTL = 30 * 24 * 3600 * 1000;
const MAX_BODY = 1500000; // Below D1's 2 MB per-cell limit; never silently truncate records.
const USERNAME = /^[A-Za-z0-9_\u4e00-\u9fa5]{2,20}$/;
const digest = value => createHash('sha256').update(value).digest('hex');
const userId = name => digest(name.toLowerCase()).slice(0, 32);

function equalHex(left, right) {
  const a = Buffer.from(left, 'hex'), b = Buffer.from(right, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
async function passwordHash(password, salt) {
  // Exactly matches the original local server, including its UTF-8 hexadecimal salt string.
  // Use the runtime's asynchronous native implementation, not a JavaScript password loop.
  return (await derive(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })).toString('hex');
}
async function readBody(request) {
  if (Number(request.headers.get('content-length')) > MAX_BODY) throw new Error('BODY_LIMIT');
  const reader = request.body?.getReader();
  if (!reader) throw new Error('BAD_BODY');
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY) { await reader.cancel(); throw new Error('BODY_LIMIT'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let body;
  try { body = JSON.parse(new TextDecoder().decode(bytes)); } catch (_) { throw new Error('BAD_BODY'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('BAD_BODY');
  return body;
}
async function sessionUser(request, db) {
  const token = /^Bearer\s+([a-f0-9]{64})$/i.exec(request.headers.get('authorization') || '')?.[1];
  if (!token) return null;
  return db.prepare('SELECT u.id, u.username FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?')
    .bind(digest(token), Date.now()).first();
}
function sessionRecord(id) {
  const token = randomBytes(32).toString('hex');
  return { token, hash: digest(token), id, expiry: Date.now() + TTL };
}
async function issueSession(db, id) {
  const session = sessionRecord(id);
  await db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)')
    .bind(session.hash, id, session.expiry).run();
  return session.token;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('origin');
    const allowed = new Set((env.ALLOWED_ORIGINS || 'https://moonite0307.github.io').split(',').map(s => s.trim()).filter(Boolean));
    allowed.add(url.origin);
    const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', Vary: 'Origin',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type,Authorization' };
    if (origin && allowed.has(origin)) headers['Access-Control-Allow-Origin'] = origin;
    const json = (status, data) => new Response(JSON.stringify(data), { status, headers });
    if (origin && !allowed.has(origin)) return json(403, { error: '此网站未获准连接账号服务' });
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (!env.DB) return json(503, { error: '账号数据库尚未连接，请完成免费部署步骤' });
    try {
      const db = env.DB;
      if (url.pathname === '/api/health' && request.method === 'GET') {
        await db.prepare('SELECT id FROM users LIMIT 1').first();
        return json(200, { service: 'englishmurdermystery', accounts: true });
      }
      if (['/api/auth/register', '/api/auth/login'].includes(url.pathname) && request.method === 'POST') {
        const body = await readBody(request);
        const username = String(body.username || '').trim(), password = String(body.password || '');
        if (!USERNAME.test(username)) return json(400, { error: '用户名需 2–20 位，只能用中英文、数字或下划线' });
        if (password.length < 6 || password.length > 128) return json(400, { error: '密码需 6–128 位' });
        const window = Math.floor(Date.now() / 900000);
        const bucket = digest((request.headers.get('cf-connecting-ip') || 'local') + ':' + window);
        const limit = await db.prepare('INSERT INTO auth_limits(bucket,hits,expires_at) VALUES(?,1,?) ON CONFLICT(bucket) DO UPDATE SET hits=hits+1 RETURNING hits')
          .bind(bucket, (window + 1) * 900000).first();
        if (limit.hits > 20) return json(429, { error: '登录或注册过于频繁，请十五分钟后重试' });
        const id = userId(username);
        if (url.pathname.endsWith('/register')) {
          if (await db.prepare('SELECT id FROM users WHERE id=?').bind(id).first()) return json(409, { error: '这个用户名已经被注册了，请直接登录' });
          const salt = randomBytes(16).toString('hex');
          const hash = await passwordHash(password, salt);
          const session = sessionRecord(id);
          try {
            await db.batch([
              db.prepare('INSERT INTO users(id,username,salt,password_hash,created_at) VALUES(?,?,?,?,?)').bind(id, username, salt, hash, new Date().toISOString()),
              db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').bind(session.hash, id, session.expiry)
            ]);
          } catch (error) {
            if (/UNIQUE constraint/i.test(String(error))) return json(409, { error: '这个用户名已经被注册了，请直接登录' });
            throw error;
          }
          return json(200, { token: session.token, username });
        }
        const user = await db.prepare('SELECT * FROM users WHERE id=?').bind(id).first();
        const hash = await passwordHash(password, user?.salt || '00000000000000000000000000000000');
        if (!user || !equalHex(hash, user.password_hash)) return json(401, { error: '用户名或密码不正确' });
        return json(200, { token: await issueSession(db, id), username: user.username });
      }
      if (url.pathname === '/api/state') {
        const user = await sessionUser(request, db);
        if (!user) return json(401, { error: '登录已失效，请重新登录' });
        if (request.method === 'GET') {
          const saved = await db.prepare('SELECT state_json FROM states WHERE user_id=?').bind(user.id).first();
          return json(200, { username: user.username, state: saved ? JSON.parse(saved.state_json) : {} });
        }
        if (request.method === 'POST') {
          const body = await readBody(request);
          if (!body.state || typeof body.state !== 'object' || Array.isArray(body.state)) return json(400, { error: '学习记录格式不正确' });
          const savedAt = new Date().toISOString();
          await db.prepare('INSERT INTO states(user_id,state_json,updated_at) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET state_json=excluded.state_json,updated_at=excluded.updated_at')
            .bind(user.id, JSON.stringify(body.state), savedAt).run();
          return json(200, { ok: true, savedAt, username: user.username });
        }
        return json(405, { error: '请求方式不支持' });
      }
      return json(404, { error: '接口不存在' });
    } catch (error) {
      if (error.message === 'BODY_LIMIT') return json(413, { error: '本次学习记录过大，未覆盖原有记录，请联系网站管理员' });
      if (error.message === 'BAD_BODY') return json(400, { error: '请求格式不正确' });
      // Do not expose database contents, SQL statements, tokens or credential hashes.
      return json(503, { error: '账号服务暂时不可用或已达免费额度，请稍后重试。本机学习记录会保留。' });
    }
  },
  async scheduled(_event, env) {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM sessions WHERE expires_at<=?').bind(Date.now()),
      env.DB.prepare('DELETE FROM auth_limits WHERE expires_at<=?').bind(Date.now())
    ]);
  }
};
