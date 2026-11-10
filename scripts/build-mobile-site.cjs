'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const output = path.join(root, '.cloudflare-private/mobile-site');

async function build() {
  fs.mkdirSync(path.join(output, 'data/daily'), { recursive: true });
  // Only runtime assets, never config.json, account files, exports or deployment credentials.
  fs.copyFileSync(path.join(root, 'index.html'), path.join(output, 'index.html'));
  for (const name of ['scenes.jsonl', 'scene_catalog.json', 'vocabulary.json', 'sources.json', 'exam_lexicon.json', 'cet_core.json']) {
    fs.copyFileSync(path.join(root, 'data/daily', name), path.join(output, 'data/daily', name));
  }
  fs.writeFileSync(path.join(output, 'site-config.json'), JSON.stringify({ accountApiBase: '', sameOriginAccounts: true }, null, 2) + '\n');
  fs.writeFileSync(path.join(output, '_routes.json'), JSON.stringify({ version: 1, include: ['/api/*'], exclude: [] }, null, 2) + '\n');
  fs.writeFileSync(path.join(output, '_headers'), '/site-config.json\n  Cache-Control: no-store\n/index.html\n  Cache-Control: no-cache\n');
  await require('esbuild').build({ entryPoints: [path.join(root, 'cloudflare/pages-worker.mjs')], outfile: path.join(output, '_worker.js'),
    bundle: true, format: 'esm', platform: 'neutral', target: 'es2022', external: ['node:*'] });
  console.log('Built public mobile site assets with same-origin account API.');
  return output;
}
module.exports = { build };
if (require.main === module) build().catch(error => { console.error(error.message); process.exitCode = 1; });
