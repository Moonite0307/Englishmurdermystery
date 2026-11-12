// Runs the real Worker/D1 locally in workerd; no Cloudflare account, network, or real user data required.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { Miniflare, convertV4MiniflareOptions } = require('miniflare');
const { buildMigration } = require('./export-cloudflare-accounts.cjs');
const root = path.resolve(__dirname, '..');
const schema = fs.readFileSync(path.join(root, 'cloudflare/schema.sql'), 'utf8');
const origin = 'https://moonite0307.github.io';
const bundle = require('esbuild').buildSync({ entryPoints: [path.join(root, 'cloudflare/worker.mjs')], bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['node:*'] }).outputFiles[0].text;
function runtime(storage, model = {}) {
  const options = convertV4MiniflareOptions({ name: 'accounts-test-worker', modules: true, script: bundle,
    compatibilityDate: '2026-11-09', compatibilityFlags: ['nodejs_compat'],
    d1Databases: { DB: 'accounts-test' }, d1Persist: storage,
    bindings: { ALLOWED_ORIGINS: origin, ...model.bindings }, ...(model.outboundService ? { outboundService: model.outboundService } : {}) });
  options.resourcePersistencePath = storage;
  return new Miniflare(options);
}
async function prepare(mf) {
  const db = await mf.getD1Database('DB');
  for (const statement of schema.split(';').map(s => s.trim()).filter(Boolean)) await db.prepare(statement).run();
  return db;
}
async function request(mf, url, method = 'GET', body, token, source = origin) {
  const res = await mf.dispatchFetch('https://accounts.example' + url, { method,
    headers: { Origin: source, 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, headers: res.headers, data: res.status === 204 ? null : await res.json() };
}

test('private model proxy enforces sessions and quotas, sanitizes streams and never exposes its secret', async () => {
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'english-model-proxy-'));
  const secret = 'test-private-provider-value-never-public';
  let calls = 0, behavior = 'normal';
  const mf = runtime(storage, { bindings: { MODEL_API_KEY: secret, MODEL_DAILY_REQUEST_LIMIT: '3' }, outboundService: async req => {
    calls++;
    assert.equal(req.url, 'https://api.deepseek.com/chat/completions');
    assert.equal(req.headers.get('authorization'), 'Bearer ' + secret);
    const body = await req.json();
    assert.equal(body.max_tokens, 8192); assert.equal(body.model, 'deepseek-chat');
    assert.equal(body.apiKey, undefined); assert.equal(body.tools, undefined);
    if (behavior === 'error') return new Response(secret, { status: 401 });
    const pieces = behavior === 'echo' ? [secret.slice(0, 9), secret.slice(9)] : ['Hello detective.'];
    return new Response(pieces.map(content => 'data: ' + JSON.stringify({ choices: [{ delta: { content } }] }) + '\n\n').join('') +
      'data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
  } });
  try {
    const db = await prepare(mf);
    const status = await request(mf, '/api/config');
    assert.deepEqual(status.data, { configured: true, modelAuth: 'play-session' });
    assert.ok(!JSON.stringify(status).includes(secret));
    const payload = { messages: [{ role: 'user', content: 'Hello' }], max_tokens: 99999, apiKey: 'ignored', tools: [{}] };
    assert.equal((await request(mf, '/api/chat', 'POST', payload)).status, 401);
    assert.equal(calls, 0);
    const lease = await request(mf, '/api/play-session', 'POST', {});
    assert.match(lease.data.token, /^play_[a-f0-9]{64}$/);
    const ask = async (token = lease.data.token, ip = '') => {
      const res = await mf.dispatchFetch('https://accounts.example/api/chat', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, ...(ip ? { 'cf-connecting-ip': ip } : {}) }, body: JSON.stringify(payload) });
      return { status: res.status, text: await res.text() };
    };
    assert.equal((await ask(lease.data.token, '198.51.100.20')).status, 401);
    assert.equal(calls, 0);
    const normal = await ask(); assert.equal(normal.status, 200, JSON.stringify({ ...normal, calls })); assert.match(normal.text, /Hello detective/);
    behavior = 'echo'; const echoed = await ask(); assert.ok(!echoed.text.includes(secret)); assert.match(echoed.text, /redacted/);
    behavior = 'error'; const failed = await ask(); assert.equal(failed.status, 502); assert.ok(!failed.text.includes(secret));
    assert.equal((await ask()).status, 429); assert.equal(calls, 3);
    await db.prepare('UPDATE play_sessions SET expires_at=0').run();
    assert.equal((await ask()).status, 401);
  } finally { await mf.dispose(); fs.rmSync(storage, { recursive: true, force: true }); }
});

test('free Worker: health, native password verification, state isolation, expiry, CORS and persistent restart', async () => {
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'english-cloudflare-test-'));
  let mf = runtime(storage);
  try {
    const db = await prepare(mf);
    assert.equal((await request(mf, '/api/health')).data.accounts, true);
    const credentials = { username: 'Alice', password: 'password-test-123' };
    const signup = await request(mf, '/api/auth/register', 'POST', credentials);
    assert.equal(signup.status, 200, JSON.stringify(signup.data));
    assert.match(signup.data.token, /^[a-f0-9]{64}$/);
    const token = signup.data.token;
    assert.equal((await request(mf, '/api/auth/register', 'POST', { ...credentials, username: 'ALICE' })).status, 409);
    assert.equal((await request(mf, '/api/auth/login', 'POST', { ...credentials, password: 'wrong-password' })).status, 401);
    const login = await request(mf, '/api/auth/login', 'POST', { ...credentials, username: 'alice' });
    assert.equal(login.status, 200);
    assert.equal(login.data.username, 'Alice');
    const state = { vocabBook: [['gift', { meaning: '礼物' }]], campaign: { completed: {}, usedWords: ['gift'] }, scriptHistory: [{ id: 'one', scriptName: '故事' }] };
    assert.equal((await request(mf, '/api/state', 'POST', { state }, token)).status, 200);
    assert.deepEqual((await request(mf, '/api/state', 'GET', null, login.data.token)).data.state, state);
    const second = await request(mf, '/api/auth/register', 'POST', { username: 'Bob', password: 'second-password' });
    assert.deepEqual((await request(mf, '/api/state', 'GET', null, second.data.token)).data.state, {});
    assert.equal((await request(mf, '/api/state')).status, 401);
    assert.equal((await request(mf, '/api/auth/login', 'POST', credentials, null, 'https://evil.invalid')).status, 403);
    const preflight = await request(mf, '/api/state', 'OPTIONS');
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), origin);
    for (const url of ['/users.json', '/data/accounts/users.json', '/config.json']) assert.equal((await request(mf, url)).status, 404);
    assert.equal((await request(mf, '/api/state', 'POST', { state: [] }, token)).status, 400);
    assert.equal((await request(mf, '/api/state', 'POST', { state: { text: 'x'.repeat(1500000) } }, token)).status, 413);
    const restored = await request(mf, '/api/state', 'GET', null, token);
    assert.equal(restored.status, 200, JSON.stringify(restored.data));
    assert.deepEqual(restored.data.state, state);
    const row = await db.prepare('SELECT password_hash,salt FROM users WHERE username=?').bind('Alice').first();
    assert.equal(row.password_hash, crypto.scryptSync(credentials.password, row.salt, 64, { N: 16384 }).toString('hex'));
    assert.equal(await db.prepare('SELECT token_hash FROM sessions WHERE token_hash=?').bind(token).first(), null);
    const tokenHash = crypto.createHash('sha256').update(second.data.token).digest('hex');
    await db.prepare('UPDATE sessions SET expires_at=0 WHERE token_hash=?').bind(tokenHash).run();
    assert.equal((await request(mf, '/api/state', 'GET', null, second.data.token)).status, 401);
    await mf.dispose(); mf = runtime(storage);
    assert.deepEqual((await request(mf, '/api/state', 'GET', null, token)).data.state, state);
  } finally {
    await mf.dispose();
    assert.equal(path.dirname(storage), os.tmpdir());
    fs.rmSync(storage, { recursive: true, force: true });
  }
});

test('private migration preserves original password, quoted Unicode and long records; duplicates cannot overwrite', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'english-cloudflare-migration-'));
  const storage = path.join(temp, 'db');
  const mf = runtime(storage);
  try {
    const accounts = path.join(temp, 'accounts'); fs.mkdirSync(path.join(accounts, 'states'), { recursive: true });
    const username = '原账号_test', password = 'old-password-123', salt = '1234567890abcdef1234567890abcdef';
    const id = crypto.createHash('sha256').update(username.toLowerCase()).digest('hex').slice(0, 32);
    const user = { username, salt, hash: crypto.scryptSync(password, salt, 64, { N: 16384 }).toString('hex'), createdAt: '2026-11-01T00:00:00.000Z' };
    const state = { vocabBook: [], learningVocab: [], scriptHistory: [{ id: 'story', text: "This is Alice's 🎭 台词。".repeat(5000) }] };
    const original = JSON.stringify({ [id]: user });
    fs.writeFileSync(path.join(accounts, 'users.json'), original);
    fs.writeFileSync(path.join(accounts, 'states', id + '.json'), JSON.stringify({ state, savedAt: user.createdAt }));
    const migration = buildMigration(accounts);
    assert.equal(migration.count, 1);
    const db = await prepare(mf);
    // Each SQL statement is a full line; quoted newlines are represented as JSON escapes.
    const statements = migration.sql.split('\n').filter(line => line && !line.startsWith('--'));
    for (const sql of statements) { assert.ok(Buffer.byteLength(sql) < 100000); await db.prepare(sql).run(); }
    const login = await request(mf, '/api/auth/login', 'POST', { username, password });
    assert.equal(login.status, 200, JSON.stringify(login.data));
    assert.deepEqual((await request(mf, '/api/state', 'GET', null, login.data.token)).data.state, state);
    await assert.rejects(db.prepare(statements[0]).run(), /UNIQUE/);
    assert.equal(fs.readFileSync(path.join(accounts, 'users.json'), 'utf8'), original);
    assert.equal((await request(mf, '/api/auth/login', 'POST', { username, password: 'incorrect' })).status, 401);
  } finally {
    await mf.dispose();
    assert.equal(path.dirname(temp), os.tmpdir()); fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('authentication is throttled within the free service instead of exhausting unlimited password work', async () => {
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'english-cloudflare-limit-'));
  const mf = runtime(storage);
  try {
    const db = await prepare(mf);
    await request(mf, '/api/auth/login', 'POST', { username: 'Alice', password: 'test-password' });
    await db.prepare('UPDATE auth_limits SET hits=20').run();
    assert.equal((await request(mf, '/api/auth/login', 'POST', { username: 'Alice', password: 'test-password' })).status, 429);
  } finally {
    await mf.dispose(); assert.equal(path.dirname(storage), os.tmpdir()); fs.rmSync(storage, { recursive: true, force: true });
  }
});
