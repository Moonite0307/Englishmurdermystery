// Synthetic malformed model replies; no network or API key required.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const start = html.indexOf('function unescapeJsonStr');
const end = html.indexOf('function scrollChatBottom', start);
const ctx = vm.createContext({});
vm.runInContext(html.slice(start, end), ctx);
const parse = raw => { ctx.raw = raw; return vm.runInContext('parseNpcReply(raw)', ctx); };
const speech = 'The lights are back. Tell me what you saw.';
const good = { npc_dialogue: speech, speaker: 'DM', translation: '灯重新亮了。请说说你看见了什么。',
  completed_tasks: [1], game_over: false, vocab: [] };

test('normal, fenced, prefaced and double-encoded replies preserve Chinese and quoted dialogue', () => {
  const data = { ...good, npc_dialogue: 'He said "stay". C:\\room, /ɪnˈtrɪkət/, café.\nNext line.' };
  const json = JSON.stringify(data);
  for (const raw of [json, '\uFEFF' + json, '```json\n' + json + '\n```', 'Here is the reply:\n' + json, JSON.stringify(json)]) {
    const parsed = parse(raw);
    assert.equal(parsed.npc_dialogue, data.npc_dialogue);
    assert.equal(parsed.translation, data.translation);
    assert.equal(parsed.completed_tasks.join(','), '1');
  }
});

test('repair literal controls, invalid escapes and trailing commas without changing dialogue', () => {
  const raw = '{"npc_dialogue":"First line.\nNext\tline: C:\\quest","translation":"第一行。\n下一行。","vocab":[{"word":"gift",},],}';
  const parsed = parse(raw);
  assert.equal(parsed.npc_dialogue, 'First line.\nNext\tline: C:\\quest');
  assert.equal(parsed.translation, '第一行。\n下一行。');
  assert.equal(parsed.vocab[0].word, 'gift');
});

test('broken vocabulary examples recover only complete public fields, never completion or ending flags', () => {
  for (const tail of ['[{"example":"He said "stay"."}]}', '[{"example":"unfinished', 'oops}']) {
    const raw = JSON.stringify({ ...good, game_over: true }).replace('"vocab":[]}', '"vocab":' + tail);
    const parsed = parse(raw);
    assert.equal(parsed.npc_dialogue, speech);
    assert.equal(parsed.speaker, 'DM');
    assert.equal(parsed.translation, good.translation);
    assert.equal(parsed.completed_tasks.length, 0);
    assert.equal(parsed.completed_task, 0);
    assert.equal(parsed.game_over, false);
    assert.equal(parsed.vocab.length, 0);
  }
});

test('complete speech containing unescaped quotation marks can be recovered', () => {
  const parsed = parse('{"npc_dialogue":"He said "stay". Look here.","speaker":"Alice","vocab":oops}');
  assert.equal(parsed.npc_dialogue, 'He said "stay". Look here.');
  assert.equal(parsed.speaker, 'Alice');
});

test('truncated or swallowed fields, nested JSON and absent speech are rejected', () => {
  const broken = [
    '{"npc_dialogue":"The door is',
    '{"npc_dialogue":"The door is open, "speaker":"DM","translation":"一段文字","vocab":oops}',
    '{"npc_dialogue":"The door is open, "game_over":true,"vocab":oops}',
    JSON.stringify({ npc_dialogue: JSON.stringify(good) }),
    JSON.stringify({ npc_dialogue: '{"npc_dialogue":"Hello"}' }),
    JSON.stringify({ npc_dialogue: '"speaker": "DM", "game_over": true' }),
    '{"speaker":"DM"}', 'not JSON', 'null', '[]'
  ];
  for (const raw of broken) assert.throws(() => parse(raw), undefined, raw);
});

test('streaming exposes only the dialogue field and hides JSON-looking dialogue', () => {
  for (const raw of ['{"speaker":"DM",', '{"npc_dialogue":"{\\"npc_dialogue\\":', 'not JSON']) {
    ctx.raw = raw;
    assert.equal(vm.runInContext('extractStreamingDialogue(raw)', ctx), null);
  }
  ctx.raw = '{"npc_dialogue":"The lights are back.","speaker":"DM","vocab":';
  assert.equal(vm.runInContext('extractStreamingDialogue(raw)', ctx), 'The lights are back.');
});
