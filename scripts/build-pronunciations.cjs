// Rebuild the project's separate UK/US pronunciation data; normal site builds use the saved JSON.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const sources = {
  uk: 'https://raw.githubusercontent.com/open-dict-data/ipa-dict/master/data/en_UK.txt',
  us: 'https://raw.githubusercontent.com/open-dict-data/ipa-dict/master/data/en_US.txt',
  mit: 'https://raw.githubusercontent.com/open-dict-data/ipa-dict/master/LICENSE',
  gpl: 'https://raw.githubusercontent.com/leoboiko/ipacards/master/LICENSE'
};
async function main() {
  const { Agent, ProxyAgent, setGlobalDispatcher } = require('undici');
  const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  setGlobalDispatcher(proxy ? new ProxyAgent(proxy) : new Agent({ connect: { timeout: 30000 } }));
  const cache = path.join(root, '.cloudflare-private/pronunciation-source');
  fs.mkdirSync(cache, { recursive: true });
  const raw = {};
  for (const [name, url] of Object.entries(sources)) {
    const file = path.join(cache, name + '.txt');
    if (fs.existsSync(file)) { raw[name] = fs.readFileSync(file, 'utf8'); continue; }
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        raw[name] = await response.text(); fs.writeFileSync(file, raw[name]);
        console.log('Downloaded ' + name + ' pronunciation source'); break;
      } catch (error) {
        if (attempt === 3) throw new Error(name + ' download: ' + (error.cause?.code || error.message));
      }
    }
  }
  const wanted = new Set(Object.keys(JSON.parse(fs.readFileSync(path.join(root, 'data/daily/exam_lexicon.json'), 'utf8')).words));
  for (const entry of JSON.parse(fs.readFileSync(path.join(root, 'data/daily/vocabulary.json'), 'utf8')).words) {
    [entry.word, entry.lemma, ...(entry.surface_forms || [])].filter(Boolean).forEach(w => wanted.add(String(w).toLowerCase()));
  }
  const words = {};
  for (const accent of ['uk', 'us']) {
    let total = 0;
    for (const line of raw[accent].split(/\r?\n/)) {
      const tab = line.indexOf('\t');
      if (tab < 1) continue;
      const word = line.slice(0, tab).trim().toLowerCase(), ipa = line.slice(tab + 1).trim();
      if (!wanted.has(word) || !ipa) continue;
      (words[word] ||= {})[accent] = ipa; total++;
    }
    if (total < 1000) throw new Error('Incomplete ' + accent + ' dictionary; no output was written.');
  }
  const data = { schema_version: 'pronunciations.v1',
    attribution: 'UK: ipa-dict / ipacards (leoboiko), GPL-3.0. US: ipa-dict / cmudict-ipa (lingz), MIT. See pronunciation-LICENSE.txt.',
    source_urls: { uk: sources.uk, us: sources.us },
    source_sha256: Object.fromEntries(['uk', 'us'].map(k => [k, crypto.createHash('sha256').update(raw[k]).digest('hex')])), words };
  fs.writeFileSync(path.join(root, 'data/daily/pronunciations.json'), JSON.stringify(data) + '\n');
  fs.writeFileSync(path.join(root, 'data/daily/pronunciation-LICENSE.txt'),
    'English pronunciation data\n\nUK data is derived from ipacards by leoboiko through open-dict-data/ipa-dict and retains GPL-3.0.\n' +
    'US data is based on cmudict-ipa by lingz through open-dict-data/ipa-dict and retains MIT.\n' +
    'This project selects entries for its own vocabulary. The editable JSON and build-pronunciations.cjs are provided alongside the app.\n' +
    Object.values(sources).join('\n') + '\n\n--- MIT ---\n' + raw.mit.trimEnd() + '\n\n--- GPL-3.0 ---\n' + raw.gpl.trimEnd() + '\n');
  const counts = Object.values(words).reduce((c, w) => { c.uk += !!w.uk; c.us += !!w.us; c.both += !!(w.uk && w.us); return c; }, { uk: 0, us: 0, both: 0 });
  console.log(JSON.stringify({ entries: Object.keys(words).length, ...counts, bytes: fs.statSync(path.join(root, 'data/daily/pronunciations.json')).size }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
