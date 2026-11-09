'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { probeProject, launch } = require('./launch.cjs');
const root = path.resolve(__dirname, '..');

test('probe distinguishes this page, an unrelated server and an unused port', async () => {
  let body = fs.readFileSync(path.join(root, 'index.html'));
  const server = http.createServer((req, res) => res.end(body));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + server.address().port;
  try {
    assert.equal(await probeProject(url), 'running');
    body = Buffer.from('Another application');
    assert.equal(await probeProject(url), 'occupied');
  } finally { await new Promise(resolve => server.close(resolve)); }
  assert.equal(await probeProject(url), 'available');
});

test('repeat launch reopens the page without spawning a second service', async () => {
  let opened = 0;
  await launch({ probe: async () => 'running', open: () => opened++, start: () => assert.fail('Duplicate service') });
  assert.equal(opened, 1);
});

test('occupied port produces a controlled error without opening or starting anything', async () => {
  try {
    await launch({ probe: async () => 'occupied', open: () => assert.fail('Wrong page'), start: () => assert.fail('Occupied port') });
    assert.equal(process.exitCode, 1);
  } finally { process.exitCode = 0; }
});

test('fresh launch starts the actual server with local settings and passes through errors', async () => {
  const service = new EventEmitter();
  let calls = 0;
  await launch({ probe: async () => 'available', open: () => assert.fail('Server opens its own page'), start: (exe, args, options) => {
    calls++;
    assert.equal(exe, process.execPath);
    assert.equal(args[0], path.join(root, 'server.js'));
    assert.equal(options.cwd, root);
    assert.equal(Object.hasOwn(options.env, 'PORT'), false);
    assert.equal(options.stdio, 'inherit');
    return service;
  } });
  assert.equal(calls, 1);
  try {
    service.emit('exit', 1);
    assert.equal(process.exitCode, 1);
  } finally { process.exitCode = 0; }
});

test('actual Windows batch parses correctly from both nested and outer Chinese paths', { skip: process.platform !== 'win32' }, () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'english-launch-check-'));
  const outer = path.join(tempRoot, '中文路径 启动检查');
  const inner = path.join(outer, 'Englishmurdermystery');
  try {
    fs.mkdirSync(path.join(inner, 'scripts'), { recursive: true });
    const launcher = fs.readFileSync(path.join(root, '启动.bat'));
    assert.ok([...launcher].every(byte => byte < 128), 'Batch commands must be ASCII');
    fs.writeFileSync(path.join(outer, '启动.bat'), launcher);
    fs.writeFileSync(path.join(inner, '启动.bat'), launcher);
    fs.writeFileSync(path.join(inner, 'scripts', 'launch.cjs'), 'console.log("LAUNCHER_PARSED_OK");');
    for (const cwd of [outer, inner]) {
      const result = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', '"call "%SCRIPT_KILL_TEST_BAT%""'], {
        cwd, encoding: 'utf8', timeout: 10000, input: '', windowsHide: true, windowsVerbatimArguments: true,
        env: { ...process.env, SCRIPT_KILL_TEST_BAT: path.join(cwd, '启动.bat') }
      });
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stdout, /LAUNCHER_PARSED_OK/);
      assert.equal(result.stderr, '');
    }
  } finally {
    assert.equal(path.dirname(tempRoot), os.tmpdir());
    assert.ok(path.basename(tempRoot).startsWith('english-launch-check-'));
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
