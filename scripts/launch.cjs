'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');
const address = 'http://127.0.0.1:8787/';

// Compare the served page to this checkout. Never terminate another process.
function probeProject(url = address, indexPath = path.join(projectRoot, 'index.html')) {
  const expected = fs.readFileSync(indexPath);
  return new Promise(resolve => {
    let settled = false;
    let timer;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const req = http.get(url, { agent: false }, res => {
      const chunks = [];
      let size = 0;
      res.on('data', chunk => {
        size += chunk.length;
        if (size > expected.length) {
          finish('occupied');
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => finish(res.statusCode === 200 && Buffer.concat(chunks).equals(expected) ? 'running' : 'occupied'));
      res.on('error', () => finish('occupied'));
    });
    req.on('error', error => finish(error.code === 'ECONNREFUSED' ? 'available' : 'occupied'));
    timer = setTimeout(() => {
      finish('occupied');
      req.destroy();
    }, 2500);
  });
}

function openBrowser() {
  const browser = spawn('cmd.exe', ['/d', '/c', 'start', '', address], { windowsHide: true, stdio: 'ignore' });
  browser.on('error', () => console.log('请手动在浏览器打开：' + address));
}

async function launch({ probe = probeProject, open = openBrowser, start = spawn } = {}) {
  if (Number(process.versions.node.split('.')[0]) < 18) {
    console.error('请安装 Node.js 18 或更新版本：https://nodejs.org/');
    process.exitCode = 1;
    return;
  }
  const status = await probe();
  if (status === 'running') {
    console.log('本项目已在运行，直接打开网页，无需重复启动。');
    console.log(address);
    open();
    return;
  }
  if (status !== 'available') {
    console.error('8787 端口已被其他服务占用，或正在运行不同版本的项目。');
    console.error('请关闭原服务的命令窗口后重试。本次未关闭任何进程。');
    process.exitCode = 1;
    return;
  }
  console.log('正在启动英语学习剧本杀，网页将在服务就绪后自动打开。');
  console.log('本地地址：' + address);
  console.log('请保持此窗口开启；关闭窗口会停止本地服务。');
  const env = { ...process.env };
  delete env.PORT;
  const service = start(process.execPath, [path.join(projectRoot, 'server.js')], {
    cwd: projectRoot, env, stdio: 'inherit', windowsHide: true
  });
  service.on('error', error => {
    console.error('启动失败：' + error.message);
    process.exitCode = 1;
  });
  service.on('exit', code => { process.exitCode = code === 0 ? 0 : 1; });
}

module.exports = { probeProject, launch };
if (require.main === module) launch().catch(error => {
  console.error('启动失败：' + error.message);
  process.exitCode = 1;
});
