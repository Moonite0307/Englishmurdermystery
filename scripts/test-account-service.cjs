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
async function browserPage({ service = '', server, legacy = false, brokenState = false, brokenLogin = false, saved = null,
  configOverride = null, apiGate = null, mobile = false, blockedStorage = false, initialStorage = null } = {}) {
  const browser = await playwright.chromium.launch({ headless: true, channel: 'msedge' });
  const page = await browser.newPage(mobile ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/130.0.0.0 Mobile Safari/537.36 MicroMessenger/8.0' } : {});
  const requests = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    requests.push({ url: url.href, method: req.method() });
    const isService = url.origin === service || (!service && server && url.origin === 'https://learner.example');
    if (isService && url.pathname.startsWith('/api/')) {
      if (apiGate && !apiGate.ready) return route.abort();
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
    if (url.pathname === '/Englishmurdermystery/site-config.json') return route.fulfill({ json: configOverride || { accountApiBase: service } });
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
  if (initialStorage) await page.addInitScript(records => {
    if (location.origin === 'null') return;
    if (sessionStorage.getItem('test-records-seeded')) return;
    for (const [key, value] of Object.entries(records)) localStorage.setItem(key, value);
    sessionStorage.setItem('test-records-seeded', 'yes');
  }, initialStorage);
  if (blockedStorage) await page.addInitScript(() => Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('Storage unavailable', 'SecurityError'); } }));
  await page.goto('https://learner.example/Englishmurdermystery/index.html');
  await page.waitForFunction(() => accountService.status !== 'checking' && EXAM_LEXICON.ready);
  return { browser, page, requests, errors };
}

test('signed-in saved game and self-test ratings survive reload and restore the same locked story', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'english-saved-run-'));
  const server = await startServer(temp);
  const credentials = { username: 'saved_player', password: 'test-pass-123' };
  const signup = await api(server.base, '/api/auth/register', 'POST', credentials);
  const saved = { username: credentials.username, token: signup.data.token, service: 'https://accounts.example' };
  const { browser, page, errors } = await browserPage({ server, service: 'https://accounts.example', saved });
  try {
    await page.waitForFunction(() => authInfo && accountSyncReady);
    await page.evaluate(plan => {
      scriptInfo = { ...scriptInfo, genre: '欢乐本', level: '高考', challenge: '简单模式', replyLanguage: 'zh' };
      scriptData = plan; scriptPlan = JSON.stringify(plan);
      setState('PLAYING');
      messages = [{ role: 'system', content: 'LOCKED_STORY ' + scriptPlan }, { role: 'user', content: 'Start' }];
      beginScriptRun();
      const data = { npc_dialogue: 'Please compare the gift and the record.', translation: '比较礼物和记录。', speaker: 'DM',
        grammar_tip: '无', task_type: 'free', options: [], vocab: [], completed_task: 0, completed_tasks: [], game_over: false };
      messages.push({ role: 'assistant', content: JSON.stringify(data) });
      finalizeNpcBubble(addNpcBubble(), data, '');
      taskProgressState.records.set('1:1', new Map([['C1', { quote: 'record one' }]]));
      deductionProgress = { questionId: 'Q1', wrongStreak: 2 };
      searchedItems.add('inspect record one');
      document.getElementById('inp-msg').value = '保留这段草稿';
      const word = { word: 'gift', meaning: '礼物', example: 'This gift is for you.', example_cn: '这个礼物是给你的。' };
      addVocabEntry(word); openWordCard([{ ...word, bookKey: 'gift' }], 0, { source: 'book' });
      rateReview('known'); closeReviewSession();
    }, require('./script-fixture.cjs')());
    await page.locator('#btn-reset').click(); await page.locator('#btn-exit-save').click();
    await page.evaluate(() => pushCloudState());
    const stored = (await api(server.base, '/api/state', 'GET', null, signup.data.token)).data.state;
    assert.equal(stored.scriptHistory[0].status, 'playing');
    assert.equal(stored.scriptHistory[0].resume.taskProgress.records[0][1][0][0], 'C1');
    assert.equal(stored.vocabBook[0][1].mastered, true);
    await page.reload(); await page.waitForFunction(() => authInfo && accountSyncReady);
    assert.equal(await page.evaluate(() => vocabBook.get('gift').mastered), true);
    await page.locator('#btn-open-script-history').click();
    await page.locator('.run-card').click(); await page.locator('.btn-resume-run').click();
    assert.equal(await page.locator('#inp-msg').inputValue(), '保留这段草稿');
    assert.equal(await page.evaluate(() => scriptData.truth), 'HIDDEN_TRUTH');
    assert.equal(await page.evaluate(() => taskProgressState.records.get('1:1').has('C1')), true);
    assert.equal(await page.evaluate(() => deductionProgress.wrongStreak), 2);
    assert.equal(await page.evaluate(() => searchedItems.has('inspect record one')), true);
    assert.equal(await page.locator('.msg-row.npc').count(), 1);
    assert.equal(await page.evaluate(() => currentRun().resume.version), 1);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close(); await server.stop();
    assert.equal(path.dirname(temp), os.tmpdir()); fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('actual service: register, old account login, disk persistence, CORS and private files', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'english-accounts-test-'));
  let server;
  try {
    server = await startServer(temp);
    assert.deepEqual((await api(server.base, '/api/health')).data, { service: 'englishmurdermystery', accounts: true });
    const pronunciations = await fetch(server.base + '/data/daily/pronunciations.json');
    assert.equal(pronunciations.status, 200);
    const door = (await pronunciations.json()).words.door;
    assert.ok(door.uk && door.us);
    assert.notEqual(door.uk, door.us);
    const license = await fetch(server.base + '/data/daily/pronunciation-LICENSE.txt');
    assert.equal(license.status, 200);
    assert.match(await license.text(), /GNU GENERAL PUBLIC LICENSE/);
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

function sampleRecords(label) {
  return { campaign: { completed: { [label]: { at: '2026-11-11' } }, usedWords: [label] },
    vocabBook: [[label, { word: label, meaning: '测试词', pos: 'n.' }]],
    learningVocab: [{ word: label, lemma: label, goal: '高考', difficulty: '简单模式', meaning: '测试词' }],
    scriptHistory: [{ id: label, startedAt: '2026-11-11T00:00:00Z', scriptName: label, transcript: [] }] };
}
function legacyRecords(state) {
  return { wp_daily_progress_v2: JSON.stringify(state.campaign), wp_vocab_book_v1: JSON.stringify(state.vocabBook),
    wp_learning_vocab_v1: JSON.stringify(state.learningVocab), wp_script_history_v1: JSON.stringify(state.scriptHistory) };
}

test('guest records never persist: legacy cleanup, in-page use, reload, new visit and back navigation', async () => {
  const { browser, page, errors } = await browserPage({ initialStorage: { ...legacyRecords(sampleRecords('legacyguest')), 'script-kill-theme': 'light' } });
  try {
    const empty = await page.evaluate(() => snapshotLocalState());
    assert.equal(empty.vocabBook.length + empty.learningVocab.length + empty.scriptHistory.length, 0);
    assert.equal(empty.campaign.usedWords.length, 0);
    await page.evaluate(state => {
      applyStateToLocal(state);
      saveVocabBook(); saveLearningVocab(); saveScriptHistory(); saveCampaignState(state.campaign);
    }, sampleRecords('temporaryguest'));
    assert.equal(await page.evaluate(() => vocabBook.size), 1);
    assert.equal(await page.evaluate(() => scriptHistory.length), 1);
    assert.deepEqual(await page.evaluate(() => Object.keys(localStorage).filter(key => /^wp_(daily_progress|vocab_book|learning_vocab|script_history)/.test(key))), []);
    await page.reload();
    await page.waitForFunction(() => EXAM_LEXICON.ready && accountService.status !== 'checking');
    assert.equal(await page.evaluate(() => snapshotLocalState().scriptHistory.length + vocabBook.size + learningVocab.size), 0);
    assert.equal(await page.evaluate(() => localStorage.getItem('script-kill-theme')), 'light');
    await page.evaluate(state => {
      applyStateToLocal(state);
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    }, sampleRecords('backguest'));
    assert.equal(await page.evaluate(() => snapshotLocalState().scriptHistory.length + vocabBook.size + learningVocab.size), 0);
    await page.goto('about:blank');
    await page.goto('https://learner.example/Englishmurdermystery/index.html');
    await page.waitForFunction(() => EXAM_LEXICON.ready);
    assert.equal(await page.evaluate(() => snapshotLocalState().scriptHistory.length + vocabBook.size + learningVocab.size), 0);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('only account records persist: guest data is excluded, logout clears all views and switching users isolates history', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'english-records-isolation-'));
  const server = await startServer(temp);
  const a = await api(server.base, '/api/auth/register', 'POST', { username: 'record_a', password: 'test-pass-123' });
  const b = await api(server.base, '/api/auth/register', 'POST', { username: 'record_b', password: 'test-pass-123' });
  await api(server.base, '/api/state', 'POST', { state: sampleRecords('accounta') }, a.data.token);
  await api(server.base, '/api/state', 'POST', { state: sampleRecords('accountb') }, b.data.token);
  const { browser, page, errors } = await browserPage({ server, service: 'https://accounts.example' });
  async function login(username) {
    await page.evaluate(() => openAuth('login'));
    await page.locator('#auth-username').fill(username);
    await page.locator('#auth-password').fill('test-pass-123');
    await page.locator('#auth-submit').click();
    await page.waitForFunction(username => authInfo && authInfo.username === username && accountSyncReady && !authSubmitting, username);
    await page.evaluate(() => closeAuth());
  }
  try {
    await page.evaluate(state => applyStateToLocal(state), sampleRecords('guestbeforelogin'));
    await login('record_a');
    assert.deepEqual(await page.evaluate(() => [...vocabBook.keys()]), ['accounta']);
    assert.deepEqual(await page.evaluate(() => scriptHistory.map(run => run.id)), ['accounta']);
    await page.evaluate(async state => { applyStateToLocal(state); await pushCloudState(); }, sampleRecords('savedaccounta'));
    await page.reload();
    await page.waitForFunction(() => authInfo && accountSyncReady);
    assert.deepEqual(await page.evaluate(() => [...vocabBook.keys()]), ['savedaccounta']);
    assert.deepEqual(await page.evaluate(() => scriptHistory.map(run => run.id)), ['savedaccounta']);
    await page.evaluate(() => signOut());
    assert.equal(await page.evaluate(() => snapshotLocalState().scriptHistory.length + vocabBook.size + learningVocab.size), 0);
    assert.equal(await page.evaluate(() => loadCampaignState().usedWords.length), 0);
    await page.evaluate(state => applyStateToLocal(state), sampleRecords('guestaftersignout'));
    await login('record_b');
    assert.deepEqual(await page.evaluate(() => [...vocabBook.keys()]), ['accountb']);
    assert.deepEqual(await page.evaluate(() => scriptHistory.map(run => run.id)), ['accountb']);
    await page.evaluate(state => {
      applyStateToLocal(state);
      saveVocabBook(); saveLearningVocab(); saveScriptHistory();
      signOut();
    }, sampleRecords('savedaccountb'));
    let remote;
    for (let attempt = 0; attempt < 20; attempt++) {
      remote = (await api(server.base, '/api/state', 'GET', null, b.data.token)).data.state;
      if (remote.scriptHistory[0]?.id === 'savedaccountb') break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(remote.scriptHistory[0].id, 'savedaccountb');
    assert.equal(await page.evaluate(() => scriptHistory.length), 0);
    await login('record_a');
    assert.deepEqual(await page.evaluate(() => [...vocabBook.keys()]), ['savedaccounta']);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close(); await server.stop();
    assert.equal(path.dirname(temp), os.tmpdir()); fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('existing signed-in local records migrate to their account; invalid sessions reveal no cached records', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'english-records-migrate-'));
  const server = await startServer(temp);
  const signup = await api(server.base, '/api/auth/register', 'POST', { username: 'legacy_member', password: 'test-pass-123' });
  const saved = { token: signup.data.token, username: 'legacy_member', service: 'https://accounts.example' };
  const valid = await browserPage({ server, service: 'https://accounts.example', saved, initialStorage: legacyRecords(sampleRecords('memberlegacy')) });
  try {
    await valid.page.waitForFunction(() => authInfo && accountSyncReady);
    assert.equal(await valid.page.evaluate(() => vocabBook.has('memberlegacy')), true);
    assert.equal(await valid.page.evaluate(() => scriptHistory[0].id), 'memberlegacy');
    assert.equal(await valid.page.evaluate(() => localStorage.getItem('wp_script_history_v1')), null);
    await valid.page.evaluate(() => pushCloudState());
    assert.equal((await api(server.base, '/api/state', 'GET', null, signup.data.token)).data.state.scriptHistory[0].id, 'memberlegacy');
    assert.deepEqual(valid.errors, []);
    const invalid = await browserPage({ server, service: 'https://accounts.example', saved: { ...saved, token: 'invalid' },
      initialStorage: legacyRecords(sampleRecords('expiredmember')) });
    try {
      await invalid.page.waitForFunction(() => !authInfo && !localStorage.getItem('wp_account_v1'));
      assert.equal(await invalid.page.evaluate(() => scriptHistory.length + vocabBook.size + learningVocab.size), 0);
      assert.equal(await invalid.page.evaluate(() => loadCampaignState().usedWords.length), 0);
      assert.deepEqual(invalid.errors, []);
    } finally { await invalid.browser.close(); }
  } finally {
    await valid.browser.close(); await server.stop();
    assert.equal(path.dirname(temp), os.tmpdir()); fs.rmSync(temp, { recursive: true, force: true });
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
    assert.match(await page.locator('#auth-msg').innerText(), /无法连接账号服务/);
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

test('direct mobile link uses reachable fallback without referrer, and shared-database sessions survive endpoint changes', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'english-accounts-fallback-'));
  const server = await startServer(temp);
  const signup = await api(server.base, '/api/auth/register', 'POST', { username: 'mobile_user', password: 'test-pass-123' });
  const saved = { token: signup.data.token, username: 'mobile_user', service: 'https://unreachable.example' };
  const { browser, page, requests, errors } = await browserPage({ server, service: 'https://accounts.example', saved, mobile: true,
    configOverride: { accountApiBase: 'https://unreachable.example', accountApiFallbacks: ['https://accounts.example'] } });
  try {
    await page.waitForFunction(() => authInfo && accountSyncReady && document.getElementById('account-bar').textContent.includes('mobile_user'));
    assert.equal(await page.evaluate(() => document.referrer), '');
    assert.equal(await page.evaluate(() => accountService.base), 'https://accounts.example');
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('wp_account_v1')).service), 'https://accounts.example');
    assert.ok(!requests.some(r => r.method === 'POST' && r.url.startsWith('https://unreachable.example')));
    assert.deepEqual(errors, []);
  } finally {
    await browser.close(); await server.stop(); assert.equal(path.dirname(temp), os.tmpdir()); fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('mobile embedded browser can register when persistent storage is unavailable', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'english-accounts-storage-'));
  const server = await startServer(temp);
  const { browser, page, errors } = await browserPage({ server, service: 'https://accounts.example', mobile: true, blockedStorage: true });
  try {
    await page.locator('#account-bar button').click();
    await page.locator('#auth-switch').click();
    await page.locator('#auth-username').fill('private_mobile');
    await page.locator('#auth-password').fill('test-pass-123');
    await page.locator('#auth-submit').click();
    await page.waitForFunction(() => authInfo && accountSyncReady && document.getElementById('account-bar').textContent.includes('private_mobile'));
    assert.deepEqual(errors, []);
  } finally {
    await browser.close(); await server.stop(); assert.equal(path.dirname(temp), os.tmpdir()); fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('same-origin mobile site reconnects after network recovery without refreshing or losing input', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'english-accounts-reconnect-'));
  const server = await startServer(temp), gate = { ready: false };
  const { browser, page, errors } = await browserPage({ server, mobile: true, apiGate: gate, configOverride: { sameOriginAccounts: true } });
  try {
    await page.locator('#account-bar button').click();
    await page.waitForFunction(() => accountService.status === 'unavailable');
    await page.locator('#auth-username').fill('keep_my_input');
    await page.locator('#auth-password').fill('test-pass-123');
    await page.locator('#auth-reconnect').waitFor({ state: 'visible' });
    gate.ready = true;
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await page.waitForFunction(() => cloudApiReady());
    assert.equal(await page.locator('#auth-submit').isEnabled(), true);
    assert.equal(await page.locator('#auth-username').inputValue(), 'keep_my_input');
    assert.equal(await page.locator('#auth-password').inputValue(), 'test-pass-123');
    assert.equal(await page.evaluate(() => accountService.base), '');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close(); await server.stop(); assert.equal(path.dirname(temp), os.tmpdir()); fs.rmSync(temp, { recursive: true, force: true });
  }
});
