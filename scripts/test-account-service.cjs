// Real temporary account storage + simulated Pages origin. Never touches real accounts or paid APIs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { test } = require('node:test');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
let playwright;
try { playwright = require('playwright'); }
catch { playwright = require(path.join(process.env.USERPROFILE, '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')); }

async function startServer(accountDir) {
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const child = spawn(process.execPath, ['server.js'], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(port), ACCOUNT_DATA_DIR: accountDir } });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Test server did not start')), 10000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', () => { clearTimeout(timeout); reject(new Error('Test server exited')); });
    child.stdout.on('data', data => { if (data.toString().includes('后端已启动')) { clearTimeout(timeout); resolve(); } });
  });
  return { base: 'http://127.0.0.1:' + port, async stop() {
    if (child.exitCode != null) return;
    await new Promise(resolve => { child.once('exit', resolve); child.kill(); });
  } };
}
async function api(base, endpoint, method = 'GET', body, token) {
  const res = await fetch(base + endpoint, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, data: await res.json() };
}
async function browserPage({ service = '', server, legacy = false, brokenState = false, brokenLogin = false, saved = null } = {}) {
  const browser = await playwright.chromium.launch({ headless: true, channel: 'msedge' });
  const page = await browser.newPage();
  const requests = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    requests.push({ url: url.href, method: req.method() });
    const isService = url.origin === service || (!service && server && url.origin === 'https://learner.example');
    if (isService && url.pathname.startsWith('/api/')) {
      if (legacy && url.pathname === '/api/health') return route.fulfill({ status: 404, contentType: 'text/html', body: '<html>Not Found</html>' });
      if (brokenState && url.pathname === '/api/state' && req.headers().authorization) {
        return route.fulfill({ status: 502, contentType: 'text/html', body: '<html>Service unavailable</html>' });
      }
      if (brokenLogin && url.pathname === '/api/auth/login') {
        return route.fulfill({ status: 502, contentType: 'text/html', body: '<html>Login service unavailable</html>' });
      }
      const response = await fetch(server.base + url.pathname, { method: req.method(), headers: {
        'Content-Type': 'application/json', ...(req.headers().authorization ? { Authorization: req.headers().authorization } : {})
      }, ...(req.postData() ? { body: req.postData() } : {}) });
      return route.fulfill({ status: response.status, headers: { 'content-type': response.headers.get('content-type') || 'application/json',
        'access-control-allow-origin': '*', 'access-control-allow-headers': 'Content-Type,Authorization', 'access-control-allow-methods': 'GET,POST,OPTIONS' }, body: await response.text() });
    }
    if (url.origin === 'https://learner.example' && url.pathname === '/Englishmurdermystery/index.html') {
      return route.fulfill({ contentType: 'text/html', body: html });
    }
    if (url.pathname === '/Englishmurdermystery/site-config.json') return route.fulfill({ json: { accountApiBase: service } });
    const data = '/Englishmurdermystery/data/daily/';
    if (url.pathname.startsWith(data) && /^[A-Za-z0-9_.-]+$/.test(url.pathname.slice(data.length))) {
      const file = path.join(root, 'data/daily', url.pathname.slice(data.length));
      if (fs.existsSync(file)) return route.fulfill({ contentType: file.endsWith('.jsonl') ? 'application/x-ndjson' : 'application/json', body: fs.readFileSync(file) });
    }
    return route.fulfill({ status: 404, contentType: 'text/html', body: '<html><head><title>GitHub Pages 404</title></head></html>' });
  });
  if (saved) await page.addInitScript(saved => {
    localStorage.setItem('wp_account_v1', JSON.stringify(saved));
    localStorage.setItem('account-test-sentinel', 'keep');
  }, saved);
  await page.goto('https://learner.example/Englishmurdermystery/index.html');
  await page.waitForFunction(() => accountService.status !== 'checking' && EXAM_LEXICON.ready);
  return { browser, page, requests, errors };
}

test('actual service: register, old account login, disk persistence, CORS and private files', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'english-accounts-test-'));
  let server;
  try {
    server = await startServer(temp);
    assert.deepEqual((await api(server.base, '/api/health')).data, { service: 'englishmurdermystery', accounts: true });
    const signup = await api(server.base, '/api/auth/register', 'POST', { username: 'old_account', password: 'test-pass-123' });
    assert.equal(signup.status, 200);
    const token = signup.data.token;
    const state = { campaign: { completed: {}, usedWords: ['gift'] }, vocabBook: [], learningVocab: [], scriptHistory: [] };
    assert.equal((await api(server.base, '/api/state', 'POST', { state }, token)).status, 200);
    assert.equal((await api(server.base, '/api/auth/register', 'POST', { username: 'old_account', password: 'test-pass-123' })).status, 409);
    assert.equal((await api(server.base, '/api/auth/login', 'POST', { username: 'old_account', password: 'wrong-pass' })).status, 401);
    assert.equal((await fetch(server.base + '/api/state', { method: 'OPTIONS', headers: { Origin: 'https://learner.example' } })).status, 204);
    for (const file of ['/data/accounts/users.json', '/users.json', '/server.js', '/config.json']) {
      assert.equal((await fetch(server.base + file)).status, 404);
    }
    await server.stop();
    server = await startServer(temp);
    assert.equal((await api(server.base, '/api/state', 'GET', null, token)).data.state.campaign.usedWords[0], 'gift');
    const login = await api(server.base, '/api/auth/login', 'POST', { username: 'old_account', password: 'test-pass-123' });
    assert.equal(login.status, 200);
    assert.equal((await api(server.base, '/api/state', 'GET', null, login.data.token)).data.state.campaign.usedWords[0], 'gift');
    const stored = JSON.parse(fs.readFileSync(path.join(temp, 'users.json'), 'utf8'));
    assert.ok(Object.values(stored).every(u => !Object.values(u).includes('test-pass-123') && u.hash && u.salt));
  } finally {
    if (server) await server.stop();
    assert.equal(path.dirname(temp), os.tmpdir());
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('Pages without backend: explains unavailability, never posts credentials, preserves saved session and records', async () => {
  const saved = { token: 'a'.repeat(64), username: 'old_account' };
  const { browser, page, requests, errors } = await browserPage({ saved });
  try {
    await page.locator('#account-bar button').click();
    await page.waitForFunction(() => accountService.status === 'unavailable');
    await page.locator('#auth-username').fill('old_account');
    await page.locator('#auth-password').fill('test-pass-123');
    await page.locator('#auth-password').press('Enter');
    assert.equal(await page.locator('#auth-submit').isDisabled(), true);
    assert.match(await page.locator('#auth-msg').innerText(), /尚未连接账号服务/);
    assert.match(await page.locator('#auth-local-help').innerText(), /启动.bat/);
    assert.ok(!requests.some(r => r.method === 'POST'));
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('wp_account_v1')).token), saved.token);
    assert.equal(await page.evaluate(() => localStorage.getItem('account-test-sentinel')), 'keep');
    assert.ok(!/Unexpected token|not valid JSON/.test(await page.locator('#auth-modal').innerText()));
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('Pages with independent service: existing account, new registration, record sync and session restore', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'english-accounts-ui-'));
  const server = await startServer(temp);
  const credentials = { username: 'migrated_account', password: 'test-pass-123' };
  const signup = await api(server.base, '/api/auth/register', 'POST', credentials);
  await api(server.base, '/api/state', 'POST', { state: { campaign: { completed: {}, usedWords: ['record'] }, vocabBook: [], learningVocab: [], scriptHistory: [] } }, signup.data.token);
  const { browser, page, requests, errors } = await browserPage({ service: 'https://accounts.example', server });
  try {
    await page.locator('#account-bar button').click();
    await page.locator('#auth-username').fill(credentials.username);
    await page.locator('#auth-password').fill(credentials.password);
    await page.locator('#auth-submit').click();
    await page.waitForFunction(() => authInfo && accountSyncReady && document.getElementById('account-bar').textContent.includes('migrated_account'));
    assert.match(await page.locator('#account-bar').innerText(), /migrated_account/);
    assert.ok(await page.evaluate(() => loadCampaignState().usedWords.includes('record')));
    assert.ok(requests.some(r => r.url === 'https://accounts.example/api/auth/login'));
    assert.ok(!requests.some(r => r.method === 'POST' && r.url.startsWith('https://learner.example')));
    await page.reload();
    await page.waitForFunction(() => authInfo && accountSyncReady);
    assert.match(await page.locator('#account-bar').innerText(), /migrated_account/);
    await page.locator('#account-bar button').click();
    await page.locator('#account-bar button').click();
    await page.locator('#auth-switch').click();
    await page.locator('#auth-username').fill('new_account');
    await page.locator('#auth-password').fill('new-pass-123');
    await page.locator('#auth-submit').click();
    await page.waitForFunction(() => authInfo && authInfo.username === 'new_account' && accountSyncReady && document.getElementById('account-bar').textContent.includes('new_account'));
    assert.equal((await api(server.base, '/api/auth/login', 'POST', { username: 'new_account', password: 'new-pass-123' })).status, 200);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close(); await server.stop();
    assert.equal(path.dirname(temp), os.tmpdir());
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('legacy local service is detected independently of the model configuration', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'english-accounts-legacy-'));
  const server = await startServer(temp);
  const { browser, page, errors } = await browserPage({ server, legacy: true });
  try {
    assert.equal(await page.evaluate(() => cloudApiReady()), true);
    await page.locator('#account-bar button').click();
    assert.equal(await page.locator('#auth-submit').isEnabled(), true);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close(); await server.stop();
    assert.equal(path.dirname(temp), os.tmpdir());
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('HTML response during login cannot overwrite state or discard a valid saved token', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'english-accounts-outage-'));
  const server = await startServer(temp);
  const signup = await api(server.base, '/api/auth/register', 'POST', { username: 'valid_user', password: 'test-pass-123' });
  const saved = { token: signup.data.token, username: 'valid_user', service: 'https://accounts.example' };
  const { browser, page, requests, errors } = await browserPage({ service: 'https://accounts.example', server, brokenState: true, saved });
  try {
    await page.waitForFunction(() => authInfo !== null);
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('wp_account_v1')).token), saved.token);
    assert.equal(await page.evaluate(() => accountSyncReady), false);
    assert.ok(!requests.some(r => r.method === 'POST' && r.url.endsWith('/api/state')));
    assert.deepEqual(errors, []);
  } finally {
    await browser.close(); await server.stop();
    assert.equal(path.dirname(temp), os.tmpdir());
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('HTML from the login endpoint produces a readable message and does not create a session', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'english-accounts-html-'));
  const server = await startServer(temp);
  const { browser, page, errors } = await browserPage({ service: 'https://accounts.example', server, brokenLogin: true });
  try {
    await page.locator('#account-bar button').click();
    await page.locator('#auth-username').fill('old_account');
    await page.locator('#auth-password').fill('test-pass-123');
    await page.locator('#auth-submit').click();
    await page.waitForFunction(() => !authSubmitting);
    assert.match(await page.locator('#auth-msg').innerText(), /网页或无效数据/);
    assert.ok(!/Unexpected token|not valid JSON/.test(await page.locator('#auth-msg').innerText()));
    assert.equal(await page.evaluate(() => authInfo), null);
    assert.equal(await page.evaluate(() => localStorage.getItem('wp_account_v1')), null);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close(); await server.stop();
    assert.equal(path.dirname(temp), os.tmpdir());
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
