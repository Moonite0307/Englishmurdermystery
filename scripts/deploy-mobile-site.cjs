'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { build } = require('./build-mobile-site.cjs');
const root = path.resolve(__dirname, '..');
const wrangler = path.join(root, 'node_modules/wrangler/bin/wrangler.js');
const name = 'englishmurdermystery-mobile';

async function deploy() {
  const { ProxyAgent, setGlobalDispatcher } = require('undici');
  const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  if (proxy) setGlobalDispatcher(new ProxyAgent(proxy));
  const env = { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: 'true' };
  const command = args => execFileSync(process.execPath, [wrangler, ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env, maxBuffer: 8 * 1024 * 1024 });
  const auth = JSON.parse(command(['auth', 'token', '--json']));
  const config = JSON.parse(fs.readFileSync(path.join(root, '.cloudflare-private/wrangler.json'), 'utf8'));
  const accountId = config.account_id;
  async function api(endpoint, method = 'GET', body) {
    const r = await fetch('https://api.cloudflare.com/client/v4/accounts/' + accountId + endpoint, {
      method, headers: { Authorization: 'Bearer ' + auth.token, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(45000)
    });
    const data = await r.json();
    if (!r.ok || !data.success) throw Object.assign(new Error('Cloudflare Pages operation failed (HTTP ' + r.status + ')'), { status: r.status });
    return data.result;
  }
  const settings = {
    compatibility_date: '2026-11-09', compatibility_flags: ['nodejs_compat'],
    d1_databases: { DB: { id: config.d1_databases[0].database_id } },
    env_vars: { ALLOWED_ORIGINS: { type: 'plain_text', value: config.vars.ALLOWED_ORIGINS + ',https://' + name + '.pages.dev' } }
  };
  let project;
  try { project = await api('/pages/projects/' + name); }
  catch (error) {
    if (error.status !== 404) throw error;
    project = await api('/pages/projects', 'POST', { name, production_branch: 'main', deployment_configs: { production: settings, preview: settings } });
  }
  const boundId = project.deployment_configs?.production?.d1_databases?.DB?.id;
  if (boundId && boundId !== config.d1_databases[0].database_id) throw new Error('Existing Pages project uses another database; stopped without replacing it.');
  // Existing bindings and encrypted secrets must survive later UI deployments.
  // New projects received settings during creation; existing projects are reused.
  const output = await build();
  try {
    const result = command(['pages', 'deploy', output, '--project-name', name, '--branch', 'main', '--commit-dirty=true']);
    console.log(result.replace(/\x1b\[[0-9;]*m/g, ''));
  } catch (_) { throw new Error('Pages upload failed; private command output was withheld.'); }
  console.log('Mobile site: https://' + name + '.pages.dev');
  console.log('Reused the existing account database; no migration or account replacement performed.');
}
module.exports = { deploy };
if (require.main === module) deploy().catch(error => { console.error(error.message); process.exitCode = 1; });
