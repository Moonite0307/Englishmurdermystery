'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const quote = text => "'" + String(text).replace(/'/g, "''") + "'";

function buildMigration(accountDir) {
  const usersPath = path.join(accountDir, 'users.json');
  const users = fs.existsSync(usersPath) ? JSON.parse(fs.readFileSync(usersPath, 'utf8')) : {};
  if (!users || typeof users !== 'object' || Array.isArray(users)) throw new Error('原账号文件格式不正确，已停止迁移。');
  const sql = ['-- PRIVATE: password hashes and account records. Never commit or share this file.'];
  let count = 0;
  for (const [id, user] of Object.entries(users)) {
    if (!user || !/^[a-f0-9]{32}$/.test(id) || !/^[a-f0-9]{32}$/.test(user.salt) || !/^[a-f0-9]{128}$/.test(user.hash) ||
      crypto.createHash('sha256').update(String(user.username).toLowerCase()).digest('hex').slice(0, 32) !== id) {
      throw new Error('发现不兼容的原账号，已停止导出；没有改动原文件。');
    }
    // Conflict must fail. Never overwrite a different cloud user's password or learning history.
    sql.push('INSERT INTO users(id,username,salt,password_hash,created_at) VALUES(' +
      [id, user.username, user.salt, user.hash, user.createdAt || new Date().toISOString()].map(quote).join(',') + ');');
    const statePath = path.join(accountDir, 'states', id + '.json');
    const raw = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : {};
    const state = raw.state && typeof raw.state === 'object' ? raw.state : raw;
    if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('原学习记录格式不正确，已停止导出。');
    const stateJson = JSON.stringify(state);
    if (Buffer.byteLength(stateJson) > 1400000) throw new Error('有账号记录超过免费服务的单次大小上限，已停止导出，未截断记录。');
    sql.push('INSERT INTO states(user_id,state_json,updated_at) VALUES(' + quote(id) + ", '', " + quote(raw.savedAt || new Date().toISOString()) + ');');
    // Keep each statement below D1's SQL length limit, preserving all UTF-8 characters and quotes.
    let chunk = '', bytes = 0;
    const flush = () => { if (chunk) sql.push('UPDATE states SET state_json=state_json || ' + quote(chunk) + ' WHERE user_id=' + quote(id) + ';'); chunk = ''; bytes = 0; };
    for (const character of stateJson) {
      const size = Buffer.byteLength(character);
      if (bytes + size > 24000) flush();
      chunk += character; bytes += size;
    }
    flush(); count++;
  }
  return { sql: sql.join('\n') + '\n', count };
}
function exportMigration() {
  const outputDir = path.join(root, '.cloudflare-private');
  execFileSync('git', ['check-ignore', '--quiet', '--no-index', '.cloudflare-private/accounts.sql'], { cwd: root });
  const migration = buildMigration(path.join(root, 'data', 'accounts'));
  fs.mkdirSync(outputDir, { recursive: true });
  const output = path.join(outputDir, 'accounts.sql');
  fs.writeFileSync(output, migration.sql, { mode: 0o600 });
  console.log('已在 Git 忽略的私密目录生成 ' + migration.count + ' 个账号的迁移文件，未改动原账号。');
  console.log('迁移文件含密码校验数据，请勿上传 GitHub、截图或发送给他人。');
  return { ...migration, output };
}
module.exports = { buildMigration, exportMigration };
if (require.main === module) {
  try { exportMigration(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
