'use strict';
const fs = require('node:fs');
const path = require('node:path');
function assertPublicAssets(root = path.resolve(__dirname, '..')) {
  // GitHub Pages also publishes HTML backups, even when the app never links to them.
  for (const name of [...fs.readdirSync(root).filter(name => name.endsWith('.html')), 'site-config.json']) {
    const source = fs.readFileSync(path.join(root, name), 'utf8');
    if (/sk-[A-Za-z0-9_-]{20,}/.test(source) || /["']apiKey["']\s*:\s*["'][^"']{20,}["']/.test(source)) {
      throw new Error('发布被阻止：' + name + ' 疑似包含真实 API 密钥。请改用服务端私密配置，不要发布共享密钥。');
    }
  }
}
module.exports = { assertPublicAssets };
if (require.main === module) {
  try { assertPublicAssets(); console.log('Public assets contain no recognized model credentials.'); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
