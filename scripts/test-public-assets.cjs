'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { assertPublicAssets } = require('./check-public-assets.cjs');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
test('public HTML and site configuration contain no recognized model credentials', () => assertPublicAssets(root));
test('publication gate rejects credentials in the homepage and an unlinked HTML backup', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'public-assets-'));
  try {
    fs.writeFileSync(path.join(temp, 'index.html'), '<html>Safe</html>');
    fs.writeFileSync(path.join(temp, 'site-config.json'), '{}');
    assertPublicAssets(temp);
    const fake = ['sk', '-'].join('') + 'z'.repeat(32);
    for (const name of ['index.html', 'index.before-avatar.html']) {
      fs.writeFileSync(path.join(temp, name), 'const key = "' + fake + '";');
      assert.throws(() => assertPublicAssets(temp), /发布被阻止/);
      fs.writeFileSync(path.join(temp, name), '<html>Safe</html>');
    }
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
test('public sites discard legacy browser model keys instead of restoring direct access', () => {
  const source = html.slice(html.indexOf('const STATIC_DEFAULTS'), html.indexOf('function validateSettings'));
  for (const hostname of ['englishmurdermystery-mobile.pages.dev', 'moonite0307.github.io', 'localhost', '127.0.0.1']) {
    let removed = false;
    const ctx = vm.createContext({ location: { hostname }, localStorage: {
      getItem: () => JSON.stringify({ apiBase: 'https://provider.invalid', apiKey: 'test-only', model: 'mock' }),
      removeItem: () => { removed = true; }
    } });
    const settings = vm.runInContext(source + '\ngetSettings()', ctx);
    const local = ['localhost', '127.0.0.1'].includes(hostname);
    assert.equal(!!settings.apiKey, local);
    assert.equal(removed, !local);
  }
});
test('missing model configuration fails locally without contacting a paid provider', async () => {
  let requests = 0;
  const ctx = vm.createContext({ backendMode: false, getSettings: () => ({ apiBase: '', apiKey: '', model: '' }),
    fetch: () => { requests++; throw new Error('must not call'); } });
  const source = html.slice(html.indexOf('async function callLLM'), html.indexOf('function typewriter'));
  vm.runInContext(source, ctx);
  await assert.rejects(vm.runInContext('callLLM([], null)', ctx), /共享接口已停用/);
  assert.equal(requests, 0);
});
