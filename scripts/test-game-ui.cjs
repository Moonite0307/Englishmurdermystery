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
function contrastRatio(foreground, background) {
  const luminance = color => {
    const values = color.match(/[\d.]+/g).slice(0, 3).map(Number).map(value => value / 255)
      .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
    return .2126 * values[0] + .7152 * values[1] + .0722 * values[2];
  };
  const a = luminance(foreground), b = luminance(background);
  return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
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
  if (generation.openingReply) responses.push(generation.openingReply);
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/api/config', r => staticMode ? r.fulfill({ status: 404, body: 'Static site' }) : r.fulfill({ json: { configured: true, model: 'mock' } }));
  // No external requests, including any fallback model or dictionary API.
  await page.route('https://**', r => r.abort());
  const handleChat = async route => {
    const req = route.request().postDataJSON(); requests.push(req);
    const isPlan = req.messages[0].content.includes('资深剧本杀编剧');
    const planned = isPlan && generation.replies && generation.replies.shift();
    const result = isPlan ? (planned ? planned.data : fixture()) : (responses.shift() || (generation.replyMode === 'options' ? reply({
      task_type: 'choice', options: ["I'd like to inspect record one.", 'Alice, what did you notice?'], option_translations: ['我想查看记录一。', '爱丽丝，你注意到了什么？']
    }) : reply()));
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
  await page.locator('#btn-explore-learning').click();
  await page.locator('[data-goal="' + (generation.goal || '高考') + '"]').click();
  await page.locator('#btn-goal-next').click();
  assert.ok(!/大模型接口设置|API Base URL|API Key|server\.js|config\.json/.test(await page.locator('#panel-config').innerText()));
  await page.locator('#sel-genre').selectOption(generation.genre || '欢乐本');
  await page.locator('#sel-reply-mode').selectOption(generation.replyMode || 'free');
  if (generation.replyMode !== 'options') await page.locator('#sel-reply-language').selectOption(mode);
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

test('home paths open a full guide or exploration; return navigation preserves the selected goal and shared typography', async () => {
  const browser = await playwright.chromium.launch({ headless: true, channel: 'msedge' });
  try {
    for (const width of [1440, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
      await page.route('https://**', route => route.abort());
      await page.goto(pageUrl);
      await page.locator('#btn-explore-learning').waitFor();
      if (width === 1440) {
        if (artifacts) await page.screenshot({ path: path.join(artifacts, 'home-night.png') });
        const nightPalette = await page.locator('body').evaluate(el => getComputedStyle(el).getPropertyValue('--bg').trim());
        await page.locator('#theme-toggle').click();
        await page.waitForFunction(() => getComputedStyle(document.querySelector('#theme-toggle')).backgroundColor === 'rgb(255, 250, 240)');
        const dayPalette = await page.locator('body').evaluate(el => ({
          className: el.className,
          bg: getComputedStyle(el).getPropertyValue('--bg').trim(),
          panel: getComputedStyle(el).getPropertyValue('--bg-panel').trim(),
          ink: getComputedStyle(el).getPropertyValue('--text').trim(),
          gold: getComputedStyle(el).getPropertyValue('--case-gold').trim(),
          toggle: getComputedStyle(document.querySelector('#theme-toggle')).backgroundColor
        }));
        assert.equal(dayPalette.className.includes('light'), true);
        assert.notEqual(dayPalette.bg, nightPalette);
        assert.equal(dayPalette.bg, '#f4efe4');
        assert.equal(dayPalette.panel, '#fffaf0');
        assert.equal(dayPalette.ink, '#352c23');
        assert.equal(dayPalette.toggle, 'rgb(255, 250, 240)');
        if (artifacts) await page.screenshot({ path: path.join(artifacts, 'home-day.png') });
        await page.locator('#theme-toggle').click();
      }
      assert.equal(await page.locator('#step-guide').isVisible(), false);
      assert.equal(await page.locator('#btn-open-guide').isVisible(), true);
      assert.equal(await page.locator('#step-goal').isVisible(), false);
      await page.locator('#btn-open-guide').click();
      assert.equal(await page.locator('#step-home').isVisible(), false);
      assert.equal(await page.locator('#step-guide .experience-section').isVisible(), true);
      assert.equal(await page.locator('#step-guide .guide-section').count(), 6);
      await page.locator('.guide-contents a[href="#guide-review"]').click();
      await page.locator('#guide-review-title').waitFor({ state: 'visible' });
      const fonts = await page.evaluate(() => ['.site-brand strong', '.entry-title', '#guide-heading', '#btn-open-guide', '#guide-review-title'].map(selector => getComputedStyle(document.querySelector(selector)).fontFamily));
      assert.equal(new Set(fonts).size, 1);
      await page.locator('#btn-guide-home-bottom').click();
      assert.equal(await page.locator('#step-home').isVisible(), true);
      await page.locator('#btn-open-guide').click();
      await page.locator('[data-start-exploring]').first().click();
      assert.equal(await page.locator('#step-goal').isVisible(), true);
      await page.locator('#btn-back-home').click();
      const surfaces = await page.evaluate(() => ['.entry-intro', '.experience-section', '.home-selection'].map(selector => {
        const style = getComputedStyle(document.querySelector(selector));
        return [style.backgroundColor, style.borderTopWidth, style.borderBottomWidth];
      }));
      assert.ok(surfaces.every(([color, top, bottom]) => color === 'rgba(0, 0, 0, 0)' && top === '0px' && bottom === '0px'));
      await page.locator('#btn-explore-learning').click();
      assert.equal(await page.locator('#step-home').isVisible(), false);
      assert.equal(await page.locator('#step-goal').isVisible(), true);
      assert.equal(await page.locator('#panel-config').evaluate(el => el.scrollTop), 0);
      await page.locator('[data-goal=高考]').click();
      await page.locator('#btn-back-home').click();
      assert.equal(await page.locator('#step-home').isVisible(), true);
      await page.locator('#btn-explore-learning').click();
      assert.equal(await page.locator('[data-goal=高考]').getAttribute('aria-pressed'), 'true');
      await page.locator('#btn-goal-next').click();
      assert.equal(await page.locator('#step-exam-script').isVisible(), true);
      assert.equal(await page.locator('#sel-reply-mode').inputValue(), 'options');
      assert.equal(await page.locator('#reply-language-exam').evaluate(el => el.classList.contains('hidden')), true);
      await page.locator('#btn-back-exam-goal').click();
      await page.locator('#btn-home').click();
      assert.equal(await page.locator('#step-home').isVisible(), true);
      await page.close();
    }
  } finally { await browser.close(); }
});

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
    assert.deepEqual(await page.evaluate(() => Object.keys(localStorage).filter(key => /^wp_(daily_progress|vocab_book|learning_vocab|script_history)/.test(key))), []);
    await noOverflow(page);
    if (artifacts) await page.screenshot({ path: path.join(artifacts, 'desktop.png') });
    await page.locator('#btn-reset').click();
    await page.locator('#btn-exit-switch').click();
    await page.locator('#btn-open-vocab-book').click();
    assert.match(await page.locator('#vocab-book-list').innerText(), /gift/);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('explicit save restores the locked story, evidence, search options, translations and draft without another opening', async () => {
  const { browser, page, errors, requests, responses } = await setup({ width: 1280, height: 900 }, 'zh');
  try {
    assert.equal(await page.evaluate(() => scriptRunStatusText(currentRun())), '本次未保存');
    const ask = 'Please inspect record one';
    responses.push(reply({ task_type: 'search', options: ['Inspect record one', 'Inspect record two'],
      option_translations: ['查看记录一', '查看记录二'], task_events: [actionEvent(1, 1, ask, 'C1', 'public observation 0')] }));
    await page.locator('#inp-msg').fill(ask); await page.locator('#btn-send').click();
    await page.waitForFunction(() => !busy);
    await page.evaluate(() => { searchedItems.add('inspect record one'); deductionProgress = { questionId: 'Q1', wrongStreak: 2 }; });
    await page.locator('.translate-btn').last().click();
    await page.locator('#inp-msg').fill('我还想看看另一份记录');
    const before = await page.evaluate(() => ({ plan: scriptPlan, messages, id: currentRunId, task: taskProgressDescription(1),
      appearances: [...learningVocab.values()].map(v => v.appearances), transcript: currentRun().transcript.length }));
    const requestCount = requests.length;
    await page.locator('#btn-reset').click();
    assert.match(await page.locator('#exit-guest-note').innerText(), /刷新.*清空/);
    await page.locator('#btn-exit-save').click();
    assert.equal(await page.locator('#step-home').isVisible(), true);
    assert.equal(await page.evaluate(() => scriptHistory[0].status), 'playing');
    await page.locator('#btn-open-script-history').click();
    assert.match(await page.locator('.run-badge').innerText(), /进行中/);
    await page.locator('.run-card').click(); await page.locator('.btn-resume-run').click();
    assert.equal(await page.locator('#panel-playing').isVisible(), true);
    const after = await page.evaluate(() => ({ plan: scriptPlan, messages, id: currentRunId, task: taskProgressDescription(1),
      appearances: [...learningVocab.values()].map(v => v.appearances), transcript: currentRun().transcript.length }));
    assert.deepEqual(after, before);
    assert.equal(await page.evaluate(() => Object.isFrozen(scriptData) && Object.isFrozen(scriptData.characters)), true);
    assert.equal(requests.length, requestCount);
    assert.equal(await page.locator('#inp-msg').inputValue(), '我还想看看另一份记录');
    assert.match(await page.locator('#sb-player-script').innerText(), /PLAYER_SECRET/);
    assert.equal(await page.locator('.translation-box:not(.hidden)').count(), 1);
    assert.equal(await page.locator('.option-btn').count(), 1);
    assert.match(await page.locator('#options-area').innerText(), /record two/);
    assert.deepEqual(await page.evaluate(() => deductionProgress), { questionId: 'Q1', wrongStreak: 2 });
    await page.locator('.option-btn .opt-prefix').click(); await page.waitForFunction(() => !busy);
    assert.equal(requests.length, requestCount + 1);
    assert.equal(requests.at(-1).messages.filter(m => m.role === 'user').at(-1).content, 'Inspect record two');
    await page.locator('#btn-reset').click(); await page.locator('#btn-exit-switch').click();
    assert.equal(await page.evaluate(() => scriptHistory[0].status), 'left');
    assert.equal(await page.evaluate(() => !!scriptHistory[0].resume), false);
    await page.reload(); await page.waitForFunction(() => EXAM_LEXICON.ready);
    assert.equal(await page.evaluate(() => scriptHistory.length + vocabBook.size + learningVocab.size), 0);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('word cards hide Chinese until rated, support corrections, repeat review and shared mastered filters in both themes', async () => {
  const { browser, page, errors } = await setup({ width: 390, height: 844 });
  try {
    await page.evaluate(() => {
      const word = [...learningVocab.values()].find(v => v.word.toLowerCase() === 'gift');
      word.example = 'This gift is for you.'; word.example_cn = '这个礼物是给你的。';
      addVocabEntry(word);
    });
    await page.locator('#btn-game-panel').click(); await page.locator('#btn-reset').click();
    await page.locator('#btn-exit-switch').click(); await page.locator('#btn-open-vocab-book').click();
    assert.match(await page.locator('#step-vocab-book .wizard-sub').innerText(), /自测.*已掌握.*未掌握.*重复复习/);
    await page.locator('.vocab-book-item').click();
    assert.equal(await page.locator('#review-meaning-wrap').isVisible(), false);
    assert.equal(await page.locator('#review-example-cn').isVisible(), false);
    assert.equal(await page.locator('#review-example-en').innerText(), 'This gift is for you.');
    assert.equal(await page.locator('#review-nav').isVisible(), false);
    assert.equal(await page.locator('#review-extra').innerText().then(t => /词表第|词频|排名/.test(t)), false);
    const firstTheme = await page.locator('#review-modal').evaluate(el => getComputedStyle(el).getPropertyValue('--rv-bg'));
    if (artifacts) await page.screenshot({ path: path.join(artifacts, 'word-self-test-dark.png') });
    await page.locator('.review-rate.known').click();
    assert.equal(await page.locator('#review-meaning-wrap').isVisible(), true);
    assert.equal(await page.locator('#review-example-cn').innerText(), '这个礼物是给你的。');
    assert.match(await page.locator('#review-hint').innerText(), /已加入【已掌握】/);
    assert.equal(await page.evaluate(() => vocabBook.get('gift').mastered), true);
    assert.equal(await page.evaluate(() => [...learningVocab.values()].find(v => v.word === 'gift').mastered), true);
    if (artifacts) await page.screenshot({ path: path.join(artifacts, 'word-self-test-revealed.png') });
    await page.locator('#btn-review-undo').click();
    assert.equal(await page.evaluate(() => learningStatusOf(vocabBook.get('gift'))), 'unknown');
    assert.equal(await page.evaluate(() => vocabBook.get('gift').srs.reviews), 1);
    assert.match(await page.locator('#review-hint').innerText(), /已加入【未掌握】/);
    assert.equal(await page.locator('#btn-review-undo').isVisible(), false);
    await page.locator('#btn-review-close').click();
    await page.locator('#book-status-filter').selectOption('mastered');
    assert.equal(await page.locator('.vocab-book-item').count(), 0);
    await page.locator('#book-status-filter').selectOption('unknown');
    assert.equal(await page.locator('.vocab-book-item').count(), 1);
    await page.locator('.vocab-book-item').click();
    assert.equal(await page.locator('#review-meaning-wrap').isVisible(), false);
    await page.locator('.review-rate.known').click();
    await page.locator('#btn-review-next').click();
    assert.equal(await page.locator('#review-word').innerText(), '本组复习完成');
    await page.locator('#btn-review-done').click();
    await page.locator('#btn-home').click(); await page.locator('#btn-open-vocab-review').click();
    await page.locator('#review-status-filter').selectOption('mastered');
    assert.equal(await page.locator('.learning-word-main').count(), 1);
    await page.locator('#theme-toggle').click();
    await page.locator('.learning-word-main').click();
    assert.equal(await page.locator('#review-meaning-wrap').isVisible(), false);
    assert.notEqual(await page.locator('#review-modal').evaluate(el => getComputedStyle(el).getPropertyValue('--rv-bg')), firstTheme);
    if (artifacts) await page.screenshot({ path: path.join(artifacts, 'word-self-test-light.png') });
    await page.locator('.review-rate.unknown').click();
    assert.equal(await page.evaluate(() => learningStatusOf(vocabBook.get('gift'))), 'unknown');
    assert.match(await page.locator('#review-hint').innerText(), /已加入【未掌握】/);
    await page.locator('#btn-review-close').click();
    await page.locator('#review-status-filter').selectOption('unknown');
    assert.equal(await page.locator('.learning-word-main').count(), 1);
    assert.deepEqual(await page.evaluate(() => Object.keys(localStorage).filter(k => /^wp_(vocab_book|learning_vocab)/.test(k))), []);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('exit waits for the current reply; warm conversation colors and review controls fit both themes and small screens', async () => {
  const { browser, page, errors } = await setup({ width: 390, height: 844 });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  try {
    async function preview(name) {
      const style = await page.locator('.msg-row.npc .bubble').last().evaluate(el => ({
        background: getComputedStyle(el).backgroundColor,
        text: getComputedStyle(el).color,
        expected: getComputedStyle(el).getPropertyValue('--dialogue-surface').trim(),
        light: document.body.classList.contains('light'),
        speaker: el.closest('.msg-row').querySelector('.speaker-label').textContent,
        icon: el.closest('.msg-row').querySelectorAll('.avatar-icon').length,
        role: el.closest('.msg-row').querySelector('.avatar').getAttribute('aria-hidden') }));
      assert.ok(style.background && style.expected);
      assert.equal(style.background, (() => {
        const m = style.expected.match(/^#([\da-f]{6})$/i);
        if (!m) return style.background;
        const n = m[1]; return `rgb(${parseInt(n.slice(0,2),16)}, ${parseInt(n.slice(2,4),16)}, ${parseInt(n.slice(4,6),16)})`;
      })());
      assert.ok(contrastRatio(style.text, style.background) >= 4.5);
      assert.equal(style.speaker, 'Alice'); assert.equal(style.icon, 1); assert.equal(style.role, 'true');
      const player = await page.locator('.msg-row.user').last().evaluate(row => {
        const bubble = row.querySelector('.bubble'), avatar = row.querySelector('.avatar');
        return { background: getComputedStyle(bubble).backgroundColor, text: getComputedStyle(bubble).color,
          name: avatar.textContent.trim(), aria: avatar.getAttribute('aria-hidden'), alignment: getComputedStyle(row).justifyContent,
          x: bubble.getBoundingClientRect().x + bubble.getBoundingClientRect().width };
      });
      assert.equal(player.name, '我'); assert.equal(player.aria, 'true'); assert.equal(player.alignment, 'flex-end');
      assert.ok(contrastRatio(player.text, player.background) >= 4.5);
      assert.ok(player.x <= 390);
      await noOverflow(page);
      if (artifacts) await page.screenshot({ path: path.join(artifacts, name) });
      return style.background;
    }
    await page.evaluate(() => addUserBubble('Where were you at that moment?'));
    const dark = await preview('warm-chat-dark.png');
    await page.locator('#theme-toggle').click();
    const light = await preview('warm-chat-light.png'); assert.notEqual(dark, light);
    await page.route('**/api/chat', async route => {
      await gate;
      await route.fulfill({ contentType: 'text/event-stream', body: 'data: ' + JSON.stringify({ choices: [{ delta: { content: JSON.stringify(reply()) } }] }) + '\n\ndata: [DONE]\n\n' });
    });
    await page.locator('#inp-msg').fill('Please show me the gift.'); await page.locator('#btn-send').click();
    await page.waitForFunction(() => busy);
    await page.locator('#btn-game-panel').click(); await page.locator('#btn-reset').click();
    assert.equal(await page.locator('#btn-exit-save').isDisabled(), true);
    assert.equal(await page.locator('#btn-exit-switch').isDisabled(), true);
    assert.equal(await page.locator('#btn-exit-save').evaluate(el => {
      const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
    }), true);
    release(); await page.waitForFunction(() => !busy);
    assert.equal(await page.locator('#btn-exit-save').isEnabled(), true);
    if (artifacts) await page.screenshot({ path: path.join(artifacts, 'save-exit-light.png') });
    await page.locator('#btn-exit-save').click(); await page.locator('#btn-open-script-history').click();
    if (artifacts) await page.screenshot({ path: path.join(artifacts, 'saved-history-light.png') });
    await page.locator('#btn-home').click(); await page.locator('#btn-open-vocab-review').click();
    await page.locator('#btn-start-review').click();
    const count = await page.evaluate(() => reviewSession.queue.length); assert.ok(count >= 2);
    await page.locator('.review-rate.known').click(); await page.locator('#btn-review-next').click();
    assert.equal(await page.locator('#review-meaning-wrap').isVisible(), false);
    assert.equal(await page.locator('#review-example-cn').isVisible(), false);
    assert.equal(await page.locator('#review-nav').isVisible(), false);
    await page.setViewportSize({ width: 320, height: 568 });
    const bounds = await page.locator('.review-actions').boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 321 && bounds.y + bounds.height <= 569);
    assert.deepEqual(errors, []);
  } finally { release(); await browser.close(); }
});

test('English option mode completes every story stage by selection, blocks typed submissions and restores saved choices', async () => {
  const first = "I'd like to inspect record one.";
  const { browser, page, errors, responses, requests } = await setup({ width: 390, height: 844 }, 'en', true, false, { replyMode: 'options' });
  try {
    assert.equal(await page.locator('.input-box').isVisible(), false);
    assert.match(await page.locator('#sm-reply-language').textContent(), /英文选项模式/);
    const count = requests.length;
    await page.evaluate(() => sendMessage('This is typed input.'));
    assert.equal(requests.length, count);
    assert.match(await page.locator('#input-error').innerText(), /点击本轮.*选项/);
    const second = "I'd like to inspect record two.", alice = 'Alice, what did you notice?', bob = 'Bob, what did you notice?';
    const explanation = 'I think the two accounts describe the same event.';
    const final = 'My final answer is a misunderstanding because the accounts disagree.';
    const ending = 'Please show us what happened after the vote.', review = 'Please review the clues and explain the ending.';
    async function choose(text, next, override = {}) {
      responses.push(reply({ task_type: 'choice', options: [next, 'Could you repeat that?'], option_translations: ['下一步', '可以再说一次吗？'], ...override }));
      await page.locator('.option-btn').filter({ hasText: text }).first().click();
      await page.waitForFunction(() => !busy);
      assert.equal(requests.at(-1).messages.filter(m => m.role === 'user').at(-1).content, text);
      assert.ok(requests.at(-1).messages.some(m => m.content.includes('玩家全程只能点击')));
      assert.equal(await page.locator('.input-box').isVisible(), false);
    }
    await choose(first, second, { speaker: 'DM', npc_dialogue: 'Here is public observation 0.', task_events: [actionEvent(1, 1, first, 'C1', 'public observation 0')] });
    await choose(second, alice, { speaker: 'DM', npc_dialogue: 'Here is public observation 1.', task_events: [actionEvent(1, 1, second, 'C2', 'public observation 1')] });
    assert.equal(await page.evaluate(() => completedTasks.has(1)), true);
    await choose(alice, bob, { speaker: 'Alice', npc_dialogue: 'I saw the gift by the door.', task_events: [actionEvent(2, 1, alice, 'Alice', 'I saw the gift by the door.')] });
    await choose(bob, explanation, { speaker: 'Bob', npc_dialogue: 'I saw the record by the gift.', task_events: [actionEvent(2, 1, bob, 'Bob', 'I saw the record by the gift.')] });
    await choose(explanation, final, { task_events: [actionEvent(2, 2, explanation)] });
    assert.equal(await page.evaluate(() => completedTasks.has(2)), true);
    await page.locator('#btn-game-panel').click(); await page.locator('#btn-reset').click(); await page.locator('#btn-exit-save').click();
    await page.locator('#btn-open-script-history').click(); await page.locator('.run-card').click(); await page.locator('.btn-resume-run').click();
    assert.equal(await page.evaluate(() => scriptInfo.replyMode), 'options');
    assert.equal(await page.locator('.input-box').isVisible(), false);
    await choose(final, ending, { story_phase: 'ballot', task_events: [actionEvent(3, 1, final), actionEvent(3, 2, 'because the accounts disagree.')], game_over: true });
    assert.equal(await page.evaluate(() => completedTasks.size), 3);
    assert.equal(await page.evaluate(() => gameOverPending), false);
    await choose(ending, review, { story_phase: 'discussion', game_over: false,
      npc_dialogue: 'The case is closed, and your report is done.',
      translation: '案件已经结束，你的报告也完成了。' });
    assert.equal(await page.evaluate(() => gameOverPending), true);
    assert.equal(await page.locator('.review-entry-btn').innerText(), '查看学习结算');
    await page.locator('.review-entry-btn').click();
    await page.locator('#end-modal').waitFor({ state: 'visible' });
    assert.equal(await page.evaluate(() => gameEnded), true);
    assert.equal(await page.evaluate(() => gameOverPending), true);
    assert.equal(await page.locator('.review-entry-btn').count(), 0);
    if (artifacts) await page.screenshot({ path: path.join(artifacts, 'option-mode-phone-complete.png') });
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('option mode keeps a missed earlier task action visible after a later task is completed', async () => {
  const { browser, page, errors } = await setup({ width: 390, height: 844 }, 'en', true, false, { replyMode: 'options' });
  try {
    const state = await page.evaluate(() => {
      let turnId = 100;
      function submit(text, speaker, dialogue, taskEvents) {
        const data = { npc_dialogue: dialogue, translation: '', speaker, story_phase: 'discussion', task_events: taskEvents };
        applyScriptTurnRules(data, false, text, turnId++);
        return data;
      }
      const first = "I'd like to inspect record one.";
      const second = "I'd like to inspect record two.";
      const firstReply = 'public observation 0.';
      submit(first, 'DM', firstReply, [{ task_id: 1, requirement_index: 1, target_id: 'C1', player_quote: first, response_quote: firstReply }]);
      searchedItems.add(first.toLowerCase());
      searchedItems.add(second.toLowerCase()); // 模拟录音笔选项已点过，但当轮证据漏记

      const aliceAsk = 'Alice, what did you notice?';
      const aliceReply = 'I saw a gift by the door.';
      submit(aliceAsk, 'Alice', aliceReply, [{ task_id: 2, requirement_index: 1, target_id: 'Alice', player_quote: aliceAsk, response_quote: aliceReply }]);
      const bobAsk = 'Bob, what did you notice?';
      const bobReply = 'I saw the record beside the gift.';
      submit(bobAsk, 'Bob', bobReply, [{ task_id: 2, requirement_index: 1, target_id: 'Bob', player_quote: bobAsk, response_quote: bobReply }]);
      const explanation = 'I think the two accounts describe the same event because their times agree.';
      submit(explanation, 'DM', 'Thank you for explaining.', [{ task_id: 2, requirement_index: 2, target_id: '', player_quote: explanation, response_quote: '' }]);

      const data = { task_type: 'search', options: [second, 'Inspect another clue.'], option_translations: ['查看记录二。', '查看另一条线索。'] };
      ensureOptionModeReply(data);
      renderOptions(data.options, data.task_type, data.option_translations);
      return { options: [...currentOptions], taskOneDone: taskEvidenceComplete(1), taskTwoDone: taskEvidenceComplete(2), progress: taskProgressDescription(1) };
    });
    assert.equal(state.taskOneDone, false);
    assert.equal(state.taskTwoDone, true);
    assert.match(state.progress, /1\/2.*记录一.*记录二/);
    assert.ok(state.options.includes("I'd like to inspect record two."), 'the missing recorder action must reappear even after it was selected once');
    assert.equal(await page.locator('.option-btn').filter({ hasText: 'inspect record two' }).count(), 1);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('answer mode fields and dual pronunciation cards work on desktop and phones with no More menu', async () => {
  const { browser, page, errors } = await setup({ width: 1280, height: 800 }, 'zh');
  try {
    await page.locator('#btn-reset').click(); await page.locator('#btn-exit-switch').click();
    await page.locator('[data-goal=高考]').click(); await page.locator('#btn-goal-next').click();
    for (const [select, field] of [['sel-reply-mode', 'reply-language-exam'], ['sel-daily-reply-mode', 'reply-language-daily'], ['sel-random-reply-mode', 'reply-language-random']]) {
      await page.evaluate(({ select }) => { const el = document.getElementById(select); el.value = 'options'; el.dispatchEvent(new Event('change')); }, { select });
      assert.equal(await page.locator('#' + select).inputValue(), 'options');
      assert.equal(await page.locator('#' + field).evaluate(el => el.classList.contains('hidden')), true);
    }
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: width === 1280 ? 800 : 720 });
      for (const [select, field] of [['sel-reply-mode', 'reply-language-exam'], ['sel-daily-reply-mode', 'reply-language-daily'], ['sel-random-reply-mode', 'reply-language-random']]) {
        await page.evaluate(({ select, mode }) => { const el = document.getElementById(select); el.value = mode; el.dispatchEvent(new Event('change')); }, { select, mode: 'options' });
        assert.equal(await page.locator('#' + field).evaluate(el => el.classList.contains('hidden')), true);
        await page.evaluate(({ select, mode }) => { const el = document.getElementById(select); el.value = mode; el.dispatchEvent(new Event('change')); }, { select, mode: 'free' });
        assert.equal(await page.locator('#' + field).evaluate(el => el.classList.contains('hidden')), false);
      }
      const challengeBox = await page.locator('#sel-challenge').boundingBox();
      const replyModeBox = await page.locator('#sel-reply-mode').boundingBox();
      const languageBox = await page.locator('#reply-language-exam').boundingBox();
      assert.ok(Math.abs(languageBox.x - challengeBox.x) <= 1 && Math.abs(languageBox.width - (replyModeBox.x + replyModeBox.width - challengeBox.x)) <= 1, 'reply language control must span both upper controls');
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await page.locator('#sel-reply-mode').scrollIntoViewIfNeeded();
      if (artifacts) await page.screenshot({ path: path.join(artifacts, 'reply-config-' + width + '.png') });
    }
    await page.evaluate(() => { addVocabEntry({ word: 'door', meaning: '门', example: 'The door was locked from inside.' }); });
    await page.locator('#btn-home').click(); await page.locator('#btn-open-vocab-review').click();
    assert.equal(await page.locator('.review-more, #btn-import-learning, #btn-export-learning-json').count(), 0);
    assert.equal(await page.locator('#btn-export-learning').isVisible(), true);
    await page.locator('#btn-home').click(); await page.locator('#btn-open-vocab-book').click();
    await page.locator('.vocab-book-item').click();
    await page.waitForFunction(() => !!PRONUNCIATIONS.words.door);
    const uk = await page.locator('#review-phonetic-uk').innerText(), us = await page.locator('#review-phonetic-us').innerText();
    assert.match(uk, /ɔː/); assert.match(us, /ɔ/); assert.notEqual(uk, us);
    await page.evaluate(() => { window.testPronunciations = []; speechSynthesis.speak = u => window.testPronunciations.push(u.lang); speechSynthesis.getVoices = () => []; });
    await page.locator('#btn-review-speak-uk').click(); await page.locator('#btn-review-speak-us').click();
    assert.deepEqual(await page.evaluate(() => window.testPronunciations), ['en-GB', 'en-US']);
    assert.equal(await page.locator('#review-meaning-wrap').isVisible(), false);
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: width === 1280 ? 800 : 568 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      const r = await page.locator('#review-actions').boundingBox(); assert.ok(r.y + r.height <= (width === 1280 ? 800 : 568) + 1);
      if (artifacts) await page.screenshot({ path: path.join(artifacts, 'dual-phonetics-' + width + '.png') });
    }
    if (!(await page.evaluate(() => document.body.classList.contains('light')))) await page.locator('#theme-toggle').click();
    if (artifacts) await page.screenshot({ path: path.join(artifacts, 'dual-phonetics-light-320.png') });
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('option mode repairs missing or Chinese options locally and keeps at least two selectable English replies', async () => {
  const { browser, page, errors, responses, requests } = await setup({ width: 320, height: 568 }, 'en', false, false, {
    replyMode: 'options', openingReply: reply({ task_type: 'grammar', options: ['我想查看记录。'], grammar_task: '请自己输入一句话' })
  });
  try {
    assert.equal(await page.locator('#grammar-task-slot-active').count(), 0);
    assert.equal(await page.locator('.input-box').isVisible(), false);
    assert.ok(await page.locator('.option-btn').count() >= 2);
    assert.equal(await page.evaluate(() => currentOptions.some(containsChineseAnswer)), false);
    const count = requests.length;
    responses.push(reply({ options: [], task_type: 'free' }));
    await page.locator('.option-btn').first().click(); await page.waitForFunction(() => !busy);
    assert.equal(requests.length, count + 1);
    assert.ok(await page.locator('.option-btn').count() >= 2);
    assert.equal(await page.evaluate(() => currentOptions.some(containsChineseAnswer)), false);
    if (artifacts) await page.screenshot({ path: path.join(artifacts, 'option-mode-small-phone.png') });
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
    await page.locator('#btn-exit-switch').click();
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
    await page.locator('#btn-exit-switch').click();
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
