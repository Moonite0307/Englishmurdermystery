// Task decisions use synthetic turns; no network, credentials, or paid model calls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const fixture = require('./script-fixture.cjs');
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const source = html.slice(html.indexOf('const PROMPT_GENERATE_PLAN'), html.indexOf('/* ================= 全局状态'));
function environment() {
  const ctx = vm.createContext({ console });
  vm.runInContext(source, ctx);
  ctx.plan = fixture();
  vm.runInContext(`let scriptInfo={genre:'欢乐本',challenge:'简单模式'};
    let scriptData=plan; const completedTasks=new Set();
    let taskProgressState=createTaskProgressState();
    let deductionProgress={questionId:'',wrongStreak:0}; const storyPhases=new Set();`, ctx);
  let nextTurn = 1;
  const run = code => vm.runInContext(code, ctx);
  function turn(text, events = [], options = {}) {
    ctx.text = text;
    ctx.data = { npc_dialogue: 'I saw a gift by the door.', translation: '我看到门边有一份礼物。', speaker: 'Alice',
      story_phase: 'discussion', completed_task: 2, completed_tasks: [1, 2, 3],
      task_checks: [{ task_id: 2, status: 'completed', evidence: 'Model says so' }],
      task_events: events, ...options };
    ctx.turnId = options.turnId || nextTurn++;
    ctx.boot = Boolean(options.boot);
    run('applyScriptTurnRules(data,boot,text,turnId)');
    return JSON.parse(JSON.stringify(ctx.data));
  }
  return { ctx, run, turn, count: (id, index) => run(`taskRequirementRecords(${id},${index}).size`) };
}
const event = (task, index, quote, target = '', response = '') => ({ task_id: task,
  requirement_index: index, target_id: target, player_quote: quote, response_quote: response });
const answer = 'I saw a gift by the door.';

test('model completion flags and NPC spontaneous speech never complete a task', () => {
  const e = environment();
  const result = e.turn('Hello Alice.', [event(2, 1, 'Hello Alice.', 'Alice', answer)]);
  assert.equal(e.count(2, 1), 0);
  assert.deepEqual(result.completed_tasks, []);
  assert.equal(result.completed_task, 0);
  assert.equal(result.task_checks[1].status, 'pending');
  assert.equal(e.turn('I think Alice took it.', [event(2, 2, 'I think Alice took it.')], { boot: true }).completed_task, 0);
});

test('asking one person credits only that person; both people and a player explanation are required', () => {
  const e = environment();
  const askAlice = 'Ask Alice what she saw.';
  let result = e.turn(askAlice, [event(2, 1, askAlice, 'Alice', answer),
    event(2, 1, askAlice, 'Bob', answer), event(2, 2, askAlice)]);
  assert.equal(e.count(2, 1), 1);
  assert.equal(e.count(2, 2), 0);
  assert.deepEqual(result.completed_tasks, []);
  assert.match(result.task_checks[1].evidence, /1\/2人.*鲍勃.*尚未提出/);
  e.turn(askAlice, [event(2, 1, askAlice, 'Alice', answer)]);
  assert.equal(e.count(2, 1), 1);
  const askBob = 'Ask Bob what he saw.';
  result = e.turn(askBob, [event(2, 1, askBob, 'Bob', answer)], { speaker: 'Bob' });
  assert.equal(e.count(2, 1), 2);
  assert.deepEqual(result.completed_tasks, []);
  const explanation = 'I think the gift was taken by mistake.';
  result = e.turn(explanation, [event(2, 2, explanation)]);
  assert.deepEqual(result.completed_tasks, [2]);
  assert.equal(e.run('taskEvidenceComplete(2)'), true);
});

test('future, past and negated questions do not count; current direct follow-up does count', () => {
  for (const text of ['I already asked Alice what she saw.', 'I will ask Alice what she saw.',
    "Don't ask Alice what she saw.", '我以后问爱丽丝看到了什么。', '我没有问爱丽丝看到了什么。']) {
    const e = environment();
    e.turn(text, [event(2, 1, text, 'Alice', answer)]);
    assert.equal(e.count(2, 1), 0, text);
  }
  const e = environment();
  e.turn('Hello there.');
  const question = 'What did you see by the door?';
  e.turn(question, [event(2, 1, question, 'Alice', answer)]);
  assert.equal(e.count(2, 1), 1);
});

test('Chinese names, mixed input, multiple speakers, and word boundaries match real targets', () => {
  const e = environment();
  const question = '我想问爱丽丝，what did you see?';
  e.turn(question, [event(2, 1, question, 'Alice', answer)]);
  assert.equal(e.count(2, 1), 1);
  const other = environment();
  const group = 'Ask Alice and Bob what they saw.';
  const speech = 'Alice: I saw a gift.\nBob: I saw a box.';
  other.turn(group, [event(2, 1, group, 'Alice', 'Alice: I saw a gift.'), event(2, 1, group, 'Bob', 'Bob: I saw a box.')], { speaker: 'DM', npc_dialogue: speech });
  assert.equal(other.count(2, 1), 2);
  const wrong = environment();
  wrong.turn('Ask Bobbie what he saw.', [event(2, 1, 'Ask Bobbie what he saw.', 'Bob', answer)], { speaker: 'Bob' });
  assert.equal(wrong.count(2, 1), 0);
  const simple = environment();
  simple.turn('问爱丽丝。', [event(2, 1, '问爱丽丝。', 'Alice', answer)]);
  assert.equal(simple.count(2, 1), 1);
});

test('fabricated player quotes, NPC quotes, old turns and invalid IDs are rejected', () => {
  const e = environment();
  e.turn('Ask Alice what she saw.', [
    event(2, 1, 'Ask Bob what he saw.', 'Bob', answer),
    event(2, 1, 'Ask Alice what she saw.', 'Alice', 'The model invented a different reply.'),
    event(99, 1, 'Ask Alice what she saw.', 'Alice', answer),
    event(2, -1, 'Ask Alice what she saw.', 'Alice', answer),
    event(2, 1, 'Ask Alice what she saw.', 'Unknown', answer), null
  ]);
  assert.equal(e.count(2, 1), 0);
  e.turn('Thank you.', [event(2, 2, 'I think the gift was taken by mistake.')]);
  assert.equal(e.count(2, 2), 0);
  e.turn('Ask Alice why she was by the door.', [event(2, 2, 'she was by the door')]);
  assert.equal(e.count(2, 2), 0);
});

test('inspections require the requested source and actual delivered content, counted once per source', () => {
  const e = environment();
  const inspect = 'Please show me record one.';
  e.turn(inspect, [event(1, 1, inspect, 'C1', answer), event(1, 1, inspect, 'C2', answer)]);
  assert.equal(e.count(1, 1), 1);
  e.turn(inspect, [event(1, 1, inspect, 'C1', answer)]);
  assert.equal(e.count(1, 1), 1);
  const second = '查看记录二。';
  const result = e.turn(second, [event(1, 1, second, 'C2', '我看到门边有一份礼物。')]);
  assert.equal(e.count(1, 1), 2);
  assert.deepEqual(result.completed_tasks, [1]);
  const refusal = environment();
  refusal.turn(inspect, [event(1, 1, inspect, 'C1', 'I cannot show that to you yet.')], { npc_dialogue: 'I cannot show that to you yet.' });
  assert.equal(refusal.count(1, 1), 0);
});

test('an inspected clue is not rejected because quoted dialogue mentions a later event or says will not', () => {
  const e = environment();
  e.run("taskProgressState.phase='search'; plan.task_criteria[0].requirements[0].targets[1].aliases.push('corridor recorder')");
  const request = 'Check the corridor recorder';
  const dialogue = "You play the corridor recorder. The woman says, 'I won't let you destroy the competition.' Someone else came later.";
  const result = e.turn(request, [event(1, 1, request, 'C2', dialogue)], { npc_dialogue: dialogue });
  assert.equal(e.count(1, 1), 1);
  assert.equal(result.task_events.length, 1);
});

test('a final judgment and its reason are separate requirements, neither demands correctness', () => {
  const e = environment();
  let result = e.turn('My final answer is that Bob took the gift.', [event(3, 1, 'My final answer is that Bob took the gift.')]);
  assert.equal(e.count(3, 1), 1);
  assert.deepEqual(result.completed_tasks, []);
  result = e.turn('Because the time in the record was changed.', [event(3, 2, 'Because the time in the record was changed.')]);
  assert.deepEqual(result.completed_tasks, [3]);
  const wrong = environment();
  wrong.turn('Ask Alice what she saw.', [event(3, 1, 'Ask Alice what she saw.'), event(3, 2, 'Ask Alice what she saw.')]);
  assert.equal(wrong.count(3, 1), 0);
  assert.equal(wrong.count(3, 2), 0);
  const mixed = environment();
  const combined = 'Ask Alice what she saw. My final answer is Bob because he changed the record.';
  const both = mixed.turn(combined, [event(3, 1, 'My final answer is Bob'), event(3, 2, 'because he changed the record.')]);
  assert.deepEqual(both.completed_tasks, [3]);
});

test('same-turn retries and repeated events are idempotent; a new game clears all evidence', () => {
  const e = environment(); const ask = 'Ask Alice what she saw.';
  e.turn(ask, [event(2, 1, ask, 'Alice', answer), event(2, 1, ask, 'Alice', answer)], { turnId: 12 });
  const again = e.turn(ask, [event(2, 1, ask, 'Bob', answer)], { turnId: 12, speaker: 'Bob' });
  assert.equal(e.count(2, 1), 1);
  assert.deepEqual(again.task_events, []);
  e.run('taskProgressState=createTaskProgressState()');
  assert.equal(e.count(2, 1), 0);
  assert.equal(e.run('taskEvidenceComplete(2)'), false);
});

test('missing or corrupt requirement rules fail draft validation, duplicate sources cannot count twice', () => {
  for (const damage of [p => delete p.task_criteria[1].requirements,
    p => p.task_criteria[1].requirements[0].required = 1,
    p => p.task_criteria[1].requirements[0].targets[1].id = 'Nobody',
    p => p.task_criteria[1].requirements[0].targets[1].aliases.push('Alice'),
    p => p.task_criteria[0].requirements[0].targets[1].id = 'C3',
    p => p.clues[1].source = p.clues[0].source]) {
    const e = environment(); damage(e.ctx.plan);
    assert.ok(e.run('scriptTaskRequirementsErrors(plan).length') > 0);
  }
});

test('public text derives from the same rules as counting, rather than stale task prose', () => {
  const e = environment();
  vm.runInContext(html.slice(html.indexOf('function repairJsonSyntax'), html.indexOf('/* 流式过程中')), e.ctx);
  e.ctx.plan.tasks[1] = 'Ask one person';
  e.ctx.plan.task_criteria[1].condition = 'Ask one person';
  e.run('normalizeScriptPlanReferences(plan)');
  assert.match(e.ctx.plan.tasks[1], /爱丽丝.*鲍勃.*自己的解释/);
  assert.equal(e.ctx.plan.tasks[1], e.ctx.plan.task_criteria[1].condition);
});
