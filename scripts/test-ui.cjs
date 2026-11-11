'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const publicFiles = new Set(['/index.html', '/site-config.json', ...[
  'scenes.jsonl', 'scene_catalog.json', 'vocabulary.json', 'sources.json',
  'exam_lexicon.json', 'cet_core.json', 'pronunciations.json', 'pronunciation-LICENSE.txt'
].map(name => '/data/daily/' + name)]);

// Serve only runtime assets. Browser tests mock model requests and isolate account storage.
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const file = pathname === '/' ? '/index.html' : pathname;
  if (!publicFiles.has(file)) { res.writeHead(404); res.end(); return; }
  fs.readFile(path.join(root, file.slice(1)), (error, bytes) => {
    if (error) { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.json') ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8');
    res.end(bytes);
  });
});
server.listen(0, '127.0.0.1', () => {
  const child = spawn(process.execPath, ['--test', ...process.argv.slice(2), 'scripts/test-game-ui.cjs', 'scripts/test-account-service.cjs'], {
    cwd: root, windowsHide: true, stdio: 'inherit',
    env: { ...process.env, GAME_UI_URL: 'http://127.0.0.1:' + server.address().port + '/' }
  });
  child.on('error', error => { console.error(error.message); process.exitCode = 1; server.close(); });
  child.on('exit', code => { process.exitCode = code === 0 ? 0 : 1; server.close(); });
});
