// Browser checks use synthetic model responses and never call a paid API.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const fixture = require('./script-fixture.cjs');
let playwright;
try { playwright = require('playwright'); }
catch { playwright = require(path.join(process.env.USERPROFILE, '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')); }
const artifacts = process.env.GAME_UI_ARTIFACTS;
if (artifacts) fs.mkdirSync(artifacts, { recursive: true });
const pageUrl = process.env.GAME_UI_URL || 'http://127.0.0.1:8787/';

function reply(overrides = {}) {
  return { npc_dialogue: 'Please compare the gift and the record. What did you notice?', speaker: 'Alice',
    translation: '请比较礼物和记录。你注意到了什么？', grammar_tip: '无', task_type: 'free', options: [],
    option_translations: [], grammar_task: '', completed_task: 0, completed_tasks: [], game_over: false,
    story_phase: 'discussion', deduction_assessment: { question_id: '', verdict: 'none' }, vocab: [], ...overrides };
}
function actionEvent(task, index, text, target = '', response = '') {
  return { task_id: task, requirement_index: index, player_quote: text, target_id: target, response_quote: response };
}
async function setup(viewport, mode = 'en', staticMode = false, eofOnly = false, generation = {}) {
  const browser = await playwright.chromium.launch({ headless: true, channel: 'msedge' });
  const context = await browser.newContext({ viewport, isMobile: viewport.width <= 720, hasTouch: viewport.width <= 720 });
  const page = await context.newPage();
  const errors = [];
  const requests = [];
  const responses = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/api/config', r => staticMode ? r.fulfill({ status: 404, body: 'Static site' }) : r.fulfill({ json: { configured: true, model: 'mock' } }));
  // No external requests, including any fallback model or dictionary API.
  await page.route('https://**', r => r.abort());
  const handleChat = async route => {
    const req = route.request().postDataJSON(); requests.push(req);
    const isPlan = req.messages[0].content.includes('资深剧本杀编剧');
    const planned = isPlan && generation.replies && generation.replies.shift();
    const result = isPlan ? (planned ? planned.data : fixture()) : (responses.shift() || reply());
    const content = typeof result === 'string' ? result : JSON.stringify(result);
    const finish = planned && planned.finishReason ? '\n\ndata: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: planned.finishReason }] }) : '';
    await route.fulfill({ contentType: 'text/event-stream', body: 'data: ' + JSON.stringify({ choices: [{ delta: { content } }] }) + finish + (eofOnly ? '' : '\n\ndata: [DONE]\n\n') });
  };
  await page.route('**/api/chat', handleChat);
  await page.route('https://mock.invalid/v1/chat/completions', handleChat);
  if (staticMode) await page.addInitScript(() => localStorage.setItem('script-kill-llm-settings', JSON.stringify({ apiBase: 'https://mock.invalid/v1', apiKey: 'test-only', model: 'mock' })));
  await page.goto(pageUrl);
  await page.waitForFunction(wantStatic => (wantStatic ? !backendMode : backendMode) && EXAM_LEXICON.ready, staticMode);
  assert.equal(await page.locator('#api-settings, #backend-badge, #direct-mode-hint, #inp-api-base, #inp-api-key, #inp-model').count(), 0);
  await page.locator('[data-goal="' + (generation.goal || '高考') + '"]').click();
  await page.locator('#btn-goal-next').click();
  assert.ok(!/大模型接口设置|API Base URL|API Key|server\.js|config\.json/.test(await page.locator('#panel-config').innerText()));
  await page.locator('#sel-genre').selectOption(generation.genre || '欢乐本');
  await page.locator('#sel-reply-language').selectOption(mode);
  if (generation.theme) await page.locator('#inp-theme').fill(generation.theme);
  if (generation.background) await page.locator('#inp-background').fill(generation.background);
  await page.locator('#btn-generate').click();
  if (generation.expectFailure) {
    await page.locator('#error-banner').waitFor({ state: 'visible' });
    return { browser, page, errors, requests, responses };
  }
  await page.locator('#btn-start-game').waitFor({ state: 'visible' });
  assert.match(await page.locator('#sm-tasks').innerText(), /完成条件/);
  assert.match(await page.locator('#sm-reading-guide').innerText(), /任意.*单词.*生词本/);
  await page.locator('#btn-start-game').click();
  await page.waitForFunction(() => state === 'PLAYING' && !busy);
  return { browser, page, errors, requests, responses };
}

test('phone generation: screenshot configuration accepts normalized hints and equivalent character fields', async () => {
  const plan = fixture();
  plan.core_questions[0].direction_hint = '比较 Alice 的说法与两份记录。';
  plan.characters[0].agenda = { short_term: 'Find the gift', long_term: 'Make friends' };
  plan.relationships[0].to = 'alice';
  const { browser, page, errors, requests } = await setup({ width: 390, height: 844 }, 'zh', true, false,
    { goal: '中考', background: '王者峡谷', replies: [{ data: plan }] });
  try {
    const plans = requests.filter(r => r.messages[0].content.includes('资深剧本杀编剧'));
    assert.equal(plans.length, 1);
    assert.equal(plans[0].max_tokens, 8192);
    assert.equal(plans[0].temperature, 0.4);
    assert.ok(plans[0].messages[0].content.includes('王者峡谷'));
    assert.equal(await page.evaluate(() => validateScriptPlan(scriptData).length), 0);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('generation retries a length-limited draft and reaches a playable script', async () => {
  const { browser, page, errors, requests } = await setup({ width: 1280, height: 800 }, 'en', false, false,
    { replies: [{ data: '{"script_name":"partial', finishReason: 'length' }, { data: fixture() }] });
  try {
    const plans = requests.filter(r => r.messages[0].content.includes('资深剧本杀编剧'));
    assert.equal(plans.length, 2);
    assert.match(plans[1].messages[2].content, /精简|完整JSON/);
    assert.equal(await page.evaluate(() => state), 'PLAYING');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('generation repairs missing character links without rewriting the script', async () => {
  const plan = fixture('推理本');
  plan.relationships = plan.relationships.filter(r => r.from !== 'Alice' && r.to !== 'Alice');
  const { browser, page, errors, requests } = await setup({ width: 1280, height: 800 }, 'zh', true, false,
    { goal: '高考', genre: '推理本', theme: '喜羊羊大战灰太狼', background: '王者峡谷',
      replies: [{ data: plan }, { data: { updates: { relationships: fixture('推理本').relationships } } }] });
  try {
    const plans = requests.filter(r => r.messages[0].content.includes('资深剧本杀编剧'));
    assert.equal(plans.length, 2);
    assert.match(plans[1].messages[2].content, /只返回JSON补丁/);
    assert.match(plans[1].messages[2].content, /relationships/);
    assert.equal(await page.evaluate(() => validateScriptPlan(scriptData).length), 0);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('persistent generation failure shows a specific safe explanation and leaves controls usable', async () => {
  const plan = fixture(); delete plan.truth;
  const { browser, page, errors, requests } = await setup({ width: 390, height: 844 }, 'zh', true, false,
    { replies: [{ data: plan }, { data: plan }, { data: plan }], expectFailure: true });
  try {
    assert.equal(requests.length, 3);
    const text = await page.locator('#error-banner').innerText();
    assert.match(text, /故事背景或结局信息不完整/);
    assert.doesNotMatch(text, /HIDDEN_|truth|locked_ending/);
    assert.equal(await page.locator('#btn-generate').isEnabled(), true);
    assert.equal(await page.locator('#panel-config').isVisible(), true);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
async function noOverflow(page) {
  // Viewport resize events update the app height on the following browser frame.
  await page.waitForFunction(() => document.getElementById('btn-send').getBoundingClientRect().bottom <= visualViewport.height + 1);
  const dims = await page.evaluate(() => ({ width: innerWidth, pageWidth: document.documentElement.scrollWidth,
    height: visualViewport.height, send: document.getElementById('btn-send').getBoundingClientRect().bottom,
    chat: document.getElementById('chat-area').getBoundingClientRect().height }));
  assert.ok(dims.pageWidth <= dims.width + 1, JSON.stringify(dims));
  assert.ok(dims.send <= dims.height + 1, JSON.stringify(dims));
  assert.ok(dims.chat > 40, JSON.stringify(dims));
}

test('desktop: language blocking, private role book, task ticks and optional vocabulary collection', async () => {
  const { browser, page, errors, requests, responses } = await setup({ width: 1440, height: 900 });
  try {
    const before = requests.length;
    const input = page.locator('#inp-msg');
    await input.fill('I think 是礼物拿错了');
    await page.locator('#btn-send').click();
    assert.equal(requests.length, before);
    assert.equal(await page.locator('.msg-row.user').count(), 0);
    assert.match(await page.locator('#input-error').innerText(), /未发送/);
    assert.equal(await input.inputValue(), 'I think 是礼物拿错了');
    await input.press('Enter');
    assert.equal(requests.length, before);
    await input.dispatchEvent('keydown', { key: 'Enter', isComposing: true });
    assert.equal(requests.length, before);
    await page.evaluate(() => sendMessage('我想看看记录。')); // alternate call path is blocked too
    assert.equal(requests.length, before);
    assert.equal(await page.locator('#game-sidebar #vocab-list').count(), 0);
    assert.equal(await page.locator('#game-sidebar #vocab-progress-bar').count(), 0);
    const roleText = await page.locator('#sb-player-script').innerText();
    assert.match(roleText, /PLAYER_SECRET/);
    assert.ok(!roleText.includes('HIDDEN_'));
    assert.ok(!(await page.locator('#sb-story-background').innerText()).includes('HIDDEN_'));
    assert.match(await page.locator('#sb-task-goal').innerText(), /完成条件/);

    responses.push(reply({ completed_tasks: [1, 2], task_checks: [{ task_id: 1, status: 'completed', evidence: 'Compared records' }] }));
    await input.fill('I compared the two records and asked both guests.');
    await page.locator('#btn-send').click();
    await page.waitForFunction(() => !busy);
    assert.equal(await page.locator('.task-item.done').count(), 0);
    const delivered = 'Please compare the gift and the record.';
    for (const [text, task, index, target, speaker] of [
      ['Please show me record one.', 1, 1, 'C1', 'Alice'],
      ['Please show me record two.', 1, 1, 'C2', 'Alice'],
      ['Ask Alice what she saw.', 2, 1, 'Alice', 'Alice'],
      ['Ask Bob what he saw.', 2, 1, 'Bob', 'Bob'],
      ['I think the gift was taken by mistake.', 2, 2, '', 'Bob']
    ]) {
      responses.push(reply({ speaker, task_events: [actionEvent(task, index, text, target, target ? delivered : '')] }));
      await input.fill(text);
      await page.locator('#btn-send').click();
      await page.waitForFunction(() => !busy);
    }
    assert.equal(await page.locator('.task-item.done').count(), 2);
    assert.equal(await page.locator('#options-area').innerText(), '');
    const final = 'My final answer is a misplaced gift because the records disagree.';
    responses.push(reply({ completed_tasks: [3], story_phase: 'ballot', game_over: true,
      task_events: [actionEvent(3, 1, final), actionEvent(3, 2, 'because the records disagree.')] }));
    await input.fill(final);
    await input.press('Enter');
    await page.waitForFunction(() => completedTasks.size === 3 && !busy);
    assert.equal(await page.locator('.task-item.done').count(), 3);
    assert.equal(await page.evaluate(() => gameOverPending), false);
    const taskContext = requests.at(-1).messages.at(-1).content;
    assert.ok(taskContext.includes('"completed":true'));

    const word = page.locator('.msg-row.npc .vocab-word').filter({ hasText: /^gift$/ }).last();
    await word.click();
    await page.locator('#vocab-popover').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#vp-add-btn').count(), 1);
    await page.locator('#vp-close').click();
    assert.equal(await page.evaluate(() => vocabBook.size), 0);
    await word.click();
    await page.locator('#vp-add-btn').click();
    await page.locator('#vp-spell-input').fill('gift');
    await page.locator('#vp-spell-btn').click();
    assert.equal(await page.evaluate(() => vocabBook.has('gift')), true);
    await noOverflow(page);
    if (artifacts) await page.screenshot({ path: path.join(artifacts, 'desktop.png') });
    await page.locator('#btn-reset').click();
    await page.locator('#btn-open-vocab-book').click();
    assert.match(await page.locator('#vocab-book-list').innerText(), /gift/);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('Chinese mode accepts Chinese and mixed answers while NPC dialogue stays English', async () => {
  const { browser, page, errors, requests } = await setup({ width: 1280, height: 800 }, 'zh', true);
  try {
    for (const answer of ['我想看看记录。', 'I think 礼物被拿错了。', 'Please show me the gift.']) {
      const before = requests.length;
      await page.locator('#inp-msg').fill(answer);
      await page.locator('#btn-send').click();
      await page.waitForFunction(() => !busy);
      assert.equal(requests.length, before + 1);
      assert.equal(requests.at(-1).messages.filter(m => m.role === 'user').at(-1).content, answer);
    }
    assert.match(requests.at(-1).messages[0].content, /允许中文、英文和中英混合/);
    assert.match(await page.locator('#reply-language-note').innerText(), /中文.*英文均可/);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('screenshot regression: Lazy alone cannot complete the two-person task or supply the player explanation', async () => {
  const plan = JSON.parse(JSON.stringify(fixture('推理本')).replaceAll('Alice', 'Lazy').replaceAll('Bob', 'Pleasant'));
  const targets = plan.task_criteria[1].requirements[0].targets;
  targets[0].label = '懒羊羊'; targets[0].aliases = ['Lazy', '懒羊羊', '懒洋洋'];
  targets[1].label = '喜羊羊'; targets[1].aliases = ['Pleasant', '喜羊羊'];
  const { browser, page, errors, responses, requests } = await setup({ width: 1280, height: 900 }, 'zh', true, false,
    { genre: '推理本', theme: '喜羊羊大战灰太狼', background: '王者峡谷', replies: [{ data: plan }] });
  try {
    const speech = 'I saw Beauty by the pit. She buried something in the soil.';
    async function send(text, speaker, events) {
      responses.push(reply({ speaker, npc_dialogue: speech, completed_task: 2, completed_tasks: [2],
        task_checks: [{ task_id: 2, status: 'completed', evidence: 'Both sheep talked.' }], task_events: events }));
      await page.locator('#inp-msg').fill(text);
      await page.locator('#btn-send').click();
      await page.waitForFunction(() => !busy);
    }
    const ask = 'Ask Lazy what he saw nearby';
    await send(ask, 'Lazy', [actionEvent(2, 1, ask, 'Lazy', speech), actionEvent(2, 1, ask, 'Pleasant', speech),
      actionEvent(2, 2, speech)]);
    assert.equal(await page.locator('.task-item.done').count(), 0);
    assert.match(await page.locator('.task-progress').nth(1).innerText(), /1\/2人.*喜羊羊.*尚未提出/);
    assert.equal(await page.locator('.task-toast').count(), 0);
    await page.evaluate(() => markTaskCompleted(2, 'fake completion'));
    assert.equal(await page.locator('.task-item.done').count(), 0);
    await send('我想问懒洋洋，what did you see?', 'Lazy', [actionEvent(2, 1, '我想问懒洋洋，what did you see?', 'Lazy', speech)]);
    assert.match(await page.locator('.task-progress').nth(1).innerText(), /1\/2人/);
    await send('问问喜羊羊，他看到了什么？', 'Pleasant', [actionEvent(2, 1, '问问喜羊羊，他看到了什么？', 'Pleasant', speech)]);
    assert.match(await page.locator('.task-progress').nth(1).innerText(), /2\/2人.*尚未提出/);
    assert.equal(await page.locator('.task-item.done').count(), 0);
    const explanation = '我觉得美羊羊可能把东西藏起来了。';
    await send(explanation, 'Pleasant', [actionEvent(2, 2, explanation)]);
    assert.equal(await page.locator('.task-item.done').count(), 1);
    assert.equal(await page.locator('.task-toast').count(), 1);
    assert.equal(await page.evaluate(() => completedTasks.has(2)), true);
    await send('谢谢。', 'Pleasant', []);
    assert.equal(await page.locator('.task-toast').count(), 1);
    assert.match(requests.at(-1).messages.at(-1).content, /verified.*懒洋洋/);
    if (artifacts) await page.screenshot({ path: path.join(artifacts, 'verified-task-progress.png') });
    await page.locator('#btn-reset').click();
    assert.equal(await page.evaluate(() => taskProgressState.records.size), 0);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('phone: drawer, keyboard focus, word popup, small screens, landscape and reset', async () => {
  const { browser, page, errors } = await setup({ width: 390, height: 844 });
  try {
    await noOverflow(page);
    await page.locator('#btn-game-panel').click();
    await page.locator('#game-sidebar').waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.getElementById('game-sidebar').getBoundingClientRect().x >= -1);
    assert.equal(await page.locator('#btn-game-panel').getAttribute('aria-expanded'), 'true');
    assert.match(await page.locator('#sb-player-script').innerText(), /PLAYER_SECRET/);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#btn-game-panel').getAttribute('aria-expanded'), 'false');
    assert.equal(await page.locator('#btn-game-panel').evaluate(e => e === document.activeElement), true);
    const word = page.locator('.msg-row.npc .vocab-word').filter({ hasText: /^gift$/ }).last();
    await word.click();
    await page.locator('#vocab-popover').waitFor({ state: 'visible' });
    const popup = await page.locator('#vocab-popover').boundingBox();
    assert.ok(popup.x >= 0 && popup.x + popup.width <= 391);
    assert.ok(popup.y >= 0 && popup.y + popup.height <= 845);
    await page.setViewportSize({ width: 390, height: 360 });
    await page.waitForFunction(() => document.getElementById('vocab-popover').getBoundingClientRect().bottom <= visualViewport.height);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#vp-close').click();
    if (artifacts) await page.screenshot({ path: path.join(artifacts, 'phone.png') });
    await page.locator('#btn-game-panel').click();
    await page.waitForFunction(() => document.getElementById('game-sidebar').getBoundingClientRect().x >= -1);
    if (artifacts) await page.screenshot({ path: path.join(artifacts, 'phone-role.png') });
    await page.locator('#btn-close-game-panel').click();
    for (const size of [{ width: 320, height: 568 }, { width: 390, height: 360 }, { width: 844, height: 390 }]) {
      await page.setViewportSize(size);
      await noOverflow(page);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#btn-game-panel').click();
    await page.locator('#btn-reset').click();
    await page.locator('#panel-config').waitFor({ state: 'visible' });
    assert.equal(await page.locator('body').evaluate(e => e.classList.contains('sidebar-open')), false);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('malformed replies recover dialogue, retry safely and never display raw internal JSON', async () => {
  const { browser, page, errors, requests, responses } = await setup({ width: 1280, height: 800 }, 'en', false, true);
  try {
    // Observe intermediate streaming changes as well as the final bubbles.
    await page.evaluate(() => {
      window.leakedReplyData = [];
      new MutationObserver(() => {
        for (const el of document.querySelectorAll('.msg-row.npc .bubble')) {
          if (/"(?:npc_dialogue|speaker|task_checks|game_over|vocab)"\s*:/.test(el.textContent)) window.leakedReplyData.push(el.textContent);
        }
      }).observe(document.getElementById('chat-area'), { childList: true, subtree: true, characterData: true });
    });
    const send = async text => {
      await page.locator('#inp-msg').fill(text);
      await page.locator('#btn-send').click();
      await page.waitForFunction(() => !busy);
    };
    responses.push('{"npc_dialogue":"The lights are back. Tell me what you saw.","speaker":"DM","translation":"灯重新亮了。","completed_tasks":[1,2,3],"game_over":true,"vocab":[{"example":"He said "stay"."}]}');
    let before = requests.length;
    await send('Please check the room.');
    assert.equal(requests.length, before + 1);
    assert.equal(await page.locator('.msg-row.npc .bubble').last().innerText(), 'The lights are back. Tell me what you saw.');
    assert.equal(await page.evaluate(() => completedTasks.size), 0);
    assert.equal(await page.evaluate(() => gameOverPending), false);
    await page.locator('.msg-row.npc .translate-btn').last().click();
    assert.equal(await page.locator('.translation-box').last().innerText(), '灯重新亮了。');

    before = requests.length;
    responses.push('{"npc_dialogue":"cut off', reply({ completed_tasks: [1] }));
    await send('I compared the records.');
    assert.equal(requests.length, before + 2);
    assert.equal(await page.locator('.task-item.done').count(), 0);
    assert.equal(await page.locator('.msg-row.user').count(), 2);
    assert.match(requests.at(-1).messages.at(-1).content, /不是玩家的新行动/);

    before = requests.length;
    responses.push('not JSON', '{"npc_dialogue":"cut off');
    await send('Please ask Alice.');
    assert.equal(requests.length, before + 2);
    assert.match(await page.locator('.error-box').innerText(), /回答已保留/);
    assert.equal(await page.locator('.msg-row.user').count(), 3);
    assert.equal(await page.locator('.task-item.done').count(), 0);
    responses.push(reply({ completed_tasks: [2], task_events: [actionEvent(2, 1, 'Please ask Alice.', 'Alice', 'Please compare the gift and the record.')] }));
    await page.locator('.retry-link').click();
    await page.waitForFunction(() => !busy);
    assert.equal(await page.locator('.error-box').count(), 0);
    assert.equal(await page.locator('.msg-row.user').count(), 3);
    assert.equal(await page.locator('.task-item.done').count(), 0);
    assert.equal(await page.evaluate(() => taskRequirementRecords(2, 1).size), 1);
    assert.equal(await page.evaluate(() => messages.filter(m => m.role === 'user' && m.content === 'Please ask Alice.').length), 1);
    assert.equal(await page.evaluate(() => messages.filter(m => m.role === 'assistant').every(m => {
      try { return typeof JSON.parse(m.content).npc_dialogue === 'string'; } catch (_) { return false; }
    })), true);
    assert.deepEqual(await page.evaluate(() => window.leakedReplyData), []);
    if (artifacts) await page.screenshot({ path: path.join(artifacts, 'reply-repaired.png') });
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
