// Verify the deployment gates without an online account or access to real credentials.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(__dirname, 'deploy-free-accounts.cjs'), 'utf8');

async function scenario({ paid = false, quotaFailure = false, existing = false, permissionDenied = false, freePlanConfirmed = false } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'english-free-deploy-test-'));
  for (const dir of ['scripts', 'cloudflare', 'node_modules/wrangler/bin', 'data/accounts']) fs.mkdirSync(path.join(temp, dir), { recursive: true });
  fs.writeFileSync(path.join(temp, 'node_modules/wrangler/bin/wrangler.js'), '');
  fs.copyFileSync(path.join(root, 'cloudflare/wrangler.jsonc'), path.join(temp, 'cloudflare/wrangler.jsonc'));
  fs.writeFileSync(path.join(temp, 'site-config.json'), '{"accountApiBase":""}');
  fs.writeFileSync(path.join(temp, 'data/accounts/users.json'), '{"local-user":{}}');
  const commands = [], urls = [];
  let savedState;
  const module = { exports: {} };
  const execFileSync = (_exe, args) => {
    const cmd = args.slice(1); commands.push(cmd);
    if (cmd[0] === 'whoami') return JSON.stringify({ loggedIn: true, accounts: [{ id: 'a'.repeat(32) }] });
    if (cmd[0] === 'auth') return JSON.stringify({ token: 'synthetic-not-a-real-credential' });
    if (cmd.includes('SELECT COUNT(*) AS count FROM users')) return JSON.stringify([{ results: [{ count: existing ? 1 : 0 }] }]);
    if (cmd.includes('--json')) return '[{"results":[]}]';
    return '';
  };
  const context = vm.createContext({ module, __dirname: path.join(temp, 'scripts'),
    require: name => name === 'node:child_process' ? { execFileSync } : name === './export-cloudflare-accounts.cjs' ? {
      exportMigration: () => ({ count: 1, output: path.join(temp, '.cloudflare-private/accounts.sql') })
    } : require(name),
    process: { platform: 'linux', versions: process.versions, env: {}, execPath: process.execPath }, console: { log() {}, error() {} },
    AbortSignal, setTimeout, fetch: async (url, options = {}) => {
      urls.push(url);
      const endpoint = new URL(url).pathname;
      if (endpoint.endsWith('/subscriptions')) return new Response(JSON.stringify({ success: !permissionDenied, result: paid ? [{ rate_plan: { id: 'workers_paid', name: 'Workers Paid' } }] : [] }), { status: permissionDenied ? 403 : 200 });
      if (endpoint.endsWith('/d1/database')) return new Response(JSON.stringify({ success: true, result: options.method === 'POST' ? { uuid: 'b'.repeat(8) + '-1111-1111-1111-' + 'b'.repeat(12) } : [] }));
      if (endpoint.endsWith('/workers/subdomain')) return new Response(JSON.stringify({ success: true, result: { subdomain: 'test-user' } }));
      if (endpoint === '/api/health') return new Response(JSON.stringify({ service: 'englishmurdermystery', accounts: true }));
      if (quotaFailure) return new Response('<html>Worker exceeded CPU time</html>', { status: 1102 > 599 ? 503 : 1102 });
      if (endpoint === '/api/auth/register' || endpoint === '/api/auth/login') return new Response(JSON.stringify({ token: 'test-token' }));
      if (endpoint === '/api/state' && options.method === 'POST') { savedState = JSON.parse(options.body).state; return new Response('{"ok":true}'); }
      if (endpoint === '/api/state') return new Response(JSON.stringify({ state: savedState }));
      throw new Error('Unexpected endpoint');
    }
  });
  vm.runInContext(source, context);
  let error;
  try { await module.exports.deploy({ freePlanConfirmed }); } catch (caught) { error = caught; }
  return { temp, commands, urls, error, config: JSON.parse(fs.readFileSync(path.join(temp, 'site-config.json'), 'utf8')), cleanup() {
    assert.equal(path.dirname(temp), os.tmpdir()); fs.rmSync(temp, { recursive: true, force: true });
  } };
}
test('free deployment migrates only to the private database and connects the webpage after live checks', async () => {
  const result = await scenario();
  try {
    assert.equal(result.error, undefined);
    assert.equal(result.config.accountApiBase, 'https://englishmurdermystery-accounts.test-user.workers.dev');
    assert.ok(result.commands.some(cmd => cmd.includes('--file') && cmd.some(v => v.endsWith('accounts.sql'))));
    assert.ok(result.commands.some(cmd => cmd[0] === 'deploy'));
    assert.ok(result.commands.some(cmd => cmd.some(v => v.startsWith('DELETE FROM users WHERE id='))));
    assert.ok(!result.urls.some(url => /github.com|billing|upgrade/.test(url)));
  } finally { result.cleanup(); }
});
test('a human-confirmed Free plan permits deployment when OAuth cannot read billing, without changing a plan', async () => {
  const result = await scenario({ permissionDenied: true, freePlanConfirmed: true });
  try {
    assert.equal(result.error, undefined);
    assert.ok(result.config.accountApiBase.startsWith('https://'));
    assert.ok(!result.urls.some(url => /billing|upgrade/.test(url)));
  } finally { result.cleanup(); }
});
for (const [name, options] of [['paid subscription', { paid: true }], ['unverified subscription', { permissionDenied: true }],
  ['live runtime quota failure', { quotaFailure: true }], ['unrelated existing accounts', { existing: true }]]) {
  test(name + ' stops deployment without changing the public webpage connection', async () => {
    const result = await scenario(options);
    try {
      assert.ok(result.error);
      assert.equal(result.config.accountApiBase, '');
      if (options.paid || options.permissionDenied) assert.ok(!result.urls.some(url => url.includes('/d1/database')));
      if (options.existing) assert.ok(!result.commands.some(cmd => cmd[0] === 'deploy'));
    } finally { result.cleanup(); }
  });
}
test('Windows deployment launcher works from nested Chinese folders without encoding failures', { skip: process.platform !== 'win32' }, () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'english-free-launcher-'));
  try {
    const outer = path.join(temp, '中文测试 空格'), inner = path.join(outer, 'Englishmurdermystery');
    fs.mkdirSync(path.join(inner, 'scripts'), { recursive: true });
    const launcher = fs.readFileSync(path.join(root, '免费部署账号.bat'));
    assert.ok([...launcher].every(byte => byte < 128));
    fs.writeFileSync(path.join(inner, 'scripts/deploy-free-accounts.cjs'), 'console.log("FREE_LAUNCHER_OK");');
    for (const folder of [outer, inner]) {
      const file = path.join(folder, 'deploy-test.bat'); fs.writeFileSync(file, launcher);
      const result = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', '"call "%FREE_TEST_BAT%""'], {
        cwd: folder, windowsHide: true, windowsVerbatimArguments: true, encoding: 'utf8', input: '\r\n', timeout: 10000,
        env: { ...process.env, FREE_TEST_BAT: file }
      });
      assert.ifError(result.error); assert.equal(result.status, 0, result.stderr + result.stdout);
      assert.match(result.stdout, /FREE_LAUNCHER_OK/);
    }
  } finally { assert.equal(path.dirname(temp), os.tmpdir()); fs.rmSync(temp, { recursive: true, force: true }); }
});
