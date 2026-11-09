'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { exportMigration } = require('./export-cloudflare-accounts.cjs');
const root = path.resolve(__dirname, '..');
const privateDir = path.join(root, '.cloudflare-private');
const configPath = path.join(privateDir, 'wrangler.json');
const wrangler = path.join(root, 'node_modules/wrangler/bin/wrangler.js');
const databaseName = 'englishmurdermystery-accounts';

function configureProxy() {
  if (process.platform === 'win32' && !process.env.HTTPS_PROXY) {
    try {
      const settings = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-Command',
        "Get-ItemProperty -LiteralPath 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings' | Select-Object ProxyEnable,ProxyServer | ConvertTo-Json -Compress"],
      { encoding: 'utf8', windowsHide: true }));
      if (settings.ProxyEnable && /^127\.0\.0\.1:\d+$/.test(settings.ProxyServer || '')) {
        process.env.HTTPS_PROXY = 'http://' + settings.ProxyServer;
        process.env.HTTP_PROXY = process.env.HTTPS_PROXY;
      }
    } catch (_) {}
  }
  const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  if (proxy) {
    const { ProxyAgent, setGlobalDispatcher } = require('undici');
    setGlobalDispatcher(new ProxyAgent(proxy));
  }
}
function cli(args, interactive = false) {
  try {
    return execFileSync(process.execPath, [wrangler, ...args], { cwd: root, encoding: 'utf8', windowsHide: true,
      stdio: interactive ? 'inherit' : ['ignore', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: interactive ? '' : 'true' } });
  } catch (_) {
    // Captured errors may echo SQL or credentials. Never print their contents.
    throw new Error('Cloudflare 操作未完成：' + args.slice(0, 2).join(' ') + '。请检查网络、平台授权及免费额度；没有自动开通付费。');
  }
}
function cliJson(args) { return JSON.parse(cli(args)); }
function sql(command) {
  return cliJson(['d1', 'execute', 'DB', '--config', configPath, '--remote', '--yes', '--json', '--command', command])
    .flatMap(result => result.results || []);
}
async function verifyService(base) {
  const testName = 'check_' + crypto.randomBytes(5).toString('hex');
  const password = crypto.randomBytes(24).toString('hex');
  async function call(endpoint, method = 'GET', body, token) {
    const response = await fetch(base + endpoint, { method, headers: { 'Content-Type': 'application/json', Origin: 'https://moonite0307.github.io', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000) });
    let data;
    try { data = await response.json(); } catch (_) { throw new Error('免费服务未通过线上验收，可能为运行额度或网络限制。已停止接入网页，不会升级付费。'); }
    if (!response.ok) throw new Error('免费服务未通过线上验收（HTTP ' + response.status + '）。已停止接入网页，不会升级付费。');
    return data;
  }
  try {
    let health;
    for (let attempt = 0; attempt < 3; attempt++) {
      try { health = await call('/api/health'); break; }
      catch (error) {
        if (attempt === 2) throw error;
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
    }
    if (health.accounts !== true || health.service !== 'englishmurdermystery') throw new Error('账号服务健康检查未通过。');
    const signup = await call('/api/auth/register', 'POST', { username: testName, password });
    if (!signup.token) throw new Error('注册验收未通过。');
    const login = await call('/api/auth/login', 'POST', { username: testName, password });
    const state = { campaign: { completed: {}, usedWords: ['gift'] }, vocabBook: [], learningVocab: [], scriptHistory: [] };
    await call('/api/state', 'POST', { state }, login.token);
    if ((await call('/api/state', 'GET', null, login.token)).state?.campaign?.usedWords?.[0] !== 'gift') throw new Error('学习记录验收未通过。');
  } finally {
    const id = crypto.createHash('sha256').update(testName.toLowerCase()).digest('hex').slice(0, 32);
    sql("DELETE FROM users WHERE id='" + id + "'");
  }
}
async function deploy({ freePlanConfirmed = false } = {}) {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('请安装 Node.js 22 或更新版本。');
  if (!fs.existsSync(wrangler)) throw new Error('请先在项目目录运行 npm install 安装部署工具，再重新双击部署文件。');
  configureProxy();
  console.log('正在部署 Cloudflare Workers + D1 免费版。不会购买域名或开通付费。');
  console.log('只使用 Workers Free；如平台要求付款请停止，不要填银行卡。模型接口费用独立。');
  let who;
  try { who = cliJson(['whoami', '--json']); } catch (_) {}
  if (!who?.loggedIn) {
    console.log('即将打开 Cloudflare 授权页面，请注册/登录并点击允许。无需发送密码或令牌。');
    cli(['login'], true); who = cliJson(['whoami', '--json']);
  }
  if (who.accounts?.length !== 1) throw new Error('当前包含多个或零个 Cloudflare 账户，需要先选择目标账户；本次未创建资源。');
  const accountId = who.accounts[0].id;
  if (!/^[a-f0-9]{32}$/i.test(accountId)) throw new Error('Cloudflare 账户信息不完整。');
  const credentials = cliJson(['auth', 'token', '--json']);
  if (!credentials.token) throw new Error('请使用 Cloudflare 登录授权，而不是全局 API 密钥。');
  async function cf(endpoint, method = 'GET', body) {
    const response = await fetch('https://api.cloudflare.com/client/v4/accounts/' + accountId + endpoint, { method,
      headers: { Authorization: 'Bearer ' + credentials.token, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000) });
    const data = await response.json();
    if (!response.ok || !data.success) throw Object.assign(new Error('Cloudflare 接口未成功（HTTP ' + response.status + '）。请检查授权及免费额度，不要升级付费。'), { status: response.status });
    return data.result;
  }
  let subscriptions;
  try { subscriptions = await cf('/subscriptions'); }
  catch (_) {
    if (!freePlanConfirmed) throw new Error('平台未允许核对免费套餐，本次未创建服务。请在控制台确认 Workers Free，并联系我继续处理。');
    console.log('使用你已在控制台确认的 Workers Free 套餐；不进行任何套餐变更。');
    subscriptions = [];
  }
  if (!Array.isArray(subscriptions)) throw new Error('无法确认免费套餐，已停止，不创建服务。');
  if (subscriptions.some(item => /worker/i.test(JSON.stringify(item.rate_plan || {})) && !/free/i.test(JSON.stringify(item.rate_plan || {})))) {
    throw new Error('检测到 Workers 付费套餐，已停止。请使用 Workers Free 账户。');
  }
  let subdomain;
  try { subdomain = await cf('/workers/subdomain'); }
  catch (error) {
    if (error.status !== 404) throw error;
    // This is Cloudflare's free subdomain registration, not a domain purchase.
    subdomain = await cf('/workers/subdomain', 'PUT', { subdomain: 'englishmystery-' + accountId.slice(0, 10) });
  }
  if (!/^[a-z0-9-]+$/i.test(subdomain?.subdomain || '')) throw new Error('免费 workers.dev 子域名未就绪，请在 Workers 页面完成引导后重试；不用买域名。');
  fs.mkdirSync(privateDir, { recursive: true });
  const databases = await cf('/d1/database?per_page=100');
  let database = databases.find(item => item.name === databaseName);
  if (!database) database = await cf('/d1/database', 'POST', { name: databaseName, primary_location_hint: 'apac' });
  if (!/^[a-f0-9-]{36}$/i.test(database.uuid || '')) throw new Error('免费数据库未返回有效标识。');
  const config = JSON.parse(fs.readFileSync(path.join(root, 'cloudflare/wrangler.jsonc'), 'utf8'));
  config.main = path.join(root, 'cloudflare/worker.mjs'); config.account_id = accountId;
  config.d1_databases[0].database_id = database.uuid;
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  console.log('正在初始化免费数据库……');
  cli(['d1', 'execute', 'DB', '--config', configPath, '--remote', '--yes', '--file', path.join(root, 'cloudflare/schema.sql')]);
  const migration = exportMigration();
  const count = Number(sql('SELECT COUNT(*) AS count FROM users')[0]?.count);
  if (!Number.isFinite(count)) throw new Error('无法确认云端账号数量，已停止，未覆盖账号。');
  const markerPath = path.join(privateDir, 'migration-complete.json');
  const localUsers = path.join(root, 'data/accounts/users.json');
  const ids = fs.existsSync(localUsers) ? Object.keys(JSON.parse(fs.readFileSync(localUsers, 'utf8'))).sort() : [];
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify(ids)).digest('hex');
  if (count > 0 && migration.count > 0) {
    const marker = fs.existsSync(markerPath) ? JSON.parse(fs.readFileSync(markerPath, 'utf8')) : {};
    if (marker.database !== database.uuid || marker.fingerprint !== fingerprint) throw new Error('云端已有账号，本次未覆盖。需要先合并，不能直接重导。');
    console.log('原账号已迁移，本次保留云端最新记录。');
  } else if (migration.count > 0) {
    console.log('正在通过已授权的私密接口迁移原账号……');
    cli(['d1', 'execute', 'DB', '--config', configPath, '--remote', '--yes', '--file', migration.output]);
    fs.writeFileSync(markerPath, JSON.stringify({ database: database.uuid, fingerprint }));
  }
  console.log('正在发布并验收线上注册、登录和记录同步……');
  cli(['deploy', '--config', configPath]);
  const base = 'https://' + config.name + '.' + subdomain.subdomain + '.workers.dev';
  console.log('已发布，正在验证服务地址：' + base);
  await verifyService(base);
  fs.writeFileSync(path.join(root, 'site-config.json'), JSON.stringify({ accountApiBase: base }, null, 2) + '\n');
  console.log('免费账号服务已通过线上验收：' + base);
  console.log('网页连接已写好。请告诉我“部署完成”，我会将连接配置同步到 GitHub。');
}
module.exports = { deploy, verifyService };
if (require.main === module) deploy({ freePlanConfirmed: process.argv.includes('--free-plan-confirmed') })
  .catch(error => { console.error(error.message); process.exitCode = 1; });
