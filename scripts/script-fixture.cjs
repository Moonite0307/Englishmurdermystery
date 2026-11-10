// Synthetic story used by local tests; contains no real player data.
function fixture(genre = '欢乐本', challenge = '简单模式') {
  const count = { 简单模式: 4, 困难模式: 6, 地狱模式: 7 }[challenge];
  const names = ['Player', 'Alice', 'Bob', 'Carol', 'David', 'Eve', 'Frank'].slice(0, count);
  const clues = Array.from({ length: { 简单模式: 6, 困难模式: 9, 地狱模式: 12 }[challenge] }, (_, i) => ({
    id: 'C' + (i + 1), act: i === 0 ? 1 : i === 1 ? 2 : 3, source: 'source' + i,
    discovery: 'public observation ' + i, meaning: 'HIDDEN_MEANING',
    links: ['C' + (i === 0 ? 2 : 1)], kind: i === 2 ? 'red_herring' : 'evidence', resolution: 'HIDDEN_RESOLUTION'
  }));
  const qCount = { 简单模式: 2, 困难模式: 2, 地狱模式: 3 }[challenge];
  return {
    script_name: 'A misplaced gift', event_kind: genre === '推理本' ? 'murder' : 'nonlethal',
    storyline: 'A gift is missing.', ending_style: 'resolved', truth: 'HIDDEN_TRUTH', locked_ending: 'HIDDEN_ENDING',
    player_script: { character_name: names[0], role_title: '乌龙当事人', personal_script: 'You brought a gift.', secret: 'PLAYER_SECRET', personal_task: 'Find the gift.' },
    characters: names.slice(1).map(name => ({ name, role: 'Guest', secret: 'HIDDEN_SECRET', agenda: 'HIDDEN_AGENDA',
      personality: 'Shy', voice: 'Soft', known_facts: ['HIDDEN_KNOWLEDGE'], lie_logic: 'HIDDEN_LIE', reveal_condition: 'HIDDEN_TRIGGER', arc: 'HIDDEN_ARC' })),
    tasks: ['Meet the guests', 'Compare the evidence', 'Explain what happened'],
    task_criteria: [
      { task_id: 1, condition: '查看两处资料', requirements: [{ kind: 'inspect', required: 2, targets: [
        { id: 'C1', label: '记录一', aliases: ['record one', 'source0', '记录一'] },
        { id: 'C2', label: '记录二', aliases: ['record two', 'source1', '记录二'] }
      ] }] },
      { task_id: 2, condition: '向两位角色提问并提出解释', requirements: [{ kind: 'inquire', required: 2, targets: [
        { id: 'Alice', label: '爱丽丝', aliases: ['Alice', '爱丽丝'] },
        { id: 'Bob', label: '鲍勃', aliases: ['Bob', '鲍勃'] }
      ] }, { kind: 'explain', required: 1, targets: [] }] },
      { task_id: 3, condition: '提交判断及理由', requirements: [
        { kind: 'judge', required: 1, targets: [] }, { kind: 'reason', required: 1, targets: [] }
      ] }
    ],
    timeline: [1, 2, 3].map(i => ({ time: '' + i, actor: names[0], event: 'HIDDEN_EVENT', cause: 'HIDDEN_CAUSE', effect: 'HIDDEN_EFFECT' })),
    relationships: names.map((from, i) => ({ from, to: names[(i + 1) % count], public_relation: 'Guests', hidden_relation: 'HIDDEN_RELATION' })),
    acts: [1, 2, 3].map(act => ({ act, title: 'Act ' + act, trigger: 'HIDDEN_TRIGGER', event: 'HIDDEN_EVENT',
      clue_ids: clues.filter(c => c.act === act).map(c => c.id), character_beats: 'HIDDEN_BEAT' })),
    clues, core_questions: Array.from({ length: qCount }, (_, i) => ({ id: 'Q' + (i + 1), question: 'What happened?',
      answer: 'HIDDEN_ANSWER', supporting_clue_ids: ['C1', 'C2'], direction_hint: '比较两份记录的先后顺序。' })),
    mechanics: genre === '机制阵营本' ? {
      factions: [{ id: 'F1', name: 'Team A', members: names.slice(0, 2), goal: 'Recover gift' },
        { id: 'F2', name: 'Team B', members: names.slice(2), goal: 'Keep gift' }],
      skills: [{ owner: names[0], effect: 'Inspect a record', cost: 'One token', limit: 'Once' }],
      resources: names.map(owner => ({ owner, amount: 3 })), round_rules: 'One action per turn',
      win_conditions: 'Team with the gift wins', fixed_result: 'HIDDEN_RESULT'
    } : null,
    core_vocab: ['gift', 'record']
  };
}
module.exports = fixture;
