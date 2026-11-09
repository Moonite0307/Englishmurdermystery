// Run with: node scripts/test-script-strategy.cjs (no API or dependencies needed).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const js = html.match(/<script>([\s\S]*?)<\/script>/)[1];
new vm.Script(js); // Compile the entire page, including untouched code.
function section(start, end) {
  const a = js.indexOf(start);
  const b = js.indexOf(end, a);
  assert.ok(a >= 0 && b > a, start);
  return js.slice(a, b);
}
function environment(genre = '欢乐本', challenge = '简单模式') {
  const elements = new Map();
  function element() {
    return { textContent: '', children: [], classList: { add() {}, remove() {} },
      appendChild(child) { this.children.push(child); } };
  }
  const ctx = vm.createContext({
    console,
    $: id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); },
    document: { createElement: element, createTextNode: textContent => ({ textContent }) },
    isExamGoal: () => false
  });
  vm.runInContext(section('const PROMPT_GENERATE_PLAN', '/* ================= 全局状态'), ctx);
  vm.runInContext(`let scriptInfo = ${JSON.stringify({ genre, challenge })};
    let scriptData = null;
    let deductionProgress = { questionId: '', wrongStreak: 0 };
    const storyPhases = new Set();`, ctx);
  vm.runInContext(section('function repairJsonSyntax', '/* 流式过程中'), ctx);
  vm.runInContext(section('function containsChineseAnswer', 'function gameRequestMessages'), ctx);
  vm.runInContext(section('function formatScriptPlan', '/* 玩家角色本'), ctx);
  vm.runInContext(section('function buildScriptModal', '/* 只向大模型发送'), ctx);
  return { ctx, elements, run: code => vm.runInContext(code, ctx) };
}
const fixture = require('./script-fixture.cjs');
test('all six genres and three difficulty counts accept a complete plan', () => {
  for (const genre of ['推理本', '还原本', '恐怖本', '欢乐本', '情感本', '机制阵营本']) {
    for (const challenge of ['简单模式', '困难模式', '地狱模式']) {
      const { ctx, run } = environment(genre, challenge);
      ctx.plan = fixture(genre, challenge);
      assert.equal(run('validateScriptPlan(plan).join(";")'), '', `${genre}/${challenge}`);
      assert.equal(run('plan.characters.length + 1 === totalChars()'), true);
    }
  }
});
test('shorter scripts retain sufficient pre-ballot evidence at every difficulty', () => {
  for (const [challenge, count] of [['简单模式', 4], ['困难模式', 6], ['地狱模式', 8]]) {
    const { ctx, run } = environment('欢乐本', challenge);
    ctx.plan = fixture('欢乐本', challenge);
    ctx.plan.clues = ctx.plan.clues.slice(0, count);
    run('normalizeScriptPlanReferences(plan)');
    assert.equal(run('validateScriptPlan(plan).join(";")'), '');
  }
});
test('language rules cover mixed input and extended Chinese characters', () => {
  const { ctx, run } = environment();
  for (const text of ['你好', 'I think 是他', '\u{20000}']) {
    ctx.sample = text; assert.equal(run('containsChineseAnswer(sample)'), true);
  }
  for (const text of ['I think Alice has it.', 'The café opens at 8:30.', '123?!']) {
    ctx.sample = text; assert.equal(run('containsChineseAnswer(sample)'), false);
  }
  run('scriptInfo.replyLanguage = "zh"');
  assert.match(run('replyLanguageRule()'), /中英混合/);
});
test('multiple completion formats merge once, invalid IDs are ignored, and missing task conditions fail', () => {
  const { ctx, run } = environment();
  ctx.turn = { completed_task: 1, completed_tasks: [1, '2', -1, 8, false],
    task_checks: [{ task_id: 3, status: 'completed', evidence: 'The player submitted a conclusion' }] };
  assert.equal(run('completedTaskIds(turn, 3).join(",")'), '1,2,3');
  ctx.plan = fixture(); delete ctx.plan.task_criteria;
  assert.match(run('validateScriptPlan(plan).join(";")'), /完成条件/);
});
test('invalid plans cannot pass character, clue, relationship, or truth checks', () => {
  const { ctx, run } = environment();
  const changes = [
    p => p.characters.pop(), p => p.characters.push({ ...p.characters[0], name: 'Extra' }),
    p => p.characters[0].name = 'Player', p => delete p.truth, p => delete p.locked_ending,
    p => p.event_kind = 'murder', p => p.clues[0].links = ['UNKNOWN'],
    p => p.clues[1].source = p.clues[0].source,
    p => p.clues[1].act = 3, p => p.relationships = [],
    p => p.core_questions[0].direction_hint = p.core_questions[0].answer,
    p => p.core_questions[0].direction_hint = 'Ask Alice.', p => p.acts.pop(),
    p => p.characters[0] = null, p => p.clues[0] = null, p => p.core_questions[0] = null
  ];
  for (const change of changes) {
    ctx.plan = fixture(); change(ctx.plan);
    assert.ok(run('validateScriptPlan(plan).length') > 0, change.toString());
  }
  assert.ok(run('validateScriptPlan(null).length') > 0);
});
test('faction members and starting resources must cover the actual cast', () => {
  const { ctx, run } = environment('机制阵营本');
  ctx.plan = fixture('机制阵营本');
  ctx.plan.mechanics.factions[0].members.push('NotInCast');
  ctx.plan.mechanics.resources[0].amount = -1;
  const errors = run('validateScriptPlan(plan).join(";")');
  assert.match(errors, /阵营/); assert.match(errors, /筹码/);
});
test('hints require three wrong guesses on the same question; chat and language tasks do not count', () => {
  const { ctx, run } = environment(); ctx.plan = fixture();
  run('scriptData = plan');
  function turn(verdict, question_id = 'Q1', phase = 'discussion') {
    ctx.turn = { deduction_hint: 'MODEL_SPOILER', deduction_assessment: { verdict, question_id }, story_phase: phase };
    run('applyScriptTurnRules(turn)'); return ctx.turn;
  }
  assert.equal(turn('wrong').deduction_hint, '');
  assert.equal(turn('none').deduction_hint, '');
  assert.equal(turn('wrong').deduction_hint, '');
  assert.equal(turn('wrong').deduction_hint, ctx.plan.core_questions[0].direction_hint);
  assert.equal(turn('none').deduction_hint, '');
  assert.equal(turn('partial').deduction_hint, '');
  assert.equal(turn('wrong').deduction_hint, '');
  assert.equal(turn('wrong', 'Q2').deduction_hint, '');
  assert.equal(turn('wrong', 'Q1').deduction_hint, ''); // switching resets the streak
  assert.equal(turn('wrong', 'Q1').deduction_hint, '');
  assert.ok(turn('wrong', 'Q1').deduction_hint);
  turn('right'); assert.equal(turn('wrong').deduction_hint, '');
  assert.equal(turn('wrong', 'UNKNOWN').deduction_hint, '');
});
test('tasks can tick before review while ballot, ending, and review still require separate turns', () => {
  const { ctx, run } = environment(); ctx.plan = fixture(); run('scriptData = plan');
  const step = story_phase => {
    ctx.turn = { story_phase, completed_task: 3, game_over: true };
    run('applyScriptTurnRules(turn)'); return ctx.turn;
  };
  assert.equal(step('review').game_over, false);
  assert.equal(step('ending').completed_task, 3);
  assert.equal(step('ballot').game_over, false);
  assert.equal(step('review').game_over, false);
  assert.equal(step('ending').game_over, false);
  assert.equal(step('review').game_over, true);
  assert.equal(ctx.turn.completed_task, 3);
});
test('locked draft is immutable and all private design reaches DM without appearing in the public modal', () => {
  const { ctx, run, elements } = environment(); ctx.plan = fixture();
  run('freezeScriptPlan(plan); buildScriptModal(plan)');
  assert.equal(run('Object.isFrozen(plan.clues[0]) && Object.isFrozen(plan.characters[0].known_facts)'), true);
  const dmText = run('formatScriptPlan(plan)');
  for (const tag of ['HIDDEN_TRUTH', 'HIDDEN_ARC', 'HIDDEN_RELATION', 'HIDDEN_MEANING', 'HIDDEN_ENDING']) assert.ok(dmText.includes(tag));
  const publicText = JSON.stringify([...elements.values()]);
  assert.ok(publicText.includes('PLAYER_SECRET'));
  assert.ok(!publicText.includes('HIDDEN_'), publicText);
});
test('bad JSON repairs once before lock; a repeated invalid draft fails instead of exposing raw text', async () => {
  const { ctx, run } = environment(); const calls = [];
  ctx.callLLM = async request => { calls.push(structuredClone(request)); return calls.length === 1 ? 'not JSON' : JSON.stringify(fixture()); };
  const result = await run('generateValidatedScript("Create a plan")');
  assert.equal(result.truth, 'HIDDEN_TRUTH'); assert.equal(calls.length, 2);
  assert.equal(calls[1][2].role, 'user'); assert.match(calls[1][2].content, /尚未开局/);
  ctx.callLLM = async () => '{}';
  await assert.rejects(run('generateValidatedScript("Create a plan")'), /自动校对后仍有信息缺漏/);
});
test('stale, missing and repeated act indexes are rebuilt without changing story facts or clue release times', async () => {
  const { ctx, run } = environment();
  ctx.plan = fixture();
  const facts = structuredClone({ clues: ctx.plan.clues, truth: ctx.plan.truth, ending: ctx.plan.locked_ending });
  delete ctx.plan.acts[0].clue_ids;
  ctx.plan.acts[1].clue_ids = ['C1', 'C2', 'C2', 'UNKNOWN'];
  ctx.plan.acts[2].clue_ids = ['C2']; // a later recap is not a new clue
  run('normalizeScriptPlanReferences(plan)');
  assert.equal(run('validateScriptPlan(plan).join(";")'), '');
  assert.deepEqual(ctx.plan.clues, facts.clues);
  assert.equal(ctx.plan.truth, facts.truth);
  assert.equal(ctx.plan.locked_ending, facts.ending);
  let calls = 0;
  ctx.plan.acts[1].clue_ids = ['C1'];
  ctx.callLLM = async () => { calls++; return JSON.stringify(ctx.plan); };
  const result = await run('generateValidatedScript("Create a plan")');
  assert.equal(calls, 1); // no paid model retry for redundant index bookkeeping
  assert.equal(result.acts[1].clue_ids.join(','), 'C2');
});
test('a final act may recap the existing evidence without introducing a new clue', () => {
  const { ctx, run } = environment(); ctx.plan = fixture();
  ctx.plan.clues.forEach((c, i) => { c.act = i % 2 + 1; });
  ctx.plan.acts[2].clue_ids = [];
  run('normalizeScriptPlanReferences(plan)');
  assert.equal(run('validateScriptPlan(plan).join(";")'), '');
  assert.equal(ctx.plan.acts[2].clue_ids.length, 0);
});
test('numeric act strings normalize while unknown acts, duplicate clue IDs and missing evidence still fail', () => {
  const { ctx, run } = environment(); ctx.plan = fixture();
  ctx.plan.acts.forEach(a => a.act = String(a.act));
  ctx.plan.clues.forEach(c => c.act = ' ' + c.act + ' ');
  run('normalizeScriptPlanReferences(plan)');
  assert.equal(run('validateScriptPlan(plan).join(";")'), '');
  for (const damage of [p => p.clues[1].act = 9, p => p.clues[1].act = null,
    p => p.clues[1].id = p.clues[0].id, p => p.core_questions[0].supporting_clue_ids = ['UNKNOWN'],
    p => p.clues[1].act = 3]) {
    ctx.plan = fixture(); damage(ctx.plan);
    run('normalizeScriptPlanReferences(plan)');
    assert.ok(run('validateScriptPlan(plan).length') > 0);
  }
});
test('daily mode responses bypass the new narrative rules', () => {
  const { ctx, run } = environment();
  ctx.turn = { game_over: true, completed_task: 3, deduction_hint: 'unchanged' };
  run('scriptInfo.dailyMode = "闯关模式"; applyScriptTurnRules(turn)');
  assert.equal(ctx.turn.game_over, true); assert.equal(ctx.turn.completed_task, 3);
  assert.equal(ctx.turn.deduction_hint, 'unchanged');
});
test('generation entry fills the strategy prompt and freezes a validated plan', async () => {
  const { ctx, run, elements } = environment();
  run('let scriptPlan = ""; const backendMode = false;');
  for (const [id, value] of Object.entries({ 'sel-genre': '欢乐本', 'inp-theme': '', 'inp-background': '', 'sel-level': '高考', 'sel-challenge': '简单模式' })) {
    ctx.$(id).value = value;
  }
  const requests = [];
  ctx.callLLM = async request => { requests.push(structuredClone(request)); return JSON.stringify(fixture()); };
  ctx.hideBanner = () => {};
  ctx.getSettings = () => ({});
  ctx.validateSettings = () => true;
  ctx.examCandidateText = () => 'gift,record';
  ctx.setState = () => {};
  ctx.showPlanningLoading = () => {};
  ctx.showBanner = message => assert.fail(message);
  run(section('function fillTemplate', '/* 场景与难度的定位 */'));
  run(section('async function generatePlan()', '/* ================= PLANNING → PLAYING'));
  await run('generatePlan()');
  assert.equal(requests.length, 1);
  assert.doesNotMatch(requests[0][0].content, /\{(?:genre|npcCount|totalChars|playerRole|structureRule|vocabPool)\}/);
  assert.equal(run('Object.isFrozen(scriptData) && Object.isFrozen(scriptData.clues)'), true);
  assert.ok(run('SCRIPT_ROLE_POOLS[scriptInfo.genre].includes(scriptInfo.playerRole)'));
  assert.ok(run('scriptPlan.includes("HIDDEN_TRUTH")'));
  assert.equal(elements.get('btn-generate').disabled, false);
});
test('unrelated learning templates are unchanged from the original page', () => {
  const { execFileSync } = require('node:child_process');
  const base = execFileSync('git', ['show', 'HEAD:index.html'], { cwd: path.join(__dirname, '..'), encoding: 'utf8' });
  const normalize = text => text.replace(/\r\n/g, '\n');
  for (const constant of ['PROMPT_GENERATE_DAILY_PLAN', 'PROMPT_PLAY_DAILY_GAME', 'PROMPT_END_REVIEW']) {
    const pattern = new RegExp('const ' + constant + ' = `([\\s\\S]*?)`;');
    assert.equal(normalize(html.match(pattern)[1]), normalize(base.match(pattern)[1]), constant);
  }
});
